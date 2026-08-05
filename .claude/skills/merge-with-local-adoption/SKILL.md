---
name: merge-with-local-adoption
description: >-
  Merge a ready PR, safely adopt merged main in the operator checkout, apply documented
  local adoption, then quiesce and remove the exact merged PR worktree. The post-merge
  path accepts the original worker head H0 and the live merged PR head H1, and may
  intentionally discard dirty target-only work after exact identity, capability,
  quiescence, final discard-manifest, and dual-read-back proof. It never broadens cleanup
  to the primary checkout, sibling worktrees, unrelated panes/processes, or a moved branch.
  Use for concrete merge requests such as «мерж 385», «смерж», or “merge and pull”.
---

# Merge with local adoption

Run the complete flow from the **operator terminal** in the live primary checkout
(`/home/che/projects/orchestrator-pack`). Never run teardown from inside the worktree being
removed, and never delegate merge/pull or destructive lifecycle authority to a nested agent.

`N` in a user command may be an Issue or PR number. Resolve it in Step 2 before acting.

## Runtime profile

The active runtime is Orca. Runtime-specific commands stay at the edge; the lifecycle
coordinator and destructive actuator validate their structured responses.

| Capability | Orca command |
|---|---|
| worktree inventory | `orca worktree list --json` |
| agent inventory | `orca worktree ps --json` |
| terminal inventory | `orca terminal list --json` |
| target terminal stop | `orca terminal stop --worktree "path:<wt>" --json` |
| one-pane close | `orca terminal close --terminal <handle> --json` |
| ordinary worktree removal | `orca worktree rm --worktree "path:<wt>" --json` |
| exact merged-target force removal | `orca worktree rm --worktree "path:<wt>" --force --json` |

Force removal is not an operator shortcut. It is available only through
`scripts/worktree-lifecycle/cli.ts --context post-merge-cleanup` after the installed command
shape has been capture-proven and every target-local gate has passed. The exact-dual actuator
requires a validated response with `removed: true`.

AO is retired. Do not use `ao session`, ProjectConfig, AO runtime-worktree probes, or AO
recovery scripts. Orca inventories are global across repositories, so every row must be
filtered by canonical repository identity before it can contribute authority.

## Non-negotiable safety rules

- Never use `git reset --hard`, `git clean`, forced checkout/switch, destructive restore,
  stash drop/clear, `rm -rf`, private Orca persistence edits, or manual `.git/worktrees`
  edits.
- Never select a target by display name, Issue substring, `active`, `current`, path
  substring, process name, command line, executable name, user-wide process list, or a
  blanket tab close.
- Never run direct `orca worktree rm --force` or `git worktree remove --force` by hand.
  Only the exact post-merge lifecycle command may authorize those effects.
- Never delete a local branch with `git branch -d` or `git branch -D` to finish cleanup.
  The actuator uses expected-old-OID compare-and-delete and refuses a moved/reused ref.
- Never signal PID 1, a negative PID, process-group zero, or a process selected by name.
  Process selection is current target CWD plus descendants only.
- A cleanup outcome never reverses a successful merge/adoption and never blocks unrelated
  scheduler work. Do not weaken a gate or blindly retry a disputed target.

## Step 1 — Snapshot the operator checkout

Record:

```bash
git rev-parse --show-toplevel
git branch --show-current
git status --short
git diff --stat
git diff --cached --stat
git stash list
orca worktree current --json
```

The Orca current row must resolve to the primary checkout. Preserve every pre-existing
operator-checkout change throughout the run. If a Git command refuses because of local
changes, report it; do not discard work.

## Step 2 — Resolve and bind the PR

Resolve the concrete PR with `gh pr view` or an exact `Closes/Fixes/Resolves #N` link.
Zero or multiple matches require one clarification; never guess.

Before merge, record:

```bash
read HEAD_REF H0 < <(gh pr view P --repo chetwerikoff/orchestrator-pack \
  --json headRefName,headRefOid -q '[.headRefName,.headRefOid] | @tsv')
```

