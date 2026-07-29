---
name: create-issue-draft
description: Use when accepting a GPT-chat-authored task for orchestrator-pack — the user hands over a GitHub Issue link plus the browser-GPT task-chat link (or only a brief: one flow-manager opens the GPT task chat and GPT authors the Issue). OpenCode is the default manager when no runtime is explicitly selected; a capable operator-selected runtime such as Cursor or Codex is permitted without a tracked manager-name allowlist. The flow-manager drives the fixed per-tier cycle through acceptance or a bounded blocked outcome; browser GPT is the only review engine. T1/T2: one terminal GPT architectural lens. T3: competitive → architectural-review → Claude architectural-lens (or valid unavailable waiver) → terminal GPT architectural. Browser-GPT turns use the state-light send-once page-polling helper; stale legacy admission/recovery state is non-authoritative. Covers Issue-only live task state, T3-critical L4 floors, issue-body guards, and the finding-disposition ledger. No Codex create-flow role. Invoke for on-ladder GPT-authored tasks; use the canonical below-ladder skip line from docs/tiering.md.
---

# create-issue-draft — GPT-chat authoring flow

Tasks are authored by the operator's **browser GPT** in the custom ChatGPT
project «orchestrator-pack». GPT creates the GitHub Issue, edits it directly
throughout the flow, and owns every content fix and finding disposition. One
current **flow-manager** owns the operational cycle **through acceptance** or a
bounded blocked outcome. **OpenCode** is the default when no manager runtime is
explicitly selected; the operator may select another capable runtime, including
**Cursor or Codex**, without adding its name to a tracked allowlist. There is no
mandatory stop-and-hand-off to an architect outside the fixed per-tier stages in
`docs/tiering.md`.

The **GitHub Issue is the only live task artifact and queue entry**. Pulled
revisions, captures, chat URLs, manager handoffs, the finding ledger, #975
adoption evidence, and author replies live in an out-of-repo workdir and are never
committed. `docs/issues_drafts/**` and `docs/issue_queue_index.md` are read-only
prior art for this flow.

Issue #972 owns the flow-manager/author/reviewer chat topology. The #975 M1–M5
economics below are independent of that ownership split and must be preserved
without reverting #972. Issue #973 remains the owner of tier-demotion records
and rubric applicability. Issue #1027 owns the GPT-only per-tier topology; Issue
#1120 changes the T3 stage sequence and Browser-GPT transport mechanics without
reintroducing Codex review stages.

## Inputs and routing

Supported intake forms are:

1. **Existing Issue, with or without the original task-chat reference.** The live
   Issue is sufficient to continue the flow. When the original author task chat is
   absent, expired, or unusable, the flow-manager opens a fresh browser-GPT author
   continuation chat, gives it the full current Issue plus required prior review
   context, records the new URL, and continues author dispositions there. The
   original task-chat handle is not a prerequisite or recovery authority.
2. **Brief-only direct entry.** Operator brief → flow-manager → one new
   browser-GPT task chat. That chat becomes the initial author chat; GPT authors
   the spec against the floors below and creates the Issue. The first body line
   becomes `GitHub Issue: #N` once known. Browser-authoring unavailability leaves
   authoring pending; required GPT work stays incomplete — no engine substitution.
3. **Optional architect-first consultation (pre-task only).** When selected by
   the operator, the architect may prepare/critique the initial brief before a
   flow-manager opens the author chat. Record the consultation; it is not a review
   stage and does not replace any lens in the fixed topology.

For brief-only entry, the self-contained brief carries problem/goal, advisory
tier prior, constraints, out-of-scope, and verified grounding pointers. The
flow-manager opens exactly one new browser-GPT author chat and records its URL.
For Issue-only continuation, the live Issue is the canonical source; missing
historical chat state must not block continuation.

Explicit wrapper routing:

- brief-only `discuss-with-gpt` floors the effective tier at **T2** and routes into
  this flow; it does **not** add a competitive create-flow stage beyond the single
  terminal GPT `architectural` lens;
- `adversarial-draft-review` is **standalone Codex challenge only** — it does not
  add an in-flow review stage to create-issue-draft. An explicit request to create
  or manage a task with Codex instead selects Codex as this flow's manager.

