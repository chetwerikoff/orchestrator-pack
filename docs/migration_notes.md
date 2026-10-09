# Operator adoption

This is the current operator-facing adoption surface referenced by repository scope policy.
Keep only concrete post-merge actions that are still required by the current tree. Completed
migration procedures belong in Git history and their GitHub Issues/PRs.

## Current state

LeoPoker wake supervisor: after this repair is on the default branch, clear a persisted
`scheduler_child_stall_loop` with `scripts/orchestrator-wake-supervisor.ts reset-stall-refusal`
using the same project, state directory, repo root, epoch, and registry arguments as `run`,
then start the supervisor from that default branch. Do not reset or start it from an unmerged
worktree. Remove this paragraph once that start is healthy.


## Issue #2430 — post-merge manager recovery adoption

After #2430 lands on the selected project's adopted pack checkout (not from
an unmerged worktree), use the existing scripts from PACK_ROOT. The PR itself
does not adopt machine state or restore a native Run.

1. Validate the selected project card repository, primaryRoot, defaultBranch and
   PACK_ROOT through the current setup procedure. Confirm Run/Task membership
   using orca orchestration run-show --id "$RUN_ID" --json and
   orca orchestration task-list --run "$RUN_ID" --json.
2. Independently inspect the historical Run coordinator_handle and establish
   that the **old** exact Run-bound coordinator terminal is no longer live
   before any run-use. A stored coordinator_handle is not liveness evidence:
   the currently substantiated native reads do not provide the required
   exact-identity pre-bind liveness witness. If live/unknown/unverifiable,
   **do not run run-use**; manually reconcile that exact old Run/handle using
   already-supported native authority. Only after separately proven safe
   reconciliation may a genuinely runtime-issued fresh coordinator handle
   conditionally use orca orchestration run-use --id "$RUN_ID" --json
   (optionally --from the actual observed exact current handle). Confirm
   orca orchestration run-current --json and
   orca orchestration run-show --id "$RUN_ID" --json both refer to the
   same existing Run and coordinator_handle equals ORCA_TERMINAL_HANDLE.
   These post-bind reads cannot substitute for old-terminal pre-bind proof.
   Without that independent proof, stop here before invoking the manager launch assistant.
   Never send worker-start to the coordinator terminal.
3. Read orca orchestration dispatch-show --task "$TASK_ID" --json **before**
   preparing a worktree or terminal. A present Dispatch is reconciled and
   continued by the existing coordinator, not restarted. For an absent
   Dispatch, invoke the existing manager launch assistant with the exact
   --project, --issue-number, --run, --task and --worktree arguments as shown
   in docs/target_repo_setup.md. Its second pre-start Dispatch check remains
   mandatory. The selected Issue must have exactly one open same-repository
   closing PR with matching local branch, base branch and complete head SHA.
   Dirty, ambiguous, forked, drifted and otherwise unsupported evidence
   refuses without moving the manager branch.
4. Independently inspect the current same-project/repository *local*
   WorkerAssignment. Inspect operator-primary-binding show --project
   "$PROJECT_ID"; for a verified current local target only, use existing bind
   when the pointer is absent, or replace with the full observed expected
   task/binding/assignment-id/generation plus --operator-attested. Read back
   the project-scoped pointer and separately
   orca orchestration worker-show --dispatch "$DISPATCH_ID".
   If no valid local assignment exists, do not mutate the pointer.
5. For class-12 restoration, use only recognized native positive gone
   evidence and the preexisting expected-current WorkerAssignment fence.
   Retained/unknown old terminal handles are denial witnesses, not reuse
   or cleanup authority. No native external ff-2383 gone proof is asserted.
   The separately fenced exact historical terminal-mail exception in the
   generic worker-start path must continue unchanged. If provider succeeded
   but assignment publication lost a CAS race, reconcile the non-authoritative
   Dispatch manually; never announce ready or automatically start again.

**Adoption status:** Until the old coordinator's liveness is independently
proved safe, its Run rebinding remains unadopted/manual. Offline CI is not
evidence of live Run takeover or actual operator pointer mutation.

### Issue #2430 rollback

Halt fresh manager starts, retain the existing Run/Task/Dispatch and assignment
facts, and revert this patch from the adopted pack checkout via ordinary
source-control deployment. Re-read the actual native Run/Task/Dispatch after any
potential provider effect. Do not use a reset/rebase/forced update of a live PR
worktree, create replacement Dispatches to hide an ambiguous result, bypass the
operator-primary expected-current fence, or invoke run-use without old-terminal
pre-bind authority. Operator-local launchers, native Orca state and other
projects are not edited by this change.


When a change modifies runtime registration, supervised processes, operator-owned inputs, or
tracked policy delivery, record the exact target-specific post-merge actions here and in the PR
body. Remove those instructions once they are no longer actionable.

Use the current owning procedure rather than preserving compatibility narration:

- `docs/target_repo_setup.md` for target repository installation and verification;
- `docs/orchestration-runbook.md` for supervised runtime operation;
- `docs/orchestrator-recovery-runbook.md` for recovery.

## Rollback

Use source-control revert plus the owning current setup/runtime procedure. Do not preserve a
retired flow by adding aliases, fallback transports, duplicate state, or compatibility shims.
