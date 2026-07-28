# Task complexity tiering (architect / draft-author)

Worker **pre-flight** (blocking rubric reassessment before implementation) lives in
[`AGENTS.md`](../AGENTS.md) (**Review / CI / Handoff worker contract**).
This page holds the full tier rubric and per-tier draft-review flow for architects and task-spec authors.

## Task complexity tier rubric

Classify every incoming task into **T1**, **T2**, or **T3** before choosing
authoring ceremony. The tier measures **how much ceremony** the task warrants —
not implementation shape. **Orthogonal to behavior-kind:** both are intake
declarations on one task specification; behavior-kind classifies action shape,
this rubric classifies complexity/ceremony. Neither replaces the other.

**Below the ladder — no tier.** Reuse the **#237 design-analysis skip line**
verbatim: operator/runtime steps, config or YAML changes, one-line spec or rule
edits, typo/rename, and other small fixes carry **no tier** and no authoring
ceremony. See `prompts/investigate_root_cause.md` (**Conditional design-analysis
block** — *Skips when*).

### Tier meanings (ceremony weight)

- **T1** — light ceremony: small, obvious, self-contained (~1–2 files); text or
  local cosmetics; little design judgment.
- **T2** — moderate ceremony: one component needing real design judgment on
  *how*; still a single coherent surface.
- **T3** — full ceremony: subsystem behavior, system guarantees, or other high
  blast-radius work — size does not discount danger.

### Failure-type lens (apply first)

Ask: **what is the worst thing this task can break?**

- Text/cosmetics only → usually **T1**.
- Local behavior of one function or module → usually **T2**.
- A subsystem's behavior or a system guarantee (CI gate, recovery, durable state,
  trust, concurrency, merge safety, operator evidence) → **T3**.

Read the actual task with fresh eyes. Vocabulary in the Issue body does not
mechanically set tier; blast radius and failure type do. Merely naming a subject,
quoting prior art, describing a rejected alternative, or reusing an unchanged
primitive is not by itself enough to justify T3.

### Classification order (hard precedence)

1. **Failure-type lens.** Apply the rubric above to the real change, not keyword
   matches in prose.
2. **Size and design judgment.** Small, obvious, ~1–2 files, self-contained →
   **T1**. One component needing real design judgment → **T2**.
3. **Doubt escalates up (fail-up).** Between two tiers, take the **higher**.

**Demote-only magnitude rule.** Numeric file/diff ceilings may only
**disqualify** a task from a lower tier (push it up). They may **never qualify**
a task into **T1**. Smallness is necessary but not sufficient for T1.

For #973 audit records, the flow-manager serializes the rubric decision with
stable machine labels: `failure-type:text-cosmetics`,
`failure-type:local-behavior`, `failure-type:subsystem-or-system-guarantee`,
`size:small-obvious-self-contained`, `size:single-component-design-judgment`,
and `fail-up:doubt`. The applicable rubric labels form the guard-enumerable driver
set for that immutable tier decision.

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
out-of-repository layout.

### Roles and mixed-engine topology

- **Browser GPT author.** Browser GPT is the default task-spec author. One task
  chat owns authoring, every content fix, direct edits to the live GitHub Issue,
  every finding disposition, M3 author activation, and the M4 mechanism inventory.
  Reviewer findings are proposals to this author.
- **Cursor flow-manager.** One current Cursor flow-manager per task owns the
  operational cycle: live Issue pulls, rubric/guard application, tier and stage
  selection, mechanical/body floors, immutable captures, finding-ledger
  bookkeeping, pass accounting, chat references/topology, browser-turn execution,
  #975 adoption evidence, and two-phase economics-guard execution. It records
  author dispositions but does not author spec content, judge findings, or perform
  the final architect lens. A successor may act only after the latest explicit
  predecessor/operator handoff recorded in an existing audit/chat surface; that
  handoff immediately ends the predecessor's manager authority. No lease,
  heartbeat, or new ownership store is implied.
- **Architect.** The architect has exactly two possible touchpoints: optional
  pre-task consultation when selected by the operator/task origin, and the
  mandatory final architect lens. The final lens owns M3 contest/adjudication when
  required, the sole independent aggregate cut decision, and the only sanctioned
  tier downgrade. It does not operate routine browser turns, maintain the ledger,
  ratify ordinary per-round dispositions, control ordinary stage ordering, or own
  intake/mid-cycle tier selection.
