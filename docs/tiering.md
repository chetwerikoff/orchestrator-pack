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

### Guard-alignment prerequisite (#1030 intent)

Issue #1027's ordered #1030 prerequisite is the **guard-alignment** requirement:
landed `stage-completeness` and `finding-ledger-guard` behavior must match the
fixed topology below (terminal GPT `architectural` as M5 anchor; T1/T2 with no
`architectural-lens`; T3 with Claude pre-terminal then terminal GPT). When that
behavior is present — including via #1062 / PR #1073 — the prerequisite is
**satisfied** even if live Issue #1030 still describes superseded r03 ordering.
Policy acceptance does not require re-syncing the stale #1030 Issue body.

### Per-tier pipeline (ceilings, not quotas)

The flow-manager drives the full cycle through acceptance or a bounded blocked
outcome. There is no mandatory stop-and-hand-off to an architect outside the
stages below. Browser GPT is the only review engine in create-issue-draft; Codex
has no create-flow role.

| Tier | Review sequence | Pre-lens #975 | Terminal lens | Tier downgrade |
|------|-----------------|---------------|---------------|----------------|
| **T1** | Exactly **one** independent browser-GPT `architectural` lens (not the task chat) → acceptance | **No** | Same GPT lens owns aggregate cut + M5 anchor | **None** |
| **T2** | Exactly **one** independent browser-GPT `architectural` lens → acceptance. **No** competitive create-flow stage | **No** | Same GPT lens owns aggregate cut + M5 anchor | **None** |
| **T3** | Selected **pre-lens** stages (e.g. competitive when selected) → **pre-lens #975 guard** → exactly **one** full Claude `architectural-lens` → author dispositions/fixes → exactly **one** terminal independent browser-GPT `architectural` lens → acceptance | **Yes** (after pre-lens stages terminal) | Claude owns **pre-terminal** aggregate cut; terminal GPT owns **final** aggregate cut + M5 anchor | **T3→T2 only**, at Claude lens |

There is **no** `architectural-final` stage. Historical captures with that name
are audit-only.

**Reviewer GPT chats are distinct from the GPT author task chat.** Competitive
passes use a fresh browser chat per pass when selected. The terminal GPT
`architectural` lens uses its own independent fresh browser chat (never the task
chat or a competitive review chat).

**Shared lens rubric.** Every GPT lens and the Claude `architectural-lens` apply
the same four simplification questions and review-economics contract from
`prompts/codex_draft_review_prompt.md` (rubric source only — Codex is not invoked).

### Roles

- **Browser GPT author.** One task chat owns authoring, every content fix, direct
  edits to the live GitHub Issue, every finding disposition, M3 author activation,
  and the M4 mechanism inventory. Reviewer findings are proposals to this author.
- **Cursor flow-manager.** One current flow-manager per task owns the operational
  cycle end-to-end: live Issue pulls, rubric/guard application, fixed per-tier
  stage order, mechanical/body floors, immutable captures, finding-ledger
  bookkeeping, pass accounting, chat references/topology, browser-turn execution,
  #975 adoption evidence, and economics-guard execution. It records author
  dispositions but does not author spec content or judge findings. A successor may
  act only after the latest explicit predecessor/operator handoff recorded in an
  existing audit/chat surface; that handoff immediately ends the predecessor's
  manager authority.
- **Claude architectural-lens (T3 only).** Exactly one full `architectural-lens`
  capture per cycle segment, produced by an independent Claude Code CLI invocation
  with co-located producing-run evidence. Owns pre-terminal M3 contest/adjudication
  when required, the **pre-terminal independent aggregate cut**, and the **only
  sanctioned tier downgrade** (`T3→T2` only). Never runs after the terminal GPT
  lens. Never operates routine browser turns or maintains the ledger.
- **Browser GPT reviewer lenses.** Independent review chats only. Terminal
  `architectural` owns final aggregate cut for acceptance on every tier and is
  the M5 anchor at final acceptance. GPT cannot emit architect-only #973
  downgrade authority.

**Browser outage.** Required GPT work stays incomplete. No engine substitution.

**In-flight cycles.** Restart the fixed per-tier sequence from intake; do not infer
historical provenance to skip stages.

### Tier provenance and demotion audit (#973)

The first authoritative tier floor is not author-controlled Issue metadata. For
a fresh Issue-only workdir, before the first tier-gate decision the current Cursor
flow-manager records one `tier-intake/v1` record in the existing review directory
with `producer: cursor-flow-manager`, task identity, `kind: fresh`, the rubric/guard
intake prior, and the first immutable `rNN` revision. The Issue
`advisory-prior` is a mirror and must match this record. Missing, malformed, or
mismatched intake evidence fails closed.

