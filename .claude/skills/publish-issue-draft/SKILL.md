---
name: publish-issue-draft
description: >-
  After create-issue-draft finishes (Codex draft review done, GitHub issue
  synced), decide how the local draft is persisted. DEFAULT is sync-only: the
  GitHub Issue is the queue; the draft file stays local and is NOT committed or
  PR'd. Only open a PR to main on explicit request (batch a series, or full
  publish of one draft). Use when the user asks to publish, commit, batch, or
  ship a draft. Chains from create-issue-draft.
---

# Publish issue draft

The GitHub **Issue** is the live queue and the source of truth a worker reads
(`ao spawn`, scope guard, planner all read the issue body). Landing the local
draft *file* in `main` is a separate, optional act of repo snapshotting.

This skill picks **how** a draft is persisted after `create-issue-draft`:

| Mode | Issue synced | Draft file PR'd to main | Snapshot + CI | When |
|------|--------------|-------------------------|---------------|------|
| **sync-only** (default) | yes | **no** | no | normal impl tasks; issue body is the full spec |
| **batch** | yes | one PR for several drafts | one run | epic+children, arch waves, registry refresh |
| **full-publish** | yes | one PR for this draft | yes | user says "commit/merge this draft"; spec must live in main before impl; audit |

Codex review is **unchanged**: draft-quality review happens in
`create-issue-draft` (before sync); for any PR opened here, an optional manual
Codex pass runs per [`direct-fix-checklist`](../direct-fix-checklist/SKILL.md).

**Prerequisite:** [`create-issue-draft`](../create-issue-draft/SKILL.md) completed:

- Draft at `docs/issues_drafts/NN-<slug>.md` with `GitHub Issue: #N` (not TBD).
- Codex draft review done (`NO_FINDINGS` or 5-iteration cap with open questions recorded).
- `gh issue create` / `gh issue edit` synced the body.
- `docs/issue_queue_index.md` row updated **locally**.

---

## Mode A — sync-only (DEFAULT)

Use unless the user explicitly asks for a PR/merge or batch. The draft is a
working artifact; the issue carries everything the worker needs.

1. Confirm the issue body matches the local draft (re-`gh issue edit` if the
   draft changed after the last sync).
2. Confirm the draft header records `GitHub Issue: #N`.
3. Ensure the local `docs/issue_queue_index.md` row exists (local edit only — not committed).
4. **Stop.** Do not open a PR, do not run `ao-declare`, do not run scope checks.
5. Report to the user:
   - Issue URL and number **N** (open for `ao spawn`).
   - "Draft kept local — not committed. Say *batch* or *publish this draft* to land it in `main`."

**Accepted risk:** `main` will lag the local draft. If a *future* draft's
prerequisites reference this draft by its `docs/issues_drafts/...` path on
`main`, that path won't resolve until a batch/full publish runs. Mitigate by
keeping the full spec in the issue body and a self-reference (draft path) inside it.

## Mode B — batch publish

Use when several related drafts have accumulated (epic + children, an
architecture wave) or the registry needs to land. One PR, one CI run, one merge
for the whole set.

1. Pre-flight + branch from `main` (see Common steps).
2. Stage all drafts + one `docs/issue_queue_index.md` update (plus
   `docs/issues_drafts/00-architecture-decisions.md` when changed).
3. One commit, one PR covering the set (spec-only body template below), one CI run, one merge.

Prefer batch over N single-draft PRs whenever drafts are related.

## Mode C — full-publish (single draft, on request)

Use when the user explicitly says "commit / merge this draft", the spec must be
in `main` before implementation, or there's an audit/compliance reason. This is
the full heavy flow. Run the Common steps end-to-end for the one draft.

---

## Common steps (Modes B and C only)

> **Publication runs through Cursor by default (every mode, single or batch).**
> The architect does **not** run the publish mechanics (branch, commit, push, PR,
> merge, issue create/re-sync) by hand when `cursor-agent` is on `PATH`. Delegate
> the whole publish to **one** `cursor-agent -p --force` call in the architect
> working tree (workspace defaults to the current directory — do **not** pass
> `-w`/`--worktree`) so it acts on the drafts exactly as they sit on disk. The
> manual PowerShell/`gh` commands in the steps below are the **fallback** — use
> them only when `cursor-agent` is missing, errors out, or leaves the PR/issues
> half-done, and tell the user Cursor was unavailable.

**Delegation prompt** (fill the `<…>` placeholders; covers single draft and batch):

