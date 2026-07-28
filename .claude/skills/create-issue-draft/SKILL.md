---
name: create-issue-draft
description: Use when accepting a GPT-chat-authored task for orchestrator-pack — the user hands over a GitHub Issue link plus the browser-GPT task-chat link (or only a brief: one Cursor flow-manager opens the GPT task chat and GPT authors the Issue). The flow-manager drives the full fixed per-tier cycle through acceptance or a bounded blocked outcome; browser GPT is the only review engine. T1/T2: one terminal GPT architectural lens. T3: pre-lens stages → pre-lens #975 guard → one Claude architectural-lens → author fixes → one terminal GPT architectural lens. Covers Issue-only live task state, T3-critical L4 floors, tracked chatgpt-browser-turn mechanics, issue-body guards, and the finding-disposition ledger. No Codex create-flow role. Invoke for on-ladder GPT-authored tasks; use the canonical below-ladder skip line from docs/tiering.md.
---

# create-issue-draft — GPT-chat authoring flow

Tasks are authored by the operator's **browser GPT** in the custom ChatGPT
project «orchestrator-pack». GPT creates the GitHub Issue, edits it directly
throughout the flow, and owns every content fix and finding disposition. One
current **Cursor flow-manager** owns the operational cycle **through acceptance**
or a bounded blocked outcome. There is no mandatory stop-and-hand-off to an
architect outside the fixed per-tier stages in `docs/tiering.md`.

The **GitHub Issue is the only live task artifact and queue entry**. Pulled
revisions, captures, chat URLs, manager handoffs, the finding ledger, #975
adoption evidence, and author replies live in an out-of-repo workdir and are never
committed. `docs/issues_drafts/**` and `docs/issue_queue_index.md` are read-only
prior art for this flow.

Issue #972 owns the flow-manager/author/reviewer chat topology. The #975 M1–M5
economics below are independent of that ownership split and must be preserved
without reverting #972. Issue #973 remains the owner of tier-demotion records
and rubric applicability. Issue #1027 owns the fixed GPT-only per-tier topology.

## Inputs and routing

Supported intake forms are:

1. **Existing Issue + task-chat reference.** Hand both directly to the current
   Cursor flow-manager.
2. **Brief-only direct entry.** Operator brief → flow-manager → one new
   browser-GPT task chat. That chat becomes the task chat; GPT authors the spec
   against the floors below and creates the Issue. The first body line becomes
   `GitHub Issue: #N` once known. Browser-authoring unavailability leaves
   authoring pending; required GPT work stays incomplete — no engine substitution.
3. **Optional architect-first consultation (pre-task only).** When selected by
   the operator, the architect may prepare/critique the initial brief before a
   flow-manager opens the task chat. Record the consultation; it is not a review
   stage and does not replace any lens in the fixed topology.

For brief-only entry, the self-contained brief carries problem/goal, advisory
tier prior, constraints, out-of-scope, and verified grounding pointers. The
flow-manager opens exactly one new browser-GPT task chat and records its URL.

Explicit wrapper routing:

- brief-only `discuss-with-gpt` floors the effective tier at **T2** and routes into
  this flow; it does **not** add a competitive create-flow stage beyond the single
  terminal GPT `architectural` lens;
- `adversarial-draft-review` is **standalone Codex only** — it does not add an
  in-flow stage to create-issue-draft.

Apply the canonical **Below the ladder — no tier** rule from `docs/tiering.md`.
When that rule applies, skip this authoring ceremony; otherwise continue here.

## Roles

| Party | Owns | Must not do |
|-------|------|-------------|
| GPT author in task chat | Spec content, every content fix, direct Issue edits, every finding disposition, M3 author activation, M4 mechanism inventory | Review its own spec |
| Cursor flow-manager | Live Issue pulls, fixed per-tier stage order, tier/T3-critical classification, body/mechanical floors, immutable captures, ledger bookkeeping, pass counting, chat references/topology, browser-turn execution, #975 adoption evidence, economics-guard mechanics, driving the cycle to acceptance or bounded blocked outcome | Author spec content, decide reviewer findings, perform the Claude lens, invent new helper/runtime semantics, mandatory hand-off to architect |
| Claude architectural-lens (T3 only) | Exactly one `architectural-lens` per cycle segment: pre-terminal M3 when required, pre-terminal independent aggregate cut, sole sanctioned `T3→T2` demotion | Routine browser turns, ledger bookkeeping, post-terminal-GPT work, `T2→T1`, GPT stages |
| Reviewer GPT chats | Independent review only: competitive (fresh chat per pass when selected), terminal `architectural` (fresh independent chat on every tier) | Edit the Issue, share the task chat, authorize #973 demotion, self-activate protected authority |

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

## Fixed per-tier pipeline

See `docs/tiering.md` for the rubric. Stage order is fixed; in-flight cycles
restart from intake without historical provenance inference.

