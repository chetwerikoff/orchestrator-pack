# Deterministic, explicitly-selected reviewer that preserves the AO review layer

GitHub Issue: #86

## Prerequisite

- Tracked Claude wrapper + strict review gate
  (`docs/issues_drafts/27-tracked-claude-review-and-strict-gate.md`, GitHub #79,
  merged) — the two tracked per-reviewer wrappers
  (`scripts/run-pack-review.ps1` Codex, `scripts/run-pack-review-claude.ps1`
  Claude), the strict gate `scripts/invoke-pack-review-strict-gate.ps1`, the
  shared helper `scripts/lib/Get-PackReviewCommand.ps1`, and `verify.ps1` fixture
  wiring are the baseline this issue builds on. This issue does **not** change the
  wrappers' review behaviour or the NO_FINDINGS contract.
- NO_FINDINGS pack-wrapper contract
  (`docs/issues_drafts/06-codex-reviewer-scope-context.md`, GitHub #9) — stdout
  finding format (`NO_FINDINGS`, structured JSON, npm preflight off stdout) is
  unchanged; this issue changes **which executor runs and how that choice is
  made**, not the output format.
- Autonomous review loop
  (`docs/issues_drafts/11-orchestrator-autonomous-review-loop.md`, GitHub #28) —
  the loop reads `ao review list --json` run statuses, `ao review send`, ping /
  respawn, round-limit, and the merge-gate. This issue MUST keep every review on
  the `ao review run --execute --command <…>` path so runs continue to appear in
  that ledger; no bypass of AO is permitted.
- Launch-safe `orchestratorRules` (GitHub #55, closed) — REVIEW_COMMAND stays a
  named line in rules text; runtime `--command` is passed only on the shell, no
  embedded `"` inside the YAML literal.
- **CI context:** `scripts/verify.ps1` runs in `.github/workflows/scope-guard.yml`
  with no AO daemon, no `~/.agent-orchestrator/`, and no live `gh`. Any gate logic
  added here MUST still pass in CI without them.

**Open question (pre-sync review).** The mandated critical Codex pass on this draft
could not run — Codex CLI is over its usage limit until 2026-06-02. A Claude
self-review against the planner-freedom checklist was substituted (no prescribed
signatures, observable acceptance criteria, correct fences). Re-run the Codex draft
review when quota resets and fold any P0/P1 findings back into this draft.

## Goal

Make the **executor selection deterministic and explicit** so the orchestrator
always runs the reviewer the operator named (Claude today, Codex tomorrow, by a
single deliberate switch), while preserving the entire AO review layer the
autonomous loop depends on.

Observed failure (2026-05-29, PR #84 episode): the live REVIEW_COMMAND named the
Claude wrapper, yet the first review run of the episode executed the Codex wrapper
and only switched to Claude reactively after Codex failed on a usage limit;
subsequent runs also drifted from the configured path (`scripts/...` vs `.ao/...`
basename aside, the executor was chosen by the orchestrator, not by config). Root
cause (5 Whys): the `--command` string is **assembled by the orchestrator (an LLM)
from rules prose each turn**, with the bare `ao review run --execute` path silently
defaulting to built-in Codex. Selection is therefore non-deterministic and
wrong-by-default. Discipline prose (already ~6 warnings in the example YAML) cannot
fix an LLM-discretion problem; the choice must become **data the entrypoint reads**,
not a decision the orchestrator makes.

## Binding surface

This issue commits the repository to:

1. **Single reviewer-agnostic review entrypoint.** The orchestrator names **one
   constant command** in REVIEW_COMMAND whose script basename does **not** encode
   which reviewer runs. That entrypoint resolves the reviewer from the explicit
   selector below and dispatches to the existing tracked per-reviewer wrappers.
   The entrypoint MAY be a new script or an evolution of an existing wrapper; the
   planner picks the basename, and the example YAML, gate, diagnose, and docs all
   reference that one basename consistently.

2. **One canonical selector (single source of truth).** Which reviewer runs is
   set in exactly **one** explicit operator-controlled place (form is the
   planner's choice — e.g. an environment variable or a small config value). It
   recognises at least `claude` and `codex`. The entrypoint, the strict gate, and
   the diagnose path all derive the expected reviewer from this one source; none
   reimplements the selection. Mode-2 invariant: the executor choice is no longer
   duplicated across the REVIEW_COMMAND string and gate expectations — it has one
   home.

3. **Fail-closed on unset/unknown selector.** When the selector is missing or has
   an unrecognised value, the entrypoint exits non-zero with a clear message and
   runs **no** reviewer. It MUST NOT silently fall back to Codex or any default
   executor.

4. **AO layer preserved unchanged.** Every review still runs through
   `ao review run --execute --command <entrypoint>`, so the run lands in
   `ao review list --json` with the same status vocabulary
   (`needs_triage` / `waiting_update` / `clean` / `outdated` / `failed` /
   `queued` / `preparing` / `running` / `cancelled`). The entrypoint emits the
   same stdout contract (NO_FINDINGS / structured JSON) with npm preflight off
   stdout, so AO records `clean` / `needs_triage` exactly as the existing wrappers
   do. `ao review send`, reconciliation, ping / respawn, round-limit, and the
   merge-gate are not modified and keep working as-is.

5. **Selector-aware strict gate (extends #79).** "Drift" is broadened: a run whose
   executed reviewer differs from the explicit selector is a fail-closed violation,
   in addition to the existing empty-failed and forbidden-script checks. In fixture
   (CI / `verify.ps1`) mode the expected reviewer is encoded in the committed
   fixture; in `-Live` / `-Strict` mode it is read from the operator selector. The
   gate's fixture path still invokes no `ao`, no `gh`, and no network.

6. **Docs describe switching by flipping the selector**, in one place, instead of
   rewriting the REVIEW_COMMAND line per reviewer. The example YAML carries the
   single reviewer-agnostic REVIEW_COMMAND, free of "canonical Codex vs TEMP
   Claude" framing.

## Files in scope

- `agent-orchestrator.yaml.example` — single reviewer-agnostic REVIEW_COMMAND line;
  document the selector and the fail-closed behaviour in `orchestratorRules`.
- `scripts/` — review entrypoint (new or evolved wrapper) and selector resolution;
  extend the strict gate to compare executed reviewer against the selector.
- `scripts/lib/` — extend the shared helper so gate and diagnose share one selector
  / expected-reviewer resolver (no duplicate parsing).
- `scripts/orchestrator-diagnose.ps1` — `-Strict` honours the selector-mismatch
  violation under the same inputs as the gate.
- `scripts/verify.ps1` — wire any new fixtures into the fixture-only CI gate path.
- Committed gate fixtures (under `scripts/` or `tests/`, planner's choice) covering
  selector-vs-executed match and mismatch for both reviewers.
- `docs/reviewer-switch-runbook.md`, `docs/migration_notes.md`,
  `docs/orchestrator-autoloop-go-live.md` — switching = flip the selector; note the
  operator migration of the live (gitignored) YAML to the new entrypoint.
- `docs/issues_drafts/00-architecture-decisions.md` — new subsection **K** (next
  letter after J) recording this decision; sync to GitHub #3 in the same PR.
- `docs/issue_queue_index.md` — registry row for this draft.

## Files out of scope

- Live `agent-orchestrator.yaml` (gitignored operator file). The operator migrates
  it to the new entrypoint separately; this issue only documents that step.
- `.ao/**` — not a spec source; the deprecated `.ao/run-pack-review-claude.ps1`
  bridge is not revived or referenced as canonical.
- `plugins/ao-codex-pr-reviewer/**` review behaviour and the NO_FINDINGS / finding
  format (GitHub #9) — unchanged.
- The two existing wrappers' review semantics (GitHub #79) — they remain the
  dispatch targets; this issue does not rewrite how they review.
- Upstream AO product default for `ao review run --command` (an upstream gap; the
  entrypoint is the in-repo workaround, not an AO core change).
- AO core, `vendor/**`, `packages/core/**`, AO schema or CLI changes.
- Worker-facing rules and the auto-fix loop reaction wiring.

## Denylist

Pack-wide fences match
[`27-tracked-claude-review-and-strict-gate.md`](./27-tracked-claude-review-and-strict-gate.md)
§ Denylist (`vendor/**`, `packages/core/**`, `code-reviews/**`) plus `.ao/**` in
denylist and `allowed-roots` for `scripts/**`, `tests/**`,
`agent-orchestrator.yaml.example`, `docs/**` — same literals as that draft, extended
with `.ao/**` only where this issue forbids the deprecated bridge path.

## Acceptance criteria

- **Reviewer-agnostic command.** The REVIEW_COMMAND in
  `agent-orchestrator.yaml.example` is a single line whose script basename does not
  contain `claude` or `codex` and is not under `.ao/`.
- **Selector drives the executor.** With the REVIEW_COMMAND unchanged, setting the
  selector to `claude` causes a review run to execute the Claude wrapper, and
  setting it to `codex` causes it to execute the Codex wrapper — observable via the
  run's `terminationReason` / resolved script in `ao review list --json` (or the
  entrypoint's own resolution output in a dry run).
- **Fail-closed default.** With the selector unset or set to an unrecognised value,
  the entrypoint exits non-zero, emits a clear message, and runs no reviewer; no
  Codex (or other) fallback occurs.
- **AO layer intact.** A review run through the entrypoint appears in
  `ao review list --json` and reaches `clean` (on NO_FINDINGS) or `needs_triage`
  (on real findings) exactly as a direct wrapper run would; npm preflight output
  does not appear in the run's findings.
- **Selector mismatch fails closed.** A committed fixture whose executed reviewer
  differs from its encoded selector causes `scripts/verify.ps1` and
  `scripts/orchestrator-diagnose.ps1 -Strict` to exit non-zero; a matching fixture
  passes.
- **CI stays offline.** The `verify.ps1` gate path runs the new checks on fixtures
  only, invoking no `ao`, no `gh`, and no network.
- **Docs aligned.** `reviewer-switch-runbook.md` and `migration_notes.md` describe
  switching reviewers as changing the single selector value, and note the operator
  step to point the live YAML at the new entrypoint.
- **Decision logged.** `00-architecture-decisions.md` has subsection K describing
  the reviewer-agnostic entrypoint + canonical selector, synced to GitHub #3 in the
  same PR.

## Upgrade-safety check

- No edits to AO core, `vendor/**`, or `packages/core/**`; no unsupported
  `reviewer:` YAML field.
- `orchestratorRules` literal stays free of embedded `"` (GitHub #55).
- `scripts/verify.ps1` on a clean checkout with no AO install MUST still pass
  (fixture-only gate).
- Selector resolution and any live preflight (`claude` / `codex` on PATH) run only
  behind the live/operator path, never in the CI fixture gate.
- NO_FINDINGS / finding format (GitHub #9) and the #79 wrappers' review behaviour
  are unchanged.
- No new repo secrets.

## Verification

- **Static — agnostic command.** `Test-Path` the entrypoint; grep
  `agent-orchestrator.yaml.example` shows the reviewer-agnostic REVIEW_COMMAND
  (no `claude`/`codex` basename, no `.ao/`).
- **Behavioural — selector dispatch (operator / live).** Set selector to `claude`,
  run `ao review run <session> --execute --command <entrypoint>` → result is
  `clean` or `needs_triage` and the resolved script is the Claude wrapper; repeat
  with selector `codex` → resolved script is the Codex wrapper, same REVIEW_COMMAND.
- **Behavioural — fail-closed.** Unset / corrupt the selector, invoke the entrypoint
  directly → non-zero exit, clear message, no reviewer launched.
- **Static — gate fixtures.** `scripts/verify.ps1` passes on the committed
  match fixtures; a selector-vs-executed mismatch fixture (and an empty-failed
  fixture) fail verify; the job invokes no `ao` / `gh` (grep or documented gate
  header contract).
- **Static — diagnose strict.** On the mismatch fixture,
  `scripts/orchestrator-diagnose.ps1 -Strict` exits non-zero; without `-Strict`,
  exits 0 with WARN.
- **Manual — switch doc.** Following `reviewer-switch-runbook.md`, flipping the
  single selector value swaps the executed reviewer with no REVIEW_COMMAND edit.
