# Watchdog Probe Frequency Audit — 2026-04-18

Scope: read-only audit of `scripts/vcontext-watchdog.sh` (outer loop cadence
and per-target probe behavior) + launchd plist + real-world log behavior.
Follow-up from today's `ae1ce3f` fix (MLX embed timeout 5 s → 30 s, 2-strike
rule). That commit tuned the per-target *timeout* and *failure threshold*;
this audit examines the BASE probe frequency (`CHECK_INTERVAL`) that the
outer loop sleeps on.

Inputs:
- `/Users/mitsuru_nakajima/skills/scripts/vcontext-watchdog.sh` (297 lines)
- `~/Library/LaunchAgents/com.vcontext.watchdog.plist`
- `/tmp/vcontext-watchdog.log` (tail -100, 184 lines total)
- `launchctl print gui/501/com.vcontext.watchdog`
- `ps -o etime=` for PID 52912

---

## Section 1 — Current configuration

| Field | Value | Source |
|---|---|---|
| outer-loop sleep (`CHECK_INTERVAL`) | **60 s** (env-overridable) | script:L33 |
| vcontext `:3150` probe (`check_health`) curl timeout | 3 s | script:L45 (`--connect-timeout 3`) |
| `:3150` failure threshold | 1 (fire alert + try `vcontext-wrapper.sh` on first fail) | script:L113-128 |
| `:3150` action on fail | notify (macOS + optional webhook, 300 s cooldown) + restart wrapper if absent + (if missing from launchd graph) `launchctl bootstrap` | script:L115-155 |
| MLX-embed `:3161` curl timeout | **30 s** (post `ae1ce3f`) | script:L205 |
| MLX-embed failure threshold | **2 consecutive** (post `ae1ce3f`) | script:L208-216 |
| MLX-embed probe cadence | every outer cycle (`% 1 == 0`) | script:L202 |
| MLX-embed action on fail | `launchctl unload` + `kill -9` + `lsof -ti :3161 \| xargs kill -9` + `launchctl load` | script:L218-222 |
| MLX-embed memory kill | > 10 000 MB (when health OK) | script:L38, L216 |
| MLX-generate `:3162` probes | `/v1/models` 5 s timeout (liveness); fallback `/v1/chat/completions` 90 s timeout; plus `/health` 3 s for call-count JSON | script:L261, L264, L274 |
| MLX-generate failure threshold | 1 (restart if BOTH `/v1/models` ≠ 200 AND fallback generation ≠ 200/503) | script:L262-270 |
| MLX-generate probe cadence | every outer cycle (`% 1 == 0`, comment says "every 5 min" but the modulus is 1) | script:L234 |
| MLX-generate action on fail | `launchctl unload` + `kill -9` + `lsof -ti :3162` + `launchctl load` | script:L283-291 |
| MLX-generate memory kill | > 14 000 MB | script:L37, L252 |
| MLX-generate call-count kill | > 200 `/health.calls` | script:L39, L276 |
| RAM-disk check | every cycle; WARN 85 %, CRIT 95 % → sqlite TRUNCATE checkpoint + remove `*corrupt*.db` | script:L35-36, L158-178 |
| SearXNG docker check | every cycle (`% 1 == 0`; comment says "every 5 min", modulus is 1) | script:L181-184 |
| `RunAtLoad` | true | plist:L12-13 |
| `KeepAlive` | true (unconditional — respawn on exit) | plist:L14-15 |
| schedule (`StartCalendarInterval` / `StartInterval`) | none — pure sleep-loop inside script | plist |
| launchd state (now) | running, PID 52912, active_count=1, uptime 2 h 09 m | `launchctl print` |

### Important discrepancy — code vs. comment

The source comments at L180 ("Check SearXNG every 5 minutes (every 5th
iteration)"), L186 ("MLX Embed health check every minute"), and L230
("MLX Generate health check every 5 minutes (every 5th iteration)") all
imply sub-sampling of the outer loop. But every one of those guards is
`if [[ $((SEARXNG_CHECK_COUNTER % 1)) -eq 0 ]]` — modulo 1 is always 0.
**Effective cadence for every check is the outer `CHECK_INTERVAL` = 60 s.**
The counter variable is incremented but the `% 5` that the comment
describes was never applied.

This is not itself a bug (probing every 60 s is fine) but it means the
tuning knob the author intended to offer doesn't exist — any future attempt
to "slow down the MLX probes" by editing the modulus will silently no-op.

---

## Section 2 — Observed behavior (log-driven)

`log()` fires only on events (alert, restart, bootstrap, RAM warn).
Healthy-probe cycles leave no trace. So inter-log delta ≠ inter-probe
delta; instead it's inter-*event* delta, which is what an operator
actually sees and cares about.

Window: last hour, 16:26 → 17:26 (now = 17:26:36).

Events in window:
```
16:09:30  ALERT :3150 down              (just before window, included for context)
16:14:07  wrapper restart attempt
16:14:13  bootstrap com.vcontext.server
16:14:18  MLX Generate: process not found → restart
16:14:25  MLX Generate restarted
16:15:29  ALERT :3150 down + wrapper restart
16:15:35  bootstrap com.vcontext.server
16:20:44  ALERT :3150 down
[silence 16:20:44 → 17:26, 65 min no events]
```

- **Events in last 60 min (16:26–17:26):** 0.
- **Events in last 2 h (15:26–17:26):** 14 (mostly clustered 16:14–16:20).
- Inter-event delta histogram (all 2 h events, coalesced by same-second):
  - < 10 s apart: 6 (bootstrap/restart chains — expected burst)
  - 10–60 s apart: 1 (16:14:18 → 16:14:25)
  - 1–5 min apart: 3 (16:09→16:14, 16:14:25→16:15:29, 16:15:35→16:20:44)
  - > 5 min apart: 1 (16:20:44 → silence → present, 65 min)
