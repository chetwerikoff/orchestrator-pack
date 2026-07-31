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

T1 and T2 use the same create-flow review pipeline: exactly one independent
terminal browser-GPT `architectural` lens. Their classification is descriptive
and calibrational, not a reason to buy a different review topology.

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
captures, chat references, finding-disposition ledger, and related audit state
remain outside the repository. Pre-existing `docs/issues_drafts/**` and
`docs/issue_queue_index.md` content is legacy prior art, not the live artifact for
new work. `.claude/skills/create-issue-draft/SKILL.md` owns the exact procedure and
out-of-repository layout. A historical author/task-chat URL is not required to
continue an existing Issue: a fresh author continuation chat may be reconstructed
from the live Issue and prior review context when needed.

### Guard-alignment prerequisite (#1030 intent)

Issue #1027's ordered #1030 prerequisite is the **guard-alignment** requirement:
landed `stage-completeness` and `finding-ledger-guard` behavior must match the
fixed topology below (terminal GPT `architectural` as M5 anchor; T1/T2 with no
`architectural-lens`; T3 with at least one `competitive`, exactly one later
`architectural-review`, then Claude pre-terminal and terminal GPT). When that
behavior is present — including via #1062 / PR #1073 plus the #1120 topology
cutover — the prerequisite is satisfied even if live Issue #1030 still describes
superseded ordering. Policy acceptance does not require re-syncing the stale #1030
Issue body.

### Per-tier pipeline (ceilings, not quotas)

The flow-manager drives the full cycle through acceptance or a bounded blocked
outcome. There is no mandatory stop-and-hand-off to an architect outside the
stages below. Browser GPT is the only review engine in create-issue-draft;
Codex has no create-flow reviewer role.

| Tier | Review sequence | Pre-lens #975 | Terminal lens |
|------|-----------------|---------------|---------------|
| **T1** | Exactly one independent browser-GPT `architectural` lens → acceptance | **No** | Same GPT lens owns aggregate cut + M5 |
| **T2** | Exactly one independent browser-GPT `architectural` lens → acceptance | **No** | Same GPT lens owns aggregate cut + M5 |
| **T3** | 1–3 `competitive` → one `architectural-review` → pre-lens guard → one Claude `architectural-lens` (or valid waiver) → one terminal GPT `architectural` → acceptance | **Yes** | Terminal GPT owns final aggregate cut + M5 |

The canonical T3 business order is therefore:

```text
competitive → architectural-review → Claude lens → GPT lens
```

The counted capture-token order is:

```text
competitive → architectural-review → architectural-lens (or valid Claude-unavailable anchor) → architectural
```

There is **no** `architectural-final` stage. Historical captures with that name
are audit-only.

**Reviewer GPT chats are distinct from the current GPT author chat.** Competitive
passes use a fresh browser chat per pass. `architectural-review` uses exactly one
fresh independent browser chat after competitive. The terminal GPT `architectural`
lens uses its own independent fresh browser chat (never the author,
`competitive`, or `architectural-review` chat).

**Shared lens rubric.** Every governed Browser-GPT review and the Claude
`architectural-lens` apply the review-economics contract and simplification rubric
from `prompts/codex_draft_review_prompt.md` (rubric source only — Codex is not
invoked as a create-flow reviewer).

### Roles

- **Browser GPT author.** Owns authoring, content fixes, direct Issue edits,
  finding dispositions, M3 author activation, and M4 inventory.
- **Flow-manager.** Owns live pulls, rubric/guard application, fixed stage order,
  immutable captures, ledgers, and one pre-capture adjacent correction. Runtime
  names are not an allowlist. It does not author spec content or judge findings.
- **Claude architectural-lens (T3 only).** Owns pre-terminal M3 when required and
  the pre-terminal aggregate cut. It may state that a task appears over-tiered,
  but after any reviewer capture that statement is advisory only.
- **Browser GPT reviewers.** Own independent review findings and the terminal M5
  cut. They never edit the Issue and have no post-capture tier-transition
  authority.

**Browser outage.** Required GPT work stays incomplete. No engine substitution.

