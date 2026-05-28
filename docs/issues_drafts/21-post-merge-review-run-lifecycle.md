# Post-merge AO-local review run lifecycle — stop triaging stale runs after PR merge

GitHub Issue: #54

## Prerequisite

- Issue #28 (file `docs/issues_drafts/11-orchestrator-autonomous-review-loop.md`)
  must be merged. This issue extends the review-loop contract with a
  **terminal branch** when the linked worker's PR is already merged.
- Issue #45 (file `docs/issues_drafts/17-patch-review-loop-sentfindingcount.md`)
  must be merged. Pending-worker detection for `waiting_update` is assumed.
- Issue #40 (file `docs/issues_drafts/15-orchestrator-recovery-runbook.md`)
  must be merged. This issue **amends** `docs/orchestrator-recovery-runbook.md`
  with an operator section for the post-merge case.
- Issue #39 (file `docs/issues_drafts/14-orchestrator-wake-mechanism.md`)
  must be merged. This issue edits and verifies against
  `docs/orchestrator-wake-runbook.md`; wake events must not re-drive review
  triage for a PR whose worker session is already `merged`.

**5 Whys (failure trace, 2026-05-28, PR #53 / op-17):**

1. After manual merge, the AO dashboard kanban still showed active review runs
   (`needs_triage`, `waiting_update`).
2. Worker session `op-17` correctly transitioned `mergeable → merged` and was
   killed; AO-local code-review runs for the same PR were not closed.
3. AO 0.9.x merge cleanup tears down the **worker** worktree/session only;
   `code-reviews/` store entries persist. By observed behavior, AO core only
   marks an existing review run `outdated` when a **new** run targets a
   **different** SHA — PR merge triggers no outdate/cancel of existing runs.
4. `orchestratorRules` instruct triage for every `needs_triage` /
   `waiting_update` run but do not exempt runs whose linked worker PR is already
   `merged` — so a wake or operator nudge can still attempt `ao review send` or
   ping a dead worker.
5. Root cause: missing **pack contract** for "linked PR merged → review loop
   terminal for that PR; do not act on stale AO-local runs." Upstream AO
   cancel/archive API is a separate enhancement, not required to stop harmful
   orchestrator actions.

## Goal

When a worker's PR is merged (human merge, per repo policy), the orchestrator
and operators must treat AO-local review runs for that PR as **historical** —
not as queue work. The dashboard may still list the runs until AO upstream adds
cancel/archive; this issue stops **incorrect automation** (send, ping, respawn,
new review rounds) and documents the expected post-merge kanban state.

## Binding surface

Observable contracts:

1. **`orchestratorRules`** (`agent-orchestrator.yaml.example`): A named branch
   **merged PR — review loop terminal** that applies on every orchestrator turn
   when the PR linked to a review run is **merged on GitHub**. Detection MUST key
   off the linked PR's merge state (the run carries its PR ref; verify merge via
   GitHub, e.g. `gh pr view`), **not** solely live session status — merge cleanup
   can already have killed/removed the worker session from `ao status` while the
   `code-reviews/` run persists, so a session-only check would miss exactly this
   case. A still-visible `merged` / `terminated` session is a sufficient but not
   necessary signal. For that PR, the orchestrator MUST:
   - **Not** call `ao review send` for any run linked to that session/PR.
   - **Not** call `ao review run` for a new round on that PR.
   - **Not** `ao send` ping or `ao session kill` / `ao spawn --claim-pr` for
     review-loop purposes on that PR.
   - **Not** treat `needs_triage` or `waiting_update` runs for that PR as
     blocking other work or as requiring recovery under the autonomous loop.
   - Treat **linked PR merged** as an additional EXIT condition for the named
     `waiting_worker_review_response` state (alongside the existing four), so the
     orchestrator leaves that state rather than pinging or respawning a
     terminated worker.
   - **May** proceed to other open issues/PRs normally.

2. **Wake handling** (listener behavior and/or
   `docs/orchestrator-wake-runbook.md`): Review-related wake events for an
   already-merged PR MUST NOT result in an orchestrator nudge that implies
   triage/send for that PR. Note: the wake *filter* (`evaluateWakePayload` in
   `orchestrator-wake-filter.mjs`) is a pure, stateless function over a single
   payload — it cannot know PR merge state, so it is **not** the correct layer
   for this suppression. The binding behavior is satisfied **entirely** by the
   merged-PR terminal branch in `orchestratorRules` (the orchestrator simply does
   not act on the wake) plus documentation in the wake runbook. No wake-listener
   or wake-filter code change ships with this issue; if a future listener-level
   guard is wanted, it is a separate issue with its own allowed-roots.

3. **Recovery runbook** (`docs/orchestrator-recovery-runbook.md`): A dedicated
   section **After manual PR merge** that explains:
   - Worker cleanup vs review-run persistence is **expected** on AO 0.9.x.
   - Stale `ao review list` entries after merge are **not** evidence the
     orchestrator is stuck.
   - Operators must **not** `ao review send` to a terminated/merged worker.
   - What to do if the kanban still shows review cards (ignore for merged PRs;
     focus on open PRs only).
   - Explicit note that AO CLI has no `review cancel` today; upstream request
     is documented, not implemented in this pack.

4. **Migration** (`docs/migration_notes.md`): Short paragraph telling operators
   to merge the updated `orchestratorRules` block into live config and restart
   AO (`ao stop` then `ao start`), plus restart the wake listener if used. (No
   wake-filter code change ships with this issue, so none to migrate.)