- Watchdog uptime vs. launchd: `active_count=1`, PID 52912, `etime=2:09:11`
  → single instance, singleton PIDFILE guard (L13-22) is working.

**Conclusion:** the watchdog is alive and probing every 60 s; the log
silence is the expected quiet-mode of a healthy system, not a stuck loop.
The 16:14–16:20 burst reflects the server restart cycle following the
earlier cascade — recovery took ~6 min across two wrapper restarts.

---

## Section 3 — Analysis

### Flapping risk (probes too frequent)

`:3150` has a 3 s connect timeout and restarts on first failure. Combined
with 60 s outer loop, worst-case restart cadence is 1/min. At 15:00–15:15
today, `:3161` (embed) restarted **10 times in 15 min** (log L47–67)
before `ae1ce3f` landed. Most restarts hit `mem=4–9 GB` with `health=timeout`
— classic blocked-event-loop during a batch, not a true hang. Today's
`ae1ce3f` fix (30 s timeout + 2-strike) is the correct remedy; that change
is on the *threshold* side, not the *frequency* side, so 60 s outer cadence
is not the proximate cause. No new flapping risk emerges from the
60 s interval itself.

### Slow-detection risk (probes too infrequent)

60 s gives at most 60 s user-visible downtime per incident before alert +
auto-recovery fires. The self-heal `launchctl bootstrap` block (L139-155)
and wrapper-restart (L120-128) mean most failures recover within the *next*
cycle, i.e. 60–120 s end-to-end. For a developer-facing cognitive
substrate that's acceptable; tightening to 30 s would not meaningfully
improve UX and would double log volume + CPU churn.

### MLX batch interaction

Typical `:3161` embed batch for 8B DWQ: 5–45 s on M-series GPU. Probe
every 60 s means in steady state ≤ 1 probe lands mid-batch per minute.
Before `ae1ce3f`, that one probe (5 s timeout) nearly always tripped and
restarted the server. After `ae1ce3f` (30 s timeout + 2-strike): to get a
false-positive restart, **two consecutive 60 s cycles must both land
inside a batch AND the batch must block > 30 s**. For typical batch
durations this is rare enough to drop the flap rate from ~40/h to
essentially 0 (consistent with the last 60 min of silence).

**Interaction is now well-damped.** No change to the 60 s interval is
warranted to improve MLX batch behavior — the fix was correctly placed
at the timeout + strike-count layer.

### Secondary findings (not the question, but surfaced)

1. **% 1 modulus bug (docs vs. code)** — three comments describe a
   5-iteration sub-sample that the code doesn't implement. Not
   functionally wrong (current behavior is fine), but the tuning knob
   is missing.
2. **Log file is shared between watchdog stdout and vcontext server stdout**
   (first 40 lines of `tail -100` are vcontext startup banner, not
   watchdog output). Check where `com.vcontext.server.plist` routes its
   StandardOutPath; if both plists point at `/tmp/vcontext-watchdog.log`,
   the audit trail is muddied. This is a separate plist hygiene issue.
3. **Single instance confirmed** — the 2026-04-17 triple-watchdog
   incident (L10-12 of the script's comment) has been fixed by the
   singleton PIDFILE guard; `launchctl print` shows `active_count=1` and
   the pidfile matches the running PID.

---

## Section 4 — Proposed adjustments

**Recommendation: keep `CHECK_INTERVAL=60s`. No change.**

Rationale:
- 60 s strikes the right balance: user-visible detection ≤ 60 s, log
  volume manageable (events-only), CPU/network footprint negligible.
- Today's fix (`ae1ce3f`) addressed the actual flap driver (timeout +
  strike count); changing the outer interval on top would either
  over-damp detection (slower) or resurrect flapping risk (faster).
- The 65 min quiet log window in the last hour is the correct signal
  of a healthy system, not staleness.

### Optional Phase 2 (cosmetic, not urgent) — log cleanup only

If log volume becomes an issue later, add explicit "heartbeat on shape
change" lines at L106 so operators can distinguish "watchdog idle because
healthy" from "watchdog hung." Not recommended today — the evidence we
have (pidfile + launchctl uptime + etime) is sufficient.

### Rollback

No change proposed → no rollback needed. If a future operator lowers
`CHECK_INTERVAL` via `VCONTEXT_WATCHDOG_INTERVAL` env var and observes
flapping return: `launchctl setenv VCONTEXT_WATCHDOG_INTERVAL 60` and
reload the plist.

---

## Section 5 — Followup (unclear / out of scope)

1. **Modulus-1 "sub-sample" comments** — worth a tiny doc-only PR to
   either (a) restore the intended `% 5` sub-sample for MLX Generate
   (probe every 5 min, keeping per-cycle for `:3161` embed) or (b) update
   comments to match code. Low risk either way, but do not mix with an
   interval tuning change.
2. **Shared log file** — check `com.vcontext.server.plist` stdout path;
   split if co-located with the watchdog log.
3. **Event metrics** — consider pushing watchdog events to `/metrics/report`
   so the dashboard can graph restart frequency per target over time
   (e.g. "MLX embed restarts/hour") without grepping /tmp/.
4. **Not investigated** — CPU cost of the 60 s cycle (curl ×4 + footprint
   ×2 + sqlite ×1 + df + pgrep). Anecdotally negligible; formal measurement
   not in scope.
