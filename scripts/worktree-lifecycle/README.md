# Worktree lifecycle continuity

Issue #1298 adds one bounded decision seam between Git's common worktree registry and
Orca's supported worktree/agent/terminal inventories. It does not create a third registry,
watcher, daemon, or background reconciler.

## Contract

- Git and Orca are read independently and validated before use.
- The exact identity is repository root + canonical worktree path + issue-or-PR authority +
  branch or detached mode + full 40-hex HEAD SHA.
- Pre-PR create/handoff uses `--issue` and requires the exact Orca `linkedIssue`.
- Post-merge cleanup and destructive recovery use `--pr`; issue-only authority can never
  authorize removal.
- Only `exact_dual` authorizes terminal spawn.
- `exact_git_only` may use the guarded PR-bound recovery path; it is never deleted by path alone.
- `orca_only`, duplicate, malformed, unavailable, or conflicting evidence preserves the
  disputed target.
- A target-level mutation block never stops the global work pipeline. The terminal report
  carries `cleanup_deferred`, `replacement_required`, or `task_degraded`,
  `pipelineContinues: true`, and an actionable continuation decision.

## Commands

Post-create read-back, before any terminal or agent spawn:

```bash
node --experimental-strip-types scripts/worktree-lifecycle/cli.ts \
  --context post-create \
  --repo-root "$(git rev-parse --show-toplevel)" \
  --worktree "<absolute-worktree-path>" \
  --issue <number> \
  --expected-head <40-hex-worktree-head> \
  --expected-branch <worktree-branch> \
  --json
```

For a detached worktree, replace `--expected-branch ...` with `--detached`.
Terminal creation is allowed only when the report says:

```json
{
  "outcome": "ready_to_spawn",
  "classification": { "classification": "exact_dual" },
  "decision": { "terminalSpawnAuthorized": true }
}
```

Guarded recovery for one exact Git-only merged-PR candidate is dry-run by default:

```bash
node --experimental-strip-types scripts/worktree-lifecycle/cli.ts \
  --context explicit-recovery \
  --repo-root "$(git rev-parse --show-toplevel)" \
  --worktree "<absolute-worktree-path>" \
  --pr <number> \
  --expected-head <40-hex-pr-head> \
  --expected-branch <pr-head-branch> \
  --json
```

Review every gate. Re-run the same command with `--apply` only when the dry-run outcome is
`git_only_recovery_eligible`. Apply uses Git's non-force `worktree remove`, never
`orca worktree rm --force`, `rm -rf`, or branch `-D`.

Nonblocking post-merge cleanup:

```bash
node --experimental-strip-types scripts/worktree-lifecycle/cli.ts \
  --context post-merge-cleanup \
  --repo-root "$(git rev-parse --show-toplevel)" \
  --worktree "<absolute-worktree-path>" \
  --pr <number> \
  --expected-head <40-hex-pr-head> \
  --expected-branch <pr-head-branch> \
  --apply \
  --json
```

A valid lifecycle terminal report exits zero even when its target result is
`cleanup_deferred`, `replacement_required`, or `task_degraded`. This is intentional: the report
blocks unsafe mutation of that target, not the scheduler or an already successful merge/adoption.
Invalid CLI arguments exit 2.

## Replacement rule

When post-create read-back is not exact dual:

1. Read the report; never blindly repeat an unknown create attempt.
2. If a PR already exists and the report is `exact_git_only`, the PR-bound guarded recovery path
   may be used. A pre-PR issue-bound worktree is never destructively recovered by issue number.
3. Preserve every disputed target that cannot be proven safe. Perform at most one isolated
   replacement create using a unique path and a fresh local continuation branch rooted at the
   exact expected source SHA.
4. Read back the replacement through this command with the same issue authority. Spawn only after
   exact dual agreement, including the exact Orca `linkedIssue`.
5. If the replacement also cannot become exact dual, return task-level degraded control to the
   scheduler/operator. Do not loop and do not stop unrelated tasks.

Publication from a continuation branch still uses the repository's normal current-head and
expected-head checks; it must not overwrite an advanced PR branch.