- **Browser GPT competitive review.** When the existing tier or an explicit
  request selects a competitive stage, each pass runs in a fresh browser-GPT
  chat. The stage ceiling remains three passes.
- **Browser GPT architectural review.** Ordinary architectural review uses one
  dedicated browser-GPT review chat for the task and reuses that same chat across
  its ordinary rounds. The post-lens final-verification pass remains a fresh
  browser-GPT chat. Review chats never edit the Issue; dispositions return to the
  task chat.
- **Codex.** Codex is not the default architectural-review engine. Its sanctioned
  roles are: the mandatory independent addition for T3-critical tasks; a recorded
  substitution for a browser-GPT review stage only when the browser is unavailable
  and the operator cannot raise it; and an explicitly user-requested standalone
  `adversarial-draft-review` challenge loop added on top of the normal flow.

A Codex substitution is captured, normalized, and dispositioned like the stage it
replaces and is credited only to that replaced browser stage. It never satisfies
the separate mandatory T3-critical Codex addition. Competitive and final browser
passes remain fresh after a substitution. Ordinary architectural review retains
its single dedicated browser-chat identity when one already exists; a substitution
does not create a second browser architectural stream. An explicit
`adversarial-draft-review` loop never replaces the GPT competitive stage or the
normal architectural stage.

The flow-manager applies the existing rubric, stage-selection
rules, and T3-critical/L4 classification at intake, after every material
Issue/scope change, and immediately before the final architect lens. Ambiguous or
unparseable classification follows the existing fail-up behavior. If that
pre-final recomputation makes the task T3-critical, the independent Codex addition
must complete before the final lens.

### Tier provenance and final-lens demotion audit (#973)

The first authoritative tier floor is not author-controlled Issue metadata. For
a fresh Issue-only workdir, before the first tier-gate decision the current Cursor
flow-manager records one `tier-intake/v1` record in the existing review directory
with `producer: cursor-flow-manager`, task identity, `kind: fresh`, the rubric/guard
intake prior, and the first immutable `rNN` revision. The Issue
`advisory-prior` is a mirror and must match this record. Missing, malformed, or
mismatched intake evidence fails closed. No architect attribution is required at
intake, for direct Issue/task-chat entry, or for brief-only entry.

The implementation contains one static frozen production compatibility set. At
#973 cutover that set is deliberately empty: every production identity follows
fresh rules. Runtime code never discovers, infers, appends, or extends membership.
Compatibility semantics remain fixture-testable only through explicitly injected
membership; they never rewrite historical revisions or infer legacy status from
local workdir shape.

After every immutable pull, the flow-manager records the applied tier decision in
that `rNN` directory as `tier-gate-decision/v1`: producer, revision, tier, fired
applicable rubric labels from the mapping above, and the
current L4 result (`clear|active|ambiguous|missing|stale`). This is same-user
audit evidence, not cryptographic authorization. Once a first valid revision
exists, the highest tier in preceding immutable revisions is the transition
high-watermark; changing `advisory-prior` cannot hide a downstep.

A valid downstep is exactly one adjacent tier step and may occur only at the final
architect lens, at most once in the task lifecycle. The original lens capture
contains one fenced `tier-demotion-event/v1` JSON record with an event id,
`role: architect`, `stage: final-architect-lens`, exact source revision, before and
after tiers, and one non-empty prose rationale for every source driver. The driver
set must equal the source decision's rubric labels exactly; no
missing, extra, or substituted driver is accepted. The Issue complexity-tier
fence then carries the stable original event id and immediately pre-demotion tier
(`demotion-event` + `demotion-from`). Author text, intake evidence, or those fence
fields alone never authorize the lower tier.

After the task chat applies the authorized title/fence change and the flow-manager
re-pulls it as a new immutable revision, the full tier gate remains red until a
newer architect final-lens capture emits `tier-demotion-revalidation/v1` for that
exact candidate and same event, with the original before/after tiers and current
L4 result. Acceptance and final verification always run the full tier gate on the
current anchor. A crash between re-pull and revalidation therefore leaves the
current candidate rejected; no pending-state record, journal, lease, or state
machine is added. Same-event revalidation may repeat after same-tier fixes without
consuming another demotion. Any later up-escalation is allowed and required, but
closes event reuse; a later downstep is a forbidden second demotion.

