# [T3] Weight-driven self-balancing heavy-shard topology + oversized-file floor guard

GitHub Issue: #695

## Prerequisite

- `docs/issues_drafts/241-ci-vitest-runtime-history-feedback-loop.md` (GitHub #691 —
  **must merge first**) — ships the measured per-file runtime weights this issue
  consumes. Without it, derivation and the oversized-file guard run on fiction.
- `docs/issues_drafts/155-ci-pipeline-split-parallel-test-stage.md` (GitHub #487,
  closed) — shipped PR-required Vitest matrix sharding and the fail-closed aggregate
  **Run pack contract tests** contract.
- Issue #556 (merged; see `docs/ci-pipeline-split.md` and
  `scripts/vitest-ci-lanes.config.json`) — shipped light/heavy lane split, greedy
  LPT heavy assignment, serial-in-runner heavy isolation, and coverage-equivalence
  guards. **Reused, not rebuilt:** classification, LPT packing, light lane, aggregate
  semantics, and worker-RPC flake posture stay unchanged.
- Reactive one-off tuning drafts (237/238/239 class) are the toil this issue
  replaces — not prerequisites.

Prior-art verdict (**recon per architect brief, 2026-07-08**): no queued draft
covers weight-driven **shard count** derivation or a merge-blocking **single-file
floor** guard. #556 fixed assignment **given** a hand-edited `heavyShardCount`; this
issue makes count and floor policing outputs of one shared `targetShardSeconds`
budget. One coherent contract — do not split.

## Goal

Stop hand-bumping the heavy Vitest shard matrix and filing per-file reactive tuning
tasks whenever the suite shifts. The heavy lane must **derive shard count from
measured total weight** against a documented per-shard time budget, keep the
workflow matrix and coverage-equivalence guard aligned with that derived count, and
**fail merge** when any single Vitest test file exceeds the budget (naming the file
and the required human action: split or speed up). Distribution scales automatically;
the irreducible split/speed-up action is auto-triggered on the introducing PR, not
discovered later.

```behavior-kind
action-producing
```

```complexity-tier
tier: T3
advisory-prior: T3
```

## Design analysis

### Critical mechanics

Issue #556 plans heavy shards at CI time: classify files light/heavy, assign heavy
files to a **fixed** `heavyShardCount` (currently **7**) via greedy LPT over
committed weights, run each heavy shard serial in-runner, and prove lane union equals
serial discovery. Weights today come from `scripts/vitest-runtime-history.json` with
`heavyDefaultRuntimeMs` fallback — but #691's harvest loop is the prerequisite for
**real** measured weights. Three rigidities remain: (1) weights were frozen until
#691; (2) shard count is a hand-edited constant in config and a hand-listed matrix in
`.github/workflows/scope-guard.yml`; (3) a single oversized file pins a shard floor
and is found ad hoc. Both fixes share one budget: `targetShardSeconds` (canonical **seconds**;
runtime-history weights are normalized from milliseconds at read time) drives
`shardCount = clamp(ceil(heavyLaneTotalWeightSeconds / targetShardSeconds), min, max)` and
defines oversized as `resolvedFileWeightSeconds > targetShardSeconds`. **Shard-count
numerator** sums resolved weights for files **routed to the heavy lane** after
classification; the oversized floor guard still evaluates **every discovered** Vitest file.

### Industry grounding

