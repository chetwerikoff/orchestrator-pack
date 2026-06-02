# Review dashboard: operator script to outdate terminal clean/failed runs

GitHub Issue: #122

**Pre-sync review:** Codex CLI over usage limit until 2026-06-02 — draft revised per
architect review (2026-05-31): script-primary delivery, upstream API gate, no
orchestratorRules “first turn” trigger.

## Prerequisite

- **Gate 0 (blocking — complete before implementation PR is mergeable).** Confirm
  whether AO 0.9.x exposes **any** supported path to move a review run from `clean` or
  `failed` to `outdated` (CLI subcommand, documented HTTP API, official plugin hook, or
  UI action that applies to **CLEAN/FAILED** cards — not only TRIAGE dismiss). Record
  the result in the implementation PR and in `docs/architecture.md`:
  - If **yes** → document the exact invocation; the pack script calls it in `-Apply`
    mode.
  - If **no** → open (or link) a minimal upstream issue on ComposioHQ/agent-orchestrator
    with the contract below; **this pack issue does not ship a noop as “done”** — it
    ships detection + docs + upstream tracking until the API lands, then a small follow-up
    wires `-Apply`.
  - The pack **MUST NOT** hand-edit review-run JSON under `.agent-orchestrator/` or
    `code-reviews/` (recovery runbook invariant). Do not invent `ao review cancel`.
- Post-merge review terminal policy (**MERGED PR — REVIEW LOOP TERMINAL**, GitHub #54;
  `00-architecture-decisions.md` §J) — **closed** for orchestrator *actions*; does not
  move dashboard cards. This issue is additive.
