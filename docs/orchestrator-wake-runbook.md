# Orchestrator wake listener and heartbeat runbook

**Event path:** AO `webhook` notifier → loopback HTTP POST →
`ao send <orchestrator-session-id> <wake message>`.

**Heartbeat path (issue #59):** separate process
`scripts/orchestrator-wake-heartbeat.ps1` → periodic labelled `ao send` on a
low-frequency interval, independent of webhook traffic.

For the full autonomous review-loop go-live checklist (live YAML, review command,
verification), see [`orchestrator-autoloop-go-live.md`](orchestrator-autoloop-go-live.md).

The orchestrator applies its `orchestratorRules` decision procedure on the next
AO-message-induced turn; the wake message is only a nudge naming the event kind
and affected worker session / PR.

## Merged PR — review wakes are not triage work

Review-related wakes (`review.needs_triage`, `ready_for_review`, `merge.ready`,
etc.) may still be **accepted** by the listener and delivered as `ao send` to the
orchestrator. That is expected: the wake path only schedules a turn.

When the linked worker PR is **already merged on GitHub**, the orchestrator MUST
**not** act on that wake as review backlog — no `ao review send`, no new
`ao review run`, no review-loop ping or respawn for that PR. Suppression is
entirely in **`orchestratorRules`** (**MERGED PR — REVIEW LOOP TERMINAL**, Issue
#54), applied on the next orchestrator turn after verifying merge via GitHub
(e.g. `gh pr view`), not from `ao status` session state alone.

`docs/orchestrator-wake-filter.mjs` (`evaluateWakePayload`) is a **stateless**
function over one payload; it cannot know PR merge state. Do **not** add
merge-state logic to the filter for this issue — a future listener-level guard
would be a separate change. After merge, operators may ignore stale review cards
on the dashboard for that PR; see
[`orchestrator-recovery-runbook.md`](orchestrator-recovery-runbook.md#after-manual-pr-merge).

## Prerequisites

- AO configured with `notifiers.webhook` and `notificationRouting` for `urgent`
  and `action` pointing at the listener URL (see `agent-orchestrator.yaml.example`).
- Node.js on PATH (used only to evaluate `docs/orchestrator-wake-filter.mjs`;
  no `tsx` or `npm ci` required for the listener itself).
- Orchestrator session id from `ao status` (e.g. `op-orchestrator`).

## Defaults

| Setting | Default | Override |
|--------|---------|----------|
| Port | `17487` | `-Port`, `AO_WAKE_LISTENER_PORT` |
| Path | `/ao-wake` | `-Path` |
| Bind address | `127.0.0.1` only | not configurable (by design) |
| Webhook URL in example | `http://127.0.0.1:17487/ao-wake` | `notifiers.webhook.url` in local YAML |
| Dedup window | 30 seconds | `-DedupWindowSeconds` (listener and heartbeat) |
| Heartbeat interval | 15 minutes | `-IntervalMinutes`, `AO_WAKE_HEARTBEAT_INTERVAL_MINUTES` |
| Shared dedup state file | `%TEMP%\orchestrator-wake-dedup.json` | `AO_WAKE_DEDUP_STATE` |
| Orchestrator session | — | `-OrchestratorSessionId`, `AO_ORCHESTRATOR_SESSION_ID` |

## Start (event listener)

```powershell
cd <orchestrator-pack-root>
$env:AO_ORCHESTRATOR_SESSION_ID = 'op-orchestrator'   # your id
pwsh -File scripts/orchestrator-wake-listener.ps1
```

Start this **alongside** `ao start` in a dedicated terminal. AO does not start the
listener for you.

Dry-run (no `ao send`):

```powershell
pwsh -File scripts/orchestrator-wake-listener.ps1 -DryRun
```

## Start (heartbeat backstop)

Run in a **third** terminal, separate from the webhook listener:

```powershell
cd <orchestrator-pack-root>
$env:AO_ORCHESTRATOR_SESSION_ID = 'op-orchestrator'
pwsh -File scripts/orchestrator-wake-heartbeat.ps1
```

The heartbeat does not bind a port and does not read webhook POSTs. Stopping the
listener does **not** stop the heartbeat; stopping AO notification delivery does
**not** stop the heartbeat.

Dry-run (logs `ao send` decisions without calling AO):

```powershell
pwsh -File scripts/orchestrator-wake-heartbeat.ps1 -DryRun
```

One-shot tick (smoke test):

```powershell
pwsh -File scripts/orchestrator-wake-heartbeat.ps1 -Once -DryRun
```

Heartbeat wake message format (distinct from events):

```text
wake heartbeat.reconcile periodic=reconcile
```

## Verify reachability

```powershell
Test-NetConnection -ComputerName 127.0.0.1 -Port 17487
```

The listener logs `listening` on startup. Non-loopback clients receive HTTP 403.

Synthetic POST (dry-run listener recommended):

```powershell
$body = @{
  type = 'notification'
  event = @{
    id = 'test-1'
    type = 'ci.failing'
    priority = 'action'
    sessionId = 'op-worker-test'
    projectId = 'orchestrator-pack'
    timestamp = (Get-Date).ToUniversalTime().ToString('o')
    message = 'test'
    data = @{
      schemaVersion = 3
      semanticType = 'ci.failing'
      subject = @{
        session = @{ id = 'op-worker-test'; projectId = 'orchestrator-pack' }
      }
    }
  }
} | ConvertTo-Json -Depth 10

Invoke-RestMethod -Method POST -Uri 'http://127.0.0.1:17487/ao-wake' -Body $body -ContentType 'application/json'
```

Expect a log line `accepted: ci.failing` or `dry-run: ao send ...`.

## Wake-relevant event kinds

The listener forwards when the payload semantic type or event type matches:

- `review.needs_triage` (including AO `review.pending` notifications and
  `codeReview.status: needs_triage` when present)
- `pr_created`, `ready_for_review` (agent report semantic types)
- `ci.failing`
- `report.stale` (including `report-stale` reaction notifications)
- `merge.ready`

Dropped without `ao send`:

- `info` / `warning` priority (not routed to this webhook in the example config)
- Other chatter (`summary.*`, `session.working`, etc.)
- Malformed JSON or missing worker `sessionId`

## Single-flight deduplication

The same wake kind + worker session + PR/run id within **30 seconds** produces one
`ao send`. AO webhook retries therefore do not storm the orchestrator. Adjust
with `-DedupWindowSeconds` if needed.

Listener and heartbeat share dedup state in `%TEMP%\orchestrator-wake-dedup.json`
(override with `AO_WAKE_DEDUP_STATE`), coordinated by an exclusive sidecar
`orchestrator-wake-dedup.json.lock` during each read-modify-write. A global key
prevents **any** second orchestrator wake within the window — including a heartbeat
immediately after an event-driven wake (or the reverse). If the lock cannot be
acquired within 500 ms, the wake is skipped (`dedup_lock_timeout`) rather than
risking a double `ao send`.

## Detect listener / AO problems

| Symptom | What to check |
|--------|----------------|
| No log lines after startup | AO not POSTing — confirm `notifiers.webhook.url`, routing, and `ao start` |
| `quiet-period: no accepted wake events in 300s` | Listener up but no urgent/action notifications in 5 minutes |
| `rejected non-loopback` | Something other than localhost hit the port — expected 403 |
| `rejected: missing session id` | Malformed AO payload |
| `ao send failed` | Orchestrator session id wrong or session not running |
| Port bind failure | Another process on 17487 — change port in YAML and listener |
| No heartbeat log lines | Heartbeat process not running — start `orchestrator-wake-heartbeat.ps1` |
| `heartbeat skipped: interval_not_elapsed` | Normal between 15-minute ticks |
| `heartbeat skipped: global_deduped` | Recent event wake within 30s — expected |

## Webhook authentication

The example uses loopback binding only (no shared secret). If your AO install
adds `notifiers.webhook.headers` (e.g. `Authorization`), configure the same
headers in local `agent-orchestrator.yaml` only; do not commit secrets.

## Stop

Press Ctrl+C in each wake terminal. AO and worker sessions are unaffected;
only automatic orchestrator wakes stop until the processes are started again.
Stopping the listener alone leaves the heartbeat path active (and vice versa).

## See also

- [`orchestrator-autoloop-go-live.md`](orchestrator-autoloop-go-live.md) — end-to-end autoloop adoption
- [`orchestrator-recovery-runbook.md`](orchestrator-recovery-runbook.md) — orchestrator `stuck` / `probe_failure`
