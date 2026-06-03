# Offline bounded-edit preflight for the finding router

GitHub Issue: [#141](https://github.com/chetwerikoff/orchestrator-pack/issues/141) (deferred)

**Queue status:** `deferred` — blocked until draft 50 upstream unblock (A + A′).
Offline logic is valid; **promote → prod** has no target. Unfreeze when Composio AO
ships selective send + programmatic dismiss/backlog. See `00-architecture-decisions.md` §Q.

## Prerequisite

- Finding-routing scorer and gold corpus (file
  `docs/issues_drafts/47-finding-routing-scorer-corpus.md`, GitHub #139) — **must merge
  first**; reuses #47 scorer, `baseline_forward_all`, and reason codes.
- Codex review finding bar (#51) — judge rubric reference only.
- Live routing behavior gate — draft
  `docs/issues_drafts/49-finding-routing-live-behavior-gate.md` — owns churn improvement
  and live judge measurement. This preflight makes **no improvement claim**.
- Shared invariants — [`finding-routing-eval-shared-pack-boundaries.md`](./finding-routing-eval-shared-pack-boundaries.md).
- Selective-send enactment (draft 50) — **hard defer** for this issue until upstream unblock.

## Goal

Offline guardrail **before** draft 49 or runtime promotion (when queue unfreezes): edit hygiene on classifier
artifacts + #47 harness regression (fixtures + **recorded** stub routes). Does **not**
run live Layer B, does **not** measure churn improvement (that is #49 against ratified
gold).

## Binding surface

### Preflight checks

1. **Bounded edit size** — per-file byte bounds as in prior draft (#81 pattern); new
   artifacts use documented new-artifact budget (not 10%-of-zero).
2. **Section discipline** — rubric markdown headings on own lines; one section
   replace/delete per edit unless operator approves.
3. **Few-shot set (judge only)** — separate from gold corpus (#47):
   - Max N examples (default ≤8).
   - **No held-out leakage:** few-shot examples MUST NOT be copied from (or paraphrase)
     #47 **held-out** gold cases. Selection-set examples allowed with `few_shot: true`
     marker in corpus metadata; held-out cases are forbidden in few-shot to prevent
     judge prompt overfitting to the evaluation set.
   - Eviction logged in rejected-edit buffer; sole-class atomic swap for pinned-critical
     examples only.
4. **Rejected-edit buffer** — #47 codes + preflight codes.
5. **Harness regression** — #47 offline scorer self-test on **recorded** predictions;
   no live judge. Does not re-score candidate under live judge (that is #49).
6. **No-improvement-claim** — hygiene only; gates A / A′ / B1 / B2 acceptance is #49.
7. **Judge-config edits** — changes to judge model/temperature/K require a new #49 gate
   run; preflight does not substitute for parity re-check (see #49 judge-config artifact).

## Files in scope

- Preflight scripts, rejected-edit buffer, docs, optional classifier demo edit under
  `plugins/**` or `scripts/**`.
- `docs/issues_drafts/48-finding-routing-bounded-edit-preflight.md`.
- `docs/issue_queue_index.md`.

## Files out of scope

- Gold corpus / scorer — #47.
- Live gate — #49.
- Runtime wiring, `prompts/codex_review_prompt.md`.
- Shared exclusions — [`finding-routing-eval-shared-pack-boundaries.md`](./finding-routing-eval-shared-pack-boundaries.md).

## Denylist

Pack-wide fences:
[`finding-routing-eval-shared-pack-boundaries.md`](./finding-routing-eval-shared-pack-boundaries.md)
§ Denylist. This issue may add classifier-artifact paths under `scripts/` and `tests/**`
when implementing the preflight harness; `prompts/codex_review_prompt.md` stays out of scope.

## Acceptance criteria

- Byte/section bounds enforced on fixture edits.
- Few-shot held-out leakage rule documented and tested (fixture that cites held-out case
  in few-shot → rejected).
- #47 offline self-test passes on PR (recorded routes only).
- No-improvement-claim in docs; points to #49 for churn.

## Upgrade-safety check

- Offline only; no Codex auth for preflight.
- Does not change ratified gold without architect PR.

## Verification

```powershell
.\scripts\verify.ps1
.\scripts\check-reusable.ps1
```

- Static: oversize edit rejected; held-out few-shot leakage rejected.
- Static: #47 self-test still passes after bounded edit.
