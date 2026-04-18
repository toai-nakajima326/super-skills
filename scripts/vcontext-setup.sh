#!/bin/bash
# vcontext-setup.sh — storage lifecycle for Virtual Context
# Usage: ./scripts/vcontext-setup.sh {start|stop|status}
#
# 2026-04-18: primary DB moved from 18 GB APFS RAM disk to internal NVMe
# SSD.  Per owner: "RAM diskは、SSDにしましょう、ただしSSD用のバッファー
# でとして1GBならOKですよ、必要ならの話です" — default is now SSD-only.
# Set VCONTEXT_USE_RAMDISK=1 to re-enable the 18 GB RAM-disk mount (e.g.
# for revert).  VCONTEXT_DB_PATH overrides the DB file location.

set -euo pipefail

USE_RAMDISK="${VCONTEXT_USE_RAMDISK:-}"
MOUNT_POINT="/Volumes/VContext"
BACKUP_DIR="${HOME}/skills/data"
if [[ "${USE_RAMDISK}" == "1" ]]; then
  DEFAULT_DB_PATH="${MOUNT_POINT}/vcontext.db"
else
  DEFAULT_DB_PATH="${BACKUP_DIR}/vcontext-primary.sqlite"
fi
DB_PATH="${VCONTEXT_DB_PATH:-${DEFAULT_DB_PATH}}"
BACKUP_PATH="${BACKUP_DIR}/vcontext-backup.sqlite"
RAM_BLOCKS=37748736  # 18GB in 512-byte blocks (4 → 6 → 12 → 18 — 18GB (50% of 36GB system RAM) keeps vcontext/vec/WAL + corrupted-copy headroom comfortable; "他はスワップで良し" per owner 2026-04-18)
PLIST_LABEL="com.vcontext.ramdisk"
PLIST_PATH="${HOME}/Library/LaunchAgents/${PLIST_LABEL}.plist"

# ── Colors ──────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[vcontext]${NC} $*"; }
warn() { echo -e "${YELLOW}[vcontext]${NC} $*"; }
err()  { echo -e "${RED}[vcontext]${NC} $*" >&2; }

# ── Init SQLite schema ─────────────────────────────────────────
init_db() {
  log "Initializing SQLite database at ${DB_PATH}"
  sqlite3 "${DB_PATH}" <<'SQL'
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('conversation','decision','observation','code','error')),
  content TEXT NOT NULL,
  tags TEXT DEFAULT '[]',
  session TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  token_estimate INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(type);
CREATE INDEX IF NOT EXISTS idx_entries_session ON entries(session);
CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at);

-- FTS5 full-text search index
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  content,
  tags,
  type,
  content_rowid=id
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, content, tags, type)
  VALUES (new.id, new.content, new.tags, new.type);
END;

CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, content, tags, type)
  VALUES ('delete', old.id, old.content, old.tags, old.type);
END;

CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, content, tags, type)
  VALUES ('delete', old.id, old.content, old.tags, old.type);
  INSERT INTO entries_fts(rowid, content, tags, type)
  VALUES (new.id, new.content, new.tags, new.type);
END;
SQL
  log "Database initialized with FTS5"
}

# ── Restore from backup if available ───────────────────────────
# Picks the best source in order:
#   1. vcontext-backup.sqlite  (5-min backup cadence)
#   2. latest data/snapshots/*.db (pre-outage / daily)
#   3. vcontext-ssd.db  (long-term archive)
#   4. fresh init
# Validates size > 100KB AND integrity_check=ok AND entries-table-exists
# so a 0-byte or truncated backup doesn't get silently accepted
# (observed 2026-04-17: power outage mid-backup left 0-byte file,
#  restore "succeeded" into an empty DB).
restore_backup() {
  local snap_dir="${BACKUP_DIR}/snapshots"
  local ssd_db="${BACKUP_DIR}/vcontext-ssd.db"
  local candidates=()

  # Priority 1: regular backup (if valid)
  [ -f "${BACKUP_PATH}" ] && candidates+=("${BACKUP_PATH}")
  # Priority 2: latest snapshots (newest first)
  if [ -d "$snap_dir" ]; then
    while IFS= read -r s; do candidates+=("$s"); done < <(ls -t "$snap_dir"/vcontext-*.db 2>/dev/null)
  fi
  # Priority 3: SSD DB
  [ -f "$ssd_db" ] && candidates+=("$ssd_db")

  for src in "${candidates[@]}"; do
    local size_bytes
    size_bytes=$(stat -f%z "$src" 2>/dev/null || echo 0)
    # Reject < 100 KB (empty / truncated)
    if [ "$size_bytes" -lt 102400 ]; then
      warn "Skip (too small ${size_bytes}B): $(basename "$src")"
      continue
    fi
    # Integrity check
    if ! sqlite3 "$src" "PRAGMA quick_check;" 2>/dev/null | grep -q "^ok$"; then
      warn "Skip (integrity fail): $(basename "$src")"
      continue
    fi
    # Must have entries table with rows
    local row_count
    row_count=$(sqlite3 "$src" "SELECT COUNT(*) FROM entries;" 2>/dev/null || echo 0)
    if [ "${row_count:-0}" -lt 10 ]; then
      warn "Skip (< 10 entries): $(basename "$src")"
      continue
    fi
    log "Restoring from: $(basename "$src") (${size_bytes} B, ${row_count} entries)"
    cp "$src" "${DB_PATH}"
    return 0
  done

  warn "No valid backup found among ${#candidates[@]} candidates — initializing fresh DB"
  init_db
}

