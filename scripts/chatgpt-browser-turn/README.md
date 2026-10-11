# chatgpt-browser-turn

Shared Browser-GPT state-light transport used by multiple orchestrator-pack workflows, under the declared Node runtime. Workflow-specific review and acceptance rules remain with their callers. Issue #1120 cuts the canonical create/review `turn` path over to a state-light, send-once
helper while retaining the pre-cutover implementation files and control commands
only for diagnostics/rollback compatibility.

Canonical operator procedure:
[`docs/browser-gpt-turn-runbook.md`](../../docs/browser-gpt-turn-runbook.md).

## Entrypoint

```text
npm run --silent chatgpt-browser-turn -- turn   --invocation-id <id>   --profile <profile>   --cdp <url>   --input <prompt-file>   --output <reply-file>   [--project-url <url> --new-chat | --chat-url <url>]
```

The entrypoint reads stable input, owns one send, observes the exact conversation,
recovers only the same invocation, and atomically publishes the harvested reply.

The command emits one `turn-result/v1` JSON result. Possible/proven delivery
forbids blind resend. Timeouts, process liveness, or missing local artifacts do
not manufacture non-delivery.

The existing page probe supports an additive identity-bound `inspect` form for
callers that already retain one state-light invocation:

```bash
npm run browser-gpt-page-probe -- inspect \
  --cdp "${CDP_ENDPOINT}" \
  --profile "${BROWSER_PROFILE}" \
  --invocation-id "${INVOCATION_ID}" \
  (--url "${CHAT_URL}" | --target-id "${TARGET_ID}")
```

`--profile` and `--invocation-id` must be supplied together. The probe derives
the existing configured profile key and reads exactly the corresponding
`state-light-turn-observation/v1` record; it does not scan profile state or
choose a different marker from the page. A bound durable conversation URL must
match the inspected page.

The persisted phase is evaluated before recovery classification. `not_sent` and
`prepared` skip marker projection. `dispatching`, `sent_unbound`,
`sent_unharvested`, and `harvested` may classify only the exact persisted
marker, requiring one carrier and one occurrence; unrelated historical markers
do not make that expected marker ambiguous. The mode is read-only,
`diagnostic_only: true`, and `workflow_authority: none`; it cannot open,
navigate, close, Retry, Stop, resend, publish, or authorize a replacement. Its
snapshot omits prompt/marker text witnesses. `--open-if-missing` is therefore
invalid in identity-bound mode.

## Tab lifetime and cleanup

Every canonical turn creates a dedicated owned tab. This removes the old shared-
tab cleanup ambiguity.

- a fresh pre-send failure best-effort clears the draft on its still-owned blank project page while holding the composer lock, even when the page is preserved; an uncertain click never authorizes draft clearing;
- a post-send turn closes that exact tab only after the final-path publisher returns
  `committed_ok`;
- every post-send/no-publication result preserves the reachable retained tab and
  grants no resend or orphan-close authority;
- a definitely lost page receives no second close attempt;
- bounded page-close failure is subordinate to the already-determined result and
  never widens the close target set;
- the connected browser release runs after that page decision and only disconnects
  this Playwright client; sibling/foreign tabs remain outside the cleanup target set.

A helper crash can leave an orphan. The supported follow-up uses the exact same
caller-owned invocation identity: `browser-gpt-page-probe harvest` is the sole
action-producing probe (`diagnostic_only: false`) and still has
`workflow_authority: none`; `list`, `inspect`, `export`, and `liveness` are
diagnostic-only and also have `workflow_authority: none`. No later process
derives page-close authority from metadata, URLs, target IDs, age, focus, or
liveness.

## Fresh-conversation prepare bounds and advisory walls

