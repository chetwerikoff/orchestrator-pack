# CI pipeline split (Issue #487, eight-way experiment #536)

Parallel Vitest matrix sharding for PR-required full regression, with a
fail-closed aggregate check that preserves the existing required status name
**Run pack contract tests**.

## Architecture

```text
classify-pr-changes (markdown-only skip)
  |
  +--> Type-check pack sources (tsc --noEmit + review-start claim guard)
  +--> Vitest shard 1..N (matrix; one worker per runner; CI serialized files)
  +--> Pester regression (test-all.ps1 -SkipNpm)
  |
  +--> Run pack contract tests (aggregate; fail-closed on any lane)
```

Shard count is canonical in `scripts/ci-pipeline-split.config.json` (currently **8**).

Issue #487 shipped a **4-way** Vitest matrix. Issue #536 doubles isolation to
**8-way** as a cheap reversible experiment to reduce PR-required regression
critical-path wall time. Runtime-weighted shard assignment remains a planned
follow-up if imbalance persists after this change.

## Pre-change baseline (GHA, 2026-06-30)

Ten successful `scope-guard` runs on `main` before the eight-way experiment are
documented in `docs/investigations/ci-test-speed-current-baseline.md`:

- **Vitest shard 3/4** was the slowest shard in **10/10** runs (p50 **597s** /
  ~9m57s; other shards p50 **125s** / ~2m05s, range 91s–162s).
- Workflow critical path p50 **597s** (~9m57s) — dominated by shard 3/4, not
  typecheck, Pester, or `verify-pack`.
- Root cause: Vitest default round-robin assigns sorted files by index, not by
  duration; heavy integration tests cluster in one bucket.

Eight-way round-robin redistributes files across `(i mod 8)` buckets. Baseline
estimates suggest **~40–50%** critical-path reduction (rough p50 ~5–7 min), not
~2 min — durable balance likely needs weighted sharding later. **Do not treat
unverified timing improvements as fact** until measured on a representative PR
run.

## Timing baseline (2026-06-28, local WSL2, 4-way)

Measurements exclude GitHub queue time. **Before** is the pre-split monolithic
`tests` job path on the same host (`CI=true`, serialized Vitest).

| Stage | Before (serial) | After (4-way shard) |
| --- | ---: | ---: |
| `tsc --noEmit` | ~12 s | ~12 s (parallel lane) |
| Vitest (`npm test`) | ~683 s wall | ~175 s wall (slowest shard, parallel) |
| Pester (`test-all.ps1 -SkipNpm`) | ~45 s | ~45 s (parallel lane) |
| **Complete tests path** | **~740 s (~12.3 min)** | **~190 s (~3.2 min)** |

Vitest per-shard keeps `fileParallelism: false` and `maxWorkers: 1` in
`vitest.config.ts` to avoid the known `vitest-worker` `onTaskUpdate` RPC timeout
class. Matrix sharding recovers wall-clock parallelism at the runner level.

Shard fan-out inherits workflow-level PR-scoped cancellation from Issue #486
(superseded runs cancel; aggregate binds `GITHUB_SHA` + `GITHUB_RUN_ID` only).

## Rollback

To revert the eight-way experiment to four shards:

1. Set `vitestShardCount` to **4** in `scripts/ci-pipeline-split.config.json`.
2. Update `.github/workflows/scope-guard.yml` `test-vitest` matrix to
   `shard: [1, 2, 3, 4]`, display name `.../4`, and `-ShardTotal 4`.
3. Update `scripts/check-ci-pipeline-split.test.ts` expectations to match.
4. Re-run `pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1`.

Branch protection and the aggregate check name **Run pack contract tests** stay
unchanged — no rename required.

To restore the pre-#487 monolithic path instead:

- Restore the monolithic `tests` job in `.github/workflows/scope-guard.yml`
  (single job running `tsc`, Vitest via `test-all.ps1`, and Pester), remove
  `test-typecheck` / `test-vitest` / `test-pester` / `test-aggregate`, and
  revert `scripts/check-ci-cheap-wins.ps1` to require `test-all.ps1` in the
  tests job. Delete or bypass `scripts/check-ci-pipeline-split.ps1` invocation
  in `verify-pack`.

## Required-check migration

- **Promotion:** the aggregate job keeps the stable display name **Run pack
  contract tests** so branch protection does not need a second required check.
- **Rollback:** see **Rollback** above; aggregate name and fail-closed
  semantics stay constant.

## Verification

```powershell
pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
```
