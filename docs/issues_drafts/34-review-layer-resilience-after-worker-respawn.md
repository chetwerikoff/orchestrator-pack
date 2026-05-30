# Review-layer resilience after worker respawn

GitHub Issue: #98

## Prerequisite

- `docs/issues_drafts/24-ao-review-preflight-and-failed-run-discipline.md` (GitHub #60) — **closed**;
  established failed-run discipline (empty-trap, `terminationReason` check). This issue extends
  that contract to the respawn scenario where a dead linked-session leaves orphan runs.
- `docs/issues_drafts/11-orchestrator-autonomous-review-loop.md` (GitHub #28) — **closed**;
  established `ao review run` / `ao review send` / worker handoff loop. This issue adds
  idempotency and orphan-reap obligations that #28 did not cover.
- `docs/issues_drafts/33-orchestrator-session-launch-death-and-worktree-hygiene.md` (GitHub #91) —
  **closed**; established worktree preflight. This issue covers the review-layer fallout *after*
  a worker is lost and respawned — distinct failure class.
- `docs/issues_drafts/32-worker-acknowledge-pickup-contract.md` (GitHub #88) — **open**;
  reduces no-acknowledge / stuck events that trigger respawn. This issue addresses what happens
  to the review layer *when respawn occurs anyway*.

**Note (2026-05-30):** Issue #58 state-derived reconciliation (`gh pr list` → `ao spawn
--claim-pr`) was **reverted** after PR #97 split-brain duplicate workers. This issue does
**not** reintroduce reconciliation spawn; it hardens review/idempotency **after** a respawn
that already happened (ping/respawn discipline, operator recovery).

## Goal

When a worker session is lost and replaced (respawned or `ao spawn --claim-pr`), the AO-local
review layer must not enter a run-storm, leave orphan `needs_triage` blocks on the dead session,
or produce infrastructure failures from stale reviewer workspaces or detached-HEAD PR context.
After a respawn, a human operator must be able to reach a clean merge gate — without manual UI
surgery to dismiss orphan findings — by following a documented, CLI-first recovery path.

Observed failure (2026-05-30, PR #97 / issue #86): orchestrator after restore produced 5 review
runs in under 10 minutes (including a duplicate run on the same sha `8f472e4` 35s apart);
op-rev-1 (linked dead `op-1`) held 2 open findings blocking merge until dismissed in UI;
op-rev-3 failed with `git worktree add … already exists`; op-rev-6 failed with
`gh: could not determine current branch: not on any branch` (detached HEAD in reviewer
workspace). PR cleared only after: op-rev-1 findings dismissed in UI, `ao session claim-pr 97
op-3` manual rebind, and fresh review run on current head.

## Binding surface

1. **Orchestrator idempotency rule.** `orchestratorRules` in `agent-orchestrator.yaml.example`
   must state: before calling `ao review run`, the orchestrator checks `ao review list --json`
   for an active run (status `running` or `reviewing`) on the *current PR head sha*. If one
   exists, it does not spawn a new run. A new run is only spawned after the active run
   completes or the head sha advances. This clause is additive to, not a replacement of, the
   existing empty-trap rule from #60.

2. **Orphan-run operator path (CLI-first).** `docs/orchestrator-recovery-runbook.md` and
   `docs/migration_notes.md` document what "orphan run" means (review run whose `linkedSessionId`
   is in `terminated`/`killed`/`detecting` state) and the explicit CLI-first recovery sequence:
   `ao session claim-pr <pr> <new-session>` to rebind the PR, then a fresh `ao review run` on
   the new session. If open findings remain on the orphan run and `ao review send` cannot
   deliver to the dead session, the runbook documents the UI dismiss path (Reviews → TRIAGE →
   resolve) as the escape hatch, clearly labelled as manual. The runbook must not leave this
   case undocumented or route operators to `ao review send` on a dead session.

3. **Detached-HEAD-safe PR context detection.** The pack's reviewer wrapper or context-detection
   script must resolve the PR number and base ref without relying on `git symbolic-ref HEAD` or
   `gh pr view` with no arguments (both fail in detached HEAD). Acceptable alternatives include
   `gh pr view --json headRefOid` filtered by the current sha, or passing the PR number
   explicitly from the AO review-run context. The wrapper must not exit with
   `could not determine current branch` when run in a detached-HEAD reviewer workspace.

4. **Stale reviewer workspace guard.** Before `git worktree add` for a new reviewer workspace,
   the review invocation path (or the pack wrapper's preflight) must detect and remove a
   pre-existing directory at the target path. A `worktree add … already exists` failure must
   not leave the run in `failed` with `findingCount: 0` without a recovery suggestion. The
   workspace cleanup may be implemented in the reviewer wrapper, in a preflight script, or in
   `orchestratorRules` guidance — planner's choice.

5. **Migration notes update.** `docs/migration_notes.md` gains a subsection on respawn-induced
   review disarray: run-storm prevention (idempotency check), orphan-run identification
   (`ao review list --json` fields: `linkedSessionId`, `status`, `openFindingCount`), detached-
   HEAD failure signature and fix, stale-workspace failure signature and fix, and the
   `ao session claim-pr` rebind command as the canonical respawn-recovery entry point.

6. **Decision log.** `docs/issues_drafts/00-architecture-decisions.md` gains a new subsection
   recording: review runs are keyed to a `(linkedSessionId, sha)` pair; a respawned session
   gets a new id and inherits the PR but not existing run records; orphan runs on dead sessions
   are not auto-reaped by AO and require operator action; idempotency is enforced via
   `orchestratorRules`, not AO core (pack-side rule, not upstream fix). Sync to Issue #3 in
   the same PR.

## Files in scope

- `agent-orchestrator.yaml.example` — `orchestratorRules` idempotency clause (binding surface 1).
- `docs/orchestrator-recovery-runbook.md` — orphan-run section (binding surface 2).
- `docs/migration_notes.md` — respawn + review disarray subsection (binding surface 5).
- `plugins/ao-codex-pr-reviewer/` — detached-HEAD-safe PR context detection (binding surface 3);
  stale-workspace guard (binding surface 4). Planner decides which file(s) within the plugin.
- `scripts/` — if stale-workspace guard is a standalone preflight; planner's choice.
- `docs/issues_drafts/00-architecture-decisions.md` + Issue #3 re-sync (binding surface 6).
- `docs/issues_drafts/34-review-layer-resilience-after-worker-respawn.md` — this spec.

## Files out of scope

- `vendor/**`, `packages/core/**`, AO core review-run scheduling (idempotency at AO level is
  an upstream ask, not a pack deliverable).
- Live `agent-orchestrator.yaml` (gitignored).
- `ao review send` behaviour when the linked session is dead — that is AO core; pack documents
  the symptom and the workaround only.
- Worker prompt-delivery launch failure (Issue #63, #91) — this issue starts *after* respawn
  has already happened.
- GitHub Actions Codex review workflow.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
code-reviews/**
```

```allowed-roots
agent-orchestrator.yaml.example
docs/**
plugins/ao-codex-pr-reviewer/**
scripts/**
prompts/**
```

## Acceptance criteria

- [ ] `agent-orchestrator.yaml.example` `orchestratorRules` contains an explicit clause
      requiring the orchestrator to check `ao review list --json` for a `running`/`reviewing`
      run on the current head sha before calling `ao review run`. The clause is present and
      parseable as English prose (not a comment). Verified by grepping the literal block.
- [ ] `docs/orchestrator-recovery-runbook.md` has a section named or equivalent to "Orphan
      review run after worker respawn" that documents: how to identify an orphan run from
      `ao review list --json` output, the `ao session claim-pr` rebind command, when
      `ao review send` will fail silently (dead session), and the UI dismiss escape hatch.
- [ ] `docs/migration_notes.md` documents all five respawn-review failure signatures:
      run-storm, orphan needs_triage, detached-HEAD `gh` error, stale-workspace `worktree add`
      error, and silent `ao review send` delivery failure to dead session.
- [ ] Running the pack reviewer wrapper (or its PR-context-detection component) in a detached-
      HEAD checkout that has the PR sha does not exit with `could not determine current branch`
      or equivalent. Provable by invoking the detection path with a detached HEAD and a known
      PR number available in the environment or passed explicitly.
- [ ] `ao review run` triggered via the pack's canonical review command on a reviewer workspace
      where the target directory already exists (stale from a prior failed run) does not fail
      with `already exists`; it either reuses or recreates the workspace cleanly.
- [ ] `docs/issues_drafts/00-architecture-decisions.md` has a new subsection recording the
      decisions in binding surface 6; the corresponding Issue #3 body is re-synced in the same
      PR (PR notes link the updated section and the Issue #3 edit).
- [ ] `scripts/verify.ps1` or a check wired into it validates that `orchestratorRules` in
      `agent-orchestrator.yaml.example` contains the idempotency clause (criterion 1); the
      check fails on a deliberate regression (clause removed).

## Upgrade-safety check

- No edits under `vendor/**` or `packages/core/**`.
- No new AO YAML schema fields; `orchestratorRules` is a plain string block, no new keys.
- No new repository secrets.
- Does not change the NO_FINDINGS review contract (Issue #60 / `06-codex-reviewer-scope-context.md`).
- Does not change worker `ao acknowledge` contract (Issue #88).

## Verification

1. **Idempotency guard:** show `scripts/verify.ps1` (or the new check) passing on the updated
   `.example` and failing on a copy with the idempotency clause removed.
2. **Detached-HEAD fix:** in a fresh reviewer workspace checkout, detach HEAD to the PR's merge
   sha, run the PR-context-detection path, show it resolves the PR number without error.
3. **Stale-workspace fix:** with an existing directory at the reviewer workspace path, run the
   pack's review command and show it does not fail with `worktree add … already exists`.
4. **Runbook completeness:** PR notes include a checklist confirming each of the five migration-
   notes failure signatures is present in the updated `migration_notes.md`.
5. **Decision log sync:** PR notes link the new `00-architecture-decisions.md` subsection and
   the updated Issue #3 body.