**In-flight cycles.** Continue from the canonical Issue-bound capture history;
restarting a local cycle never reopens intake correction authority.

**Browser outage.** Required GPT work stays incomplete. No engine substitution.

**In-flight cycles.** Restart the fixed per-tier sequence from intake; do not infer
historical provenance to skip stages.

### Tier provenance and one free intake correction

Before the first tier decision, the flow-manager records one `tier-intake/v1`
record with exact non-empty `producer`, Issue/task identity, `kind: fresh`, intake
prior, and first immutable revision. The Issue `advisory-prior` mirrors that
record. Producer is an audit label, not a runtime allowlist or authorization.

Every immutable revision has one `tier-gate-decision/v1` receipt with exact
producer, revision, tier, applicable rubric classes, and L4 status. New T1/T2
receipts emit `l4Status: not-applicable`; T3 receipts use
`clear|active|ambiguous|missing|stale`. Legacy pre-cutover below-T3 `clear` is
readable only as a normalized synonym for `not-applicable` and creates no floor.

The Issue identity owns one free correction window. It opens after intake and
closes when the first immutable capture exists for any reviewer stage selected by
`selectAuthoringReviewStages`. Before closure, the flow-manager may lower the
current tier by exactly one adjacent edge with the existing receipt:

- `correctedFrom: T3` for `T3→T2`, or `correctedFrom: T2` for `T2→T1`;
- non-empty `reason` explaining why the prior was over-tiered (for example,
  “r01 prior was over-tiered”);
- the ordinary exact producer, revision, resulting tier, rubric classes, and
  below-T3 `l4Status: not-applicable`.

No new record type is introduced. Direct `T3→T1`, a second downstep, branching,
reuse after an upstep, blank reason, or correction after the first selected-stage
capture fails closed. Before that capture, neither advisory prior nor immutable
pre-capture high watermark is a tier floor. At and after that capture, the tier is
fixed for the Issue. Restarting intake, changing workdir/cycle/revision numbering,
deleting a pointer, or replaying the same Issue does not reopen the window.
Worker pre-flight remains upward-only and never receives this authoring authority.

Reviewer observations that a captured task appears over-tiered remain advisory.
They do not create a transition. Changing tier after capture requires a new
Issue/task contract.

### Retired demotion compatibility

Fresh tasks no longer produce, require, or authorize `tier-demotion-event/v1`,
`tier-demotion-revalidation/v1`, terminal narrow revalidation,
`demotion-from`, or `demotion-event`. Claude and terminal GPT have no post-capture
tier-transition authority.

The tier-gate code contains one frozen compatibility census for task identities
whose old event, matching revalidation, and lower-tier immutable candidate were
fully complete at cutover. The census is empty at Issue #1142 cutover. For a
listed identity only, the minimum legacy reader validates that already-bound
current candidate. It is read-old/write-none: partial chains, newly appearing
identities or records, appended revalidations, another downstep, later candidate,
restart, reuse after upstep, and dynamic membership all fail closed. Historical
files remain audit-only bytes and do not authorize fresh progression.

### L4 within-T3 graduation

L4 is evaluated only after a task independently satisfies the conjunctive T3
test. It can graduate floors within T3; it never establishes T3, vetoes a valid
pre-capture intake correction, or attaches to record-only/below-T3 work.

The complete L4 failure classes are:

- fail-closed/fail-open behavior;
- single-winner, lease, or claim correctness;
- recovery semantics;
- required-check / merge-contract correctness;
- self-certifying-test or test-harness correctness risk;
- live-state mutation;
- external side effects;
- migration or backward-compatibility behavior.

Each active L4 floor names its applicable class. Add rollback/migration and
crash/race/stale-state acceptance/verification only where that named class
materially exists. New T1/T2 receipts use `not-applicable`; `active` and every
other T3-only L4 state are invalid below T3, and `not-applicable` is invalid at
T3. A #1135-shaped record-only task is below-ladder/T1 with L4 not applicable; a
#1120-shaped action-producing guarantee task remains T3 with its material L4
classes.

### Review economics (M1–M5) — #975

