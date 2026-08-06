# Task complexity tiering (architect / draft-author)

Worker **pre-flight** (blocking rubric reassessment before implementation) lives in
[`AGENTS.md`](../AGENTS.md) (**Review / CI / Handoff worker contract**).
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

The create-flow topology is fixed by tier:

- **T1:** one GPT `architectural` lens.
- **T2:** three GPT `architectural-review` sources launched concurrently, then
  one GPT `architectural` lens.
- **T3:** three GPT `competitive` sources when directly required by the
  operator, selected by the architect, or judged necessary by the
  flow-manager because the task has fundamentally different plausible
  solution designs, then three GPT
  `architectural-review` sources concurrently, one Claude
  `architectural-lens`, and one GPT `architectural` lens.

“Concurrently” means the slots are launched as one parallel batch, with browser
starts staggered by 10–15 seconds. The T3 competitive decision is recorded in
the journal. The flow-manager makes this decision from the substance of the
task, without checklists, thresholds, scores, or formal scales. Skipping is
legal only with an explicit journal rationale explaining why the solution
space is narrow; missing rationale is a process defect. Between stages, the
author must run a fix-round:
close or substantively reject every finding, update the Issue body, and
increment its revision before the next stage starts. No stage may start from a
stale revision; reviewers read the latest revision.
These fixed counts replace older single-source and configurable-cardinality
wording.

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

Governs **create-issue-draft task-spec review** only. Worker **PR-code** review
(`prompts/codex_review_prompt.md`, pack review runner) is unchanged.

For newly authored tasks, the GitHub Issue is the sole live task specification
and queue entry. The mirrorless flow creates no tracked or in-repository draft or
queue-index artifact. Its working anchor, immutable pulled revisions, reviewer
captures, chat references, stage receipts, relay evidence, the finding ledger,
and related audit state remain outside the repository. `.claude/skills/create-issue-draft/SKILL.md`
owns the exact procedure and layout.

### Guard-alignment and activation ordering

Stage completeness and finding-ledger behavior must match the fixed topology
below. Issue #1150 owns source-preserving cardinality inside T3 pre-terminal
rounds; Issue #1171 owns the Issue-lifetime cap: one settled `stageAttemptId` per
required stage, canonical Issue-root receipt authority, and fail-closed
non-reopening.

Therefore:

- exact `triple-source/v1` pre-lens admission may be produced and validated by
  #1150;
- one three-capture `stageAttemptId` is one full stage and one logical round,
  never three rounds;
- flow-manager consolidation is forbidden;
- live T3 final acceptance accepts the fixed three-source rounds once #1171
  validates canonical history, topology, relay, ledger, and terminal binding;
  `triple-source/v1` alone is not a blocker.

### Per-tier pipeline (ceilings, not quotas)

| Tier | Review sequence | Pre-lens #975 | Terminal lens |
|------|-----------------|---------------|---------------|
| **T1** | One GPT `architectural` lens → mandatory author fix-round → acceptance | **No** | GPT lens owns aggregate cut + M5 |
| **T2** | Three concurrent GPT `architectural-review` sources → mandatory author fix-round → one GPT `architectural` lens → mandatory author fix-round → acceptance | **No** | GPT lens owns aggregate cut + M5 |
| **T3** | Three concurrent GPT `competitive` sources when operator/architect/flow-manager judgment requires them → mandatory author fix-round → three concurrent GPT `architectural-review` sources → mandatory author fix-round → one Claude `architectural-lens` (or valid waiver) → mandatory author fix-round → one GPT `architectural` lens → mandatory author fix-round → acceptance after #1171 checks | **Yes** | GPT lens owns final aggregate cut + M5 |

The canonical T3 order is:

```text
competitive[01..03] (when triggered) → author fix-round → architectural-review[01..03] → author fix-round → Claude architectural-lens → author fix-round → GPT architectural → author fix-round → acceptance
```

Every author fix-round is mandatory before the next stage, including after the
Claude lens and after the final GPT lens. If a review returns `NO_FINDINGS`, the
fix-round is a journaled statement “no findings, no changes required”; the next
stage cannot start until that record exists.

