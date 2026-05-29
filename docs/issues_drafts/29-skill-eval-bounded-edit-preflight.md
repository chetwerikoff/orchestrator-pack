# Offline bounded-edit preflight for the Codex review prompt

GitHub Issue: #81

## Prerequisite

- Contract-compliance scorer and eval corpus (file
  `docs/issues_drafts/28-skill-eval-scorer-corpus.md`, GitHub #80) — **must merge first**
  and be **proven on `main`**. This preflight reuses #80's scorer + reason codes.
- NO_FINDINGS / structured-finding contract (file
  `docs/issues_drafts/06-codex-reviewer-scope-context.md`, GitHub #9) — unchanged.
- Pairs with the **live prompt-behavior gate** (file
  `docs/issues_drafts/30-skill-eval-live-behavior-gate.md`, not yet synced), which owns
  the actual improvement measurement. This preflight makes **no improvement claim**.
- Adapted from arXiv 2605.23904 ("SkillOpt"): bounded edits ("textual learning rate")
  and a rejected-edit buffer. The strict-improvement / maintenance acceptance rule is
  **not** here — an offline corpus of *stored reviewer outputs* is invariant under a
  prompt edit, so it cannot measure whether an edit improves the prompt. That belongs
  to the live gate (draft 30).

## Goal

A cheap, offline static guardrail that runs **before** any expensive live behavior
gate (draft 30). Given a candidate edit to `prompts/codex_review_prompt.md`, enforce
edit hygiene — bounded size, section discipline, total-size budget, rejected-edit
logging, docs/report discipline — and confirm the #80 scorer corpus still passes
(a regression guard on the harness, not a measure of the prompt). It explicitly does
**not** prove the edited prompt reviews better; that is draft 30's job.

## Binding surface

This issue commits the repository to:

1. **Bounded-edit size discipline (two-axis, byte/section-based, not lines).** Per
   candidate edit the preflight MUST enforce:
   - net added bytes ≤ min(800, 10% of current prompt size in bytes);
   - changed bytes ≤ min(1600, 20% of current prompt size in bytes);
   - reject if the prompt would exceed a documented **total size budget** after the edit.
   `changed_bytes` is defined as `added_bytes + deleted_bytes`, counted in UTF-8 bytes
   from the unified diff of `prompts/codex_review_prompt.md` (not Levenshtein distance,
   not hunk count). `net added bytes` is `added_bytes − deleted_bytes`. Line-based
   bounds are rejected because the prompt packs many concerns into few long lines.
   Planner finalizes tooling; the metrics above are fixed contracts.
2. **Section discipline against existing headers.** `prompts/codex_review_prompt.md`
   already has stable markdown section markers, each on its own line (verified:
   `## Your task`, `## Scope context`, `## Finding bar and calibration`,
   `## Structured finding format`, `## Response format`, `### Clean review —
   NO_FINDINGS`). The preflight binds to those existing headers — not a planner-invented
   scheme — using a parser that keys on a heading at the **start of a line** (`^#{1,6} `).
   A **precondition** the preflight MUST enforce: every markdown heading stays on its
   own line (a candidate edit that moves a heading mid-line is rejected), so the parser
   stays well-defined. The preflight then enforces: at most one named section deleted or
   replaced per edit, and no new top-level (`##`) policy section unless the operator
   approves it in the preflight record.
3. **A rejected-edit buffer.** A tracked log of rejected candidate edits with a
   machine-readable reason, reusing #80's scorer reason codes plus preflight-specific
   ones (e.g. `exceeded_size_bound`, `unauthorized_new_section`,
   `exceeded_total_budget`), so the same dead-end is not re-proposed.
4. **A harness regression guard.** The PR carrying a candidate edit must keep the #80
   scorer corpus passing. This guards the PR from accidentally breaking the
   corpus/scorer — it is **not** a measurement of the prompt edit's quality.
5. **An explicit no-improvement-claim statement.** Docs MUST state that passing this
   preflight only certifies edit *hygiene*; it does **not** establish that the prompt
   reviews better. Behavioral improvement is measured only by draft 30.
6. **Docs/report discipline.** The preflight report restates that gate-passing is
   **necessary but not sufficient** for reviewer-prompt improvement.

## Files in scope

- A new docs page describing the preflight checks, the size/section bounds, and the
  rejected-edit buffer; planner names it.
- The rejected-edit buffer file; planner names it and its location.
- Preflight helper scripts under `scripts/` (and `tests/**` for tests); new files
  allowed.
- `prompts/codex_review_prompt.md` — **only** if a first bounded edit is demonstrated
  through the preflight; otherwise unchanged.
- `docs/issues_drafts/00-architecture-decisions.md` — subsection recording the offline
  preflight (two-axis byte bound, section discipline, no-improvement-claim).
- `docs/issue_queue_index.md` — registry row.

## Files out of scope

- The actual improvement measurement, two-mode acceptance rule, live Codex runs, and
  attempt-cap / overfitting guard — all belong to the live behavior gate (draft 30).
- The corpus and scorer themselves (owned by #80).
- The finding format / `NO_FINDINGS` contract (owned by #9).
- Run-state discipline (owned by #79).
- Any autonomous optimizer that edits prompts without operator acceptance.
- `agent-orchestrator.yaml` / `.ao/**`, `packages/core/**`, `vendor/**`.

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
prompts/codex_review_prompt.md
```

## Acceptance criteria

- **Two-axis size bound enforced.** A candidate edit exceeding the documented
  net-added or changed-byte bound is rejected; a line-only metric is not used.
- **Total budget enforced.** A candidate that would push the prompt past the documented
  total size budget is rejected.
- **Section discipline enforced.** A candidate that deletes/replaces more than one
  existing named section, or adds a new `##` section without recorded approval, or
  moves any markdown heading off the start of its own line, is rejected.
- **Rejected-edit buffer populated.** The buffer records at least one worked-example
  rejection with its machine-readable reason code.
- **Harness regression guard.** The #80 scorer corpus still passes in the PR carrying a
  preflight change.
- **No-improvement-claim documented.** Docs state the preflight certifies hygiene only,
  not that the prompt reviews better, and point to draft 30 for behavioral measurement.
- **Report discipline.** The preflight report states gate-passing is necessary but not
  sufficient for reviewer-prompt improvement.

## Upgrade-safety check

- No edits to Composio AO core or vendored `packages/core/**`; no AO CLI/schema change.
- No new repository secrets. The preflight is **offline** — no Claude/Codex auth and no
  network (this is the whole point of separating it from draft 30).
- `NO_FINDINGS` / finding format (#9), finding bar (#51), run-state discipline (#79),
  and the #80 scorer/corpus contract are unchanged.

## Verification

- **Static — size bound.** A fixture candidate edit exceeding the net-added or
  changed-byte bound is rejected (demonstrable); one within bounds passes.
- **Static — total budget.** A fixture edit that exceeds the total size budget is
  rejected.
- **Static — section discipline.** A fixture edit adding a new `##` section without
  approval is rejected; one changing two named sections is rejected.
- **Static — buffer.** The rejected-edit buffer contains a worked-example rejection
  with a reason code.
- **Static — regression guard.** The #80 scorer corpus passes under this PR.
- **Docs.** The docs page states the no-improvement-claim and necessary-but-not-
  sufficient framing and references draft 30 for behavioral measurement.