Apply the canonical **Below the ladder — no tier** rule from `docs/tiering.md`.
When that rule applies, skip this authoring ceremony; otherwise continue here.

## Roles

**Flow-manager runtime default.** **OpenCode** is the default flow-manager when no
runtime is explicitly selected. Runtime selection is **not** a tracked allowlist:
the operator may select another capable runtime, including **Cursor or Codex**.
The tier-provenance `producer` label records the selected manager for audit but
does not grant or deny runtime permission. A flow-manager runtime that does not
read `.claude/skills/**` natively must explicitly be handed or load **this file**
(`.claude/skills/create-issue-draft/SKILL.md`) as the canonical procedure.

| Party | Owns | Must not do |
|-------|------|-------------|
| GPT author in the current author chat | Spec content, every content fix, direct Issue edits, every finding disposition, M3 author activation, M4 mechanism inventory | Review its own spec |
| Flow-manager (OpenCode default; capable operator-selected Cursor/Codex allowed) | Live Issue pulls, fixed per-tier stage order, tier/T3-critical classification, body/mechanical floors, immutable captures, ledger bookkeeping, pass counting, chat references/topology, Browser-GPT turn execution, #975 adoption evidence, economics-guard mechanics, driving the cycle to acceptance or bounded blocked outcome | Author spec content, decide reviewer findings, perform the Claude lens, invent new helper/runtime semantics, mandatory hand-off to architect |
| Claude architectural-lens (T3 only) | Exactly one `architectural-lens` per cycle segment: pre-terminal M3 when required, pre-terminal independent aggregate cut, adjacent `T3→T2` authority | Routine browser turns, ledger bookkeeping, post-terminal-GPT work, `T2→T1`, GPT stages |
| Reviewer GPT chats | Independent review only: T3 `competitive`, T3 `architectural-review`, and terminal `architectural` with their fixed authorities | Edit the Issue, share the author chat, overwrite author-owned M4, direct `T3→T1`, or emit two downsteps from one capture |

### Flow-manager authority transfer

Exactly one current flow-manager authority exists per task. The latest explicit
predecessor/operator handoff recorded in an existing audit/chat surface such as
`$REVIEW_DIR/chats.md` or the author-chat handoff record is the transfer boundary.
Recording that handoff immediately ends the predecessor's flow-manager authority,
even if its predecessor session still exists. A successor acts only after the handoff,
reconstructs state from the live Issue plus existing audit artifacts, and reruns
missing required evidence under the existing stage/cap rules rather than
inventing it. Do not add a lease, heartbeat, ownership service, or new state
store for this role boundary.

## Browser-GPT turn transport — Issue #1120

The canonical `npm run chatgpt-browser-turn -- turn ...` path is a **state-light,
send-once helper**, not a workflow coordinator.

- One helper invocation owns one newly opened ChatGPT tab. Even when an existing
  `--chat-url` is supplied, the helper opens a dedicated tab instead of reusing a
  pre-existing tab. It closes only that owned tab; sibling/foreign tabs are never
  helper cleanup targets.
- The exact prompt is submitted **once** per live invocation. After dispatch, the
  same tab is only observed/polled/read; no timeout or ambiguity branch silently
  resends the user prompt.
- Completion is established from the page/DOM state. A non-empty final assistant
  node that is no longer generating and is stable across bounded reads is
  sufficient; service-terminal/network witness fields are not required.
- Multi-node progress/intermediate assistant nodes are not concatenated into the
  result. The final eligible assistant node for the owned user turn is the
  returned reply. Continuation UI may be advanced, but it is not a second user
  prompt send.
- Any extra/foreign user turn after the invocation baseline makes only this
  invocation degraded (`foreign_activity` or another local error). Sibling
  Browser-GPT tasks continue independently.
- Login/quota/challenge/composer/page errors are invocation-local blockers.
  Existing `status/list`, `clear`, capability/Gate-B, `possible_delivery`,
  `profile_wall`, conversation/profile locks, claim/queue/lease records, and
  stale recovery records are **not** admission authority for create/review turns.
- A crash, lost tab, helper exception after send, or unavailable historical chat
  may be retried by opening a fresh chat and sending a fresh invocation. Duplicate
  recoverable GPT text is an accepted residual risk; do not build an exactly-once
  delivery protocol or old recovery/clear workflow around it.
