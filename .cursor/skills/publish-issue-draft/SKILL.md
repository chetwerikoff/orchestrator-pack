---
name: publish-issue-draft
description: >-
  LEGACY DRAFTS ONLY (operator decision 2026-07-23): persistence workflow for
  the pre-existing draft files in docs/issues_drafts/** — edits, batches,
  re-syncs of historical specs. New GPT-authored tasks are mirrorless
  (create-issue-draft produces no local draft file and never chains here —
  there is nothing to persist). DEFAULT is sync-only: the GitHub Issue is the
  queue; a legacy draft file stays local and is NOT committed or PR'd. Only
  open a PR to the selected default branch on explicit request (batch a series, or full publish of
  one legacy draft). Use when the user asks to publish, commit, batch, or
  ship a legacy draft.
---

# Publish issue draft

> **Legacy-drafts only (operator decision 2026-07-23).** New GPT-authored
> tasks are **mirrorless**: `create-issue-draft` produces no local draft file
> and no queue-index row — there is nothing for this skill to persist. Invoke
> this skill only for the pre-existing legacy drafts in
> `docs/issues_drafts/**` (edits, batches, re-syncs of historical specs).

The GitHub **Issue** is the live queue and the source of truth a worker reads
(worker execution, scope guard, and planner all read the issue body). Landing the local
draft *file* in the selected default branch is a separate, optional act of repo snapshotting.

This skill picks **how** a draft is persisted after `create-issue-draft`:

| Mode | Issue owner | Draft file PR'd to the selected default branch | Snapshot + CI | When |
|------|-------------|-------------------------|---------------|------|
| **sync-only** (default) | `create-issue-draft` | **no** | no | normal tasks; Issue body is the live spec |
| **batch** | `create-issue-draft` separately | one PR for several drafts | one run | epics + related Issues, multi-draft waves, index refresh |
| **full-publish** | `create-issue-draft` separately | one PR for this draft | yes | user requests snapshot publication |

Codex review is **unchanged**: draft-quality review happens in
`create-issue-draft` (before sync); for any PR opened here, an optional manual
Codex pass runs per [`direct-fix-checklist`](../direct-fix-checklist/SKILL.md).

**Entrypoint compatibility:** this is the canonical publish/update workflow for
Claude, Codex, Cursor, and Hermes. The path lives under `.claude/` for historical
reasons; non-Claude agents that are routed here by `AGENTS.md` must still read
and execute this file in full. Do not invent Codex- or Hermes-specific publish
mechanics. In Modes B/C, they use the same OpenCode/deepseek delegation below
unless the fallback conditions in this skill apply.

**Prerequisite:** [`create-issue-draft`](../create-issue-draft/SKILL.md) completed:

- Draft at `docs/issues_drafts/NN-<slug>.md` with `GitHub Issue: #N` (not TBD).
- Codex draft review done (`NO_FINDINGS` or 5-iteration cap with open questions recorded).
- Issue authoring, review, body edits, and acceptance are owned by the current [`create-issue-draft`](../create-issue-draft/SKILL.md) workflow. Complete that workflow and read back the published Issue before treating its revision as current. This legacy persistence skill does not create, edit, or verify Issue bodies.
- Registry row for this draft defined (draft path → issue **N**); Cursor lands it in
  `docs/issue_queue_index.md` at publish — the architect does not hand-edit the tracked
  file (see Common steps).

---

## Mode A — sync-only (DEFAULT)

Use unless the user explicitly asks for a PR/merge or batch. The draft is a
working artifact; the issue carries everything the worker needs.

1. Run the contract-evidence mechanical guard (Issue #366) on the draft; refuse
   repository snapshot publication while it exits non-zero:

   ```bash
   node scripts/draft-discipline.mjs contract-evidence --draft docs/issues_drafts/NN-<slug>.md
   ```

2. If the Issue needs creation, revision, review, or acceptance, use the current
   [`create-issue-draft`](../create-issue-draft/SKILL.md) owner. This skill does
   not perform Issue-body sync or parity checks.
3. Confirm the draft header records `GitHub Issue: #N` and that its Issue is
   current under the create-issue-draft workflow.
4. Confirm the registry row for this draft is defined (draft path → **N**); it will be
   written to `docs/issue_queue_index.md` by Cursor at publish, not by the architect.
5. **Stop.** Do not open a PR, do not run `pack-declare`, do not run scope checks.
6. Report to the user:
   - Issue URL and number **N** (open for worker execution).
   - "Draft kept local — not committed. Say *batch* or *publish this draft* to land it in the selected default branch."

**Accepted risk:** the selected default branch will lag the local draft. If a *future* draft's
prerequisites reference this draft by its `docs/issues_drafts/...` path on
the selected default branch, that path won't resolve until a batch/full publish runs. Mitigate by
keeping the full spec in the issue body and a self-reference (draft path) inside it.

## Mode B — batch publish

Use when several related drafts have accumulated (epic + children, an
architecture wave) or the registry needs to land. One PR, one CI run, one merge
for the whole set.

1. Pre-flight + branch from the selected default branch (see Common steps).
2. Stage all drafts plus **only each published draft's registry row** in
   `docs/issue_queue_index.md` (selective staging — see Common steps; other drafts'
   pending index rows stay in the working tree uncommitted), and
   `docs/issues_drafts/00-architecture-decisions.md` when changed.
3. One commit, one PR covering the set (spec-only body template below), one CI run, one merge.

Prefer batch over N single-draft PRs whenever drafts are related.

## Mode C — full-publish (single draft, on request)

Use when the user explicitly says "commit / merge this draft", the spec must be
in the selected default branch before implementation, or there's an audit/compliance reason. This is
the full heavy flow. Run the Common steps end-to-end for the one draft.

---

## Common steps (Modes B and C only)

> **Self-delegation guard — am I already inside OpenCode?** The `opencode run`
> delegation below is **only** for an architect surface (Claude Code, Cursor CLI)
> handing the GitHub work to a fresh deepseek session. **If you are yourself
> running inside an OpenCode session** (for example the `opk-orchestrator` worktree
> or another session already launched by the operator), do NOT call `opencode run`
> again — that spawns a nested OpenCode. Determine this from the current invocation
> context rather than a runtime-specific environment variable. Instead run the
> publish mechanics (branch, commit, push, PR, merge, issue create/re-sync) yourself,
> directly, using the manual `gh`/git commands in the steps below as your
> **primary** path.
>
> Direct `gh pr merge` / `gh pr create` / `gh issue create` is blocked by the RTK
> hook. Run it with the **`OPK_PUBLISH_FALLBACK=1`** prefix — you are already the
> executing agent, so the fallback is the correct path. If a PR head is behind
> base (`not mergeable: head … not up to date`), run `gh pr update-branch <N>`
> first, then re-run the merge.

**Publication procedure:** this skill owns only repository snapshot branch/PR
publication. Issue creation, Issue-body edits, review, and acceptance remain
owned by [`create-issue-draft`](../create-issue-draft/SKILL.md). Do not use a
retired Issue-body synchronization command.
**Delegation prompt** (fill the `<…>` placeholders; covers single draft and batch):

```bash
PROMPT_FILE="$(mktemp)"
cat > "$PROMPT_FILE" <<'EOF'
You are publishing already-reviewed architect docs for orchestrator-pack from an
isolated scratch checkout. The helper preloaded only the files listed below from
the architect's live working tree. Do NOT edit the drafts' content — they passed
Codex review. Do NOT run git commands in any other checkout.

Files to publish (already on disk): <list every touched path: docs/issues_drafts/NN-*.md,
  docs/issues_drafts/00-architecture-decisions.md if changed>.
Registry rows to land (one per published draft): <for each draft, the exact index line,
  e.g. "| docs/issues_drafts/NN-<slug>.md | #N |" — derive from the draft or from this list>.
Issues that require creation or body changes are handled separately through
the current `create-issue-draft` owner; this repository-snapshot workflow does not sync them.

Index ownership: the delegated agent owns docs/issue_queue_index.md during publish. Add
each new registry row (from the draft or from the row text above) and stage ONLY that
row's hunk — never wholesale-stage or reset the file. The architect does NOT pre-edit,
post-edit, or restore the index by hand.

Steps:
0. For each draft file listed above, run the contract-evidence guard (Issue #366;
   plus positive-outcome / parked-root when the draft declares those blocks). Exit
   non-zero => STOP; do not sync, commit, or publish:
   node scripts/draft-discipline.mjs contract-evidence --draft <draft path>
1. In this isolated checkout only: git fetch origin; update the local selected-default-branch base
   (git checkout "$TARGET_DEFAULT_BRANCH" && git pull origin "$TARGET_DEFAULT_BRANCH"), then create the publish branch:
   git checkout -b architect/draft-<NN>-<slug>.
2. Stage ONLY the listed draft files (and 00-architecture-decisions.md if applicable).
   For docs/issue_queue_index.md: add or update ONLY each published draft's registry row,
   then stage selectively — e.g. git add -p docs/issue_queue_index.md (accept only the
   new-row hunk), or git apply --cached with a one-line patch. Other unpublished drafts'
   pending index rows MUST stay in the working tree and MUST NOT be committed. FORBIDDEN:
   git checkout HEAD -- docs/issue_queue_index.md (or any wholesale reset) — that destroys
   other drafts' pending rows. Run `node --experimental-strip-types scripts/verify.ts --repo-root .` and
   `node --experimental-strip-types scripts/verify.ts --repo-root . --reusable-only`. Do not change draft content — if a gate fails
   on the drafts, STOP and report instead of editing.
3. Commit ("docs: <short title> (spec)") and push -u origin HEAD. If push is refused on
   credentials, retry: git -c credential.helper='!/usr/bin/gh auth git-credential' push -u origin HEAD
4. Open a spec-only PR with "<!-- pr-type: spec-only -->" in the body. These docs PRs route
   the no-ceremony / docs-only path: the scope guard FAILS on any issue reference, so the PR
   body MUST contain ZERO "Refs #N", bare "#N", or issue URLs — summarise the change instead.
5. Wait for CI green (gh pr checks <pr> --watch). Then gh pr merge <pr> --merge --delete-branch.
   If you refresh after merge, do it only in this isolated checkout (git checkout main &&
   git pull origin main); never touch the architect's live checkout.
6. If an Issue needs creation or a body change, handle it through the current
   [`create-issue-draft`](../create-issue-draft/SKILL.md) workflow. Do not use
   the retired publisher, raw `gh issue create` / `gh issue edit`, or low-level
   `gh api` for Issue-body mutation.
7. Report the PR URL and merge commit; refer Issue creation/body changes to the current owner.
EOF
# Issue creation and body changes are owned by ../create-issue-draft/SKILL.md.
```

**Verify state after the run — `opencode run` can exit 0 mid-failure.** A
connection drop or context exhaustion can leave `opencode run` reporting exit 0
while the repository snapshot publish is half-done (e.g. PR not opened or index
row left uncommitted). Do **not** trust the exit code alone: confirm the PR and
`git status` before reporting success, and complete any missing repository step
via the fallback below.

If a repository snapshot amends a draft for an already-closed Issue, the
create-issue-draft owner handles any required live Issue revision; this skill
does not resync Issue bodies.

### Pre-flight

```bash
git status -sb
git fetch origin
```

Fallback/manual branch work must happen in a separate checkout (not the architect's
live working tree): update that checkout's selected default branch from origin, then create
`architect/draft-NN-<slug>` there (or stay on a clean branch already cut for this
draft). Record implementation issue number **N** from the draft header.

### Files in the publish commit

Include **only** what the draft session touched:

- `docs/issues_drafts/NN-<slug>.md`
- **Only this draft's registry row** in `docs/issue_queue_index.md` (the delegated agent adds/updates the
  row and stages it selectively — see Index ownership below; other drafts' pending rows stay
  uncommitted in the working tree)
- `docs/issues_drafts/00-architecture-decisions.md` (if decision log updated)
- `.claude/skills/**` or `.cursor/skills/**` only when the draft itself required skill changes

Do **not** bundle unrelated local edits (other skills, machine-local runtime config, WIP code).

**Index ownership (delegated agent during publish):** `docs/issue_queue_index.md` is owned by
the delegated agent (deepseek via opencode run) for the publish commit. The agent derives
each new row from the draft (or from row text in the delegation prompt), writes it into the
working tree, and stages **only** that row's hunk. The architect does **not** pre-edit,
post-edit, or restore `docs/issue_queue_index.md` by hand. **Forbidden scoping shortcuts:**
`git add docs/issue_queue_index.md` (wholesale) and `git checkout HEAD --
docs/issue_queue_index.md` (or any reset-to-HEAD) — both drop other drafts' pending rows.

Spec-only docs PRs use the **spec-only scope-guard path** (no declaration
snapshot, no `Closes #N`, no reopen step). See
[`docs/repository_policy.md`](../../../docs/repository_policy.md#spec-only-docs-prs).

### Local checks

```bash
node --experimental-strip-types scripts/verify.ts --repo-root .
node --experimental-strip-types scripts/verify.ts --repo-root . --reusable-only
npm run typecheck:foundation
```

**Contract-evidence gate (Issue #366).** Run on **every** draft in the publish
commit (Modes B and C) before a spec PR commit. Issue creation, body edits,
review, and acceptance are owned by [`create-issue-draft`](../create-issue-draft/SKILL.md);
this persistence workflow does not publish or verify Issue bodies.

```bash
node scripts/draft-discipline.mjs contract-evidence --draft docs/issues_drafts/NN-<slug>.md
```

Refuse snapshot publication while this exits non-zero.

For each draft in the publish commit that declares `behavior-kind` or
`parked-root-cause` (parked root tracking), run the mechanical guards (Issue #221) before push:

```bash
node scripts/draft-discipline.mjs positive-outcome --draft docs/issues_drafts/NN-<slug>.md
node scripts/draft-discipline.mjs parked-root --draft docs/issues_drafts/NN-<slug>.md
```

Reviewer findings and author dispositions follow the current Issue-comment
contract in [`create-issue-draft`](../create-issue-draft/SKILL.md#author-rounds-substantive-floor-and-acceptance);
this persistence workflow does not use a separate finding-ledger guard.
When a `parked-root-cause` block references `#N`, validate the live Issue
through the current `create-issue-draft` owner before relying on the body.

Fix `[STRICT]` findings before push.

### Commit and push

```bash
git add docs/issues_drafts/NN-<slug>.md
# plus 00-architecture-decisions.md if applicable
# Index row — selective staging ONLY (never wholesale git add on the index):
#   git add -p docs/issue_queue_index.md   # accept only this draft's new-row hunk
# or: echo '<one-line row patch>' | git apply --cached
# FORBIDDEN: git checkout HEAD -- docs/issue_queue_index.md
git commit -m "docs: draft NN — <short title> (#N spec)"
git push -u origin HEAD
```

### Open PR

Body template (replace placeholders). Use the **spec-only signal**. These docs
PRs route the **no-ceremony / docs-only** path, where the scope guard **fails on
any issue reference** — so the body carries **zero** `Refs #N`, bare `#N`, or
issue URLs. Name the affected drafts/issues in prose instead; GitHub keeps the
issues untouched because nothing closes or references them:

```markdown
<!-- pr-type: spec-only -->

## Summary

- Add/amend canonical draft `docs/issues_drafts/NN-<slug>.md`.
- Update `docs/issue_queue_index.md` (and `00-architecture-decisions.md` if changed).

**Spec only** — does not implement the spec.

## Test plan

- [x] Docs-only under spec-docs allowlist (`docs/issues_drafts/**`, `docs/issue_queue_index.md`, …)
- [x] `node --experimental-strip-types scripts/verify.ts --repo-root .`
- [x] `node --experimental-strip-types scripts/verify.ts --repo-root . --reusable-only`
- [x] `npm run typecheck:foundation` (CI)
- [ ] CI: scope guard + self-architect lint
```

For a **batch** PR, summarise each draft in the bullet list — still **no** issue
references in the body (the no-ceremony scope guard rejects them). If a CI run
fails because a reference slipped in, strip it and `gh run rerun --failed`.

```bash
gh pr create --repo $TARGET_REPOSITORY \
  --title "docs: draft NN — <short title> (#N spec)" \
  --body-file "${TMPDIR:-/tmp}/publish-draft-pr-body.md"
```

### Review and merge

Architect PRs do not get automatic pack review. Either wait for CI green then merge,
or run manual pack review per [`direct-fix-checklist`](../direct-fix-checklist/SKILL.md)
if the user expects a Codex pass before merge.

When the user asked to merge, follow
[`merge-with-local-adoption`](../merge-with-local-adoption/SKILL.md): Cursor
merges, pulls the selected default branch in the live checkout when needed, and applies operator
adoption. Adoption is usually **none** for docs-only drafts unless the draft
changed `.example` or runbooks.

### Report

Tell the user: PR URL, merge commit, draft path(s) on the selected default branch, and the synced/created
issue number(s). The PR body carried no issue reference, so GitHub never auto-closed
anything — if a closed issue's spec materially changed, flag that it may need reopening
for re-implementation (architect + user decide).

## Operator adoption

Docs-only draft publishes normally need **no** local operator steps. If a draft
touched an operator runtime configuration example, run the adoption scan from
`merge-with-local-adoption` even when merging a spec PR.

## Do not

- Sync or publish while `contract-evidence` exits non-zero (Issue #366).
- Run publish mechanics directly by default — delegate to `opencode run
  --dangerously-skip-permissions --dir .` first; use `OPK_PUBLISH_FALLBACK=1`
  only as fallback (opencode unavailable or half-done).
- Hand-edit, wholesale-stage, or reset `docs/issue_queue_index.md` — selective
  single-row staging only (see Index ownership), whoever runs the publish.
- Put any issue reference (`Refs #N`, bare `#N`, issue URL) in a spec-only PR body —
  the no-ceremony scope guard rejects it.
- Open a PR in sync-only mode — that is the whole point of the default.
- Merge with failing scope guard or self-architect `-Strict`.
- Use `gh pr merge --admin` to skip checks unless the user explicitly requests it.
- Commit secrets or machine-local runtime config.
