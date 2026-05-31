# Pack reviewer selector survives AO review spawn

GitHub Issue: #106

## Prerequisite

- `docs/issues_drafts/31-deterministic-reviewer-selection.md` (GitHub #86) — **closed**;
  `PACK_REVIEWER` (`claude` | `codex`) is the single selector; `scripts/invoke-pack-review.ps1`
  is the only REVIEW_COMMAND entrypoint; fail-closed when unset.
- `docs/issues_drafts/27-tracked-claude-review-and-strict-gate.md` (GitHub #79) — **closed**;
  strict gate and shared selector resolver in `scripts/lib/`.
- `docs/issues_drafts/24-ao-review-preflight-and-failed-run-discipline.md` (GitHub #60) —
  **closed**; failed runs with `findingCount: 0` are infra, not clean.

**Pre-sync review:** Codex CLI over usage limit until 2026-06-02 — draft self-reviewed
against planner-freedom checklist; re-run Codex draft review when quota resets.

**Observed failure (2026-05-31, PR #104 / #105):** operator set `PACK_REVIEWER=claude` at
Windows User scope and restarted AO from a shell with the variable present — review on PR #104
reached `clean` (op-rev-4). After `ao stop` and a later `ao start` from a parent that did not
inherit User env (IDE not restarted), review runs on PR #105 failed in under one second with
`PACK_REVIEWER is not set` (op-rev-5) despite User env still containing `claude`. Root cause:
AO review spawn exposes **process-scoped** environment to the reviewer workspace; User/Machine
registry values are not visible to `$env:PACK_REVIEWER` in that child unless the AO daemon
process inherited them at start.

## Goal

Review runs spawned by AO must resolve the same `PACK_REVIEWER` selector the operator configured,
without requiring every `ao start` parent to re-export User env into process scope and without
changing the #86 contract (one variable name, fail-closed, no Codex default).

## Binding surface

1. **Persistent-env fallback in the pack resolver.** The canonical selector resolver used by
   `invoke-pack-review.ps1`, the strict gate, and `orchestrator-diagnose.ps1 -Strict` MUST,
   when process-scoped `PACK_REVIEWER` is unset or whitespace, consult operator-persistent
   environment layers before failing closed. On Windows this includes at least User and Machine
   registry scopes for the same variable name. The resolver MUST remain a single shared function
   (Mode 2 — no duplicate parsing). Precedence when multiple layers are set is the planner's
   choice but MUST be documented in one place.

2. **Fail-closed unchanged.** If the variable is unset or unrecognised in **all** consulted
   layers, behaviour matches #86: non-zero exit, clear message, no reviewer executed.

3. **Selector mismatch semantics unchanged.** Strict gate still compares executed wrapper to the
   resolved selector value; fixtures and `-Live` mode use the same resolver.

4. **Operator docs.** `docs/reviewer-switch-runbook.md` and `docs/migration_notes.md` state:
   User-level `PACK_REVIEWER` is sufficient for review spawn after this change; process-level
   export before `ao start` remains recommended for the AO daemon itself; IDE restart is still
   required for other env vars the daemon must see at boot — but review must not fail solely
   because the reviewer child lacked process inheritance.

5. **Decision log.** `docs/issues_drafts/00-architecture-decisions.md` gains subsection **N**
   extending decision **L** (#86): persistent env layers are a read-only fallback for the same
   `PACK_REVIEWER` selector, not a second source of truth.

6. **Out of scope for this issue:** upstream AO changes to inject env into review spawn; a new
   config key in `agent-orchestrator.yaml`; automatic Codex↔Claude failover on quota.

## Operator adoption

After merge, operators who already set User-level `PACK_REVIEWER` need **no** yaml change.
Optional verification: trigger one review and confirm `terminationReason` does not contain
`PACK_REVIEWER is not set` when User env is `claude` or `codex`.

## Files in scope

- `scripts/lib/` — extend the shared `PACK_REVIEWER` resolver (planner picks helper shape).
- `scripts/invoke-pack-review.ps1` — uses the shared resolver only (no inline duplicate).
- `scripts/invoke-pack-review-strict-gate.ps1`, `scripts/orchestrator-diagnose.ps1` — same
  resolver for `-Strict` / fixture expected reviewer.
- `scripts/verify.ps1` — wire tests or fixtures for persistent-env fallback and unchanged
  fail-closed when all layers unset.
- Committed fixtures or unit tests under `scripts/` or `tests/` (planner's choice).
- `docs/reviewer-switch-runbook.md`, `docs/migration_notes.md`
- `docs/issues_drafts/00-architecture-decisions.md` — subsection **N**
- `docs/issue_queue_index.md` — registry row

## Files out of scope

- `vendor/**`, `packages/core/**`, AO core / schema / CLI.
- Live `agent-orchestrator.yaml` (gitignored).
- `agent-orchestrator.yaml.example` — REVIEW_COMMAND and rules prose unchanged unless a
  one-line cross-reference to persistent-env fallback is needed (planner's choice).
- Changing which reviewers exist or the NO_FINDINGS contract (#9, #79 wrappers).

## Denylist

Pack-wide fences match
[`27-tracked-claude-review-and-strict-gate.md`](./27-tracked-claude-review-and-strict-gate.md)
§ Denylist (`vendor/**`, `packages/core/**`, `code-reviews/**`) plus `.ao/**` in
denylist and `allowed-roots` for `scripts/**`, `tests/**`, `docs/**` only.

## Acceptance criteria

- **Fallback resolves selector.** With process-scoped `PACK_REVIEWER` unset and User-level
  (Windows) set to `claude`, a test or fixture invocation of the entrypoint resolves `claude`
  and does not emit the "PACK_REVIEWER is not set" message.
- **Fail-closed when nowhere set.** With process, User, and Machine unset (or empty), the
  entrypoint still exits non-zero with the existing unset message; no reviewer runs.
- **Invalid value still fails.** Unrecognised value in User scope still fails closed with the
  existing unrecognised-value message.
- **Gate and diagnose aligned.** `scripts/verify.ps1` and `orchestrator-diagnose.ps1 -Strict`
  use the same resolver; a fixture encoding persistent-env fallback passes; mismatch fixtures
  still fail.
- **Docs.** Runbook and migration notes describe User-level sufficiency for review spawn and
  the precedence rule in one paragraph.
- **Decision log.** Subsection **N** in `00-architecture-decisions.md` records persistent-env
  fallback as an extension of decision **L**, not a second selector.

## Upgrade-safety check

- No edits under `vendor/**` or `packages/core/**`.
- No new secrets or repo-committed selector values — still operator env only.
- AO review layer unchanged: `ao review run --execute --command` → same entrypoint basename.
- Does not weaken #86 fail-closed when selector is genuinely absent everywhere.

## Verification

- `.\scripts\verify.ps1` (includes new resolver / fixture coverage).
- `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/lint-self-architect.ps1`
- Manual (operator, after merge): with User `PACK_REVIEWER=claude`, AO running, trigger review
  on an open PR; `ao review list orchestrator-pack --json` — latest run not `failed` with
  unset-selector message.
