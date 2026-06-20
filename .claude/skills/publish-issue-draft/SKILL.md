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

**Entrypoint compatibility:** this is the canonical publish/update workflow for
Claude, Codex, Cursor, and Hermes. The path lives under `.claude/` for historical
reasons; non-Claude agents that are routed here by `AGENTS.md` must still read
and execute this file in full. Do not invent Codex- or Hermes-specific publish
mechanics. In Modes B/C, they use the same OpenCode/deepseek delegation below
unless the fallback conditions in this skill apply.

**Prerequisite:** [`create-issue-draft`](../create-issue-draft/SKILL.md) completed:

- Draft at `docs/issues_drafts/NN-<slug>.md` with `GitHub Issue: #N` (not TBD).
- Codex draft review done (`NO_FINDINGS` or 5-iteration cap with open questions recorded).
- `gh issue create` / `gh issue edit` synced the body.
- Registry row for this draft defined (draft path → issue **N**); Cursor lands it in
  `docs/issue_queue_index.md` at publish — the architect does not hand-edit the tracked
  file (see Common steps).

---

## Mode A — sync-only (DEFAULT)

Use unless the user explicitly asks for a PR/merge or batch. The draft is a
working artifact; the issue carries everything the worker needs.

1. Run the contract-evidence mechanical guard (Issue #366) on the draft; refuse
   issue sync while it exits non-zero:

   ```powershell
   pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/NN-<slug>.md
   ```

2. Confirm the issue body matches the local draft (re-`gh issue edit` if the
   draft changed after the last sync).
3. Confirm the draft header records `GitHub Issue: #N`.
4. Confirm the registry row for this draft is defined (draft path → **N**); it will be
   written to `docs/issue_queue_index.md` by Cursor at publish, not by the architect.
5. **Stop.** Do not open a PR, do not run `ao-declare`, do not run scope checks.
6. Report to the user:
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
2. Stage all drafts plus **only each published draft's registry row** in
   `docs/issue_queue_index.md` (selective staging — see Common steps; other drafts'
   pending index rows stay in the working tree uncommitted), and
   `docs/issues_drafts/00-architecture-decisions.md` when changed.
3. One commit, one PR covering the set (spec-only body template below), one CI run, one merge.

Prefer batch over N single-draft PRs whenever drafts are related.

## Mode C — full-publish (single draft, on request)

Use when the user explicitly says "commit / merge this draft", the spec must be
in `main` before implementation, or there's an audit/compliance reason. This is
the full heavy flow. Run the Common steps end-to-end for the one draft.

---

## Common steps (Modes B and C only)

> **Self-delegation guard — am I already inside OpenCode?** The `opencode run`
> delegation below is **only** for an architect surface (Claude Code, Cursor CLI)
> handing the GitHub work to a fresh deepseek session. **If you are yourself
> running inside an OpenCode session** (e.g. the `opk-orchestrator` worktree or
> any AO-managed session — check `echo $AO_SESSION_ID`), do NOT call
> `opencode run` — that spawns a nested OpenCode. Instead run the publish
> mechanics (branch, commit, push, PR, merge, issue create/re-sync) yourself,
> directly, using the manual `gh`/git commands in the steps below as your
> **primary** path.
>
> Direct `gh pr merge` / `gh pr create` / `gh issue create` is blocked by the RTK
> hook. Run it with the **`AO_PUBLISH_FALLBACK=1`** prefix — you are already the
> executing agent, so the fallback is the correct path. If a PR head is behind
> base (`not mergeable: head … not up to date`), run `gh pr update-branch <N>`
> first, then re-run the merge.

> **Publication delegates to deepseek via OpenCode by default (every mode, single
> or batch).** The architect hands the publish mechanics to `opencode run` through
> `.claude/skills/publish-issue-draft/opencode-publish.sh`, which creates a
> per-invocation isolated scratch checkout, preloads only the intended draft path(s)
> plus `docs/issue_queue_index.md` from the live tree, rewrites `--dir` to that
> checkout, and tears it down. Direct
> `gh pr create` / `gh pr merge` / `gh issue create` is blocked by the publish
> hook for the architect — use `opencode run` as the delegate so deepseek runs
> those commands. The **direct `AO_PUBLISH_FALLBACK=1`** path (manual
> PowerShell/`gh` steps below) is the **fallback** — use it only when
> `opencode run` is unavailable, errors, or leaves the publish half-done.

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
Issues to handle after merge: <for each, "#N <- draft path" to re-sync an existing issue
  body, or "new <- draft path" to create one>.

Index ownership: the delegated agent owns docs/issue_queue_index.md during publish. Add
each new registry row (from the draft or from the row text above) and stage ONLY that
row's hunk — never wholesale-stage or reset the file. The architect does NOT pre-edit,
post-edit, or restore the index by hand.

Steps:
0. For each draft file listed above, run the contract-evidence guard (Issue #366;
   plus positive-outcome / parked-root when the draft declares those blocks). Exit
   non-zero => STOP; do not sync, commit, or publish:
   pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath <draft path>
1. In this isolated checkout only: git fetch origin; update the local main base
   (git checkout main && git pull origin main), then create the publish branch:
   git checkout -b architect/draft-<NN>-<slug>.
2. Stage ONLY the listed draft files (and 00-architecture-decisions.md if applicable).
   For docs/issue_queue_index.md: add or update ONLY each published draft's registry row,
   then stage selectively — e.g. git add -p docs/issue_queue_index.md (accept only the
   new-row hunk), or git apply --cached with a one-line patch. Other unpublished drafts'
   pending index rows MUST stay in the working tree and MUST NOT be committed. FORBIDDEN:
   git checkout HEAD -- docs/issue_queue_index.md (or any wholesale reset) — that destroys
   other drafts' pending rows. Run scripts/verify.ps1, scripts/check-reusable.ps1, and
   scripts/lint-self-architect.ps1 -Strict. Do not change draft content — if a gate fails
   on the drafts, STOP and report instead of editing.
3. Commit ("docs: <short title> (spec)") and push -u origin HEAD. If push is refused on
   credentials, retry: git -c credential.helper='!/usr/bin/gh auth git-credential' push -u origin HEAD
4. Open a spec-only PR with "<!-- pr-type: spec-only -->" in the body. These docs PRs route
   the no-ceremony / docs-only path: the scope guard FAILS on any issue reference, so the PR
   body MUST contain ZERO "Refs #N", bare "#N", or issue URLs — summarise the change instead.
5. Wait for CI green (gh pr checks <pr> --watch). Then gh pr merge <pr> --merge --delete-branch.
   If you refresh after merge, do it only in this isolated checkout (git checkout main &&
   git pull origin main); never touch the architect's live checkout.
6. For each "#N <- draft": re-sync the existing issue body (body = draft minus the H1 line,
   i.e. tail -n +3) with gh issue edit <N> --body-file <tmp>. For each "new <- draft":
   gh issue create with title = the draft H1 and body = draft minus H1, then write the
   returned number into the draft's "GitHub Issue: #N" line and add that draft's registry
   row to docs/issue_queue_index.md (selective staging only — see Index ownership above).
7. Report the PR URL, the merge commit, and each issue number/URL synced or created.
EOF
# Fast isolated runtime: the helper creates a scratch checkout for all delegate
# git mutations and a dedicated opencode data dir to avoid SQLite write-lock
# contention with the orchestrator's shared DB (a raw `opencode run` otherwise
# stalls intermittently at "creating instance"); deepseek-chat (non-reasoning) +
# 180s timeout + startup-hang retry. See opencode-publish.sh.
OPENCODE_PUBLISH_INCLUDE="<same touched path list plus docs/issue_queue_index.md>" \
bash .claude/skills/publish-issue-draft/opencode-publish.sh --dangerously-skip-permissions --dir . "$(cat "$PROMPT_FILE")"
```

**Verify state after the run — `opencode run` can exit 0 mid-failure.** A
connection drop or context exhaustion can leave `opencode run` reporting exit 0
while the publish is half-done (e.g. issue created, PR not opened, or index row
left uncommitted). Do **not** trust the exit code alone: confirm with
`gh issue view <N>`, `gh pr list --search <slug>`, and `git status` before
reporting success, and complete any missing step via the fallback below.

If the published change is an **amendment to an already-closed issue** whose spec
materially changed, note in your report that the issue may need reopening for
re-implementation — the architect decides that with the user; deepseek only
re-syncs the body.

### Pre-flight

```powershell
git status -sb
git fetch origin
```

Fallback/manual branch work must happen in a separate checkout (not the architect's
live working tree): update that checkout's `main` from origin, then create
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

Do **not** bundle unrelated local edits (other skills, `agent-orchestrator.yaml`, WIP code).

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

```powershell
pwsh -NoProfile -File scripts/lint-self-architect.ps1 -WithWorkingTree
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
```

**Contract-evidence gate (Issue #366).** Run on **every** draft in the publish
commit (Mode A re-sync, Modes B and C) before `gh issue create` / `gh issue edit`
or spec PR commit:

```powershell
pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/NN-<slug>.md
```

Refuse sync or publish while this exits non-zero.

For each draft in the publish commit that declares `behavior-kind` or
`parked-root-cause` (parked root tracking), run the mechanical guards (Issue #221) before push:

```powershell
pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/NN-<slug>.md
pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command parked-root -DraftPath docs/issues_drafts/NN-<slug>.md
```

When a `parked-root-cause` block references `#N`, validate the live issue body
carries the declared cause (re-run `parked-root` after `gh issue view` sync, or
supply `-MockIssuesPath` only in tests).

Fix `[STRICT]` findings before push.

### Commit and push

```powershell
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
# Refresh only the separate fallback checkout if needed; do not pull the architect's live tree.
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

- Sync or publish while `contract-evidence` exits non-zero (Issue #366).
- Run publish mechanics directly by default — delegate to `opencode run
  --dangerously-skip-permissions --dir .` first; use `AO_PUBLISH_FALLBACK=1`
  only as fallback (opencode unavailable or half-done).
- Hand-edit, wholesale-stage, or reset `docs/issue_queue_index.md` — selective
  single-row staging only (see Index ownership), whoever runs the publish.
- Put any issue reference (`Refs #N`, bare `#N`, issue URL) in a spec-only PR body —
  the no-ceremony scope guard rejects it.
- Open a PR in sync-only mode — that is the whole point of the default.
- Merge with failing scope guard or self-architect `-Strict`.
- Use `gh pr merge --admin` to skip checks unless the user explicitly requests it.
- Commit secrets or `agent-orchestrator.yaml` (gitignored).