After every immutable pull, the flow-manager records the applied tier decision in
that `rNN` directory as `tier-gate-decision/v1`: producer, revision, tier, fired
applicable rubric labels, and the current L4 result
(`clear|active|ambiguous|missing|stale`).

A valid downstep is **exactly `T3→T2`**, occurs only at the Claude
`architectural-lens`, and may happen at most once in the task lifecycle. There is
**no** `T2→T1` path.

The original Claude lens capture contains one fenced `tier-demotion-event/v1` JSON
record with an event id, `role: architect`, `stage: architectural-lens`, exact
source revision, before/after tiers, and one non-empty prose rationale for every
source driver. The driver set must equal the source decision's rubric labels
exactly.

After the task chat applies the authorized title/fence change and the flow-manager
re-pulls it as a new immutable revision:

1. record **narrow revalidation evidence** (not a full second Claude lens);
2. run the terminal GPT `architectural` lens on the post-demotion candidate;
3. proceed to acceptance when guards are green.

**No Claude after terminal GPT.** Cancel any historical
gate-red → GPT → Claude revalidation ordering.

### T3-critical (within-T3 graduation)

Gated by the **L4-condition list** recorded in Issue #574 /
`docs/issues_drafts/187-task-complexity-tier-rubric.md` (cite by reference — do
not restate). T3-critical adds **only** these non-waivable Issue-body floors:

- an explicit rollback or migration note appropriate to the change; and
- realistic acceptance criteria and matching verification for every material
  crash, race, or stale-state failure class.

There is **no** mandatory independent Codex addition. Codex outage substitution
does not apply to create-issue-draft.

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
| **T3 pre-Claude** | Retains Claude M3: zero-signal, absent activation, or contest → `architectPending` until the Claude `architectural-lens` adjudicates. |
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

For **T3**, the pre-lens #975 guard runs only after selected pre-lens stages
(e.g. competitive) are legally terminal. The terminal GPT `architectural` lens is
the M5 anchor at final acceptance.

Pre-adoption anchors cannot satisfy final acceptance. Re-enter a governed
post-adoption pre-lens stage when needed; do not mint synthetic clean-token passes.

### Two-phase finding-ledger guard

`scripts/finding-ledger-guard.mjs` keeps legacy behavior when invoked without a
#975 phase. The #975 flow calls the same guard in two bounded phases:

- **`pre-lens`** — **T3 only.** After existing stage/completion authority declares
  the pre-lens reviewer sequence legally terminal; enforces post-adoption M2 and
  pre-terminal M5 shape. Never certifies acceptance.
- **`final-acceptance`** — all tiers at acceptance; requires the terminal GPT
  `architectural` M5 anchor, applicable M2/M3 evidence, and current
  revision-bound outcomes.

### Claude architectural-lens goals (T3)

The Claude lens has four mandatory goals, in this exact order:

1. **Contradiction check** — fix contradictions via the task-chat fix path.
2. **Feasibility check** — verify buildability with live probes where possible.
3. **Cut ALL overengineering — PRIMARY goal** — forced-cut answer, explicit tier
   reconsideration, and `T3→T2` demotion only when justified under #973.
4. **Find what was missed** — route required corrections through the task-chat fix
   path.

For T3, record explicit **keep** or **cut** for each major mechanism.

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

Runs in an **independent fresh browser-GPT chat** (never the task chat). Applies
the shared four-question rubric and review-economics contract. On **T1/T2** this
lens is the sole reviewer stage and owns aggregate cut + M5. On **T3** it owns
**final** aggregate cut + M5 after Claude and author fixes.

GPT cannot authorize #973 demotion.

### Simplification lens

The four-question lens in `prompts/codex_draft_review_prompt.md` is mandatory on
every GPT and Claude lens: what can be simplified / must not be simplified / is
excess / is missing.

### Explicit wrappers

- **`discuss-with-gpt` brief-only wrapper** — routes into `create-issue-draft` and
  floors effective tier at **T2**; it does **not** add a competitive create-flow
  stage beyond the single terminal GPT `architectural` lens.
- **`adversarial-draft-review`** — standalone Codex only; **not** in create-flow.

If a low/contained-stakes artifact exits adversarial review with approximately
100% of findings `addressed`, record that as a **proportionality smell** in the
applicable lens capture and re-examine whether review-added machinery is actually
the cheapest sufficient design.