Also resolve the unique non-primary target worktree path `WT` by exact repository, branch or
confirmed detached mode, full `H0`, and non-conflicting PR linkage. Preserve `WT`, `HEAD_REF`,
and `H0` for Step 9. The worktree may later remain at `H0` even when the PR moves to `H1`.

## Step 3 — Confirm readiness

Read required checks and PR state:

```bash
gh pr checks P --repo chetwerikoff/orchestrator-pack
gh pr view P --repo chetwerikoff/orchestrator-pack \
  --json state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
```

A direct user merge order may normalize draft to ready and update a `BEHIND` branch, then
must wait for checks on the new head. Required CI that is red, pending, queued, or absent
still blocks merge. `--admin` is not an escape because `main` enforces required checks.

When CI is red, send the exact failure evidence to the existing PR worker and verify the
message landed. Do not merge while a worker fix is in flight.

## Step 4 — Collect local adoption instructions

Read the PR body, changed paths/content, linked Issue, applicable migration notes, examples,
environment docs, runbooks, and rules-channel files. State the local post-merge work before
merging. Do not invent secrets, ports, or machine-local values.

Set `RULES_TOUCHED=yes` when the diff includes any of:

```text
AGENTS.md
CLAUDE.md
.cursor/rules/**
prompts/**
.claude/skills/**
```

## Step 5 — Merge

Use the repository merge strategy unless the user explicitly requested another supported
strategy:

```bash
gh pr merge P --repo chetwerikoff/orchestrator-pack --merge --delete-branch
gh pr view P --repo chetwerikoff/orchestrator-pack \
  --json state,mergedAt,mergeCommit,headRefName,headRefOid,baseRefName
```

Require `state=MERGED`. Record `MERGE_SHA=mergeCommit.oid` and live `H1=headRefOid`.
`H0 == H1` is valid. A rebase/update may produce `H0 != H1`; that is expected and does not
invalidate the original worker target.

## Step 6 — Adopt merged main in the operator checkout

Fetch and update safely. A dirty operator checkout uses the existing stash/merge procedure
without dropping the stash or losing paths. After adoption require:

```bash
git merge-base --is-ancestor "$MERGE_SHA" HEAD
git status --short
git log -1 --oneline
```

Current `main` may move beyond `MERGE_SHA`; equality is not required.

## Step 7 — Apply local operator adoption

Apply only the instructions identified in Step 4. Keep edits surgical and report any
remaining manual action. Never commit secrets or machine-local values unless the same user
message explicitly requested it.

## Step 8 — Sibling advisory

When `RULES_TOUCHED=yes`, report how far non-primary manager worktrees are behind and their
agent state. This is advisory and never blocks Step 9. Never auto-recycle or interrupt an
unrelated sibling manager.

## Step 9 — Exact merged-worktree cleanup

### 9a — Initial authority

The target must be the unique non-primary worktree bound to the saved tuple:

```text
canonical repository/common-dir
absolute WT
PR P
branch HEAD_REF or confirmed detached mode
original worker head H0
live merged PR head H1
```

The closed authorized target-head set is `{H0,H1}`. Any third head `H2`, changed common-dir,
path mismatch, branch/detached mismatch, duplicate census, primary checkout, conflicting
non-null linkage, or reused branch is target-local drift and receives no destructive effect.

The PR must still be `MERGED`, its live head must be `H1`, its base must be `main`, and its
merge result must be reachable from current `origin/main`. Current `origin/main` may advance;
`H0` need not be its ancestor.

### 9b — Dry-run

```bash
node --experimental-strip-types scripts/worktree-lifecycle/cli.ts \
  --context post-merge-cleanup \
  --repo-root /home/che/projects/orchestrator-pack \
  --worktree "$WT" \
  --pr "$P" \
  --expected-head "$H0" \
  --expected-branch "$HEAD_REF" \
  --json
```

For a Git-confirmed detached target, replace `--expected-branch` with `--detached`. The CLI
reads and validates live `H1`; do not supply or guess it separately.

Dry-run outcomes:

