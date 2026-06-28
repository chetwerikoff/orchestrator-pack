# CI pipeline split (Issue #487)

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

Shard count is canonical in `scripts/ci-pipeline-split.config.json` (currently **4**).

## Timing baseline (2026-06-28, local WSL2)

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

## Required-check migration

- **Promotion:** the aggregate job keeps the stable display name **Run pack
  contract tests** so branch protection does not need a second required check.
- **Rollback:** restore the monolithic `tests` job in
  `.github/workflows/scope-guard.yml` (single job running `tsc`, Vitest via
  `test-all.ps1`, and Pester), remove `test-typecheck` / `test-vitest` /
  `test-pester` / `test-aggregate`, and revert `scripts/check-ci-cheap-wins.ps1`
  to require `test-all.ps1` in the tests job. Delete or bypass
  `scripts/check-ci-pipeline-split.ps1` invocation in `verify-pack`.

## Verification

```powershell
pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
```
