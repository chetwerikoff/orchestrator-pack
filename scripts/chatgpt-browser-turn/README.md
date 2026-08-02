# ChatGPT browser-turn transport

This directory contains the tracked Node 22 Browser-GPT transport. Issue #1120
cuts the canonical create/review `turn` path over to a state-light, send-once
helper while retaining the pre-cutover implementation files and control commands
only for diagnostics/rollback compatibility.

The helper connects to the operator's already-running headed automation Chrome.
It does not launch Chrome, edit prompts, choose workflow stages, or replace the
standalone `.claude/skills/discuss-with-gpt/driver.mjs` adversarial driver.

## Canonical invocation

Use the repository package entrypoint so the Node-major guard runs first.
Existing conversation:

```bash
npm run chatgpt-browser-turn -- turn \
  --profile /absolute/path/to/automation-profile \
  --cdp http://127.0.0.1:9222 \
  --input /absolute/path/to/message.txt \
  --output /absolute/path/to/reply.txt \
  --chat-url https://chatgpt.com/c/<conversation-id>
```

Fresh conversation:

```bash
npm run chatgpt-browser-turn -- turn \
  --profile /absolute/path/to/automation-profile \
  --cdp http://127.0.0.1:9222 \
  --input /absolute/path/to/message.txt \
  --output /absolute/path/to/reply.txt \
  --new-chat \
  --project-url <configured-project-url>
```

The package entrypoint also accepts the new direct shape without the `turn` word,
but existing callers do not need to change their argv.


## Flow-manager long-running launcher (#1164)

Applicable create-issue-draft long turns must launch through the caller-side
adapter rather than spawning this transport directly from a flow-manager caller
that may exit before the turn completes:

```bash
npm run flow-manager-browser-gpt-long-run -- \
  --run-identity <id> --attempt-identity <id> \
  --handoff-receipt /path/receipt.json \
  --terminal-envelope /path/envelope.json \
  --output /path/reply.txt \
  --profile ... --cdp ... --input ... --chat-url ...
```

See [`docs/flow-manager-long-running-child-runbook.md`](../../docs/flow-manager-long-running-child-runbook.md).
This transport's send-once, atomic reply publication, and `turn-result/v1`
stdout authority are unchanged.

## State-light turn contract

One invocation owns one Browser-GPT exchange:

1. validate the caller's stable input/output arguments and local browser/profile
   preconditions;
2. connect to the configured automation Chrome;
3. open a **new dedicated tab owned by this invocation**, even when `--chat-url`
   refers to an existing conversation;
4. navigate to the requested conversation/project;

