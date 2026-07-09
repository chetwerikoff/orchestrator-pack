# Issue #692 — Vitest heavy mega-file split evidence

## Semantics inventory (machine-generated)

Source: `enumerateVitestFileTestTitles` from `scripts/lib/vitest-ci-lanes.mjs` on pre-split `main` mega-files vs post-split replacements.

| Metric | Count |
|--------|------:|
| Pre-split titles (4 mega-files) | 46 |
| Post-split titles (14 replacement files + `supervisor-auto-recovery.test.ts`) | 50 |

The sole pre-split-only title is the Vitest static name `keeps supervisor alive after ${label}` from the `for`-loop in `supervisor-fault-boundary.test.ts`. Post-split expands that into four concrete titles (redirect disposed, child-entry null, status-entry, recovery-stop). No assertion or supervisor exercise was dropped or altered; only file boundaries moved.

**Changes beyond file-boundary moves:** none.

## Per-file runtime weights (documented estimates)

Weights below are conservative estimates / `heavyDefaultRuntimeMs` defaults unless noted as measured from CI run [28994188708](https://github.com/chetwerikoff/orchestrator-pack/actions/runs/28994188708).

| Pre-split file | Est. ms | Post-split files | Est. ms each |
|----------------|--------:|------------------|-------------:|
| `orchestrator-wake-supervisor.test.ts` | 500000 | startup / lifecycle / side-process-registry / empty-pid | 180000 / 200000 / 120000 / 90000 |
| `supervisor-degraded-backoff.test.ts` | 400000 | restart / crash-preserve | **27.0s** / **24.8s** measured (CI run 28994188708) |
| `supervisor-fault-boundary.test.ts` | 200000 | 4 injection + escalate + deterministic-terminal | 50000–80000 |
| `orchestrator-wake-listener.test.ts` | 120000 | evaluate / helpers | 60000 / 60000 |
| `supervisor-auto-recovery.test.ts` | 120000 | (unchanged single file — one `it`, no seam) | 120000 |

`supervisor-degraded-backoff-crash-preserve.test.ts` retains a single `it` (no further split seam without changing semantics). Its planner weight is **25s measured** from CI (Vitest reported 24.83s on shard 2/9), replacing the interim 280s estimate that incorrectly retained the pre-split mega-file floor.

## Measured heavy-shard assignment (representative PR CI runs)

Source: GitHub Actions `scope-guard` workflow `vitest-lane-timing` lines (`run-vitest-heavy-shard.ps1`) and per-file Vitest JSON report `Duration` from the same job logs. Both runs are non-markdown PR-path classifications on `ubuntu-latest`.

| | **Before split (`main`)** | **After split (PR #706)** |
|---|---|---|
| CI run | [28990733442](https://github.com/chetwerikoff/orchestrator-pack/actions/runs/28990733442) | [28994188708](https://github.com/chetwerikoff/orchestrator-pack/actions/runs/28994188708) |
| Head SHA | `c2dcc51d` | `e8828ce1` |
| Slowest heavy shard | **1/9 — 485.85s** observed (`weight_ms=860000`) | **8/9 — 327.14s** observed (`weight_ms=890000`) |
| Heaviest file on slowest shard | `scripts/orchestrator-wake-supervisor.test.ts` — **441.88s** measured | `scripts/orchestrator-wake-supervisor-startup.test.ts` — **141.14s** measured |
| Mega-file stacking | Shard **6/9** carries **two** pre-split mega-files serially: `orchestrator-wake-listener.test.ts` (0.61s) + `supervisor-fault-boundary.test.ts` (186.13s); shard elapsed **352.38s** | No heavy shard carries two of the four pre-split mega-files; largest former mega (`orchestrator-wake-supervisor`) is split across shards 3/4/5/8 |

### Observed per-shard elapsed (seconds)

| Shard | Before (`main` c2dcc51d) | After (PR #706 e8828ce1) |
|------:|-------------------------:|-------------------------:|
| 1 | 485.85 | 125.81 |
| 2 | 39.17 | 140.67 |
| 3 | 183.70 | 103.34 |
| 4 | 54.81 | 316.26 |
| 5 | 111.34 | 179.08 |
| 6 | 352.38 | 136.31 |
| 7 | 82.23 | 312.33 |
| 8 | 213.32 | **327.14** |
| 9 | 132.78 | 58.75 |

Slowest-shard makespan improved **485.85s → 327.14s** (−33%). The pre-split floor file (`orchestrator-wake-supervisor.test.ts` at 441.88s on shard 1) is gone; the heaviest post-split piece on the new slowest shard is `orchestrator-wake-supervisor-startup.test.ts` at 141.14s.

### Post-split LPT file assignment (PR head, plan output)

Mega-file replacements are spread across shards (no monolithic mega-file remains):

| Pre-split mega-file | Post-split heavy files (shard) |
|---------------------|--------------------------------|
| `orchestrator-wake-supervisor.test.ts` | `…-startup` (8), `…-lifecycle` (4), `…-side-process-registry` (5), `…-empty-pid` (3) |
| `supervisor-degraded-backoff.test.ts` | `…-restart` (8), `…-crash-preserve` (2) |
| `supervisor-fault-boundary.test.ts` | four injection files + `…-escalate` (4) + `…-deterministic-terminal` (1) + others on 6/7/8 |
| `orchestrator-wake-listener.test.ts` | `…-evaluate` (9), `…-helpers` (3) |

`supervisor-auto-recovery.test.ts` remains a single heavy file on shard 7 (one `it`, no seam).

## Heavy-shard LPT assignment (estimate weights, 9 shards)

Supplementary planner-weight view (not a substitute for measured CI timings above). Weights are conservative estimates / `heavyDefaultRuntimeMs` defaults until brief #1 harvest (#691).

Slowest shard by estimate weight after split: **shard 5 — 915s total**, heaviest file `plugins/ao-codex-pr-reviewer/tests/reviewer-budget.test.ts` (120s default).

Slowest shard by estimate weight before split (mega-files restored in plan): **shard 8 — 1320s total**, heaviest `scripts/orchestrator-message-registry.test.ts` (400s).
