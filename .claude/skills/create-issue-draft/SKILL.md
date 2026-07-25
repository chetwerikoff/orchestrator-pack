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
revisions, captures, chat URLs, manager handoffs, and the finding ledger live in
an out-of-repo workdir and are never committed. `docs/issues_drafts/**` and
`docs/issue_queue_index.md` are read-only prior art for this flow.

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
| GPT author in task chat | Spec content, every content fix, direct Issue edits, every finding disposition | Review its own spec |
| Cursor flow-manager | Live Issue pulls, tier/stage selection through existing rubric/guards, stage order, T3-critical classification, body/mechanical floors, immutable captures, ledger bookkeeping, pass counting, chat references/topology, browser-turn execution, acceptance mechanics | Author spec content, decide reviewer findings, perform the architect lens, invent new helper/runtime semantics |
| Architect | Optional pre-task consultation when selected; mandatory final architect lens including protected adjudication required by the active contract and the only sanctioned tier downgrade | Operate routine browser turns, maintain ledger, ratify ordinary per-round dispositions, own ordinary stage ordering or intake/mid-cycle tier selection, author normal content fixes |
| Reviewer GPT chats | Competitive critique in a fresh chat per pass; ordinary architectural critique in one dedicated reusable review chat; final verification in a fresh chat | Edit the Issue or share the task chat |
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
   records any manager handoff, recomputes tier/T3-critical stage selection, and
   runs body floors.
2. When the task began with optional architect consultation, preserve its brief
   evidence; otherwise no architect stage runs here.
3. Browser-GPT competitive stage when selected or explicitly requested, ≤3
   fresh-chat passes; findings return to the task chat for author disposition.
4. Browser-GPT ordinary architectural review in one dedicated review chat, using
   the per-tier ceiling; findings return to the task chat for author disposition.
5. Additional explicit Codex wrapper loop when requested; mandatory independent
   Codex addition for T3-critical tasks; recorded Codex substitution only for
   browser outage. Before the final lens, the flow-manager recomputes tier and
   stage selection and completes any newly required stage.
6. Mandatory final architect lens, including the only sanctioned downgrade and
   sole independent aggregate cut decision.
7. One fresh-chat browser-GPT final architectural pass after the latest final-lens
   capture when the tier/flow requires it.
8. Acceptance only over the current Issue revision with all floors and ledger
   green and a final lens covering that exact accepted revision.

Ordinary architectural review ends early on a clean pass with no findings.
Competitive and explicit adversarial loops use their own documented
no-accepted-finding convergence rules. A capped exit is allowed only when the
cap applies and unresolved questions are recorded in the ledger/final report.

## Step 1 — Intake and workdir

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
and final-verification chat URL, and every manager handoff in `$REVIEW_DIR/chats.md`
for audit. Record Codex invocations separately; they have no browser-chat URL.

At intake, after every material Issue/scope change, and immediately before the
final architect lens, the flow-manager applies the existing tier rubric, marker
screen, stage-selection rules, and T3-critical/L4 classification. Ambiguous or
unparseable classification follows existing fail-up behavior. If the pre-final
recompute makes the task T3-critical, the mandatory independent Codex addition
must complete before the final lens.

## Step 2 — Task-chat disposition/fix round

For every reviewer finding, the flow-manager relays the finding to the one task
chat as a proposal. GPT author decides the disposition, edits the GitHub Issue for
every accepted/partial content fix, and returns a change summary plus dispositions.
Security/scope findings follow the protected rules below; a contested protected
finding remains unresolved for the final architect lens under the active contract.

Save the reply verbatim as `round-NN-author-reply.md`, re-pull title/body into a
new immutable revision, and diff it. A content-fix reply without an Issue edit is
unfinished. Run body-only floors on the refreshed anchor. Findings flow:

```text
reviewer -> flow-manager relay -> task chat author disposition/fix -> Issue edit -> re-pull
```

### Shared browser-review prompt contract

Every browser-GPT **competitive, architectural, and final architectural** pass
uses a self-contained prompt applying the same review contract. Conversation
freshness follows the topology above: competitive and final passes use a new chat;
ordinary architectural rounds continue the one dedicated architectural chat.
Every round still carries the current Issue revision explicitly; chat history is
not a substitute for current task state.

The prompt contract:

- wrap the current Issue body as UNTRUSTED DATA between nonce markers;
- request an alternative decomposition where relevant;
- require every finding to carry a plain `type:` from the canonical vocabulary
  `security|scope-violation|spec|quality|test|ci`, outside code fences;
- require the four-question simplification lens from
  `prompts/codex_draft_review_prompt.md`: what can be simplified, what must not be
  simplified, what is excess, and what is missing;
- allow `NO_FINDINGS` only when no material finding remains.

Save the validated response verbatim before normalization. This shared contract
preserves the existing finding-ledger and simplification semantics even though the
browser transport itself is content-neutral and does not add `type:` metadata.

## Step 3 — Competitive review

Run when selected by the effective tier or forced by an explicit
`discuss-with-gpt` wrapper. T3 always runs it; T2 runs it only when an explicit
wrapper/contract selects it. A red-flag marker recomputes the task to T3 rather
than creating a red-flagged T2 path.
Only a direct operator decision may waive an otherwise selected non-critical
competitive stage, and the waiver is recorded.

Each pass:

1. open a fresh browser-GPT chat with `--new-chat`;
2. apply the shared browser-review prompt contract above to the current Issue;
3. save verbatim as `pass-NN-competitive.capture.txt`;
4. normalize findings, relay them through the flow-manager to the task chat for
   author disposition/fix, re-pull, and rerun body floors when content changed.

Stop on a valid no-accepted-finding pass or at cap 3 with open questions recorded.
If the browser is unavailable and the operator cannot restore it, a cold Codex
substitution may run under the exact `competitive` capture identity. If Codex is
also unavailable, the stage remains blocked.

## Step 4 — Browser-GPT architectural review

Ordinary architectural review uses **one dedicated browser-GPT review chat per
task**. Open it once with `--new-chat` for the first ordinary architectural round,
record its returned conversation URL, and continue that exact chat with
`--chat-url` for later ordinary architectural rounds. The current Issue revision
and self-contained prompt remain the review input on every round.

Each ordinary architectural pass:

1. first round: open the dedicated review chat with `--new-chat`; later rounds:
   target the recorded dedicated chat with its exact `--chat-url`;
2. apply the shared browser-review prompt contract above, focused on independent
   architecture/spec review of the current Issue revision;
3. save the validated response verbatim as
   `pass-NN-architectural.capture.txt`;
4. normalize every finding, relay it through the flow-manager to the task chat
   for author disposition/fix, re-pull the Issue, and rerun body floors when
   content changed.

Per-tier ordinary architectural ceiling: T1 one light pass, T2 ≤3 passes, T3 ≤4
passes. A clean pass with no findings ends the ordinary architectural stage
early; capped exits preserve open questions. Passes are sequential. Competitive
or final-verification chats are never reused here, and the dedicated
ordinary-architectural chat is never reused outside this task/stage.

### Browser-outage substitution

Only when the browser is unavailable and the operator cannot restore it may a
fresh cold Codex invocation replace a browser-GPT review pass. Use
[`adversarial-draft-review`](../adversarial-draft-review/SKILL.md), preserve the
replaced stage name (`competitive`, `architectural`, or `architectural-final`) in
the plain capture, store raw JSON alongside it, and record the substitution.

A substitution is credited only to the browser stage it replaces and never
satisfies the separate mandatory T3-critical Codex addition. It creates no new
browser-chat continuity. When browser GPT resumes, competitive/final stages still
open fresh chats; ordinary architectural review resumes the already-recorded
dedicated architectural chat when one exists, or opens that single dedicated chat
if no browser architectural chat existed yet.

### Explicit Codex wrapper

When brief-only `adversarial-draft-review` was explicitly requested, run its
additional cold challenge loop after the ordinary browser-GPT architectural
stage and **before** the final lens. The explicit wrapper never replaces the GPT
competitive or architectural stage. Relay findings to the task chat for GPT
author disposition, apply accepted fixes there, and rerun body floors. Cap: three
passes under that skill's convergence rule.

### T3-critical classification and mandatory floors

Classify a task as **T3-critical** whenever it matches any L4 condition in Issue
#574 / `docs/issues_drafts/187-task-complexity-tier-rubric.md`. The declared tier
is only a prior. The flow-manager classifies at intake, after material Issue/scope
change, and before the final lens. While an L4 condition remains, the task cannot
be downgraded below T3.

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
  the safe reversal/transition boundary and operator action when applicable;
- realistic acceptance criteria and matching verification for every material
  crash, race, or stale-state failure class.

