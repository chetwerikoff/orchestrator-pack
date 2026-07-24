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
- **Browser GPT architectural review.** One dedicated browser-GPT review chat is
  created for the task and reused for every browser-GPT architectural turn,
  including browser-GPT final verification. It is distinct from the task chat
  and from every competitive chat.
- **Codex.** Codex is not the default architectural-review engine. Its sanctioned
  roles are: the mandatory independent addition for T3-critical tasks; a recorded
  substitution for a browser-GPT review stage only when the browser is unavailable
  and the operator cannot raise it; and an explicitly user-requested standalone
  `adversarial-draft-review` challenge loop added on top of the normal flow.

A Codex substitution necessarily runs outside the dedicated browser-GPT review
chat and is captured, normalized, and dispositioned like the stage it replaces.
When browser-GPT review resumes, later architectural turns continue in the same
dedicated browser-GPT review chat; a substitution never replaces that chat.
An explicit `adversarial-draft-review` loop never replaces the GPT competitive
stage or the normal architectural stage.

### Per-tier pipeline (ceilings, not quotas)

Clean `NO_FINDINGS` ends a stage early. The post-lens final-verification round is
an additional ×1 round and is not charged against the ordinary architectural
ceiling.

| Tier | Stages |
|------|--------|
| **T1** | One light browser-GPT architectural pass; after the final architect lens, one additional browser-GPT final-verification round only when the lens changed content. |
| **T2** | Browser-GPT architectural review, up to **3** passes; first `NO_FINDINGS` ends the ordinary stage. After the final architect lens, one additional browser-GPT final-verification round only when the lens changed content. No competitive stage unless separately selected by an explicit wrapper contract. |
| **T3** | Competitive adversarial browser-GPT review up to **3** fresh-chat passes → browser-GPT architectural review in the one dedicated review chat up to **4** passes → final architect lens → mandatory browser-GPT final-verification round **1** in that same dedicated review chat. |

**T3-critical** (within-T3 graduation): gated by the **L4-condition list recorded
in Issue #574 / `docs/issues_drafts/187-task-complexity-tier-rubric.md` Decisions**
(cite by reference — do not restate). T3-critical requires qualifying independent
**GPT and Codex together**: the normal browser-GPT participation plus a mandatory
independent Codex addition. It also requires the existing rollback/migration note
and crash/race/stale-state test floors. A Codex outage substitution for a
browser-GPT stage never satisfies the GPT half of this requirement. Without
qualifying independent GPT participation, acceptance is blocked or deferred.

### Finding-disposition ledger + normalization

Reviewers cannot be relied on for structured output. Per pass the authoring flow:

1. Captures **raw reviewer output verbatim** (audit anchor).
2. **Normalizes** every emitted finding into the disposition ledger with stable
   `id`, `summary`, `type`, and `disposition` — `addressed` or `rejected` plus
   one-line `rejectReason`.

The ledger and verbatim `pass-NN-<stage>.capture.txt` files live in the
out-of-repository audit workdir defined by
`.claude/skills/create-issue-draft/SKILL.md`; they are not tracked task artifacts.
The existing guard receives that review directory explicitly.

**Completeness:** a finding present in capture but absent from the ledger is a
silent drop — invalid. `NO_FINDINGS` passes owe no rows. Re-worded findings on
later passes map to the carried-forward `id`, not a new row.

**Stakes-weighted proportionality (non-protected findings).** Disposition is not
a vote on whether the reviewer's observation is factually correct. A finding
that proposes durable-state, CAS, attestation, crash-resume, or
threat-model-class machinery may be `rejected` as **correct but disproportionate**
when it fails both tests: the prevented failure materially matters at the
artifact's stated stakes, and the proposed mechanism is the cheapest sufficient
guard for that failure. Its `rejectReason` MUST connect the verdict to the stated
blast radius, reversibility, and failure impact and name the cheaper sufficient
design; bare reasons such as "out of scope" or "too complex" are not sufficient.

The following table is **illustrative, non-binding guidance — not a rigid lookup**.
It applies only after reading the artifact's own stakes statement; the stakes
axis is qualitative and is **not** the T1/T2/T3 ceremony tier.