- Polling stays bounded and low-frequency after initial dispatch observation. A
  normal `generating`/wait poll is not an incident.
- Directly detected unexpected browser-turn events are appended best-effort to
  `~/.local/state/create-issue-draft/browser-turn-recurrence.jsonl`. The journal is
  append-only, advisory, non-authoritative, unlocked, and never scanned to grant
  or deny work. The same direct incident class must be carried into the current
  flow-manager report. Journal write failure is reportable but cannot veto an
  already captured reply or sibling task.
- Do not add a second direct-agent/CDP fallback, inspector, or 10–15 minute
  watchdog in this task. That fallback is deferred follow-up work.

Legacy control commands may remain callable for compatibility/evidence lookup,
but create/review progression must not wait for or clear legacy global state.

## Fixed per-tier pipeline

See `docs/tiering.md` for the rubric. Stage order is fixed; in-flight cycles
restart from intake without historical provenance inference.

### T1

1. Intake, workdir, #973 intake prior, #975 adoption boundary, tier gate.
2. Exactly **one** independent browser-GPT `architectural` lens (fresh review
   chat, not the author chat).
3. Author dispositions/fixes from that lens.
4. **`final-acceptance`** #975 guard and acceptance. **No** pre-lens #975 phase.
   Terminal GPT `architectural` is the M5 anchor and owns aggregate cut.

### T2

1. Intake through tier gate (same as T1).
2. Exactly **one** terminal independent browser-GPT `architectural` lens.
3. Author dispositions/fixes.
4. If GPT authorizes `T2→T1`, apply only the authorized correction and perform
   the bounded same-chat narrow revalidation below.
5. **`final-acceptance`** and acceptance. **No** pre-lens #975 phase and no
   competitive or `architectural-review` create-flow stage.

### T3

The canonical counted sequence is exactly:

```text
competitive → architectural-review → architectural-lens (or valid Claude-unavailable waiver) → architectural
```

The business-role names are:

```text
competitive → architectural-review → Claude lens → GPT lens
```

1. Intake through tier gate.
2. Run **at least one and at most three** fresh browser-GPT `competitive` passes.
3. Run exactly **one** fresh browser-GPT `architectural-review` pass after the
   competitive anchor. It is a full reviewer stage with the normal disposition /
   economics machinery, but it is **not M5** and has **no tier-demotion authority**.
4. After both pre-Claude reviewer stages are legally terminal, run the
   **`pre-lens`** #975 guard.
5. Run exactly **one** Claude `architectural-lens` (independent Claude Code CLI
   invocation + producing-run evidence) **or** a valid `claude-unavailable` skip
   record when Claude is observably unavailable (terminal GPT still mandatory).
6. Author dispositions/fixes from Claude findings; re-pull.
7. Run exactly **one** terminal independent browser-GPT `architectural` lens in a
   fresh chat distinct from author, competitive, and `architectural-review` chats.
8. Author dispositions/fixes from terminal GPT findings when needed.
9. Run **`final-acceptance`** and accept only when all guards are green. Terminal
   GPT `architectural` is the sole M5 anchor and owns final aggregate cut.

**No `architectural-final` stage.** **No Codex** review role. **No engine
substitution** on browser outage.

**Staleness / review-episode binding.**

- Claude `architectural-lens` captures bind to the **source Issue revision**
  reviewed; post-Claude author fixes are the normal T3 path and do not invalidate
  that capture or force a second Claude lens. Post-Claude fixes proceed to
  **terminal GPT `architectural` only**.
- Terminal GPT `architectural` remains the **review-episode M5 anchor** after
  accepted terminal-GPT fixes; the resulting current body still owes all existing
  mechanical/body/tier/ledger acceptance checks — no second GPT lens. A bounded
  same-chat demotion revalidation is a distinct capture identity and does not
  replace or move that M5 anchor.

## Chat topology

| Stream | Chat | Lifetime |
|--------|------|----------|
| Authoring, fixes, finding dispositions | current **author chat**; may be freshly reconstructed from live Issue | until replaced by an explicit author-continuation chat |
| Competitive review (T3 only) | **fresh browser-GPT chat per pass** | one pass |
| `architectural-review` (T3 only) | exactly one **fresh browser-GPT chat** | one pass |
| Terminal `architectural` (all tiers) | **fresh independent browser-GPT chat** | one terminal lens |
| Claude `architectural-lens` (T3) | no browser review chat | one lens per cycle segment |

