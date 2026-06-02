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
- Codex draft review done (`NO_FINDINGS` or 3-iteration cap with open questions recorded).
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
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/lint-self-architect.ps1 -WithWorkingTree
.\scripts\verify.ps1
.\scripts\check-reusable.ps1
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

Body template (replace placeholders). Use the **spec-only signal** and a
**non-closing** issue reference so GitHub keeps #N open:

```markdown
<!-- pr-type: spec-only -->

Refs #N

## Summary

- Add canonical draft `docs/issues_drafts/NN-<slug>.md` (GitHub #N).
- Update `docs/issue_queue_index.md`.

**Spec only** — does not implement #N.

## Test plan

- [x] Docs-only under spec-docs allowlist (`docs/issues_drafts/**`, `docs/issue_queue_index.md`, …)
- [x] `.\scripts\verify.ps1`
- [x] `.\scripts\check-reusable.ps1`
- [x] `.\scripts\lint-self-architect.ps1 -Strict` (CI)
- [ ] CI: scope guard + self-architect lint
```

For a **batch** PR, list every implementation issue: `Refs #N1`, `Refs #N2`, …
on separate lines (scope guard uses the last non-closing reference).

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

Tell the user: PR URL, merge commit, draft path on `main`, and that issue **#N**
(each `#N` for batch) remains **open** for `ao spawn` (non-closing `Refs #N` —
no reopen step).

## Operator adoption

Docs-only draft publishes normally need **no** local operator steps. If a draft
touched `agent-orchestrator.yaml.example`, run the adoption scan from
`merge-with-local-adoption` even when merging a spec PR.

## Do not

- Open a PR in sync-only mode — that is the whole point of the default.
- Merge with failing scope guard or self-architect `-Strict`.
- Use `gh pr merge --admin` to skip checks unless the user explicitly requests it.
- Commit secrets or `agent-orchestrator.yaml` (gitignored).
