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

| Tier | Review sequence | Pre-lens #975 | Terminal lens | Tier downgrade |
|------|-----------------|---------------|---------------|----------------|
| **T1** | Exactly **one** independent browser-GPT `architectural` lens (not the author chat) → acceptance | **No** | Same GPT lens owns aggregate cut + M5 anchor | **None** |
| **T2** | Exactly **one** independent browser-GPT `architectural` lens → acceptance. **No** competitive or `architectural-review` create-flow stage | **No** | Same GPT lens owns aggregate cut + M5 anchor | **None** |
| **T3** | **1–3** fresh `competitive` passes → exactly **one** fresh `architectural-review` → **pre-lens #975 guard** → exactly **one** full Claude `architectural-lens` (or valid `claude-unavailable` skip) → author dispositions/fixes → exactly **one** terminal independent browser-GPT `architectural` lens → acceptance | **Yes** (after competitive + `architectural-review` are terminal) | Claude owns **pre-terminal** aggregate cut; terminal GPT owns **final** aggregate cut + M5 anchor | **T3→T2 only**, at Claude lens |

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

- **Browser GPT author.** The current author chat owns authoring, every content
  fix, direct edits to the live GitHub Issue, every finding disposition, M3 author
  activation, and the M4 mechanism inventory. Reviewer findings are proposals to
  this author. The current author chat may be a fresh continuation reconstructed
  from the live Issue when historical chat state is unavailable.
- **Flow-manager (OpenCode default when no runtime is selected; capable operator-selected runtime such as Cursor or Codex allowed).** One current
  flow-manager per task owns the operational
  cycle end-to-end: live Issue pulls, rubric/guard application, fixed per-tier
  stage order, mechanical/body floors, immutable captures, finding-ledger
  bookkeeping, pass accounting, chat references/topology, browser-turn execution,
  #975 adoption evidence, and economics-guard execution. It records author
  dispositions but does not author spec content or judge findings. Runtime names
  are not a tracked admission allowlist. A successor may act only after the latest
  explicit predecessor/operator handoff recorded in an existing audit/chat surface;
  that handoff immediately ends the predecessor's manager authority.
- **Claude architectural-lens (T3 only).** Exactly one full `architectural-lens`
  capture per cycle segment, produced by an independent Claude Code CLI invocation
  with co-located producing-run evidence. Owns pre-terminal M3 contest/adjudication
  when required, the **pre-terminal independent aggregate cut**, and one
  sanctioned adjacent `T3→T2` downstep. Never runs after the terminal GPT lens.
  Never operates routine browser turns or maintains the ledger.
- **Browser GPT reviewer lenses.** Independent review chats only. T3
  `competitive` and `architectural-review` are pre-Claude reviewer stages;
  `architectural-review` is not M5 and has no tier-demotion authority. Terminal
  `architectural` owns final aggregate cut for acceptance on every tier and is
  the M5 anchor at final acceptance. Terminal GPT may authorize one adjacent
  downstep (`T3→T2` or `T2→T1`) per authoritative capture; sequential
  `T3→T2→T1` requires two separately authorized adjacent steps on distinct source
  revisions.

**Browser outage.** Required GPT work stays incomplete. No engine substitution.

**In-flight cycles.** Restart the fixed per-tier sequence from intake; do not infer
historical provenance to skip stages.

### Tier provenance and demotion audit (#973)

The first authoritative tier floor is not author-controlled Issue metadata. For
a fresh Issue-only workdir, before the first tier-gate decision the current
flow-manager records one `tier-intake/v1` record in the existing review directory
with `producer` set to the manager's exact non-empty audit label, task identity,
`kind: fresh`, the rubric/guard intake prior, and the first immutable `rNN`
revision. The producer label is preserved verbatim but is **not** checked against a
finite runtime-name allowlist and is not authentication or authorization. The Issue
`advisory-prior` is a mirror and must match this record. Missing, blank, malformed,
or mismatched intake evidence fails closed.

A flow-manager runtime that does not read `.claude/skills/**` natively must be
explicitly handed or load `.claude/skills/create-issue-draft/SKILL.md` as the
canonical create-issue-draft procedure.