The author fix-round after the terminal GPT lens is mandatory for every tier,
even when that lens returns `NO_FINDINGS`. In that case it is a journaled
disposition stating “no findings, no changes required”; the terminal stage is
still recorded before acceptance.

Competitive review runs when the operator requires it, the architect selects
it, or the flow-manager judges that the task has fundamentally different
plausible solution designs and records that substantive rationale. A skipped
competitive stage requires an equally explicit journal rationale explaining
why the solution space is narrow. No checklist, threshold, score, or formal
scale may decide this; missing rationale is a process defect.

The stage receipts freeze the required cardinality: T1 has one GPT lens; T2 has
three architectural-review sources followed by one GPT lens; T3 has three
competitive sources when a trigger is journaled, three
architectural-review sources, one Claude lens, and one GPT lens. There is no
configurable cardinality override.

There is no `architectural-final` stage. Historical captures with that name are
audit-only.

### Source-preserving review episode (#1150)

One create-flow review episode begins when the first required reviewer-stage
attempt is created after intake correction closes. Its root is the immutable
`tier-intake/v1` task identity plus first frozen revision. Its `reviewEpisodeId`
spans all pre-terminal stages, Claude, author-fix revisions, terminal review,
relay, and author disposition. It does not reset at a lens, revision change,
continuation chat, replay, or workdir change.

Each stage attempt:

- has one `stageAttemptId`, one stage, one policy, one frozen `sourceRevision`,
  and the selected cardinality snapshot;
- records revision checks at attempt creation, before launch, and settlement;
- forbids author edits while unsettled;
- settles only after every launched invocation is terminal, no retry runs or
  remains eligible, and final revision checks match;
- emits one authoritative persisted `stage-completeness-receipt/v1` in a
  no-overwrite sequence and cumulative receipt census.

No `review-episode-receipt` or equivalent persisted episode snapshot exists.
Both guards call the same pure derivation over the complete canonical receipt
directory, immutable `tier-intake/v1`, independently produced Claude evidence,
and verified relay evidence to obtain episode-wide credentialing sets,
governed/relayed unions, raw counts, and logical-round identities. A caller
cannot prove a later episode root by passing only a self-consistent subset.

### T3 plural source stages

T2 `architectural-review` and T3 `architectural-review` use policy
`triple-source/v1` and exact independent reviewer slots `01..03` in one
staggered concurrent batch. T3 `competitive` uses the same three-slot policy
when the operator, architect, or flow-manager's substantive judgment selects
it, with the decision and rationale recorded in the journal. A skip likewise
requires an explicit rationale for why the solution space is narrow.

- All three launches begin before harvesting/adjudicating siblings.
- Preserve 10–15 second spacing and bounded prior-slot observation.
- After each logical review round, the author closes or substantively rejects
  every finding, updates the Issue body, and increments its revision before
  the next stage. No later stage starts on a stale revision; every reviewer
  reads the latest revision.
- There is no account-wide hard cap or synthetic pre-attempt capacity outcome.
- Every invocation emits immutable `reviewer-invocation-envelope/v1` evidence,
  including episode/attempt/policy/stage/revision identities, cardinality and
  config identity, reviewer slot and independent source identity, invocation
  and terminal-result identities, observable capacity result, revision check,
  `send_count`, retry-attempt state, retry class, and terminal classification.
- Successful siblings remain separate immutable files:
  `pass-NN-competitive-SS.capture.txt` and
  `pass-NN-architectural-review-SS.capture.txt`.
- Exact slots `01..03` credential the stage together. Missing, duplicate, extra,
  consolidated, mislabeled, mixed-revision, or non-terminal source sets fail
  closed.

T1, Claude `architectural-lens`, and GPT `architectural` use one source.
T2's three-source architectural review precedes its one GPT lens.

### Retry and observable capacity

One paced retry under the same slot and `stageAttemptId` is permitted only after
an invocation-local terminal result proves a pre-send quota/composer/fill failure
with `send_count: 0`. It uses `attemptOrdinal: 2`, records
`retryAttempt: true`, and consumes the only retry. A failed retry may settle as
blocked/exhausted; it never creates another retry opportunity.

