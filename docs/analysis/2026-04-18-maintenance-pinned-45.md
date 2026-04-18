# Maintenance LaunchAgent Pinned to :45 (P6 Cadence Audit Followup)

**Date**: 2026-04-18
**Scope**: `com.vcontext.maintenance` LaunchAgent schedule
**Driver**: [2026-04-18 autonomous cadence audit](2026-04-18-autonomous-cadence-audit.md) — proposal P6
**Touches repo code**: `scripts/launchagent-health-check.sh` (parsing bugfix)
**Touches outside repo**: `~/Library/LaunchAgents/com.vcontext.maintenance.plist`

## Before

```xml
<!-- Run every hour. launchd catches up after wake/reboot. -->
<key>StartInterval</key>
<integer>3600</integer>
```

**Problem**: `StartInterval=3600` fires every hour *from the load time*. After
a boot at (say) 16:23, the agent fires at :23, :23, :23 … drifting unpredictably.

Wall-clock fire minute depended on when the server last rebooted. This created
two failure modes:

1. **Overlap risk**: if boot happens to land near `:00`, maintenance fires in
   the same minute as the `:00` cluster (keyword-expander, article-scanner,
   self-evolve, morning-brief, new-feature-watcher, conversation-skill-miner),
   contending for RAM disk + MLX resources.
2. **Phase ambiguity**: operator has no way to know "when will maintenance
   next fire?" without calling `launchctl print`. Invisible to the health-check
   row, which read `interval=3600s` instead of a wall-clock time.

## After

```xml
<!-- Pinned to :45 every hour (P6 cadence audit 2026-04-18). Away from :00 cluster. -->
<key>StartCalendarInterval</key>
<dict>
  <key>Minute</key>
  <integer>45</integer>
</dict>
```

- Fires at every `HH:45` local time, independent of boot time.
- `RunAtLoad` still `true` — boot triggers a catch-up fire.
- All other keys (ProgramArguments, StandardOut/ErrorPath, Nice, ProcessType)
  preserved verbatim.

## Why `:45`

Cadence audit tail-mapped the daily cluster:

| Minute | Agents firing |
|--------|---------------|
| `:00`  | keyword-expander, article-scanner, self-evolve, morning-brief, new-feature-watcher, conversation-skill-miner, article-scanner-evening |
| `:03 / :08 / :13 / …` | SSD backup cycle (every 5 min, offset-3) |
| `:30`  | skill-discovery (weekly) |

`:45` is maximally distant from both the `:00` cluster (15 min buffer) and the
backup phase (2 min from `:43` / `:48` nearest slots, not a conflict since
backups are fast). This lets maintenance compete for no contested resource.

## Verification (launchctl print)

```
$ launchctl print gui/$(id -u)/com.vcontext.maintenance | grep -A 2 descriptor
      descriptor = {
        "Minute" => 45
      }
```

Next fire at time of reload (current clock 17:23 JST):

```
$ bash scripts/launchagent-health-check.sh | grep maintenance
  OK  com.vcontext.maintenance  kind=cron-daily  pid=-  log_age=1 min  next_fire=2026-04-18 17:45
```

Matches expected — 22 minutes to next `:45`.

## Health-check fix

`scripts/launchagent-health-check.sh`'s `next_fire_for()` originally required
both `Hour` and `Minute` in the StartCalendarInterval descriptor and returned
`MALFORMED` otherwise. Minute-only schedules (hourly repetition pinned to a
minute) are a valid launchd idiom, so the parser now accepts `minute` alone
and computes the next-hour fire via Python datetime arithmetic.

Verified against the running agent: returns `2026-04-18 17:45` (correct).
No regression for other agents — they all have both Hour and Minute set.

## Revert

```bash
# 1. Restore old plist inline
cat > ~/Library/LaunchAgents/com.vcontext.maintenance.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.vcontext.maintenance</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/mitsuru_nakajima/skills/scripts/vcontext-maintenance.sh</string>
  </array>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/vcontext-maintenance-launchd.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/vcontext-maintenance-launchd.log</string>
  <key>Nice</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
EOF

# 2. Reload
launchctl bootout gui/$(id -u)/com.vcontext.maintenance
sleep 2
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.vcontext.maintenance.plist

# 3. (Optional) revert the health-check parser by `git revert <this commit>`
```

## Observations to watch next 48h

- `/tmp/vcontext-maintenance-launchd.log` should get new entries at `:45`
  every hour, starting from the next `:45` after load.
- Health-check row should continue showing `next_fire=YYYY-MM-DD HH:45`
  rolling forward.
- If any contention with the backup phase is observed (rare — backups are
  <1s), shift to `:47` or similar — one-line plist edit.