### T1

1. Intake, workdir, #973 intake prior, #975 adoption boundary, tier gate.
2. Exactly **one** independent browser-GPT `architectural` lens (fresh review
   chat, not the task chat).
3. Author dispositions/fixes from that lens.
4. **`final-acceptance`** #975 guard and acceptance. **No** pre-lens #975 phase.
   Terminal GPT `architectural` is the M5 anchor and owns aggregate cut.

### T2

1. Intake through tier gate (same as T1).
2. Exactly **one** terminal independent browser-GPT `architectural` lens.
3. Author dispositions/fixes.
4. **`final-acceptance`** and acceptance. **No** pre-lens #975 phase. **No**
   competitive create-flow stage. **No** tier downgrade path.

### T3

1. Intake through tier gate.
2. **Pre-lens** browser-GPT **competitive** stage when selected (≤3 fresh chats).
3. After pre-lens stages are legally terminal: **`pre-lens`** #975 guard.
4. Exactly **one** Claude `architectural-lens` (independent Claude Code CLI
   invocation + producing-run evidence) **or** a valid `claude-unavailable` skip
   record when Claude is observably unavailable (terminal GPT still mandatory).
5. Author dispositions/fixes from Claude findings; re-pull.
6. Exactly **one** terminal independent browser-GPT `architectural` lens (fresh
   chat, never the task chat or a competitive chat).
7. Author dispositions/fixes from terminal GPT findings when needed.
8. **`final-acceptance`** and acceptance. Terminal GPT `architectural` is the M5
   anchor and owns **final** aggregate cut. Claude already exercised pre-terminal
   aggregate cut authority.

**No `architectural-final` stage.** **No Codex** review role. **No engine
substitution** on browser outage.

**Staleness / review-episode binding.**

- Claude `architectural-lens` captures bind to the **source Issue revision**
  reviewed; post-Claude author fixes are the normal T3 path and do not invalidate
  that capture or force a second Claude lens. Post-Claude fixes proceed to
  **terminal GPT `architectural` only**.
- Terminal GPT `architectural` remains the **review-episode M5 anchor** after
  accepted terminal-GPT fixes; the resulting current body still owes all existing
  mechanical/body/tier/ledger acceptance checks — no second GPT lens.

## Chat topology

| Stream | Chat | Lifetime |
|--------|------|----------|
| Authoring, fixes, finding dispositions | one **task chat** | whole flow |
| Competitive review (T3 only) | **fresh browser-GPT chat per pass** | one pass |
| Terminal `architectural` (all tiers) | **fresh independent browser-GPT chat** | one terminal lens |
| Claude `architectural-lens` (T3) | no browser review chat | one lens per cycle segment |

Never review in the task chat. Never reuse a competitive or terminal `architectural`
chat. Reviewer GPT chats are always distinct from the GPT author task chat.

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

Pull the title every time because the tier prefix lives in it. Record the task
chat, every
fresh competitive chat URL, every terminal `architectural` chat URL, every manager
handoff, and any active-cycle #975 adoption timestamp in `$REVIEW_DIR/chats.md`.

At intake, after every material Issue/scope change, and immediately before the
next fixed stage in the per-tier topology (Claude lens or terminal GPT
`architectural` as applicable), the flow-manager applies the existing tier
rubric, fixed stage-selection rules, and T3-critical/L4 classification. Ambiguous
or unparseable classification follows existing fail-up behavior. T3-critical adds
only rollback/migration and crash/race/stale-state floors — no Codex stage.

### #973 tier provenance records

These records live only in the existing out-of-repository workdir. They are
same-user audit evidence for mechanical consistency, **not** an unforgeable role
authorization channel; deliberate same-user fabrication is the explicit CX973-1
residual trust risk. Do not add a signer, database, protected store, remote
attestation, registry, lease, journal, or pending-state machine.

Before the first tier-gate decision for a fresh workdir, the **flow-manager**
records `$REVIEW_DIR/tier-intake.json` as `tier-intake/v1` with:

- `producer` set to a tracked exact allowlist identifier (`cursor-flow-manager` or `opencode-flow-manager`);
- exact task identity;
- `kind: fresh`;
- the intake prior produced by the existing rubric/guard application;
- `firstRevision`, bound to the first valid immutable `rNN`.

The Issue `advisory-prior` mirrors this record and must match it. Browser GPT does
not write the intake record, and no architect attribution is required for existing
Issue + task-chat entry or direct brief-only entry. Missing, malformed, partial,
or mismatched intake evidence fails closed.

The implementation owns exactly one **static frozen** production compatibility
set, deliberately empty at #973 cutover. Every production identity therefore
follows fresh rules. Runtime code never discovers, infers, appends, or extends
membership. Compatibility semantics may be exercised only with explicitly injected
test membership; never rewrite historical revisions or infer legacy eligibility
from workdir shape.

