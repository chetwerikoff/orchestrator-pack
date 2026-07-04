# Phase-0 audit retention bounds (Issue #588)

Pack-owned GitHub telemetry JSONL streams are append-only observability. Maintenance is
best-effort, opportunistic on append, and must never fail or delay wrapped GitHub work.

## Streams

| Stream | Default active path | Producer |
| --- | --- | --- |
| Wrapper audit | `$XDG_STATE_HOME/orchestrator-pack/gh-wrapper-audit.jsonl` (supervisor children use `$AO_SIDE_PROCESS_STATE_DIR/gh-wrapper-audit.jsonl`) | `scripts/lib/gh-wrapper.mjs` |
| Fleet cache audit | `$AO_SIDE_PROCESS_STATE_DIR/github-fleet-cache/audit.jsonl` | `Write-GhFleetInventoryCacheAudit` in `scripts/lib/Gh-FleetInventoryCache.ps1` |

Enable stderr mirrors with `GH_WRAPPER_AUDIT=1` and `GH_FLEET_CACHE_AUDIT=1` (supervisor
children inherit both).

## Bounded defaults

Policy defaults live in `scripts/audit-jsonl-retention-policy.json` and are grounded in the
2026-07-04 measured rates:

| Stream | ~bytes/line | ~daily growth | Active rotate trigger | Total footprint cap | Age cap |
| --- | ---: | --- | ---: | ---: | ---: |
| Wrapper | 264 | 100–130 MB/day | 64 MB | 1 GB (~0.7–1.5 GB/week envelope) | 7 days |
| Fleet cache | 517 | 15–20 MB/day | 16 MB | 200 MB (~0.1–0.2 GB/week envelope) | 7 days |

Absent, disabled, or malformed operator overrides fall back to these caps — retention is
never unbounded by default.

## Operator overrides

Per-stream environment variables (all optional, positive integers only):

- Wrapper: `GH_WRAPPER_AUDIT_MAX_ACTIVE_BYTES`, `GH_WRAPPER_AUDIT_MAX_TOTAL_BYTES`, `GH_WRAPPER_AUDIT_MAX_AGE_DAYS`
- Fleet cache: `GH_FLEET_CACHE_AUDIT_MAX_ACTIVE_BYTES`, `GH_FLEET_CACHE_AUDIT_MAX_TOTAL_BYTES`, `GH_FLEET_CACHE_AUDIT_MAX_AGE_DAYS`

`GH_WRAPPER_AUDIT_FILE` still redirects the wrapper active file path for tests or custom
layouts; retention operates on that resolved active file and sibling rotated segments in the
same directory.

## Maintenance semantics

- Hot append path performs at most one active-file size probe before append.
- Segment enumeration and age/total-footprint pruning run only when a rotation trigger fires.
- Rotation uses a nonblocking per-file advisory lock (`<active>.maintenance.lock`). Writers that
  cannot acquire the lock append and skip rotation for that call.
- Active-file size triggers rotation to timestamped `*.YYYYMMDDTHHMMSSZ.jsonl` segments. Retention
  age and total-footprint policy delete older segments; footprint is authoritative when pressures
  conflict.
- Rotation/prune failures are logged on stderr (`*-audit-retention:` / `write_failed`) but never
  change wrapper exit codes or cache populate semantics.
