# Test fixtures for external-tool output must match a real captured per-state shape, enforced by a guard

GitHub Issue: #223

## Prerequisite

- None blocking. Companion to `docs/issues_drafts/75-rca-spec-discipline-against-misdirected-fixes.md`
  (the procedural half). This draft is the mechanical guard half; they are independent.
- Context: `docs/issues_drafts/74-review-head-ready-report-sha-independent-binding.md` (GitHub #218).
  The #218 bug survived three fix cycles because a test fixture put `headRefOid` on a worker report
  object — a field the real `ao report` record never carries — so "ready fires" was proven on input
  that cannot occur in production while the real (field-less) input was never exercised.

## Goal

Make it mechanically detectable when test data that stands in for an external tool's output carries a
shape the real tool never produces — a field it never emits in any state, **or** a combination of
fields that never co-occur in a single real output. This covers both standalone fixture files **and
inline object literals / factory-built shapes inside `*.test.ts`**: the #218 defect was an inline
`headRefOid` on a worker-report literal in a trigger test, so a guard scoped only to imported fixture
files would miss the exact real bug. When a pack test models the output of an external command (worker
reports, review-run listings, session status, PR metadata), that test data must be anchored to a real,
**per-state** reference for that command, and a guard must fail the build on a shape the real tool
cannot produce — without becoming a brittle gate that rejects legitimate, state-dependent fields.

## Binding surface

- **Per-state reference, validated per variant.** The anchor for each external command's output must
  capture the field shape **per state/variant** the command produces (e.g. a review run in clean /
  needs_triage / failed / degraded states; a session with and without a linked PR), modelled as
  versioned per-variant schemas or a per-variant sample corpus that distinguishes required vs
  optional/conditional vs forbidden fields for that variant. Each fixture must declare the command and
  the state/variant it models and is validated against that **complete variant** — not against the
  union of all states. A field legitimately present in one variant but absent from the fixture's
  declared variant, or a combination of fields that never co-occurs in any single variant, must fail;
  a field genuinely valid in the declared variant must pass.
- **Comparison is shape-aware, not shallow.** The guard must detect an impossible field/combination
  wherever it appears — including nested objects and arrays — not only at the top level, and must not
  misclassify dynamic map keys (value-keyed maps such as per-PR or per-session keyed objects) as fixed
  schema fields. Planner chooses the comparison mechanism; the requirement is the detection behavior.
- **Phantom shape failure is actionable.** On a field/combination absent from the declared variant the
  guard fails and names the offending fixture and the field path. The `headRefOid`-on-a-report case is
  the canonical thing it must catch.
- **Mandatory classification, enumerated from real usage — including inline data.** Every piece of
  external-tool-output test data consumed by the review/orchestration **trigger** tests must carry a
  classification (external command + variant + anchored-reference id, or an explicit reviewed
  non-external opt-out), whether it lives in a fixture file **or as an inline object literal / factory
  output inside the `*.test.ts`**. CI must cover the test data those suites actually exercise — not
  only imported fixture files — so an impossible worker-report-shaped inline literal cannot bypass the
  guard. At minimum, worker-report-shaped objects in the trigger suites must not carry fields absent
  from the anchored per-variant report reference, wherever they are constructed.
- **Blocking coverage floor.** The fixture family implicated by #218 (worker-report-shaped objects)
  and every classified external-output fixture in the trigger tests must be anchored before this issue
  closes — non-negotiable, not deferred. Any external-output fixture elsewhere not yet anchored must
  appear in an explicit inventory (owner + follow-up reference); CI fails if a classified
  external-output fixture is neither anchored nor inventoried.
- **Provenance is capture-backed, not asserted.** Each reference variant must link to committed,
  scrubbed raw capture evidence — the source command, AO/tool version, capture timestamp/context, and
  scrub log — so the required/optional/forbidden split is traceable to real output rather than
  author assertion. A refresh produces a reviewer-visible diff. For a state that cannot be safely
  captured, an explicit exception records the alternate source of truth and a follow-up owner.

**Operator adoption.** None expected beyond normal CI — the guard runs in the existing test/CI flow.
State explicitly in the draft if any operator step is introduced.

## Files in scope

- Test infrastructure and fixtures under `scripts/` (the `*.test.ts` suites and their fixture data).
- A location for per-variant references, their scrubbed raw capture evidence, and provenance (new
  files/dir, marked `(new)`).
- The fixture classification manifest/metadata for trigger-test fixtures (new, marked `(new)`).
- CI wiring that runs the guard and the classification enumeration (extend the existing test/lint
  workflow; planner's choice of step).
- Documentation of the refresh path and the current coverage/inventory (runbook or migration notes).

## Files out of scope

- `packages/core/**`, `vendor/**`, AO CLI behavior — the guard observes AO output, never changes it.
- Product review-trigger logic (#218) and the RCA/spec rules (#75).

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

1. **Per-variant reference with capture-backed provenance.** Each anchored external command has
   per-variant references distinguishing required/optional/conditional/forbidden fields, each linked to
   committed scrubbed raw capture evidence (source command, tool version, timestamp/context, scrub
   log); un-capturable states carry a documented exception. Provable by the reference + evidence
   artifacts.
2. **Phantom field rejected; variant-valid field accepted; impossible combination rejected.** Negative:
   a fixture with `headRefOid` (or any field no variant contains) on a report-shaped object fails with
   fixture+path named. Positive: a field valid in the fixture's declared variant passes. Cross-state:
   a fixture combining fields that are each real in different variants but never co-occur fails. All
   demonstrated.
3. **Shape-aware detection.** An impossible field nested below the top level fails; a dynamic-key map's
   value-keys are not flagged as unknown fields. Provable by those fixtures.
4. **Guard runs in CI and blocks merge** on a drifting fixture, on the normal test/lint path.
5. **Classification + coverage floor are mechanically enforced, inline data included.** CI covers the
   external-tool-output test data the review/orchestration trigger tests actually exercise — fixture
   files **and inline literals / factory shapes in `*.test.ts`** — and fails any lacking
   classification; the #218 worker-report family and all classified trigger-test external data are
   anchored; any other external-output fixture is anchored or inventoried; CI fails when one is
   neither. Provable by a check that fails on the historical inline `headRefOid`-on-report literal
   (the actual #218 shape), on an unclassified trigger-test fixture, and on an un-anchored,
   un-inventoried external fixture.
6. **Refresh path documented.** A named step/owner updates references on a tool/AO version bump,
   producing a reviewer-visible diff, so a legitimately new field is adopted by a reviewable reference
   change, not a guard weakening.

## Upgrade-safety check

- No edits to `packages/core/**` or `vendor/**`; the guard never mutates AO behavior or assumes AO
  CLI flags beyond reading captured output.
- No new repo secrets; captured references and raw evidence must be scrubbed of tokens/URLs/personal
  data before commit.
- No new unsupported `agent-orchestrator.yaml` fields.
- The guard must not produce false positives on legitimate variant-valid fields (criterion 2) —
  brittleness that blocks valid fixtures is a defect, not acceptable strictness.

## Verification

- Negative/positive/cross-state tests (criterion 2): phantom fails with fixture+path; variant-valid
  passes; impossible combination fails; the `headRefOid`-on-report case included.
- Shape-aware tests (criterion 3): nested-impossible-field fails; dynamic-key map does not.
- CI (criterion 4): guard wired into the existing workflow, fails the run on a drifting fixture.
- Classification/coverage check (criterion 5): fails on an unclassified trigger-test fixture and on an
  un-anchored, un-inventoried external fixture.
- Provenance + refresh (criteria 1, 6): capture evidence present per reference; refresh path exercised
  with a reviewer-visible diff.
- `pwsh -NoProfile -File scripts/orchestrator-diagnose.ps1 -Strict` (or the staged-only CI equivalent)
  passes on the change.