After each immutable pull and tier/L4 recomputation, the flow-manager records
`$WORKDIR/rNN/tier-gate-receipt.json` as `tier-gate-decision/v1` with the exact
revision, resulting tier, the applicable rubric
classes, and current L4 status (`clear|active|ambiguous|missing|stale`). Use only
these stable rubric labels, which map the existing canon rather than defining a
new rubric:

- `failure-type:text-cosmetics`;
- `failure-type:local-behavior`;
- `failure-type:subsystem-or-system-guarantee`;
- `size:small-obvious-self-contained`;
- `size:single-component-design-judgment`;
- `fail-up:doubt`.

The applicable rubric labels are the exact guard-enumerable driver set for that
immutable decision. After the first valid revision, transition direction comes from
the highest tier in preceding immutable `rNN` revisions, not from the author-editable
`advisory-prior`; a hidden downstep therefore remains visible. Tier is judged from
blast radius and failure type, not from keyword matches in Issue prose.

## Step 2 — Task-chat disposition/fix round
### Independent review-economics adoption boundary

## Step 2 — Task-chat disposition/fix round + M4

For every reviewer finding, the flow-manager relays the finding to the one task
chat as a proposal. GPT author decides the defect disposition, chooses the remedy,
edits the GitHub Issue for every accepted/partial content fix, and returns a
change summary plus dispositions. Remedy advice is non-binding.

After **every reviewer round**, the author reply updates one running inventory of
material mechanisms/ceremony introduced by that round. Each item is classified
exactly once as `keep`, `simplify`, `defer`, or `cut`. Keep the inventory in
`round-NN-author-reply.md`; do not create another store. The latest inventory is
passed to every lens.

Save the reply verbatim as `round-NN-author-reply.md`, re-pull when the Issue
changed, and diff it. A content-fix reply without an Issue edit is unfinished.
Run body-only floors on the refreshed anchor.