Fresh `--new-chat` turns take one profile-wide composer file lock before opening
their tab, reusing `acquireDomainLock`. Dead-process locks are reclaimed immediately;
One 61-second limit bounds the slot: a lock older than that limit is reclaimed
even if its owner is still alive; a waiter proceeds without the slot when the
same limit is reached, or stops at an earlier invocation deadline. This limit
applies only to the fresh-send composer lock, not other domain locks.
The lock is released after observed dispatch or after bounded pre-send draft
cleanup on every exit path. Existing-chat continuations do not take it. The
legacy send-slot protocol is no longer a canonical fresh-send gate.
Fresh composer reads and fills front the tab; rendered payload comparisons
ignore whitespace added by the editor, including around backticked URLs.

Prepare attempts are capped (`STATE_LIGHT_FRESH_PREPARE_ATTEMPTS`, currently 3) with
exponential backoff between attempts instead of hot-looping `page.goto`. A product
wall observed during prepare returns the wall state immediately — no further
navigation rounds for that invocation.

### Ownership TTL, owner fences, and fail-open recovery (#1145)

The profile composer lock bounds fresh-send contention; per-conversation fresh
claims retain their finite ownership contract:

- `--timeout-ms` through **1,800,000 ms** remains accepted; larger values fail
  before browser connection, artifact acquisition, or dispatch with
  `send_count: 0`.
- The existing **`2 × timeout-ms` post-send value is a decision threshold**, not a
  hard observation/hold ceiling. An awaited DOM observation pass may return after
  that threshold; it does not manufacture resend authority.
- Fresh claims created by new code expire at
  `claimed_at + 2 × accepted timeout-ms + 300,000 ms` (maximum **3,900,000 ms**).
  Passive/legacy v1 claims without `expires_at` use `claimed_at + 3,900,000 ms`.
  The 300,000 ms grace is advisory, not proof that all work finished first.

Before dispatch, a sender still holding a composer lock checks that it has not
been taken over. After fresh-claim acquisition and before continuation or late
publication, the helper re-reads the canonical fresh claim with its expected
identity and unexpired status. Claim loss preserves the owned page and returns
without resend or page-close authority. The finalizer still performs bounded
connected-client release. Expired/corrupt claims use the existing bounded recovery.

Emitted records remain rollback-readable v1 with only optional additive
`expires_at`. Release compares complete expected v1 identity on a final canonical
read and skips on mismatch or expected expiry, so a successor present before that
read survives. Replacement after final revalidation but before protected entry,
or after final release read but before unlink, remains documented residual risk.

A resumed old composer-lock owner cannot release its successor's lock or clear
the successor's shared draft. The original invocation deadline still bounds
pre-send work, including callers that proceeded without the slot at the wait cap.

On a dedicated new-chat project tab, the pre-send composer is read before typing;
a stale nonempty draft is cleared and re-read before the owned marker is inserted.
Only positive evidence records `stale_composer_cleared: true` in terminal/v1.
Prompt bytes, stale draft bytes and sibling tabs never enter that diagnostic.
The full **60 s Send-readiness reserve** sits inside the original invocation
timeout, separately from navigation/cleanup/insertion; insufficient remaining
time ends safely before typing. Two 30 s readiness **maxima**, not sleeps, click
immediately on an enabled visible Send button (no Enter fallback or third window).
A first Playwright click timeout is possible delivery by default. A second and
final click is allowed only when the actual Playwright actionability log proves
the first action never physically dispatched and the exact marked composer,
user-node baseline, absent Stop and current page/slot identity all still agree.
Missing log proof or any ambiguity forbids retry and pre-send cleanup; a newly
attributable Stop after click is delivery and continues normal observation.
An unclicked never-enabled button can end not-sent; clear its draft before
releasing the composer lock, then close only its proven dedicated blank tab.
After lock release, the finalizer reads the composer but never fills it again.
Operator recovery must never blindly resend after possible delivery.

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

