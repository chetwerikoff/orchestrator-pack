---
name: create-issue-draft
description: Use when authoring a new task draft for `orchestrator-pack` — adding `docs/issues_drafts/NN-<slug>.md` and syncing it as a GitHub Issue. Covers the draft structure, the 5-mode framework triggers, decision logging, and the sync-to-GitHub procedure. Invoke before opening any new issue or rewriting an existing draft. Do not invoke for tiny docs typos or rename-only refactors.
---

# create-issue-draft

You are authoring a task spec that will be picked up by Cursor (planner+worker)
under AO orchestration and reviewed by Codex. Your output goes through GitHub
Issues. The planner picks file names, function shapes, library choices — you
set boundaries and acceptance criteria. **Over-specification is a bug.**

## When to invoke

- Adding a new issue to the queue.
- Rewriting an existing draft after a Codex finding or 5 Whys analysis.
- Splitting / merging issues during pre-implementation alignment.

Skip on: typo fixes, rename-only refactors, one-file mechanical CI tweaks.

## Draft file structure (fixed order)

Path: `docs/issues_drafts/NN-<slug>.md`. Top-level H1 is the issue title.

1. **Prerequisite** — issues that must merge first. Reference draft filenames,
   not just GitHub numbers: `Issue #3 (file docs/issues_drafts/00-architecture-decisions.md)`.
   GitHub numbers can shift; draft filenames are stable.
2. **Goal** — one paragraph. Outcome, not method.
3. **Binding surface** — what this issue commits the repository to. Concrete
   about contracts, deliberately vague about implementation.
4. **Files in scope** — coarse-grained directories or specific new files.
   Mark new files `(new)`. Avoid prescribing function names / signatures.
5. **Files out of scope** — explicit list.
6. **Denylist** — mandatory fenced block:
   ```
   ` ``denylist
   vendor/**
   packages/core/**
   .ao/**
   ` ``
   ```
   `_shared/issue_parser` consumes this verbatim. Always include `vendor/**`
   and `packages/core/**`. Add `allowed_roots` fence when the task should
   stay inside a subtree.
7. **Acceptance criteria** — observable, testable bullets. Each one provable
   without reading Claude's mind. Avoid "review by Claude" or "looks good."
8. **Upgrade-safety check** — explicit invariants (no AO core / vendor edits,
   no unsupported YAML, no new repo secrets unless declared here).
9. **Verification** — exactly how the planner proves done: commands, fixtures,
   test outcomes. Match acceptance criteria 1:1 where possible.

## Apply the 5-mode framework when

Run `docs/first_principles_5_operational_framework.md` inline before
finalising the draft if **any** of these hold:

- The task introduces a contract ≥ 2 future issues will depend on
  (finding format, declaration schema, ledger event keys).
- Scope spans more than one of `_shared` / plugin code / scripts / CI.
- The task is a response to a failure — start with **5 Whys**.
- Two scripts or templates share a literal that this task touches —
  apply **Mode 2 (Assumption Destruction)** before approving;
  prefer one canonical source.

Cost rule (from the framework): **don't ask which agent is best, ask which
is the cheapest sufficient executor given tests + Codex review as safety net.**

## Planner-freedom checklist (must pass)

Before syncing the draft to GitHub, confirm none of these is true:

- [ ] Draft names a specific function signature or import path.
- [ ] Draft prescribes a folder layout not derivable from existing conventions.
- [ ] Draft pins a library version, file-internal structure, or comment style.
- [ ] Acceptance criteria can only be checked by Claude reading the diff.

Any "yes" → loosen, re-author. The planner's `ao-declare` produces
`declared_paths`; you bound it via `denylist` + `allowed_roots`, you do not
enumerate it.

## Sync to GitHub Issue

The draft body **minus the H1 heading** is the issue body. Use:

```powershell
$body = "C:\Users\che\AppData\Local\Temp\issue-NN-body.md"
# Strip the H1 line and the blank line under it (`tail -n +3`):
Get-Content docs/issues_drafts/NN-<slug>.md | Select-Object -Skip 2 | Set-Content $body
gh issue edit <N> --repo chetwerikoff/orchestrator-pack --body-file $body
```

For new issues: `gh issue create ... --body-file $body --title "<title>"`.

## Cross-issue contract changes

When a change affects ≥ 2 drafts (example: NO_FINDINGS contract touching #9
and pulling lessons from #11), land **one** docs PR that:

- Updates every affected draft.
- Re-syncs every corresponding GitHub Issue body in the same PR.
- Bumps the relevant section in `docs/issues_drafts/00-architecture-decisions.md`
  (or `docs/architecture.md`) if a DD-level decision changed.

Never let drafts drift from the architecture decision they descend from. If
the planner sees a stale draft and an updated architecture section, it will
pick the wrong contract.

## Decision logging

Architectural decisions the planner needs across iterations:

1. Add a new sub-section (next letter: `00.G`, `00.H`) to
   `docs/issues_drafts/00-architecture-decisions.md`, or a new DD-NNN entry
   in `docs/architecture.md` once that file owns the DD log style.
2. Sync to Issue #3 (or the live architecture issue) in the same PR.
3. Update every affected draft in the same PR.
4. If the decision invalidates an open Codex finding or an in-flight planner
   action, say so in the PR body so the planner can re-baseline.

## Fold reviewer lessons back

A Codex finding on a merged PR is signal your spec missed something. Default
response: update the upstream draft (the one whose contract was violated),
not the implementation. The next iteration of that draft becomes the durable
fix; the merged PR's manual patch was the one-off.

Example: PR #21's op-rev-3 produced "no concrete bugs" prose wrapped as a
warning — the durable fix landed in Issue #9 (`NO_FINDINGS` contract), not
in the test-harness code.
