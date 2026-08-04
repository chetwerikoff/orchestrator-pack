# Worktree lifecycle continuity

Issue #1298 adds one bounded decision seam between Git's common worktree registry and
Orca's supported worktree/agent/terminal inventories. It does not create a third registry,
watcher, daemon, or background reconciler.

## Contract

- Git and Orca are read independently and validated before use.
- The exact Orca repository identity is derived from the capture-shaped composite
  `result.worktrees[].id` value (`<repository-id>::<canonical-worktree-path>`). The embedded path
  must equal the separately returned canonical `path`; a missing, malformed, or inconsistent id
  fails closed.
- The complete identity is repository id + repository root + canonical worktree path +
  issue-or-PR authority + branch or capture-proven detached mode + full 40-hex HEAD SHA.
- Pre-PR create/handoff uses Issue authority and requires the exact Orca `linkedIssue`.
- Post-merge cleanup and destructive recovery use PR authority; issue-only authority can never
  authorize removal.
- A read-only `exact_dual` observation never exports terminal-spawn authority. Only the bounded
  create-and-spawn actuator may create a worker terminal, while holding the lifecycle exclusion.
- `exact_git_only` may use the guarded PR-bound recovery path; it is never deleted by path alone.
- Archived, main-worktree, wrong-repository, duplicate, malformed, unavailable, Orca-only, or
  conflicting evidence preserves the disputed target.
- Missing, malformed, active, or interrupted `worktree ps` agent evidence blocks candidate use.
- An explicit empty Orca branch string is the only accepted detached representation. Missing,
  non-string, or whitespace-only branch data is malformed rather than detached.
- A target-level mutation block never stops the global work pipeline. The terminal report carries
  `cleanup_deferred`, `replacement_required`, or `task_degraded`, `pipelineContinues: true`, and
  an actionable continuation decision.
- Multiple worktrees may legitimately start from the same source commit. A shared HEAD SHA is not
  itself an identity collision; repository, path, branch, binding, and the complete row decide
  identity.

## Mechanical create and bounded worker start

The canonical handoff is one executable operation. Resolve the exact intended source SHA and run:

```bash
node --experimental-strip-types scripts/worktree-lifecycle/create-continuation.ts \
  --repo-root "$(git rev-parse --show-toplevel)" \
  --issue <number> \
  --expected-head <40-hex-source-head> \
  --terminal-title "<role> #<number>" \
  --terminal-command "<agent-cli> --model <model>" \
  --apply \
  --json
```

The command:

1. acquires the same owner-token exclusion path used by guarded teardown/recovery;
2. reads Git and Orca before any create and proves one active main-worktree repository id from the
   composite Orca id;
3. recognizes the complete Issue family independently of current HEAD or a caller-chosen name;
4. refuses another effect when any same-repository Issue-family row is old-head, malformed, active,
   interrupted, already terminal-bound, or otherwise disputed;
5. otherwise performs at most one stable primary create (`issue-<N>`);
6. reads both authorities even when the create response is missing, invalid, or timed out;
7. treats any terminal materialized by `worktree create` as create-owned activity: the new target is
   preserved and the actuator returns `task_degraded` without replacement or a separate terminal;
8. requires one exact, valid `worktree ps` row whose agents are all done and not interrupted before
   using a candidate;
9. preserves other disputed same-head state and performs at most one stable isolated replacement
   (`issue-<N>-replacement`) rooted at the exact source SHA;
10. performs two fresh exact-dual reads, creates one terminal while still holding the exclusion,
    and performs two more fresh reads proving exactly one new terminal handle;
11. returns `task_degraded` with `pipelineContinues: true` when no safe candidate or unique terminal
    result exists.

The exclusion records PID, process start time, and an unguessable owner token. A dead owner may be
recovered only after a stable compare-before-unlink check. A live, malformed, changed, or replaced
lock remains fail-closed, and only the recorded owner may unlink it. The teardown child borrows the
parent token without taking ownership, so create, recovery, child teardown, and dual post-readback
share one exclusion interval.

Successful output has this shape:

```json
{
  "outcome": "worker_spawned",
  "terminalSpawnCompleted": true,
  "terminalSpawnAuthorized": false,
  "selected": { "path": "/absolute/verified/worktree" },
  "selectedReadBack": {
    "classification": { "classification": "exact_dual" }
  },
  "terminal": {
    "handle": "runtime-terminal-handle",
    "worktreePath": "/absolute/verified/worktree"
  }
}
```

There is no later spawn authorization to transfer to another caller. Use the returned terminal
handle for subsequent worker observation or exact-handle close.

## Read-only post-create classification

For diagnostics of an already known worktree, the lower-level read-only command remains available:

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

For a detached worktree, replace `--expected-branch ...` with `--detached`. An exact match returns
`exact_dual_observed`; it does not authorize a terminal effect. Canonical handoff uses the bounded
create-and-spawn command above.

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
`git_only_recovery_eligible`. Every safety gate is recollected immediately before the effect under
the same exclusion. Apply uses Git's non-force `worktree remove`, never
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

The wrapper holds the shared owner-token exclusion across the authoritative pre-effect census,
teardown child, and dual post-effect readback. The child validates and borrows the parent token; it
does not unlink the parent lock. `cleanup_complete` is emitted only when the exact target is absent
from both authorities and unrelated in-repository inventory is unchanged. Effect-before-receipt may
settle complete from that readback; a successful child exit without dual absence settles
`task_degraded`.

A valid lifecycle terminal report exits zero even when its target result is `cleanup_deferred`,
`replacement_required`, or `task_degraded`. This is intentional: the report blocks unsafe mutation
of that target, not the scheduler or an already successful merge/adoption. Invalid CLI arguments
exit 2.

Publication from a continuation branch still uses the repository's normal current-head and
expected-head checks; it must not overwrite an advanced PR branch.