- `cleanup_eligible` — exact target and required removal capability are proven;
- `already_absent` — idempotent no-op;
- `unsupported_runtime_preflight` — required installed Orca force capability is not proven;
- `cleanup_deferred` — identity or authority is unsafe/ambiguous before quiescence;
- `task_degraded` — bounded evidence could not be validated.

Dirty files and active/interrupted target agents are report facts, not blockers in this exact
post-merge mode. They remain blockers in `explicit-recovery`, create/handoff, sibling recycle,
and all non-post-merge paths.

### 9c — Apply once

Run the same command with `--apply` after reading the dry-run:

```bash
node --experimental-strip-types scripts/worktree-lifecycle/cli.ts \
  --context post-merge-cleanup \
  --repo-root /home/che/projects/orchestrator-pack \
  --worktree "$WT" \
  --pr "$P" \
  --expected-head "$H0" \
  --expected-branch "$HEAD_REF" \
  --apply \
  --json
```

The actuator performs two phases under one lifecycle exclusion token.

**Phase A — quiescence**

1. Re-prove exact target identity and individually addressable target panes.
2. Stop/close only target panes; preserve unrelated panes in mixed tabs.
3. Repeatedly select processes whose current CWD equals/is below `WT`, plus descendants.
4. Apply bounded TERM, wait, SIGKILL, and repeated zero census.
5. Any observable survivor produces `task_degraded` and preserves worktree/ref.

**Phase B — irreversible removal**

1. Re-read Git/Orca census, live merged PR binding, branch ownership, and target head.
2. Capture a bounded, normalized, NUL-safe, path-only discard manifest twice after
   quiescence; require stable equality. It may list tracked, untracked, and non-allowlisted
   ignored paths, but never contents, diffs, credentials, secrets, or editor buffers.
3. Repeat full target proof immediately before removal. Late target-local drift produces
   `quiesced_cleanup_deferred`: quiescence is reported, but worktree/ref are preserved.
4. Remove the dirty exact target:
   - `exact_dual`: capture-proven Orca force removal with validated `removed: true`;
   - `exact_git_only`: `git worktree remove --force`, followed by dual read-back.
5. Compare-and-delete the local branch with expected-old-OID CAS. A missing, detached,
   moved, reused, ambiguous, or CAS-refused branch is reported and preserved; it does not
   falsify proven worktree cleanup.
6. Require target absence in both Git and Orca and unchanged unrelated in-repository
   inventory.

### 9d — Closed outcomes

- `cleanup_complete` — exact target removed; Git+Orca absence proven;
- `already_absent` — no-op repeat;
- `cleanup_deferred` — no quiescence/removal because initial authority was unsafe;
- `quiesced_cleanup_deferred` — target quiesced, but late drift blocked worktree/ref deletion;
- `unsupported_runtime_preflight` — capability missing before effects;
- `task_degraded` — a bounded effect or read-back could not be proven complete.

All valid lifecycle outcomes keep `pipelineContinues: true`. Do not call a successful merge
failed because cleanup deferred, and do not retry by weakening evidence.

### Evidence limit

CWD plus ancestry is observable inference, not proof of historical process ownership. A
process that changed CWD, double-forked, or reparented before census may be unreachable.
Launch-time cgroup containment is a separate follow-up, not a claim of this flow.

## Step 10 — Report

Report, in the user's language:

- PR, Issue, `MERGE_SHA`, saved `H0`, live merged `H1`, and whether `main` advanced;
- readiness normalization and required-check results;
- operator-checkout pull/adoption and preservation of pre-existing dirty paths;
- sibling advisory when applicable;
- lifecycle classification and final outcome;
- target path/branch, terminal/process counts, SIGKILL count, residual census;
- discard-manifest path categories/counts without contents;
- removal mode (`exact-dual Orca force`, `exact-git-only Git force`, or no effect);
- branch CAS result;
- final Git+Orca read-back and `pipelineContinues`;
- any unsupported/deferred/degraded evidence exactly as returned.

Never claim CI, adoption, quiescence, removal, branch deletion, or read-back succeeded without
the corresponding command evidence.
