# Isolate delegated publish from the architect's live working tree

GitHub Issue: #304

## Prerequisite

None blocking.

**Prior art (reference only — surveyed, no overlap, not a dependency):**

- GitHub #98 (review-layer resilience) — cleans stale *reviewer* workspaces with a
  `git worktree` preflight so review runs don't fail on "already exists". Scope:
  reviewer-workspace hygiene, not publish-delegation isolation.
- GitHub #91 (orchestrator launch death) — removes stale `orchestrator/*`
  worktrees/branches before `ao start`. Scope: orchestrator session preflight.
- GitHub #148 (coworker delegation) — prohibits the coworker delegate from running
  `ao-declare` / `ao report` / opening PRs, but only at the *prompt* level; nothing
  stops a delegate mutating tracked files in the live tree.

None of these isolates a delegated **publish** from the architect's working tree;
the recon (coworker over the full `docs/issues_drafts/**` + decision log) found the
threat model uncovered.

## Goal

A delegated publish (issue-create, draft-to-main publish, or PR merge — currently
run via `opencode run` against the architect's live working tree) must never
disturb that working tree. After any delegated publish — whether it succeeds,
errors, is retried after a startup hang, or is killed mid-flight — the architect's
current branch, `HEAD`, index, and all uncommitted changes (tracked and untracked)
must be exactly as they were before. The publish must still operate on the local
draft(s) as they sit uncommitted on disk.

```behavior-kind
action-producing
```

## Background — the failure this fixes

The publish helper isolates only opencode's SQLite state (a per-invocation data
dir). It still launches the delegate against the **live** working tree, so the
delegate's git sequence (`git checkout main` → `git pull` → `git checkout -b …` →
clean/stash the tree → commit → PR → merge → `git checkout main`) runs there. With
any uncommitted **tracked** change present, the clean/stash step discards it and the
branch checkout moves the architect off their branch. Observed: an in-progress
architect skill edit was wiped and the branch switched to `main` during an unrelated
delegated publish; an orphaned `stash@{0}: unstaged working tree before merge` was
the residue of the abandoned stash. Untracked files survived (checkout/stash without
`-u` ignore them), which is why the data loss was silent and partial.

Failure class: **a shared, mutable resource (the git working tree) used by a
delegate without isolation** — the same class AO already solved for workers (each
worker runs in its own worktree) and for reviewers (#98) and the orchestrator (#91).
Publish is the one delegated path still operating in the live tree.

## Binding surface

- The delegated publish runs against an **isolated checkout** of the repository,
  separate from the architect's live working tree, so no git mutation
  (checkout/branch/pull/stash/reset/commit/merge) touches the live tree, its
  current branch, its `HEAD`, or its uncommitted changes.
- The isolated checkout **contains the draft file(s) being published in their
  on-disk (uncommitted) form** — and **only** those, so the delegate can commit/PR
  content that exists only as an uncommitted/untracked file in the live tree
  **without** importing unrelated uncommitted live-tree changes (other tracked
  edits, other untracked files). Only the intended draft and its index row may
  appear in the published artifact; a whole-tree copy that would let an unrelated
  in-progress edit leak into the commit/PR does not satisfy this.
- The isolation is **created and torn down within the publish helper**: cleaned up
  on every **trappable** exit path — success, model/tool error, startup-hang retry,
  and a trapped termination signal. For **untrappable** deaths (`SIGKILL`, host
  crash) where no teardown can run, a leftover scratch checkout must be **reaped by
  the next run's preflight** (same pattern as the helper's existing safe orphan
  reap and the #98/#91 stale-worktree preflight), so scratch checkouts/branches do
  not accumulate across runs.
- If the isolated checkout **cannot be established**, the helper **fails loud**
  (non-zero, actionable message) and does **not** fall back to mutating the live
  tree.
- Per-invocation isolation holds under concurrency: two delegated publishes, or a
  publish concurrent with live architect edits, do not share or corrupt one
  another's checkout (extends the existing per-invocation SQLite isolation to the
  git checkout).
- The actual publish sequence delivered to the delegate (which `gh`/`git`
  subcommands, the spec-only PR rules, the index-row staging discipline) is
  unchanged **except** where it assumed the live tree (e.g. a live-tree
  `git checkout main` is no longer the mechanism for getting a clean base).
- The three skill prompts that drive this delegation
  (`publish-issue-draft`, `create-issue-draft`, `merge-with-local-adoption`) are
  updated to match the isolated model and to stop instructing live-tree checkout.

No operator-facing surface changes (agent-facing skills + helper only) — no
operator-adoption step.

## Files in scope

- `.claude/skills/publish-issue-draft/opencode-publish.sh` — establish/tear down
  the isolated checkout around the delegate run; guard + cleanup.