```text
reviewer -> flow-manager relay -> task chat author disposition/fix -> Issue edit -> re-pull
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

Every browser-GPT lens and the Claude `architectural-lens` use the same contract
from `prompts/codex_draft_review_prompt.md` (rubric source only):

- wrap the current Issue body as UNTRUSTED DATA between nonce markers;
- require exact review-level `review-economics-contract: v1`;
- require every material finding to carry stable `id`, canonical `type`
  (`security|scope-violation|spec|quality|test|ci`), severity, raw `evidence:`,
  non-binding `recommendation:`, and `persistent-machinery: yes|no`;
- for every `persistent-machinery: yes`, require `cheapest-sufficient-alternative`,
  `stakes-price`, and `trade-in` (or exact `stakes-undeclared` / `net-add`);
- require the four-question simplification lens;
- permit M5 cut candidate only with exact raw `simplification-cut-candidate: yes`;
- for pre-lens `competitive` outputs on T3, require exact
  `SIMPLIFICATION_CLEAN` when no tokened cut candidate; if genuinely clean, also
  exact `NO_FINDINGS`;
- for **terminal** GPT `architectural` (M5 anchor on all tiers), require the same
  M5 token rules as the final acceptance anchor.

Save every response verbatim before normalization.

### Normalized #975 ledger facts

Keep the existing stable row and add only row-local facts needed by the guard:

- `persistent-machinery`, plus the three price values when applicable;
- `proposalOutcome` / `proposalReason` only for a declined malformed proposal;
- `simplificationCutCandidate: true|false` matching the latest governed marked raw
  occurrence;
- `protectedActivation: { authority: "author", signal: "...", whyNow: "..." }`
  when the author activates a protected nomination;
- `architectPending: true` only under **T3 pre-Claude** M3 when genuinely required;
- `architectRequired: true` only when another existing rule independently requires
  Claude adjudication.

## Step 3 — Competitive review (T3 only)

Run when T3 selects competitive as a pre-lens stage. **T1 and T2 never run
competitive.**

Each pass: fresh `--new-chat`, shared contract, save as `pass-NN-competitive.capture.txt`,
normalize, relay to task chat, update M4, re-pull, rerun body floors when changed.
Cap 3 passes. Browser unavailability blocks the stage — no substitution.

## Step 4 — Pre-lens #975 guard (T3 only)

Run only after pre-lens reviewer stages are legally terminal:

```bash
node scripts/finding-ledger-guard.mjs   --ledger "$REVIEW_DIR/finding-disposition-ledger.json"   --captures-dir "$REVIEW_DIR"   --draft-path "$ANCHOR"   --phase pre-lens   --adoption-timestamp "$ADOPTION_TS"   --stage-terminal
```

T1/T2 **skip** this phase entirely.

## Step 5 — Claude architectural-lens (T3 only)

Exactly one full lens per cycle segment after the pre-lens guard is green. The
accepted candidate must be covered by this lens before terminal GPT runs.

The flow-manager **orchestrates** this stage only: prepare inputs and the
evidence destination, launch one **separate independent Claude Code CLI** invocation,
wait for terminal completion, and capture its verbatim output/provenance. The
flow-manager must not reason through, draft, simulate, or adjudicate the Claude lens.
Browser GPT, Codex, or any other model cannot substitute for the skipped Claude lens.

#### Claude-unavailable skip (T3 stage completeness only)

When a real Claude Code CLI invocation cannot run because Claude is observably
unavailable — explicit quota, rate-limit, provider-unavailable, or CLI-unavailable
evidence — record one durable `architect-lens-stage-waiver.json` sidecar in
`$REVIEW_DIR` and proceed without the Claude lens. Ordinary impatience, an
ambiguous timeout, or a manager decision to save cost is **not** a valid skip.
Do not retry in a loop once unavailability is established.

The skip record is audit evidence only. It is not Claude provenance, does not
create an `architectural-lens` capture, does not satisfy M3 adjudication, and
grants no `T3→T2` demotion authority. After a valid skip, the terminal browser-GPT
`architectural` lens remains mandatory.

Minimal producer-facing record (stage-completeness guard accepts only this shape):

```json
{
  "reason": "claude-unavailable",
  "recorded-at": "2026-07-28T12:00:00.000Z",
  "after-pass": 2,
  "unavailability": "rate-limit"
}
```

- `reason` must be exactly `claude-unavailable`.
- `recorded-at` must be strict ISO-8601 UTC (same rule as competitive waivers).
- `unavailability` must be one of `quota`, `rate-limit`, `provider-unavailable`,
  `cli-unavailable`.
- `after-pass` is the highest completed pre-Claude pass index in the review
  episode (competitive and/or pre-lens reviewer passes). The guard requires this
  skip anchor to be **strictly greater** than the competitive anchor, and the
  terminal GPT `architectural` capture must be strictly after the skip anchor.


The Claude lens is the **pre-terminal independent aggregate cut** authority and the
**only** sanctioned tier-downgrade point (`T3→T2` only; **no** `T2→T1`). It
consumes current Issue body, T3 reject partition where applicable, current M3
protected state, latest M4 inventory, and applicable pre-lens economics.

Four mandatory goals, in order:

1. **Contradiction check** — fix via task-chat path.
2. **Feasibility check** — live probes where possible.
3. **Cut ALL overengineering — PRIMARY goal** — forced-cut answer, explicit tier
   reconsideration, `T3→T2` demotion only when justified under #973.
4. **Find what was missed** — route corrections via task-chat path.

For T3, record explicit **keep** or **cut** for each major mechanism.

### Producing-run evidence

Save as `pass-NN-architectural-lens.capture.txt` with detailed analysis in
`presync-architect-lens.md`. Co-located producing-run evidence from the
independent **Claude Code CLI** invocation is mandatory. Absence fails closed.

Fix-required results return to the task chat; re-pull and **do not** rerun Claude
until a new cycle segment is required. Post-Claude fixes go to **terminal GPT
architectural only**.

### #973 demotion (`T3→T2` only)

When justified, the lens capture contains exactly one fenced `tier-demotion-event/v1`
JSON record (`role: architect`, `stage: architectural-lens`, exact source revision,
`beforeTier: T3`, `afterTier: T2`, drivers matching source rubric labels).

After the task chat applies the authorized fence/title change and the flow-manager
re-pulls:

1. record **narrow revalidation evidence** (`tier-demotion-revalidation/v1` — not a
   full second Claude lens);
2. run **terminal GPT `architectural`** on the post-demotion candidate;
3. proceed toward acceptance when guards are green.

**No Claude after terminal GPT.**

## Step 6 — Terminal GPT architectural lens (all tiers)

Exactly **one** terminal independent browser-GPT `architectural` lens per acceptance
attempt segment. Always a **fresh** review chat (`--new-chat`), never the task chat
or a competitive review chat.

Apply the shared lens contract. Save verbatim as `pass-NN-architectural.capture.txt`
using the terminal capture identity recognized by stage-completeness guards.

- **T1/T2:** sole reviewer stage; owns **aggregate cut** and **M5 anchor**.
- **T3:** owns **final aggregate cut** and **M5 anchor** after Claude and author
  fixes. GPT cannot emit #973 demotion authority.

Relay findings to task chat, update M4, re-pull. Post-terminal-GPT accepted fixes
do **not** trigger a second GPT lens; ledger/guards decide acceptance.

### M3 by tier

| Tier / stage | Protected nomination rule |
|--------------|---------------------------|
| T1/T2 (terminal GPT) | No architect contest. Valid non-zero-signal author activation is authoritative. Absent/invalid activation → ordinary M1, **not** `architectPending`. |
| T3 pre-Claude | Zero-signal, absent activation, or contest → `architectPending` until Claude lens adjudicates. Only Claude lens may create/withdraw contest. |
| Protected nomination first emitted in terminal GPT | No post-GPT architect path. Valid author activation authoritative; else ordinary M1. |

Record `m3-protected:` lines per protected id when Claude adjudicates on T3.

## Step 7 — Acceptance

Run stage completeness/body floors, then economics guard:

```bash
node scripts/finding-ledger-guard.mjs   --ledger "$REVIEW_DIR/finding-disposition-ledger.json"   --captures-dir "$REVIEW_DIR"   --draft-path "$ANCHOR"   --phase final-acceptance   --adoption-timestamp "$ADOPTION_TS"   --issue-revision "rNN"
```

T1/T2 skip `pre-lens` phase; T3 requires it green before Claude ran and
`final-acceptance` green now.

Final acceptance requires:

1. terminal GPT `architectural` is the M5 anchor for the review episode; accepted
   terminal-GPT fixes do not require a second GPT lens — guards validate the
   resulting current body;
2. on T3, Claude `architectural-lens` covers the **source revision** it judged
   and has valid producing-run evidence when Claude ran in this segment;
3. full `checkTierGateGuard` green on the current anchor, including #973 demotion
   narrow revalidation when applicable;
4. body floors, stage completeness, and finding-ledger guard green;
5. every typed finding normalized; protected work resolved under tier-appropriate M3;
6. governed reviewer evidence after adoption boundary;
7. live Issue title prefix matches final tier; T3-critical L4 floors when applicable;
8. no required browser-GPT stage skipped; browser outage leaves work blocked;
9. final report includes Issue URL, tier/pass counts, chat URLs, manager handoff,
   workdir, T3-critical result, #973 state when applicable, M4 summary, residual risks.

Two non-converging fix cycles on the same segment escalate to the operator.

## Mechanical parity edits

Only mechanical format defects may be fixed by the flow-manager in the workdir
anchor. Content fixes belong to the GPT author in the task chat.

Run the sync helper from the **trusted repository root** with an **absolute** anchor:

```bash
REPO_ROOT=/abs/path/to/trusted/orchestrator-pack
ANCHOR="$WORKDIR/docs/issues_drafts/<N>-<slug>.md"
cd "$REPO_ROOT"
node scripts/publish-issue-body-sync.ts edit   --draft-path "$ANCHOR"   --issue-number <N>   --repo chetwerikoff/orchestrator-pack
node scripts/publish-issue-body-sync.ts verify   --draft-path "$ANCHOR"   --issue-number <N>   --repo chetwerikoff/orchestrator-pack
```

Re-pull after every parity edit.

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
  and tier-gate support files under `$REPO_ROOT`;
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
- **terminal architectural lens:** fresh conversation with `--new-chat` (never the task chat or a competitive review chat).

The flow-manager prepares the exact argv plus absolute input/output paths and owns
the browser-turn execution. It may use the sanctioned execution channel defined
by the landed helper contract, but that execution does not transfer judgment or
fallback authority to a hands-only executor.

### Cross-task browser coordination

For ordinary tracked-helper `turn` calls, **fine-grained helper scheduling is authoritative**:
existing conversations use `conversation:<normalized conversation>` and fresh chats use
independent `fresh:<invocation identity>` domains. Different conversations and independent
fresh-chat (`--new-chat`) turns may proceed in parallel. Same-conversation overlap remains
serialized or refused by the helper; callers must not clear, restart, or work around it.

Capability characterization and binding/provenance drift are **diagnostic only**. Missing,
stale, serialized, or mismatched capability must not downgrade managed tracked turns to
configured-profile scheduling, acquire a profile-wide queue, or return `profile_busy`
because another independent turn is active. Record drift through helper diagnostics and,
when applicable, the existing recurrence journal — do not caller-repair admission policy.

When the tracked transport itself is unavailable, record that transport failure for the
owning stage and follow the existing stage pending/outage/substitution rules. Do **not**
authorize scratchpad/legacy browser sending as a tracked-helper fallback and do **not**
take `orchestrator-pack:create-issue-draft:browser-turn` or any other caller mutex.

Ownership/recovery is unchanged: clear only owned state; `possible_delivery` still
requires independent conversation inspection.

Before the first **production** tracked-helper turn on a new/uncharacterized #964
candidate, complete Gate B in `discuss-with-gpt` and record characterization evidence.

Non-`ok` output, timeout, missing stdout, or process-liveness uncertainty is never
resend authorization by itself; use tracked status/publication/recovery per
`discuss-with-gpt`. Standalone `discuss-with-gpt` `driver.mjs` remains available but is
not tracked-helper success.

### Tracked helper long-turn monitoring

1. **Open shift.** A browser-turn is an open flow-manager shift until terminal
   `turn-result/v1` (`ok` or explicit non-recoverable failure handled per recovery
   rules), the stage capture is saved or recovery is recorded, **and the owned-turn
   cleanup obligations below are complete**. Backgrounding the shell does not
   transfer ownership; ending the manager session while the turn is non-terminal
   or still owns blocking helper state is non-compliant.

2. **No process-liveness inference.** A running Node PID, background job, or elapsed
   time does not prove GPT is still generating. Only helper control plane
   (`status/list`, `publication-status`) and terminal `turn-result` count.

3. **Poll cadence.** While a tracked `turn` is outstanding, the flow-manager MUST
   query `status/list` at least every **10–15 minutes** (sooner after 30 minutes or
   on user ping). When an `invocation_id` is available from a supported surface
   (for example terminal `turn-result/v1`, or task/review artifacts where the
   flow-manager recorded it before backgrounding), also query `publication-status`
   for that invocation. Do not treat `provisional_id` as an invocation ID —
   `status/list` items expose `provisional_id` but not `invocation_id`.

4. **Phase → action table** (minimum rows):

| Helper signal | Required flow-manager action |
|---|---|
| `possible_delivery` / active owner in flight | Not by itself evidence that generation is ongoing. Keep waiting only while an independent check of the conversation itself shows the reply still in progress. If the conversation shows a completed reply, stop waiting and take the documented recovery path. Never resend. |
| `fresh_orphan` / `orphaned_fresh_turn` / `recovery_required` | Stop passive wait; run documented recovery/clear path before any resend |
| `committed_ok` (publication-status) | Verify output capture on disk; if missing, recovery before resend |
| Terminal `ok` + capture saved | Publication is complete; stage may progress only after the owned-turn cleanup obligations below are also satisfied |
| `stream_timeout` / `no_reply` after full helper timeout | Before recording failure, check the conversation for a completed reply and recover it through the documented recovery path. Record failure only when no completed reply exists; then retry only per existing substitution/outage rules. |

Helper phase alone cannot distinguish a healthy in-flight turn from a stalled one: both report `possible_delivery`. Every row above that involves waiting or declaring failure therefore requires a second, independent observation of the conversation itself, not the helper control plane alone.

5. **Session completion gate.** The flow-manager MUST NOT report "waiting for GPT"
   as a final handoff. User-visible status updates may note in-progress work, but
   the manager remains responsible until terminal state or explicit blocked/recovery
   outcome is recorded in `$REVIEW_DIR/chats.md` or the task audit surface.

6. **Explicit contrast with standalone driver.** Standalone `driver.mjs` long turns
   poll the **page** every 5–10 minutes; tracked `chatgpt-browser-turn` long turns
   poll **`status/list`** and, when invocation identity is available,
   **`publication-status`** — do not apply the page-poll rule to tracked helper turns.

### Owned-turn completion and cleanup

Taking or recovering the assistant reply is necessary but not sufficient to close
a tracked browser turn. Before the flow-manager treats a turn it owns as finished
or frees its stage to proceed, the helper process for that owned turn must no
longer hold the helper's configured-profile serialization state and the helper
control state for that owned turn must no longer be active or blocking. This is
the helper-owned profile state observed through `status/list`, not caller-side
fallback exclusivity; releasing fallback exclusivity does not satisfy owned-turn cleanup.

Cleanup authority is ownership-scoped. The flow-manager may `clear` or kill only
the tracked turn it owns. A record or helper process belonging to another task or
current manager must never be cleared or killed merely to make the configured
profile available. If ownership cannot be established from the current task's own
invocation/control/audit evidence, treat the state as non-owned for mutation
purposes and leave the browser-turn work pending under helper admission or
fallback contention as applicable.

Where owned cleanup requires `clear`, the clear/resend rules below apply first.
Cleanup may use only existing supported helper/control operations plus ordinary
process handling; this contract adds no helper command, probe, daemon, lease, or
state machine. Before killing an owned helper process, query `publication-status`
when a supported `invocation_id` is available. While publication is `in_progress`,
wait/recover rather than kill. Without a supported invocation identity, process
kill is permitted only when existing supported evidence already proves publication
cannot be in progress, such as an owned incident still at `pre_send`; otherwise do
not kill merely to free the slot.

If supported operations and evidence cannot resolve the owned blocking state, the
turn remains incomplete. Record the truthful durable blocked outcome through the
existing session-completion gate, hand off as needed, and keep the stage blocked.

### Capture destinations are never hand-written

The flow-manager must not create, replace, prefix, annotate, or otherwise
hand-write the destination capture file for a tracked helper turn, even when the
browser visibly contains a complete reply. The capture is a verbatim audit
artifact; pre-creating or modifying the destination can turn the helper's later
successful no-replace publication into a destination collision.

If the tracked helper did not publish successfully, use the existing documented
recovery path or a legitimate rerun only after the existing recovery/coexistence
rules prove a resend safe. Put manual incident notes in audit/journal state, never
inside the capture bytes. This rule changes no helper publication behavior.

### Inspect resolvable conversations before clear; clear never authorizes resend

Before `clear` against a possible-delivery or otherwise ambiguous tracked-turn
record owned by the current flow-manager, inspect the actual target conversation
when it is resolvable through existing supported evidence such as an exact
recorded/returned chat URL or another already-supported stable conversation
identity. Never invent a conversation mapping from `provisional_id`, process
identity, tab position, elapsed time, or other evidence the landed helper contract
does not define as conversation identity.

When the target conversation is resolvable:

- if the original prompt is present and the reply is still being produced, retain
  the existing turn and wait/recover it;
- if the original prompt is present and a reply is complete, recover that existing
  reply through the documented path;
- if the prompt is present but helper/control state disagrees with the conversation,
  treat it as recovery state and do not resend;
- permit a later resend only when an existing documented observable state proves a
  new send is safe.

Resend safety comes from supported evidence, not flow-manager judgment. Existing
safe shapes include an owned `status/list` incident at phase `pre_send`, followed
by supported cleanup with no blocking state, or the existing complete compatible
control/publication result proving no possible delivery and no blocking state.
These are bindings to existing helper state and recovery contracts, not new states
or commands.

An interrupted fresh-chat record may expose only helper/provisional state and no
supported identity that resolves the actual target conversation. In that unresolved
`fresh_orphan` / `orphaned_fresh_turn` / `recovery_required` case, do not require
an impossible conversation inspection; preserve the existing fail-closed
recovery/clear path. Inability to resolve the conversation is not evidence that
the prompt was never delivered. `clear` may be used only as the existing recovery
contract permits, but it never proves non-delivery and never authorizes resend by
itself. No resend is permitted until an existing supported control/publication/
recovery state proves a new send safe and no blocking state remains.

A fresh-chat stage, including terminal GPT `architectural`, is invalidated as
a clean fresh turn if an identical prompt is dispatched into the same conversation
while the first copy is already present or being answered. The polluted reply is
not usable as that stage's capture; rerun that stage in a new fresh conversation
under its existing pass/stage rules.

These rules extend without weakening the existing `possible_delivery`, fresh-
orphan recovery, and `stream_timeout` / `no_reply` conversation-inspection rules.

### Shared human-authored recurrence journal

For each qualifying browser-turn/recovery incident, the flow-manager appends one
JSON object line to one shared append-only JSONL journal under the existing
out-of-repository create-issue-draft state root, outside individual `<N>-<slug>`
task workdirs so recurrence can be inspected across tasks. Every task flow-manager
uses the exact shared path `~/.local/state/create-issue-draft/browser-turn-recurrence.jsonl`.
The journal stays out of the repository and remains append-only.

The journal deliberately has no deterministic incident/episode identity contract:
no required `episode_id`, restart/handoff identity reconstruction, trigger
coalescing, pre-append journal scan, or exactly-once/deduplicated append semantics.
Normally append one line once a qualifying incident reaches an observable terminal,
recovery, or durable blocked outcome. If a later recovery action, restart, or
handoff writes another line about the same incident, reuse the same artifact
reference when available. Duplicate lines are acceptable and are reconciled by a
human reader through that artifact reference; the journal is not an authoritative
exact event counter.

A journal entry is required when any of these occurs:

1. a tracked browser turn finishes in any state other than `ok`;
2. a manual recovery action occurs, including `clear`, salvage/recovery
   intervention, resend, or process kill;
3. the flow-manager takes an action outside the documented instruction because the
   documented path was insufficient; or
4. helper/tool state and the actual conversation disagree materially.

Trigger 3 is human/operator judgment: having to improvise is itself evidence that
the instruction surface is incomplete.

A clean preflight blocker that stops before delivery, leaves no residual helper or
control state, needs no recovery action, and involves no improvisation may use a
minimal record containing only timestamp, stable recurrence-class slug, cost in
minutes/lost replies/burned runs as applicable, artifact reference, and author.
States such as `login`, `quota`, or `challenge` may use that minimal form when they
meet those conditions.

Use the fuller record whenever residual state remains, a recovery/process action
occurs, helper and conversation disagree, instruction had to be improvised, or the
truthful terminal outcome is a durable blocked handoff. The fuller record carries
timestamp; surface (`helper|skill|ao|ci|gpt|operator`); stable recurrence-class
slug; observed symptom; what was actually happening; cost in minutes, lost
replies, burned runs, or the applicable combination; workaround/recovery applied
(including explicit blocked/no-recovery-yet); proposed durable change; artifact
reference; and author.

Before the owning stage/session is treated as complete, every qualifying incident
that reached an observable terminal/recovery/blocked outcome must have a journal
line. A later line may supplement the record by reusing the same artifact
reference rather than mutating the earlier append-only line. This is a best-effort
human-authored recurrence journal, not a transactional event store: do not add a
machine writer, journal lock/service, identity registry, deduplication history,
rollup, central upload, recurrence threshold, review cadence, notification, or
automatic follow-up as part of this flow.

The former untracked one-shot scratchpad and legacy driver are not fallback
transports for this flow. Tracked transport unavailability is handled only by the
selected stage's existing pending/outage/substitution rules and is recorded in
task/review artifacts and final status. Helper failures, missing output, or clean
control state never authorize an alternate browser send.

`driver.mjs` keeps its standalone `discuss-with-gpt` adversarial duties, including
prompt construction and PASS_ID/SHA/verdict validation; this flow does not
redirect those duties to the generic helper.

Every review/amendment prompt remains self-contained, carries current Issue body
as UNTRUSTED DATA between nonce markers, and requests one outer `~~~markdown`
fence so inner backtick fences survive. Write prepared prompt to helper input file

## T3-critical classification and mandatory floors

Classify **T3-critical** when any L4 condition in Issue #574 /
`docs/issues_drafts/187-task-complexity-tier-rubric.md` matches. The declared tier
is only a prior. Classify at intake, after material Issue/scope change, and before
terminal GPT on T3.

T3-critical adds **only** these non-waivable Issue-body floors:

- explicit rollback or migration note appropriate to the change; and
- realistic acceptance criteria and matching verification for every material
  crash, race, or stale-state failure class.

There is **no** mandatory Codex addition and **no** Codex outage substitution in
create-issue-draft. While L4 remains active, the task cannot be downgraded below T3.

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
12. **Smoke-test plan** — realistic operator-visible scenarios with expected observable results, or explicit reasoned `not-applicable` inside a ```smoke-test-plan``` fence.
13. **Verification** mapped to acceptance criteria.
14. `contract-evidence` fence or explicit `contract-evidence: none` form accepted
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
node scripts/draft-discipline.mjs smoke-test-plan --draft "$ANCHOR"
node scripts/stage-completeness-guard.ts   --text-file "$ANCHOR" --draft-path "$ANCHOR" --repo-root "$WORKDIR"
```

