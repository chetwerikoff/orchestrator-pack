# Orchestrator wake listener runbook

This runbook covers the post-#721 listener contract. The webhook listener still admits
wake-relevant AO notifications and may trigger review-start actuation, but the retired FYI
orchestrator paste channel and the old heartbeat child are gone.

For the full supervised fleet, see
[`wake-supervisor-fleet-operator-reference.md`](wake-supervisor-fleet-operator-reference.md).

## Contract

- Listener role: accept loopback AO webhook POSTs, classify wake-relevant events, preserve
  review-start actuation for `merge.ready` / `ready_for_review`, and stamp listener progress.
- Orchestrator-facing delivery: escalation-router only. The listener does **not** paste wake
  text into the orchestrator pane.
- Orchestrator liveness during event silence: escalation-router poll cadence, not heartbeat.

## Active paths

**Webhook listener:** AO `webhook` notifier → loopback HTTP POST → listener filter and
actuation logic.

**Fast review trigger (Issue #207):** on `merge.ready` and qualifying `ready_for_review`
wakes, the listener may trigger `ao review run` before dedup. The listener also emits the
`escalation-handoff-envelope` class through the #641 escalation contract. See
`docs/review-wake-trigger.mjs` and `scripts/lib/Invoke-ReviewWakeTrigger.ps1`.

**Deferred-head re-evaluation (Issue #235):** `review-trigger-reeval` remains the bounded
follow-up for heads that were not yet ready at wake time.

**Report-state review-start seed (Issue #391):** `review-ready-report-state-seed` still
bridges accepted `ready_for_review` worker reports into the deferred re-evaluation flow. The
listener itself stays escalation-only, but the seeded follow-up remains active and documented
in `docs/review-ready-report-state-seed.mjs`.

**Escalation router:** `orchestrator-escalation-router.ps1` is now the only supervised child
that continues to deliver orchestrator-facing `llm-orchestrator` messages on its poll tick.

## Prerequisites

- AO configured with `notifiers.webhook` and `notificationRouting` for `urgent` / `action`
  to the listener URL.
- Node.js on PATH for `docs/orchestrator-wake-filter.mjs`.
- Orchestrator session id available to the supervisor or listener process.

## Defaults

| Setting | Default | Override |
|--------|---------|----------|
| Port | `17487` | `-Port`, `AO_WAKE_LISTENER_PORT` |
| Path | `/ao-wake` | `-Path` |
| Bind address | `127.0.0.1` only | not configurable |
| Webhook URL in example | `http://127.0.0.1:17487/ao-wake` | local YAML |
| Dedup window | 30 seconds | `-DedupWindowSeconds` |
| Shared dedup state file | `%TEMP%\orchestrator-wake-dedup.json` | `AO_WAKE_DEDUP_STATE` |
| Orchestrator session | — | `-OrchestratorSessionId`, `AO_ORCHESTRATOR_SESSION_ID` |

## Start (supervisor preferred)

```powershell
cd <orchestrator-pack-root>
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-wake-supervisor.ps1 -Action Start
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-wake-supervisor.ps1 -Action Status
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-wake-supervisor.ps1 -Action Stop
```

The supervisor now manages the listener plus the escalation-router as the active
orchestrator-facing pair. Per-child logs include `<state-dir>/listener.log` and
`<state-dir>/escalation-router.log`.

## Manual listener fallback

```powershell
cd <orchestrator-pack-root>
$env:AO_ORCHESTRATOR_SESSION_ID = 'op-orchestrator'
pwsh -File scripts/orchestrator-wake-listener.ps1
```

Dry-run:

```powershell
pwsh -File scripts/orchestrator-wake-listener.ps1 -DryRun
```

Manual escalation-router fallback:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-escalation-router.ps1 -OrchestratorSessionId op-orchestrator -Once
```

## Verify reachability

```powershell
Test-NetConnection -ComputerName 127.0.0.1 -Port 17487
```

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

Expect `accepted: ci.failing` in the listener log and no raw wake-text paste to the
orchestrator pane.

## Wake-relevant event kinds

The listener still accepts:

- `review.needs_triage`
- `pr_created`
- `ready_for_review`
- `ci.failing`
- `report.stale`
- `merge.ready`

It drops malformed payloads, missing `sessionId`, and non-action/info chatter exactly as
before. The difference after #721 is only the retired FYI send path.

## Single-flight deduplication

The listener retains the same file-backed 30-second dedup window for wake admission. An
accepted wake now means actuator work plus listener progress stamping; it no longer implies a
raw orchestrator `ao send`.

## Detect listener / escalation problems

| Symptom | What to check |
|--------|----------------|
| No log lines after startup | AO not POSTing, or listener not running |
| `quiet-period: no accepted wake events in 300s` | Listener is healthy but AO has not produced accepted wake traffic |
| `rejected non-loopback` | Expected 403 for non-local callers |
| `rejected: missing session id` | Malformed AO payload |
| Port bind failure | Another process on 17487 |
| Escalation JSON not reaching the orchestrator pane | Check `orchestrator-escalation-router.log` and the #641 ack flow |

## Stop

Press Ctrl+C in the listener terminal or stop the supervisor. AO and worker sessions are
unaffected; only automatic webhook wake admission stops.

## See also

- [`orchestrator-recovery-runbook.md`](orchestrator-recovery-runbook.md)
- [`orchestrator-autoloop-go-live.md`](orchestrator-autoloop-go-live.md)
- [`review-ready-report-state-seed.mjs`](review-ready-report-state-seed.mjs)