| Finding category | Contained and reversible stakes | Bounded blast radius | Systemic or irreversible stakes |
|---|---|---|---|
| Durable-state / CAS / attestation / crash-resume machinery | Prefer rejection when a local invariant, explicit constraint, or no-build alternative is sufficient; name it in `rejectReason`. | Keep only the smallest mechanism that contains the stated failure; reject stronger machinery when a cheaper guard is sufficient. | Address when the systemic failure is credible; rejection requires an equally sufficient cheaper design, not optimism. |
| Correctness / logic defect | Usually address with the narrowest correction; reject only when the observation does not apply or a cheaper alternative fully preserves correctness. | Address the affected contract and its bounded failure path. | Address; high-stakes correctness is not traded for authoring convenience. |
| Missing test coverage | Prefer the focused example or existing proof that covers the contained failure. | Add coverage proportional to the affected classes and blast radius. | Require evidence broad enough to cover systemic, race, recovery, or irreversible failure modes. |
| Phrasing / style | Reject when wording cannot alter the contract or worker interpretation. | Address ambiguity that could misroute implementation or verification. | Address wording that obscures guarantees, rollback, ownership, or failure handling. |

### Non-rejectable carve-out

Findings with `type: security` or `type: scope-violation` (#51 vocabulary) have
exactly one valid disposition: `addressed`. The guard fails when a protected
finding is `rejected` **or omitted** while present in capture. Contested protected
findings **escalate to the architect** — never self-waivable by the authoring flow.

The carve-out protects the **outcome** (the risk is explicitly resolved or owned),
not one prescribed mechanism. `addressed` may be reached by eliminating the
attack surface the finding targets or by specifying an explicit, reasoned
defensive mechanism around it. When that defense would be disproportionate to a
near-zero-payoff threat, eliminate the surface or record an explicit, reasoned
risk-acceptance note with its assumptions and residual risk. This mechanism
choice never permits `rejected` and never permits silent omission.

**Guard:** `scripts/check-finding-ledger-guard.ps1 -CapturesDir …` (or
`check-draft-discipline.ps1 -Command finding-ledger`) validates **every**
`*.capture.txt` under the supplied review directory against the ledger — not only
the final pass — and runs pre-acceptance alongside other draft-discipline checks;
non-zero exit blocks acceptance/publication. Omission detection is layered and
fails closed: typed `type:` tags are checked directly; conservative
protected-signal hits in capture with no matching ledger row also fail (false
positives escalate to the architect; unparseable prose never passes silently).

### Simplification lens

The existing review contract, including the four-question lens in
`prompts/codex_draft_review_prompt.md`, mandates: what can be simplified / must
not be simplified / is excess / is missing. Lens findings flow through the
normal ledger and remain subject to the carve-out. The architect applies the
same lens on the final architect lens. Simplification and excess judgments weigh
every major mechanism against the artifact's stated stakes, its cost and risk,
and the cheapest sufficient alternative — not against ceremony tier alone.

### Final architect lens and tier movement

After the ordinary review stages converge, the final architect lens recomputes
the tier and checks the ledger before acceptance. It is the **only sanctioned
tier-downgrade point**. A downgrade is invalid while the marker screen still
requires the higher tier. Every intake, mid-flight, post-fix, and pre-acceptance
recomputation outside this lens remains monotonic upward/fail-up; accepted
findings that grow scope can only preserve or raise the tier.

For T3, the lens retains the existing stronger contract: audit the ledger's
**reject partition** (re-judge rejects; do **not** reopen accepts), and record for
each major mechanism an explicit **keep** or **cut** verdict using the artifact's
stated stakes × mechanism cost/risk × cheapest sufficient alternative.
Repackaging or splitting an over-built mechanism across sibling tasks is not, by
itself, an **излишне** cut: the lens must record a substantive reduction or
explicitly keep the total mechanism.

If a low/contained-stakes artifact exits adversarial review with approximately
100% of findings `addressed`, record that as a **proportionality smell** in the
same lens capture and run one re-examination pass. The smell is neither an
automatic failure nor evidence of thoroughness; it prompts a fresh check for
correct-but-disproportionate machinery.