After every immutable pull, the flow-manager records the applied tier decision in
that `rNN` directory as `tier-gate-decision/v1`: producer, revision, tier, fired
applicable rubric labels, and the current L4 result
(`clear|active|ambiguous|missing|stale`).

A fresh lifecycle may consume one adjacent ladder edge per authoritative lens
capture: Claude `architectural-lens` may authorize `T3→T2`; terminal GPT
`architectural` may authorize `T3→T2` or `T2→T1`. Direct `T3→T1`, an upstep,
`T1→below-ladder`, two downsteps in one capture, duplicate edges, branching, and
reuse after an intervening upstep fail closed. `T3→T2→T1` is valid only as two
events on distinct source revisions whose edges form one ordered contiguous
chain. The second event uses the revalidated T2 revision's receipt and exact
rubric-driver set, never the original T3 receipt. The current fence names the
latest event and its `demotion-from` is the immediately preceding tier segment,
not the lifetime high watermark.

Both engines reuse `tier-demotion-event/v1`. Capture identity and embedded stage
are deliberately distinct:

- Claude event: `role: architect`, `stage: final-architect-lens`, in
  `pass-NN-architectural-lens.capture.txt`;
- GPT event: `role: reviewer`, `stage: final-architectural`, in
  `pass-NN-architectural.capture.txt`.

Each event binds its exact source revision, adjacent before/after tiers, and one
non-empty rationale for every source receipt rubric driver. Existing frozen
compatibility/historical identities retain the pre-#973 single-consumed-event
semantics; fresh-chain rules do not reinterpret their evidence.

After the current author chat applies the authorized tier/title/fence/body
correction and the flow-manager re-pulls it as a new immutable revision:

1. bind one `tier-demotion-revalidation/v1` to the event, exact candidate
   revision, transition, current receipt/driver decision, and clear L4 result;
   Claude uses `role: architect`, embedded `stage: final-architect-lens`, and a
   later `pass-NN-architectural-lens.capture.txt`;
2. after Claude demotion, run terminal GPT `architectural` on the revalidated T2
   candidate; after GPT demotion, use the **same GPT chat** for one bounded narrow
   revalidation turn saved as
   `pass-NN-architectural-demotion-narrow-revalidation.capture.txt` with
   `role: reviewer`, `stage: final-architectural-narrow-revalidation`;
3. permit that GPT narrow capture to contain only the revalidation JSON: it emits
   no findings, M3, M5, or synthetic clean state, and the original
   `pass-NN-architectural.capture.txt` remains the terminal M5 anchor;
4. proceed to acceptance when guards are green.

**No Claude after terminal GPT.** Cancel any historical
gate-red → GPT → Claude revalidation ordering.

### T3-critical (within-T3 graduation)

Gated by the **L4-condition list** recorded in Issue #574 /
`docs/issues_drafts/187-task-complexity-tier-rubric.md` (cite by reference — do
not restate). T3-critical adds **only** these non-waivable Issue-body floors:

- an explicit rollback or migration note appropriate to the change; and
- realistic acceptance criteria and matching verification for every material
  crash, race, or stale-state failure class.

There is **no** mandatory independent Codex review addition. Codex outage
substitution does not apply to create-issue-draft.

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
`architectural-lens` provenance, M3 authority, or `T3→T2` demotion authority.
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

Runs in an **independent fresh browser-GPT chat** (never the current author chat).
Applies the shared four-question rubric and review-economics contract. On
**T1/T2** this lens is the sole reviewer stage and owns aggregate cut + M5. On
**T3** it owns **final** aggregate cut + M5 after `competitive`,
`architectural-review`, Claude, and author fixes.

Terminal GPT may authorize bounded adjacent tier downsteps (`T3→T2` or `T2→T1`)
with narrow same-chat revalidation; Claude retains `T3→T2` authority.

Terminal GPT also has full current-revision M3 authority. Authoritative
`m3-protected:` records fold in capture/pass chronology across Claude and GPT, so
a later valid terminal record may confirm, replace, contest, or withdraw the
earlier Claude state for the same protected id/revision, including a nomination
first emitted by terminal GPT. Stale/malformed/conflicting state and unresolved
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
