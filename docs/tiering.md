# Task complexity tiering

Worker pre-flight is owned by [`AGENTS.md`](../AGENTS.md). This document is
the sole normative owner of the universal task-complexity rubric. Workflow-
specific review, disposition, and acceptance procedure belongs to the workflow
skill that applies this classification.

## Task complexity tier rubric

Classify the actual change by failure mode and blast radius, not vocabulary,
file count alone, or the fact that the task edits governance policy.

**Below the ladder — no tier.** Operator/runtime steps, config or YAML changes,
one-line spec/rule edits, typo/rename work, and other small obvious fixes may
use the no-tier path. Record-only work uses this path when it qualifies;
otherwise it is T1. Record-only work is never T3.

### Binding T3 test — both prongs required

A task is T3 only when **both** are true:

1. **Guarantee boundary.** The task changes an enforced subsystem/system
   guarantee on a production, CI/merge, runtime, recovery, durable-state,
   trust, concurrency, or operator-evidence path. Prose, ceremony, labels,
   calibration, or record-only reporting is not sufficient by itself.
2. **Material failure escapes safe containment.** A plausible defect can admit,
   ship, execute, authorize, corrupt, duplicate, lose, make unrecoverable, or
   cause material unavailability/coordinated recovery before fail-closed
   rejection or ordinary operator-visible handling safely contains it.
   Operator-visible rejection disproves this prong only when it happens before
   material unavailability, irreversible change, or coordinated recovery is
   required.

If either prong is false, use the T1/T2 split. Doubt fails upward only after
applying this conjunctive test to the real change.

**Governance carve-out.** Editing tiering or review ceremony does not establish
T3 merely because a gate is touched; both prongs still apply to the operational
blast radius.

### T1/T2 split

- **T1** — small, obvious, self-contained work with little design judgment.
- **T2** — one coherent component that requires real design judgment.

Numeric magnitude may disqualify a lower tier but never qualifies work into T1.
Smallness is necessary, not sufficient.

Stable descriptive rubric labels are:

- `failure-type:text-cosmetics`;
- `failure-type:local-behavior`;
- `failure-type:subsystem-or-system-guarantee`;
- `size:small-obvious-self-contained`;
- `size:single-component-design-judgment`;
- `fail-up:doubt`.

A `complexity-tier` fence may include one optional `risk-note:` line. It is
descriptive and non-gating.

### L4 within T3

L4 applies only after the task independently satisfies T3. It is an additional
within-T3 architectural signal, never a route for promoting lower-tier work.
Use it only for material combinations of fail-open/fail-closed behavior,
single-winner/lease/claim correctness, durable recovery/state migration,
trust/authority transitions, or similarly coupled system guarantees where the
ordinary T3 treatment is insufficient to express the design burden.

Workflow-specific stage counts, reviewer cardinality, prompts, dispositions,
labels, and transport mechanics are deliberately not defined here.