5. **Architecture decision** (`docs/issues_drafts/00-architecture-decisions.md`
   or `docs/architecture.md`): One entry recording that AO-local review runs are
   **not** lifecycle-coupled to PR merge in AO 0.9.x; pack policy is
   orchestrator inaction + operator documentation until upstream adds
   cancel/outdate-on-merge.

## Files in scope

- `agent-orchestrator.yaml.example` — add merged-PR terminal branch to
  `orchestratorRules`.
- `docs/orchestrator-wake-runbook.md` — document that merged-PR review wakes are
  ignored and why (the stateless wake filter cannot know merge state; suppression
  is via `orchestratorRules` inaction or a listener-level guard). Edit
  `orchestrator-wake-filter.mjs` only if the planner finds a genuine payload-level
  signal that warrants it — not expected.
- `docs/orchestrator-recovery-runbook.md` — new **After manual PR merge** section.
- `docs/migration_notes.md` — operator migration paragraph.
- `docs/architecture.md` or `docs/issues_drafts/00-architecture-decisions.md` —
  lifecycle decision entry.
- `docs/issues_drafts/21-post-merge-review-run-lifecycle.md` — this spec.

## Files out of scope

- `packages/core/**`, `vendor/**`, AO runtime patches, hand-edits under
  `.agent-orchestrator/**`.
- New `ao review cancel` / `dismiss` CLI (upstream AO; document only).
- `prompts/codex_review_prompt.md`, `plugins/ao-codex-pr-reviewer/**` — unrelated
  to merge lifecycle.
- `prompts/agent_rules.md` — worker is already terminated on merge; no worker
  behavior change required unless planner finds a conflicting clause (then minimal
  alignment only).
- Rewriting closed issues #39, #40, #45 — reference only.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
.agent-orchestrator/**
agent-orchestrator.yaml
plugins/**
.github/workflows/**
.claude/skills/**
scripts/pr-scope-check.ps1
scripts/pr-scope-check.ts
scripts/pr-scope-check.test.ts
prompts/codex_review_prompt.md
docs/issues_drafts/11-orchestrator-autonomous-review-loop.md
docs/issues_drafts/14-orchestrator-wake-mechanism.md
docs/issues_drafts/15-orchestrator-recovery-runbook.md
docs/issues_drafts/17-patch-review-loop-sentfindingcount.md
```

```allowed-roots
agent-orchestrator.yaml.example
docs/orchestrator-recovery-runbook.md
docs/orchestrator-wake-runbook.md
docs/orchestrator-wake-filter.mjs
docs/migration_notes.md
docs/architecture.md
docs/issues_drafts/00-architecture-decisions.md
docs/issues_drafts/21-post-merge-review-run-lifecycle.md
```

## Acceptance criteria

- **Merged-PR terminal branch exists.** Reading `orchestratorRules` in
  `agent-orchestrator.yaml.example` shows an explicit block that forbids
  `ao review send`, new `ao review run`, review-loop ping, and review-loop
  respawn when the linked worker PR is `merged`.
- **Loop exemption is PR-scoped.** The rules state that stale
  `needs_triage` / `waiting_update` runs for a **merged** PR do not keep the
  orchestrator in `waiting_worker_review_response` and do not block other PRs.
- **Runbook section exists.** `docs/orchestrator-recovery-runbook.md` contains
  a heading exactly `## After manual PR merge` covering persistence of
  review runs, non-actionable kanban cards, and the prohibition on
  `ao review send` to merged workers.
- **Wake behavior documented.** `docs/orchestrator-wake-runbook.md` documents
  that merged-PR review wakes are ignored and why (stateless filter cannot see
  merge state; the terminal branch makes the orchestrator inactive), matching
  `orchestratorRules`. A wake-filter code change is not required.
- **Architecture note present.** `docs/architecture.md` or
  `00-architecture-decisions.md` records the AO 0.9.x split: worker merge
  cleanup vs durable `code-reviews/` runs.
- **Migration paragraph present.** `docs/migration_notes.md` tells operators to
  update live `orchestratorRules` and restart AO (and wake listener if used).

## Upgrade-safety check

- No edits under `vendor/**` or `packages/core/**`.
- No new unsupported YAML keys; `reviewer:` block remains absent.
- No requirement to hand-edit `.agent-orchestrator/**` review-run JSON as the
  primary fix — contract is behavioral (orchestrator + operator docs).
- Upstream AO enhancement (auto `outdated`/`cancelled` on merge) may be noted
  in architecture text as future work; this issue does not block on it.

## Verification

1. Read `agent-orchestrator.yaml.example` `orchestratorRules` — confirm
   merged-PR terminal branch and prohibitions (acceptance bullets 1–2).
2. Read `docs/orchestrator-recovery-runbook.md` — confirm **After manual PR merge**
   section (acceptance bullet 3).
3. Read `docs/orchestrator-wake-runbook.md` — confirm documented merged-PR wake
   handling and the note that the stateless filter is not the suppression layer
   (acceptance bullet 4).
4. Read architecture decision entry (acceptance bullet 5).
5. Read `docs/migration_notes.md` migration paragraph (acceptance bullet 6).
6. Run `.\scripts\verify.ps1` and `.\scripts\check-reusable.ps1` — must pass.
