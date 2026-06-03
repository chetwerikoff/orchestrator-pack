# Live finding-routing behavior gate (classifier improvement measurement)

GitHub Issue: [#142](https://github.com/chetwerikoff/orchestrator-pack/issues/142) (deferred; after #139 + #141)

**Queue status:** `deferred` — same gate as draft 48 (draft 50 upstream A + A′).
Classifier vs gold is runnable offline; **accept → promote** is blocked. §Q.

## Prerequisite

- Finding-routing scorer and gold corpus (#47) — **ratified** status required; dual-metric
  scorer (`pinned_critical` recall + churn vs `baseline_forward_all`).
- Offline bounded-edit preflight (#48) — candidate edits pass first.
- Review delivery on `main` (#135; #136 preferred) — classifies hydrated findings only.
- Finding bar (#51) — judge rubric for gray zone.
- Shared invariants — [`finding-routing-eval-shared-pack-boundaries.md`](./finding-routing-eval-shared-pack-boundaries.md).
- **Gated and human-accepted** — never autonomous production promotion.
- Selective-send enactment (draft 50) — **defer entire issue** until upstream unblock; do not
  spend planner cycles on live judge tuning while prod wiring is impossible.

## Goal

Measure whether a **candidate classifier** (especially Layer B) improves routing vs
**two baselines** from #47. Unlike #80/#30 scalar score, acceptance is **multi-criteria**:

**Safety (all candidates):**

1. **Gate A** — pinned-critical recall 100% (with duplicate-exception fixtures excluded
   per #47).
2. **Gate A′** — non-pinned gold-`forward` recall 100% (no `forward` → `backlog`/`drop`
   churn gaming).

**Value (classifier with Layer B):**

3. **Gate B1** — churn strictly better than `baseline_forward_all` with A / A′ held.
4. **Gate B2** — churn strictly better than `baseline_layer_a_only` with A / A′ held —
   proves the judge adds value over rules alone (#30 “better than previous version” for
   routing). Beating forward-all alone is **insufficient**.

Layer-A-only configuration may be accepted on B1 alone; Layer B promotion requires B2.

## Binding surface

### Preconditions (gate is meaningless without these)

- #47 corpus `status: ratified` and meets **minimum size floors** (documented in #47;
  e.g. pinned-critical and gray-zone counts). Otherwise gate MUST refuse to run with
  `corpus_underpowered`.
- Gold rater independence: the automated judge/config under test MUST NOT be the same
  system/session that produced unratiated draft seed labels. Architect ratification is
  the ground-truth boundary.

### Inputs

Each case = #47 gold record (`finding` + `loop_state` + gold route). Gate runs **live**
classifier (Layer A + live Layer B if present) to produce routes — then scores with #47
offline scorer using those **fresh** predictions compared to gold. Does not re-run Codex
PR review.

### Run procedure

1. **Baselines on selection:** `baseline_forward_all`, `baseline_layer_a_only`, current
   classifier at baseline commit — score all via #47 offline scorer.
2. **Candidate edit** (post-#48) → run full classifier → score.
3. **Variance (LLM judge only):** for `pinned_critical` cases — **zero** samples may
   predict non-`forward`. For gray-zone only — planner documents K/aggregation.
4. **Judge config parity:** a tracked **judge-config artifact** (model id, temperature,
   K, prompt hash — planner chooses schema) is shared between gate runs and production.
   A parity check MUST fail promotion if production config diverges from the config that
   passed the gate (documented procedure).

### Acceptance rule (multi-criteria — not #30 scalar score)

**Hard reject** if any gate A, A′, B1, or (when Layer B present) B2 fails on selection.

**Held-out (blocking before accept):** gates A and A′ on held-out **pinned** and
**non-pinned forward** subsets; B1/B2 churn non-regression vs both baselines on held-out.
Small held-out N is low power — #47 minimum floors still required.

**Improving accept (Layer B classifier)** only if selection **and** held-out pass:
A, A′, B1, **and B2** vs `baseline_layer_a_only`.

**Improving accept (Layer-A-only deployment)** if selection **and** held-out pass:
A, A′, B1 — B2 N/A.

**Maintenance accept:** equal B1/B2 on selection, gates A/A′ on selection+held-out,
classifier artifact size not increased (sum of UTF-8 bytes of judge rubric + few-shot
files + Layer A rule artifacts in scope — same byte budget semantics as #48), operator
labels maintenance.

**Not used:** #30 “strictly higher aggregate score”.

### Attempt cap and held-out hygiene

- **Selection failures** (gates A, A′, B1, B2 on selection) consume the attempt cap
  (default 3–5); normal retry with revised candidate.
- **Held-out failures** (any gate fails on held-out after selection passed) do **not**
  consume a retry slot for tuning against the same held-out. Required actions: expand
  #47 corpus, add fresh held-out cases, or open a new issue — **no** held-out-driven
  hyperparameter loop on the same held-out set (prevents held-out leakage through retries).

### Held-out report

Publish pinned-critical and churn metrics separately; state held-out size and that
small held-out N is low power — gate validity requires #47 minimum floors, not anecdotal
3/3 on full held-out.

### Production promotion

Accept does not edit `orchestratorRules`; separate implementation PR + backlog sink wiring.

## Files in scope

- Live-gate scripts, stubbed CI harness, **judge-config artifact** + parity-check script,
  docs, optional accepted classifier under `plugins/**` or `scripts/**`.
- `docs/issues_drafts/49-finding-routing-live-behavior-gate.md`.
- `docs/issue_queue_index.md`.

## Files out of scope

- Gold corpus / offline scorer — #47.
- Preflight — #48.
- Prompt trilogy #80–#30, delivery fixes #135/#136.
- Shared exclusions — [`finding-routing-eval-shared-pack-boundaries.md`](./finding-routing-eval-shared-pack-boundaries.md).

## Denylist

Pack-wide fences:
[`finding-routing-eval-shared-pack-boundaries.md`](./finding-routing-eval-shared-pack-boundaries.md)
§ Denylist. This issue adds judge harness fixtures under `scripts/` and `tests/**` when
implementing the live gate; `prompts/codex_review_prompt.md` remains out of scope.

## Acceptance criteria

- Gate refuses when corpus not `ratified` or under minimum floors.
- Worked stubs: forward→backlog on non-pinned gold forward → reject (A′); beats
  forward-all but not Layer-A-only → reject B2; passes A/A′/B1/B2 → accept.
- Held-out failure fixture does not allow another attempt-cap retry on same held-out.
- Judge-config parity check documented and tested on fixture drift.
- Multi-criteria + dual baseline documented; #30 scalar disclaimed.
- Independence and ratification documented.

## Upgrade-safety check

- CI uses stubbed classifier; live judge smoke operator-only.
- Pinned-critical constraint non-negotiable.

## Verification

```powershell
.\scripts\verify.ps1
.\scripts\check-reusable.ps1
```

- Static: A′ and B2 enforced; held-out retry hygiene; judge-config parity failure.
- Static: underpowered corpus aborts gate.
- Docs: gates A/A′/B1/B2, Layer-A-only vs Layer B accept paths, held-out retry rule,
  judge-config parity, independence.
- Operator: optional live smoke with real judge.
