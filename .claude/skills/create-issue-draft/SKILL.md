---
name: create-issue-draft
description: Use when accepting a GPT-chat-authored task for `orchestrator-pack` — the user hands over a GitHub Issue link plus the browser-GPT task-chat link (or only a brief: one Cursor flow-manager opens the GPT task chat and GPT authors the Issue). The flow-manager owns operational tier/stage mechanics, captures, ledger bookkeeping, chat topology, and browser turns; browser GPT owns spec content and finding dispositions; ordinary architectural rounds reuse one dedicated GPT review chat; the architect appears only for optional pre-task consultation plus the mandatory final lens; competitive/final review chats stay fresh. Covers Issue-only live task state, mixed-engine Codex additions/substitutions, T3-critical L4 classification and safety floors, tracked `chatgpt-browser-turn` mechanics, issue-body guards, and the finding-disposition ledger. The Issue is the only live task artifact; audit artifacts live in an out-of-repo workdir. Invoke for on-ladder GPT-authored tasks; use the canonical below-ladder skip line from `docs/tiering.md`. Do not invoke when that skip line applies.
---

# create-issue-draft — GPT-chat authoring flow

Tasks are authored by the operator's **browser GPT** in the custom ChatGPT
project «orchestrator-pack». GPT creates the GitHub Issue, edits it directly
throughout the flow, and owns every content fix and finding disposition. One
current **Cursor flow-manager** owns the operational cycle. The architect is
outside that per-round cycle and appears only for optional pre-task consultation
plus the mandatory final architect lens.

The **GitHub Issue is the only live task artifact and queue entry**. Pulled
revisions, captures, chat URLs, manager handoffs, the finding ledger, #975
adoption evidence, and author replies live in an out-of-repo workdir and are never
committed. `docs/issues_drafts/**` and `docs/issue_queue_index.md` are read-only
prior art for this flow.

Issue #972 owns the flow-manager/author/architect role split and browser-chat
topology. The #975 M1–M5 economics below are independent of that ownership split
and must be preserved without reverting #972. Issue #973 remains the owner of
tier-demotion records and marker applicability.

## Inputs and routing

Supported intake forms are:

1. **Existing Issue + task-chat reference.** Hand both directly to the current
   Cursor flow-manager; no architect intake step is required.
2. **Brief-only direct entry.** Operator brief → flow-manager → one new
   browser-GPT task chat. That chat becomes the task chat; GPT authors the spec
   against the floors below and creates the Issue. The first body line becomes
   `GitHub Issue: #N` once known. The flow-manager then continues the normal
   cycle. Browser-authoring unavailability leaves authoring pending; it does not
   create an architect-as-author exception.
3. **Optional architect-first consultation.** Only when selected by the operator
   or task origin, the architect may prepare/critique the initial brief. Record
   that consultation, hand the brief to a new flow-manager, and then the
   architect leaves the cycle until the mandatory final lens.

For brief-only entry, the self-contained brief carries problem/goal, advisory
tier prior, constraints, out-of-scope, and verified grounding pointers. The
flow-manager opens exactly one new browser-GPT task chat and records its URL.

Explicit wrapper routing is preserved:

- brief-only `discuss-with-gpt` floors the effective tier at T2 and requires the
  requested browser-GPT competitive stage before acceptance;
- brief-only `adversarial-draft-review` floors the effective tier at T2 and
  requires the requested Codex loop before the final lens and acceptance.

Apply the canonical **Below the ladder — no tier** rule from `docs/tiering.md`.
When that rule applies, skip this authoring ceremony; otherwise continue here.

## Roles

| Party | Owns | Must not do |
|-------|------|-------------|
| GPT author in task chat | Spec content, every content fix, direct Issue edits, every finding disposition, M3 author activation, M4 mechanism inventory | Review its own spec |
| Cursor flow-manager | Live Issue pulls, tier/stage selection through existing rubric/guards, stage order, T3-critical classification, body/mechanical floors, immutable captures, ledger bookkeeping, pass counting, chat references/topology, browser-turn execution, #975 adoption evidence, pre-lens/final-acceptance guard mechanics | Author spec content, decide reviewer findings, perform the architect lens, invent new helper/runtime semantics |
| Architect | Optional pre-task consultation when selected; mandatory final architect lens including M3 contest/adjudication required by the active contract, the sole independent aggregate cut decision, and the only sanctioned tier downgrade | Operate routine browser turns, maintain ledger, ratify ordinary per-round dispositions, own ordinary stage ordering or intake/mid-cycle tier selection, author normal content fixes |
| Reviewer GPT chats | Competitive critique in a fresh chat per pass; ordinary architectural critique in one dedicated reusable review chat; final verification in a fresh chat | Edit the Issue, share the task chat, or self-activate protected authority |
| Codex | T3-critical independent addition; recorded browser-outage substitution; explicit requested adversarial loop | Become the default architectural engine or be credited for a stage it did not run |

### Flow-manager authority transfer

Exactly one current flow-manager authority exists per task. The latest explicit
predecessor/operator handoff recorded in an existing audit/chat surface such as
`$REVIEW_DIR/chats.md` or the task-chat handoff record is the transfer boundary.
Recording that handoff immediately ends the predecessor's flow-manager authority,
even if its Cursor session still exists. A successor acts only after the handoff,
reconstructs state from the live Issue plus existing audit artifacts, and reruns
missing required evidence under the existing stage/cap rules rather than
inventing it. Do not add a lease, heartbeat, ownership service, or new state
store for this role boundary.

## Chat topology

