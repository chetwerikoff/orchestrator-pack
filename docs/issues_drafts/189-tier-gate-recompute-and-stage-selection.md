# Tier gate: recompute authority and per-tier stage selection

GitHub Issue: #576

## Prerequisite

Depends on (must merge first):

- `docs/issues_drafts/187-task-complexity-tier-rubric.md` (GitHub #574) — the T1/T2/T3
  rubric, marker set, and calibration sample this gate recomputes from and enforces.
- `docs/issues_drafts/188-per-tier-review-flow-finding-ownership.md` (GitHub #575) — the
  per-tier review pipeline (T1/T2/T3 stage sequences and caps), finding ownership, ledger,
  and the drift-escalation whose recompute mechanism #188 explicitly delegates here.

Builds on / references (already shipped — **reused/gated, not rebuilt**):

- `docs/issues_drafts/79-rca-design-recommendation-block.md` (GitHub #237) — the pre-draft
  design-analysis gate (≥3 options, world practices, full-class enumeration) and its skip
  line. **Gated here:** this is exactly the authoring stage the tier selector runs on T3,
  lightens on T2, and skips on T1 — the skip line is reused, not re-invented.
- `docs/issues_drafts/75-rca-spec-discipline-against-misdirected-fixes.md` (GitHub #221) —
  behavior-kind gate. **Floor:** runs on every tier, never skipped.
- `docs/issues_drafts/117-spec-contract-evidence-grounding-gate.md` (GitHub #366) —
  contract-evidence gate. **Floor:** runs on every tier, never skipped.

**Missing dependency (to be authored as its own prerequisite draft):** the B/C series
assumes drafts are authored by a **Cursor draft-author session working from the
architect's (Opus) brief**, while the shipped `create-issue-draft` skill still names the
architect as the authoring party. The relocation of authoring into the Cursor session is
an unbuilt prerequisite owned by a separate draft (not this one); this gate's role split
(draft author runs the gate, architect is the escalation target) activates when that
relocation lands, and is exercised by the architect-as-author in the interim.

Downstream (follow-up drafts, deliberately not built here):

- **PR-scope-guard tier-fence consumption** — teaching `scripts/pr-scope-check.ps1` to
  read and act on the tier fence is a worker-PR-path change owned by a follow-up draft.
- **Retrospective misfile detector** — a T1/T2-fenced task whose worker PR later draws a
  danger-class review finding is evidence of a mis-tier; detecting it and feeding a new
  calibration row back to #187's sample is the *backward* catch this forward-only gate
  cannot provide. Follow-up draft.
- **Calibration-sample refresh obligation** — the standing duty to add rows when new
  failure classes ship (#187 and #188 both flag it as expected). Follow-up draft, same
  owner as the misfile detector.

## Goal

Give the `create-issue-draft` skill a **tier gate** that turns #187's rubric and #188's
per-tier flow from advisory prose into enforced behavior. The gate **recomputes** a task's
tier from the #187 rubric — the architect's brief tier is an **advisory prior only, not
authority** — and **selects which authoring and review stages run** by the recomputed tier:
the #237 design-analysis gate and the adversarial stages run in full on T3, lightly on T2,
and are skipped on T1, while #188's per-tier review pipeline (its counts are authoritative
here) is selected to match. A **safety floor runs on every tier and is never skipped**. A
**fail-closed marker screen** refuses any below-floor assignment — a task carrying a
red-flag marker signal cannot take a T1/T2 fast path or have design/adversarial stages
skipped; it escalates to the architect. Escalation is **blocking**: on any upward recompute
the gate stops, runs the skipped stages, and resumes. The gate governs `create-issue-draft`
authoring only; the worker PR-code path is unchanged.

```behavior-kind
action-producing
```

The gate enacts observable actions — recompute, stage selection/skip, fail-closed refusal
with escalation, and post-review drift recompute. The mechanically enforced core is the
tier-gate guard (see positive-outcome).

## Binding surface

Commits `create-issue-draft` to a tier gate with **all** of:

- **Recompute authority.** The gate recomputes the tier from the #187 rubric at authoring
  time, **over the brief text**; the architect brief tier is an **advisory prior** the gate
  may override upward. The recomputed tier is written to the issue body as a
  **machine-readable tier fence**. This draft owns the fence as a written record and its
  worker pre-flight readership (#187's shipped obligation); teaching the PR-scope-guard to
  consume it is the follow-up draft named in Prerequisite, not bound here.
- **Per-tier stage selection.** By recomputed tier the gate runs/skips authoring + review
  stages: **T1** skips the #237 design-analysis gate and the adversarial stage; **T2** runs a
  light design pass, no competitive stage; **T3** runs the full #237 gate and #188's T3
  review pipeline. Review-stage sequences and caps are **read from #188** (not restated
  here) — this gate selects *which* pipeline runs, it does not define or alter the counts.
- **Never-skipped safety floor.** Regardless of tier the gate always runs: the worker-safety
  contract (goal, allowed-roots/denylist, verification/acceptance criteria), the #366
  contract-evidence gate, the #221 behavior-kind gate, and #188's finding-ledger/carve-out
  guard. These shipped checks are **invoked, not rebuilt** — the gate adds the wiring that
  makes them unconditional at every tier. Only design-analysis and adversarial stages are
  tier-gated; the floor is not.
- **Fail-closed marker screen (the enforcement anchor).** Before honoring any T1/T2
  fast-path or stage skip, the gate runs a **conservative red-flag-marker screen** —
  **at intake over the brief text, and post-review over the final draft text** (the two
  texts differ materially; accepted findings accrete scope into the latter). The screen's
  vocabulary is **#187's marker set verbatim** — one vocabulary, no gate-local lexicon that
  could drift from the rubric. The screen is built as **reusable logic** so future
  consumers (the worker pre-flight, the scope-guard follow-up) can call the same
  implementation instead of growing parallel lexicons — #187's worker pre-flight is an
  agent obligation today, so **enabling sharing is bound here; wiring other consumers is
  not**. Matching heuristics beyond the pinned vocabulary are at the implementing
  planner's discretion. A
  marker-signal hit against a below-T3 assignment, or against skipped design/adversarial
  stages, **fails the gate** and escalates to the architect. It **fails closed**: a false
  positive costs an architect confirmation, never a silent cheap-path pass; text the screen
  cannot classify escalates to T3. The screen never *passes* by failing to parse.
- **Sync coupling (who enforces the enforcer).** The gate runs inside the same session
  whose under-tiering it polices, so "blocks sync" must be mechanical, not prose: the
  issue-body sync path (`scripts/publish-issue-body-sync`) **refuses to create or edit**
  when the tier-gate guard has not passed for the draft — the same publish-path pattern
  #366 established for contract-evidence. The draft author cannot reach GitHub around a
  failing gate; guard order with #188's finding-ledger guard is stated and the two are
  independent (either failing blocks).
- **Below-the-ladder inputs (#237 skip line) — marker dominance holds.** A task on the
  #237 skip line (operator/config/one-line/typo) carries **no tier fence and no ceremony**,
  and the gate short-circuits the stage selector for it — **but the marker screen still
  runs first**. A danger-marked one-liner (e.g. a one-line CI-gate or claim-logic change)
  is a rule-1 marker hit: it cannot use the skip line and escalates like any marked task.
  Smallness never overrides a marker — the skip line is subordinate to the screen.
  **Receipt shape:** the guard emits a passing **no-tier (skip-line) receipt** for such
  inputs after the screen passes — the sync path accepts either a tier-fence receipt or a
  no-tier receipt, so skip-line drafts are neither blocked nor a bypass: every sync still
  carries a guard receipt, and the screen ran in both shapes.
- **Wrapper inheritance and explicit-invocation floor.** The adversarial wrapper skills
  (`adversarial-draft-review`, `discuss-with-gpt`) route through `create-issue-draft` and
  inherit this gate — they cannot bypass it. In the other direction, an **explicit
  user invocation** of an adversarial wrapper **floors the effective tier at ≥ T2 and
  preserves the requested adversarial stage** regardless of recompute: a T1 recompute must
  not silently delete a review loop the operator explicitly asked for.
- **Blocking mid-flight escalation.** On any upward recompute — at authoring, after the
  marker screen, or post-review — the gate **stops**, raises the tier fence, **runs the
  now-required skipped stages**, then resumes. It never syncs at a tier below the recomputed
  one; downward movement is impossible (the #187 monotonic rule). **Fence lifecycle after
  first sync:** if the escalation happens after the issue body has already been synced, the
  gate **re-syncs the issue body with the raised fence** (via the same sync path) before
  proceeding — a stale below-recompute fence on GitHub is a gate failure, not a cosmetic lag.
- **Post-review drift recompute.** After the review loop the gate recomputes the tier **on
  the final draft text** (not the brief — accepted findings accrete scope); upward drift
  escalates to the architect before publish. This is the recompute #188's drift-escalation
  invokes.
- **T1 calibration assumption (one line, no machinery).** T1's fast path assumes #187's
  calibration sample merged consistent — which #187's own merge-blocking AC guarantees. If
  the sample is later found inconsistent, T1 deactivates pending recalibration. No runtime
  calibration-state plumbing is built here.

Deliberately **not** committed here: the rubric text and calibration sample (#187), and the
review-section content — pipeline definitions, ledger format, finding-ownership, carve-out
guard (#188).

## Files in scope

- `.claude/skills/create-issue-draft/**` — the **tier gate**: recompute, per-tier stage
  selection, the never-skipped floor wiring, blocking escalation, and post-review recompute.
  (The review-section content — pipelines, ledger, carve-out — is #188's; this gate selects
  and sequences, it does not redefine them.)
- A tier-gate guard (new; location and shape at the implementing planner's discretion) that
  runs the fail-closed marker screen pre-sync and blocks on a below-floor assignment, plus a
  test/lint proving it.
- The issue-body sync path's refusal wiring (`scripts/publish-issue-body-sync*`) — refuse
  create/edit without a passing tier-gate guard, per the sync-coupling clause.

## Files out of scope

- The tier rubric, marker set, calibration sample — `docs/issues_drafts/187-*` (draft A).
- The review pipeline/ledger/finding-ownership/carve-out content — `docs/issues_drafts/188-*`
  (draft B).
- The worker **PR-code** review path (unchanged), including `scripts/pr-scope-check.ps1` —
  tier-fence consumption there is the follow-up draft named in Prerequisite.
- The retrospective misfile detector and the calibration-sample refresh obligation —
  follow-up drafts named in Prerequisite (deliberately parked, not silently omitted).
- The authoring-relocation change (Cursor draft-author from Opus brief) — its own
  prerequisite draft per Prerequisite.
- `prompts/agent_rules.md` rubric/review-flow prose (owned by A/B; this gate references it).
- `agent-orchestrator.yaml` / reactions; `packages/core/**`, `vendor/**`, `.ao/**`.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
.claude/skills/**
scripts/**
tests/**
```

## Contract evidence

```contract-evidence
binding-id: orchestrator-pack-scripts:tier-gate-guard-exit:nonzero-on-marker-below-floor
binding-type: cli-behavior
binding: tier-gate guard fails (non-zero exit) when a task carrying a red-flag marker signal is assigned a tier below T3 or has design/adversarial stages skipped
producer: orchestrator-pack-scripts
evidence: NEW(produced-by AC#4)
selector: tier-gate-guard-exit
expected: nonzero-on-marker-below-floor
```

```contract-evidence
binding-id: orchestrator-pack-scripts:publish-sync-refusal:no-tier-gate-receipt
binding-type: cli-behavior
binding: the issue-body sync path refuses (non-zero, no create/edit) when the tier-gate guard has not passed for the draft
producer: orchestrator-pack-scripts
evidence: NEW(produced-by AC#5)
selector: publish-sync-refusal
expected: nonzero-without-tier-gate-receipt
```

The #187 marker vocabulary and #237 skip line are shipped/queued contracts cited in
**Prerequisite**, not new bindings. This draft binds only to its own repo-owned tier-gate
guard and sync-refusal wiring, whose fail-closed behaviors are the two `NEW` obligations
above.

## Acceptance criteria

1. The `create-issue-draft` gate documents recompute authority: it recomputes the tier from
   the #187 rubric **over the brief text** and treats the architect brief tier as an
   advisory prior it may override upward; the recomputed tier is written to the issue body
   as a machine-readable fence (fence readers beyond the worker pre-flight are follow-up
   work, not bound here).
2. Per-tier stage selection is documented: T1 skips the #237 design gate + adversarial; T2
   runs light design, no competitive; T3 runs the full #237 gate + #188's T3 pipeline; the
   review counts are read from #188, not restated or altered here. Below-ladder (#237
   skip-line) inputs short-circuit the selector **only after** the marker screen passes —
   a marker-hit one-liner escalates, never skips. **Observable — wrapper floor:** on a
   fixture run invoked through an adversarial wrapper where recompute yields T1, the
   selected path is ≥ T2 with the adversarial stage present (proven by the stages actually
   selected / the guard receipt recording the invocation context, not by documentation
   presence).
3. **Observable — floor on every tier:** on a **T1-tier fixture run** the never-skipped floor
   checks (#366 contract-evidence, #221 behavior-kind, #188 finding-ledger/carve-out guard,
   **and the worker-safety contract presence check — goal, allowed-roots/denylist fences,
   verification/acceptance criteria**) are all invoked — not only on T3 — and a run that
   skips any floor check on a T1 draft fails (including a T1 draft missing its
   allowed-roots/denylist fences). Only design-analysis and adversarial stages are
   tier-gated.
4. A tier-gate guard exists that **fails** (non-zero, blocking sync) when a red-flag-marker
   signal in the task text coincides with a below-T3 tier assignment or skipped
   design/adversarial stages, and **passes** a marker-free task on its assigned lower-tier
   path. Its vocabulary is #187's marker set verbatim, built as reusable logic future
   consumers can call (sharing enabled here, other consumers wired elsewhere). It fails
   closed: a false-positive marker hit escalates to the architect; text it cannot classify
   escalates to T3; it never passes by failing to parse. Input is the raw text — the brief
   at intake, the final draft post-review — plus its tier fence when one exists; for
   skip-line inputs it emits a passing no-tier receipt after the screen passes.

```producer-emission
producer: orchestrator-pack-scripts
datum: tier-gate-guard-exit
expected: nonzero-on-marker-below-floor
proof-command: npx vitest run -t "tier-gate guard fails a red-flag-marked task assigned below T3 and passes a marker-free task on its lower tier"
```

5. **Observable — sync coupling:** the issue-body sync path refuses create/edit (non-zero)
   when the tier-gate guard has not passed for the draft — proven by a fixture run where
   the guard receipt is missing or failing and sync is attempted; with a passing receipt
   (tier-fence **or** no-tier/skip-line shape) the same sync succeeds. Guard order with
   #188's finding-ledger guard is stated; either failing blocks independently.

```producer-emission
producer: orchestrator-pack-scripts
datum: publish-sync-refusal
expected: nonzero-without-tier-gate-receipt
proof-command: npx vitest run -t "issue-body sync refuses when the tier-gate guard receipt is missing or failing and proceeds when it passes"
```

6. Blocking mid-flight escalation is documented: on any upward recompute the gate stops,
   raises the tier fence, runs the skipped stages, and resumes; it never syncs below the
   recomputed tier; an escalation after first sync re-syncs the issue body with the raised
   fence.
7. Post-review drift recompute is documented: after the review loop the gate recomputes on
   the **final draft text** and escalates upward drift to the architect before publish (the
   recompute #188's drift-escalation invokes).

```positive-outcome
asserts: the tier-gate guard, given a raw task brief that contains a red-flag marker phrase (e.g. a grant/concurrency/CI-gating signal) together with a tier fence below T3, exits non-zero and blocks sync; given a marker-free small-task brief with a T1 fence it exits zero — fixture input is the raw brief text, not a pre-classified marker list
input: realistic
```

**Mechanical anchors vs agent judgment (honest residual).** The tier *recompute reasoning*
and *stage execution* are agent judgment applying #187's prose rubric — not deterministically
unit-testable. They are bounded by three mechanical anchors that **are** exercised as fixtures
above: the floor-on-every-tier check (AC 3), the fail-closed tier-gate guard (AC 4), and the
sync-coupling refusal (AC 5). A prose-only implementation that skips the floor, lets a
marked task pass below T3, or lets a failing gate reach GitHub fails these — so the enforced
guarantees do not rest on documentation presence.

## Upgrade-safety check

- No edits to AO core, `packages/core/**`, or `vendor/**`.
- No `agent-orchestrator.yaml` schema or reactions change.
- No new repository secrets.
- The #187 monotonic rule and #188 caps are **consumed, not altered** — this gate selects
  pipelines and enforces the floor; it does not change tier definitions or review counts.
- The #366 / #221 gates are **strengthened, not weakened** — the tier gate makes them
  unconditionally on-path at every tier; the PR-scope-guard is untouched (its tier-fence
  consumption is a follow-up draft).

## Verification

1. **Fixture runs (the enforced anchors):** floor checks (#366, #221, #188 guard, and the
   worker-safety contract fences incl. allowed-roots/denylist) are invoked on a **T1-tier**
   fixture run, not only T3 (AC 3); the tier-gate guard blocks a marker+sub-T3 brief and
   passes a marker-free T1 brief (AC 4); the sync path refuses create/edit without a
   passing guard receipt and proceeds with one (AC 5); a wrapper-invoked T1 recompute
   selects a ≥ T2 path with the adversarial stage present (AC 2). Each fails if the
   behavior is absent — not satisfiable by prose alone.
2. Run the tier-gate guard on fixtures built from raw briefs: marker phrase + sub-T3 fence →
   non-zero (blocks); marker phrase + skipped design stages → non-zero; marker-free brief +
   T1 fence → zero (AC 4 + producer-emission + positive-outcome).
3. `grep`-level, **policy statements only** (the agent-judgment surface, bounded by the
   anchors above): the gate documents recompute authority, per-tier stage selection
   referencing #237/#188 with the skip-line/marker-dominance and wrapper-floor clauses,
   blocking escalation with post-sync fence re-sync, and post-review recompute on the final
   draft (AC 1, 2, 6, 7).

## Decisions (design analysis)

**Prior art (reconnaissance).** Covered by the #187/#188 topic survey (coworker corpus +
grep): no existing tier recompute, stage selector, or fail-closed cheap-path refusal; the
adjacent shipped surfaces are #237 (design gate — gated here), #221/#366 (floor gates —
kept unconditional), and the no-ceremony PR shapes #161/#165 (diff-content lighten on the
*PR* path, not authoring). Reuse-vs-add is explicit; no shipped machinery is re-implemented.

**Critical mechanics.** (1) *Recompute-as-authority is the anti-#511 enforcement.* A
boundary task that looks small must not ride the cheap path on the author's say-so; the gate
recomputes and the brief tier is only a prior. (2) *The marker screen fails closed* because
prose cannot be classified perfectly — the safe error is an extra architect confirmation,
never a silent skip; unparseable text escalates to T3. (3) *The floor is tier-independent*
by construction: tiering only ever removes design/adversarial *ceremony*, never the
worker-safety contract or the grounding/behavior-kind/scope gates — otherwise the cheap path
becomes an escape hatch (the #43/#59 anti-escape-hatch lesson applied to authoring).
(4) *T1 is dark until calibrated*: the cheapest route cannot activate until #187's negative
test proves it does not misfile danger — activation is earned, not assumed.

**World practice.** Standard risk-gated intake automation: a cheap fast lane guarded by a
conservative, fail-closed classifier and a non-waivable safety floor, with the expensive
path as the default when the classifier is unsure — the same shape as CI required-check
gating and change-advisory fast-tracks.

**Architecture sketch.**

```
brief (+ advisory tier) ─▶ [gate: recompute vs #187] ─▶ marker screen (brief) ──hit & sub-T3?──▶ FAIL → architect
                                     │                        │no          (skip-line input: screen first, then no-tier short-circuit)
                                     ▼                        ▼
                          write tier fence         select stages by tier (#237 gate + #188 pipeline;
                                     │              explicit adversarial wrapper ⇒ floor ≥ T2)
                                     ▼                        ▼
                          FLOOR always runs (#366, #221, #188 guard — invoked, not rebuilt)
                                     ▼
                          review loop (#188) ─▶ post-review recompute (final draft) ─▶ drift up? ─▶ architect
                                     ▼                                                    │ (raise fence, re-sync if synced)
                          sync path refuses without passing guard receipt ─▶ sync
```

**Options considered.**
1. **Prose-only rule in agent_rules, no gate** (trust agents to self-tier). *Rejected:* this
   is the status quo the whole effort exists to fix — advisory prose lets a small-looking
   boundary task self-assign T1. Zero cost, does not enforce anything.
2. **Gate = recompute + fail-closed marker screen + tier-independent floor + calibration-gated
   T1** (chosen). *Cheapest sufficient:* makes the anti-cheap-path property mechanical where
   it matters (the marker screen) while leaving the full recompute as agent judgment bounded
   by the guard; reuses #237/#188/#366 rather than rebuilding.
3. **Deterministic scoring classifier that fully computes the tier from the text.** *Rejected:*
   the rubric is categorical prose applied by an LLM; a full deterministic classifier
   re-implements that judgment, is brittle on real briefs, and duplicates #187. High cost,
   high false-negative risk on exactly the boundary cases that matter.

**Full-class enumeration (stage-selection decision → target the class).**

| assigned/brief tier | red-flag marker signal | context | → gate action |
|---|---|---|---|
| T1 | absent | — | allow T1 fast-path (skip design + adversarial); floor still runs |
| T2 | absent | — | allow T2 (light design, no competitive); floor runs |
| T3 | any | — | run full #237 gate + #188 T3 pipeline; floor runs |
| T1 or T2 | **present** | — | **FAIL closed** → escalate to architect (danger cannot buy the cheap path) |
| any | unparseable / ambiguous | — | **FAIL closed** → T3 |
| no tier (skip line) | absent | below-ladder input | screen first, then short-circuit: no tier, no ceremony |
| no tier (skip line) | **present** | danger-marked one-liner | **FAIL closed** → escalate (skip line subordinate to screen) |
| T1 recompute | absent | explicit adversarial wrapper invocation | floor tier at ≥ T2, preserve the requested adversarial stage |
| any | — | guard receipt missing/failing at sync | **sync path refuses** create/edit |

The first three rows are the honest fast/standard/full paths; the rest are the fail-closed,
skip-line-dominance, wrapper-floor, and sync-coupling guarantees enforced mechanically.

**Revision 2026-07-03 (two independent peer analyses + operator decisions).** Deep-reasoner
and Codex reviewed this draft independently (answers not cross-shown); the operator accepted
all four resolutions. (1) **Cut: calibration-gated T1 activation** — dead machinery: #187's
consistency check is a merge-blocking AC and #187 must merge before this draft, so no live
"not-passed" state can exist at C's runtime; replaced with a one-line assumption. (2) **Cut:
PR-scope-guard fence consumption** — a worker-PR-path change (category error inside an
authoring-time floor) on a surface this draft does not own; the fence stays as a written
record, the consumer moves to a named follow-up. Together the two cuts collapse the build
from four surfaces to one PR (skill prose + guard + sync-refusal wiring + tests). (3)
**Added: sync coupling** — the gate runs inside the session whose under-tiering it polices,
so the sync path itself refuses without a passing guard receipt (the #366 publish-path
pattern); "blocks sync" is now mechanical, with its own NEW contract-evidence row and
observable AC. (4) **Added:** post-sync fence re-sync obligation; skip-line inputs screened
before short-circuit (marker dominance over smallness — a danger-marked one-liner cannot
ride the skip line); screen input split (brief at intake, final draft post-review); marker
vocabulary pinned to #187 verbatim, the screen built as reusable logic (sharing enabled
here, other consumers wired in their own drafts); wrapper inheritance +
explicit-invocation floor ≥ T2, made observable by fixture per Codex review. (5) **Parked with owners,
not silently dropped:** the retrospective misfile detector and the calibration-sample
refresh obligation move to named follow-up drafts; the authoring-relocation change (Cursor
draft-author from Opus brief) is flagged as a missing prerequisite owned by its own draft —
per operator decision, not folded into this one.