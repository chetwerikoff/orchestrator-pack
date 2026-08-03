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
- Multiple worktrees may legitimately start from the same source commit. A shared HEAD SHA is
  not itself an identity collision; path, branch, binding, and the complete row decide identity.

## Mechanical create and bounded continuation

The canonical create path is one executable operation. Resolve the exact intended source SHA,
choose one safe unique primary name, and run:

```bash
node --experimental-strip-types scripts/worktree-lifecycle/create-continuation.ts \
  --repo-root "$(git rev-parse --show-toplevel)" \
  --issue <number> \
  --expected-head <40-hex-source-head> \
  --name <unique-primary-name> \
  --apply \
  --json
```

The command:

1. acquires the same process-local exclusion path used by guarded teardown/recovery;
2. reads Git and Orca before any create;
3. resumes one already exact-dual Issue-bound worktree without recreating it;
4. otherwise performs at most one primary `orca worktree create` attempt;
5. reads both authorities even when the create response is missing, invalid, or timed out;
6. preserves disputed state and performs at most one isolated replacement create with a fresh
   name, rooted at the exact source SHA;
7. performs two fresh exact-dual reads before returning one selected worktree;
8. returns `task_degraded` with `pipelineContinues: true` when no safe candidate exists.

A dead local lock owner may be recovered using PID/start-time evidence. A live, malformed, or
changed lock remains fail-closed. The command never creates a third worktree attempt and never
spawns a terminal itself.

Terminal creation is allowed only when the report says:

```json
{
  "outcome": "ready_to_spawn",
  "terminalSpawnAuthorized": true,
  "selected": { "path": "/absolute/verified/worktree" },
  "selectedReadBack": {
    "classification": { "classification": "exact_dual" },
    "decision": { "terminalSpawnAuthorized": true }
  }
}
```

Use `selected.path` as the only worktree eligible for the subsequent terminal create. A second
concurrent caller receives a no-effect degraded result rather than another create or spawn.

## Read-only post-create classification

For diagnostics of an already known worktree, the lower-level read-only command remains
available:

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

For a detached worktree, replace `--expected-branch ...` with `--detached`. This command does not
own create or replacement effects; canonical handoff uses `create-continuation.ts`.

## Guarded Git-only recovery

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

## Nonblocking post-merge cleanup

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

Publication from a continuation branch still uses the repository's normal current-head and
expected-head checks; it must not overwrite an advanced PR branch.
