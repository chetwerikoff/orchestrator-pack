# Finding-routing scorer and gold corpus (forward / backlog / drop)

GitHub Issue: [#139](https://github.com/chetwerikoff/orchestrator-pack/issues/139)

**Queue status:** `active` — build now (offline corpus + scorer). Prod wiring blocked
until draft 50 upstream (§Q in `00-architecture-decisions.md`). Drafts 48–49 deferred.

## Prerequisite

- Codex review finding bar (file `docs/issues_drafts/19-codex-review-finding-bar.md`,
  GitHub #51) — supplies the **materiality rubric** for gray-zone labels in the gold
  corpus (cosmetic vs substantive; scope/security carve-out).
- Split-channel recovery and JSONL-first verdicts (files
  `docs/issues_drafts/44-codex-review-jsonl-verdict-source.md` GitHub #127,
  `45-codex-review-jsonl-explanation-findings-recovery.md` GitHub #135) — **must be
  on `main` before runtime routing is wired**; the gold corpus includes fail-closed /
  false-clean shapes those issues protect. This issue does not implement recovery.
- Contract-compliance scorer for review **output** (file
  `docs/issues_drafts/28-skill-eval-scorer-corpus.md`, GitHub #80) — **structural
  template only** (corpus split, offline scorer, reason codes). Do not merge the two
  corpora; #80 scores reviewer format, this issue scores **routing decisions**.
- Seed material from the 2026-06-02 review-day triage (op-rev-10…46) is **draft input
  only** — not ground truth until architect ratification (see Binding surface).
- **Feasibility gate (runtime enactment — sibling issue):** per-finding routing in
  **production** is blocked by AO 0.9.x bulk `ao review send` (spike 2026-06-02). See
  § Feasibility gate below and draft
  `docs/issues_drafts/50-finding-routing-selective-send-enactment.md`. This issue (#47)
  and #48–#49 **do not** require that gate to build offline corpus + scorer.
- Follow-ups (same pattern as #80→#81→#30):
  - Offline bounded-edit preflight — draft
    `docs/issues_drafts/48-finding-routing-bounded-edit-preflight.md`
  - Live behavior gate — draft
    `docs/issues_drafts/49-finding-routing-live-behavior-gate.md`

## Goal

Build a regression net for the **finding router** the orchestrator will use after Codex
review delivers hydrated findings: a versioned **gold corpus** (finding + loop state →
route + rationale), plus an **offline scorer** that compares **recorded** classifier
outputs to gold.

Success is **not** “100% recall on pinned only” while shedding real bugs — the degenerate
classifier **forward everything** already has perfect pinned recall. Success is:

1. **Gate A — pinned critical recall:** on `pinned_critical` subset, zero wrongful
   `drop`/`backlog` when gold is `forward` (with documented duplicate-drop exception below).
2. **Gate A′ — non-pinned forward recall:** on fixtures where `gold_route` is `forward`
   and `pinned_critical` is false, zero predicted `backlog` or `drop` (forbids churn wins
   that backlog substantive bugs).
3. **Gate B — churn vs baselines:** improve documented churn metrics vs
   `baseline_forward_all` **and** (for classifiers with Layer B) vs
   `baseline_layer_a_only` without violating gates A / A′.

This issue delivers corpus + scorer + ratification record + docs only — **not** live
Layer B invocation, **not** runtime `orchestratorRules` wiring, **not** production
enactment of per-finding routes (blocked until #50).

## Binding surface

### Feasibility gate — per-finding routing **enactment** (AO 0.9.2)

**Spike result (2026-06-02): production cannot enact per-finding routes today.** The
blocker is the same **granularity mismatch** as #122 / #45 (`sentFindingCount`): bulk
send per run, list with aggregates only.

| What | Offline eval (#47–#49) | Production enactment |
|------|------------------------|----------------------|
| Gold corpus + recorded `predicted_route` | ✅ buildable now | n/a |
| Offline scorer vs gold | ✅ buildable now | n/a |
| #49 run classifier → score routes | ✅ buildable now | n/a |
| Per-finding `forward` vs `backlog` vs `drop` via AO | n/a | ❌ **all blocked** by bulk `ao review send` |
| `prior_sent` for `drop` dedup | simulated in fixtures | ❌ needs history + selective non-send |

**Evidence (AO 0.9.2):** `ao review list` — counts only; `ao review send <run>` — all
open findings; CLI has no `findings list`, no selective send/dismiss. Per-finding JSON
exists under gitignored `code-reviews/findings/` but is not an orchestrator contract.

**Do not read:** «until gate passes, build forward/backlog» as «forward/backlog are
closer to production.» They are closer only for **offline** corpus/scorer. **All three**
routes are spec-ahead-of-substrate for **wiring** until selective-send exists.

**Sibling runtime issue:** `docs/issues_drafts/50-finding-routing-selective-send-enactment.md`
(Gate-0-style spike + contract for selective enactment). Trilogy #47–#49 does **not**
implement #50.

**Gold corpus while enactment is blocked:**

- Build and ratify `forward` / `backlog` fixtures and full scorer gates (A, A′, B1, B2).
- `drop` fixtures only with `deferred: true` and documented dependency on #50 + prior-sent.

**Substrate capabilities (orthogonal; detail in draft 50 Gate 0):**

| Capability | What it enables |
|------------|-----------------|
| **A. Selective enactment** | Send subset, not bulk all-open |
| **A′. Terminal non-forward** | `backlog`/`drop` leave finding non-`open` so rules stop re-firing |
| **B. `prior_sent` visibility** | `drop` dedup; does not replace A or A′ |

Path 2 (pack read-hook) is **not** self-sufficient without upstream A′. See draft 50.

**Out of scope for 47–49:** production `class_tag` drift observability — specified in
draft `50-finding-routing-selective-send-enactment.md` (log + threshold signal); wired
after enactment Gate 0.

### Routing model (three outcomes)

| Route | Meaning |
|-------|---------|
| `forward` | Send to the coding worker (`ao review send` / equivalent). |
| `backlog` | Do not send to worker; persist to a **defined sink** — inspectable process/spec
  debt. **Sinks (planner picks when enactment unblocks):** pack `docs/` backlog file (Issue
  #9 follow-up) **or** native [Composio #1494](https://github.com/ComposioHQ/agent-orchestrator/issues/1494)
  `ao backlog` unified view if available on target AO version. Gold `rationale` MUST name
  which sink class applies per fixture. |
| `drop` | Do not send; **only** when this finding's fingerprint **and** `class_tag` match
an entry already forwarded in `loop_state.prior_sent_fingerprints` for this cycle (see
Fingerprint contract). |

**Fail-open default (runtime):** uncertain → `forward`; immaterial / process → `backlog`
preferred over `drop`. **Eval default:** the scorer still requires the candidate to
match gold on non-critical cases — fail-open is not a license to ignore gold `backlog`.

### Baselines (required references)

1. **`baseline_forward_all`** — every case → `forward`. Perfect gates A/A′ recall,
   **worst** churn. Beating it is necessary but **not sufficient** (almost any dedup wins).
2. **`baseline_layer_a_only`** — Layer A rules only (registry unknown-class forward,
   same-class duplicate drop, P1/pinned/security forward); **no Layer B judge**. This is
   the value floor for accepting a Layer B configuration in #49: full classifier must be
   strictly better on churn than Layer-A-only while preserving gates A / A′ — restoring
   the #30 “improvement over previous version” meaning for routing.

Candidate classifiers must beat **both** baselines on churn (where applicable) while
meeting gates A and A′.

### Gold corpus

#### Case schema (every fixture)

Each case is a record, not an isolated finding:

- `finding` — hydrated structured finding (post-wrapper / #136 shape).
- `loop_state` — at minimum `prior_sent_fingerprints[]` for the review cycle under test;
  may include `review_run_id`, `pr_number`, or other fields the router will use later.
  **Required** for any gold route `drop`; without `loop_state`, `drop` is undefined.
- `gold_route` — `forward` | `backlog` | `drop`.
- `class_tag` — stable theme for dedup (e.g. `false_clean_jsonl`, `prompt_ci_drift`).
- `rationale` — why this route under current #9 / #51 / #127 / #135 contracts.
- `pinned_critical` — boolean; `true` for false-clean / must-reach-worker class (see
  subset below). **Fail-safe at ratification:** if criticality is ambiguous, architect
  sets `pinned_critical: true`. Re-ratification MUST review `pinned_critical` membership,
  not only `gold_route` flips — unpinned critical is outside gate A.
- `prior_sent[]` (recommended shape) — entries `{ fingerprint, class_tag }` sent earlier
  in the loop; `prior_sent_fingerprints[]` alone is insufficient for cross-class safety.

#### Ratification and independence

1. **Draft seed** — 2026-06-02 triage may populate initial fixtures; status `draft`.
2. **Architect ratification** — a human architect sets corpus status to `ratified` in a
   tracked record (planner chooses: `docs/` manifest or fixture header). Ratification is a
   **substantive relabeling pass** (fix misroutes, pin ambiguous critical cases, adjust
   `class_tag` registry) — not a rubber-stamp of model seed labels. Until ratified, the
   corpus MUST NOT be used as the sole gate for production promotion (#49).
3. **Rater ≠ judge under test** — the party that produced draft seed labels MUST NOT be
   the same automated judge instance scored in #49. Architect may edit gold during
   ratification; those edits are ground truth.

#### Versioning and re-ratification

- Corpus carries `corpus_version` and `contracts_snapshot` (refs: #9, #51, #127, #135
  issue numbers or commit SHAs — planner chooses schema).
- When any referenced contract changes in a way that could flip routes (finding bar,
  scope carve-out, JSONL fail-closed/recovery), corpus status returns to `draft` until
  architect re-ratifies affected cases. Docs list trigger events.
- **`known_class_tags` registry** — committed list of `class_tag` values the corpus
  covers. Runtime Layer A uses it for open-world rule (see Classifier shape). Adding a
  new production finding class requires corpus + registry update before Layer B may judge
  it — contract changes alone do not cover distribution shift.

#### Partition

- **Selection** and **held-out** sets recorded in-repo.
- **Pinned critical subset** — all fixtures with `pinned_critical: true` (false-clean
  class). Hard recall gate applies to this subset on **both** selection and held-out.
  Do not treat “100% on 3 held-out cases” as sufficient if the pinned critical set is
  larger — report pinned-critical recall explicitly.
- **Minimum size before gate claims** (documented; enforced in #49): planner sets floors
  (e.g. ≥8 pinned-critical cases total, ≥3 pinned-critical in held-out, ≥6 gray-zone
  forward↔backlog cases for Layer B). Until floors are met, corpus is `draft` only.

#### Required case classes (≥1 fixture each after ratification)

- `forward` + `pinned_critical` — material / false-clean must reach worker.
- `forward` — substantive non-blocking in-scope defect.
- `backlog` — prompt-vs-CI / control-artifact (with backlog sink named in rationale).
- `backlog` — cosmetic / immaterial per #51.
- `drop` — **deferred until #50 enactment + prior_sent** — duplicate same
  `(fingerprint, class_tag)` in `prior_sent` (negative fixture: cross-class collision →
  gold `forward`). Optional placeholder fixtures allowed if marked `deferred: true`.
- `forward` misroute guard — gold `forward`, non-pinned, must not be gold-labeled
  `backlog` (feeds gate A′).

#### Growth and Layer B coverage

- Corpus **grows**; no age-eviction of gold cases. Dedup by **class_tag**, not calendar.
- **Pinned critical** cases are never removed in dedup.
- **Explicit gap plan:** seed day is skewed to critical/fail-closed (~12/18 classes).
  Docs MUST require adding **gray-zone** fixtures (borderline forward vs backlog among
  non-critical findings) until Layer B floors are met — otherwise #49 cannot validate
  the judge.

### Fingerprint contract (safety-critical)

1. **Source:** use the **existing stable finding signature** the pack reviewer wrapper
   already computes and emits to AO (observable: normalized structured-finding fields →
   stable hash on the AO payload). This issue does not invent a second dedup key.
2. **Same-class duplicate only:** `drop` when `(fingerprint, class_tag)` matches a
   `prior_sent` entry. Same fingerprint with **different** `class_tag` → **never** `drop`
   (forward or Layer B) — prevents cross-class collision silent drops.
3. **Pinned + duplicate-drop exception (explicit):** Layer A evaluates duplicate `drop`
   **before** pinned-forward. A `pinned_critical` finding whose `(fingerprint, class_tag)`
   is already in `prior_sent` may be `drop`ped as duplicate; gate A excludes these
   fixtures from “wrongful drop/backlog” (gold route `drop`, `pinned_critical` may be
   true). Corpus MUST include at least one such exception fixture so the scorer does not
   assume pinned always forwards.

### Classifier shape (documented contract; runtime later)

- **Layer A (deterministic), ordered:**
  1. `class_tag` ∉ `known_class_tags` registry → `forward`; **do not invoke Layer B**
     (open-world / generalization gap).
  2. `(fingerprint, class_tag)` ∈ `loop_state.prior_sent` → `drop` (even if
     `pinned_critical` — see exception above).
  3. Else blocking/P1 or `pinned_critical` → `forward`.
  4. Else `security` → `forward`.
  5. Else Layer B **only if** `class_tag` ∈ `known_class_tags`.
- **Layer B (judgment):** gray zone for **known** classes only; `forward` or `backlog`
  (**never** `drop`). **Live** judge calls are **#49 only**.

### Offline scorer (recorded outputs only)

Same pattern as #80: scores **stored** classifier outputs, not live model runs.

1. **Input per case:** gold record + **recorded** `predicted_route` (and optional
   `reason`) from a fixture file, stub, or exported run — including recorded Layer B
   judge outputs when testing full classifier offline.
2. **No Codex/Claude auth in #47** — if a case needs judge output, commit the recorded
   prediction alongside gold; do not invoke live LLM in scorer CI.
3. **Metrics (all vs gold):**
   - **Hard gate A — pinned critical recall:** on `pinned_critical` subset where gold is
     `forward`, 100% — no wrongful `drop`/`backlog` (exclude gold `drop` duplicate-exception
     fixtures from this numerator/denominator).
   - **Hard gate A′ — non-pinned forward recall:** where `gold_route` is `forward` and
     `pinned_critical` is false, 100% — no predicted `backlog` or `drop`
     (`forward_to_backlog_misroute`, `forward_to_drop_misroute`).
   - **Hard gate B1 — vs forward-all:** strict churn improvement vs `baseline_forward_all`
     with gates A / A′ satisfied.
   - **Hard gate B2 — vs Layer-A-only (classifiers with Layer B):** strict churn
     improvement vs `baseline_layer_a_only` with gates A / A′ satisfied — proves judge
     adds value, not only rules.
   - **Reported:** per-route precision/recall, confusion matrix, `spurious_forward`,
     `silent_drop_equivalent` (gold `backlog` → `forward`), cross-class drop attempts.
4. **Stable reason codes** (planner finalizes), e.g. `dropped_critical`,
   `forward_to_backlog_misroute`, `forward_to_drop_misroute`, `churn_not_improved_vs_layer_a`,
   `degenerate_forward_all_only`, `wrong_gray_zone_route`, `unknown_class_sent_to_judge`,
   `cross_class_drop_blocked`, `duplicate_fingerprint_missed`, `missing_loop_state_for_drop`.

### Delivery prerequisite (trust `forward`)

Gold may label `forward`, but **scorer docs and #140 upstream asks** MUST state:
predicted `forward` does not imply the worker received the finding. Composio
[#1943](https://github.com/ComposioHQ/agent-orchestrator/issues/1943) and
[#614](https://github.com/ComposioHQ/agent-orchestrator/issues/614) are delivery
prerequisites — need skipped-reason observability before routing accept/promote in prod.
Offline corpus does not require live dispatch proof; prod wiring does.

### Explicit boundaries (docs)

- Scorer necessary but not sufficient for autoloop; does not replace Codex or scope CI.
- Does not compensate for undelivered findings (#135/#136) or silent dispatch skips (#1943).
- Does not prove reviewer prompt quality (#80 trilogy separate).
- Classifier **design default** (draft 50): pipeline `command` stage + findings JSON →
  `builtin/router` ([#1631](https://github.com/ComposioHQ/agent-orchestrator/issues/1631));
  legacy `ao review` is fallback ([#2088](https://github.com/ComposioHQ/agent-orchestrator/issues/2088)).

## Files in scope

- Versioned gold corpus fixtures under `tests/**` with schema above.
- Ratification manifest under `docs/**` (new).
- Offline routing scorer under `scripts/**` + tests under `tests/**`.
- Docs: gates A / A′ / B1 / B2, both baselines, fingerprint contract, open-world registry,
  pinned+dup exception, ratification (incl. pinned review), versioning, Layer B gap plan,
  backlog sink contract.
- `docs/issues_drafts/finding-routing-eval-shared-pack-boundaries.md`.
- `docs/issues_drafts/47-finding-routing-scorer-corpus.md`.
- `docs/issue_queue_index.md`.
- `docs/issues_drafts/00-architecture-decisions.md` — subsection if needed.

## Files out of scope

- Shared boundaries — [`finding-routing-eval-shared-pack-boundaries.md`](./finding-routing-eval-shared-pack-boundaries.md).
- Runtime `orchestratorRules` / reactions / backlog sink implementation — draft #50
  and follow-up wiring issues.
- Live Layer B judge — draft 49.
- Few-shot eviction — draft 48.
- `prompts/codex_review_prompt.md`.

## Denylist

Pack-wide fences:
[`finding-routing-eval-shared-pack-boundaries.md`](./finding-routing-eval-shared-pack-boundaries.md)
§ Denylist.

## Acceptance criteria

- Corpus schema includes `finding`, `loop_state`, `gold_route`, `class_tag`, `rationale`,
  `pinned_critical`; `drop` fixtures include `prior_sent_fingerprints`.
- `corpus_version` + `contracts_snapshot` + `status` (`draft` | `ratified`) recorded.
- Ratification procedure documented; seed triage marked `draft` until architect ratifies.
- Pinned-critical and gray-zone minimum floors documented; seed gap (Layer B cases) acknowledged.
- Both baselines implemented; forward-all fails B1; Layer-A-only stub for B2 comparisons.
- Offline scorer runs without network/auth on **recorded** predictions only.
- Gates A, A′, B1, B2 enforced in tests; fixture for forward→backlog misroute fails A′.
- Fingerprint: same-class drop fixture + cross-class non-drop fixture; pinned+dup exception
  fixture documented.
- `known_class_tags` registry committed; unknown-class → forward documented.
- Ratification includes pinned_critical membership review on re-ratify.
- Reason codes documented.
- Re-ratification triggers listed for #9 / #51 / #127 / #135 contract changes.

## Upgrade-safety check

- No AO core or vendor edits; no new secrets.
- Does not change #9 / #51 reviewer contracts.
- Gold labels are judgments — versioning discipline is mandatory.

## Verification

```powershell
.\scripts\verify.ps1
.\scripts\check-reusable.ps1
```

- Static: schema-valid fixtures; `drop` cases invalid without `loop_state`.
- Static: forward-all fails B1; candidate that backlogs non-pinned gold forward fails A′.
- Static: full classifier that only beats forward-all but ties Layer-A-only fails B2.
- Static: cross-class fingerprint collision does not produce drop.
- Static: recorded-prediction run without live judge.
- Docs: gates A/A′/B1/B2, both baselines, fingerprint, open-world, pinned+dup exception.
