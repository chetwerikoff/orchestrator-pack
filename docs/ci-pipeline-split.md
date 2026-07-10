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

- `scripts/ci-pipeline-split.config.json` — job names and **fallback** heavy shard count (**7**)
- `scripts/vitest-ci-lanes.config.json` — per-file **light** / **heavy** classification and
  **heavyTopology** budget (`targetShardSeconds`, min/max caps, fallback count)
- `scripts/vitest-runtime-history.json` — per-file timing evidence (#691 harvest producer;
  ms values normalized to **seconds** at derivation/guard read time)
- `scripts/vitest-heavy-topology.plan.json` — CI-generated canonical topology artifact (derived
  count, matrix payload, fallback classification) from `emit-vitest-heavy-topology.mjs`

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

## Runtime-weighted heavy shards (Issue #556 + #695)

Heavy files are assigned to a **derived** `heavyShardCount` using greedy LPT bin packing
on `vitest-runtime-history.json` timings (milliseconds in the artifact; **seconds** in
policy math). Shard count is:

```text
clamp(ceil(heavyLaneTotalWeightSeconds / targetShardSeconds), minShardCount, maxShardCount)
```

`heavyLaneTotalWeightSeconds` sums resolved weights for files **classified heavy** only.
The oversized-file floor guard evaluates **every discovered** Vitest file.

Current budget (see `heavyTopology` in `scripts/vitest-ci-lanes.config.json`):

| Policy input | Value |
| --- | ---: |
| `targetShardSeconds` | **900** (15 min per-shard budget) |
| `minShardCount` | **1** |
| `maxShardCount` | **14** |
| `fallbackHeavyShardCount` | **7** |

Files without per-file history use `heavyDefaultRuntimeMs` (**120s** conservative fallback)
for **LPT assignment only**; the oversized guard fail-closes on PR-changed files with
missing/stale weights unless deterministic pre-topology same-run measurement supplies a
valid weight (see Issue #695).

When the runtime-history artifact is **present-but-unusable** (empty, corrupt, degenerate),
topology derivation falls back to `fallbackHeavyShardCount` and logs `fixed-fallback`.
**Whole-artifact absence** post-#691 is a loud fail-closed error (broken harvest), not a
fallback. Cap-hit clamping emits a non-blocking under-provisioned summary.

The `plan-vitest-ci-topology` job emits the canonical topology artifact and exposes
`heavy_shard_matrix` for the dynamic `test-vitest-heavy` matrix. `check-ci-pipeline-split.ps1`
enforces matrix/count parity and the oversized-file merge guard on the PR-required path.

Guards prove:

- Lane union equals serial discovery (no missing/duplicate files)
- Unknown files cannot enter accepted lanes
- Heavy shard union equals the classified heavy set
- Derived matrix count matches topology artifact parity
- Any discovered file above `targetShardSeconds` (after ms→seconds normalization) fails merge
  with split-or-speed-up guidance

### Pre-#691 integration note

Issue #695 consumes the #691 runtime-history schema (`files` ms map plus optional
`provenance` / `contentSha` per entry). Until #691 merges and main accumulates measured
weights, derivation runs on the committed `ci-baseline-estimates` seed; real-artifact
integration completes after #691 lands.

## Light lane parallelism bound

`lightMaxWorkers` is explicit, capped at **4**, and reversible by setting
`lightMaxWorkers: 1` or disabling the light lane (see rollback). CI scans logs for
`onTaskUpdate`, `vitest-worker`, `STACK_TRACE_ERROR`, and RPC timeout signatures.

## Timeout budget alignment

CI `testTimeout` in `vitest.config.ts` matches the Issue #488 slow-test budget
(`perTestMs` = **120s**). CI must not use a lower Vitest timeout than the declared
per-test budget unless a file or lane documents a narrower timeout.

## Wall-clock acceptance stage (Issue #694)

Supervisor/wake subprocess e2e files with multi-second wall-clock polling moved off the
PR-blocking path into `.github/workflows/vitest-wallclock-e2e.yml` (main push + daily
schedule). PR-required **Run pack contract tests** excludes them; post-merge stage runs
the successor file set from Issue #692 mega-file splits.

