# Live prompt-behavior eval gate for the Codex review prompt

GitHub Issue: TBD (sync only after #80 and #81 land; needs Codex auth + a cost budget)

## Prerequisite

- Contract-compliance scorer and eval corpus (file
  `docs/issues_drafts/28-skill-eval-scorer-corpus.md`, GitHub #80) — provides the scorer
  used to grade produced outputs.
- Offline bounded-edit preflight (file
  `docs/issues_drafts/29-skill-eval-bounded-edit-preflight.md`, GitHub #81) — a
  candidate edit MUST pass the offline preflight before any live run here.
- NO_FINDINGS / structured-finding contract (file
  `docs/issues_drafts/06-codex-reviewer-scope-context.md`, GitHub #9) — unchanged.
- Adapted from arXiv 2605.23904 ("SkillOpt"): this is where the real loop lives —
  re-run the reviewer with baseline vs candidate prompt, score the produced outputs,
  accept under a two-mode rule. **Gated and human-accepted**, never autonomous.

## Goal

Measure whether a candidate edit to `prompts/codex_review_prompt.md` actually changes
reviewer behavior for the better. Unlike #80 (which scores *stored* outputs) and #81
(which only checks edit hygiene), this gate **re-runs the reviewer (Codex) with the
baseline and the candidate prompt** on a corpus of review **input** cases (diff +
declared scope), scores the produced outputs with the #80 scorer, and accepts only
under the two-mode rule. This is **not offline**: it requires Codex auth/network and
acknowledges model variance and cost.

## Binding surface

This issue commits the repository to:

1. **A review-input corpus, distinct from #80's output corpus.** Each case is a review
   *input* — a diff / PR-head plus declared scope (`declared_paths` / globs, and
   `denylist` / `allowed_roots` where relevant) — paired with an expected verdict for
   the produced output. The verdict MUST assert **finding properties**, not just
   "output is contract-valid": for a case that should surface a finding, it specifies
   the required finding(s) (at least `type`, severity, and the expected `path` /
   `code` prefix) and forbidden outcomes (e.g. exact `NO_FINDINGS` is forbidden for a
   case that must flag a scope violation). Otherwise the gate would accept a candidate
   that emits valid JSON yet misses the violation — collapsing back to format
   compliance. Planner chooses the schema; the expressiveness is the contract. Split
   into selection and held-out sets.
2. **A behavioral run procedure.** Run the reviewer with the baseline prompt on the
   selection inputs → score the produced outputs with the #80 scorer → baseline score.
   Apply a candidate edit (which has already passed the #81 preflight) → run the
   reviewer with the candidate prompt on the same inputs → score → candidate score.
3. **Variance handling.** Because model output is non-deterministic, the procedure
   documents how variance is controlled (e.g. multiple samples per case with a
   documented aggregation) so a score delta is signal, not noise. Planner finalizes the
   sampling scheme.
4. **A two-mode acceptance rule.** Improving edit — accept only if the candidate
   selection score is **strictly greater** than baseline. Maintenance edit — accept at
   **equal** selection score only if held-out score is preserved, prompt size does not
   increase, and the operator labels it maintenance. Any edit that lowers the selection
   score is rejected. Rejections are logged to the #81 rejected-edit buffer.
5. **An attempt cap (overfitting guard).** Cap candidate attempts per gate run (small
   N, default 3–5, recorded). After N rejections the run stops and requires expanding
   the corpus or opening a new issue, rather than tuning the prompt against a small
   known selection set. The cap is mandatory, not advisory.
6. **A held-out final report.** After an accept, run the held-out inputs once and
   report. The report template states that gate-passing is **necessary but not
   sufficient** and that this measures contract-compliance of *behavior* — still not
   full reviewer judgment quality (catching every real bug), which would need a labeled
   bug corpus.
7. **Cost / auth discipline.** Docs state this gate requires Codex auth and a cost
   budget, is **not** part of offline CI, and how it is invoked by an operator.

## Files in scope

- A new review-input corpus under the existing test tree (`tests/**`); planner names
  files and layout.
- Live-gate scripts under `scripts/` (and `tests/**` for harness-logic tests); new
  files allowed.
- A new docs page describing the behavioral procedure, variance handling, the two-mode
  rule, the attempt cap, and cost/auth discipline; planner names it.
- `prompts/codex_review_prompt.md` — the accepted edit, if any (optional).
- `docs/issues_drafts/00-architecture-decisions.md` — subsection recording the live
  behavioral gate and its non-offline / cost characteristics.
- `docs/issue_queue_index.md` — registry row.

## Files out of scope

- Edit hygiene (size/section bounds, rejected-edit buffer mechanics) — owned by #81.
- The output scorer and stored-output corpus — owned by #80.
- Shared SkillOpt pack boundaries — see draft 28 § Files out of scope.

## Denylist

Pack-wide fences for the SkillOpt trilogy: draft 28 § Denylist. This issue adds
`prompts/codex_review_prompt.md` to **allowed_roots** when implementing the live gate
and any demonstrated prompt edit.

## Acceptance criteria

- **Input corpus exists and is split**, and is distinct from #80's stored-output corpus
  (each case is a review input + expected verdict, with a recorded selection/held-out
  split). For finding cases the verdict asserts required finding properties (type /
  severity / path / code prefix) and forbidden outcomes (e.g. forbids exact
  `NO_FINDINGS`), so a contract-valid but violation-missing output scores as fail.
- **Behavioral run produces baseline and candidate scores** by re-running the reviewer
  with each prompt over the selection inputs and scoring the produced outputs with the
  #80 scorer.
- **Variance handling documented and runnable** (sampling + aggregation), so a reported
  delta is not single-sample noise.
- **Two-mode rule demonstrated** on a worked example: an improving edit raises the
  selection score and is accepted; a weakening edit is rejected and logged; a
  maintenance edit at equal score with size preserved and held-out preserved is
  accepted, while a size-increasing equal-score edit is rejected.
- **Attempt cap enforced.** A gate run stops after N rejected candidates and directs
  corpus expansion / a new issue.
- **Held-out report.** The accepted edit is reported on the held-out inputs; the report
  states necessary-but-not-sufficient and the behavior-vs-judgment-quality boundary.
- **Cost/auth discipline documented.** Docs state the gate needs Codex auth + budget
  and is not part of offline CI.

## Upgrade-safety check

- No edits to Composio AO core or vendored `packages/core/**`; no AO CLI/schema change.
- `NO_FINDINGS` / finding format (#9), finding bar (#51), run-state discipline (#79),
  the #80 scorer/corpus, and the #81 preflight are unchanged.
- This gate is **deliberately not offline** — it documents its Codex auth / network /
  cost needs rather than hiding them, and harness-logic tests use a recorded/stubbed
  reviewer so CI can validate scoring / two-mode / attempt-cap logic deterministically
  without live auth.

## Verification

- **Static — input corpus.** The review-input fixtures exist under `tests/**` with a
  recorded selection/held-out split and expected verdicts, distinct from #80's outputs.
- **Static — harness logic (stubbed reviewer).** With a recorded/stubbed reviewer,
  worked examples show: improving edit accepted (strictly higher selection score),
  weakening edit rejected + logged, maintenance edit accepted at equal score with size
  preserved, size-increasing equal-score edit rejected, and the attempt cap stopping a
  run after N rejects.
- **Static — variance.** The documented sampling/aggregation is runnable against the
  stubbed reviewer.
- **Docs.** The docs page states cost/auth discipline, necessary-but-not-sufficient,
  and the behavior-vs-judgment-quality boundary, and requires the #81 preflight to pass
  first.
- **Operator — live smoke (manual).** An operator runs one real baseline-vs-candidate
  comparison with Codex auth, outside offline CI, per the documented procedure.
