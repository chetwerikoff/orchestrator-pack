# Fleet hygiene sentinel runbook (Issue #711)

Standing **external** observer for wake-supervisor fleet shape and machine-wide `pwsh`
ceilings. The sentinel is **not** a supervised registry child — install it via operator
scheduling (cron, systemd timer, or launchd), not via `orchestrator-wake-supervisor.ps1`.

## Entry points

| Action | Command | Use |
| --- | --- | --- |
| Scheduled sentinel | `pwsh -NoProfile -File scripts/orchestrator-fleet-hygiene-sentinel.ps1 -Action Sentinel` | cron / timer every N minutes |
| On-demand hygiene | `pwsh -NoProfile -File scripts/orchestrator-fleet-hygiene-sentinel.ps1 -Action Hygiene` | post-merge drill; prints H1–H7 pass/fail lines |

Both actions evaluate the same **H1–H7** assertions from `scripts/lib/Orchestrator-FleetHygiene.ps1`.

## Configuration

| Variable | Default | Purpose |
| --- | ---: | --- |
| `AO_SIDE_PROCESS_STATE_DIR` or `-StateDir` | pack default | Side-process state root (`supervisor.pid`, logs) |
| `AO_FLEET_HYGIENE_KILL_ENABLE` | unset (`0`) | Set to `1` to allow conservative kill on breach (**off by default**) |
| `AO_FLEET_HYGIENE_MAX_PWSH_COUNT` | `200` | H6 total machine `pwsh` ceiling |
| `AO_FLEET_HYGIENE_MAX_SUPERVISOR_RSS_KB` | `1048576` | H6 Σ supervisor RSS ceiling (kB) |
| `AO_FLEET_HYGIENE_MAX_SUPERVISOR_LOG_BYTES` | `52428800` | H7 log size cap |
| `AO_FLEET_HYGIENE_DUPLICATE_LOG_STORM_MIN` | `5` | H7 `terminating duplicate` lines in log tail |
| `AO_FLEET_HYGIENE_ALERT_FILE` | stderr JSON | Optional alert sink file |

## Assertions (summary)

- **H1** — exactly one supervisor for the state root (reuses #613 discovery)
- **H2** — exactly one managed process per registry role
- **H3** — no unmanaged role-tagged `pwsh` (TestMode excluded via stand-in predicate until #247)
- **H4** — no supervisor whose `-File` path is outside the live pack checkout (#552 same-checkout detached supervisors pass)
- **H5** — `orchestrator-wake-supervisor.ps1 -Action Status` exit 0
- **H6** — machine `pwsh` count and supervisor RSS under caps
- **H7** — `supervisor.log` size and duplicate-terminator storm

## Platform support

H1–H4 require Linux `/proc` environment reads (same capability class as #613). On
platforms without that capability, both sentinel and hygiene action **fail closed** with an
explicit unsupported-platform diagnostic.

## Install examples

See:

- `docs/examples/fleet-hygiene-sentinel.cron.example`
- `docs/examples/fleet-hygiene-sentinel.systemd.timer.example`

## Post-merge drill

```bash
pwsh -NoProfile -ExecutionPolicy Bypass \
  -File scripts/orchestrator-fleet-hygiene-sentinel.ps1 \
  -Action Hygiene -StateDir "$AO_SIDE_PROCESS_STATE_DIR"
```

Expect exit **0** on a healthy fleet. Non-zero exit lists failing H1–H7 lines.

## Kill mode (explicit only)

Leave kill disabled in production unless remediating a known storm. When enabled:

```bash
export AO_FLEET_HYGIENE_KILL_ENABLE=1
pwsh -NoProfile -File scripts/orchestrator-fleet-hygiene-sentinel.ps1 -Action Sentinel
```

Kill path re-validates identity immediately before signal. When `supervisor.lock` names a
live holder (#246), that pid is canonical; otherwise the #613 heuristic winner survives.