| Surface | Role |
| --- | --- |
| `scripts/vitest-wallclock-e2e-split.manifest.json` | Enumerated logical move set, post-merge execution map, red-signal contract |
| `scripts/vitest-wallclock-e2e-split.pre-move-manifest.json` | Pinned pre-move PR-required union; guard derives the union from `preMoveBaselineSha` via detached git worktree and rejects checkout manifest drift |
| `postMergeWallclock` lane in `vitest-ci-lanes.config.json` | Classification for relocated files (not PR light/heavy) |
| `scripts/run-vitest-wallclock-stage.ps1` | Serial post-merge runner |
| `wall-clock-e2e-containment` job output | Machine-readable containment while stage pending/red |

Coverage-delta proof: `scripts/lib/vitest-wallclock-e2e-split.mjs` + guard in
`scripts/check-ci-pipeline-split.ps1`. Charter linkage: Issue #487 AC#8 requires immutable
GitHub approval on Issue #694 before merge (write+ collaborator). Live GitHub resolution runs on every guard invocation including `pull_request` CI. When another write+ collaborator exists, PR-author issue comments and PR reviews are rejected; solo-maintainer repos with no other eligible reviewer accept charter issue comments from the owner. A pinned immutable comment id in `scripts/vitest-wallclock-e2e-split.manifest.json` is validated live on GitHub with the same author rules.

**Latest-main wall-clock evidence (Issue #694 AC#3):** after the workflow exists on `main`,
`check-ci-pipeline-split.ps1` requires a completed successful `vitest-wallclock-e2e` run for
the newest `main` head (via GitHub Actions API). Bootstrap passes when the workflow is not yet
on `main`, no main runs exist yet, or the head is younger than the bounded age window (48h).

Red-signal on post-merge failure: `scripts/ci-wallclock-e2e-notify.ps1` records an
episode-keyed alert (`wallclock-e2e-main:{sha}`) and opens an Issue #694 comment idempotently
(matching `dedupe:` / `episode:` keys; repeated failures for the same head do not spam);
delivery miss stays fail-closed (stage red + containment blocks promotion).

### Wall-clock rollback (ordered — disable-alone is invalid)

1. Reclassify every `postMergeWallclock` file back to `heavy` (or `light` where proven safe)
   in `scripts/vitest-ci-lanes.config.json`.
2. Prove green **Run pack contract tests** on a representative PR including the restored files.
3. Only then disable or remove `.github/workflows/vitest-wallclock-e2e.yml`.
4. **Disabling post-merge alone** without step 1–2 drops coverage and is an invalid rollback.

## Pre-change baseline (GHA, 2026-06-30)

Eight-way round-robin (#536) baseline is documented in
`docs/investigations/ci-test-speed-current-baseline.md`. Shard imbalance persisted
under round-robin because assignment ignored runtime.

## Rollback

### Supervisor test sleep-to-poll (Issue #693)

If repeat-run CI shows new timing flake after the sleep-to-poll conversion:

1. Revert positive-wait helper usage in the split supervisor/wake test files
   (`orchestrator-wake-supervisor-*.test.ts`) to the prior fixed `setTimeout` budgets.
2. Remove or disable `scripts/check-supervisor-test-wait-inventory.ps1` from local/PR
   verification until the inventory is regenerated.
3. Restore prior `scripts/vitest-runtime-history.json` weights for affected files if
   measured p75 regresses.
4. Heavy-lane assignment (#556) and shard topology are unchanged — do not alter
   `vitest-ci-lanes.config.json` classification or lane counts for this rollback.

### To fixed-count topology (pre-#695 emergency)

1. Restore hand-listed `shard: [1..7]` (or prior fixed list) in `test-vitest-heavy`.
2. Remove `plan-vitest-ci-topology` job and its `needs` edges.
3. Restore fixed `heavyShardCount` in `scripts/vitest-ci-lanes.config.json` and drop derived
   `heavyTopology` block (or ignore derivation by pinning count in workflow).
4. Revert `scripts/lib/vitest-heavy-topology.mjs` consumption in lane plan/guard.

Branch protection and the aggregate check name **Run pack contract tests** stay unchanged.
Follow up to restore derived topology once weights are trustworthy.

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