| Stream | Chat | Lifetime |
|--------|------|----------|
| Authoring, fixes, finding dispositions | one **task chat** | whole flow |
| Competitive review | **fresh browser-GPT chat per pass** | one pass |
| Ordinary architectural review | one **dedicated browser-GPT review chat** | reused across that task's ordinary architectural rounds only |
| Final architectural verification | **fresh browser-GPT chat** | one pass |
| Codex additions/substitutions | no browser chat | one cold invocation per pass |
| Architect | no browser review chat | optional pre-task consultation + mandatory final lens only |

Never review in the task chat or relay content fixes/dispositions anywhere except
the task chat. Never reuse a competitive or final-verification chat. Never reuse
the dedicated ordinary-architectural chat for a competitive/final stage or for a
different task. Reusing that one dedicated chat across ordinary architectural
rounds is intentional and is the only review-chat continuity in this flow.

## Pipeline

1. Intake: current flow-manager pulls title/body, creates/reconstructs workdir,
   records any manager handoff, establishes the independent #975 adoption
   boundary, recomputes tier/T3-critical stage selection, and runs body floors.
2. When the task began with optional architect consultation, preserve its brief
   evidence; otherwise no architect stage runs here.
3. Browser-GPT competitive stage when selected or explicitly requested, ≤3
   fresh-chat passes; findings return to the task chat for author disposition and
   the author updates M4 after each reviewer round.
4. Browser-GPT ordinary architectural review in one dedicated review chat, using
   the per-tier ceiling; findings return to the task chat for author disposition
   and M4 update.
5. Additional explicit Codex wrapper loop when requested; mandatory independent
   Codex addition for T3-critical tasks; recorded Codex substitution only for
   browser outage. Raw Codex #975 economics are validated before transcription.
   Before the final lens, the flow-manager recomputes tier/stage selection and
   completes any newly required stage.
6. After existing stage/convergence authority declares the applicable pre-lens
   reviewer sequence legally terminal, run the #975 `pre-lens` guard phase.
7. Mandatory final architect lens, including current M3 adjudication, latest M4
   audit, M5 anchor audit, the four current #972 final-lens goals, sole independent
   aggregate cuts, and the only sanctioned tier downgrade.
8. One fresh-chat browser-GPT final architectural pass after the latest final-lens
   capture when the tier/flow requires it.
9. Acceptance only over the current Issue revision after the #975
   `final-acceptance` guard phase and all existing floors are green, with a final
   lens covering that exact accepted revision.

Ordinary architectural review ends early on a valid raw result containing exact
`NO_FINDINGS`. `SIMPLIFICATION_CLEAN` is an additional M5 terminal token, not a
new pass or stage. Competitive and explicit adversarial loops preserve their
existing convergence rules and pass ceilings. A capped exit is allowed only when
the cap applies and unresolved questions are recorded in the ledger/final report.

## Step 1 — Intake, workdir, and #975 adoption boundary

Task identity is `<N>-<slug>`. Create:

```text
~/.local/state/create-issue-draft/<N>-<slug>/       # $WORKDIR
  docs/issues_drafts/<N>-<slug>.md                  # $ANCHOR
  docs/issues_drafts/.review/<N>-<slug>/            # $REVIEW_DIR
  r01/ r02/ …                                       # immutable pulled revisions
```

No repository support files are copied into `$WORKDIR`. Repository-owned guards
and the sync helper run from a trusted checkout root and receive the **absolute**
anchor path. The sync helper's tier validation uses `process.cwd()` as its
repository root and needs tracked marker, contract-evidence, manifest, and corpus
files available there.

The anchor is draft-shaped, not a raw body:

1. line 1: `# <live Issue title>`;
2. line 2: blank;
3. remaining lines: live Issue body verbatim.

Pull every revision through the pack wrapper and preserve an immutable copy:

```bash
WORKDIR="$HOME/.local/state/create-issue-draft/<N>-<slug>"
ANCHOR="$WORKDIR/docs/issues_drafts/<N>-<slug>.md"
mkdir -p "$(dirname "$ANCHOR")" "$WORKDIR/rNN" "$WORKDIR/docs/issues_drafts/.review/<N>-<slug>"
scripts/gh api repos/chetwerikoff/orchestrator-pack/issues/<N> \
  --jq '"# " + .title + "\n\n" + .body' > "$WORKDIR/rNN/<N>-<slug>.md"
cp "$WORKDIR/rNN/<N>-<slug>.md" "$ANCHOR"
```

Pull the title every time because the tier prefix lives in it. Record the task
chat, the one dedicated ordinary-architectural chat URL, every fresh competitive
and final-verification chat URL, every manager handoff, and any active-cycle #975
adoption timestamp in `$REVIEW_DIR/chats.md`. Record Codex invocations separately;
they have no browser-chat URL.

At intake, after every material Issue/scope change, and immediately before the
final architect lens, the flow-manager applies the existing tier rubric, marker
screen, stage-selection rules, and T3-critical/L4 classification. Ambiguous or
unparseable classification follows existing fail-up behavior. If the pre-final
recompute makes the task T3-critical, the mandatory independent Codex addition
must complete before the final lens.

### Independent review-economics adoption boundary

Reviewer output never chooses its own #975 cutover.

- **Cycle not already active when #975 lands:** use the #975 implementation
  landing timestamp from trusted repository history as `ADOPTION_TS`.
- **Cycle already active at that landing:** the operator or current flow-manager
  records the independently established ISO-8601 timestamp once in the existing
  audit file:

  `review-economics-adopted-at: <ISO-8601>`

  Reuse that exact value as `ADOPTION_TS`; do not infer it from a later reviewer
  marker or rewrite old captures.