A below-T3 candidate also requires current `clear` L4 evidence. Missing, stale, ambiguous, conflicting, partial, or
wrong-stage/role evidence fails closed. Same-user fabrication remains the explicit
CX973-1 residual trust risk: these records provide mechanical auditability and
consistency, not unforgeable identity authentication, and #973 adds no signer,
remote attestation, protected store, database, or dynamic registry.

For a frozen-list compatibility demotion, the architect may import only a
pre-#973 downstep already proven by immutable before/after revisions plus existing
architect final-lens evidence and a mechanically reconstructable source driver set.
It consumes the same sole lifecycle demotion and cannot authorize a new downstep.
The production compatibility set and qualifying historical-demotion population are
both empty at #973 cutover, so this path is dormant outside explicit test fixtures.

### Per-tier pipeline (ceilings, not quotas)

Clean `NO_FINDINGS` ends a stage early. The post-lens final-verification round is
an additional ×1 round and is not charged against the ordinary architectural
ceiling.

| Tier | Stages |
|------|--------|
| **T1** | One light browser-GPT architectural pass in the task's dedicated ordinary-architectural chat; after the final architect lens, one additional fresh-chat browser-GPT final-verification round only when the lens changed content. |
| **T2** | Browser-GPT architectural review, up to **3** passes in one dedicated ordinary-architectural chat; first `NO_FINDINGS` ends the ordinary stage. After the final architect lens, one additional fresh-chat browser-GPT final-verification round only when the lens changed content. No competitive stage unless separately selected by an explicit wrapper contract. |
| **T3** | Competitive adversarial browser-GPT review up to **3** fresh-chat passes → browser-GPT architectural review up to **4** passes in one dedicated ordinary-architectural chat → final architect lens → mandatory fresh-chat browser-GPT final-verification round **1**. |

**T3-critical** (within-T3 graduation): gated by the **L4-condition list recorded
in Issue #574 / `docs/issues_drafts/187-task-complexity-tier-rubric.md` Decisions**
(cite by reference — do not restate). T3-critical requires qualifying independent
**GPT and Codex together**: the normal browser-GPT participation plus a mandatory
independent Codex addition. It also requires the existing rollback/migration note
and crash/race/stale-state test floors. A Codex outage substitution for a
browser-GPT stage never satisfies the GPT half of this requirement. Without
qualifying independent GPT participation, acceptance is blocked or deferred.

### Finding-disposition ledger + M1 defect/remedy split

Every reviewer capture remains immutable verbatim audit evidence. Every material
governed finding keeps defect facts in raw `evidence:` and non-binding remedy
advice in raw `recommendation:`. A stable finding `id` identifies the defect, not
one immutable remedy proposal.

The flow-manager normalizes each finding into the existing disposition ledger
with stable `id`, `summary`, `type`, and the browser-GPT author's defect-level
`disposition` — `addressed` or `rejected`, plus one-line `rejectReason` for a
rejection. Declining one remedy does not reject or erase the defect. The author
may close a valid defect with any cheaper sufficient correction that satisfies
the same observable contract.

The ledger and verbatim `pass-NN-<stage>.capture.txt` files live in the
out-of-repository audit workdir defined by
`.claude/skills/create-issue-draft/SKILL.md`; they are not tracked task artifacts.
A finding present in capture but absent from the ledger is a silent drop and
invalid. `NO_FINDINGS` never erases earlier findings.

### M2 — price persistent machinery at proposal time

Every reviewer capture governed after the #975 adoption boundary contains exact
`review-economics-contract: v1`. Every governed material finding contains raw
`evidence:`, `recommendation:`, and `persistent-machinery: yes|no`.

`persistent-machinery: yes` means the proposed remedy adds persistent state, a
record kind, subsystem, guard, or standing test obligation. Every `yes` also
contains:

- `cheapest-sufficient-alternative` — a cheaper sufficient design, including
  elimination/no-build where viable, or why elimination is insufficient;
- `stakes-price` — the narrowest explicit failure-impact/blast-radius statement;
- `trade-in` — existing mechanism/ceremony removed by the addition, or exact
  `net-add`.

When no explicit stakes statement exists, `stakes-price` is exact
`stakes-undeclared`; do not invent high stakes to justify a net addition. Default
toward elimination/no-build or the cheapest sufficient correction unless the
defect itself proves a material failure against an existing observable contract.

A `yes` missing a price field is a malformed **proposal**, not an invalid defect.
The author may decline only that remedy with row-local exact reason
`malformed-proposal`; defect disposition remains independently required.

