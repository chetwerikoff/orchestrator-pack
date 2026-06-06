# RCA and spec discipline so a recurring bug's true cause is found on the first attempt

GitHub Issue: #221

## Prerequisite

- None blocking. Sibling to `docs/issues_drafts/74-review-head-ready-report-sha-independent-binding.md`
  (GitHub #218) — the binding fix whose four-attempt history motivates this discipline.
- Companion to `docs/issues_drafts/76-golden-sample-fixtures-field-shape-guard.md` (the mechanical
  guard). This draft is the procedural/rule half; #76 is the test-infra half. They are independent
  and may merge in either order.

## Goal

Prevent the failure class where a recurring bug takes several fix cycles because each cycle
diagnoses and specs against an intermediate artifact (a decision/log record) instead of the
observed symptom, and validates the fix against a spec that points the wrong way. The durable
outcome: the standing guidance read at the moment the mistake would be made makes the misdirection
**non-compliant in a way a check or a reviewer can point at** — not merely discouraged prose, and
not a guard so shallow it is satisfied without preventing the failure.

Scope of "who reads this" is deliberate, not universal: these rules live where the work they govern
happens — spec authoring and root-cause investigation (architect/Claude surfaces and the universal
worker rules), **not** every agent entrypoint. The draft must place each rule on the surface that is
actually read for that activity and prove the placement reaches that activity's real loader files,
rather than assert blanket reach.

This encodes four rules from the #212→#218 post-mortem: positive-outcome acceptance, a recurrence
diagnostic, a 5-Whys stop condition, and no silently-parked root causes.

## Binding surface

This issue commits the repo's authoring/investigation guidance to four invariants. For each, the
draft must (a) place it on the surface read for that activity, and (b) make compliance checkable by a
script, a CI step, or a required structural artifact a reviewer can confirm — designed so it cannot
be satisfied trivially (keyword evasion, placeholder links).

- **Positive-outcome acceptance.** Authoring guidance must require that any spec for an
  action-producing path (a behavior that, on success, *does* something observable — starts a run,
  sends a message, wakes a worker, enacts a transition) include at least one acceptance criterion
  asserting that action **occurs on realistic input**, not only that the no-op / defer / failure
  branch records the correct shape. Enforcement must not rest on grepping a few literal words:
  authoring requires the draft to **declare a structured behavior kind** (action-producing vs
  pure-observability/record-only), the check fails an action-producing draft with no positive-outcome
  criterion, and a heuristic backstop (maintained term taxonomy incl. synonyms such as
  listener/supervisor/wake/retry/submit/route/enqueue/reconcile) flags drafts that read
  action-producing but are declared otherwise, for reviewer resolution. **"Realistic input" has
  teeth:** when a positive-outcome criterion's input is external-tool output, that criterion must
  require the input be production-representative — capture-backed / sample-backed provenance, deferring
  to the `#76` field-shape guard where it is in force — so the criterion cannot be satisfied with a
  plausible-but-impossible fixture (the #218 failure mode). #75 and #76 stay independently mergeable;
  this is a provenance requirement on the criterion, not a merge-order dependency.
- **Recurrence diagnostic (not an absolute verdict).** The root-cause procedure must make the first
  step, when a bug is reported as already fixed, the identification and — *when safe and
  representative* — re-running of the prior fix's own acceptance check against current live state.
  `prior check passes while the bug reproduces` is recorded as **strong evidence that the spec or
  fixture is the defect**, prompting descent into the spec/fixture before re-patching code — not an
  exclusive conclusion. Cases where the prior check is unidentifiable, unsafe to run live,
  non-deterministic, or affected by version skew / partial rollout / races / flaky dependencies must
  be recorded as such, keeping a genuine runtime/implementation defect reachable.
- **5-Whys stop condition.** The investigation procedure must state that "a component returned or
  logged value X" or "the decision/defer record is imprecise" is **not** an acceptable terminal root
  cause; the chain continues until a data/contract/field-level fact (e.g. a field the real external
  tool never emits, or a false assumption about an external tool's output shape).
- **No parked roots.** A draft that defers a suspected root cause to a future task must declare it in
  an explicit, machine-detectable structured block with required fields — at minimum: the suspected
  root-cause statement, the evidence, the reason deferred, the follow-up issue, and the resolution
  policy. A tracking issue for that cause must exist, be **open or intentionally resolved**, and **be
  about that cause** — enforced mechanically by requiring the issue body to carry the declared
  cause statement (a generic placeholder issue fails), with a reviewer checklist for the residual
  semantic on-topic judgment. Euphemistic deferral with no block, a missing issue, a placeholder/
  vague cause, or an unrelated/closed-and-unresolved link must block, not pass.

**Reader-surface fan-out.** Each rule lands on the loader file actually read for its activity:
authoring rules in the draft-authoring skill, investigation rules in `prompts/investigate_root_cause.md`
and the RCA skill, publish rules in the publish skill, and any universal worker-facing rule in
`prompts/agent_rules.md` propagated to its mirror surfaces (`AGENTS.md`, `.cursor/rules/**`, and the
generated `.cursor/skills/` pointers) via the repo's existing sync mechanism. The draft enumerates,
per rule, every surface it must reach.

**Operator adoption.** If the live worker-facing rules (`prompts/agent_rules.md`) change, the
operator must restart AO so workers pick up the new rules (`ao stop` / `ao start`). The draft lists
this in its adoption notes.

## Files in scope

- Authoring/investigation/publish guidance: `prompts/agent_rules.md`, `prompts/investigate_root_cause.md`,
  the `.claude/skills/**` SKILL markdown owning draft authoring, root-cause investigation, and publish
  (and the generated `.cursor/skills/` pointers, regenerated — not hand-edited), and the
  `agent_rules.md` mirror surfaces (`AGENTS.md`, `.cursor/rules/**`).
- Repo-root checks/guards invoked by the test/CI or publish path to enforce **Positive-outcome
  acceptance** and **No parked roots** mechanically. New helper files marked `(new)`; planner chooses
  whether to extend an existing guard or add one.

## Files out of scope

- `packages/core/**`, `vendor/**`, AO CLI behavior.
- The product review-trigger code paths (owned by #218) and golden-sample test infra (owned by #76).
- `agent-orchestrator.yaml` live wiring beyond documented adoption notes.
- AO worker *implementation* procedure — these rules govern spec authoring and investigation, not the
  worker's per-issue build loop.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

1. **Positive-outcome rule is enforced and evasion-resistant.** Authoring requires a declared
   behavior-kind; a check fails an action-producing draft with no realistic-input positive-outcome
   criterion and passes when present; a backstop flags a draft that reads action-producing (by the
   documented term taxonomy, including non-literal synonyms) but is declared record-only; and a
   positive-outcome criterion whose input is external-tool output must require production-representative
   (capture-backed) input. Provable by fixtures: a negative-only action draft (flagged), a
   positive-present draft (passes), a synonym-worded action draft declared record-only (backstop
   flags), and an action draft whose positive criterion uses an external-tool input without provenance
   (flagged).
2. **Recurrence diagnostic is the first step and is falsifiable.** The procedure names it first for an
   "already fixed" bug, states the `pass + reproduce ⇒ strong evidence of spec/fixture defect`
   evidence rule (not exclusive), and enumerates the unsafe/unidentifiable/skewed cases to record
   instead. A worked example demonstrates the #218 case (prior AC green on a `headRefOid`-bearing
   fixture while the bug reproduced).
3. **5-Whys stop condition is stated with a rejecting example.** The procedure rejects
   "returned/logged X" and "record imprecise" as terminal causes and shows one descent to a
   field-level fact. Provable by reading the procedure.
4. **No parked roots is enforced and not gameable by placeholders.** A check fails a draft that defers
   a root cause without the structured block (with its required fields), or whose tracking issue is
   missing, closed-and-unresolved, or whose body does not carry the declared cause statement; it
   passes a valid block linking a live, on-topic issue. Provable by negative fixtures (no block;
   vague/placeholder cause; placeholder issue titled generically; unrelated/closed link) and a
   positive fixture.
5. **Each rule reaches its real loader, per surface.** The draft maps each rule to every surface it
   must reach, and a consistency check confirms the rule is present in each named loader actually used
   for that activity — the authoring/RCA/publish skill files and, for worker-facing rules, the
   `agent_rules.md` mirrors and generated cursor pointers — not only `AGENTS.md`/`.cursor/rules`.
   Provable by the per-rule surface map plus the consistency check.
6. The four rules are consistent with `CLAUDE.md` (planner freedom, cost rule) and with
   `docs/issues_drafts/00-architecture-decisions.md`; a new decision-log entry records the
   #212→#218 lesson these rules descend from.
7. No added rule prescribes implementation file names, function signatures, or library choices — each
   constrains *what must be true*, preserving planner freedom.

## Upgrade-safety check

- No edits to `packages/core/**` or `vendor/**`; no AO CLI flag assumptions; no new repo secrets.
- No new unsupported `agent-orchestrator.yaml` fields.
- Each new check is additive and fail-closed only on the specific, documented marker/shape it
  targets — it must not block unrelated drafts (no broad false positives).

## Verification

- Executable (criteria 1, 4): the positive-outcome check (incl. the synonym/backstop fixture) and the
  parked-root check (incl. placeholder-issue and vague-cause fixtures) run against paired fixtures in
  the PR, demonstrated by test or documented command.
- Executable (criterion 5): the per-surface consistency check confirms each rule is present in its
  real loader file(s).
- Read-through (criteria 2, 3, 6, 7): verified by presence, ordering, worked examples, and wording in
  the named surfaces and the decision-log entry.
- Adoption note present for the `prompts/agent_rules.md` change (operator `ao stop` / `ao start`).