- `docs/issues_drafts/24-ao-review-preflight-and-failed-run-discipline.md` (GitHub #60) —
  **closed**; cleanup must not treat `failed` + `findingCount: 0` as clean or call
  `ao review send`.
- `docs/issues_drafts/34-review-layer-resilience-after-worker-respawn.md` (GitHub #98) —
  **closed**; TRIAGE dismiss is for open findings on orphan runs, not a substitute for
  CLEAN/FAILED → OUTDATED until Gate 0 proves otherwise.

**Observed operator pain (2026-05-31):** After `ao start`, the AO **Reviews** board
accumulates **CLEAN** and **FAILED** cards for merged/closed PRs (`#112`, `#114`, …).
Operators mentally filter stale columns; **Retry** on **FAILED** implies actionable work
when the PR is finished.

**Confirmed constraint (AO 0.9.x):** `ao review` = `run | execute | send | list` only.
Recovery runbook: AO does not cancel or mark runs outdated on merge; no `ao review
cancel`; pack must not invent one.

## Goal

Provide an **operator-invoked pack script** (run after `ao start` or anytime) that
identifies terminal `clean` / `failed` review runs and, when Gate 0’s supported API
exists, moves them to `outdated` so the Reviews kanban matches reality. Open,
in-progress PRs are never touched. **OrchestratorRules are not the carrier** — rules are
turn-driven and stateless; they cannot reliably mean “once per daemon start” without an
external marker.

## Binding surface

### 1. Primary delivery — pack script (operator)

- **New script** under `scripts/` (planner names it; e.g. archive pattern used by
  `orchestrator-diagnose.ps1` / `reviewer-workspace-preflight.ps1`).
- **Invocation model:** operator runs after `ao start` (documented in go-live, recovery
  runbook, and optional `scripts/bootstrap.ps1` hint — not auto-run by AO).
- **Modes:**
  - **`-DryRun` (default):** list candidates (run id, `prNumber`, status, reason
    terminal) and exit 0; no state change.
  - **`-Apply`:** call the Gate 0–confirmed API for each candidate; log per-run success /
    skip; exit non-zero if any apply failed or API missing.
- **Inputs:** project id (default `orchestrator-pack`), uses `ao review list <project>
  --json`, `ao status --json` (or equivalent) for active worker ↔ PR mapping, `gh pr
  view` for terminal PR state.
- **Must not** invoke `ao review send`, `ao review run`, or mutate finding bodies.

### 2. Runs in scope (status filter)

Only `status` ∈ `{ clean, failed }`. Do **not** process `needs_triage`,
`waiting_update`, `queued`, `preparing`, `running`, `reviewing`, or already `outdated`.

### 3. Terminal task definition (GitHub + AO)

A run is a candidate **only** when **all** hold:

- **PR terminal:** `gh pr view` shows `MERGED` or `CLOSED` (planner documents exact
  fields; closed covers abandoned / deleted-branch PRs).
- **No active worker on that PR:** no open AO worker session tied to the same
  `prNumber` in an implementation state (planner defines observable statuses — e.g.
  `working`, `fixing_ci`, `ready_for_review`). Merged/terminated-only sessions →
  terminal.
- **Issue-only runs:** if no `prNumber`, outdate only when linked GitHub Issue is
  `closed`; open issues stay candidates for future work.

**Conservative default:** unresolved `gh`/AO → **skip** + warning; never outdate on
ambiguity.

### 4. Upstream API contract (for Gate 0 / contrib)

Minimum upstream surface the pack needs (wording for upstream issue, not implementation
detail here):

- Idempotent transition: `(projectId, reviewRunId)` → status `outdated` when current
  status is `clean` or `failed`.
- Reject or no-op when PR is open and worker active (optional server-side guard; pack
  still enforces client-side).
- CLI exposure preferred: e.g. `ao review archive <run-id>` or `ao review dismiss
  <run-id> --reason terminal_pr`.

### 5. Docs (no orchestratorRules requirement)

- `docs/orchestrator-recovery-runbook.md` — subsection: when to run the script after
  merge / `ao start`; Gate 0 limitation; TRIAGE dismiss ≠ CLEAN/FAILED cleanup.
- `docs/migration_notes.md` — adoption steps.
- `docs/orchestrator-autoloop-go-live.md` — add to post-`ao start` checklist (alongside
  wake listener), one command line.
- `docs/architecture.md` — pointer to Gate 0 outcome and upstream issue link.
- **Out of scope for v1:** new `orchestratorRules` clause for “first turn cleanup”
  (stateless rules cannot implement once-per-start reliably).

### 6. Relationship to #54

- #54: orchestrator **inaction** on merged PRs (no send/run/ping).
- This issue: operator **dashboard hygiene** via script when API exists.
- `needs_triage` / `waiting_update` on merged PRs: still manual TRIAGE path per #98
  until a follow-up issue; script does not replace it.

### 7. Operator adoption

After implementation PR merges:

1. Complete Gate 0 (or read result from PR body / architecture doc).
2. `ao stop` then `ao start` (normal restart — **no yaml merge required** for v1 unless
   a later issue adds optional rules text).
3. From pack repo root:
   - `pwsh -File scripts/<cleanup-script>.ps1 -DryRun` — inspect candidates.
   - `pwsh -File scripts/<cleanup-script>.ps1 -Apply` — only when Gate 0 API exists.
4. Verify: `ao review list orchestrator-pack --json` — terminal PR runs no longer
   `clean`/`failed`; show `outdated` on dashboard.

### 8. Decision log

Add subsection to `docs/issues_drafts/00-architecture-decisions.md` (sync Issue #3 in
implementation PR): terminal PR cleanup is **operator script + upstream API**, not
orchestratorRules; TRIAGE UI ≠ CLEAN/FAILED archive.

## Files in scope

- `scripts/` — `(new)` cleanup script; `(new)` `check-*` guard in `verify.ps1`.
- `docs/orchestrator-recovery-runbook.md`, `docs/migration_notes.md`,
  `docs/orchestrator-autoloop-go-live.md`, `docs/architecture.md`.
- `docs/issues_drafts/00-architecture-decisions.md`.
- `tests/fixtures/` — `(new)` `ao review list --json` + mocked `gh` / `ao status` for
  detection tests (planner picks harness).

## Files out of scope

- `agent-orchestrator.yaml.example` / live `orchestratorRules` changes in v1 (no
  stateless “run once at start” rule).
- `vendor/**`, `packages/core/**` except a linked upstream contrib plan in docs.
- Auto-archiving `needs_triage`, `waiting_update`, in-flight runs.
- Wake listener / webhook filters.
- Hand-editing `.agent-orchestrator/` review JSON.

## Denylist

```denylist
# issue 122 — review dashboard terminal cleanup
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
scripts/**
docs/**
tests/fixtures/**
```

## Acceptance criteria

- [ ] **Gate 0 documented** in PR + `docs/architecture.md`: supported API/UI path exists,
  or upstream issue filed with §4 contract and implementation PR labeled
  **blocked-on-upstream** (detection-only merge allowed only if explicitly scoped in PR
  title/body).
- [ ] **`-DryRun`:** prints candidates for terminal merged/closed PRs (`clean`/`failed`);
  does not change AO state; exit 0.
- [ ] **`-DryRun` negative:** open PR + active worker → not listed; `gh` failure → skip
  with warning, not listed as candidate.
- [ ] **`-Apply`:** when Gate 0 API exists, each listed candidate becomes `outdated` in
  `ao review list --json`; when API absent, exits non-zero with clear message (no JSON
  hand-edit).
- [ ] Recovery runbook + migration notes + go-live checklist document: run after
  `ao start`, DryRun first, #54 vs dashboard cleanup, TRIAGE ≠ CLEAN/FAILED.
- [ ] `.\scripts\verify.ps1` regression guard for script presence and DryRun smoke path.
- [ ] No `ao review send` / `ao review run` from cleanup script.

## Upgrade-safety check

- No `vendor/**` or `packages/core/**` edits in pack PR.
- No invented `ao review` subcommands in this repo.
- No new secrets; uses existing `gh` + `ao` on operator machine.
- No unsupported `reviewer:` YAML block.

## Verification

1. `.\scripts\verify.ps1` — passes including new guard.
2. Fixture/harness: terminal detection cases (§3) without live GitHub when mocked.
3. **Gate 0 manual:** operator records whether AO UI can move a **clean** or **failed**
   card to **outdated** for a merged PR; if not, upstream issue URL in PR.
4. **Manual E2E (only when Gate 0 API exists):** ≥1 stale `clean`/`failed` on merged PR →
   DryRun lists it → Apply → `ao review list` shows `outdated`, dashboard columns updated.
5. **Manual negative:** open PR + active worker → DryRun omits; Apply (if run) does not
   change that run.
