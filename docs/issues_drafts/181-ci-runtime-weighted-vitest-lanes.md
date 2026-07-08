# Runtime-weighted Vitest lanes with bounded light-test parallelism

GitHub Issue: #556

## Prerequisite

- `docs/issues_drafts/08-test-harness.md` (GitHub #11) - establishes Vitest/Pester as the pack test harness; this issue changes scheduling and guard policy, not the test framework.
- `docs/issues_drafts/154-ci-cheap-wins.md` (GitHub #486) - shipped PR-scoped cancellation, npm cache coverage, and single CI ownership for read-delegation audit fixtures. This issue reuses those workflow guarantees.
- `docs/issues_drafts/155-ci-pipeline-split-parallel-test-stage.md` (GitHub #487) - shipped PR-required full regression via fail-closed aggregate, current-head/run binding, coverage preservation, and the worker-RPC flake guard. This issue extends that split instead of replacing it.
- `docs/issues_drafts/156-verify-script-test-runtime-refactor.md` (GitHub #488) - moved full Vitest ownership to the test lane and added slow-test budget enforcement. This issue reuses that ownership and must not move full regression back into `verify.ps1`.
- `docs/issues_drafts/172-8-way-vitest-sharding.md` (GitHub #536) - shipped the eight-way round-robin experiment and explicitly deferred runtime-weighted shard assignment when imbalance persists. This issue is that follow-up surface.
- `docs/issues_drafts/166-orchestrator-worker-recovery-sanctioned-path.md` (GitHub #522, open at authoring) - owns the worker-recovery feature branch where several heavy boundary tests were given 120s describe-level timeouts. This issue may require timeout-alignment evidence from that work, but it does not implement worker recovery.
- Prior-art reconnaissance verdict: **extends shipped CI work**. #486/#487/#488/#536 already cover cancellation, matrix sharding, fail-closed aggregation, verify deduplication, and 8-way round-robin. No open issue or local draft found for runtime-weighted sharding, heavy/light CI classification, or bounded in-process parallelism for light-only tests.

## Goal

Reduce ordinary non-markdown PR test feedback time by replacing round-robin Vitest scheduling with runtime-aware lanes: heavy integration tests remain serial and balanced across isolated GitHub Actions shards, while only proven light tests may use bounded in-process Vitest parallelism.

```behavior-kind
action-producing
```

## Design analysis

### Critical mechanics

The current CI split recovers wall-clock speed by running multiple GitHub Actions jobs, but each Vitest job still uses serial in-runner execution to avoid the known `vitest-worker` `onTaskUpdate` failure mode. The remaining risk is two-sided: round-robin file assignment can put too much runtime in one shard, while a blanket return to `fileParallelism: true` can run multiple heavy subprocess/file-system tests in the same worker pool and recreate the old flake. The scheduling contract therefore needs a test-class boundary, runtime-weighted assignment, and a guard proving heavy files never enter the bounded-parallel lane.

### Industry grounding

KB consult found `Commit stage` and `Automated testing` relevant: CI feedback should be fast, self-checking, and bounded; heavier acceptance/integration work should be isolated or run on a build grid rather than silently slowing the first feedback stage. Synto returned no relevant articles or source segments. Applied here: keep full PR-required coverage, but schedule tests according to runtime and isolation needs.

### Architecture sketch

```text
classify-pr-changes
  |
  +--> Type-check pack sources
  +--> Vitest light lane (bounded workers; light files only)
  +--> Vitest heavy shard 1..N (runtime-weighted; serial in-runner)
  +--> Pester regression
  |
  +--> Run pack contract tests (same fail-closed aggregate)
```

### Options considered

1. **Add more round-robin shards.** Low implementation cost, but #536 already used that as the reversible experiment and documented that durable balance likely needs runtime-weighted assignment.
2. **Enable Vitest in-process parallelism for every file.** Fastest local-looking option, but it directly re-enters the `onTaskUpdate` class that #487 and #536 kept out of CI.
3. **Runtime-weight heavy tests and allow bounded parallelism only for classified light tests.** More implementation and guard work, but it targets both bottlenecks: shard imbalance and wasted light-test parallelism. Chosen as the cheapest sufficient follow-up because it extends existing CI contracts instead of replacing them.
4. **Reference shipped work only and do nothing.** Rejected because #536 explicitly left a follow-up threshold for weighted sharding, and no existing issue owns the heavy/light lane contract.

### Full-class enumeration

- Test class: light pure unit/static test, heavy subprocess/git/filesystem/tmux/PowerShell integration test, classification-required unknown/new/renamed test file.
- Lane class: bounded-parallel light lane, serial heavy shard, classification-required gate, Pester lane, typecheck lane.
- Timing input class: historical runtime available, runtime missing, runtime stale, runtime report corrupt.
- Failure class: assertion failure, test timeout, worker-RPC/onTaskUpdate recurrence, shard imbalance, missing shard/lane, cancelled upstream job.
- Change class: new light test, new heavy test, edited heavy test, deleted test, renamed test.

## Binding surface

- CI has an explicit Vitest scheduling contract: light files may run with bounded in-process parallelism only when classified as light; classified heavy files run serially in isolated GitHub Actions shards; unknown/new/renamed files fail a classification-required gate.
- Heavy shard assignment is runtime-weighted using recent per-file timing evidence or a conservative fallback for classified heavy files with missing runtime data. The assignment preserves serial-vs-lane coverage equivalence: no classified test file may be missing or duplicated across light/heavy lanes, and no unclassified test file may satisfy the aggregate.
- New, renamed, or otherwise unclassified test files fail closed as classification-required in the same PR. They may be measured by an explicit diagnostic/bootstrap path if the implementation needs it, but they cannot silently enter either the bounded-parallel light lane or the accepted serial heavy lane.
- The existing aggregate required check name and fail-closed semantics from #487/#536 remain unchanged. A red, missing, skipped, cancelled, timed-out, or inconclusive light/heavy/Pester/typecheck lane blocks the aggregate.
- The worker-RPC flake guard remains load-bearing. Any representative CI evidence for the light lane must scan for `onTaskUpdate`, `vitest-worker`, `STACK_TRACE_ERROR`, and related RPC timeout signatures.
- CI timeout configuration must be consistent with the slow-test budget from #488. A test may not be killed by a lower Vitest timeout than the declared per-test budget unless that test or lane intentionally declares a narrower timeout.
- This issue does not move existing PR-required coverage to main-only, schedule-only, or advisory status.

```contract-evidence
binding-id: orchestrator-pack:ci-vitest-lanes:heavy-light-classification
binding-type: ci-test-scheduling-policy
binding: Vitest files are assigned to explicit light or heavy lanes, unknown/new/renamed files fail a classification-required gate, and only light files may use bounded in-process parallelism
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:ci-vitest-lanes:runtime-weighted-heavy-shards
binding-type: ci-shard-topology
binding: heavy Vitest files are assigned to serial shards by runtime-aware balancing while preserving coverage equivalence
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:ci-vitest-lanes:timeout-budget-alignment
binding-type: test-runtime-budget-policy
binding: CI Vitest timeout policy cannot be lower than the declared slow-test budget for files it governs unless explicitly narrowed
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)

binding-id: orchestrator-pack:ci-vitest-lanes:bounded-light-parallelism-flake-guard
binding-type: test-runtime-flake-regression
binding: bounded in-process parallelism is allowed only for light files and representative CI evidence shows no accepted worker-RPC flake recurrence
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)
```

## Files in scope

- `.github/workflows/**`
- `vitest.config.ts`
- `scripts/**` CI test runner, shard assignment, runtime budget, and guard helpers
- `docs/**`

## Files out of scope

- Worker recovery behavior from GitHub #522 beyond consuming timeout evidence if relevant.
- Moving existing PR-required tests to main-only, schedule-only, manual, or advisory lanes.
- Replacing Vitest or Pester as the test harness.
- Fetch-depth optimization for diff-sensitive workflows.
- `plugins/**` behavior changes unrelated to test fixtures.
- `vendor/**`
- `packages/core/**`

## Denylist

```denylist
vendor/**
packages/core/**
```

Scope boundary note: This denylist is scoped to `181-ci-runtime-weighted-vitest-lanes`.

## Acceptance criteria

1. CI exposes a machine-checked heavy/light Vitest classification with an explicit classification-required state for unknown, new, or renamed test files. The guard proves every serially discovered Vitest file is either assigned to exactly one accepted lane or blocks the aggregate with an actionable classification-required error; no unknown file may default into the serial heavy lane or the bounded-parallel light lane.

```producer-emission
producer: orchestrator-pack
datum: ci-vitest-lanes
expected: heavy-light-classification
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

2. Classified heavy Vitest files run in serial GitHub Actions shards with runtime-weighted assignment. A guard proves shard union equals serial discovery for the classified heavy set, no file is duplicated, unknown files are excluded from accepted heavy shards, and the assignment uses available runtime evidence or a documented conservative fallback for classified heavy files without timing history.

```producer-emission
producer: orchestrator-pack
datum: ci-vitest-lanes
expected: runtime-weighted-heavy-shards
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

3. The light lane runs only classified light files and may use bounded in-process Vitest parallelism. The bound is explicit, reversible, and low enough that repeated representative CI runs do not accept `onTaskUpdate` / `vitest-worker` / `STACK_TRACE_ERROR` / RPC timeout flakes as normal.
4. CI timeout policy is aligned with the #488 slow-test budget. A guard fails when the effective Vitest timeout for CI is lower than the declared per-test budget for governed tests unless the file or lane has an explicit narrower timeout with documented rationale.

```producer-emission
producer: orchestrator-pack
datum: ci-vitest-lanes
expected: timeout-budget-alignment
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

5. Representative CI evidence on the implementation PR records per-lane/per-shard durations, the slowest heavy shard, the light lane duration, and a log scan showing zero accepted worker-RPC/onTaskUpdate signatures.

```producer-emission
producer: orchestrator-pack
datum: ci-vitest-lanes
expected: bounded-light-parallelism-flake-guard
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

6. The aggregate **Run pack contract tests** required check remains stable and fail-closed for all mandatory lanes: typecheck, light Vitest, heavy Vitest shards, and Pester. Unexpected skip, missing upstream result, cancellation, timeout, or inconclusive lane result prevents a green aggregate.
7. No existing PR-required coverage is weakened. The PR includes before/after evidence for total discovered Vitest files, lane assignment counts, and full-regression aggregate behavior.
8. Docs record the new scheduling model, rollback to the #536 serial eight-shard topology, and the criteria for reclassifying a test from heavy to light or light to heavy.
9. A negative fixture or static guard proves a heavy-pattern test file cannot enter the bounded-parallel light lane without an explicit classification update and reviewable timing evidence, and a new/renamed test file cannot pass CI without explicit light/heavy classification.

```positive-outcome
asserts: an ordinary non-markdown PR runs full required Vitest coverage with light files in a bounded-parallel lane and heavy files in balanced serial shards, producing a green aggregate only when every lane is green, every test file is explicitly classified, and no worker-RPC flake is accepted
input: realistic
```

## Upgrade-safety check

- No AO core or vendored package edits.
- No new repository secrets.
- Branch protection remains anchored on the existing aggregate check name.
- The change is rollback-safe: disabling the light lane or weighted assignment returns CI to the #536 serial eight-shard topology without changing required-check identity.
- Planner freedom is preserved: the implementation may choose the manifest format, timing-history source, and guard layout as long as the observable contracts above hold.

## Verification

- `npm ci --include=dev`
- `pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1`
- `pwsh -NoProfile -File scripts/verify.ps1`
- `pwsh -NoProfile -File scripts/check-reusable.ps1`
- CI run on a representative non-markdown PR showing the light lane, weighted heavy shards, Pester, typecheck, and green **Run pack contract tests** for the current `GITHUB_SHA` / `GITHUB_RUN_ID`.
- CI evidence appendix with lane durations, shard assignment summary, serial-vs-lane coverage equivalence, timeout-budget alignment proof, and worker-RPC signature scan.

## Decisions

### Prior art

The prior-art survey found shipped coverage for the surrounding CI mechanics: #486 owns PR cancellation/cache/dedup, #487 owns fail-closed sharded full regression, #488 owns verify/runtime-budget cleanup, and #536 owns the eight-way round-robin experiment. #536 explicitly states runtime-weighted assignment is the expected follow-up if imbalance persists; it also keeps `fileParallelism: false` / `maxWorkers: 1` in scope for all shards. No existing open issue or unsynced draft owns runtime-weighted sharding, heavy/light classification, or bounded light-only Vitest parallelism.

### Decomposition verdict

This is one PR-sized scheduling contract, not a mega-draft: it changes how the existing Vitest regression lane is scheduled while preserving #487/#536 aggregate semantics. Broader slow-lane policy, schedule-only migration, worker recovery from #522, and fetch-depth changes are out of scope.

### Decision trail

- Chose runtime-weighted heavy shards over more round-robin shards because #536 already used round-robin as the cheap experiment and documented the durable weighted follow-up.
- Chose bounded light-only in-process parallelism over blanket `fileParallelism: true` because the old `onTaskUpdate` failure class was tied to concurrent heavy integration files inside one Vitest worker pool.
- Made unknown/new/renamed files fail a classification-required gate instead of defaulting to serial heavy. False-light classification remains the dangerous safety failure, but silent heavy-lane dumping is the speed failure; the PR that adds or renames a test must classify it immediately.