Never review in an author chat. Never reuse a competitive, `architectural-review`,
or terminal `architectural` review chat. Reviewer GPT chats are distinct from any
current author chat.

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
repository root and needs tracked tier, contract-evidence, manifest, and corpus
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

Pull the title every time because the tier prefix lives in it. Record the current
author chat, every fresh competitive chat URL, the one `architectural-review`
chat URL, every terminal `architectural` chat URL, every manager handoff, and any
active-cycle #975 adoption timestamp in `$REVIEW_DIR/chats.md`.

At intake, after every material Issue/scope change, and immediately before the
next fixed stage in the per-tier topology, the flow-manager applies the existing
tier rubric, fixed stage-selection rules, and T3-critical/L4 classification.
Ambiguous or unparseable classification follows existing fail-up behavior.
T3-critical adds only rollback/migration and crash/race/stale-state floors — no
Codex stage.

### #973 tier provenance records

These records live only in the existing out-of-repository workdir. They are
same-user audit evidence for mechanical consistency, **not** an unforgeable role
authorization channel; deliberate same-user fabrication is the explicit CX973-1
residual trust risk. Do not add a signer, database, protected store, remote
attestation, registry, lease, journal, or pending-state machine.

Before the first tier-gate decision for a fresh workdir, the **flow-manager**
records `$REVIEW_DIR/tier-intake.json` as `tier-intake/v1` with:

- `producer` set to the selected manager's exact non-empty audit label; the label is
  preserved verbatim but is not checked against a finite runtime-name allowlist and
  is not authentication or authorization;
- exact task identity;
- `kind: fresh`;
- the intake prior produced by the existing rubric/guard application;
- `firstRevision`, bound to the first valid immutable `rNN`.

The Issue `advisory-prior` mirrors this record and must match it. Browser GPT does
not write the intake record, and no architect attribution is required for existing
Issue + task-chat entry or direct brief-only entry. Missing, blank, malformed,
partial, or mismatched intake evidence fails closed. Producer allowlist ownership is the separate #1117/#1119
slice and is not changed by #1120.

The implementation owns exactly one **static frozen** production compatibility
set, deliberately empty at #973 cutover. Every production identity therefore
follows fresh rules. Runtime code never discovers, infers, appends, or extends
membership. Compatibility semantics may be exercised only with explicitly injected
test membership; never rewrite historical revisions or infer legacy eligibility
from workdir shape.

After each immutable pull and tier/L4 recomputation, the flow-manager records
`$WORKDIR/rNN/tier-gate-receipt.json` as `tier-gate-decision/v1` with the exact
revision, resulting tier, the applicable rubric classes, and current L4 status
(`clear|active|ambiguous|missing|stale`). Use only these stable rubric labels:

- `failure-type:text-cosmetics`;
- `failure-type:local-behavior`;
- `failure-type:subsystem-or-system-guarantee`;
- `size:small-obvious-self-contained`;
- `size:single-component-design-judgment`;
- `fail-up:doubt`.

The applicable rubric labels are the exact guard-enumerable driver set for that
immutable decision. After the first valid revision, transition direction comes
from the highest tier in preceding immutable `rNN` revisions, not from the
author-editable `advisory-prior`; a hidden downstep therefore remains visible.
Tier is judged from blast radius and failure type, not from keyword matches.

## Step 2 — Author disposition/fix round + M4

For every reviewer finding, the flow-manager relays the finding to the current
author chat as a proposal. GPT author decides the defect disposition, chooses the
remedy, edits the GitHub Issue for every accepted/partial content fix, and returns
a change summary plus dispositions. Remedy advice is non-binding.

After **every reviewer round**, the author reply updates one running inventory of
material mechanisms/ceremony introduced by that round. Each item is classified
exactly once as `keep`, `simplify`, `defer`, or `cut`. Keep the inventory in
`round-NN-author-reply.md`; do not create another store. The latest inventory is
passed to every lens.

Save the reply verbatim as `round-NN-author-reply.md`, re-pull when the Issue
changed, and diff it. A content-fix reply without an Issue edit is unfinished.
Run body-only floors on the refreshed anchor.

