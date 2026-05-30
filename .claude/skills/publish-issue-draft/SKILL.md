---
name: publish-issue-draft
description: >-
  After create-issue-draft finishes (Codex NO_FINDINGS, GitHub issue synced),
  commit draft files, open a PR, and merge to main. Use when the user asks to
  publish or ship an issue draft, commit the draft, open a PR for the draft, or
  says the draft should not stay uncommitted — including right after creating a
  draft and issue. Chains from create-issue-draft; skip if the user says not to
  merge or only wants the local draft.
---

# Publish issue draft to main

Land **spec-only** changes (draft markdown, registry, architecture decision log)
so `main` matches the GitHub Issue the worker will implement. This is **not**
implementation — do not close the queue item permanently.

**Prerequisite:** [`create-issue-draft`](../create-issue-draft/SKILL.md) completed:

- Draft at `docs/issues_drafts/NN-<slug>.md` with `GitHub Issue: #N` (not TBD).
- Codex draft review returned `NO_FINDINGS` (or 3-iteration cap with open questions recorded).
- `gh issue create` / `gh issue edit` synced the body.
- `docs/issue_queue_index.md` row updated.

## When to invoke

- Immediately after `create-issue-draft` unless the user opts out.
- User: «опубликуй драфт», «закоммить драфт», «pr для драфта», «publish draft», «смержи драфт».

**Skip:** user wants draft/issue only locally; implementation PR already in flight; unrelated git work on the branch.

## Files in the publish commit

Include **only** what the draft session touched:

- `docs/issues_drafts/NN-<slug>.md`
- `docs/issue_queue_index.md`
- `docs/issues_drafts/00-architecture-decisions.md` (if decision log updated)
- `docs/declarations/<N>.architect-draft-<slug>.json` (declaration snapshot — required for scope guard)
- `.claude/skills/**` or `.cursor/skills/**` only when the draft itself required skill changes

Do **not** bundle unrelated local edits (other skills, `agent-orchestrator.yaml`, WIP code).

## Workflow

### 1. Pre-flight

```powershell
git status -sb
git fetch origin
```

- Branch from current `main`: `git checkout main` → `git pull origin main` →
  `git checkout -b architect/draft-NN-<slug>` (or stay on a clean branch already cut for this draft).
- Record implementation issue number **N** from the draft header.

### 2. Declaration snapshot (scope guard)

Commit a snapshot **before** or with the docs commit. Use the **implementation** issue number **N**.

```powershell
$env:AO_ISSUE_NUMBER = '<N>'
$env:AO_SESSION_ID = 'architect-draft-NN'   # stable label; not op-<N>
npx ao-declare --issue <N> `
  --declared-paths docs/issues_drafts/NN-<slug>.md,docs/issue_queue_index.md `
  --iteration-id architect-draft-NN `
  --actor architect-draft-NN `
  --repo-root .
```

Add `docs/issues_drafts/00-architecture-decisions.md` to `--declared-paths` when it changed.
Add `docs/declarations/**` to `--declared-globs` if the declare tool accepts amending snapshot paths in a follow-up `--amend`.

If `ao-declare` fails issue-constraint validation, widen the **draft's** `allowed-roots` in the issue body (via `gh issue edit`) so `docs/issues_drafts/**` and `docs/issue_queue_index.md` are allowed, then re-declare — do not bypass scope guard.

### 3. Local checks

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/lint-self-architect.ps1 -WithWorkingTree
.\scripts\verify.ps1
.\scripts\check-reusable.ps1
```

Fix `[STRICT]` findings before push.

### 4. Commit and push

```powershell
git add docs/issues_drafts/NN-<slug>.md docs/issue_queue_index.md docs/declarations/<N>.architect-draft-NN.json
# plus 00-architecture-decisions.md if applicable
git commit -m "docs: draft NN — <short title> (#N spec)"
git push -u origin HEAD
```

### 5. Open PR

Body template (replace placeholders):

```markdown
Closes #N

## Summary

- Add canonical draft `docs/issues_drafts/NN-<slug>.md` (GitHub #N).
- Update `docs/issue_queue_index.md`.
- Declaration snapshot `docs/declarations/N.architect-draft-NN.json`.

**Spec only** — does not implement #N. If GitHub auto-closes #N on merge, reopen the issue immediately (step 7).

Refs #N

## Test plan

- [x] Docs-only under `docs/`
- [x] `.\scripts\verify.ps1`
- [x] `.\scripts\check-reusable.ps1`
- [x] `.\scripts\lint-self-architect.ps1 -Strict` (CI)
- [ ] CI: scope guard + self-architect lint
```

```powershell
gh pr create --repo chetwerikoff/orchestrator-pack `
  --title "docs: draft NN — <short title> (#N spec)" `
  --body-file $env:TEMP\publish-draft-pr-body.md
```

`Closes #N` is required for scope guard (same **N** as the snapshot `issue_number`). The summary must state spec-only.

### 6. Review and merge

Architect PRs do not get AO auto-review. Either:

- Wait for CI green, then merge; or
- Run manual pack review per [`direct-fix-checklist`](../direct-fix-checklist/SKILL.md) if the user expects Codex pass before merge.

When the user asked to merge (e.g. «смерж» after publish), follow [`merge-with-local-adoption`](../merge-with-local-adoption/SKILL.md): adoption is usually **none** for docs-only drafts unless the draft changed `.example` or runbooks.

```powershell
gh pr checks <pr> --repo chetwerikoff/orchestrator-pack
gh pr merge <pr> --repo chetwerikoff/orchestrator-pack --merge --delete-branch
git checkout main
git pull origin main
```

### 7. Reopen implementation issue if auto-closed

```powershell
$state = gh issue view <N> --repo chetwerikoff/orchestrator-pack --json state --jq .state
if ($state -eq 'CLOSED') {
  gh issue reopen <N> --repo chetwerikoff/orchestrator-pack `
    --comment "Reopened: spec merged to main in PR #<pr>; implementation still open."
}
```

### 8. Report

Tell the user: PR URL, merge commit, draft path on `main`, and that issue **#N** remains **open** for `ao spawn`.

## Operator adoption

Docs-only draft publishes normally need **no** local operator steps. If the draft touched `agent-orchestrator.yaml.example`, run the adoption scan from `merge-with-local-adoption` even when merging a spec PR.

## Do not

- Merge with failing scope guard or self-architect `-Strict`.
- Use `gh pr merge --admin` to skip checks unless the user explicitly requests it.
- Leave the draft only on disk after issue sync without publishing (default is to publish).
- Commit secrets or `agent-orchestrator.yaml` (gitignored).