# ── Start: create RAM disk and init DB ─────────────────────────
cmd_start() {
  # Clean up stray duplicates (macOS auto-appends " 1", " 2", ... when a
  # volume named VContext survives from a previous session). Only the
  # canonical MOUNT_POINT should remain.
  for stray in "/Volumes/VContext "*; do
    [ -d "$stray" ] || continue
    warn "Ejecting stray duplicate: $stray"
    stray_dev=$(mount | awk -v m="$stray" '$3==m{print $1; exit}')
    diskutil unmount force "$stray" >/dev/null 2>&1 || true
    if [ -n "${stray_dev:-}" ]; then
      parent="/dev/$(basename "$stray_dev" | sed 's/s[0-9]*$//')"
      hdiutil detach "$parent" -force >/dev/null 2>&1 || true
    fi
  done

  # Already mounted?
  if mount | grep -q "${MOUNT_POINT}"; then
    warn "RAM disk already mounted at ${MOUNT_POINT}"
    if [ -f "${DB_PATH}" ]; then
      log "Database exists, ready to use"
      return 0
    else
      restore_backup
      return 0
    fi
  fi

  log "Creating 18GB RAM disk (${RAM_BLOCKS} x 512-byte blocks)"
  DISK_DEV=$(hdiutil attach -nomount ram://${RAM_BLOCKS})
  DISK_DEV=$(echo "${DISK_DEV}" | xargs)  # trim whitespace

  if [ -z "${DISK_DEV}" ]; then
    err "Failed to create RAM disk"
    exit 1
  fi

  log "Formatting ${DISK_DEV} as APFS"
  diskutil apfs createContainer "${DISK_DEV}" >/dev/null 2>&1 || true
  diskutil apfs addVolume "${DISK_DEV}" APFS VContext -mountpoint "${MOUNT_POINT}" >/dev/null 2>&1 || {
    # Fallback: format as HFS+ if APFS container fails
    warn "APFS container creation issue, trying eraseDisk"
    diskutil eraseDisk APFS VContext "${DISK_DEV}" >/dev/null 2>&1 || {
      warn "APFS failed, falling back to HFS+"
      diskutil eraseDisk HFS+ VContext "${DISK_DEV}" >/dev/null 2>&1
    }
  }

  # Verify mount
  if ! mount | grep -q "${MOUNT_POINT}"; then
    err "RAM disk creation failed - mount point not found"
    exit 1
  fi

  log "RAM disk mounted at ${MOUNT_POINT}"

  # Ensure backup directory exists
  mkdir -p "${BACKUP_DIR}"

  # Restore or init
  restore_backup

  log "Virtual Context ready"
  echo ""
  log "  Mount:    ${MOUNT_POINT}"
  log "  Database: ${DB_PATH}"
  log "  Backup:   ${BACKUP_PATH}"
  log "  Size:     18 GB RAM"
  echo ""
  log "Start the server: node scripts/vcontext-server.js"
}

# ── Stop: backup and unmount ───────────────────────────────────
cmd_stop() {
  if ! mount | grep -q "${MOUNT_POINT}"; then
    warn "RAM disk not mounted"
    return 0
  fi

  # Backup before unmounting
  if [ -f "${DB_PATH}" ]; then
    mkdir -p "${BACKUP_DIR}"
    log "Backing up database to ${BACKUP_PATH}"
    sqlite3 "${DB_PATH}" ".backup '${BACKUP_PATH}'"
    log "Backup complete"
  fi

  log "Unmounting RAM disk"
  # Find the disk device
  DISK_DEV=$(mount | grep "${MOUNT_POINT}" | awk '{print $1}' | head -1)

  diskutil unmount "${MOUNT_POINT}" >/dev/null 2>&1 || true

  # Eject the RAM disk device if we can find the parent
  if [ -n "${DISK_DEV}" ]; then
    PARENT_DISK=$(echo "${DISK_DEV}" | sed 's/s[0-9]*$//')
    hdiutil detach "${PARENT_DISK}" -force >/dev/null 2>&1 || true
  fi

  log "RAM disk unmounted and ejected"
}

# ── Status: show RAM disk info ─────────────────────────────────
cmd_status() {
  echo -e "${CYAN}── Virtual Context Status ──${NC}"
  echo ""

  # RAM disk
  if mount | grep -q "${MOUNT_POINT}"; then
    echo -e "  RAM Disk:  ${GREEN}MOUNTED${NC} at ${MOUNT_POINT}"
    DISK_USAGE=$(df -h "${MOUNT_POINT}" 2>/dev/null | tail -1 | awk '{print $3 " used / " $2 " total (" $5 " used)"}')
    echo "  Disk:      ${DISK_USAGE}"
  else
    echo -e "  RAM Disk:  ${RED}NOT MOUNTED${NC}"
    echo ""
    echo "  Run: ./scripts/vcontext-setup.sh start"
    return 1
  fi

  # Database
  if [ -f "${DB_PATH}" ]; then
    DB_SIZE=$(ls -lh "${DB_PATH}" | awk '{print $5}')
    ENTRY_COUNT=$(sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM entries;" 2>/dev/null || echo "0")
    OLDEST=$(sqlite3 "${DB_PATH}" "SELECT MIN(created_at) FROM entries;" 2>/dev/null || echo "n/a")
    NEWEST=$(sqlite3 "${DB_PATH}" "SELECT MAX(created_at) FROM entries;" 2>/dev/null || echo "n/a")

    echo -e "  Database:  ${GREEN}OK${NC} (${DB_SIZE})"
    echo "  Entries:   ${ENTRY_COUNT}"
    echo "  Oldest:    ${OLDEST}"
    echo "  Newest:    ${NEWEST}"

    # By type
    echo ""
    echo "  By type:"
    sqlite3 "${DB_PATH}" "SELECT '    ' || type || ': ' || COUNT(*) FROM entries GROUP BY type ORDER BY COUNT(*) DESC;" 2>/dev/null || true
  else
    echo -e "  Database:  ${RED}NOT FOUND${NC}"
  fi

  # Backup
  echo ""
  if [ -f "${BACKUP_PATH}" ]; then
    BACKUP_SIZE=$(ls -lh "${BACKUP_PATH}" | awk '{print $5}')
    BACKUP_DATE=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S" "${BACKUP_PATH}" 2>/dev/null || echo "unknown")
    echo -e "  Backup:    ${GREEN}EXISTS${NC} (${BACKUP_SIZE}, ${BACKUP_DATE})"
  else
    echo -e "  Backup:    ${YELLOW}NONE${NC}"
  fi

  # Server
  echo ""
  if lsof -i :3150 -sTCP:LISTEN >/dev/null 2>&1; then
    echo -e "  Server:    ${GREEN}RUNNING${NC} on port 3150"
  else
    echo -e "  Server:    ${RED}NOT RUNNING${NC}"
    echo "  Run: node scripts/vcontext-server.js"
  fi

  echo ""
}

# ── Install launchd plist (optional) ───────────────────────────
cmd_install() {
  log "Installing launchd plist for auto-start"
  mkdir -p "$(dirname "${PLIST_PATH}")"
  cat > "${PLIST_PATH}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${HOME}/skills/scripts/vcontext-setup.sh</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/vcontext-setup.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/vcontext-setup.log</string>
</dict>
</plist>
PLIST
  launchctl load "${PLIST_PATH}" 2>/dev/null || true
  log "Plist installed at ${PLIST_PATH}"
}

# ── Uninstall launchd plist ────────────────────────────────────
cmd_uninstall() {
  if [ -f "${PLIST_PATH}" ]; then
    launchctl unload "${PLIST_PATH}" 2>/dev/null || true
    rm -f "${PLIST_PATH}"
    log "Plist removed"
  else
    warn "No plist found"
  fi
}

# ── Main ───────────────────────────────────────────────────────
case "${1:-}" in
  start)     cmd_start ;;
  stop)      cmd_stop ;;
  status)    cmd_status ;;
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  *)
    echo "Usage: $0 {start|stop|status|install|uninstall}"
    echo ""
    echo "  start     Create 4GB RAM disk, init/restore database"
    echo "  stop      Backup database, unmount RAM disk"
    echo "  status    Show RAM disk, database, and server status"
    echo "  install   Install launchd plist for auto-start on login"
    echo "  uninstall Remove launchd plist"
    exit 1
    ;;
esac