Possible/post-send failure, ambiguous delivery, output conflict, missing terminal
result, or any `send_count: 1` failure forbids resend and remains incident/blocking
evidence. A zero-send result with unused eligibility keeps the attempt unsettled
until retry or explicit abandonment to a blocked settlement.

### Governance, relay, and occurrence accounting

Every relay-eligible capture from every stage receipt in the episode remains in
`governedCaptureUnion`, including settled incomplete-attempt evidence. Claude
capture evidence is governed only when a separately produced immutable Claude
CLI result matches invocation, run, terminal-result, revision, bytes, hash, and
M3 facts. A valid Claude-unavailable waiver contributes no capture or synthetic
occurrence.

Before author adjudication or final acceptance:

```text
relayedCaptureUnion == governedCaptureUnion
```

Relay evidence must preserve immutable capture identity, bytes, hash, source
labels, and multipart cardinality. Empty/truncated wrappers, author
acknowledgement, or transport success without embedded source bytes are not
delivery. Corrected relays retain one linear supersession chain and exactly one
verified latest head.

Raw finding occurrence identity is capture identity plus source-local ordinal.
Every occurrence maps exactly once to one author-owned distinct defect. Stable
reviewer-local finding IDs are not cross-source identity. Receipt-backed ledger
validation re-reads every governed capture text and checks its exact name, byte
length, SHA-256, and raw occurrence count before accepting:

- `rawFindingCount` for governed source occurrences;
- `distinctFindingCount` for author-owned distinct defects;
- `processedDistinctCount` for `addressed` plus `rejected-as-false` defects.

The `counts` object contains exactly those three non-negative integer fields.
Defect disposition is exactly one of `addressed`, `rejected-as-false`, or
`unresolved`. Remedy disposition is independently exactly one of `accepted`,
`replaced-by-cheaper-sufficient`, or `rejected-as-overengineering`. Any unresolved
defect blocks progression.

### Roles

- **Browser GPT author.** Owns authoring, content fixes, direct Issue edits,
  defect and remedy dispositions, M3 author activation, and M4 inventory.
- **Flow-manager.** Owns live pulls, tier/guard application, stage order,
  immutable source capture, envelopes, receipts, relay verification, occurrence
  bookkeeping, and one pre-capture adjacent correction. It does not author
  content, merge sibling findings, judge defects, or simulate Claude.
- **Claude architectural-lens (T3 only).** Owns pre-terminal M3 when required and
  pre-terminal aggregate cut. It remains singular.
- **Browser GPT reviewers.** Own independent review findings and terminal M5.
  They never edit the Issue or authorize post-capture tier transition.

**Browser outage.** Required GPT work stays incomplete. No engine substitution.

### Tier provenance and one free intake correction

Before the first tier decision, record one `tier-intake/v1` record with exact
producer, Issue identity, `kind: fresh`, intake prior, and first immutable
revision. Every revision receives one `tier-gate-decision/v1` receipt.

The Issue identity owns one free correction window. It closes when the first
immutable selected-stage capture exists. Before closure only, one adjacent
`T3→T2` or `T2→T1` correction may be recorded with `correctedFrom` and non-empty
reason. Direct `T3→T1`, a second correction, branching, reuse after upstep, or
correction after capture fails closed. Restart/replay never reopens it. Worker
pre-flight remains upward-only.

### Retired demotion compatibility

Fresh tasks do not produce or authorize `tier-demotion-event/v1`,
`tier-demotion-revalidation/v1`, terminal narrow revalidation, `demotion-from`, or
`demotion-event`. Post-capture over-tier observations are advisory. A tier change
then requires a new Issue/task contract.

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

## Review economics (M1–M5) — #975

Every governed Browser-GPT and Claude capture carries exact
`review-economics-contract: v1`, stable finding blocks, persistent-machinery
pricing when proposed, and truthful simplification tokens.

### M1 — defect versus remedy

Reviewer findings are proposals. The author disposes the defect separately from
the suggested remedy and may choose a cheaper sufficient correction.

