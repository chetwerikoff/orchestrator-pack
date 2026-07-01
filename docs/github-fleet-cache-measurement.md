# GitHub fleet inventory cache measurement (Issue #453 AC#5)

Phase 1 ships a read-through cache (open-PR list snapshot + SHA→date memo + shared PR/CI/protection read model per Issue #569). Use this
procedure after merge to decide whether Phase 2 hard rate-gating (`#142`) is warranted.

## Prerequisites

- Wake supervisor running on `main` with Issue #453 merged and supervisor restarted.
- Pack `scripts/gh` REST shim active for children (Issue #447).
- Operator token with routine fleet + AO load (normal + peak windows).

## Instrumentation

Enable cache audit lines (optional, for overlap debugging):

```bash
export GH_FLEET_CACHE_AUDIT=1
```

Count subprocess spawns at the pack `gh` shim (fleet-attributed calls). Append one JSON
line per invocation to a hourly roll-up file, e.g. `$AO_SIDE_PROCESS_STATE_DIR/gh-spawn-audit.jsonl`
(instrument inside `scripts/gh` or a wrapper hook — planner choice at deploy time).

Each hour record:

| Metric | Source |
|---|---|
| Fleet `gh` subprocess count | spawn audit filtered to supervisor child PIDs |
| Per-child `gh` count | same audit grouped by `AO_SIDE_PROCESS_CHILD_ID` when present |
| List overlap ratio | identical `gh pr list` argv within 10s / total list calls |
| Memo-eligible commit lookups | `gh api …/commits/` calls |
| Fresh SHA commit lookups | first-seen SHAs per hour |
| Checks-class calls | `gh pr checks`, branch protection, etc. (shared per Issue #569 when supervisor cache warm) |
| REST `core` used/remaining | `gh api rate_limit` sample |
| GraphQL used/remaining | `gh api rate_limit` sample |

Also capture supervisor `supervisor.log` degraded lines mentioning rate limits.

## Observation window

Run **≥72 hours** under normal operation plus at least one peak window (active PRs, review
traffic, `review-trigger-reeval` cadence).

## Sufficiency verdict (Phase 1)

**Phase 1 sufficient** when all hold for the window:

- P95 fleet-attributed `gh` subprocess rate **≤ 4000/hr** (80% of REST `core` 5000/hr)
- P95 **total token consumption** (REST `core` + GraphQL) stays within headroom — not only fleet-attributed calls
- No secondary/abuse-limit reproduction
- No sustained operator-visible rate-limit degraded churn in supervisor logs

## Phase 2 trigger

Open `#142` only when:

- P95 fleet rate **> 4000/hr** (fleet is the dominant consumer), **or**
- Secondary-limit reproduced, **or**
- High-cadence list ticks still breach quota despite memo + snapshot

**Routing caveat:** token saturated while fleet rate **< 4000/hr** (co-tenant `getPRState`,
orchestrator, reviewer load) is **not** a Phase 2 trigger — route to repo-wide budget follow-up
(`#129` / `#130`), not fleet hard-gating.

## Operator adoption check

After supervisor restart, confirm `GH_FLEET_CACHE_AUDIT=1` (if enabled) shows `open_pr_list_hit`,
`ci_checks_hit`, `branch_protection_hit`, and `pr_view_hit` events under routine ticks and that concurrent
children do not produce duplicate list/checks/protection populate bursts beyond the AC bounds.
