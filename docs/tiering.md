# Task complexity tiering (architect / draft-author)

Worker **pre-flight** (blocking marker check before implementation) lives in
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
- **T3** — full ceremony: subsystem behavior, system guarantees, or any red-flag
  marker below — size does not discount danger.

### Failure-type lens (apply first)

Ask: **what is the worst thing this task can break?**

- Text/cosmetics only → usually **T1** (after marker silence).
- Local behavior of one function or module → usually **T2** (after marker silence).
- A subsystem's behavior or a system guarantee (CI gate, recovery, durable state,
  trust, concurrency, merge safety, operator evidence) → **T3**.

The enumerated red-flag markers below are the **reference backstop** for this
lens — not a substitute for reading it. Concrete examples live in the labeled
calibration sample (`tests/fixtures/task-complexity-tier-calibration.json`), not
here. That sample includes **on-ladder tasks only** — below-ladder work per the
skip line above is intentionally omitted.

### Classification order (hard precedence)

1. **Red-flag markers → unconditional T3.** If **any** marker below is present,
   the task is **T3** regardless of apparent size.
2. **Only if every marker is silent — size.** Small, obvious, ~1–2 files,
   self-contained → **T1**. One component needing real design judgment → **T2**.
3. **Doubt escalates up (fail-up).** Between two tiers, take the **higher**.

**Demote-only magnitude rule.** Numeric file/diff ceilings may only
**disqualify** a task from a lower tier (push it up). They may **never qualify**
a task into **T1**. Smallness is necessary but not sufficient for T1.

### Red-flag markers (any one → T3)

| Marker class | Present when the task… |
|---|---|
| **trust-boundary** | touches auth, permission, or trust-boundary surfaces |
| **spawn-capability** | grants spawn, capability, or elevated execution |
| **concurrency-state-retry** | changes concurrency, state-machine, event-ordering, or retry semantics |
| **ci-review-gating** | changes required CI/review gating, branch protection, merge authorization, or fail-closed check aggregation |
| **durable-state-evidence** | mutates durable state, evidence, provenance, ledgers, audit logs, or operator-visible snapshots |
| **test-harness-correctness** | risks fixture isolation, real-vs-stub binaries, self-certifying tests, or fixtures touching live state |
| **crash-recovery** | changes crash/recovery, restart mid-phase, orphaned claims/processes, duplicate execution, or liveness/kill-restart thresholds |
| **external-api-transport** | **changes** external-API transport behavior (retry, fallback, rate-limit, timeout, response-shape assumptions) — not mere API presence |
| **shared-contract-dependency** | introduces a new contract ≥2 future issues will depend on |
| **multi-surface** | spans multiple otherwise-independent surfaces |
| **ambiguity** | leaves genuine ambiguity in what is being asked |

Mechanical guard: `scripts/check-tier-calibration-consistency.ps1` over the
committed calibration sample.

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
  and proposed finding dispositions.
- **Authoring fallback.** When the browser is unavailable and the operator cannot
  raise it, the architect may use the separately recorded **architect-as-author**
  fallback.
- **Architect.** The architect writes the brief, applies the architect lenses,
  controls stage ordering and tier recomputation, and ratifies finding
  dispositions. It does not reopen addressed findings; on T3 the final lens
  re-judges only the reject partition. The architect does not replace the task
  chat for normal content fixes.
- **Browser GPT competitive review.** When the existing tier or an explicit
  request selects a competitive stage, each pass runs in a fresh browser-GPT
  chat. The stage ceiling remains three passes.
- **Browser GPT architectural review.** Every ordinary architectural pass and
  every final-verification pass runs in a fresh browser-GPT chat. Review history
  from one pass is not reused as input to another; only the persistent task chat
  carries authoring/fix continuity.
- **Codex.** Codex is not the default architectural-review engine. Its sanctioned
  roles are: the mandatory independent addition for T3-critical tasks; a recorded
  substitution for a browser-GPT review stage only when the browser is unavailable
  and the operator cannot raise it; and an explicitly user-requested standalone
  `adversarial-draft-review` challenge loop added on top of the normal flow.