- `.claude/skills/publish-issue-draft/SKILL.md` — delegation prompt + invariants.
- `.claude/skills/create-issue-draft/SKILL.md` — publish-section prompt.
- `.claude/skills/merge-with-local-adoption/SKILL.md` — merge-delegation prompt.

## Files out of scope

- The opencode model/runtime/SQLite-isolation config already in the helper
  (deepseek-chat, timeout, startup-hang watchdog, orphan reap) — preserve as-is.
- The `ao spawn` worker path and AO worker worktree management.
- The content of the `gh`/`git` publish/merge sequence itself (issue body
  derivation, spec-only PR template, scope-guard rules).
- `agent-orchestrator.yaml` / `.example`, CI workflows, `scripts/**`,
  `plugins/**`, `packages/**`, `vendor/**`.

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
.claude/skills/**
```

## Class to cover (not just the one case)

The clobber is a concurrency/state class; the build must hold across the matrix,
not only the reproduced cell. Dimensions × values:

- **Live-tree state at delegation:** clean-on-main · uncommitted tracked change ·
  on a feature branch · untracked files present.
- **Delegation kind:** sync-only issue-create · batch publish · full draft→main
  publish · PR merge.
- **Exit path:** success · model/tool error · startup-hang→kill→retry (trappable) ·
  untrappable kill mid-publish (`SIGKILL`/crash) → leftover reaped on next preflight.

Expected outcome for every cell: after the delegation, the live tree's branch,
`HEAD`, and uncommitted (tracked + untracked) changes are byte-identical to before;
the publish's own artifacts are either correct or cleanly absent (never a partial
state achieved by clobbering the live tree); and no scratch checkout is leaked. Hand
these cells to Verification as fixtures.

## Acceptance criteria

- With an uncommitted modification to a tracked file in the architect working tree,
  a delegated publish completes and that modification is byte-identical afterward.
- The architect's current branch name and `HEAD` commit are identical before and
  after a delegated publish.
- Untracked files in the live tree are present and unchanged after a delegated
  publish.
- A draft that exists only as an uncommitted/untracked file on disk is correctly
  committed/PR'd by the delegate (its content lands in the published artifact),
  proving the isolated checkout sees the local draft.
- With an **unrelated** uncommitted tracked edit also present in the live tree, that
  edit does **not** appear in the published commit/PR — only the intended draft and
  its index row do (no whole-tree leak).
- On each trappable exit path (success, error, startup-hang retry, trapped
  signal), no scratch checkout or leftover publish branch remains afterward.
- After an untrappable kill (`SIGKILL`) that leaves a scratch checkout behind, the
  next publish run's preflight reaps it (and does not touch the live tree doing so).
- When the isolated checkout cannot be created, the helper exits non-zero with an
  actionable message and performs no git mutation in the live tree.
- The matrix in "Class to cover" is exercised across both axes: the four live-tree
  states × the success and startup-hang-retry exit paths preserve the live tree,
  **and** all four delegation kinds (sync-only issue-create, batch, full draft→main
  publish, PR merge) are confirmed to run against the isolated checkout — none
  performs a checkout/branch/stash in the live tree.

```positive-outcome
asserts: with a parallel uncommitted tracked change and an uncommitted local draft both present in the live tree, a delegated publish creates the issue/PR from the draft AND leaves the parallel change, the current branch, and HEAD byte-identical
input: external-tool-output
provenance: capture-backed
```

(Capture basis: this session reproduced the clobber — reflog shows the live-tree
`checkout main → branch → merge` sequence and the orphaned pre-merge stash; the
worker reproduces the protected behavior against that scenario.)

## Upgrade-safety check

- No edits to AO core, `packages/**`, `vendor/**`, CI workflows, or
  `agent-orchestrator.yaml`.
- No new repo secret; the isolated checkout uses the existing local repo/credentials.
- The helper stays a self-contained bash script under `.claude/skills/`; no
  unsupported YAML, no new long-running operator process.
- Existing helper protections (SQLite data-dir isolation, startup-hang watchdog,
  safe orphan reap) are preserved, not regressed.

## Verification

- Stage the scenario: on a feature branch, make an uncommitted edit to a tracked
  file and leave an uncommitted/untracked draft on disk; run a delegated publish of
  that draft; assert `git status`, `git branch --show-current`, `git rev-parse HEAD`,
  and the tracked file's contents are unchanged, and the issue/PR carries the draft.
- Repeat for each live-tree state in the matrix and for the startup-hang-retry path
  (force a retry via the watchdog deadline); assert the live tree is preserved each
  time and no scratch checkout/branch is left (e.g. `git worktree list` / temp-dir
  listing is clean).
- Simulate isolation-setup failure; assert the helper exits non-zero with a clear
  message and the live tree is untouched.
- `SIGKILL` a publish mid-flight; assert a scratch checkout is left, then run the
  next publish and assert its preflight reaps the leftover without touching the
  live tree.
- Confirm the three skill prompts no longer instruct a live-tree checkout and
  describe the isolated model.