The flow-manager checks the L4 classification and both floors before the final
lens. Missing classification evidence, rollback/migration coverage, realistic
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

## Step 5 — Final architect lens

Run at every tier after the ordinary review stages and every required pre-final
Codex addition complete. The accepted candidate must be covered by the latest
final lens after the last Issue content change.

The final lens is the sole **independent aggregate** cut authority for
review-added machinery and the **only** sanctioned tier-downgrade point. It has
four mandatory goals, in this exact order:

1. **Contradiction check.** Verify the task's conditions do not contradict each
   other. Any contradiction found is **fixed via the normal task-chat fix path**,
   not merely recorded.
2. **Feasibility check.** Verify the task is actually buildable as written, using
   live probes over assumptions wherever the claim can be probed.
3. **Cut ALL overengineering — PRIMARY goal.** Re-evaluate major mechanisms
   against stakes, cost/risk, and the cheapest sufficient alternative. Explicitly
   answer **“which mechanism would be cut if one had to be?”** and resolve the
   answer as either a real cut through the normal task-chat fix path or a recorded
   keep-justification explaining why the mechanism is necessary. As part of this
   same anti-overengineering goal, explicitly reconsider whether the task still
   needs its current complexity tier: ask whether simplification or removal of
   higher-tier drivers makes a lower tier valid under the existing rubric. Apply
   the existing final-lens downgrade path when it does; otherwise record why the
   current tier remains required. Marker/L4 floors and the active demotion
   contract still bind, so tier reconsideration never forces a downgrade.
   “Traces to a finding” alone is not a keep-justification. A lens verdict without
   both the forced-cut answer and an explicit tier-reconsideration result is
   invalid.
4. **Find what was missed.** Identify gaps, unverified evidence, and unsettled
   conditionals and route required corrections through the normal task-chat fix
   path.

For T3, record an explicit **keep** or **cut** verdict for each major mechanism.
Repackaging or splitting an over-built mechanism across sibling tasks is not, by
itself, a cut: record a substantive reduction or explicitly keep the total
mechanism. The lens also performs whatever protected adjudication the active
protected-finding contract requires.

Recompute against the final body only inside this lens for any downgrade; downgrade
only when higher-tier drivers are gone and the marker screen is clear. Update
title/fence through the task chat and let the flow-manager rerun the tier gate.
Prior captures and ledger rows remain valid and are never waived.

Save the guard-recognized capture as
`pass-NN-architectural-lens.capture.txt`, with detailed analysis in
`presync-architect-lens.md`. A fix-required result returns to the task chat; the
flow-manager re-pulls the changed Issue and this lens then reruns as a new capture.
Any Issue content change after a lens invalidates that lens for acceptance.

## Step 6 — Final architectural pass

T3 always runs one; T1/T2 run one only when the final lens changed content. Run
the pass in a **fresh browser-GPT chat with `--new-chat`**, apply the shared
browser-review prompt contract above, and save the validated response as
`pass-NN-architectural-final.capture.txt`.

If the browser is unavailable and the operator cannot restore it, a cold Codex
substitution may use the same `architectural-final` capture identity with raw JSON
provenance. For T3-critical tasks, that substitution does not satisfy the GPT half
or the separate mandatory independent Codex addition.

If the final pass finds issues:

```text
final finding -> flow-manager relay -> task-chat author fix -> re-pull -> newer final lens -> one new final pass
```

Preserve the failed final capture and ledger evidence. Never place two final
captures after the same latest lens. After the newer lens, exactly one newer
final may exist; this matches `stage-completeness-core.ts`.

## Step 7 — Acceptance

Acceptance requires, in order:

1. the latest final architect lens covers the exact Issue revision being accepted;
2. a clean final pass over that exact revision when required;
3. body floors, stage completeness, and finding ledger green;
4. every typed finding normalized and dispositioned by the GPT author; unresolved
   protected work resolved/adjudicated under the active protected contract; capped
   risks recorded;
5. live Issue title prefix matching the final tier;
6. no selected browser-GPT stage skipped except through a permitted recorded
   outage substitution;
7. every mandatory T3-critical Codex addition complete, and every explicit wrapper
   complete or explicitly waived only where allowed;
8. report Issue URL, tier, pass counts, task/review chat URLs, current manager
   handoff, workdir, transport fallbacks, substitutions, waivers, T3-critical
   classification result, and risks.

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