A Codex substitution is captured, normalized, and dispositioned like the stage it
replaces. It creates no browser review-chat continuity; when browser-GPT review
resumes, the next browser review pass still starts in a fresh chat. An explicit
`adversarial-draft-review` loop never replaces the GPT competitive stage or the
normal architectural stage.

Issue #972 owns any later flow-manager/author/architect role split and browser-chat
topology change. The M1–M5 economics below are role-neutral: when #972 is present,
its current role/topology wording applies without weakening these economics.

### Per-tier pipeline (ceilings, not quotas)

Clean `NO_FINDINGS` ends a stage early. The post-lens final-verification round is
an additional ×1 round and is not charged against the ordinary architectural
ceiling.

| Tier | Stages |
|------|--------|
| **T1** | One light browser-GPT architectural pass in a fresh chat; after the final architect lens, one additional fresh-chat browser-GPT final-verification round only when the lens changed content. |
| **T2** | Browser-GPT architectural review, up to **3** fresh-chat passes; first `NO_FINDINGS` ends the ordinary stage. After the final architect lens, one additional fresh-chat browser-GPT final-verification round only when the lens changed content. No competitive stage unless separately selected by an explicit wrapper contract. |
| **T3** | Competitive adversarial browser-GPT review up to **3** fresh-chat passes → browser-GPT architectural review up to **4** fresh-chat passes → final architect lens → mandatory fresh-chat browser-GPT final-verification round **1**. |

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

The authoring flow normalizes each finding into the existing disposition ledger
with stable `id`, `summary`, `type`, and defect-level `disposition` — `addressed`
or `rejected`, plus one-line `rejectReason` for a rejection. Declining one remedy
does not reject or erase the defect. The author may close a valid defect with any
cheaper sufficient correction that satisfies the same observable contract.

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
reviewer capture, must be marked. A later self-supplied marker cannot forgive an
earlier unmarked post-adoption capture. Missing or ambiguous chronology fails
closed. Reviewer stages are `competitive`, `architectural`, and
`architectural-final`; `architectural-lens` is architect evidence and is excluded
from marker continuity. Immutable pre-adoption captures are not rewritten and do
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
system, or service is introduced. The guard recognizes one line per protected id
in this implementation:

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
  selected pre-lens sequence legally terminal; enforces post-adoption M2 marker
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

After ordinary review reaches its legal terminal state and the **pre-lens #975
guard is green**, the final architect lens recomputes the tier and checks the
ledger before acceptance. It is the **only sanctioned tier-downgrade point** and
the sole **independent aggregate** cut authority for review-added machinery.
Ordinary author fixes to reviewer-originated simplification findings before this
lens remain ordinary defect dispositions, not independent aggregate cuts.

A downgrade is invalid while the marker screen still requires the higher tier.
Every intake, mid-flight, post-fix, and pre-acceptance recomputation outside this
lens remains monotonic upward/fail-up; Issue #973 owns demotion records and marker
applicability and is not redefined here.

For T3, the lens audits the current Issue body, the ledger reject partition, the
latest M4 inventory, and the applicable M5 anchor. For each major mechanism it
records explicit `keep` or `cut` using the artifact's explicit stakes × mechanism
cost/risk × cheapest sufficient alternative. It must actively cut excess
machinery rather than treat prior reviewer provenance as justification. Same-
episode relenses reuse the M5 anchor but inspect the latest body/inventory, so
post-anchor machinery cannot hide behind earlier evidence.

The final lens remains **before** its required fresh final architectural
verification. A later final finding follows the existing
`final finding -> task-chat fix when needed -> newer final lens -> exactly one
fresh final verification` loop. This #975 economics contract does not add another
architect role/stage. Issue #972 remains the owner of role/topology wording; #973
remains the owner of tier-demotion/marker semantics.

If a low/contained-stakes artifact exits adversarial review with approximately
100% of findings `addressed`, record that as a **proportionality smell** in the
same lens capture and re-examine whether review-added machinery is actually the
cheapest sufficient design. The smell is not an automatic failure or evidence of
thoroughness.
