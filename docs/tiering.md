# Task complexity tiering (architect / draft-author)

Worker **pre-flight** (blocking rubric reassessment before implementation) lives in
[`AGENTS.md`](../AGENTS.md) (**Worker pre-flight**).
This page holds the full tier rubric and per-tier draft-review flow for architects and task-spec authors.

## Task complexity tier rubric

Classify each incoming task as **T1**, **T2**, or **T3** before choosing authoring
ceremony. Tier follows the actual failure mode and blast radius, not vocabulary,
file count alone, or the fact that a task edits tier/review policy.

**Below the ladder — no tier.** Reuse the **#237 design-analysis skip line**
verbatim: operator/runtime steps, config or YAML changes, one-line spec or rule
edits, typo/rename, and other small fixes carry no tier and no authoring ceremony.
Record-only work uses this skip line when it qualifies; otherwise it is T1. A
record-only task can never be T3.

### Failure-type lens (apply first)

Apply the conjunctive T3 test below before any size or ceremony signal.

### Binding T3 test (both prongs required)

A task is T3 only when **both** conditions hold:

1. **Guarantee boundary.** The task changes an enforced subsystem/system guarantee
   on a production, CI/merge, runtime, recovery, durable-state, trust,
   concurrency, or operator-evidence path. Prose, ceremony, labels, calibration,
   or a record-only reporting surface is not sufficient by itself.
2. **Material failure escapes safe containment.** A plausible implementation
   defect can admit, ship, execute, authorize, corrupt, duplicate, lose, make
   unrecoverable, or cause material unavailability/coordinated recovery before a
   fail-closed rejection or ordinary operator-visible handling safely contains
   it. Operator-visible rejection disproves this prong only when it occurs
   **before** material unavailability, irreversible change, or coordinated
   recovery is required. Visibility after material impact does not make the task
   non-T3.

If either prong is false, classify by the T1/T2 split below. Doubt fails upward
only after applying the conjunctive test to the actual change.

**Governance carve-out.** Editing tiering or review ceremony does not establish T3
solely because a tier gate is touched. Apply both prongs to the real operational
blast radius.

### T1/T2 split

- **T1** — small, obvious, self-contained work with little design judgment.
- **T2** — one coherent component that requires real design judgment.

The create-flow review topology is fixed by tier: **T1** has one GPT terminal
review; **T2** has three independently and concurrently launched GPT
architectural reviews and one GPT terminal review; **T3** has the same three GPT
architectural reviews, one required Claude architectural lens, and one GPT
terminal review. Every required review is published as an Issue comment whose
first line names the revision read. T3 has no competitive stage and no Claude
waiver. The three GPT reviews are an independently launched parallel batch;
published comment count alone cannot prove source independence.

The author dispositions findings from each round in one Issue comment, either
accepting with a corrected Issue revision or rejecting with a reason. Clean
rounds require no synthetic Issue-body edit. No stage receipts or replay are
needed to progress an in-flight Issue. The author/operator must not lower the
tier after review begins absent an operator decision; the current tier fence
alone does not prove historical tier.

Numeric magnitude may disqualify a task from a lower tier but never qualifies a
task into T1. Smallness is necessary, not sufficient. Stable receipt rubric
labels remain:

- `failure-type:text-cosmetics`;
- `failure-type:local-behavior`;
- `failure-type:subsystem-or-system-guarantee`;
- `size:small-obvious-self-contained`;
- `size:single-component-design-judgment`;
- `fail-up:doubt`.

Any tier may include one optional `risk-note:` line in the `complexity-tier`
fence. It is descriptive and non-gating: it creates no second ladder, stage,
taxonomy, or floor.

## Per-tier draft-review flow

This governs **create-issue-draft** review, not implementation PR review. The
GitHub Issue is the only live spec. The [canonical create-Issue skill](../.cursor/skills/create-issue-draft/SKILL.md)
owns launch/disposition/acceptance procedure; the shared Browser-GPT sender
retains its own separate unchanged transport and legal-retry authority.

### Per-tier pipeline (ceilings, not quotas)

The following table counts required published reviews, not staged receipts or
model-call quotas. No T3 competitive stage or waived Claude lens exists.

