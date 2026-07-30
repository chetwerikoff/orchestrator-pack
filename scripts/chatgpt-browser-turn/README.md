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

## State-light turn contract

One invocation owns one Browser-GPT exchange:

1. validate the caller's stable input/output arguments and local browser/profile
   preconditions;
2. connect to the configured automation Chrome;
3. open a **new dedicated tab owned by this invocation**, even when `--chat-url`
   refers to an existing conversation;
4. navigate to the requested conversation/project;
5. snapshot and submit the exact caller prompt **once**;
6. observe/poll only that owned tab until the final assistant node has page-level
   completion UI, no visible generation/tool/continuation activity, and stable
   final text across bounded reads, advancing continuation UI when needed;
7. atomically publish the captured final reply;
8. close only the invocation-owned tab and release the CDP client connection.

The input remains content-neutral. Existing stable-input validation and atomic
publication primitives are reused; they do not become workflow admission state.

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

If another/interleaved user turn appears after the invocation baseline, attribution
is ambiguous and only that invocation fails/degrades as `foreign_activity`.
Sibling Browser-GPT tabs remain independent.

## Send-once and retry boundary

Inside one live invocation there is exactly one user-message send attempt. After
the send boundary the helper only observes the same page. Slow generation,
missing historical witness state, an elapsed observation threshold, or process-
liveness uncertainty never authorizes a second send inside that invocation.

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
operational fields such as send count, poll count, cleanup outcome, incident
classes, and journal-write failure.

Typical state-light outcomes include:

- `ok`;
- `input_invalid` / `output_conflict`;
- `login` / `quota` / `rate_limit` / `challenge` / `chrome_not_running` / `profile_mismatch`;
- `send_failed`;
- `ui_contract_mismatch` / `foreign_activity` / `driver_error`.

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

## Polling and long turns

Initial dispatch observation may poll more frequently; after that, page reads are
bounded and low-frequency. Repeated normal `waiting`/`generating` observations are
not incident-journal rows. Crossing `--timeout-ms` with a still-reachable owned
page simply continues this low-frequency polling; it is not a resend signal.

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
- foreign/interleaved activity;
- mandatory own-prompt attribution after baseline;
- dedicated-tab creation and one send mutation branch;
- a reachable owned page continuing past the soft timeout without resend or
  timeout-triggered close;
- absence of old admission/recovery calls from the state-light module;
- append-only/non-authoritative recurrence journal behavior;
- absence of a second inspector/watchdog.

Repository CI additionally runs Node 22 policy, strict TypeScript, foundation
Vitest, scope/declaration checks, and current-head review gates. Real automation-
Chrome smoke remains necessary for browser/UI behavior that cannot be proven by
unit tests alone.
