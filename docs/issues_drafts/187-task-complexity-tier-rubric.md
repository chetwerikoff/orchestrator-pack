# Task complexity tier rubric (T1/T2/T3 intake classification)

GitHub Issue: #574

## Prerequisite

None must merge first. Builds on / references (already shipped — **reused, not rebuilt**):

- `docs/issues_drafts/75-rca-spec-discipline-against-misdirected-fixes.md` (GitHub #221) —
  ships the `behavior-kind` intake declaration (action-producing vs record-only).
  *Relationship:* the tier axis is **orthogonal** — behavior-kind classifies a draft's
  *action shape*, the tier classifies its *complexity/ceremony*. A draft carries both;
  this rubric neither replaces nor edits the behavior-kind gate.
- `docs/issues_drafts/79-rca-design-recommendation-block.md` (GitHub #237) — defines the
  design-analysis block and its **skip line** (operator/runtime, config/YAML, one-line
  spec/rule, typo/rename → skip). *Reused verbatim:* the same skip line is the rubric's
  "below the tier ladder — no ceremony" boundary; the rubric does not invent a new one.
- `docs/issues_drafts/105-graduated-review-intensity-by-change-magnitude.md` (GitHub #329,
  **CLOSED/archived**) — the **review-side** graduation (Codex review effort keyed to PR
  diff magnitude), deliberately decoupled. *Distinguished:* this rubric is the
  **authoring/intake-side** axis and does not reopen or depend on #329.
- `docs/issues_drafts/97-worker-build-minimum-rule.md` (GitHub #301) — worker-stage
  "build the minimum, no unrequested abstraction." *Complementary:* that governs the
  worker's implementation; this governs how much authoring ceremony precedes it.

Downstream (author after this merges, cited here so the split is visible):

- **Draft B (per-tier review flow)** — the lens mandate, accept/reject ownership, reject
  log, drift-escalation, and the **within-T3 graduation decision** (whether the top tier
  needs intensifiers — adversarial review mandatory vs recommended, rollback/migration
  story, crash/race/stale tests — seeded by the L4-condition list recorded in Decisions).
  **Out of scope here** (see Files out of scope).
- **Draft C (`create-issue-draft` tier gate)** — recompute-and-enforce authority and
  conditional stage-skipping. **Out of scope here.**

## Goal

`prompts/agent_rules.md` gains a single authoritative rubric that classifies every
incoming task into one of three complexity tiers before authoring ceremony is chosen,
so that light work stops paying for the full heavy flow while dangerous work cannot buy
its way onto a cheaper path. The rubric states the classification order, the tier
meanings at the level of "how much ceremony," and the invariants that keep the
classification safe (danger dominates size; doubt escalates upward; smallness can only
demote). It is read by every agent surface: the architect uses it as an advisory prior
when proposing a tier, and the worker uses it as a blocking pre-flight re-check before
implementation. This draft ships the **rule and its calibration only** — the recompute
authority and the stage-skipping it authorizes are separate downstream builds.

```behavior-kind
action-producing
```

The primary deliverable is rule text plus a labeled calibration sample; alongside it the
draft ships a **consistency check** that runs over the sample and fails on a violating row
(the observable action — see positive-outcome). The tier *recompute/enforcement* action
(recomputing a task's tier and skipping stages) is a separate build scoped to draft C.

## Binding surface

Commits `prompts/agent_rules.md` to carry a tier-classification rubric with **all** of:

- **A named three-tier taxonomy** (T1 / T2 / T3) with a one-line meaning for each in
  terms of ceremony weight — not implementation.
- **A failure-type lens as the primary framing.** The rubric leads with one question —
  "what is the worst thing this task can break?": text/cosmetics only → T1; local
  behavior of one function or module → T2; a subsystem's behavior or a system guarantee
  (CI gate, recovery, durable state, trust, concurrency, merge safety, operator
  evidence) → T3. The enumerated marker set below is the reference backstop the lens is
  checked against, not the primary walk — a prose rubric applied by an LLM fails by
  attention miss on long enumerations, so the applied text must stay short enough to be
  read in full on every classification (the rubric section carries the lens, the
  ordered algorithm, and the marker list in ≤ ~100 lines; concrete examples live in the
  calibration sample, not in rubric prose).
- **An ordered classification algorithm** with this precedence, stated as a hard order:
  1. **Red-flag markers → unconditional T3.** If any marker is present the task is T3
     regardless of apparent size. The marker set is enumerated and covers at least:
     trust-boundary / auth / permission surfaces; spawn or capability grants;
     concurrency, state-machine, event-ordering, retry; **CI / review gating** (required
     checks, branch protection, merge authorization, fail-closed aggregation);
     **durable state / evidence / provenance** (ledgers, audit logs, snapshots,
     operator-visible state mutation); **test-harness correctness** (fixture isolation,
     real-vs-stub binaries, tests able to pass while proving the wrong thing, fixtures
     able to touch live state); **crash / recovery** (restart mid-phase, stuck or
     orphaned claims/processes, duplicate execution, and the liveness / kill-restart
     thresholds and timeouts that govern them); **external-API transport behavior**
     (retry / fallback / rate-limit / timeout semantics or response-shape assumptions —
     the marker is *changing* that behavior, not the mere presence of an API call); a
     new contract ≥2 future issues depend on; changes spanning multiple
     otherwise-independent surfaces; and genuine ambiguity in what is being asked.
  2. **Only if every marker is silent — size.** Small, obvious, ~1–2 files, self-contained
     → T1. One component needing real design judgment on *how* → T2.
  3. **Doubt escalates up (fail-up).** Between two tiers, take the higher.
- **The demote-only rule for magnitude.** Numeric file/diff ceilings may only
  **disqualify** a task from a lower tier (push it up); they may never **qualify** it into
  T1. Smallness is necessary but not sufficient for T1.
- **The reuse of #237's skip line** as the boundary below T1 (operator/config/one-line/
  typo work carries no tier and no ceremony), stated by reference so the two cannot drift.
- **The orthogonality note to #221 behavior-kind** — both are intake declarations that
  coexist on one draft.
- **The worker pre-flight obligation:** before implementation the worker re-runs the same
  marker check with fresh eyes; if reality is larger than the assigned tier the worker
  **stops and escalates the tier upward** (never silently proceeds, never demotes).
- **A committed labeled calibration sample** — a set of representative real tasks, each
  labeled with its expected tier, the deciding marker (or "size-decided"), and an
  explicit **checked-silent attestation** (which marker classes were checked and found
  absent — the recall guard against attention-miss classification). The sample includes
  boundary-marker cases that MUST land at T3 **and genuine T1 and T2 rows reflecting
  the real queue mix**. The sample is two negative tests at once: the misfile test
  (no dangerous task files as T1/T2) and the **anti-collapse test** — a sample that
  lands almost everything in T3 is evidence the marker set over-triggers and the
  discriminator does no work, not evidence the queue is uniformly dangerous.
  Mechanically: T1 and T2 rows together comprise **≥ 25% of the sample**, with ≥ 2 of
  each, at any sample size.

Deliberately **not** committed here: the mechanism that recomputes or enforces the tier,
the review-stage changes each tier implies, and any change to the architect-review gate.

## Files in scope

- `prompts/agent_rules.md` — new rubric section (placement and heading at planner's
  discretion, consistent with existing section conventions).
- A committed labeled calibration sample (location at planner's discretion — inline in the
  rules doc or a referenced fixture).
- Any test/lint that asserts the calibration sample's internal consistency.

## Files out of scope

- `.claude/skills/create-issue-draft/**` — the tier gate/recompute wiring (draft C).
- Any review-flow surface: the finding-bar prompt, the architect-review gate, accept/reject
  ownership, reject log, drift-escalation (draft B).
- `agent-orchestrator.yaml` / `reactions` — no orchestration change.
- Any `packages/core/**`, `vendor/**`, `.ao/**`.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
prompts/**
docs/**
scripts/**
tests/**
```

## Contract evidence

```contract-evidence
none
```

This draft binds to no upstream runtime producer datum. Its cross-references (#221,
#237, #51, #329, #301) are documentation-consistency references recorded in
**Prerequisite**, not runtime field/event/state/CLI bindings, so no capture row applies.

## Acceptance criteria

1. `prompts/agent_rules.md` contains a tier-classification section naming T1, T2, T3 and
   giving each a one-line ceremony-weight meaning.
2. The section states the classification **order** explicitly: red-flag markers first
   (→ T3 unconditional), size second (T1 vs T2), fail-up third — and a reader can decide a
   task's tier from the text without asking the author. It **leads with the failure-type
   lens** ("what is the worst thing this task can break") with the marker enumeration as
   backstop, and the whole applied section (lens + order + markers) stays within ~100
   lines, examples deferred to the calibration sample.
3. The **marker set** is enumerated and includes every class named in Binding surface;
   each marker, when present, is stated to force T3 irrespective of size.
4. The **demote-only** rule for numeric ceilings is stated: magnitude may disqualify from a
   lower tier but never qualify into T1.
5. The section **reuses #237's skip line by reference** for the no-ceremony boundary and
   **notes orthogonality to #221 behavior-kind**, so neither contract is duplicated or
   contradicted.
6. The **worker pre-flight** obligation is stated: fresh-eyes re-check, blocking upward
   escalation on under-tiering, no silent demotion.
7. A labeled calibration sample is committed with ≥ 8 representative tasks, each carrying an
   expected tier, its deciding marker/"size-decided", and a checked-silent attestation
   (marker classes checked and found absent), and including ≥ 3 boundary-marker cases
   labeled T3 **and ≥ 2 genuine T1 plus ≥ 2 genuine T2 rows, with T1+T2 together ≥ 25%
   of all rows** (the anti-collapse floor — holds at any sample size, not only at 8).
8. A mechanical check asserts the calibration sample's **internal consistency**: no sample
   carrying any enumerated red-flag marker is labeled below T3; every sample has a tier
   in {T1,T2,T3}, a stated decider, and a checked-silent attestation; and the sample
   meets the distribution floor of AC 7 (≥ 2 T1, ≥ 2 T2, ≥ 3 boundary T3, and T1+T2
   together ≥ 25% of all rows). The check fails on a violating sample and on a sample
   below the distribution floor.

```positive-outcome
asserts: the consistency check, run over the committed calibration sample, passes for a well-formed sample and fails when a red-flag-marked sample is relabeled below T3
input: realistic
```

## Upgrade-safety check

- No edits to AO core, `packages/core/**`, or `vendor/**`.
- No `agent-orchestrator.yaml` schema or reactions change.
- No new repository secrets.
- No change to the shipped behavior-kind gate (#221), finding-bar (#51), or architect-review
  gate (#37) — those are referenced, not modified, here.

## Verification

1. `grep`-level: the rubric section exists in `prompts/agent_rules.md` and contains the
   failure-type lens, the ordered algorithm, the enumerated marker set, the demote-only
   rule, the #237 skip-line reference, and the #221 orthogonality note (AC 1–6).
2. The calibration sample file exists with ≥ 8 labeled tasks incl. ≥ 3 boundary→T3 cases,
   ≥ 2 T1 and ≥ 2 T2 rows, each row carrying decider + checked-silent attestation (AC 7).
3. Run the consistency check; it exits 0 on the committed sample. Mutate one boundary sample
   to a sub-T3 label and re-run; it exits non-zero. Relabel T1/T2 rows to T3 until T1+T2
   falls below 25% of rows and re-run; it exits non-zero. Restore. (AC 8 + positive-outcome.)

## Decisions (design analysis)

**Prior art (from the reconnaissance gate).** No existing draft builds a T1/T2/T3 intake
ladder. Adjacent shipped work: #221 (behavior-kind — orthogonal intake axis), #237
(design-block + skip line — reused), #329/#105 (review-side graduation — closed, decoupled),
#51 (finding-bar — extended by draft B, not here), #301 (worker build-minimum —
complementary), #366 (contract-evidence floor — stays on all tiers). The chosen scope
references these and does not re-implement any; the "build it fresh" risk (#95 class) is
avoided by making reuse-vs-add explicit in Prerequisite and Binding surface.

**Critical mechanics.** (1) Ordering is the whole safety property: danger must be evaluated
*before* size, or a small-looking boundary task rides the cheap path — this is the #511
lesson. (2) Monotonic escalation: every rule can only raise the tier (fail-up, demote-only
ceilings, worker upward-escalation); nothing silently lowers it. (3) The rubric is prose
applied by an LLM, so its only mechanical anchor is the labeled calibration sample — the
sample, not the prose, is what a check can hold.

**World practice.** This is triage/severity classification (ITIL severity, CVSS bands,
airport-style "danger keyword → escalate regardless of size"): the field standard is a
short ordered decision list with a dominant hazard gate ahead of a magnitude score, plus a
labeled reference set to calibrate raters. The datarim L1–L4 model this adapts is the same
shape. We deliberately keep it a *rubric*, not a scoring formula, because the hazard gate is
categorical, not additive.

**Architecture sketch.**

```
task in ──▶ [red-flag markers?] ──yes──▶ T3
               │no
               ▼
           [size] ── ~1-2 files, obvious ──▶ T1
               │  ── one component, design ─▶ T2
               ▼ (doubt) fail-up
        assigned tier ──▶ architect prior ──▶ (draft C recompute) ──▶ worker pre-flight re-check ──▶ impl
                                                                            │ under-tiered?
                                                                            └─ blocking escalate up
```

The rubric owns only the left box and the worker pre-flight arrow; recompute (C) and
per-tier review flow (B) consume it.

**Options considered (cost/risk/sufficiency).**
1. **Reference/extend shipped work only** (fold tiering into #221 behavior-kind or reopen
   #329). *Rejected:* #221 is an orthogonal action-shape axis and #329 is review-side and
   closed; overloading either conflates two contracts and mis-cites a decided decision.
   Low build cost, high correctness risk.
2. **Rubric as prose in agent_rules + labeled calibration sample + consistency lint**
   (chosen). *Cheapest sufficient executor:* additive, no shipped contract touched, the
   calibration sample gives a mechanical safety anchor without building a classifier.
   Risk bounded by the sample coverage; enforcement deferred to C where it belongs.
3. **Ship the executable classifier + gate now** (rubric + recompute + stage-skip in one
   draft). *Rejected:* multi-contract, overflows a single reviewable PR, and codes the
   enforcement before the rule text has been review-converged — the decomposition smell the
   skill's gate warns against. Highest cost/risk.

**Full-class enumeration (classification decision → target the class, not one case).**
The decision's input dimensions and the expected tier per equivalence class:

| any red-flag marker | size | ambiguous | → tier |
|---|---|---|---|
| present | any | any | **T3** (marker dominates) |
| absent | small, self-contained | no | **T1** |
| absent | one component, design needed | no | **T2** |
| absent | multi-surface / spreads | no | **T3** (spread is itself a marker) |
| absent | any | yes | **T3** (fail-up on ambiguity) |
| below-ceiling size | — | — | **no effect on its own**: ceilings only disqualify from a lower tier (push up); smallness alone never qualifies into T1 |

These rows become the calibration sample's equivalence classes: the sample must cover each
row, and the consistency check enforces the marker-dominates and no-sub-T3-for-markers rows
mechanically.

**Revision 2026-07-03 (GPT L1–L4 comparison, two independent peer analyses).** An external
L1–L4 proposal was compared against this draft by two independent reviewers (deep-reasoner
and Codex, neither shown the other's answer). Adopted here: (1) five marker-floor
extensions — CI/review gating, durable state/evidence/provenance, test-harness
correctness/self-certifying tests, crash/recovery (incl. liveness/kill-restart thresholds
— the narrowed remnant of a broader "resource budgets" domain judged over-triggering as a
standalone marker), and external-API transport *behavior* (narrowed from "touches an API"
to "changes retry/fallback/rate-limit/shape assumptions"); each maps to a recurring
failure class in this repo's history (green-while-broken CI, evidence fabrication, live
state leaking from fixtures, no-reaper orphans, rate-limit cascades). (2) The
failure-type lens as primary framing with an explicit brevity bound — recall beats
enumeration when an LLM applies prose. (3) The anti-collapse distribution floor on the
calibration sample — with a safety-broad marker set, most tasks in this repo touch a
danger domain, and a rubric that files ~everything as T3 decides nothing; the sample must
prove the sub-tiers still do work. (4) Checked-silent attestations per calibration row.
Deliberately NOT adopted: a fourth public level (the L3/L4 split is real but is
**within-T3 review graduation** — draft B's decision, seeded by the proposal's
L4-condition list: fail-closed/fail-open change, single-winner/lease/claim, recovery
semantics, required-check contract, self-certifying-test risk, live-state mutation,
external side effects, migration/backcompat); an additive `max(size, risk)` scoring
formula (computes size first — this rubric's whole safety property is danger-first,
categorical); per-level process prescriptions (duplicate #237/#301 and draft B's scope);
a wiki knowledge-pack binding (worker context-provisioning, not intake classification —
separate concern, packs do not exist yet). Flag for draft B: the calibration sample's
expected tiers are assigned before B defines what each tier buys; a post-B recalibration
pass is permitted and expected.