The ordinary `state-light-entry.ts turn` path and the long-running launcher share
one timing contract from `liveness-contract.ts`. Before the first heartbeat or
terminal result, the launcher permits only the bounded startup allowance for
process bootstrap plus direct-publication canonical admission. Once the admitted
turn takes over it emits `observation-heartbeat/v1` immediately, before profile/CDP
or browser work, and continues on a turn-scoped timer independent of transcript
polling and `POST_SEND_OBSERVATION_POLL_MS`.

Heartbeats include a bounded `phase` (`admitted_pre_send`, `composer_dispatch`, or
`post_send_observation`). The phase and heartbeat counters are diagnostics only:
they prove that the Node event loop can emit, not that CDP navigation, composer
insertion, dispatch, transcript observation, or model generation made progress.
Existing operation budgets remain the authority for logical stalls. The shared
contract fails closed unless the maximum healthy heartbeat gap is strictly smaller
than the live-child idle window, and the launcher replaces that recurring deadline
from each accepted heartbeat's own arrival time.

The heartbeat timer is scoped to one turn, is non-keepalive, and is disposed before
the turn returns. A terminal `turn-result/v1` remains the only completion authority
and cannot be followed by timer-owned heartbeats that keep the child alive. Startup
silence is `child_startup_timeout`; silence after an accepted heartbeat is
`child_liveness_timeout`; real process exit without a terminal result remains
`child_terminal_result_missing`. Cancellation receipts stay evidence only on these
branches: they never manufacture Stop-generating or resend authority.

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
${LOCAL_STATE_DIR}/create-issue-draft/browser-turn-recurrence.jsonl
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

The separately invokable legacy prompt-bearing `scripts/chatgpt-browser-turn.ts
turn` is not a second governed direct-publication sender. If it receives
`--reviewer-source-output` or another direct-publication identity/context key, it
returns `input_invalid:legacy_direct_publication_turn_refused` before legacy
browser configuration, profile verification, CDP, page creation, or send. Its
non-direct diagnostics/control compatibility remains unchanged.

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
  marker-owned prompt attribution;
- mandatory marker-owned attribution after baseline;
- dedicated-tab creation and one send mutation branch;
- a reachable owned page continuing past the soft timeout without resend or
  timeout-triggered close, including fresh-conversation URL-wait expiry;
- `send_count >= 1` never coexisting with `send_failed` in emitted results;
- absence of old admission/recovery calls from the state-light module;
- append-only/non-authoritative recurrence journal behavior;
- absence of a second inspector/watchdog.

Focused Issue #1431 tests additionally cover current-source canon generation,
selected-section versus whole-blob drift, frozen plural rendering, pre-browser
hand-written/mutated prompt refusal, required long-run stage/slot context, and
legacy direct-publication bypass refusal.

Repository CI additionally runs declared-runtime policy, strict TypeScript, foundation
Vitest, scope/declaration checks, and current-head review gates. Real automation-
Chrome smoke remains necessary for browser/UI behavior that cannot be proven by
unit tests alone.

### Owned-turn marker (#1172)

Each state-light payload is sent as a visible `OPKTURNV1` plus 128-bit hexadecimal
marker prefix, followed by one blank line and the unchanged caller payload. The
marker is generated once from an invocation-local cryptographically strong source
for that payload.

Ownership is established only when exactly one current `user` message has the
expected marker as its first token after the closed prefix scan over Unicode
`White_Space`, U+FEFF, and U+200B. The helper reads complete rendered `innerText`
at the user-role message boundary; product attributes such as `data-message-id`
are diagnostic-only and cannot grant, deny, or terminate ownership.

If the marker is unresolved, ambiguous, or disappears after binding, the helper
returns `ui_contract_mismatch` with the corresponding marker cause, publishes no
reply, and keeps `send_count` at one. It never falls back to prompt text, product
identity, or a second send.
This marker contract is shared by future per-payload session adoption.
`session` reuses the same transport contracts for an explicitly owned
conversation. Use `browser-gpt-page-probe` only for read-only diagnosis.