Run body-only guards after every Issue revision. #975 finding-ledger invocations
are explicit `pre-lens` (T3 only) and `final-acceptance` commands above.

## Finding ledger details

Every reviewer capture is immutable evidence. The ledger records stable id,
summary, canonical type, defect disposition, rejection reason when applicable,
plus bounded #975 row-local economics/authority facts.

- Defect `evidence` and remedy `recommendation` stay separate.
- Protected types are nominations; tier-appropriate M3 decides authority.
- Raw `evidence:` is the only input to finding-scoped zero-signal.
- Terminal GPT `architectural` is the M5 anchor at final acceptance for all tiers.
- `NO_FINDINGS` never erases prior findings.
- Capped exits preserve unresolved questions in ledger/final report.

## Review artifacts

All durable audit artifacts remain outside repository:

```text
chats.md
round-NN-author-reply.md
pass-NN-competitive.capture.txt
pass-NN-architectural.capture.txt          # terminal GPT lens (all tiers)
pass-NN-architectural-lens.capture.txt     # Claude T3 only
<co-located lens producing-run evidence>
presync-architect-lens.md
finding-disposition-ledger.json
rNN/tier-gate-receipt.json
```

Guard-recognized stages: `competitive`, `architectural`, `architectural-lens`.
`architectural-final` is historical/audit only — do not create new captures.