| Tier | Published Issue-comment reviews | Disposition and acceptance |
| --- | --- | --- |
| T1 | One GPT terminal architectural reviewer | Author dispositions any findings; existing substantive floor and label rules apply. |
| T2 | Three GPT architectural reviews, then one GPT terminal review | One author disposition comment per round; earlier findings remain binding. |
| T3 | Three GPT architectural reviews, one required Claude architectural-lens comment, then one GPT terminal review | One author disposition comment per round; no competitive stage or Claude waiver. |

For T2/T3 the manager starts the three GPT reviewers independently and in
parallel. Each reviewer's **first Issue-comment line** names the actual revision
read (for example `Read revision: #123 r04`). The Claude comment does the same.
Existing published reviewer comments on an in-flight Issue count. Duplicate
publication does not block review progression or prove independent launches.
The separate shared sender terminal envelope is **not** create-Issue review
completion; the matching published Issue review comment completes the review
turn. With neither a chat reply nor a matching Issue comment, use only the
sender's already-authorized recovery/resend path; no new send follows from
absence alone.

The author records one Issue disposition comment per review round addressing
**every** finding from that round: accepted and corrected in the next revision,
or rejected with a reason. A clean review requires no synthetic body revision.
Earlier-round unresolved findings still prevent label acceptance. The existing
`spec-review:accepted` label and those Issue comments are the only acceptance
record; never consult cycle/stage records, receipts, relay maps, a finding-ledger
format, reviewer-invocation envelope, Claude producer evidence, a Claude waiver,
or `create-issue-final-acceptance/v1` as review/label authority.

Run the **existing** draft-discipline/tier-gate substantive floor on the Issue
revision **before** its terminal GPT reviewer reads it. Fix known failures
before that review. A late-discovered substantive floor failure (including
one discovered after a clean terminal review) is a terminal-round finding:
use the **one permitted author correction** and pass the same existing floor
on the corrected revision. Do not rerun terminal review, introduce an extra
stage or new check, or synthesize an acceptance artifact. Label acceptance
requires every tier-required review comment, dispositions for findings in
**every** required round, and the named terminal-reviewed revision or its
**single** allowed findings/floor correction. An ordinary later unreviewed body
revision is not accepted; operator amendments are accepted by definition.
The author/operator does not demote a tier after review begins without operator
direction; no freeze receipt is added.

### L4 within-T3 graduation

L4 applies only after the task independently satisfies T3. Complete classes are:

- fail-closed/fail-open behavior;
- single-winner, lease, or claim correctness;
- recovery semantics;
- required-check / merge-contract correctness;
- self-certifying-test or test-harness correctness risk;
- live-state mutation;
- external side effects;
- migration or backward-compatibility behavior.

Each active floor names its class. T1/T2 use `not-applicable`; T3 cannot use
`not-applicable`.

## Review economics (M1–M5)

Maintain substantive reviewer scrutiny, without the deleted accounting gate:
identify the defect separately from the preferred remedy (M1); price proposed
persistent machinery and look for cheaper sufficient alternatives (M2);
escalate substantive security/scope disagreements to the existing owner rather
than invent protected-nomination/occurrence records (M3); examine review-added
mechanisms for keep/simplify/defer/cut (M4); and provide a truthful terminal
simplification assessment (M5). No `SIMPLIFICATION_CLEAN` token, M1–M5 row map,
receipt-backed occurrence counter, or independent acceptance gate is required.

### Architectural-stage goals

The GPT architectural reviewers, required Claude lens and terminal GPT check:
(1) contradictions, (2) feasibility, (3) unnecessary complexity and less
costly solutions, and (4) missed gaps. Reviewers publish their own evidence and
findings directly to the Issue; the manager does not replace their comments.

### Explicit wrappers

- `discuss-with-gpt` brief-only routes into `create-issue-draft`, floors at T2,
  and does not add pre-terminal stages.
- `adversarial-draft-review` is standalone Codex challenge, not a create-flow
  reviewer stage. A Codex-selected flow-manager still follows this topology.

If a low/contained-stakes artifact exits adversarial review with approximately
100% addressed findings, record a proportionality smell and re-examine whether
review-added machinery is cheapest sufficient.
