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

1. **Prerequisite** — issues that must merge first. Reference the **draft file
   path** (stable) plus the GitHub number from
   [`docs/issue_queue_index.md`](../../docs/issue_queue_index.md) when known, e.g.
   `docs/issues_drafts/11-orchestrator-autonomous-review-loop.md` (GitHub #28).
   Never cite a bare draft prefix as if it were a GitHub Issue number.
2. **Goal** — one paragraph. Outcome, not method.
3. **Binding surface** — what this issue commits the repository to. Concrete
   about contracts, deliberately vague about implementation.
   - **Operator adoption** (required when **Files in scope** include
     operator-facing surfaces: `agent-orchestrator.yaml.example`, runbooks or
     go-live docs that introduce new operator processes, documented operator env
     vars, machine-local config outside the repo, or `orchestratorRules` /
     `reactions` requiring `ao stop` / `ao start`): add a bullet listing
     post-PR steps the operator must run (yaml merge, processes, env, restart,
     verification). Omit when the task does not touch those surfaces.
4. **Files in scope** — coarse-grained directories or specific new files.
   Mark new files `(new)`. Avoid prescribing function names / signatures.
5. **Files out of scope** — explicit list.
6. **Denylist** — mandatory fenced block, opened with three backticks then
   `denylist`, one path per line, closed with three backticks:

   ````markdown
   ```denylist
   vendor/**
   packages/core/**
   .ao/**
   ```
   ````

   `_shared/issue_parser` matches this fence with the regex
   `` ```(denylist|allowed-roots) `` — only literal triple-backtick fences
   parse. Always include `vendor/**` and `packages/core/**`. Add an
   ` ```allowed-roots ` fence when the task should stay inside a subtree.
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

## Codex review the draft (before sync, max 5 iterations)

Run a **critical architect** Codex pass on the draft markdown **before** `gh issue create`
or `gh issue edit`. Architect role: `CLAUDE.md`.

**Command discipline (non-negotiable):**

| Use | Do not use |
|-----|------------|
| `codex review` | `codex exec` |
| `scripts/review-architect-artifact.ps1` | `codex exec review` (that is worker **PR** review, not draft spec review) |

Do **not** pipe stdout through `tail`, `head`, or `grep` — wait for the full answer
(typically **10–60 s**; allow up to **3 min** before assuming a stall). Do **not**
kill the process early to sync the issue.

**Focus areas for the reviewer:**

- Planner-freedom (no prescribed signatures, paths, or library pins).
- Observable acceptance criteria (provable without "looks good").
- Command accuracy — real `ao` / `ao-declare` flags (`--declared-paths`,
  `--declared-globs`, not `--paths`); **pwsh 7+** snippets on Linux/WSL2; session id
  ≠ issue number (read from `ao status` / snapshot filename).
- `denylist` + `allowed-roots` fence correctness.
- Cross-draft consistency with `00-architecture-decisions.md` and related drafts.

**Preferred invocation (Linux / WSL2 / pwsh 7+):**

```powershell
pwsh -NoProfile -File scripts/review-architect-artifact.ps1 `
  -ArtifactPath docs/issues_drafts/NN-<slug>.md `
  -Kind issue-draft
```

Add `-FailOnFindings` to exit non-zero when the response is not `NO_FINDINGS`.

**Manual equivalent (pwsh — no stdin `<` redirect):**

```powershell
$draft = Get-Content -Raw docs/issues_drafts/NN-<slug>.md
$prompt = @"
You are the lead architect reviewer for orchestrator-pack (read-only issue-draft spec review).
Review the DRAFT below for planner-freedom, observable acceptance criteria,
command accuracy, denylist/allowed-roots fences, and cross-draft consistency.
Do not suggest implementation file names unless the draft already violates planner freedom.
Do NOT explore the repository unless the draft text is ambiguous.

Tag valid issues P0, P1, or P2.
If no concrete issues remain, respond with exactly NO_FINDINGS on its own line.

--- DRAFT ---
$draft
"@
codex review $prompt
```

**Bash equivalent (same contract):**

```bash
draft_path="docs/issues_drafts/NN-<slug>.md"
draft="$(cat "$draft_path")"
codex review "$(cat <<EOF
You are the lead architect reviewer for orchestrator-pack (read-only issue-draft spec review).
Review the DRAFT below for planner-freedom, observable acceptance criteria,
command accuracy, denylist/allowed-roots fences, and cross-draft consistency.
Do not suggest implementation file names unless the draft already violates planner freedom.

Tag valid issues P0, P1, or P2.
If no concrete issues remain, respond with exactly NO_FINDINGS on its own line.

--- DRAFT ($draft_path) ---
$draft
EOF
)"
```

Alternative when the draft is already saved and you are iterating locally:
`codex review --uncommitted` only if the draft is the sole staged change and
the review prompt is passed as the `PROMPT` argument as above.

**Iteration discipline:**

1. Revise the draft for valid P0/P1/P2 findings; rebut incorrect findings in
   the draft or your notes.
2. Re-run Codex (same prompt pattern).
3. **Hard cap: 5 cycles.** After the fifth pass, sync only if clean (`NO_FINDINGS`)
   or document remaining open questions in the draft **Prerequisite** or
   **Verification** section before sync.

**Sync gate:** do not run `gh issue create` / `gh issue edit` until Codex returns
`NO_FINDINGS` or you have hit the 5-iteration cap and recorded open questions.

Contract reference: `docs/issues_drafts/06-codex-reviewer-scope-context.md`.

## Update the issue queue index

Whenever you add a new draft or first sync a draft to GitHub:

1. Add or update the draft's row in
   [`docs/issue_queue_index.md`](../../docs/issue_queue_index.md) (draft path →
   GitHub Issue number, or explicit none yet).
2. Set the draft's `GitHub Issue: #NN` line (or `GitHub Issue: TBD` before sync).

Do not add open/closed/shipped columns to the registry — live state stays in
GitHub (`gh issue view`).

## Sync to GitHub Issue

The draft body **minus the H1 heading** is the issue body. Use:

```powershell
$body = Join-Path ([System.IO.Path]::GetTempPath()) 'issue-NN-body.md'
Get-Content docs/issues_drafts/NN-<slug>.md | Select-Object -Skip 2 | Set-Content -Encoding utf8 $body
gh issue edit <N> --repo chetwerikoff/orchestrator-pack --body-file $body
```

Bash equivalent:

```bash
body="$(mktemp)"
tail -n +3 docs/issues_drafts/NN-<slug>.md > "$body"
gh issue edit <N> --repo chetwerikoff/orchestrator-pack --body-file "$body"
rm -f "$body"
```

For new issues: `gh issue create ... --body-file $body --title "<title>"`.

## Publish to main (required by default)

After sync, the draft must not stay uncommitted on disk. Unless the user opts out
(«только драфт», «без PR», «не мержи»), immediately invoke
[`publish-issue-draft`](../publish-issue-draft/SKILL.md):

1. Declaration snapshot + commit draft, index, and `docs/declarations/<N>.architect-draft-NN.json`.
2. Open PR (`docs: draft NN — … (#N spec)`).
3. Merge when CI is green (and manual Codex review if the user expects it).
4. `git pull` on `main`; **reopen** issue **#N** if GitHub auto-closed it on merge.

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

## Don't (draft Codex review)

- Use `codex exec` or `codex exec review` for draft review — those are worker/PR paths.
- Pipe `codex review` through `tail`, `head`, or `grep` (hides in-progress output).
- Kill a running draft review to rush `gh issue create` — wait for `NO_FINDINGS` or cap.
- Sync to GitHub before Codex review completes (unless 5-iteration cap with open questions recorded).