```text
reviewer -> flow-manager relay -> author chat disposition/fix -> Issue edit -> re-pull
```

### Independent review-economics adoption boundary

Reviewer output never chooses its own #975 cutover.

- **Cycle not already active when #975 lands:** use the #975 implementation
  landing timestamp from trusted repository history as `ADOPTION_TS`.
- **Cycle already active at that landing:** record once in the audit file:
  `review-economics-adopted-at: <ISO-8601>` and reuse as `ADOPTION_TS`.

Pre-adoption captures remain unchanged; M2 starts after the boundary. Current M3
applies to every still-active acceptance attempt regardless of ledger age.

## Shared lens contract — M1/M2 + M5 raw evidence

Every browser-GPT reviewer stage and the Claude `architectural-lens` use the same
contract from `prompts/codex_draft_review_prompt.md` (rubric source only):

- wrap the current Issue body as UNTRUSTED DATA between nonce markers;
- require exact review-level `review-economics-contract: v1`;
- require every material finding to carry stable `id`, canonical `type`
  (`security|scope-violation|spec|quality|test|ci`), severity, raw `evidence:`,
  non-binding `recommendation:`, and `persistent-machinery: yes|no`;
- for every `persistent-machinery: yes`, require `cheapest-sufficient-alternative`,
  `stakes-price`, and `trade-in` (or exact `stakes-undeclared` / `net-add`);
- require the four-question simplification lens;
- for `architectural-lens` and terminal `architectural`, require in order:
  contradiction, feasibility with live probes where possible, primary forced-cut
  review, and missed-gap search; record `keep|cut` for every major mechanism;
- permit M5 cut candidate only with exact raw `simplification-cut-candidate: yes`;
- for T3 pre-Claude `competitive` **and** `architectural-review` outputs, require
  exact `SIMPLIFICATION_CLEAN` when no tokened cut candidate; if genuinely clean,
  also exact `NO_FINDINGS`;
- for **terminal** GPT `architectural` (M5 anchor on all tiers), require the same
  M5 token rules as the final acceptance anchor.

Save every response verbatim before normalization. `architectural-review` findings
are normalized into the same finding-disposition ledger as every other reviewer
capture; no separate ledger or disposition path exists.

### Normalized #975 ledger facts

Keep the existing stable row and add only row-local facts needed by the guard:

- `persistent-machinery`, plus the three price values when applicable;
- `proposalOutcome` / `proposalReason` only for a declined malformed proposal;
- `simplificationCutCandidate: true|false` matching the latest governed marked raw occurrence;
- `protectedActivation: { authority: "author", signal: "...", whyNow: "..." }`
  when the author activates a protected nomination;
- `architectPending: true` only under **T3 pre-Claude** M3 when genuinely required;
- `architectRequired: true` only when another existing rule independently requires
  Claude adjudication.

## Step 3 — Competitive review (T3 only)

T3 runs **at least one** competitive pass. T1 and T2 never run competitive.
Each pass uses a fresh `--new-chat`, the shared contract, and is saved as
`pass-NN-competitive.capture.txt`. Normalize, relay to the author chat, update M4,
re-pull, and rerun body floors when changed. Cap at three passes. A historical
competitive waiver remains parseable audit data but no longer substitutes for the
mandatory real pass. Browser unavailability blocks the stage — no engine substitution.

## Step 4 — Architectural-review (T3 only)

After competitive is legally terminal, run exactly one fresh independent
Browser-GPT **full** review in a new chat and save it as:

```text
pass-NN-architectural-review.capture.txt
```

It uses the shared reviewer/economics contract, normal finding normalization,
author disposition, M4 update, and re-pull path. It is a pre-Claude full
architecture review, but **not M5**, has **no tier-demotion authority**, and cannot
replace either Claude `architectural-lens` or terminal GPT `architectural`.

## Step 5 — Pre-lens #975 guard (T3 only)

Run only after both required pre-Claude reviewer stages are legally terminal:

```bash
node scripts/finding-ledger-guard.mjs \
  --ledger "$REVIEW_DIR/finding-disposition-ledger.json" \
  --captures-dir "$REVIEW_DIR" \
  --draft-path "$ANCHOR" \
  --phase pre-lens \
  --adoption-timestamp "$ADOPTION_TS" \
  --stage-terminal
```

