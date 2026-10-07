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

No other standing operator migration is required by the current default branch.

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
