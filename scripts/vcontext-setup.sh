#!/bin/bash
# vcontext-setup.sh — RAM disk lifecycle for Virtual Context
# Usage: ./scripts/vcontext-setup.sh {start|stop|status}
#
# Creates a 4GB APFS RAM disk at /Volumes/VContext with a SQLite + FTS5
# database for Claude Code's virtual memory system.

set -euo pipefail

MOUNT_POINT="/Volumes/VContext"
DB_PATH="${MOUNT_POINT}/vcontext.db"
BACKUP_DIR="${HOME}/skills/data"
BACKUP_PATH="${BACKUP_DIR}/vcontext-backup.sqlite"
RAM_BLOCKS=12582912  # 6GB in 512-byte blocks (was 4GB — expanded 2026-04-17 for headroom)
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
restore_backup() {
  if [ -f "${BACKUP_PATH}" ]; then
    log "Restoring from backup: ${BACKUP_PATH}"
    cp "${BACKUP_PATH}" "${DB_PATH}"
    # Verify integrity
    if sqlite3 "${DB_PATH}" "PRAGMA integrity_check;" | grep -q "ok"; then
      log "Backup restored and verified"
    else
      warn "Backup integrity check failed, reinitializing"
      rm -f "${DB_PATH}"
      init_db
    fi
  else
    init_db
  fi
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

  log "Creating 6GB RAM disk (${RAM_BLOCKS} x 512-byte blocks)"
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
  log "  Size:     6 GB RAM"
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
