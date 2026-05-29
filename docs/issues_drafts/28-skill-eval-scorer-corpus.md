# Contract-compliance scorer and eval corpus for the Codex review prompt

GitHub Issue: #80

## Prerequisite

- NO_FINDINGS / structured-finding contract (file
  `docs/issues_drafts/06-codex-reviewer-scope-context.md`, GitHub #9) — this issue
  treats that contract as the **scored target**; it must remain the single source of
  truth for the output format. This issue does not change the finding format.
- Codex PR review finding bar (file `docs/issues_drafts/19-codex-review-finding-bar.md`,
  GitHub #51) — the material-vs-suppressed calibration is part of what eval cases
  exercise; do not contradict it.
- Tracked Claude wrapper and strict review gate (file
  `docs/issues_drafts/27-tracked-claude-review-and-strict-gate.md`, GitHub #79) — owns
  **run-state** discipline (failed/cancelled run ≠ clean). This issue scores
  **reviewer output**, not run state, and does not duplicate #79.
- This issue is the foundation (corpus + scorer) for two follow-ups, adapted from
  arXiv 2605.23904 ("SkillOpt"): an **offline bounded-edit preflight** (draft
  `docs/issues_drafts/29-skill-eval-bounded-edit-preflight.md`) that enforces edit
  hygiene on a candidate prompt edit, and a **live prompt-behavior gate** (draft
  `docs/issues_drafts/30-skill-eval-live-behavior-gate.md`) that actually re-runs the
  reviewer to measure improvement. The offline corpus here cannot measure a prompt
  edit's effect — that is the live gate's job.

## Goal

Build a regression net for `prompts/codex_review_prompt.md`: a tracked corpus of
**reviewer-output samples** paired with expected machine verdicts, plus an offline
scorer that decides pass/fail strictly from the published output contract. After this
issue, any future change to the review prompt (or its parser) can be scored against a
fixed corpus to detect whether contract compliance held, before changes go through the
normal worker/PR + Codex review flow.

Scope is deliberately narrow:

- The scorer evaluates **stored samples of reviewer output**, not live Codex runs on
  real diffs. It measures **contract/format compliance** only — not reviewer
  *judgment quality* (did the review catch the real bug), which would need a labeled
  corpus we do not have.
- This issue does **not** modify `prompts/codex_review_prompt.md` and does **not**
  build the bounded-edit acceptance gate. Those are the follow-up (draft 29).

## Binding surface

This issue commits the repository to:

1. **A fixed corpus of reviewer-output eval cases.** A set of cases, each pairing a
   sample of reviewer output with an expected machine verdict, covering at least: a
   clean review that must be exactly `NO_FINDINGS`; a structured-findings review that
   must parse as the single JSON object with all mandatory fields present; a
   `scope-violation` / `security` finding that must not be suppressed or downgraded;
   forbidden clean-review prose (e.g. "LGTM", "No concrete bugs were identified") that
   must score as fail; output missing a mandatory field that must score as fail. Each
   case's expected verdict MUST be expressive enough to assert what the scorer has to
   check — for a findings case, at least the required `type` / severity and the
   presence of `path` and `source` — not merely a bare pass/fail (planner chooses the
   schema and field names). Negative cases (e.g. forbidden prose, missing field,
   downgraded scope-violation) are **committed fixtures** with `expected: fail`, not
   produced by mutating a passing sample at test time. The corpus is split into a
   **selection** set and a **held-out** set, with the partition recorded in the repo
   (not implicit). Run-state outcomes (failed/cancelled) are out of scope — see #79.
2. **An offline scorer.** A repo-tracked check that, given a reviewer-output sample
   and an expected verdict, produces a pass/fail (and an aggregate score over a case
   set) strictly from the published output contract — not from reading a human's
   intent, and without requiring Claude/Codex auth or network. On failure it MUST emit
   a **stable, machine-readable reason code** (e.g. `not_exact_no_findings`,
   `forbidden_prose`, `json_parse_error`, `multiple_json_objects`,
   `missing_mandatory_field`, `non_suppressible_finding_downgraded` — planner finalizes
   the set) so the follow-up gate can log and de-duplicate rejections by reason.
3. **A boundary statement in docs.** Docs make explicit that the scorer is a
   **pre-filter / regression net**, not a replacement for Codex review or the PR scope
   guard, that it scores stored output samples rather than live runs, and that it
   covers contract compliance only — not review judgment quality. Docs MUST state:
   passing the scorer is **necessary but not sufficient** for improving reviewer
   effectiveness (a prompt can be perfectly contract-compliant yet miss real bugs).
   The offline edit-hygiene preflight that uses this scorer lives in draft 29; actual
   behavior measurement (re-running the reviewer) lives in draft 30 — not here.

## Files in scope

- New reviewer-output eval fixtures under the existing test tree (`tests/**`); planner
  names files and layout.
- A new scorer script under `scripts/`; planner names it.
- Scorer tests under the existing Pester tree (`tests/powershell/**`) if the planner
  adds them; new files allowed.
- A new docs page describing the corpus and how to run the scorer, including the
  boundary statement; planner names it (e.g. under `docs/`).
- `docs/issues_drafts/00-architecture-decisions.md` — new subsection (next letter
  after the latest) recording the contract-compliance-scorer decision and its
  output-contract-only scope.
- `docs/issue_queue_index.md` — registry row for this draft.

## Files out of scope

- `prompts/codex_review_prompt.md` — **not edited** this issue (no prompt change).
- The bounded-edit acceptance gate, "textual learning rate" bound, rejected-edit
  buffer, anti-bloat bound, maintenance-edit mode, and worked accept/reject examples
  — split across follow-up drafts 29 (offline preflight) and 30 (live behavior gate).
- The finding format / `NO_FINDINGS` contract itself (owned by GitHub #9) — reused,
  not changed.
- Run-state discipline (failed/cancelled run ≠ clean) — owned by GitHub #79.
- Scoring reviewer **judgment quality** (did the review catch the real bug) — needs a
  labeled corpus; out of scope.
- Eval harnesses for other skills (`create-issue-draft`, `agent_rules.md`,
  `direct-fix-checklist`, `investigate_root_cause.md`) — separate follow-up drafts.
- `agent-orchestrator.yaml` / `.ao/**` (gitignored live files).
- `packages/core/**`, `vendor/**`, AO upstream schema or CLI changes.

## Denylist

```denylist
vendor/**
packages/core/**
code-reviews/**
.ao/**
```

```allowed-roots
scripts/**
tests/**
docs/**
```

## Acceptance criteria

- **Corpus exists and is split.** A tracked set of reviewer-output eval cases exists,
  each declaring its expected machine verdict, partitioned into a selection set and a
  held-out set, with the partition recorded in the repo (not implicit).
- **Required case classes present.** The corpus includes at least one case for each:
  exact `NO_FINDINGS` clean; valid single-JSON findings object; non-suppressible
  `scope-violation` or `security` finding; forbidden clean-review prose → fail;
  missing-mandatory-field → fail. (Run-state cases are excluded — see #79.)
- **Scorer is mechanical.** Running the scorer over the corpus reports a pass/fail per
  case and an aggregate score, decided only from the published output contract.
- **Negative fixtures are committed.** A committed clean-review-with-prose case (e.g.
  "LGTM") scores as fail, and a committed missing-mandatory-field case scores as fail,
  without the test mutating any working-tree file.
- **Failures carry reason codes.** Each failing case yields a stable machine-readable
  reason code (per the documented set), not just a boolean.
- **Scorer is offline.** The scorer runs against tracked fixtures with no Claude/Codex
  auth and no network.
- **Boundary documented.** Docs state the scorer is a regression-net pre-filter (not a
  review replacement), scores stored output samples (not live runs), covers contract
  compliance only — not judgment quality — and that passing is necessary but not
  sufficient for reviewer effectiveness, consistent with #9, #51, #79.

## Upgrade-safety check

- No edits to Composio AO core or vendored `packages/core/**`; no AO CLI/schema change.
- No new repository secrets. The scorer runs offline against tracked fixtures.
- The `NO_FINDINGS` / structured-finding contract (GitHub #9) and the finding bar
  (GitHub #51) are unchanged by this issue.
- `prompts/codex_review_prompt.md` is unchanged by this issue.

## Verification

- **Static — corpus.** The eval-case fixtures exist under `tests/**` with the required
  case classes and a recorded selection/held-out split; reading them shows each case's
  expected verdict.
- **Static — scorer over corpus.** Running the scorer over the committed corpus passes
  on the positive samples and fails on the committed negative fixtures, reporting an
  aggregate score and a reason code per failing case — without mutating any file.
- **Static — offline.** The scorer completes against fixtures on a machine with no
  Claude/Codex auth and no network.
- **Docs — boundary.** The docs page states the regression-net / pre-filter framing,
  the stored-samples-not-live-runs scope, and the contract-compliance-only scope,
  consistent with #9, #51, and #79.