```bash
cursor-agent -p --force "$(cat <<'EOF'
You are publishing already-reviewed architect docs for orchestrator-pack from the
current working tree. Do NOT edit the drafts' content — they passed Codex review.

Files to publish (already on disk): <list every touched path: docs/issues_drafts/NN-*.md,
  docs/issue_queue_index.md, docs/issues_drafts/00-architecture-decisions.md if changed>.
Issues to handle after merge: <for each, "#N <- draft path" to re-sync an existing issue
  body, or "new <- draft path" to create one>.

Steps:
1. git fetch origin; branch from main: git checkout main && git pull origin main &&
   git checkout -b architect/draft-<NN>-<slug>.
2. Stage ONLY the listed files. Run scripts/verify.ps1, scripts/check-reusable.ps1, and
   scripts/lint-self-architect.ps1 -Strict. Do not change draft content — if a gate fails
   on the drafts, STOP and report instead of editing.
3. Commit ("docs: <short title> (spec)") and push -u origin HEAD. If push is refused on
   credentials, retry: git -c credential.helper='!/usr/bin/gh auth git-credential' push -u origin HEAD
4. Open a spec-only PR with "<!-- pr-type: spec-only -->" in the body. These docs PRs route
   the no-ceremony / docs-only path: the scope guard FAILS on any issue reference, so the PR
   body MUST contain ZERO "Refs #N", bare "#N", or issue URLs — summarise the change instead.
5. Wait for CI green (gh pr checks <pr> --watch). Then gh pr merge <pr> --merge --delete-branch;
   git checkout main && git pull origin main.
6. For each "#N <- draft": re-sync the existing issue body (body = draft minus the H1 line,
   i.e. tail -n +3) with gh issue edit <N> --body-file <tmp>. For each "new <- draft":
   gh issue create with title = the draft H1 and body = draft minus H1, then write the
   returned number into the draft's "GitHub Issue: #N" line and docs/issue_queue_index.md.
7. Report the PR URL, the merge commit, and each issue number/URL synced or created.
EOF
)"
```

If the published change is an **amendment to an already-closed issue** whose spec
materially changed, note in your report that the issue may need reopening for
re-implementation — the architect decides that with the user; Cursor only re-syncs
the body.

### Pre-flight

```powershell
git status -sb
git fetch origin
```

Branch from current `main`: `git checkout main` → `git pull origin main` →
`git checkout -b architect/draft-NN-<slug>` (or stay on a clean branch already
cut for this draft). Record implementation issue number **N** from the draft header.

### Files in the publish commit

Include **only** what the draft session touched:

- `docs/issues_drafts/NN-<slug>.md`
- `docs/issue_queue_index.md`
- `docs/issues_drafts/00-architecture-decisions.md` (if decision log updated)
- `.claude/skills/**` or `.cursor/skills/**` only when the draft itself required skill changes

Do **not** bundle unrelated local edits (other skills, `agent-orchestrator.yaml`, WIP code).

Spec-only docs PRs use the **spec-only scope-guard path** (no declaration
snapshot, no `Closes #N`, no reopen step). See
[`docs/repository_policy.md`](../../../docs/repository_policy.md#spec-only-docs-prs).

### Local checks

```powershell
pwsh -NoProfile -File scripts/lint-self-architect.ps1 -WithWorkingTree
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
```

Fix `[STRICT]` findings before push.

### Commit and push

```powershell
git add docs/issues_drafts/NN-<slug>.md docs/issue_queue_index.md
# plus 00-architecture-decisions.md if applicable
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
- [x] `.\scripts\verify.ps1`
- [x] `.\scripts\check-reusable.ps1`
- [x] `.\scripts\lint-self-architect.ps1 -Strict` (CI)
- [ ] CI: scope guard + self-architect lint
```

For a **batch** PR, summarise each draft in the bullet list — still **no** issue
references in the body (the no-ceremony scope guard rejects them). If a CI run
fails because a reference slipped in, strip it and `gh run rerun --failed`.

```powershell
gh pr create --repo chetwerikoff/orchestrator-pack `
  --title "docs: draft NN — <short title> (#N spec)" `
  --body-file $env:TEMP\publish-draft-pr-body.md
```

### Review and merge

Architect PRs do not get AO auto-review. Either wait for CI green then merge, or
run manual pack review per [`direct-fix-checklist`](../direct-fix-checklist/SKILL.md)
if the user expects a Codex pass before merge.

When the user asked to merge, follow
[`merge-with-local-adoption`](../merge-with-local-adoption/SKILL.md): adoption is
usually **none** for docs-only drafts unless the draft changed `.example` or runbooks.

```powershell
gh pr checks <pr> --repo chetwerikoff/orchestrator-pack
gh pr merge <pr> --repo chetwerikoff/orchestrator-pack --merge --delete-branch
git checkout main
git pull origin main
```

### Report

Tell the user: PR URL, merge commit, draft path(s) on `main`, and the synced/created
issue number(s). The PR body carried no issue reference, so GitHub never auto-closed
anything — if a closed issue's spec materially changed, flag that it may need reopening
for re-implementation (architect + user decide).

## Operator adoption

Docs-only draft publishes normally need **no** local operator steps. If a draft
touched `agent-orchestrator.yaml.example`, run the adoption scan from
`merge-with-local-adoption` even when merging a spec PR.

## Do not

- Run the publish git/`gh` mechanics by hand when `cursor-agent` is available —
  delegate to Cursor first; the manual commands are the fallback only.
- Put any issue reference (`Refs #N`, bare `#N`, issue URL) in a spec-only PR body —
  the no-ceremony scope guard rejects it.
- Open a PR in sync-only mode — that is the whole point of the default.
- Merge with failing scope guard or self-architect `-Strict`.
- Use `gh pr merge --admin` to skip checks unless the user explicitly requests it.
- Commit secrets or `agent-orchestrator.yaml` (gitignored).
