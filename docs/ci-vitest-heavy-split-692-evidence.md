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

Weights are conservative estimates / `heavyDefaultRuntimeMs` defaults until brief #1 harvest (#691). Not treated as measured CI proof.

| Pre-split file | Est. ms | Post-split files | Est. ms each |
|----------------|--------:|------------------|-------------:|
| `orchestrator-wake-supervisor.test.ts` | 500000 | startup / lifecycle / side-process-registry / empty-pid | 180000 / 200000 / 120000 / 90000 |
| `supervisor-degraded-backoff.test.ts` | 400000 | restart / crash-preserve | 120000 / 280000 |
| `supervisor-fault-boundary.test.ts` | 200000 | 4 injection + escalate + deterministic-terminal | 50000–80000 |
| `orchestrator-wake-listener.test.ts` | 120000 | evaluate / helpers | 60000 / 60000 |
| `supervisor-auto-recovery.test.ts` | 120000 | (unchanged single file — one `it`, no seam) | 120000 |

## Heavy-shard LPT assignment (estimate weights, 9 shards)

Slowest shard after split: **shard 5 — 915s total**, heaviest file `plugins/ao-codex-pr-reviewer/tests/reviewer-budget.test.ts` (120s default).

Slowest shard before split (same file set with mega-files restored): **shard 8 — 1320s total**, heaviest `scripts/orchestrator-message-registry.test.ts` (400s).

No heavy shard stacks two of the four pre-split mega-files (`orchestrator-wake-supervisor`, `orchestrator-wake-listener`, `supervisor-fault-boundary`, `supervisor-degraded-backoff`) after the split. LPT assignment uses documented estimate weights; observed CI shard durations remain the primary balance proof on merge.