The helper strips H1 + blank before syncing. Re-pull after every parity edit so
revision history remains gapless.

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
- **ordinary architectural review:** first round creates the one dedicated chat
  with `--new-chat`; later ordinary rounds use that returned exact `--chat-url`;
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

Every review/amendment prompt remains self-contained, carries the current Issue
body as UNTRUSTED DATA between nonce markers, and requests one outer `~~~markdown`
fence so inner backtick fences survive. Write the prepared prompt to the helper
input file and save the successful reply output verbatim before interpretation.

A Codex browser-outage substitution is a separate review-engine rule, not a
transport fallback. It is permitted only after recorded browser unavailability
when the operator cannot restore it; preserve the replaced stage capture name,
raw JSON provenance, and substitution record.

## Tier gate

Run at intake, after material Issue/scope changes as required by the rubric, before
the final lens, and on the final revision from the trusted repository root with
an absolute anchor path:

```bash
node scripts/tier-gate-guard.ts --text-file "$ANCHOR" --draft-path "$ANCHOR"
```

The marker screen is fail-closed. A red marker with a below-T3 assignment or a
skipped mandatory stage blocks acceptance; unparseable input becomes T3.

Tier stages:

- T1: no competitive stage; one light browser-GPT architectural pass in the
  dedicated ordinary-architectural chat; light final lens; one fresh browser-GPT
  final verification only after lens-driven content change.
- T2: no competitive stage unless an explicit wrapper/contract selects it;
  browser-GPT architectural ≤3 in the dedicated ordinary-architectural chat;
  light final lens; one fresh browser-GPT final verification only after
  lens-driven content change.
- T3: browser-GPT competitive ≤3 fresh chats; browser-GPT architectural ≤4 in the
  dedicated ordinary-architectural chat; full final lens; exactly one fresh
  browser-GPT final pass after the latest lens.
- T3-critical: run the full T3 GPT flow plus the independent Codex addition and
  require rollback/migration plus realistic crash/race/stale-state floors.

Explicit adversarial wrappers floor the effective tier at T2 and preserve their
requested stage. Upward recompute runs skipped stages. Downward movement occurs
only at final lens and never erases evidence.

### T3-critical floor details

The L4 classification is independent of the literal `complexity-tier` fence. At
intake and every required pre-final recompute, cite the matched L4 condition(s) in
the flow-manager record. An L4 task is not acceptance-ready unless the live Issue
contains:

1. a rollback/migration note describing the safe rollback or migration boundary,
   data/state compatibility, and required operator action; and
2. numbered acceptance criteria plus matching verification that exercise every
   material crash, race, and stale-state class with realistic inputs.

These are additive to all never-skipped worker-safety, behavior-kind,
contract-evidence, stage-completeness, finding-ledger, qualifying GPT, and
independent Codex floors. They are not satisfied by a generic risk paragraph, a
happy-path unit test, or a waiver.

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
    by the repository validator.

### Required fence examples

Every task declares one behavior kind:

```behavior-kind
record-only
```

or:

```behavior-kind
action-producing
```

Action-producing tasks also include a realistic positive outcome:

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
the finite union. Broad `.`/`**/*` roots require explicit justification and
remain subject to scope discipline.

The complexity fence is exactly one of:

```complexity-tier
tier: T2
advisory-prior: T2
```

or, for a genuine below-ladder input:

```complexity-tier
skip-line: true
```

The title/H1 carries `[T1]`, `[T2]`, or `[T3]`; skip-line inputs omit a prefix.

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
node scripts/finding-ledger-guard.mjs \
  --ledger "$REVIEW_DIR/finding-disposition-ledger.json" \
  --captures-dir "$REVIEW_DIR" \
  --draft-path "$ANCHOR"
