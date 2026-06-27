# CI pipeline split and parallel test stage

GitHub Issue: #487

## Prerequisite

- `docs/issues_drafts/03-scope-guard-ci.md` (GitHub #6) - existing CI scope guard remains mandatory.
- `docs/issues_drafts/08-test-harness.md` (GitHub #11) - established Vitest/Pester test harness; this issue changes CI orchestration, not the test framework contract.
- `docs/issues_drafts/54-ci-path-filter-markdown-only.md` (GitHub #155) - markdown-only heavy-job skip remains in force. This is an existing GitHub issue identity; this draft's authoritative GitHub issue identity is the `GitHub Issue:` line above after sync, not the local draft filename number.
- `docs/issues_drafts/154-ci-cheap-wins.md` (GitHub #486) - hard prerequisite; cheap workflow cleanup should land first so the larger pipeline change can measure only the remaining test-stage bottleneck.
- Prior art reconnaissance: no existing draft or queued issue covers Vitest sharding, CI-mode re-parallelization, or PR fast/full gate policy. The Ubuntu runner migration (#119) and markdown-only skip (#155) are related but do not address test runtime.

## Goal

Bring the ordinary non-markdown PR test feedback path under the commit-stage ceiling without weakening the required regression signal for pack changes.

```behavior-kind
action-producing
```

## Design analysis

### Critical mechanics

The current CI-mode Vitest configuration serializes files with one worker to avoid `vitest-worker` `onTaskUpdate` RPC timeouts on GitHub Actions. Fresh local measurement on 2026-06-27 confirmed the trade-off: ordinary parallel `npm test` finished in 217 seconds wall time with 98 files / 2052 tests, cumulative Vitest test time 1136.50 seconds, 5 failed files / 8 failed tests, and 3 `onTaskUpdate` errors; `CI=true npm test` finished green in 683 seconds with 98 files / 2052 tests and cumulative Vitest test time 665.24 seconds. The existing CI workaround is therefore justified as a flake defense, but it discards material wall-clock compression on a suite dominated by subprocess and disk-I/O tests.

### Industry grounding

KB consult found `Commit stage` and `Continuous integration` notes relevant. They ground the target as fast actionable feedback on every change, with the commit stage ideally around 90 seconds and no more than ten minutes; slower acceptance/integration work should move to later parallel stages or a build grid. The `Commit stage` note also names "fail for slow tests" as a guard against gradual feedback-loop decay. Synto returned no relevant articles or source segments for this topic.

### Architecture sketch

```text
PR update
  |
  +--> fast structural gates
  |
  +--> required test shards 1..N, each bounded to avoid the known worker-RPC failure mode
  |
  +--> aggregate required status for this head SHA and run ID only

push main / schedule
  |
  +--> same or broader regression signal, never a replacement for the PR-required pack safety net
```

### Options considered

1. Restore in-process Vitest file parallelism with a low worker count. This is the smallest code/config change and recovers some wall time, but it directly re-enters the known `onTaskUpdate` failure mode that caused serialization.
2. Use GitHub Actions matrix sharding for the Vitest suite, with each shard keeping conservative per-runner execution. This recovers parallel wall-clock behavior at the runner/job level while avoiding many heavy files contending inside one Vitest worker pool. It costs more runner concurrency but is the cheapest sufficient safety-preserving win.
3. Move full regression off PR and keep only a small PR smoke suite. This maximizes PR latency reduction but weakens safety for this pack, where CI is the main guard for prompt/rule/script contracts.

Chosen direction: matrix sharding for the current full regression, keeping full regression PR-required. A later main/schedule-only slow lane may be introduced for tests that are explicitly classified as too slow for the commit-stage budget, but this issue must not silently move today's required coverage off PR.

### Full-class enumeration

- Event class: pull request, push to main, scheduled/manual run.
- Change class: markdown-only, ordinary non-markdown, workflow/script/test-harness change.
- Test class: fast structural checks, Vitest shard, Pester/PowerShell checks, future slow-classified regression.
- Failure class: test assertion failure, shard infrastructure failure, missing shard result, timeout, cancellation, known worker-RPC timeout recurrence.
- Aggregation class: all required shards green, one or more red, missing/inconclusive, skipped by markdown-only classifier.

## Binding surface

- Ordinary non-markdown PRs keep a required full-regression signal, split so the complete `tests` job path (`tsc --noEmit`, Vitest, and Pester/PowerShell regression checks) reaches the commit-stage target instead of optimizing Vitest alone.
- The test-stage design must avoid reintroducing the known `onTaskUpdate` failure as an accepted steady-state flake. If bounded in-runner parallelism is used, it must be proven stable against that failure class; matrix sharding is the preferred safer contract.
- The PR gate exposes one stable aggregate required status that fails if any mandatory shard/check is red, missing, skipped unexpectedly, timed out, cancelled, or masked by `continue-on-error`.
- The aggregate consumes only results for the current workflow run and current PR head SHA; stale runs cannot satisfy a newer head.
- Shard assignment is coverage-safe for newly added tests: a new test file cannot silently fall outside PR-required coverage.
- The test split must not introduce shared mutable state between shards; shard execution must use isolated temp/generated/cache/port state as needed.
- Fast structural checks may report earlier than full regression, but they do not authorize merge alone for ordinary non-markdown PRs.
- Pester/PowerShell regression checks are either included in the parallelized budget or measured separately with evidence that their residual contribution keeps the complete `tests` job path under the target; they cannot become advisory by accident during the split.
- Any later move of an existing PR-required test into a main/schedule-only slow lane requires a separate issue with coverage-delta proof and explicit review approval.
- Fetch-depth reduction is explicitly out of scope for this issue because diff-sensitive security gates require correct base/head comparison.

```contract-evidence
binding-id: orchestrator-pack:ci-pipeline-split:pr-required-full-regression
binding-type: github-actions-required-test-policy
binding: ordinary non-markdown PRs keep required full-regression coverage while the test stage runs within the commit-stage time ceiling
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:ci-pipeline-split:vitest-shard-aggregate
binding-type: ci-shard-aggregation-policy
binding: the required test aggregate fails closed when any mandatory shard is red, missing, timed out, cancelled, or unexpectedly skipped
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)

binding-id: orchestrator-pack:ci-pipeline-split:worker-rpc-timeout-regression-guard
binding-type: test-runtime-flake-regression
binding: the CI test strategy does not accept recurring Vitest worker onTaskUpdate timeouts as the normal operating mode
producer: orchestrator-pack
evidence: NEW(produced-by AC#7)
```

## Files in scope

- `.github/workflows/**`
- `vitest.config.ts`
- `scripts/test-all.ps1`
- `docs/**`
- Lightweight CI guard scripts or fixtures, including a dedicated CI pipeline split guard (new)

## Files out of scope

- `scripts/verify.ps1` broad refactor; use `docs/issues_drafts/156-verify-script-test-runtime-refactor.md`
- Fetch-depth optimization for diff-sensitive jobs
- `plugins/**`
- `vendor/**`
- `packages/core/**`

## Denylist

```denylist
vendor/**
packages/core/**
plugins/**
```

Scope boundary note: This denylist is scoped to `155-ci-pipeline-split-parallel-test-stage`.

## Acceptance criteria

1. On an ordinary non-markdown PR, all current full-regression test coverage remains PR-required, but the complete `tests` job path (`tsc --noEmit`, Vitest, and Pester/PowerShell regression checks) is split or otherwise arranged so the target wall time is under ten minutes with an explicit stretch goal in the low single-digit minutes.

```producer-emission
producer: orchestrator-pack
datum: ci-pipeline-split
expected: pr-required-full-regression
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

2. The synced GitHub Issue number exists before implementation starts, and implementation branch/PR/check evidence is bound to that issue.
3. PR update concurrency reuses the PR-scoped cancellation contract from #486 rather than defining a second independent workflow policy. Superseded shard fan-out does not waste runner time, and current-head evidence cannot be satisfied by stale runs.
4. Required shard aggregation is fail-closed: a red, missing, timed-out, cancelled, or unexpectedly skipped shard prevents the aggregate required status from going green.

```producer-emission
producer: orchestrator-pack
datum: ci-pipeline-split
expected: vitest-shard-aggregate
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

5. Required-check migration is simple and reversible: introduce the new aggregate in shadow mode, require it only after representative green evidence, and document rollback.
6. Full-regression preservation is machine-checked. The PR proves the union of all required shards covers the serially discovered Vitest test files/tests, with no missing files and no unexpected duplicates; total test count alone is not sufficient evidence.
7. The implementation demonstrates that the known Vitest worker-RPC timeout class is not reintroduced as an ordinary CI flake. Matrix sharding must show representative GitHub Actions logs with zero accepted `onTaskUpdate` timeouts; any bounded in-runner parallelism alternative must add repeated/stress CI evidence rather than relying on one green run.

```producer-emission
producer: orchestrator-pack
datum: ci-pipeline-split
expected: worker-rpc-timeout-regression-guard
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

8. No existing PR-required test may be moved into a main/schedule-only slow lane by this issue. Any such move requires a separate issue, coverage-delta proof, and explicit review approval.
9. Fast structural checks are distinguishable from the full regression lane. Type-checking may move to a parallel fast check if useful, but ordinary non-markdown PR mergeability still depends on the aggregate full-regression result.
10. Fresh baseline numbers are recorded in the PR or docs for the complete `tests` job path, not only `npm test`: `tsc --noEmit`, Vitest, and Pester/PowerShell timing before and after the change, shard count if any, and whether failures were product failures or environment-specific. Timing metric excludes GitHub queue time, which is recorded separately.

```positive-outcome
asserts: an ordinary non-markdown PR gets required full-regression feedback in under ten minutes without accepted Vitest worker-RPC flake recurrence
input: realistic
```

## Upgrade-safety check

- Required CI semantics remain stricter than the fast lane: no ordinary code-bearing PR can merge on fast checks alone.
- Shard count and aggregation behavior are easy to adjust without changing the safety contract.
- The design preserves planner freedom for exact workflow names, shard count, and command wiring, but the observable required-signal and timeout-flake contracts are fixed.

## Verification

- CI run on a representative non-markdown PR showing all required shards/checks and aggregate status for the current head SHA/run ID.
- Evidence artifact or workflow summary with before/after wall time, shard count, total test count, and no accepted `onTaskUpdate` timeout recurrence.
- Full `tests` job timing report covering `tsc --noEmit`, Vitest, and Pester/PowerShell checks; Pester may remain unsharded only if the report proves it is not a residual bottleneck against the target.
- `scripts/check-ci-pipeline-split.ps1` or equivalent dedicated guard validates coverage preservation, aggregate fail-closed behavior, and current head/run binding.
- Machine-checkable serial-vs-shard coverage equivalence report.
- Required-check migration evidence for shadow mode, promotion, and rollback.
- Pester/PowerShell required-signal and timing evidence whether those checks are moved, aggregated, or intentionally left serial.
- Negative aggregation check, fixture, or static guard proving red, missing, skipped, timed-out, and cancelled shard states cannot produce a green aggregate.
- Timing report separating queue time, shard runtime, and aggregate completion latency.
- Evidence that shard execution does not share mutable temp/generated/cache/port state in a way that can affect results.
- Existing local checks remain green:

```powershell
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
```

## Review decision log

- GPT passes 1-2: accepted the load-bearing gaps only: fail-closed aggregate, current head/run binding, serial-vs-shard coverage preservation, RPC timeout recurrence guard, no movement of current PR-required tests to a slow lane, and Pester/PowerShell required-signal preservation.
- GPT passes 3-5: later findings pushed toward heavy rollout ceremony. After operator review, retained the real outcomes (coverage-safe new tests, no shared mutable shard state, simple reversible required-check migration) and removed mechanism-heavy requirements for expected-shard schemas, four-state branch-protection snapshots, and formal isolation equivalence reports.
- Codex review after GPT cap: accepted the issue-identity confusion finding; prerequisite now states that existing GitHub #155 is distinct from this draft's authoritative synced issue identity.
- Operator review after sync: accepted that #486 owns PR-scoped concurrency; this draft now reuses that contract instead of defining a second concurrency policy. Follow-up operator review required full `tests` job timing (`tsc --noEmit`, Vitest, and Pester/PowerShell), so the budget target is no longer tied to Vitest-only baseline.
- GPT loop: 5 passes; stopped because cap-5; last-pass accepted=0; final STATE=completed_valid VALIDATION=ok pass=1cf2d1d0-4d19-41ed-afd6-1910b6d28cf2 sha=cc56591bb7c6ff0eae4eb7c039eba6f1a61bcca41905712b63923df8c2da8d10