The latest **marked** occurrence of a stable finding id controls its current
machinery classification, price fields, and proposal outcome. `yes -> no` and
`no -> yes` are valid when the latest occurrence and ledger agree. Earlier raw
occurrences remain immutable. Machinery already introduced from an earlier
proposal stays visible in the M4 inventory until explicitly classified; no
per-occurrence proposal ledger or registry is created.

#### M2 adoption cutover

The adoption boundary is independent of reviewer text. For work not already
active when #975 lands, the #975 landing point on the implementation base is the
boundary. For an already-active cycle, the operator or current flow-manager
records one independently established ISO-8601 adoption timestamp on a
`review-economics-adopted-at:` line in the existing `$REVIEW_DIR/chats.md` audit
file. This adds no service, registry, or tracked store.

The first reviewer capture chronologically after that boundary, and every later
reviewer capture, must be marked. A later self-supplied rubric downgrade cannot forgive an
earlier unmarked post-adoption capture. Missing or ambiguous chronology fails
closed. Reviewer stages are `competitive`, `architectural`, and
`architectural-final`; `architectural-lens` is architect evidence and is excluded
from rubric continuity. Immutable pre-adoption captures are not rewritten and do
not owe retroactive M2 fields. Before acceptance there must be governed reviewer
evidence after adoption.

This cutover is **M2-only**. Every still-active acceptance attempt uses current
M3 semantics regardless of ledger age; historically completed ledgers remain
readable without backfill.

### M3 — protected nomination, author activation, architect contest

Reviewer `type: security` and `type: scope-violation` are protected
**nominations**, not self-activating authority. The vocabulary and canonical
protected-signal meaning remain unchanged.

A valid author activation records both a real corresponding canonical protected
signal and why closure belongs in this task now. It is independently authoritative
when the nomination is non-zero-signal, no current architect contest or other
architect-required condition applies, and current audit evidence makes contest
absence/withdrawal unambiguous. Activated findings are addressed-only; remedy
choice remains cheapest-sufficient.

The finding-scoped `zero-signal` check scans only the raw finding's `evidence:`.
It excludes the nomination `type:`, `recommendation:`, machinery/price fields,
and other remedy prose. Remedy-only terms such as `denylist` cannot manufacture
protected evidence. A zero-signal author activation is invalid.

Architect adjudication is required for zero-signal nominations, missing/invalid
author activation, a current/unknown/stale contest, or another existing rule that
requires the architect. An architect outcome is `activate` or `non-activate`.
`activate` makes addressed-only apply; `non-activate` restores ordinary M1
disposition for the underlying defect.

Architect authority reuses the existing latest applicable
`pass-NN-architectural-lens.capture.txt`; no contest registry, receipt, signing
system, or service is introduced. The guard recognizes one line per protected id:

`m3-protected: id=<id> | revision=<exact-current-revision> | contest=none|contested|contest-withdrawn | outcome=none|activate|non-activate | evidence=<architect evidence when activating> | why-now=<why closure belongs now when activating>`

Only architect-lens evidence may create/withdraw contest state. `contested`
binds to the exact finding id and Issue revision. A same/newer applicable lens
closes it with `activate`, `non-activate`, or `contest-withdrawn`. A stale,
unknown, malformed, or ambiguously bound contest fails closed to
`architect-pending`. Architect-issued activation needs current real canonical
protected evidence plus why-now in the lens record; non-activation still needs
matching current id/outcome provenance.

At **pre-lens progression**, genuinely architect-required protected work may be
recorded as `architect-pending` and proceed only to that lens. At **final
acceptance**, `architect-pending` never passes. A valid non-zero-signal author
activation needs no architect **authorization**; a separately required newer lens
is freshness/audit and must not be described as retroactive authorization.

The global protected-signal receipt/fingerprint/suppression behavior remains
unchanged outside this finding-scoped M3 check.

### Stakes-weighted proportionality

Disposition is not a vote on whether the reviewer's defect observation is
factually correct. A finding that proposes durable-state, CAS, attestation,
crash-resume, or threat-model-class machinery may be `rejected` as **correct but
disproportionate** when the failure does not materially matter at the artifact's
stated stakes or the proposal is not the cheapest sufficient guard. Its
`rejectReason` connects the verdict to blast radius, reversibility, failure
impact, and a cheaper sufficient design; bare reasons such as “too complex” are
not sufficient.

