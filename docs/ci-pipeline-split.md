# CI pipeline split (Issues #487, #536, #556)

Runtime-weighted Vitest lanes for PR-required full regression, with a fail-closed
aggregate check that preserves the existing required status name **Run pack
contract tests**.

## Architecture

```text
classify-pr-changes (markdown-only skip)
  |
  +--> Type-check pack sources (tsc --noEmit + review-start claim guard)
  +--> Vitest light lane (bounded workers; classified light files only)
  +--> Vitest heavy shard 1..N (runtime-weighted; serial in-runner)
  +--> Pester regression (test-all.ps1 -SkipNpm)
  |
  +--> Run pack contract tests (aggregate; fail-closed on any lane)
```

Lane topology is canonical in:

- `scripts/ci-pipeline-split.config.json` — job names and heavy shard count (**7**)
- `scripts/vitest-ci-lanes.config.json` — per-file **light** / **heavy** classification
- `scripts/vitest-runtime-history.json` — per-file timing evidence for weighted shards

Issue #487 shipped a **4-way** Vitest matrix. Issue #536 doubled isolation to
**8-way** round-robin as a reversible experiment. Issue #556 replaces round-robin
with **runtime-weighted heavy shards** plus a **bounded-parallel light lane**.

## Heavy vs light classification

Every discovered Vitest file must be explicitly classified in
`scripts/vitest-ci-lanes.config.json`:

| Lane | Execution | Criteria |
| --- | --- | --- |
| **light** | Bounded in-process parallelism (`lightMaxWorkers`, currently **2**) | Pure unit/static tests without subprocess/git/tmux/PowerShell integration |
| **heavy** | Serial in-runner on one GitHub Actions shard | Subprocess, git, filesystem, tmux, or PowerShell integration tests |
| **unclassified** | Blocks CI | New, renamed, or missing manifest entries fail `classification-required` |

### Reclassifying a test

1. Measure wall time on a representative CI run (or local `CI=true npm test -- <file>`).
2. Update `classification` in `scripts/vitest-ci-lanes.config.json`.
3. For **heavy → light**, include timing evidence in the PR showing the file stays
   under the slow-test budget and does not reproduce worker-RPC flakes under
   bounded parallelism.
4. For **light → heavy**, add/update `scripts/vitest-runtime-history.json` when
   timing history exists.
5. Re-run `pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1`.

**False-light classification is the dangerous failure** (can reintroduce
`onTaskUpdate` flakes). When uncertain, classify **heavy**.

## Runtime-weighted heavy shards

Heavy files are assigned to `heavyShardCount` shards using greedy LPT bin packing
on `vitest-runtime-history.json` timings. Files without history use
`heavyDefaultRuntimeMs` (**120s** conservative fallback).

Guards prove:

- Lane union equals serial discovery (no missing/duplicate files)
- Unknown files cannot enter accepted lanes
- Heavy shard union equals the classified heavy set

## Light lane parallelism bound

`lightMaxWorkers` is explicit, capped at **4**, and reversible by setting
`lightMaxWorkers: 1` or disabling the light lane (see rollback). CI scans logs for
`onTaskUpdate`, `vitest-worker`, `STACK_TRACE_ERROR`, and RPC timeout signatures.

## Timeout budget alignment

CI `testTimeout` in `vitest.config.ts` matches the Issue #488 slow-test budget
(`perTestMs` = **120s**). CI must not use a lower Vitest timeout than the declared
per-test budget unless a file or lane documents a narrower timeout.

## Pre-change baseline (GHA, 2026-06-30)

Eight-way round-robin (#536) baseline is documented in
`docs/investigations/ci-test-speed-current-baseline.md`. Shard imbalance persisted
under round-robin because assignment ignored runtime.

## Rollback

### To #536 eight-way serial round-robin

1. Restore `test-vitest` matrix job (`shard: [1..8]`) invoking
   `scripts/run-vitest-shard.ps1 -ShardTotal 8`.
2. Remove `test-vitest-light` / `test-vitest-heavy` jobs.
3. Revert `scripts/ci-test-aggregate.ps1` to single `VITEST_RESULT`.
4. Revert `vitest.config.ts` to serial-only CI (`fileParallelism: false`,
   `maxWorkers: 1` for all CI).
5. Set `vitestShardCount: 8` in `scripts/ci-pipeline-split.config.json`.

Branch protection and the aggregate check name **Run pack contract tests** stay
unchanged.

### To pre-#487 monolithic path

See Issue #487 rollback in git history — restore monolithic `tests` job with
`test-all.ps1`.

## Required-check migration

- **Promotion:** aggregate job keeps **Run pack contract tests**.
- **Rollback:** see above; aggregate name and fail-closed semantics stay constant.

## Runtime-history refresh (Issue #691)

Measured per-file durations from heavy-shard Vitest JSON reports refresh
`scripts/vitest-runtime-history.json` on **main push**, **weekly schedule**, and
**workflow_dispatch** via `.github/workflows/vitest-runtime-history-refresh.yml`.
The refresh does **not** run on ordinary PR events.

- Smoothing rule: `median-of-last-5-samples` (spike-resistant; not last-run-wins)
- Provenance gate: all heavy shards must succeed at a matching commit; partial,
  failed, mismatched, or unclassified paths are rejected without mutating history
- Race-safe single-writer commit-back with idempotent no-op when data is unchanged
- Durable per-entry provenance (`measured` / `seeded` / `fallback`) sits beside the
  numeric `files` map consumed by Issue #556 LPT assignment
- `dataChangedAt` records when a file weight last changed (not validation-only reruns)

Guards and fixtures live in `scripts/check-ci-pipeline-split.ps1` and
`scripts/lib/vitest-runtime-history-merge.fixture.mjs`.

## Verification

```powershell
npm ci --include=dev
pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
```

CI evidence on the implementation PR should record per-lane/per-shard durations,
the slowest heavy shard, light lane duration, lane assignment counts, and a log
scan showing zero accepted worker-RPC signatures.

## Before/after assignment summary (Issue #556)

| Metric | #536 round-robin (8 shards) | #556 lanes |
| --- | ---: | ---: |
| Discovered Vitest files | 108 | 108 |
| Light lane files | — | 41 (bounded parallel) |
| Heavy shard files | 108 (all serial) | 67 (weighted across 7 shards) |
| Aggregate required check | Run pack contract tests | unchanged |