### M2 — persistent machinery pricing

`persistent-machinery: yes` requires `cheapest-sufficient-alternative`,
`stakes-price`, and `trade-in`. Malformed pricing blocks; it cannot be hidden by
merging sources. Receipt-backed validation applies this to every raw occurrence,
not merely one representative row.

### M3 — protected nominations

`type: security` and `type: scope-violation` are nominations, not automatically
addressed-only authority.

- T1/T2 terminal GPT has full current-revision authority under existing evidence
  and why-now rules.
- T3 pre-Claude may leave occurrence-local `architectPending`; Claude capture may
  adjudicate that exact occurrence.
- A valid Claude-unavailable waiver has no M3 authority.
- Terminal GPT has full current-revision authority and may supersede earlier
  Claude state for the same occurrence, including same-capture adjudication of a
  newly emitted protected nomination.
- Stale, malformed, duplicate-conflicting, row-ID substitution, or unresolved
  contest state fails closed.

Protected occurrence type cannot be silently reclassified when multiple sources
map into a distinct defect. Every receipt-backed ledger row must map at least one
real occurrence; an empty decoy row cannot satisfy the protected-type floor.

### M4 — author mechanism inventory

After each logical review round, not each sibling capture, the author updates one
inventory of review-added mechanisms as `keep`, `simplify`, `defer`, or `cut`.
One three-capture `stageAttemptId` consumes one round.

### M5 — truthful simplification verdict

GPT `architectural` remains the sole final M5 anchor for all tiers. The
three-source pre-lens aggregation is a progression gate only:

- union every `simplification-cut-candidate: yes` occurrence across all three
  `architectural-review` sources, independent of file order;
- aggregate `SIMPLIFICATION_CLEAN` only when all three sources carry it and no
  source emits a candidate;
- aggregate `NO_FINDINGS` only when all three are locally no-findings;
- never let one clean source erase another source's finding or candidate.

### Two-phase finding-ledger guard

- **`pre-lens`** — T3 only, after the selected three-source `competitive`
  stage (if journaled as needed) and three-source `architectural-review` stage
  are settled, fully relayed, and occurrence-accounted.
- **`final-acceptance`** — all tiers, requiring terminal GPT M5 and all applicable
  M2/M3/relay/count evidence. T3 plural-source activation is governed by #1171's
  canonical logical-round and terminal acceptance checks.

The production CLI reads `--receipt-directory`, immutable `--tier-intake`, all
`--stage-receipt` files, optional independent `--claude-producer-evidence`, and
`--verified-relay-evidence`; it never derives authority from filenames alone or
from a caller-selected receipt subset.

### Claude lens and unavailable skip

Claude remains exactly one pre-terminal source. A counted capture requires a
separate Claude invocation and independently supplied producing-result evidence.
Only observable `quota`, `rate-limit`, `provider-unavailable`, or
`cli-unavailable` may produce a `claude-unavailable` waiver. The waiver is
topology evidence only and creates no capture, finding, M3 authority, or tier
authority. Terminal GPT remains required.

### Architectural-stage goals

`architectural-review`, Claude lens, and terminal GPT use, in order:

1. contradiction check;
2. feasibility check;
3. forced cut of all overengineering;
4. missed-gap search.

Competitive retains the shared economics and four-question simplification lens
without gaining architectural/M5 authority.

### Terminal GPT architectural lens

Runs once in an independent fresh chat. T1 uses it as the only reviewer. T2
uses it after three architectural-review sources. T3 uses it after the
conditional three-source competitive stage, three architectural-review
sources, Claude/waiver, and author fixes. It remains singular and cannot be
replaced by consolidation or a second Claude pass.

### Explicit wrappers

- `discuss-with-gpt` brief-only routes into `create-issue-draft`, floors at T2,
  and does not add pre-terminal stages.
- `adversarial-draft-review` is standalone Codex challenge, not a create-flow
  reviewer stage. A Codex-selected flow-manager still follows this topology.

If a low/contained-stakes artifact exits adversarial review with approximately
100% addressed findings, record a proportionality smell and re-examine whether
review-added machinery is cheapest sufficient.
