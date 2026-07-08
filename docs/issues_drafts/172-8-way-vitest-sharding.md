# 8-way Vitest sharding for required PR regression

GitHub Issue: #536

## Prerequisite

- `docs/issues_drafts/154-ci-cheap-wins.md` (GitHub #486) — PR-scoped workflow cancellation and npm cache coverage; shard fan-out already inherits this contract.
- `docs/issues_drafts/155-ci-pipeline-split-parallel-test-stage.md` (GitHub #487, **merged**) — shipped 4-way Vitest matrix sharding, fail-closed aggregate **Run pack contract tests**, serial in-runner Vitest (`fileParallelism: false`, `maxWorkers: 1`), worker-RPC flake guard, and coverage-equivalence guard.
- `docs/issues_drafts/156-verify-script-test-runtime-refactor.md` (GitHub #488, **merged**) — `verify.ps1` no longer owns full Vitest execution; per-shard slow-test budget enforcement lives in the full test lane via `run-vitest-shard.ps1`.
- `docs/investigations/ci-test-speed-current-baseline.md` — **10-run GHA baseline** (2026-06-30): Vitest shard 3/4 is slowest in **10/10** runs; critical path p50 **~9m53s**; imbalance is runtime skew (round-robin file index), not missing #486–#488 wins.
- Prior-art reconnaissance verdict: **extends #487** — no open issue or unsynced draft covers increasing Vitest shard count beyond four. Runtime-weighted shard assignment remains a planned follow-up, not in scope here.

## Goal

Reduce PR-required regression critical path via a **cheap reversible experiment**: double GitHub Actions Vitest matrix isolation from four to eight shards while preserving the shipped #487 safety contracts (fail-closed aggregate, serial Vitest inside each runner, worker-RPC flake detection). Eight-way round-robin likely cuts the tail but is **not** the durable end state — weighted sharding is the expected follow-up if imbalance persists.

```behavior-kind
action-producing
```

## Design analysis

### Critical mechanics

Issue #487 replaced a monolithic Vitest job with four matrix shards, each running with `fileParallelism: false` and `maxWorkers: 1` to avoid the known `vitest-worker` `onTaskUpdate` RPC timeout class. Matrix sharding recovers wall-clock parallelism at the runner level only.

**Operational baseline** (`docs/investigations/ci-test-speed-current-baseline.md`, 10 successful `scope-guard` runs):

- **Vitest shard 3/4** is the slowest shard in **10/10** runs (p50 **~9m48s**; other shards p50 **~1m54s–2m37s**).
- Workflow critical path p50 **~9m53s** — dominated by shard 3/4, not typecheck, Pester, or `verify-pack`.
- Root cause: Vitest default round-robin assigns **sorted files by index**, not by duration; heavy integration tests cluster in shard 3's bucket.

Eight-way split redistributes files across `(i mod 8)` buckets. Baseline estimates **~40–50% critical-path reduction** (rough p50 **~5–7 min**), not ~2 min — durable balance likely needs weighted sharding later.

Canonical shard count must stay single-sourced (`scripts/ci-pipeline-split.config.json`) with workflow matrix, guards, and live coverage checks reading that value.

### Industry grounding

KB consult (`Commit stage`, `sources/ch07 the commit stage 13505109.md`): commit stage should give fast actionable feedback — ideally ~90 seconds, hard ceiling ~10 minutes. This task adds more isolated runners rather than re-enabling flaky in-process Vitest parallelism.

### Architecture sketch

```text
classify-pr-changes (markdown-only skip)
  |
  +--> Type-check pack sources
  +--> Vitest shard 1..8 (matrix; maxWorkers:1; fileParallelism:false per shard)
  +--> Pester regression
  |
  +--> Run pack contract tests (aggregate; fail-closed; same required check name)
```

Triggers: `pull_request` and `push` to `main` only (`.github/workflows/scope-guard.yml`).

### Options considered

1. **Increase matrix shard count 4 → 8, keep serial in-runner Vitest.** Cheap reversible experiment; reuses #487 aggregate, RPC guard, and coverage-equivalence machinery; costs more concurrent runners; likely partial tail reduction.
2. **Runtime-weighted shard assignment.** Targets equal wall time per shard; needed for durable balance near commit-stage ceiling; defer unless option 1 evidence triggers follow-up threshold (below).
3. **Restore `fileParallelism: true` / `maxWorkers > 1`.** Re-enters the `onTaskUpdate` failure mode #487 rejected.

Chosen direction: **option 1** as experiment. **Option 2** is the explicit follow-up when the threshold in AC#8 fires.

### Full-class enumeration

- Event class: pull request (ordinary non-markdown), push to `main`.
- Failure class: assertion failure, shard infra failure, missing shard result, timeout, cancellation, `onTaskUpdate` RPC recurrence.
- Aggregation class: all eight Vitest shards + typecheck + Pester required; any red/missing/skipped/cancelled lane blocks green aggregate.
- Rollback class: revert config + workflow matrix to four shards; guards and docs document rollback without branch-protection rename.

## Binding surface

- Canonical Vitest shard count becomes **8** everywhere the #487 split is configured: `scripts/ci-pipeline-split.config.json`, `.github/workflows/scope-guard.yml` `test-vitest` matrix, and any guard/test/doc that hardcodes four shards today (including `scripts/check-ci-pipeline-split.test.ts` expectations).
- Required aggregate check keeps display name **Run pack contract tests** and remains fail-closed on failure, unexpected skip, cancellation, missing upstream result, or missing `GITHUB_SHA` / `GITHUB_RUN_ID` binding for the current run.
- Each shard continues serial in-runner execution: `fileParallelism: false`, `maxWorkers: 1` in `vitest.config.ts`; `scripts/run-vitest-shard.ps1` must retain `onTaskUpdate` / RPC timeout log detection and non-zero exit on match.
- Shard union must remain coverage-equivalent to serial Vitest discovery (no missing files, no cross-shard duplicates) for shard total **8**.
- PR-scoped cancellation from #486 is unchanged; superseded runs must not satisfy a newer head.
- Implementation PR must attach GitHub Actions timing and parallelism evidence (see Acceptance criteria) and open weighted-sharding follow-up when AC#8 threshold fires.

```contract-evidence
binding-id: orchestrator-pack:ci-pipeline-split:vitest-eight-shard-matrix
binding-type: ci-shard-topology
binding: PR-required Vitest regression runs as eight isolated matrix shards with config-driven indices 1..8
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:ci-pipeline-split:vitest-shard-aggregate
binding-type: ci-shard-aggregation-policy
binding: the required test aggregate fails closed when any mandatory shard is red, missing, timed out, cancelled, or unexpectedly skipped
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)

binding-id: orchestrator-pack:ci-pipeline-split:worker-rpc-timeout-detector
binding-type: test-runtime-flake-regression
binding: run-vitest-shard.ps1 retains onTaskUpdate/RPC timeout log detection with non-zero exit on match
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)
```

## Files in scope

- `scripts/ci-pipeline-split.config.json`
- `scripts/check-ci-pipeline-split.ps1` (only if guard literals or issue references need extension for eight shards)
- `scripts/check-ci-pipeline-split.test.ts`
- `.github/workflows/scope-guard.yml` (`test-vitest` matrix and shard display names)
- `docs/ci-pipeline-split.md`

## Files out of scope

- `vitest.config.ts` parallelism settings (must remain `fileParallelism: false`, `maxWorkers: 1` — no change intended)
- `scripts/run-vitest-shard.ps1` behavior beyond shard-total parameter wiring if already config-driven
- Runtime-weighted shard assignment logic
- Fast/slow test classification or moving PR-required tests to schedule/main-only
- `scripts/verify.ps1` / `verify-pack` job structure (#488 already landed)
- `vendor/**`, `packages/core/**`, `plugins/**`

## Denylist

```denylist
vendor/**
packages/core/**
plugins/**
```

Scope boundary note: This denylist is scoped to `172-8-way-vitest-sharding`.

## Acceptance criteria

1. CI runs Vitest shards **1/8 through 8/8** on ordinary non-markdown PRs; workflow matrix indices match `vitestShardCount: 8` in `scripts/ci-pipeline-split.config.json`.

```producer-emission
producer: orchestrator-pack
datum: ci-pipeline-split
expected: vitest-eight-shard-matrix
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

2. All eight Vitest shards participate in the aggregate job (`test-aggregate` needs `test-vitest` matrix success); union coverage check passes for total **8** (no missing serial files, no duplicates).
3. Aggregate **Run pack contract tests** remains fail-closed: red, cancelled, unexpectedly skipped, missing, or inconclusive typecheck/Vitest/Pester lane prevents green aggregate; stable required check name unchanged.

```producer-emission
producer: orchestrator-pack
datum: ci-pipeline-split
expected: vitest-shard-aggregate
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

4. **Static:** `run-vitest-shard.ps1` retains `onTaskUpdate` / vitest-worker RPC timeout log detection with non-zero exit on match (machine-checked by the pipeline-split guard).

```producer-emission
producer: orchestrator-pack
datum: ci-pipeline-split
expected: worker-rpc-timeout-detector
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

5. **CI evidence:** a representative `scope-guard` run on the **implementation PR branch** (the PR's own CI run, reviewable before merge) shows **zero accepted** `onTaskUpdate` / vitest-worker RPC timeout occurrences across all eight shard job logs (PR links run URL + states log review outcome; not proved by local guard alone). Optional post-merge confirmation on `main` is useful but **not** a merge gate.
6. **Parallel fan-out evidence:** the same representative PR run records `started_at` for all eight `Vitest shard */8` jobs from the GitHub Actions jobs API (or workflow run UI). Evidence must show whether shards actually started concurrently or were serialized by runner/org concurrency limits — if serialized, note reduced expected wall-time gain.
7. `docs/ci-pipeline-split.md` documents that **4-way** split shipped under #487, states **8-way** as the current experiment, describes rollback to four shards, cites `docs/investigations/ci-test-speed-current-baseline.md` as pre-change baseline, and does **not** state unverified timing improvements as fact.
8. The implementation PR links a representative **PR-branch** `scope-guard` run (merge-reviewable) with: per-shard durations, slowest shard identity, scope-guard critical-path wall time (queue excluded), and confirmation typecheck/Pester/`verify-pack` were not the critical path. **Follow-up threshold** (open weighted-sharding issue after merge if triggered, do not solve here): slowest Vitest shard duration is **≥2× the median** of the other seven shards **or** workflow critical path remains **≥8 minutes** — per `docs/investigations/ci-test-speed-current-baseline.md` recommendation.

```positive-outcome
asserts: an ordinary non-markdown PR completes required Vitest regression via eight matrix shards with fail-closed aggregate and no accepted worker-RPC flake in CI logs
input: realistic
```

## Non-goals

- Do not enable `fileParallelism: true`.
- Do not change `maxWorkers: 1`.
- Do not implement runtime-weighted sharding in this issue.
- Do not change fast/slow test policy or move PR-required tests to schedule/main-only.
- Do not rename the required aggregate check.
- Do not modify `vendor/agent-orchestrator`.
- Do not add `schedule` / `workflow_dispatch` triggers to `scope-guard`.

## Upgrade-safety check

- Shard count remains config-driven so a future adjustment (8 → N) reuses the same guard pattern without branch-protection churn.
- Rollback is reverting config + workflow matrix to four shards; aggregate name and fail-closed semantics stay constant.
- #486 cancellation and #488 per-shard budget enforcement remain compatible; this issue must not weaken them.

## Verification

```powershell
npm ci --include=dev
pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
```

- CI run on a representative non-markdown PR showing jobs **Vitest shard 1/8 … 8/8**, parallel typecheck/Pester lanes, and green **Run pack contract tests** for the current `GITHUB_SHA` / `GITHUB_RUN_ID`.
- `check-ci-pipeline-split.ps1` passes with live eight-shard coverage equivalence when `node_modules` is present.
- Post-merge PR appendix: per-shard durations, slowest shard, eight job `started_at` timestamps (parallelism check), scope-guard critical-path seconds (queue excluded), RPC log scan result (AC#5) — all from the **implementation PR's own CI run**, reviewable before merge.
- Negative/static guard proof that matrix shard list `[1..8]` mismatches config count → guard failure.

## Review decision log

- Architect session 2026-06-30: scoped as #487 extension; 10-run baseline (`ci-test-speed-current-baseline.md`) replaces single-run anecdote.
- Codex architect review: **attempt 1** (`codex review` inline) **interrupted by timeout** — not valid evidence. **Attempt 2** (`review-architect-artifact.ps1`): **NO_FINDINGS** on initial draft. Post-review operator findings (2026-06-30): fixed broken #536 body sync, split AC#4 static vs CI evidence, cited 10-run baseline, removed schedule/manual scope, added parallel fan-out AC and weighted-sharding threshold. **Attempt 3** (`review-architect-artifact.ps1`, revised draft): **P2** — AC#5/6/8 required post-merge runs (not merge-gatable); revised to PR-branch CI evidence before merge, post-merge optional. **Attempt 4** (`review-architect-artifact.ps1`, after P2 fix): **NO_FINDINGS**.