Commit-stage CI practice (see `docs/ci-pipeline-split.md` and Issue #487) treats
matrix sharding as the cheapest sufficient way to recover wall-clock on a
self-hosted runner without reintroducing in-runner worker-RPC contention. Dynamic
matrix generation from a plan job output is the standard GitHub Actions pattern for
count that tracks workload. Work-stealing / shared-queue coordinators (Buildkite/Knapsack-Pro
style) are industry solutions at larger scale but introduce a standing coordinator
service — judged over-engineered here (~150 Vitest files, one self-hosted machine).

### Architecture sketch

```text
plan job (existing vitest-ci-lane plan)
  |
  +--> read measured weights (#691 harvest)
  +--> derive heavyShardCount = clamp(ceil(heavyLaneTotalSeconds / targetShardSeconds), min, max)
  +--> fail-closed fallback to current fixed count when weights present-but-unusable
  |    (whole-artifact absence post-#691 = loud error, not fallback)
  +--> emit matrix JSON for heavy shards 1..N
  +--> LPT assign heavy files (unchanged #556)
  |
  +--> merge guard: any discovered Vitest file > targetShardSeconds => fail PR (name file, action)
  |
heavy matrix jobs 1..N (serial in-runner, unchanged isolation)
light lane (unchanged bounded parallelism)
aggregate Run pack contract tests (unchanged fail-closed semantics)
```

### Options considered

| Option | Cost | Risk | Sufficiency | Decision |
|---|---:|---:|---:|---|
| Weight-driven dynamic shard count + oversized-file merge guard | Low–medium | Low with fail-closed fallback + cap | Reuses #556 LPT/isolation/coverage; auto-scales; floor self-announcing | **Chosen** |
| Work-stealing / queue coordinator | High | New always-on component + failure modes | Full runtime rebalance but unjustified at scale; still bounded by slowest unit | **Rejected** |
| Status quo — hand-bump count + per-file tasks | Zero | Recurring toil (237/238/239 class) | Does not meet goal | **Rejected** |

### Full-class enumeration (acceptance fixtures)

| Weight state | Topology / guard outcome |
|---|---|
| Present, total moderate | Derived count in `[min, max]`; shards ≈ target budget |
| Present, total large | Count rises to cap; **non-blocking** under-provisioned summary when cap hit (documented accepted degradation — not merge-blocking) |
| Present, one file > target | **Merge guard fails** naming file; count derivation still proceeds for remainder |
| New/changed file, no/stale per-file weight | Guard uses conservative resolution (see Binding surface); introducing PR cannot pass on missing history alone |
| Present-but-unusable global (empty / corrupt / degenerate) | Topology falls back to fixed count; **oversized guard still fail-closed** on per-file unknown/stale weights |
| Whole-artifact absence post-#691 (deleted/unavailable) | **Loud fail-closed error** (broken harvest), NOT a fallback; pre-#691 absence is prerequisite-blocked/out of scope |
| Matrix vs derived count drift | Coverage/topology guard fails closed (reuse #556 guard) |

## Binding surface

- **One budget, two outputs.** `targetShardSeconds` (human-diffable documented
  config, **seconds** — the sole time unit in policy math), plus documented
  `minShardCount` and `maxShardCount`, are the sole scaling policy inputs.
  Runtime-history weights are read in milliseconds and **normalized to seconds**
  before any derivation or guard comparison. Derived shard count and oversized-file
  threshold both reference this budget — no duplicate constants that can drift.
- **Canonical topology artifact.** The plan job emits one machine-readable topology
  artifact (JSON — planner chooses path/shape) carrying at minimum: derived
  `heavyShardCount`, heavy shard index list/matrix payload, and fallback
  classification. The plan job also exposes the heavy matrix payload as a **named
  GitHub Actions job output** for workflow `needs` expansion. The persisted
  artifact and job output must agree (hash or count parity — planner chooses check).
  The heavy workflow matrix **and** `check-ci-pipeline-split.ps1` consume that
  agreed source — not independently hand-maintained lists. The guard validates matrix
  count == derived count from that artifact (fail-closed).
- **Derived topology.** The existing plan job emits `heavyShardCount` and the heavy
  workflow matrix from **heavy-lane total** weight instead of reading a fixed constant.
  Greedy LPT assignment, light/heavy classification, serial-in-runner heavy isolation,
  and the coverage-equivalence guard remain unchanged in semantics.
- **Matrix consistency.** The heavy Vitest workflow matrix matches the derived count
  with no manual shard list edits. `scripts/check-ci-pipeline-split.ps1` enforces
  matrix count == **derived** count from the canonical topology artifact
  (fail-closed), composing with existing coverage-equivalence checks — not
  replacing them.
- **Oversized-file merge guard.** A dedicated check fails the PR when any
  **discovered Vitest test file** (after weight resolution — not only pre-classified
  heavy) exceeds `targetShardSeconds`. Classification may still route lanes, but the
  floor guard runs on resolved per-file weight for every discovered file so a slow
  file cannot hide in the light lane. The failure names each offending file and
  states the action (split or speed up). **Weight resolution for guard purposes:**
  use measured history when present; for files with no history, **stale history**
  (weight not associated with the file's current content or PR baseline — planner
  chooses association key; fixtures must cover changed-file-with-present-history),
  or corrupt entries — fail closed on the introducing PR unless the plan job supplies
  a **deterministic pre-topology** same-run measured weight for that file (single
  ordered step before topology emission, with documented max files and timeout;
  exceed bound => fail closed with clear message). The guard **flags only** — no auto-split or auto-speed-up. It does not double as the
  coverage guard. Oversized-file failures are enforced on the **existing PR-required**
  path via `check-ci-pipeline-split.ps1` (not an optional side job).
- **Fail-closed weight input.** A **present-but-unusable global** weight artifact — empty,
  corrupt, or **post-baseline degenerate** — falls back to the **current fixed heavy shard
  count** (today **7**) for **topology derivation only**, never silently collapsing to one
  shard or exploding without cap. A **whole-artifact absence at runtime** is treated
  differently: post-#691 the artifact must exist, so its absence signals a broken harvest
  pipeline and **fails closed as a loud error** (not a silent fallback to 7) — while
  **pre-#691 absence is out of scope** (blocked by the prerequisite merge). **Topology
  fallback does not relax the oversized-file guard:** per-file unknown/stale weights still
  fail closed per guard rules regardless of global fallback classification. When the
  post-#691 artifact is present but unusable, topology fallback is permitted; when present
  and valid, derivation and guard must consume it. Log or summary output
  records fallback classification.
- **Fail-closed policy input.** Invalid `targetShardSeconds` (≤ 0), `minShardCount`
  (< 1), `maxShardCount` (< `minShardCount`), or non-numeric policy values fail
  topology emission before matrix generation (fixtures required).
- **Path normalization.** Topology and weight artifacts use **repo-relative
  forward-slash** paths so workflow and PowerShell guards agree on file identity.
- **Bounded scale.** Derived count is clamped to `[minShardCount, maxShardCount]` so
  pathological weights cannot request hundreds of runners (GitHub Actions concurrency
  and #142/#585 API-governor concerns). When total weight implies a count above
  `maxShardCount`, derivation clamps and emits an explicit **under-provisioned**
  summary — this is a documented, **non-blocking** degradation (merge may proceed);
  operators address via raising caps or splitting the suite, not reactive per-file
  tasks.
- **No new repo secrets.** Budget and caps live in tracked, diffable config/docs.
- **Explicit non-goals:** no work-stealing coordinator; no intra-file parallelism
  (#487/#556 `onTaskUpdate` RPC flake class stays out); no change to light-lane
  worker bounds or aggregate required-check name.
- **Rollback.** Document **emergency-only** reverting to fixed `heavyShardCount` and
  hand-listed matrix (restore pre-this-issue config/workflow) without changing branch
  protection or aggregate check identity; note follow-up to restore derived topology.

```contract-evidence
binding-id: orchestrator-pack:ci-vitest-heavy-topology:derived-shard-count
binding-type: ci-shard-count-derivation-policy
binding: heavy Vitest shard count is derived from measured total weight against targetShardSeconds with documented min/max clamping instead of a hand-edited fixed constant
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:ci-vitest-heavy-topology:matrix-derived-count-parity
binding-type: github-actions-matrix-topology-policy
binding: the heavy Vitest workflow matrix shard count matches the plan-derived heavyShardCount from one canonical topology artifact with no manual drift
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:ci-vitest-heavy-topology:oversized-file-floor-guard
binding-type: ci-merge-guard-policy
binding: a PR fails merge when any discovered Vitest test file exceeds targetShardSeconds (after ms normalization and conservative unknown/stale resolution) naming the file and split-or-speed-up action
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)

binding-id: orchestrator-pack:ci-vitest-heavy-topology:weight-input-fail-closed-fallback
binding-type: ci-shard-count-derivation-policy
binding: a present-but-unusable global weight artifact (empty/corrupt/degenerate) falls back to the current fixed heavy shard count for topology derivation without silent one-shard collapse or unbounded shard explosion, while whole-artifact absence post-#691 fails closed as a loud error (not fallback); oversized guard remains fail-closed on per-file unknown/stale weights
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)
```

## Files in scope

- `.github/workflows/**` — dynamic heavy matrix from plan output
- `scripts/**` — plan job, lane config, merge guard, and guard regressions
- `docs/**` — budget/cap documentation and rollback note (including
  `docs/ci-pipeline-split.md` cross-reference if the planner updates it)
- `tests/**` — fixtures for derivation, guard, and scenario matrix

## Files out of scope

- `plugins/**` — fully out of scope; all fixtures live under `scripts/**` / `tests/**`
  (allowed roots), no plugin carve-out
- `vendor/**`, `packages/core/**`
- Vitest in-runner parallelism changes (#487 RPC flake class)
- Work-stealing / external queue coordinator services
- #691 weight harvest loop itself (prerequisite only)

```denylist
vendor/**
packages/core/**
```

Scope boundary note: This denylist is scoped to `240-ci-vitest-self-balancing-shard-topology`.

```allowed-roots
.github/**
scripts/**
docs/**
tests/**
```

## Acceptance criteria

1. **Derived shard count.** Given post-#691 measured weights (normalized to
   **seconds** from runtime-history milliseconds), the plan job emits
   `heavyShardCount = clamp(ceil(heavyLaneTotalWeightSeconds / targetShardSeconds),
   minShardCount, maxShardCount)` and uses it for LPT assignment. The committed
   config/documents record `targetShardSeconds` (seconds), min, max, fallback fixed
   count, and ms→seconds normalization rule.

```producer-emission
producer: orchestrator-pack
datum: ci-vitest-heavy-topology
expected: derived-shard-count
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

2. **Matrix parity.** The heavy Vitest GitHub Actions matrix is generated from the
   plan-derived count via the **canonical topology artifact** and matching **plan job
   output** (same JSON consumed by the workflow `needs` expansion and
   `check-ci-pipeline-split.ps1`). Manual hand-listed shard indices that can drift
   from derivation are removed. `check-ci-pipeline-split.ps1` fails when matrix count
   ≠ derived count from that artifact/output pair.

```producer-emission
producer: orchestrator-pack
datum: ci-vitest-heavy-topology
expected: matrix-derived-count-parity
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

3. **Oversized-file merge guard.** When any **discovered** Vitest test file's
   resolved weight (seconds, after ms normalization) exceeds `targetShardSeconds`,
   the guard fails the PR, naming each offending file and stating split-or-speed-up
   action. Unknown/stale/missing per-file weights fail closed on the introducing PR
   unless deterministic pre-topology same-run measurement supplies a valid weight.
   Oversized-file failures are enforced by `check-ci-pipeline-split.ps1` on the
   **existing PR-required** CI path (same aggregate family as matrix parity — not an
   optional side job). The guard does not replace coverage-equivalence checks.

```producer-emission
producer: orchestrator-pack
datum: ci-vitest-heavy-topology
expected: oversized-file-floor-guard
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

4. **Weight-input fail-closed fallback.** Fixtures prove **present-but-unusable** weight
   input — empty, corrupt, or post-baseline degenerate — yields the documented fixed fallback
   count (today **7**), with no silent one-shard topology and no count above `maxShardCount`.
   A **separate** fixture proves **whole-artifact absence at runtime post-#691**
   (deleted/unavailable history artifact) **fails closed as a loud error** — NOT a silent
   fallback to the fixed count — so a broken harvest pipeline is surfaced, not masked.
   (Pre-#691 absence remains out of scope, blocked by the prerequisite merge.) Separate
   fixtures prove invalid policy config (bad target/min/max) fails before topology emission.

```producer-emission
producer: orchestrator-pack
datum: ci-vitest-heavy-topology
expected: weight-input-fail-closed-fallback
proof-command: npx vitest run scripts/check-ci-pipeline-split.test.ts -t "heavy topology weight-input fail-closed"
```

5. **Prerequisite consumption.** When the post-#691 weight artifact is present and
   schema-valid, derivation and guard consume it (no silent fixed-count shortcut).
   Implementation must reference the #691 runtime-history schema/source. Fallback
   fixtures cover **present-but-unusable** input (empty / corrupt / degenerate), matching
   AC#4; whole-artifact absence is blocked by the #691 prerequisite and is not a runtime
   fallback path.

6. **Scenario matrix.** Acceptance fixtures cover the full-class table in Design
   analysis: moderate total, cap-hit total (non-blocking summary), single oversized
   file, new/changed file with no/stale weight, bad weight input, invalid policy
   config, heavy-lane-only shard numerator vs all-file floor guard, ms→seconds
   normalization, slash-normalized paths, and matrix/count drift. Each cell asserts
   the documented pass/fail/fallback outcome.

7. **#556 semantics preserved.** Light/heavy classification, LPT assignment,
   serial-in-runner heavy execution, lane union coverage-equivalence, and aggregate
   fail-closed **Run pack contract tests** behavior remain green except where this
   issue intentionally changes count derivation and floor policing.

8. **Rollback documented.** `docs/ci-pipeline-split.md` (or equivalent runbook
   section the planner chooses) records reverting to fixed shard count and hand-listed
   matrix without changing required-check name or branch-protection identity.

```positive-outcome
asserts: on post-#691 measured weights the heavy Vitest shard count and workflow matrix derive from heavy-lane total weight (seconds) against targetShardSeconds via one canonical topology artifact without hand-editing a fixed constant; a PR that introduces or changes a Vitest file above the budget fails merge naming the file and split-or-speed-up action — including when per-file history is missing or stale
input: realistic
```

## Upgrade-safety check

- Required CI semantics stay fail-closed: aggregate **Run pack contract tests** unchanged.
- Fallback to fixed count preserves a known-good topology when weights are bad.
- Planner freedom for plan-job wiring, matrix emission shape, and guard script layout;
  observable contracts above are fixed.
- No AO core, vendor, or packages/core edits.

## Operator adoption / rollout order

This issue is the observability + auto-distribution keystone of the CI heavy-lane speedup
series. Recommended rollout — **measure first, then act on data, not speculation:**

1. **Land #691 (harvest) first**, then let it run a **few `main`-branch cycles** so the
   committed runtime-history holds real measured weights (this issue's derivation and guard are
   meaningless on the seeded `ci-baseline-estimates`).
2. **Land this issue (#240) next.** From that point CI **auto-scales** the heavy-shard count
   from measured total weight (operators no longer hand-edit `heavyShardCount`/the matrix), and
   the **oversized-file guard names any file over the target shard budget** on the PR that
   introduces it.
3. **Monitor** the per-shard/per-file measured timings and the guard's signals over real PRs.
   If CI is now fast enough, the remaining reactive drafts may not be needed at all.
4. **Act only on what the data flags — the reactive drafts become guard-triggered, not routine:**
   - a *specific* file the guard flags as over-budget → speed it up (sleep→poll, the
     `TASK-ci-vitest-supervisor-fixed-sleep-to-poll` / draft 238 class — bigger wall-clock win,
     flake risk) or split it (`TASK-ci-vitest-heavy-megafile-split` / draft 237 class — safe
     redistribution, no flake risk);
   - the *whole* PR path still over the commit-stage ceiling after the above → relocate the
     wall-clock e2e cluster off the PR-blocking lane (`TASK-ci-vitest-wallclock-e2e-separate-stage`
     / draft 239 class, chartered by #487 AC#8) as the last resort, since it trades coverage
     timeliness.

This ordering makes distribution self-balancing (auto weights + auto scale) and the single-file
floor self-announcing, so routine shard tuning no longer needs a hand-filed task; only the
irreducible file-level speedup/split/relocate remains, and it is triggered automatically by the
guard rather than discovered ad-hoc.

## Verification

- `pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1` — extended for derived
  count parity and oversized-file guard (AC#1–#3).
- Focused fixtures for derivation fallback, cap behavior, oversized guard, and
  scenario matrix (AC#4–#5).
- Representative CI run or workflow summary showing derived count, matrix size, and
  fallback classification when exercised.
- Rollback steps exercised or walkthrough-linked in docs (AC#8).
- Existing checks remain green:

```powershell
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
```

## Decisions

### Knowledge base

KB consult: commit-stage ceiling and fail-for-slow-tests guard from Issue #487
grounding remain applicable — auto-scaling shard count is the durable alternative to
repeated manual tuning tasks. No new external coordinator justified at current suite
scale (~150 Vitest files, one self-hosted runner).

### Shared budget rationale (one draft)

Shard count (`total / target`) and oversized (`file > target`) are the same contract.
Splitting into separate issues would duplicate `targetShardSeconds` and invite drift
between topology and floor guard.

### Work-stealing rejection

Runtime shared-queue coordinators eliminate weight files but require a standing
service, add failure modes, and still cannot beat the single-slowest-unit floor.
Rejected as over-engineered; recorded here per architect brief.