| Finding category | Contained and reversible stakes | Bounded blast radius | Systemic or irreversible stakes |
|---|---|---|---|
| Durable-state / CAS / attestation / crash-resume machinery | Prefer rejection when a local invariant, explicit constraint, or no-build alternative is sufficient. | Keep only the smallest mechanism that contains the stated failure. | Address when the systemic failure is credible; rejection requires an equally sufficient cheaper design. |
| Correctness / logic defect | Usually address with the narrowest correction. | Address the affected contract and its bounded failure path. | Address; high-stakes correctness is not traded for authoring convenience. |
| Missing test coverage | Prefer the focused example or existing proof that covers the contained failure. | Add coverage proportional to affected classes and blast radius. | Require evidence broad enough for systemic/race/recovery/irreversible failures. |
| Phrasing / style | Reject when wording cannot alter the contract or worker interpretation. | Address ambiguity that could misroute implementation or verification. | Address wording that obscures guarantees, rollback, ownership, or failure handling. |

### M4 — author-maintained mechanism inventory

After every review round, the author reply updates one running inventory of every
new material review-added mechanism/ceremony introduced by that round. Each item
is classified exactly once as `keep`, `simplify`, `defer`, or `cut`. Keep the
inventory in the existing author-reply audit evidence; do not create a tracked
store. `defer` creates no automatic follow-up Issue.

The latest inventory is input to every applicable final architect lens. Re-emitting
a finding with cheaper current economics never erases machinery that was already
introduced; the inventory carries it until it receives one of the four outcomes.

### M5 — truthful terminal simplification verdict

M5 uses the **terminal pre-lens reviewer result selected by the existing
stage/convergence contract**. It does not introduce another convergence state
machine or confirmation reviewer pass.

A finding is an M5 cut candidate only when its raw block contains exact
`simplification-cut-candidate: yes`. Any other value, duplicate discriminator, or
malformed discriminator blocks progression. The normalized ledger row for the
same stable id must carry the corresponding candidate flag; raw/ledger mismatch
in either direction fails closed. Ordinary simplification prose without the exact
token is not a cut candidate.

The terminal raw result has two truthful shapes:

1. no raw cut candidate → exact `SIMPLIFICATION_CLEAN` is required; if the result
   is genuinely clean it also carries existing `NO_FINDINGS`, while a legal
   non-clean terminal result must not fabricate `NO_FINDINGS`;
2. one or more tokened cut candidates → those findings are the non-clean M5
   verdict, no retroactive `SIMPLIFICATION_CLEAN` is inserted, and every candidate
   must be ledger-mapped and dispositioned or legitimately `architect-pending`.

A reviewer cut candidate is still a normal finding, never a cut decision. The
author may perform an ordinary M1 content correction. The final architect lens
remains the sole **independent aggregate** cut authority.

#### M5 episode anchor and adoption floor

The terminal pre-lens reviewer result immediately before the first final lens in
a contiguous lens/final-verification episode is that episode's M5 anchor.
Same-episode relenses caused by lens fixes or final-verification findings reuse
the applicable post-adoption anchor; every newer lens still audits the current
Issue body and latest M4 inventory. `architectural-final` is M2-governed reviewer
evidence but never becomes M5 merely because it follows a lens.

A pre-adoption anchor cannot satisfy final acceptance. Immutable older captures
stay untouched, but the cycle must re-enter one existing governed pre-lens
reviewer stage after adoption. Once existing stage/convergence authority declares
that post-adoption result legally terminal, it starts the new segment and becomes
the anchor. There is no grandfather/exemption path and no synthetic clean-token
pass.

### Two-phase finding-ledger guard

`scripts/finding-ledger-guard.mjs` keeps legacy behavior when invoked without a
#975 phase. The #975 flow calls the same guard in two bounded phases:

- **`pre-lens`** — only after existing stage/completion authority declares the
  selected pre-lens sequence legally terminal; enforces post-adoption M2 rubric
  continuity/structure and M5 terminal evidence, and permits genuinely
  architect-required M3 state only as `architect-pending` for progression to the
  lens. It never certifies acceptance.
- **`final-acceptance`** — rechecks applicable immutable M2/M3/M5 evidence,
  requires a post-adoption M5 anchor, enforces current revision-bound architect
  outcomes/contest closure where required, and preserves the normal latest-lens /
  latest-final and other acceptance floors owned by the surrounding flow.

The guard does not edit captures/Issue state, select a defect/remedy disposition,
create a reviewer pass, or add a persistence/provenance service.