## Repository-write boundary

This flow creates no tracked draft mirror, queue-index row, or in-repo audit file.
The only permitted temporary in-repo write is untracked `.review-challenge/**`
transport scratch for unrelated standalone Codex runs; delete immediately.

## Don't

- Perform, simulate, or adjudicate the Claude lens in the flow-manager session.
- Treat a `claude-unavailable` skip as Claude provenance, M3 authority, or demotion authority.
- Skip the Claude lens for impatience, ambiguous timeout, or cost-saving without observable quota/rate-limit/provider/CLI unavailability.
- Let the flow-manager author spec content or decide reviewer findings.
- Mandatory hand-off to architect outside the fixed T3 Claude lens stage.
- Review in the task chat or reuse terminal/competitive review chats.
- Run pre-lens #975 on T1/T2.
- Run `architectural-final` or credit Codex as a create-flow reviewer.
- Substitute Codex or any engine when browser GPT is unavailable.
- Authorize `T2→T1` or GPT-side #973 demotion.
- Run a second Claude lens after post-Claude fixes.
- Run a second terminal GPT lens after accepted terminal-GPT fixes.
- Treat any capture before the terminal GPT `architectural` lens as the M5 anchor.
- Skip required GPT stage silently.
- Accept with stale captures/title, red floors, incomplete ledger, red #975 phase,
  or unresolved tier-inappropriate protected work.
- Commit workdir artifacts.
- Hand-edit `.cursor/skills/**`; regenerate only when canonical frontmatter changes.