Capture chronology is immutable-by-procedure audit evidence under the same-user
trust model as the existing review workdir. Missing/ambiguous adoption chronology
fails closed. Pre-adoption reviewer captures remain unchanged; M2 only starts
after the boundary. Current M3 applies to every still-active acceptance attempt
regardless of ledger age.

## Step 2 — Task-chat disposition/fix round + M4

For every reviewer finding, the flow-manager relays the finding to the one task
chat as a proposal. GPT author decides the defect disposition, chooses the remedy,
edits the GitHub Issue for every accepted/partial content fix, and returns a
change summary plus dispositions. Remedy advice is non-binding: a valid defect
may be closed with a cheaper sufficient correction. Protected nominations follow
M3 below.

After **every reviewer round**, the author reply updates one running inventory of
material mechanisms/ceremony introduced by that round. Each item is classified
exactly once as `keep`, `simplify`, `defer`, or `cut`. Keep the inventory in the
existing `round-NN-author-reply.md` evidence; do not create another tracked or
out-of-repo store. `defer` creates no automatic follow-up Issue. The latest
inventory is passed to every final lens.

Save the reply verbatim as `round-NN-author-reply.md`, re-pull title/body into a
new immutable revision when the Issue changed, and diff it. A content-fix reply
without an Issue edit is unfinished. Run body-only floors on the refreshed
anchor. Findings flow:

```text
reviewer -> flow-manager relay -> task chat author disposition/fix -> Issue edit -> re-pull
```

## Shared browser-review contract — M1/M2 + applicable M5 raw evidence

Every post-adoption browser-GPT **competitive, architectural, and final
architectural** pass uses a self-contained prompt applying the same review
contract. Conversation freshness follows the topology above: competitive and
final passes use new chats; ordinary architectural rounds continue the one
dedicated architectural chat. Every round carries the current Issue revision
explicitly; chat history is not a substitute for current task state.

The prompt must:

- wrap the current Issue body as UNTRUSTED DATA between nonce markers;
- request an alternative decomposition where relevant;
- require exact review-level `review-economics-contract: v1`;
- require every material finding to carry stable `id`, canonical plain `type`
  (`security|scope-violation|spec|quality|test|ci`), severity, separate raw
  `evidence:` defect facts, non-binding `recommendation:`, and
  `persistent-machinery: yes|no`;
- for every `persistent-machinery: yes`, require
  `cheapest-sufficient-alternative`, `stakes-price`, and `trade-in`; use exact
  `stakes-undeclared` when no explicit failure-impact statement exists and exact
  `net-add` when nothing is traded out;
- require the four-question simplification lens from
  `prompts/codex_draft_review_prompt.md`: what can be simplified, what must not be
  simplified, what is excess, and what is missing;
- permit a material cut candidate only with exact raw
  `simplification-cut-candidate: yes`; no other value or inferred flag;
- for pre-lens `competitive` / `architectural` outputs, require exact
  `SIMPLIFICATION_CLEAN` when that raw result has no tokened cut candidate; if the
  result is genuinely clean, also require exact `NO_FINDINGS`;
- keep post-lens `architectural-final` M2-governed, but do **not** require
  `SIMPLIFICATION_CLEAN` merely because it is clean or follows a lens.

Save the validated response verbatim before normalization. A malformed persistent
`yes` proposal missing a price field does not erase its defect. Normalize the
defect normally; the author may decline only that remedy with row-local
`proposalOutcome: "declined"` and exact `proposalReason: "malformed-proposal"`.

The latest **governed marked** occurrence of a stable defect id is authoritative
for current machinery classification/price/proposal economics. Pre-adoption and
earlier governed captures stay immutable. `yes -> no` and `no -> yes` are valid
when latest governed raw/ledger agree; M4 continues to account for machinery
actually introduced earlier.

### Normalized #975 ledger facts

Keep the existing stable row and add only row-local facts needed by the guard:

- `persistent-machinery`, plus the three price values when applicable;
- `proposalOutcome` / `proposalReason` only for a declined malformed proposal;
- `simplificationCutCandidate: true|false` matching the latest governed marked raw
  occurrence and, for M5, the terminal anchor;
- `protectedActivation: { authority: "author", signal: "...", whyNow: "..." }`
  when the author activates a protected nomination;
- `architectPending: true` only while current M3 genuinely requires a lens;
- `architectRequired: true` only when another existing rule independently
  requires architect adjudication.

Field organization is audit-only, not a new ledger/store schema service. The
existing defect-level `disposition` stays `addressed|rejected`.

## Step 3 — Competitive review

Run when selected by the effective tier or forced by an explicit
`discuss-with-gpt` wrapper. T3 always runs it; T2 runs it only when an explicit
wrapper/contract selects it. A red-flag marker recomputes the task to T3 rather
than creating a red-flagged T2 path. Only a direct operator decision may waive an
otherwise selected non-critical competitive stage, and the waiver is recorded.

Each pass:

1. open a **fresh** browser-GPT chat with `--new-chat`;
2. apply the shared #975 browser-review contract to the current Issue;
3. save verbatim as `pass-NN-competitive.capture.txt`;
4. normalize findings/economics, relay them through the flow-manager to the task
   chat for author disposition/fix, update M4, re-pull, and rerun body floors when
   content changed.

Stop on the existing legal no-accepted-finding terminal state or at cap 3 with
open questions recorded. If browser unavailability qualifies for substitution,
a cold Codex pass may use the exact `competitive` capture identity.

## Step 4 — Browser-GPT architectural review

Ordinary architectural review uses **one dedicated browser-GPT review chat per
task**. Open it once with `--new-chat` for the first ordinary architectural round,
record its returned conversation URL, and continue that exact chat with
`--chat-url` for later ordinary architectural rounds. The current Issue revision
and self-contained #975 prompt remain the review input on every round.