```

Run body-only guards after every Issue revision. Stage completeness and the
finding-ledger guard run at acceptance. Contract evidence uses tracked manifests
from the trusted repository root; stage completeness alone receives the workdir
as repo root to locate out-of-repo captures.

## Finding ledger

Every reviewer capture is immutable evidence. The flow-manager records each
finding with stable id, summary, type (`security`, `scope-violation`, `spec`,
`quality`, `test`, `ci`), the GPT author's disposition, and reject reason when
applicable.

- Accepted/partial findings are fixed by the GPT author through the task chat.
- Rejected non-protected findings need a proportionality reason tied to blast
  radius, reversibility, failure impact, and a cheaper sufficient alternative.
- Before #975 is present on the implementation base, the current legacy protected
  handling remains unchanged: security and scope-violation findings cannot be
  rejected; address them with real defense/evidence or explicit operator risk
  acceptance, and contested protected work remains unresolved for architect
  adjudication at the final lens.
- Once #975 is present on the implementation base, every still-active acceptance
  attempt follows its current M3 nomination/author-decision/architect-adjudication
  semantics regardless of when the ledger began; already-completed historical
  ledgers remain legacy-readable. A non-binding architect adjudication returns the
  underlying defect to ordinary M1 author disposition semantics.
- `NO_FINDINGS` never erases prior findings.
- Capped exits preserve unresolved questions in the ledger and final report.

This role/topology flow adds no protected guard, schema, capture-format, pricing,
or reviewer-economics behavior.

## Review artifacts

All durable audit artifacts remain outside the repository:

```text
chats.md
round-NN-author-reply.md
pass-NN-competitive.capture.txt
pass-NN-architectural.capture.txt
pass-NN-architectural.codex.json        # only when a Codex role runs
pass-NN-architectural-lens.capture.txt
pass-NN-architectural-final.capture.txt
pass-NN-architectural-final.codex.json  # only when Codex substitutes
presync-architect-lens.md
finding-disposition-ledger.json
```

Optional pre-task architect consultation may be referenced in `chats.md` or the
existing handoff/audit record; it does not add a mandatory new artifact class.
Pass numbers form one chronological sequence. Guard-recognized stages are
`competitive`, `architectural`, `architectural-lens`, and
`architectural-final`. Capture every reviewer response before editing.

Every typed finding receives a stable id, summary, type, author disposition, and
reason when rejected where the active contract permits rejection. Reworded
findings retain identity. `NO_FINDINGS` never erases older findings. Protected
findings follow the active contract and may never be silently omitted.

Codex raw JSON is provenance only; whenever Codex runs, transcribe findings 1:1
into the plain capture for the stage because the ledger guard ignores fenced/raw
JSON structure.

## Repository-write boundary

This flow creates no tracked draft mirror, queue-index row, capture, ledger, or
workdir file. The only permitted temporary in-repo write is an untracked
`.review-challenge/**` transport copy when a Codex role requires
`--scope working-tree`; delete it immediately after the pass and never commit it.

Cross-Issue contract changes update every affected live Issue before acceptance
and land the corresponding architecture decision together. Durable decisions go
to the repository's architecture decision surface under their own scoped change.

## Don't

- Let the flow-manager author spec content or decide reviewer findings.
- Let the architect operate routine browser turns, ledger bookkeeping, ordinary
  stage ordering, per-round disposition ratification, or intake/mid-cycle tier
  selection.
- Review in the task chat.
- Reuse any competitive or final browser-GPT review chat; conversely, do not open
  a new ordinary architectural browser chat for each round after the dedicated
  chat exists.
- Let Codex become the default architectural engine, claim a substitution without
  recorded browser unavailability, or double-count a substitution as the separate
  T3-critical Codex addition.
- Start a browser turn without exclusive ownership of the common cross-task
  browser critical-section identity; do not extend that lock over Issue/ledger
  work or implement a new runtime lock here.
- Treat a tracked-helper non-`ok` state, timeout, missing stdout, or unresolved
  status as scratchpad/legacy fallback authorization or resend permission.
- Run legacy/scratchpad browser sends while helper-owned unresolved state blocks
  coexistence for the configured profile.
- Trust a chat reply without a live Issue re-pull and diff.
- Run parity sync from `$WORKDIR`; use trusted repo cwd + absolute anchor.
- Omit `behavior-kind` or `allowed-roots` from any task/skip-line body.
- Skip a requested GPT/Codex stage, a selected browser-GPT stage, or the mandatory
  T3-critical Codex addition silently.
- Miss the Issue #574 L4 classification or waive/dilute rollback/migration and
  crash/race/stale-state floors.
- Accept after an Issue content edit without a newer final-lens capture and any
  final verification required by the tier flow.
- Accept with stale captures/title, red floors, or incomplete ledger.
- Use raw `gh issue edit`; use the sanctioned body-sync helper for parity only.
- Commit workdir or `.review-challenge/**` artifacts.
- Hand-edit `.cursor/skills/**`; regenerate only when canonical frontmatter changes.
- Over-specify implementation details that belong to the planner.