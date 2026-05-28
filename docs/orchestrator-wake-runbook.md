# Orchestrator wake listener runbook

Event-driven local bridge: AO `webhook` notifier → loopback HTTP POST →
`ao send <orchestrator-session-id> <wake message>`.

The orchestrator applies its `orchestratorRules` decision procedure on the next
AO-message-induced turn; the wake message is only a nudge naming the event kind
and affected worker session / PR.

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
| Dedup window | 30 seconds | `-DedupWindowSeconds` |
| Orchestrator session | — | `-OrchestratorSessionId`, `AO_ORCHESTRATOR_SESSION_ID` |

## Start

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

## Detect listener / AO problems

| Symptom | What to check |
|--------|----------------|
| No log lines after startup | AO not POSTing — confirm `notifiers.webhook.url`, routing, and `ao start` |
| `quiet-period: no accepted wake events in 300s` | Listener up but no urgent/action notifications in 5 minutes |
| `rejected non-loopback` | Something other than localhost hit the port — expected 403 |
| `rejected: missing session id` | Malformed AO payload |
| `ao send failed` | Orchestrator session id wrong or session not running |
| Port bind failure | Another process on 17487 — change port in YAML and listener |

## Webhook authentication

The example uses loopback binding only (no shared secret). If your AO install
adds `notifiers.webhook.headers` (e.g. `Authorization`), configure the same
headers in local `agent-orchestrator.yaml` only; do not commit secrets.

## Stop

Press Ctrl+C in the listener terminal. AO and worker sessions are unaffected;
only automatic orchestrator wakes stop until the listener is started again.