Each ordinary architectural pass:

1. first round: open the dedicated review chat with `--new-chat`; later rounds:
   target the recorded dedicated chat with its exact `--chat-url`;
2. apply the shared M1/M2 + pre-lens M5 contract;
3. save verbatim as `pass-NN-architectural.capture.txt`;
4. normalize the defect + economics facts, relay author fixes, update M4, re-pull
   changed Issue content, and rerun body floors.

Per-tier ceiling: T1 one light pass, T2 ≤3, T3 ≤4. A valid raw result carrying
`NO_FINDINGS` ends the ordinary stage early; capped exits preserve open questions.
Competitive/final chats are never reused here, and the dedicated ordinary chat
is never reused outside this task/stage.

### Browser-outage substitution

Only when the browser is unavailable and the operator cannot restore it may a
fresh cold Codex invocation replace a browser-GPT review pass. Use
[`adversarial-draft-review`](../adversarial-draft-review/SKILL.md), preserve the
replaced stage name (`competitive`, `architectural`, or `architectural-final`) in
the plain capture, store raw JSON alongside it, and record the substitution.

**Before transcription**, validate governed raw Codex JSON against the #975
contract in that skill. The plain capture copies raw economics/candidate facts
1:1 and may never synthesize missing fields. A substitution is credited only to
the browser stage it replaces and never satisfies the independent T3-critical
Codex addition. When browser GPT resumes, competitive/final stages use fresh
chats; ordinary architectural review resumes the already-recorded dedicated chat
or opens that single dedicated chat if none existed yet.

### Explicit Codex wrapper

When brief-only `adversarial-draft-review` was explicitly requested, run its
additional cold challenge loop after ordinary browser-GPT architectural review
and **before** the final lens. The explicit wrapper never replaces GPT competitive
or architectural review. Relay findings to the task chat for GPT author
disposition, apply accepted fixes there, update M4, and rerun body floors. Cap:
three passes under that skill's convergence rule. Raw-before-transcription #975
economics are mandatory.

### T3-critical classification and mandatory floors

Classify a task as **T3-critical** whenever it matches any L4 condition in Issue
#574 / `docs/issues_drafts/187-task-complexity-tier-rubric.md`. The declared tier
is only a prior. The flow-manager classifies at intake, after material Issue/scope
change, and immediately before the final lens. While an L4 condition remains, the
task cannot be downgraded below T3.

T3-critical means **GPT and Codex together**:

- the normal T3 browser-GPT competitive, architectural, and final stages run;
- an independent cold Codex challenge loop also runs after ordinary browser-GPT
  architectural review and before the final lens, under the
  `adversarial-draft-review` convergence rule (cap 3);
- this mandatory addition is independent of any explicitly requested Codex loop;
- a Codex outage substitution does not satisfy the mandatory independent Codex
  addition and never satisfies the GPT half.

T3-critical also adds two non-waivable Issue-body floors:

- an explicit rollback or migration note appropriate to the change, including
  safe reversal/transition boundary and operator action when applicable;
- realistic acceptance criteria and matching verification for every material
  crash, race, or stale-state failure class.

The flow-manager checks L4 classification and both floors before the final lens.
Missing classification evidence, rollback/migration coverage, realistic
failure-mode verification, qualifying GPT participation, or the independent
Codex addition blocks progression to the final lens/acceptance.

### Codex availability

Availability is fail-closed:

- the T3-critical independent Codex addition is mandatory and cannot be waived;
- an additional explicit non-T3-critical wrapper blocks until Codex is restored
  or the operator directly waives only that extra wrapper stage; record the
  waiver in ledger notes and final report;
- when Codex is selected as a browser-outage substitute and is unavailable, the
  replaced browser stage remains blocked.

Never call an unavailable or skipped required stage complete.

## M3 — protected nomination handling

Reviewer `type: security` or `type: scope-violation` is a **nomination**. It is
never silently dropped, but its type is not self-activating addressed-only
authority.

For every still-active cycle evaluated under #975:

1. find the nomination's raw `evidence:` only; do not scan `type`,
   `recommendation`, M2 prices, or other remedy prose for finding-scoped
   zero-signal;
2. author activation is valid only when raw evidence contains a real canonical
   protected signal and the author record includes both that signal and why
   closure belongs in this task now;
3. valid non-zero-signal author activation is addressed-only and independently
   authoritative while no current architect contest/other architect-required
   condition applies;
4. zero-signal, absent/invalid activation, current/unknown/stale contest, or
   another architect-required condition is recorded `architectPending: true`
   until the architect acts;
5. architect `activate` makes addressed-only apply; `non-activate` returns the
   underlying defect to ordinary M1 disposition.

Only a final architect-lens capture may create/withdraw a contest. Record one
machine-readable line for each touched protected id:

`m3-protected: id=<id> | revision=<exact-rNN> | contest=none|contested|contest-withdrawn | outcome=none|activate|non-activate | evidence=<real architect evidence when activating> | why-now=<why closure belongs now when activating>`

The line binds architect outcome/contest to the exact revision. Stale, unknown,
malformed, or ambiguous state fails closed. Architect activation needs current
real canonical protected evidence + why-now. A valid author activation does not
need architect authorization; a required later lens is freshness/audit only.

## Step 5 — Pre-lens progression and final architect lens

Run only after **existing** stage/convergence authority says the applicable
pre-lens reviewer sequence is legally terminal. Do not use #975 to invent a new
terminal state.

First run the bounded pre-lens economics phase:

```bash
node scripts/finding-ledger-guard.mjs \
  --ledger "$REVIEW_DIR/finding-disposition-ledger.json" \
  --captures-dir "$REVIEW_DIR" \
  --draft-path "$ANCHOR" \
  --phase pre-lens \
  --adoption-timestamp "$ADOPTION_TS" \
  --stage-terminal
```

This phase requires every post-adoption reviewer capture to be M2-marked,
validates latest raw/ledger proposal economics, validates terminal M5 shape, and
permits genuinely architect-required protected work only as
`architectPending: true`. It **never** certifies acceptance.

### M5 terminal anchor

For the first lens in a contiguous lens/final episode, the legally terminal
post-adoption pre-lens reviewer result is the M5 anchor. No raw
`simplification-cut-candidate: yes` → exact `SIMPLIFICATION_CLEAN` required
(`NO_FINDINGS` too only when genuinely clean). Tokened candidate(s) → no
retroactive clean token; each must match its ledger flag and be dispositioned or
legitimately architect-pending.

If the selected anchor predates `ADOPTION_TS`, stop. Preserve it, re-enter one
existing governed pre-lens reviewer stage, and let existing convergence authority
produce one legally terminal post-adoption result. That new segment supplies the
anchor. Do not insert a confirmation pass just to mint a token.

### Final architect lens

Run at every tier after all required pre-final stages and the pre-lens #975 guard
are green. The accepted candidate must be covered by the latest final lens after
the last Issue content change.

The final lens is the sole **independent aggregate** cut authority for
review-added machinery and the **only** sanctioned tier-downgrade point. It
consumes current Issue body, the T3 reject partition where applicable, current M3
protected state, latest M4 inventory, and applicable M5 anchor. Ordinary author
handling of reviewer-originated simplification remains an M1 fix, not an
aggregate lens decision.

It has four mandatory goals, in this exact order:

1. **Contradiction check.** Verify the task's conditions do not contradict each
   other. Any contradiction found is **fixed via the normal task-chat fix path**,
   not merely recorded.
2. **Feasibility check.** Verify the task is actually buildable as written, using
   live probes over assumptions wherever the claim can be probed.
3. **Cut ALL overengineering — PRIMARY goal.** Re-evaluate every major mechanism
   against explicit stakes, cost/risk, and cheapest sufficient alternative.
   Explicitly answer **“which mechanism would be cut if one had to be?”** and
   resolve that answer as a real cut through the task-chat fix path or a recorded
   keep-justification explaining why it is necessary. As part of the same goal,
   explicitly reconsider whether the task still needs its current complexity tier;
   apply the final-lens downgrade path when higher-tier drivers are gone, otherwise
   record why the tier remains required. Marker/L4 floors and #973 demotion
   mechanics still bind. “Traces to a finding” alone is not a keep-justification.
   A verdict without both forced-cut answer and explicit tier reconsideration is
   invalid.
4. **Find what was missed.** Identify gaps, unverified evidence, and unsettled
   conditionals and route required corrections through the normal task-chat fix
   path.

For T3, record explicit **keep** or **cut** for every major mechanism. Repackaging
or splitting an over-built mechanism across sibling tasks is not itself a cut.
Same-episode relenses reuse the post-adoption M5 anchor but audit latest body and
M4 inventory. The lens also records any required current-revision `m3-protected:`
contest/adjudication line. Issue #973 owns demotion record/marker mechanics.

Save the guard-recognized capture as
`pass-NN-architectural-lens.capture.txt`, with detailed analysis in
`presync-architect-lens.md`. A fix-required result returns to task chat; the
flow-manager re-pulls the changed Issue and this lens reruns as a newer capture.
Any Issue content change after a lens invalidates that lens for acceptance.

## Step 6 — Final architectural verification

T3 always runs one; T1/T2 run one only when the final lens changed content under
the current tier flow. Run it in a **fresh browser-GPT chat with `--new-chat`**,
apply the same #975 reviewer contract, and save verbatim as
`pass-NN-architectural-final.capture.txt`. `architectural-final` remains
M2-governed but does **not** owe M5 merely because it follows a lens.

If browser is unavailable and the operator cannot restore it, a cold Codex
substitution may use the same capture identity with raw JSON provenance; for
T3-critical it does not satisfy the GPT half or independent Codex addition.

If the final pass finds ordinary issues:

```text
final finding -> flow-manager relay -> task-chat author fix -> re-pull -> newer final lens -> one new final pass
```

Preserve failed final capture and ledger evidence. Never place two final captures
after the same latest lens. After the newer lens exactly one newer final may exist,
matching the existing stage-completeness contract.

### Protected nomination first discovered in final verification

The older lens cannot adjudicate a nomination it predates.

1. preserve/normalize raw final capture;
2. apply M3 immediately: valid non-zero-signal, uncontested author activation is
   authoritative; otherwise record architect-pending;
3. run the **newer final lens** required by the existing final-finding loop. If no
   Issue content change is required, it may review unchanged current `rNN`;
4. for valid author activation, lens records freshness/audit (`contest=none` or
   withdrawal) without pretending it authorized earlier author decision;
5. for architect-pending it records required contest closure/adjudication;
6. run exactly one fresh `architectural-final` after latest lens.

No synthetic Issue edit, extra reviewer stage, or confirmation M5 pass is added.

## Step 7 — Acceptance

Acceptance requires all pre-existing floors plus current M2/M3/M5 evidence. Run
stage completeness/body floors as usual, then the full economics phase over exact
current immutable revision identity (`rNN`):

```bash
node scripts/finding-ledger-guard.mjs \
  --ledger "$REVIEW_DIR/finding-disposition-ledger.json" \
  --captures-dir "$REVIEW_DIR" \
  --draft-path "$ANCHOR" \
  --phase final-acceptance \
  --adoption-timestamp "$ADOPTION_TS" \
  --issue-revision "rNN"
```