Independent of role/topology ownership (#972). Post-adoption reviewer captures
carry exact `review-economics-contract: v1`, M1/M2 defect/remedy separation,
persistent-machinery pricing when proposed, and governed M5 cut-candidate tokens.

#### M1 — defect disposition

Reviewer findings are proposals. The author chooses defect disposition and may
close a valid defect with any cheaper sufficient correction than the reviewer's
remedy advice.

#### M2 — persistent machinery pricing

When `persistent-machinery: yes`, the raw capture must include
`cheapest-sufficient-alternative`, `stakes-price`, and `trade-in`. Malformed price
fields block progression; the author may decline only the remedy with
`proposalOutcome: declined` / `proposalReason: malformed-proposal`.

#### M3 — protected nomination handling

Reviewer `type: security` or `type: scope-violation` is a **nomination**, never
self-activating addressed-only authority.

| Context | Rule |
|---------|------|
| **T1 / T2** | No architect contest path. Valid non-zero-signal author activation is independently authoritative. Absent or invalid activation uses ordinary M1 disposition — **not** `architectPending`. |
| **T3 pre-Claude** | Includes both `competitive` and `architectural-review`. Retains Claude M3: zero-signal, absent activation, or contest → `architectPending` until the Claude `architectural-lens` adjudicates. |
| **Protected nomination first emitted in terminal GPT `architectural`** | No post-GPT architect path. Valid author activation is authoritative when uncontested; otherwise ordinary M1 — never `architectPending`. |

Only a Claude `architectural-lens` capture may create/withdraw a contest on T3.
Record machine-readable `m3-protected:` lines per protected id as defined in
`create-issue-draft`.

#### M4 — author-maintained mechanism inventory

After every review round, the author reply updates one running inventory of every
new material review-added mechanism/ceremony introduced by that round. Each item
is classified exactly once as `keep`, `simplify`, `defer`, or `cut`. The latest
inventory is input to every applicable lens.

#### M5 — truthful terminal simplification verdict

**Terminal GPT `architectural` capture is the M5 anchor at final acceptance for
all tiers.**

A finding is an M5 cut candidate only when its raw block contains exact
`simplification-cut-candidate: yes`. The terminal raw result has two truthful
shapes:

1. no raw cut candidate → exact `SIMPLIFICATION_CLEAN` required; if genuinely clean,
   also exact `NO_FINDINGS`;
2. tokened cut candidate(s) → no retroactive `SIMPLIFICATION_CLEAN`; each candidate
   must be ledger-mapped and dispositioned or legitimately resolved under M3.

For **T3**, the pre-lens #975 guard runs only after required `competitive` and
`architectural-review` stages are legally terminal. `architectural-review` uses
the same governed economics/finding schema but is **not** the final M5 anchor.
The terminal GPT `architectural` lens remains the M5 anchor at final acceptance.

Pre-adoption anchors cannot satisfy final acceptance. Re-enter a governed
post-adoption pre-lens stage when needed; do not mint synthetic clean-token passes.

### Two-phase finding-ledger guard

`scripts/finding-ledger-guard.mjs` keeps legacy behavior when invoked without a
#975 phase. The #975 flow calls the same guard in two bounded phases:

- **`pre-lens`** — **T3 only.** After existing stage/completion authority declares
  required competitive + `architectural-review` legally terminal; enforces
  post-adoption M2 and pre-terminal simplification shape. Never certifies
  acceptance.
- **`final-acceptance`** — all tiers at acceptance; requires the terminal GPT
  `architectural` M5 anchor, applicable M2/M3 evidence, and current
  revision-bound outcomes.

### T3 Claude lens orchestration and unavailable skip (#1090)

The flow-manager orchestrates the Claude `architectural-lens` but never authors or
simulates it. A counted Claude lens requires a separate Claude Code CLI invocation
with co-located producing-run evidence. When Claude is observably unavailable
(quota, rate-limit, provider-unavailable, or CLI-unavailable), record
`architect-lens-stage-waiver.json` with `reason: claude-unavailable`, strict ISO
`recorded-at`, closed `unavailability`, and `after-pass` set strictly after the
completed `architectural-review` pass. The skip is audit-only: it does not create
`architectural-lens` provenance, M3 authority, or tier-correction authority.
The terminal browser-GPT `architectural` capture remains mandatory after a valid
skip. Stage-completeness accepts `Claude lens → terminal GPT` or
`valid claude-unavailable skip → terminal GPT`; missing both fails closed.

### Architectural-stage goals (T3 architectural-review, Claude lens, and terminal GPT)

`architectural-review`, `architectural-lens`, and terminal `architectural` use the
ordered contradiction/feasibility/simplification/missed-gap discipline, with
stage-specific authority preserved. Claude and terminal GPT have four mandatory
goals in this exact order:

1. **Contradiction check** — fix contradictions via the current author-chat path.
2. **Feasibility check** — verify buildability with live probes where possible.
3. **Cut ALL overengineering — PRIMARY goal** — a forced `keep|cut` verdict for
   every major mechanism; `keep` must cite a surviving contract, risk, or
   acceptance need rather than circularly citing an earlier finding.
4. **Find what was missed** — route required corrections through the current
   author-chat fix path.

Each architectural-stage review receives the exact current Issue revision,
applicable reject partition, current M3 state, latest author-owned M4 inventory,
and applicable economics state. `architectural-review` remains pre-Claude and has
neither M5 nor tier-demotion authority. Competitive review retains the shared
four-question simplification/economics rubric without becoming an architectural
or terminal authority.

**Staleness / review-episode binding.** A Claude `architectural-lens` capture is
bound to the **source Issue revision** it reviewed and remains valid pre-terminal
M3 evidence for that revision. The normal T3 path **requires** post-Claude author
dispositions/fixes before terminal GPT runs; those edits do not invalidate the
Claude capture or force a second Claude lens. Post-Claude fixes proceed to
**terminal GPT `architectural` only** — no second Claude lens. A terminal GPT
`architectural` capture remains the **review-episode M5 anchor** after accepted
terminal-GPT fixes; the resulting current body still owes all existing
mechanical/body/tier/ledger acceptance checks — no second GPT lens.

### Terminal GPT architectural lens (all tiers)

Runs in an independent fresh browser-GPT chat (never the author chat). It applies
the shared four-question rubric and review-economics contract. On T1/T2 it is the
sole reviewer stage and owns aggregate cut + M5. On T3 it owns final aggregate
cut + M5 after `competitive`, `architectural-review`, Claude, and author fixes.

A terminal reviewer may report that the task appears over-tiered, but the first
canonical reviewer capture has already fixed the tier for this Issue. The report
is advisory and creates no demotion event, narrow revalidation, restarted intake,
or replacement transition protocol.

Terminal GPT has full current-revision M3 authority. Authoritative
`m3-protected:` records fold in capture/pass chronology across Claude and GPT, so
a later valid terminal record may confirm, replace, contest, or withdraw earlier
Claude state for the same protected id/revision, including a nomination first
emitted by terminal GPT. Stale/malformed/conflicting state and unresolved
current-revision contest fail final acceptance; no post-GPT Claude pass is
required.

### Simplification lens

The four-question lens in `prompts/codex_draft_review_prompt.md` is mandatory on
every GPT and Claude lens: what can be simplified / must not be simplified / is
excess / is missing.

### Explicit wrappers

- **`discuss-with-gpt` brief-only wrapper** — routes into `create-issue-draft` and
- **`discuss-with-gpt` brief-only wrapper** — routes into `create-issue-draft` and
  floors effective tier at **T2**; it does **not** add a competitive or
  `architectural-review` create-flow stage beyond the single terminal GPT
  `architectural` lens.
- **`adversarial-draft-review`** — standalone Codex challenge only; **not** a
  create-flow review stage. An explicit Codex flow-manager selection still routes
  through `create-issue-draft`.

If a low/contained-stakes artifact exits adversarial review with approximately
100% of findings `addressed`, record that as a **proportionality smell** in the
applicable lens capture and re-examine whether review-added machinery is actually
the cheapest sufficient design.
