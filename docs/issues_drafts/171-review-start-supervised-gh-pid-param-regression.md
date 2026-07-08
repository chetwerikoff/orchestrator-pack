# Review-start supervised-gh child stop must not bind against read-only `$PID`

GitHub Issue: [#534](https://github.com/chetwerikoff/orchestrator-pack/issues/534)

## Prerequisite

- `docs/issues_drafts/164-review-start-readiness-envelope-external-io-accounting.md` (GitHub #515, closed) — introduced `Stop-ReviewStartSupervisedGhChild` and ownership-loss cleanup on supervised `gh` child PIDs during review-start claim infra pause.
- `docs/issues_drafts/165-review-start-envelope-cross-attempt-ledger-and-escalation.md` (GitHub #516, closed) — cross-attempt ledger on the same lifecycle surface; does not cover this named-parameter regression.
- `docs/issues_drafts/124-supervisor-empty-pid-file-start-crash.md` (GitHub #388) — precedent for PowerShell chokepoint hardening where a read-only/null edge aborts supervisor-side automation before side effects complete.

**Prior-art verdict:** new tight regression sibling on shipped #515 lifecycle code. #515/#516 are closed; no open queue item targets this bind-time failure. Not an amendment — the fix is a parameter rename plus regression guard, not a lifecycle contract change.

## Goal

`Stop-ReviewStartSupervisedGhChild` and every callsite must be invocable on PowerShell 7.x without bind-time failure against the automatic read-only `$PID` variable. Automated review-start paths (`review-trigger-reconcile`, supervised `gh` infra pause cleanup, ownership-loss cleanup) must not abort a reconcile tick before `ao review run` can start for uncovered heads.

```behavior-kind
action-producing
```

```contract-evidence
none
```

No upstream AO/gh producer field is bound. Failure is a local PowerShell parameter-name collision in pack lifecycle helpers.

## Background (confirmed root cause)

Live incident 2026-06-29 on WSL/Linux, PowerShell 7.6.2:

```
review-trigger-reconcile: tick error: Cannot overwrite variable Pid because it is read-only or constant.
```

Log: `/home/che/.local/state/orchestrator-pack-wake-supervisor/review-trigger-reconcile.log`

Direct reproduction:

```powershell
function Stop-ReviewStartSupervisedGhChild { param([int]$Pid) }
Stop-ReviewStartSupervisedGhChild -Pid 12345
# → Cannot overwrite variable Pid because it is read-only or constant.
```

Source: `scripts/lib/Review-StartClaimLifecycle.ps1` — `Stop-ReviewStartSupervisedGhChild { param([int]$Pid) ... }`.

Introduced in merge `78d26d7` (#515). `npx vitest run scripts/review-start-envelope-external-io.test.ts` passes (19/19) but does not invoke this helper with a real parameter bind.

**Tick ordering (log-bound, no over-claim):** on the failing tick, PR #531 was deferred as `degraded_ci_visibility` before PR #529 was skipped as `head_covered`; the crash occurred immediately after #529. The log does **not** record which uncovered PR was next in the reconcile plan. Therefore “crashed while starting #531” is **not** established by this log alone. What **is** established: the tick terminated with a bind error, so later uncovered PRs in the same tick (including #527/#528/#531 class heads) received no new `ao review run` on that pass.

**Observed fleet state at incident time:** `ao review list` showed only **outdated** runs for PRs #527, #528, #531 — no covering run for current heads. Workers had reported `ready_for_review`; reconcile could not complete automated starts until the bind error is fixed or operator runs `ao review run` manually.

## Binding surface

- **No `$Pid` parameter names on functions that accept a process id.** Any helper that stops or inspects a child process by id must use a non-colliding parameter name (illustrative: `$ProcessId`, `$ChildProcessId`). PowerShell treats `$Pid` and `$PID` as the same symbol; `$PID` is automatic and read-only.
- **All callsites updated.** Every invocation currently passing `-Pid` to `Stop-ReviewStartSupervisedGhChild` must use the renamed parameter. Known callsites at authoring time: `Review-StartClaimLifecycle.ps1` (ownership-loss cleanup), `Review-StartSupervisedGh.ps1` (two cleanup paths). Planner may find additional call sites; static guard must cover the whole `scripts/**` tree.
- **Semantics unchanged.** When the target pid is not running, the helper returns a non-throwing `not_running` (or equivalent) outcome — same as today. This issue fixes binding only, not kill policy (#515 intent preserved).
- **Reconcile tick must survive cleanup.** `review-trigger-reconcile` must not record `tick error` for this bind failure when ownership-loss cleanup runs during claim acquisition on an uncovered head.

## Files in scope

- `scripts/lib/Review-StartClaimLifecycle.ps1`
- `scripts/lib/Review-StartSupervisedGh.ps1`
- `scripts/**` — regression test surface and static guard the planner chooses
- `docs/**` — only if verification docs need a one-line operator note

## Files out of scope

- `vendor/**`, `packages/core/**`, `.ao/**`
- AO core / `ao review run` behavior changes
- Reopening #515/#516 envelope or ledger contracts
- GraphQL rate-limit / fleet-cache work (#140, #168)

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
scripts/**
docs/**
tests/external-output-references/**
```

## Operator adoption

After merge: restart supervised side processes so reconcile loads the fix — `ao stop` / `ao start`, or wake-supervisor stop/start per local runbook. Optional immediate unblock before ship: manual `ao review run` on affected worker sessions.

## Acceptance criteria

```positive-outcome
asserts: Stop-ReviewStartSupervisedGhChild binds and returns a non-throwing outcome for a non-existent pid; review-trigger-reconcile no longer logs tick error Cannot overwrite variable Pid on the ownership-loss cleanup path; static guard fails on reintroduction of param([int]$Pid) in scripts
input: realistic
```

1. **Parameter bind succeeds.** A regression test dot-sources the lifecycle helper (and any required dependencies the planner chooses) and invokes `Stop-ReviewStartSupervisedGhChild` with a non-existent pid (e.g. `999999`). The call completes without a terminating bind error and returns `not_running` (or equivalent non-throwing outcome) — not a PowerShell parameter collision.

```producer-emission
producer: orchestrator-pack
datum: review-start-supervised-gh-pid-bind
expected: stop-helper-binds-without-pid-collision
proof-command: npm test -- review-start-supervised-gh-pid
```

2. **All callsites use renamed parameter.** Every `Stop-ReviewStartSupervisedGhChild` invocation in `scripts/**` passes the renamed argument (not `-Pid`). Covered by the regression test and/or a focused callsite inventory assertion the planner chooses.

3. **Reconcile tick no longer dies on this class.** A fixture or integration test exercises the ownership-loss cleanup path that calls `Stop-ReviewStartSupervisedGhChild` during claim acquisition far enough to prove the helper is invoked without `tick error: Cannot overwrite variable Pid`. Planner picks fixture shape; contract is **no bind-time abort** on that path.

```producer-emission
producer: orchestrator-pack
datum: review-start-supervised-gh-pid-bind
expected: reconcile-ownership-loss-cleanup-no-pid-bind-error
proof-command: npm test -- review-start-supervised-gh-pid
```

4. **Static guard against recurrence.** A `scripts/**` static check (new script or extension of an existing verify hook) fails CI when any function declares `param([int]$Pid)` or `param($Pid)` (case-insensitive `$pid` parameter name on functions). Guard scope: `scripts/**/*.ps1`. Rationale: `$PID` is automatic/read-only and case-insensitive in PowerShell.

```producer-emission
producer: orchestrator-pack
datum: powershell-pid-param-static-guard
expected: scripts-tree-fails-on-pid-parameter-name
proof-command: pwsh -NoProfile -File scripts/check-powershell-pid-param-static.ps1
```

5. **Existing envelope suite stays green.** `npx vitest run scripts/review-start-envelope-external-io.test.ts` and `scripts/review-start-claim-lifecycle.test.ts` remain passing — no regression in shipped #515/#516 behavior.

## Upgrade-safety check

Pack-only `scripts/**` change; no Composio core or AO schema dependency.

## Verification

```powershell
pwsh -NoProfile -File scripts/verify.ps1
npm test -- review-start-supervised-gh-pid
pwsh -NoProfile -File scripts/check-powershell-pid-param-static.ps1
```

Manual pre/post repro:

```powershell
pwsh -NoProfile -Command 'function Stop-ReviewStartSupervisedGhChild { param([int]$ProcessId) }; Stop-ReviewStartSupervisedGhChild -ProcessId 12345'
# post-fix: no bind error
```

## Decision log

- **Cheapest sufficient fix:** rename the helper parameter and all `-Pid` arguments; do not introduce a wrapper alias or try/catch around binding — the collision is at bind time, before the function body runs.
- **Static guard over comment-only policy:** grep-style guard chosen because the failure mode is silent at author time and invisible to existing vitest fixtures until a real bind occurs in reconcile.
- **Incident wording discipline:** draft does not assert crash happened specifically while starting PR #531; log only proves tick abort after #529 skip.