Final acceptance requires:

1. latest final architect lens covers exact Issue revision being accepted and the
   normal latest-lens/latest-final relationship holds;
2. clean final pass over that exact revision when required;
3. body floors, stage completeness, and full finding-ledger guard green;
4. every typed finding normalized and remedy outcome separate from defect
   disposition;
5. governed reviewer evidence after independent adoption boundary;
6. a legally terminal **post-adoption** M5 anchor; no grandfather exemption;
7. valid author M3 authority only with real-signal + why-now and current contest
   unambiguously absent/withdrawn, or current architect adjudication when required;
8. no architect-pending protected state;
9. live Issue title prefix matches final tier and all existing T3-critical floors
   are satisfied;
10. no selected browser-GPT stage skipped except through permitted recorded outage
    substitution; every mandatory T3-critical Codex addition complete and every
    explicit wrapper complete or explicitly waived only where allowed;
11. final report includes Issue URL, tier/pass counts, task/review chat URLs,
    current manager handoff, workdir, transport fallbacks, substitutions/waivers,
    T3-critical result, M4 summary, and residual risks.

Two non-converging `fix -> newer lens -> final` cycles escalate to the operator.

## Mechanical parity edits

Only mechanical format defects such as fence syntax or header shape may be fixed
by the flow-manager in the workdir anchor. Content fixes belong to the GPT author
in the task chat.

Run the sync helper from the **trusted repository root**, never from `$WORKDIR`,
and pass an **absolute** anchor path:

```bash
REPO_ROOT=/abs/path/to/trusted/orchestrator-pack
ANCHOR="$WORKDIR/docs/issues_drafts/<N>-<slug>.md"
cd "$REPO_ROOT"
node scripts/publish-issue-body-sync.ts edit \
  --draft-path "$ANCHOR" \
  --issue-number <N> \
  --repo chetwerikoff/orchestrator-pack
node scripts/publish-issue-body-sync.ts verify \
  --draft-path "$ANCHOR" \
  --issue-number <N> \
  --repo chetwerikoff/orchestrator-pack
```

Why this works:

- tier validation uses `process.cwd()` and therefore sees tracked contract-evidence
  and marker support files under `$REPO_ROOT`;
- stage completeness derives `$WORKDIR` from the absolute draft path;
- finding-ledger validation resolves `.review/<stem>` beside the absolute anchor.

Re-pull after every parity edit so revision history remains gapless.

## Browser-turn mechanics

Use [`discuss-with-gpt`](../discuss-with-gpt/SKILL.md) as the canonical detailed
browser-mechanics source. The normal one-shot transport for this flow is the
tracked Issue #964 helper `scripts/chatgpt-browser-turn.ts`, invoked through the
package entrypoint `npm run chatgpt-browser-turn -- turn`.

Destination mode follows chat topology:

- **task chat:** exact existing conversation with its recorded `--chat-url`;
- **brief-only task creation:** fresh conversation with
  `--new-chat --project-url <configured-project-url>`;
- **competitive review:** fresh conversation with `--new-chat` for every pass;
- **ordinary architectural review:** first round creates one dedicated chat with
  `--new-chat`; later ordinary rounds use that returned exact `--chat-url`;
- **final architectural verification:** fresh conversation with `--new-chat`.

The flow-manager prepares the exact argv plus absolute input/output paths and owns
the browser-turn execution. It may use the sanctioned execution channel defined
by the landed helper contract, but that execution does not transfer judgment or
fallback authority to a hands-only executor.

### Cross-task browser critical section

All task flow-managers in the same operator environment use **one shared local
lock identity** for browser-turn execution. The logical mutex key is exactly
`orchestrator-pack:create-issue-draft:browser-turn`; every flow-manager MUST
resolve that literal key to the same local mutual-exclusion object in the operator
environment. The key MUST NOT be derived from Issue number, task identity, chat
URL, or manager identity. Establish exclusive ownership before the one browser-turn
operation and release it immediately after that operation. Contention or inability
to establish exclusivity leaves that browser-turn work pending. Do not put Issue
pull/edit, ledger work, capture normalization, or other task mechanics under this
lock. Exact filesystem path, representation, and lock primitive used to realize
the literal key are planner freedom, but a mapping that can yield different mutexes
for that same key is non-compliant. This is caller policy only: do not add a second
browser runtime lock, helper state machine, daemon, lease, or ownership store.

Before the first **production** tracked-helper turn on a newly built or
uncharacterized #964 candidate, complete the Gate-B gate in `discuss-with-gpt`:
`npm run test:issue-964` green, operator live characterization (`capability` →
command-scoped `CHATGPT_BROWSER_TURN_GATE_B_DIGEST` on characterization turns →
serialized live smoke → post-smoke `capability` telemetry, then `unset`), and a
retained digest-pinned recovery root under
`~/.local/lib/orchestrator-pack/chatgpt-browser-turn-recovery/<candidate_digest>`.
The Gate-B characterization turns themselves are exempt from this production gate.
Record characterization evidence in task/review artifacts.

Interpret only the landed helper contract documented in `discuss-with-gpt`:
`turn-result/v1` with its closed state/scope/cause and exit mapping;
`control-result/v1` for `status/list`, `clear`, and capability; and
`publication-status/v1` for publication recovery. A hard crash may emit no turn
stdout. A non-`ok` state, timeout, missing stdout, or process-liveness uncertainty
is never by itself resend or scratchpad-fallback authorization; use the tracked
status/publication/recovery path first.