T1/T2 **skip** this phase entirely.

## Step 6 — Claude architectural-lens (T3 only)

Exactly one full lens per cycle segment after the pre-lens guard is green. The
accepted candidate must be covered by this lens before terminal GPT runs.

The flow-manager **orchestrates** this stage only: prepare inputs and the evidence
destination, launch one **separate independent Claude Code CLI** invocation, wait
for terminal completion, and capture its verbatim output/provenance. The
flow-manager must not reason through, draft, simulate, or adjudicate the Claude
lens. Browser GPT, Codex, or any other model cannot substitute for skipped Claude.

### Claude-unavailable skip

When a real Claude Code CLI invocation cannot run because Claude is observably
unavailable — explicit quota, rate-limit, provider-unavailable, or CLI-unavailable
evidence — record one durable `architect-lens-stage-waiver.json` sidecar in
`$REVIEW_DIR` and proceed without the Claude lens. Ordinary impatience, an
ambiguous timeout, or a manager decision to save cost is **not** a valid skip.
Do not retry in a loop once unavailability is established.

The skip record is audit evidence only. It is not Claude provenance, does not
create an `architectural-lens` capture, does not satisfy M3 adjudication, and
grants no `T3→T2` demotion authority. Terminal browser-GPT `architectural`
remains mandatory.

```json
{
  "reason": "claude-unavailable",
  "recorded-at": "2026-07-28T12:00:00.000Z",
  "after-pass": 3,
  "unavailability": "rate-limit"
}
```

- `reason` must be exactly `claude-unavailable`.
- `recorded-at` must be strict ISO-8601 UTC.
- `unavailability` must be one of `quota`, `rate-limit`, `provider-unavailable`,
  `cli-unavailable`.
- `after-pass` is a pass index **strictly after** the completed
  `architectural-review` pass, and terminal GPT `architectural` must be strictly
  after that skip anchor.

The Claude lens is the **pre-terminal independent aggregate cut** authority and
may authorize one adjacent `T3→T2` downstep. It consumes current Issue body, T3
reject partition where applicable, current M3 protected state, latest M4
inventory, and applicable pre-lens economics.

Four mandatory goals, in order:

1. **Contradiction check** — fix via author-chat path.
2. **Feasibility check** — live probes where possible.
3. **Cut ALL overengineering — PRIMARY goal** — forced-cut answer, explicit tier
   reconsideration, `T3→T2` demotion only when justified under #973.
4. **Find what was missed** — route corrections via author-chat path.

For T3, record explicit **keep** or **cut** for each major mechanism.

### Producing-run evidence

Save as `pass-NN-architectural-lens.capture.txt` with detailed analysis in
`presync-architect-lens.md`. Co-located producing-run evidence from the
independent **Claude Code CLI** invocation is mandatory. Absence fails closed.

Fix-required results return to the author chat; re-pull and **do not** rerun
Claude until a new cycle segment is required. Post-Claude fixes go to terminal
GPT `architectural` only.

### Tier demotion (#973 + #1104)

When justified, the lens capture contains exactly one fenced `tier-demotion-event/v1`
JSON record (`role: architect`, embedded `stage: final-architect-lens`, exact source
revision, `beforeTier: T3`, `afterTier: T2`, drivers matching source rubric labels).

After the author chat applies the authorized fence/title change and the
flow-manager re-pulls:

1. record **narrow revalidation evidence** (`tier-demotion-revalidation/v1`, not a
   full second Claude lens) with `role: architect`, embedded
   `stage: final-architect-lens`, and a later canonical
   `pass-NN-architectural-lens.capture.txt`;
2. run terminal GPT `architectural` on the post-demotion candidate;
3. proceed toward acceptance when guards are green.

**No Claude after terminal GPT.**

## Step 7 — Terminal GPT architectural lens (all tiers)

Exactly **one** terminal independent browser-GPT `architectural` lens per
acceptance-attempt segment. Always a **fresh** review chat (`--new-chat`), never
the author, competitive, or `architectural-review` chat.

Apply the shared lens contract. Save verbatim as `pass-NN-architectural.capture.txt`
using the terminal capture identity recognized by stage-completeness guards.
Supply the exact reviewed Issue revision, applicable reject partition, current M3
state, latest author-owned M4 inventory, and applicable economics state.