**Dedicated-tab trade-off (Issue #1120).** Every canonical turn pays one extra cold
`page.goto` compared with the pre-cutover shared-tab reuse model: the helper always
opens a fresh owned tab instead of reusing an operator-visible ChatGPT tab. That
removes shared-tab cleanup ambiguity at the cost of one additional navigation per
invocation.
5. snapshot and submit the exact caller prompt **once**;
6. observe/poll only that owned tab until the final assistant node has page-level
   completion UI, no visible generation/tool/continuation activity, and stable
   final text across bounded reads, advancing continuation UI when needed;
7. atomically publish the captured final reply;
8. close only the invocation-owned tab and release the CDP client connection.

The input remains content-neutral. Existing stable-input validation and atomic
publication primitives are reused; they do not become workflow admission state.

### Composer timing (Issue #1188)

Composer interaction uses two phases. The readiness phase starts immediately
before its first probe and has a deadline of 12 seconds, bounded by the
invocation deadline. A qualifying observation must find `#prompt-textarea`
present, visible, enabled, and content-editable.

After a successful readiness observation, the insertion phase starts with a
payload-structural allowance: `max(3,000 ms, structural_line_count × 65 ms)`.
Structural line count is the number of newline-separated blocks, treating CRLF
as one newline. The 3,000 ms floor covers trivial and one-line payloads; a
382-line payload receives 24,830 ms, exceeding the measured 21,168 ms worst
case by 3,662 ms. The allowance is clamped by the remaining invocation
deadline, and readiness time is never consumed by it. Remaining time is
recomputed before each action and at the send boundary; actions are awaited
directly and must settle strictly before the deadline. Composer readiness is
rechecked before focus/click, before fill, and at the send boundary. Losing
readiness before send fails locally with `send_count: 0`, `driver_error`, and
cause `composer_mutation_budget_exhausted`; `blocking_page_overlay` remains a
distinct confirmed timeout path.

Byte count alone does not derive a live composer deadline. `MAX_LOCAL_READ_WAIT_MS`
continues to govern unrelated local DOM-read paths.

### Page completion is sufficient

The canonical path no longer requires service-terminal/network-witness evidence
when the page already shows one attributable, final assistant reply. The helper
requires its own exact user prompt to appear after the page baseline and requires
page-level completion UI on the last assistant node while generation/tool/
continuation activity is absent, then returns only that final eligible assistant
node for the turn.

Intermediate/progress assistant nodes are not concatenated into the result and a
stable non-empty intermediate node is not sufficient by itself. A continuation
button may be clicked because it continues the same assistant response; it is not
a second user-prompt send.

Reply capture uses a strict publication window: only assistant nodes strictly
between the owned prompt user node and the next user node (of any origin) may be
published. Prompt recognition is strict normalized-text equality (markdown syntax
and whitespace collapsed); a truncated lazy-render miss stays in `waiting` until
the page catches up. A foreign or interleaved user turn after the owned prompt
without a capturable reply in that window, or a page that never shows the owned
prompt before the hard observation deadline, ends the invocation as
`observation_uncertain` (**exit 11**, no resend). Sibling Browser-GPT tabs
remain independent.

Recurrence-journal rows for interleaved/ambiguous observation use the
`interleaved_user_activity` event class with bounded uncertainty diagnostics.
Unrecognized owned prompts on a readable page never produce journal incidents.

## Send-once and retry boundary

Inside one live invocation there is exactly one user-message send attempt. After
the send boundary the helper only observes the same page. Fresh-conversation
collision recovery follows the same discipline: a second send is allowed only on
positive page-state evidence that the prior send did not land (no user message
with the sent text, no conversation URL materialized, composer still holding the
text). Ambiguous evidence or a landed send on a contended surface terminates the
invocation locally; the caller decides whether to open a fresh chat.

Slow generation,
missing historical witness state, an elapsed observation threshold, or process-
liveness uncertainty never authorizes a second send inside that invocation.
Once `send_count >= 1`, observation-window expiry alone never yields `send_failed`
or any other resend-licensing terminal while the owned page stays reachable.

`--timeout-ms` is a **soft post-send observation threshold**. If the helper still
owns a reachable page after it elapses, the same invocation keeps polling that
page at the configured low-frequency cadence; elapsed time alone neither closes
the tab nor returns fresh-resend authorization. A fresh replacement is legal only
when the process/page/chat is genuinely lost or another real local failure makes
the owned turn unavailable.

A genuinely lost/crashed process, tab, or chat may be replaced by a fresh
invocation in a fresh chat. A rare duplicate recoverable GPT text request is an
explicitly accepted Issue #1120 risk; preventing it is not worth a cross-agent
admission/recovery protocol.

## No create/review admission control plane

The canonical `turn` path does **not** read or wait on:

- `status/list` or `clear`;
- capability or Gate-B characterization/admission policy;
- `publication-status` as delivery/admission authority;
- `possible_delivery`, `profile_wall`, quarantine/tombstone/orphan recovery state;
- profile/conversation/task/Issue/PR mutexes, claims, queues, leases, or adoption
  records.

Old files and control verbs may remain reachable through the package entrypoint
for diagnostics/rollback compatibility. They are not prerequisites, admission
checks, completion checks, or resend authorization for create/review `turn`.
Historical incompatible/recovery records therefore cannot block an otherwise
healthy new Browser-GPT invocation.

## Result and output

`turn` emits one compact JSON `turn-result/v1` line. The state-light path uses the
existing closed turn-state/exit-code contract where applicable and adds compact
operational fields such as send count, poll count, navigation count, cleanup
outcome, incident classes, and journal-write failure.

`navigation_count` remains the sum of `goto_count` (`page.goto` calls) and
`new_chat_click_count` (successful "New chat" activations) during the invocation.
The split fields are emitted alongside `navigation_count` for compatibility. Retrospective incident journal rows may include the same
counter when known.

Typical state-light outcomes include:

- `ok`;
- `input_invalid` / `output_conflict`;
- `login` / `quota` / `rate_limit` / `challenge` / `chrome_not_running` / `profile_mismatch` (product walls and profile blockers use **exit 12**; `rate_limit` is temporary request throttling, distinct from exhausted `quota`);
- `send_failed`;
- `ui_contract_mismatch` / `observation_uncertain` (**exit 11**) / `driver_error` (**exit 13**).

`stream_timeout` remains part of the shared legacy turn-state contract, but the
state-light post-send path does not manufacture it merely because
`--timeout-ms` elapsed while its owned page is still reachable.

The final reply bytes are written through the existing atomic no-clobber
publication primitive. Publication conflict is invocation-local; it does not
create a profile/browser admission wall.

## Tab lifetime and cleanup

Every canonical turn creates a dedicated owned tab. This removes the old shared-
tab cleanup ambiguity.

- success closes that owned tab;
- real pre-send/post-send failures close that owned tab when the process still has
  it;
- an elapsed soft observation threshold while the owned page remains reachable is
  not a failure/cleanup boundary and does not close the tab;
- close failure is a direct incident and is reported, but a reply already captured
  successfully is not discarded because cleanup could not be confirmed;
- sibling/foreign tabs are never helper cleanup targets;
- disconnecting the Playwright CDP client never terminates the operator's Chrome.

A process crash can of course prevent local cleanup. Later flows may progressively
clean only tabs they can establish they own; they must not sweep arbitrary ChatGPT
tabs.

## Fresh-conversation prepare bounds and advisory walls

Fresh `--new-chat` turns serialize the whole prepare+send critical section behind a
mandatory profile send slot. Disabling that slot requires explicit opt-in plus a
recorded reason env var; the legacy disable flag alone is not sufficient.

Prepare attempts are capped (`STATE_LIGHT_FRESH_PREPARE_ATTEMPTS`, currently 3) with
exponential backoff between attempts instead of hot-looping `page.goto`. A product
wall observed during prepare returns the wall state immediately — no further
navigation rounds for that invocation.

### Ownership TTL, owner fences, and fail-open recovery (#1145)

Fresh `--new-chat` turns still serialize behind the profile send slot and
per-conversation fresh claims, but both artifacts are now **finite and fail-open**:

- `--timeout-ms` through **1,800,000 ms** remains accepted; larger values fail
  before browser connection, artifact acquisition, or dispatch with
  `send_count: 0`.
- The existing **`2 × timeout-ms` post-send value is a decision threshold**, not a
  hard observation/hold ceiling. An awaited DOM observation pass may return after
  that threshold; it does not manufacture resend authority.
- Send-slot authority expires no later than `acquired_at + 2,100,000 ms`.
- Fresh claims created by new code expire at
  `claimed_at + 2 × accepted timeout-ms + 300,000 ms` (maximum **3,900,000 ms**).
  Passive/legacy v1 claims without `expires_at` use `claimed_at + 3,900,000 ms`.
  The 300,000 ms grace is advisory, not proof that all work finished first.

Immediately before final message dispatch and fresh-claim create/replace, the
helper re-reads the canonical send slot and requires the complete expected v1
identity plus unexpired status. After every awaited fresh-chat observation pass
and immediately before continuation or late-result publication, it re-reads the
canonical fresh claim the same way. Fence loss suppresses the protected effect:
before-dispatch loss keeps `send_count: 0`; after-dispatch loss preserves the
owned page and returns without resend, continuation, publication, cleanup, or
release. Expiry wins over PID uncertainty; expired/corrupt records recover
through bounded retry, stale cleanup, exclusive create, and post-create
revalidation.

Emitted records remain rollback-readable v1 with only optional additive
`expires_at`. Release compares complete expected v1 identity on a final canonical
read and skips on mismatch or expected expiry, so a successor present before that
read survives. Replacement after final revalidation but before protected entry,
or after final release read but before unlink, remains documented residual risk.

These records are transport-local only. They do not authorize workflow
progression, prove delivery, permit resend, or become durable recovery state.
Upgrade/rollback requires no active state-light invocation: new code reads
passive v1 and emits old-reader-compatible v1; already-running old code is not
retroactively fenced.

The per-invocation navigation budget (`STATE_LIGHT_MAX_NAVIGATIONS_PER_INVOCATION`,
currently 10) is a hard ceiling across the owned-tab goto, prepare surfaces, and
collision-recovery prepares. Worst-case fresh-chat navigation is therefore
statically bounded and small.

When an invocation classifies `rate_limit`, `quota`, `challenge`, or `login`, it
records a short-lived, profile-scoped advisory wall marker (fail-open; corrupted
or expired markers are ignored). Sibling invocations consult that marker before
navigating and return the wall state without loading pages. This is advisory only —
not the pre-#1120 durable fail-closed blocker machinery.

## Polling and long turns

Initial dispatch observation polls every ~500ms for up to 30 seconds. After
that, post-send page observation polls every ~15 seconds — local CDP DOM reads only,
decoupled from send/navigation anti-rate-limit pacing (`--poll-ms` no longer slows
observation). Completion-sighting confirm reads stay at ~1s. Repeated normal
`waiting`/`generating` observations are not incident-journal rows. Crossing
`--timeout-ms` with a still-reachable owned page continues observation polling; it
is not a resend signal.

### Observation heartbeats

During post-send observation the helper emits one machine-greppable JSON line per
heartbeat to stdout (approximately every 30 seconds wall time or every two polls,
whichever comes first). Heartbeats use `schema: observation-heartbeat/v1` and carry
`poll_count`, `observation_state`, `stable_reads`, `completion_ready`,
`last_reply_length`, and a bounded `last_reply_sha256_head` digest. The terminal
`turn-result/v1` line remains the only completion authority; heartbeats exist so
stuck invocations become diagnosable from captured stdout within minutes instead of
waiting for deadline exhaustion.

### Transcript read resilience

Per-message transcript reads use short bounded per-node timeouts with one retry.
Chat-url continuations verify conversation identity by UUID after navigation and on
every post-send poll. A page URL whose `/c/<uuid>` does not match `--chat-url` surfaces
`owned_conversation_identity_mismatch` instead of polling indefinitely. When the URL still
matches but assistant completion is visible without the owned prompt after the dispatch
window, the helper returns `owned_conversation_render_mismatch`.

`--new-chat` turns poll for a project-scoped `/c/<uuid>` after send, navigate onto
that conversation when it materializes, and require either the owned prompt or a
materialized conversation URL before the landing window closes. Past that bound
without either, the helper returns `fresh_conversation_landing_mismatch` instead of
polling indefinitely on the blank project surface.

A failed node read marks the poll `transcriptIncomplete` instead of silently
dropping that node from the transcript (which could otherwise yield false
`owned_prompt_not_observed` on long chats or prevent stability convergence during
confirm reads). Incomplete polls are retried on the next cadence without resetting
capture stability once completion has been sighted. Post-send product-wall probes use
a separate short budget and cannot block or invalidate transcript reads.

PID, log growth, helper stdout timing, or a background shell job prove neither
that ChatGPT is still generating nor that it has completed. Issue #1120 does not
add a second direct-CDP inspector/watchdog. The direct-agent fallback/supervision
policy is a separate follow-up.

## Retrospective incident journal

Unexpected directly observed Browser-GPT events append best-effort JSONL rows to:

```text
~/.local/state/create-issue-draft/browser-turn-recurrence.jsonl
```

Compact rows may include timestamp, Issue/PR when known, surface, event class,
observed symptom, action, invocation, and agent/runtime.

The journal is deliberately weak infrastructure:

- append-only;
- no read-before-turn dependency;
- no mutex, deduplication, identity protocol, exactly-once guarantee, or recovery
  state machine;
- duplicate rows are acceptable;
- append failure is reportable but cannot veto an already captured result or a
  sibling invocation.

Normal waits do not create rows. Direct incidents must also be surfaced in the
current flow-manager/agent report so operators do not need to inspect raw JSONL to
understand the current run.

## Legacy implementation and control commands

`scripts/chatgpt-browser-turn.ts` plus older state/recovery modules remain in the
repository for compatibility and rollback evidence. The package entrypoint routes
`turn` to `state-light-turn.ts`; non-turn legacy control verbs may delegate to the
old CLI implementation.

Do not copy old Gate-B, possible-delivery, profile-wall, claim/lock, or clear-before-
retry procedures into create/review skills or call sites. Their continued presence
on disk is not live authority.

### Historical Gate-B diagnostics (non-authoritative)

The pre-#1120 implementation and its regression suite retain the original
`gate-b-characterization` diagnostic vocabulary and probe artifacts. In
particular, historical characterization covered **service-worker-owned HTTP** and
**worker/secondary-target outbound WebSocket** observations and used
`dispatch_request_not_issued` as one legacy non-delivery outcome.

Those probes remain useful for regression/forensics and for rollback compatibility.
They do **not** gate the canonical state-light `turn`, do not grant resend
authority, and must not be consulted by create-issue-draft or pack-review before a
healthy new invocation.

## Verification

Focused Issue #1120 tests cover:

- page-only final reply completion with page-level final/in-progress discrimination;
- a stable intermediate/tool-progress node surviving multiple reads before the
  later final node, with only the final node published;
- generating/continuation intermediate state;
- foreign/interleaved activity with stable-read promotion and render-tolerant
  owned-prompt echo matching;
- mandatory own-prompt attribution after baseline;
- dedicated-tab creation and one send mutation branch;
- a reachable owned page continuing past the soft timeout without resend or
  timeout-triggered close, including fresh-conversation URL-wait expiry;
- `send_count >= 1` never coexisting with `send_failed` in emitted results;
- absence of old admission/recovery calls from the state-light module;
- append-only/non-authoritative recurrence journal behavior;
- absence of a second inspector/watchdog.

Repository CI additionally runs Node 22 policy, strict TypeScript, foundation
Vitest, scope/declaration checks, and current-head review gates. Real automation-
Chrome smoke remains necessary for browser/UI behavior that cannot be proven by
unit tests alone.