The former untracked one-shot scratchpad is fallback-only. It may be used only
when either (a) the tracked executable or sanctioned flow-manager execution
channel is proven unavailable before any tracked-helper/browser effect, or (b) a
complete compatible #964 control/publication result proves no possible delivery
and no blocking state. Record every fallback in task/review artifacts and final
status; never report it as a successful tracked-helper run. It stays serialized
and does not create a second parallel-use policy.

Preserve #964 coexistence and rollback safety: while helper-owned unresolved
conversation/provisional/publication state, a profile wall/block, opaque
quarantine, or blocking tombstone remains for the configured profile, do not run
legacy-driver or scratchpad sends against it. Reverting to the old scratchpad
mandate requires a complete compatible #964 status/incident check proving no
blockers; without that proof the prohibition remains until exact clearance.

`driver.mjs` keeps its standalone `discuss-with-gpt` adversarial duties, including
prompt construction and PASS_ID/SHA/verdict validation; this flow does not
redirect those duties to the generic helper.

Every review/amendment prompt remains self-contained, carries current Issue body
as UNTRUSTED DATA between nonce markers, and requests one outer `~~~markdown`
fence so inner backtick fences survive. Write prepared prompt to helper input file
and save successful reply verbatim before interpretation. For #975-governed
reviewer turns, saved raw reply must satisfy M1/M2 and applicable M5 before
normalization; transport never invents or repairs missing economics.

A Codex browser-outage substitution is a separate review-engine rule, not a
transport fallback. It is permitted only after recorded browser unavailability
when operator cannot restore it; preserve replaced stage capture name, raw JSON
provenance, 1:1 economics transcription, and substitution record.

## Tier gate

Run at intake, after material Issue/scope changes as required by the rubric,
before the final lens, and on the final revision from trusted repository root with
an absolute anchor path:

```bash
node scripts/tier-gate-guard.ts --text-file "$ANCHOR" --draft-path "$ANCHOR"
```

The marker screen is fail-closed. A red marker with a below-T3 assignment or a
skipped mandatory stage blocks acceptance; unparseable input becomes T3.
Downward movement occurs only at final lens and never erases evidence. #973 owns
auditable demotion/marker rules.

Tier stages/ceilings remain unchanged by #975:

- T1: no competitive stage; one light architectural pass in dedicated ordinary
  chat; light final lens; fresh final verification only when current flow requires.
- T2: no competitive unless explicitly selected; architectural ≤3 in dedicated
  ordinary chat; light final lens; fresh final verification under current flow.
- T3: competitive ≤3 fresh chats; architectural ≤4 in dedicated ordinary chat;
  full final lens; exactly one fresh final pass after latest lens.
- T3-critical: full T3 GPT flow + independent Codex addition + rollback/migration
  and realistic crash/race/stale-state floors.

Explicit adversarial wrappers floor effective tier at T2 and preserve requested
stage. Upward recompute runs skipped stages.

### T3-critical floor details

The L4 classification is independent of literal `complexity-tier` fence. At
intake and every required pre-final recompute, cite matched L4 condition(s) in
flow-manager record. An L4 task is not acceptance-ready unless live Issue contains:

1. rollback/migration note describing safe rollback or migration boundary,
   data/state compatibility, and required operator action; and
2. numbered acceptance criteria plus matching verification exercising every
   material crash, race, and stale-state class with realistic inputs.

These are additive to all worker-safety, behavior-kind, contract-evidence,
stage-completeness, finding-ledger, qualifying GPT, and independent Codex floors.
They are not satisfied by generic risk prose, happy-path test, or waiver.

## Mandatory Issue-body floors

The Issue body must use this order:

1. **Prerequisite** — blocking and already-landed prior art, cited by Issue number.
2. **Goal** — observable outcome, not implementation method.
3. mandatory `behavior-kind` fence: `action-producing` or `record-only`.
4. mandatory `complexity-tier` fence.
5. **Binding surface** — observable contracts and operator adoption; preserve
   planner freedom over names, signatures, layout, and library choice.
6. **Files in scope**.
7. **Files out of scope**.
8. mandatory `denylist` fence.
9. mandatory `allowed-roots` fence, listing every allowed root.
10. **Acceptance criteria** — numbered, observable, testable.
11. **Upgrade-safety check**.
12. **Verification** mapped to acceptance criteria.
13. `contract-evidence` fence or explicit `contract-evidence: none` form accepted
    by repository validator.

### Required fence examples

Every task declares one behavior kind:

```behavior-kind
record-only
```

or:

```behavior-kind
action-producing
```

Action-producing tasks also include realistic positive outcome:

```positive-outcome
asserts: <observable action on realistic input>
input: realistic
```

Worker-safety fences are always present:

```denylist
vendor/**
packages/core/**
```

```allowed-roots
<first allowed root>
<second allowed root when applicable>
```

`allowed-roots` is not optional merely because scope spans multiple roots; list
the finite union. Broad `.`/`**/*` roots require explicit justification and remain
subject to scope discipline. The complexity fence uses canonical T1/T2/T3 form or
the canonical below-ladder skip-line form from `docs/tiering.md`.

### Discipline details

- External-tool positive outcomes use `input: external-tool-output` plus
  capture-backed provenance (or allowed golden-sample provenance).
- Deferred causes require a complete `parked-root-cause` fence with an existing
  follow-up Issue.
- Every upstream datum in Binding surface, ACs, or Verification is grounded in
  `contract-evidence`; belief/self-attestation is inadmissible.
- Capture-backed evidence rows use stable binding id/type, producer,
  selector/token, expected behavior, and repository manifest provenance.

## Mechanical floor commands

Run from trusted repository root with absolute `$ANCHOR`:

```bash
node scripts/tier-gate-guard.ts --text-file "$ANCHOR" --draft-path "$ANCHOR"
node scripts/draft-discipline.mjs positive-outcome --draft "$ANCHOR"
node scripts/draft-discipline.mjs parked-root --draft "$ANCHOR"
node scripts/draft-discipline.mjs contract-evidence --draft "$ANCHOR"
node scripts/stage-completeness-guard.ts \
  --text-file "$ANCHOR" --draft-path "$ANCHOR" --repo-root "$WORKDIR"
```

Run body-only guards after every Issue revision. Stage completeness runs at its
existing points. #975 finding-ledger invocations are the explicit `pre-lens` and
`final-acceptance` commands above; do not substitute old one-phase call for active
#975 acceptance. Legacy/non-#975 consumers may continue calling
`finding-ledger-guard.mjs` without `--phase` and retain old protected behavior.

## Finding ledger details

Every reviewer capture is immutable evidence. The ledger records stable id,
summary, canonical type, defect disposition, rejection reason when applicable,
plus bounded #975 row-local economics/authority facts above.

- Defect `evidence` and remedy `recommendation` stay separate.
- A malformed/disproportionate remedy never erases a valid defect.
- Protected types are nominations; current M3 decides author/architect authority.
- Raw `evidence:` is the only input to finding-scoped zero-signal.
- Latest governed marked stable-id occurrence controls M2 proposal economics.
- M4 inventories machinery actually introduced even if later proposals become
  cheaper.
- Exact raw cut-candidate token and ledger flag must agree for M5.
- `NO_FINDINGS` never erases prior findings.
- Capped exits preserve unresolved questions in ledger/final report.

## Review artifacts

All durable audit artifacts remain outside repository:

```text
chats.md                                  # manager handoffs; active-cycle adoption timestamp when needed
round-NN-author-reply.md                  # running M4 inventory
pass-NN-competitive.capture.txt
pass-NN-architectural.capture.txt
pass-NN-architectural.codex.json          # only when a Codex role runs
pass-NN-architectural-lens.capture.txt    # M3 contest/outcome evidence lives here
pass-NN-architectural-final.capture.txt
pass-NN-architectural-final.codex.json    # only when Codex substitutes
presync-architect-lens.md
finding-disposition-ledger.json
```

Optional pre-task architect consultation may be referenced in `chats.md` or
existing handoff/audit record; it does not add a mandatory artifact class. Pass
numbers form one chronological sequence. Guard-recognized stages remain
`competitive`, `architectural`, `architectural-lens`, and `architectural-final`.
Capture every reviewer response before editing. Raw Codex JSON remains provenance
and is validated before 1:1 plain capture transcription.

## Repository-write boundary

This flow creates no tracked draft mirror, queue-index row, capture, ledger,
adoption record, inventory, or workdir file. The only permitted temporary in-repo
write remains untracked `.review-challenge/**` transport copy when a Codex role
requires `--scope working-tree`; delete it immediately and never commit it.

Cross-Issue role/topology or demotion changes stay owned by #972/#973. #975 does
not edit sibling Issues or add workflow/plugin/core machinery.

## Don't

- Let the flow-manager author spec content or decide reviewer findings.
- Let the architect operate routine browser turns, ledger bookkeeping, ordinary
  stage ordering, per-round disposition ratification, or intake/mid-cycle tier
  selection.
- Review in the task chat.
- Reuse any competitive or final browser-GPT review chat; conversely, do not open
  a new ordinary architectural browser chat for each round after the dedicated
  chat exists.
- Let #975 silently alter #972-owned browser-chat topology.
- Let reviewer `type: security|scope-violation` self-activate protected authority.
- Scan recommendation/economics prose to manufacture M3 zero-signal evidence.
- Infer or synthesize missing raw Codex/browser economics during transcription.
- Let a later reviewer marker move the independent M2 adoption boundary.
- Rewrite immutable pre-adoption captures to add M2/M5 tokens.
- Add a confirmation reviewer pass solely to mint `SIMPLIFICATION_CLEAN`.
- Treat `architectural-final` as M5 merely because it follows a lens.
- Accept a pre-adoption M5 anchor without the existing governed post-adoption
  pre-lens re-entry/new segment.
- Create a contest registry, proposal ledger, adoption service, receipt/signing
  system, or other new persistence plane for #975.
- Let Codex become default architectural engine, claim substitution without
  recorded browser unavailability, or double-count substitution as independent
  T3-critical Codex addition.
- Start browser turn without exclusive ownership of common cross-task browser
  critical-section identity; do not extend lock over Issue/ledger work or add new
  runtime lock here.
- Treat tracked-helper non-`ok`, timeout, missing stdout, or unresolved status as
  scratchpad/legacy fallback authorization or resend permission.
- Run legacy/scratchpad browser sends while helper-owned unresolved state blocks
  coexistence for configured profile.
- Trust chat reply without live Issue re-pull and diff.
- Skip requested GPT/Codex stage, selected browser stage, or mandatory T3-critical
  Codex addition silently.
- Let a T3-critical Codex substitution satisfy GPT half.
- Miss Issue #574 L4 classification or waive/dilute rollback/migration and
  crash/race/stale-state floors.
- Retry final pass without newer final-lens capture required by existing loop.
- Accept with stale captures/title, red floors, incomplete ledger, red #975 phase,
  unknown/stale M3 contest state, or architect-pending protected work.
- Use raw `gh issue edit`; use sanctioned body-sync helper for parity only.
- Commit workdir or `.review-challenge/**` artifacts.
- Hand-edit `.cursor/skills/**`; regenerate only when canonical frontmatter changes.
- Over-specify implementation details that belong to the planner.