Terminal GPT performs the ordered contradiction → feasibility → primary forced-cut
→ missed-gap goals as Claude, with explicit `keep|cut` for every major mechanism.
Reviewer verdicts remain advisory; the author still records each M4 mechanism
exactly once as `keep|simplify|defer|cut`.

- **T1/T2:** sole reviewer stage; owns aggregate cut and M5 anchor.
- **T3:** owns final aggregate cut and is the **sole M5 anchor** after Claude and
  author fixes. `architectural-review` is never an M5 substitute.

Terminal GPT may emit one `tier-demotion-event/v1` with `role: reviewer` and
embedded `stage: final-architectural`, authorizing exactly one adjacent `T3→T2`
or `T2→T1` edge from the exact source revision it reviewed. Reject direct/skipped
transitions, duplicate edge/id, branching, shared-source events, or reuse after an
intervening upstep.

After the author applies only the authorized tier/title/fence/body correction and
the manager re-pulls the immediate candidate revision, reuse the **same terminal
GPT chat** for exactly one narrow turn. Save only one fenced
`tier-demotion-revalidation/v1` in
`pass-NN-architectural-demotion-narrow-revalidation.capture.txt`; it may emit no
findings, M3, M5, `NO_FINDINGS`, or other review state. The original terminal
capture remains the M5 anchor.

Relay findings to the author chat, update M4, re-pull. Post-terminal-GPT accepted
fixes do **not** trigger a second GPT lens; ledger/guards decide acceptance.

### M3 by tier

| Tier / stage | Protected nomination rule |
|--------------|---------------------------|
| T1/T2 (terminal GPT) | Terminal GPT has full current-revision `m3-protected:` authority: activate/non-activate and create/withdraw contest under the existing evidence + why-now rules. |
| T3 pre-Claude | Zero-signal, absent activation, or contest → `architectPending` until Claude lens adjudicates. Only Claude lens may create/withdraw contest. |
| T3 terminal GPT | Full current-revision authority may supersede the earlier Claude record; no later Claude pass is required. |
| Protected nomination first emitted in terminal GPT | Terminal GPT may adjudicate it in the same authoritative capture; no post-GPT Claude path is required. |

Record `m3-protected:` lines per protected id when either authoritative lens
adjudicates. Fold current-revision records in capture/pass chronology across
Claude and GPT; later terminal GPT may confirm, replace, contest, or withdraw the
earlier Claude state. Stale/malformed/duplicate-conflicting state or an unresolved
final contest fails closed.

## Step 8 — Acceptance

Run stage completeness/body floors, then economics guard:

```bash
node scripts/finding-ledger-guard.mjs \
  --ledger "$REVIEW_DIR/finding-disposition-ledger.json" \
  --captures-dir "$REVIEW_DIR" \
  --draft-path "$ANCHOR" \
  --phase final-acceptance \
  --adoption-timestamp "$ADOPTION_TS" \
  --issue-revision "rNN"
```

T1/T2 skip `pre-lens`; T3 requires it green after competitive +
`architectural-review` and before Claude ran, with `final-acceptance` green now.

Final acceptance requires:

1. terminal GPT `architectural` is the sole M5 anchor for the review episode;
2. T3 stage completeness proves at least one (max three) competitive capture,
   exactly one later `architectural-review`, exactly one later Claude lens or valid
   unavailable skip, and exactly one later terminal `architectural`;
3. on T3, Claude `architectural-lens` covers the source revision it judged and has
   valid producing-run evidence when Claude ran in this segment;
4. full `checkTierGateGuard` green on the current anchor, including #973 demotion
   narrow revalidation when applicable;
5. body floors, stage completeness, and finding-ledger guard green;
6. every typed finding normalized; protected work resolved under tier-appropriate M3;
7. governed reviewer evidence after adoption boundary;
8. live Issue title prefix matches final tier; T3-critical L4 floors when applicable;
9. no required browser-GPT stage skipped; browser outage leaves required GPT work blocked;
10. final report includes Issue URL, tier/pass counts, all active-cycle chat URLs,
    manager handoff, workdir, T3-critical result, #973 state when applicable, M4
    summary, residual risks, and every direct Browser-GPT incident emitted by the
    helper (including journal-write failure when present).

Two non-converging fix cycles on the same segment escalate to the operator.