### Post-lens protected nomination path

A protected nomination first emitted in `architectural-final` cannot be
adjudicated by the older lens. Preserve and normalize the raw final capture, then
apply M3. Valid non-zero-signal author activation is authoritative immediately
when uncontested; otherwise record `architect-pending`. In both cases the existing
final-finding loop requires a **newer final architect lens** before another final
verification. If no Issue content change is required, that lens may run over the
unchanged current Issue revision. It audits a valid author activation or records
required contest closure/adjudication; it does not retroactively authorize the
author. After the latest lens run exactly one fresh `architectural-final` pass.
No synthetic Issue edit or extra reviewer stage is added.

### Simplification lens

The four-question lens in `prompts/codex_draft_review_prompt.md` remains mandatory:
what can be simplified / must not be simplified / is excess / is missing. M2 now
prices persistent remedies when proposed; M4 keeps the running mechanism
inventory; M5 supplies truthful terminal pre-lens simplification evidence.

### Final architect lens and tier movement

After the ordinary review stages and every required pre-final Codex addition
complete, and after the **pre-lens #975 guard is green**, the final architect lens
runs on the current Issue revision. It is the sole **independent aggregate** cut
authority for review-added machinery and the **only sanctioned tier-downgrade
point**. Ordinary author fixes to reviewer-originated simplification findings
before this lens remain ordinary defect dispositions, not independent aggregate
cuts.

For T3, preserve the existing reject-partition audit before mechanism verdicts:
re-judge rejects without reopening accepted/addressed findings. The lens consumes
the current Issue body, the ledger reject partition, current M3 protected state,
the latest M4 inventory, and the applicable M5 anchor.

The final lens has four mandatory goals, in this exact order:

1. **Contradiction check.** Verify the task's conditions do not contradict each
   other. Any contradiction found is **fixed through the normal task-chat fix
   path**, not merely recorded.
2. **Feasibility check.** Verify the task is actually buildable as written, using
   live probes over assumptions wherever the claim can be probed.
3. **Cut ALL overengineering — PRIMARY goal.** Re-evaluate every major mechanism
   against the artifact's stated stakes × mechanism cost/risk × cheapest
   sufficient alternative. Explicitly answer **“which mechanism would be cut if
   one had to be?”** and resolve that answer as either a real cut through the
   normal task-chat fix path or a recorded keep-justification explaining why the
   mechanism is necessary. As part of this same anti-overengineering goal,
   explicitly reconsider whether the task still needs its current complexity tier:
   ask whether simplification or removal of higher-tier drivers makes a lower tier
   valid under the existing rubric. Apply the existing final-lens downgrade path
   when it does; otherwise record why the current tier remains required. Applicable L4
   floors and the active demotion contract still bind, so tier reconsideration
   never forces a downgrade. “Traces to a finding” alone is not a
   keep-justification. A lens verdict without both the forced-cut answer and an
   explicit tier-reconsideration result is invalid.
4. **Find what was missed.** Identify gaps, unverified evidence, and unsettled
   conditionals, and route any required content correction through the normal
   task-chat fix path.

For T3, record explicit **keep** or **cut** for each major mechanism using explicit
stakes × mechanism cost/risk × cheapest sufficient alternative. Repackaging or
splitting an over-built mechanism across sibling tasks is not itself a cut. Same-
episode relenses reuse the post-adoption M5 anchor but inspect the latest body and
M4 inventory. Issue #973 remains the owner of demotion records and rubric
applicability.

When that lens authorizes a #973 downgrade, ordering is strict: source-revision
demotion event → task-chat Issue edit → immutable re-pull → expected full-gate
rejection → architect current-candidate revalidation → full-gate success → the
required fresh final architectural pass. Revalidation references the stable
original event and is not a second demotion.

Any Issue content change after a final lens invalidates that lens for acceptance.
After a lens-directed fix or a later final-verification finding changes the Issue,
the flow-manager re-pulls the author revision and the final architect lens runs
again on that candidate before the tier flow's required fresh final verification.
A protected nomination first emitted post-lens follows the M3 path above and also
requires the newer final lens before another final verification.

If a low/contained-stakes artifact exits adversarial review with approximately
100% of findings `addressed`, record that as a **proportionality smell** in the
same lens capture and re-examine whether review-added machinery is actually the
cheapest sufficient design. The smell is neither an automatic failure nor evidence
of thoroughness; it prompts a fresh check for correct-but-disproportionate machinery.
