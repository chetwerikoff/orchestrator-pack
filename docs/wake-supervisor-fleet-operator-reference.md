# Wake-supervisor fleet operator reference

Living operator reference for the registry-backed wake-supervisor fleet after Issue #721.
The active orchestrator-facing model is escalation-only: the listener no longer pastes FYI
wake text, and the heartbeat child is retired from the registry.

**Related:** start/stop mechanics and webhook defaults live in
[`orchestrator-wake-runbook.md`](orchestrator-wake-runbook.md).

## Supervisor entry point

```powershell
cd <orchestrator-pack-root>
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-wake-supervisor.ps1 -Action Start
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-wake-supervisor.ps1 -Action Status
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-wake-supervisor.ps1 -Action Stop
```

Default state root: `%LOCALAPPDATA%/orchestrator-pack-wake-supervisor/` (Linux:
`$XDG_STATE_HOME/orchestrator-pack-wake-supervisor/` or `~/.local/state/...`).

## Registry roster

Roster derived from `scripts/orchestrator-side-process-registry.json` after heartbeat
retirement (**14** children):

| `children[].id` | Script | Cadence (s) | Side-effecting |
| --- | --- | ---: | --- |
| `listener` | `orchestrator-wake-listener.ps1` | 300 | yes |
| `review-trigger-reconcile` | `review-trigger-reconcile.ps1` | 600 | yes |
| `review-trigger-reeval` | `review-trigger-reeval.ps1` | 5 | yes |
| `review-ready-report-state-seed` | `review-ready-report-state-seed.ps1` | 5 | yes |
| `ci-green-wake-reconcile` | `ci-green-wake-reconcile.ps1` | 60 | yes |
| `dead-worker-reconcile` | `dead-worker-reconcile.ps1` | 60 | yes |
| `review-finding-delivery-confirm` | `review-finding-delivery-confirm.ps1` | 300 | yes |
| `worker-message-submit-reconcile` | `worker-message-submit-reconcile.ps1` | 30 | yes |
| `review-run-recovery` | `review-run-recovery.ps1` | 60 | yes |
| `review-stuck-run-reaper` | `review-stuck-run-reaper.ps1` | 60 | yes |
| `review-start-claim-reaper` | `review-start-claim-reaper.ps1` | 30 | yes |
| `ci-failure-notification-reconcile` | `ci-failure-notification-reconcile.ps1` | 60 | yes |
| `ci-failure-notification-reaction` | `ci-failure-notification-reaction.ps1` | 60 | no |
| `escalation-router` | `orchestrator-escalation-router.ps1` | 30 | yes |

## Operator summary

| Id | Verify pattern | Operator note |
| --- | --- | --- |
| `listener` | `-DryRun` (long-running HTTP) | Accepts webhook wakes, may actuate review start, stamps progress, never pastes FYI wake text. |
| `escalation-router` | `-Once` | Only active orchestrator-facing delivery child; poll tick owns `llm-orchestrator` redelivery. |
| `review-trigger-reconcile` | `-Once -DryRun` | Periodic open-PR coverage and degraded-CI reconcile. |
| `review-trigger-reeval` | `-Once -DryRun` | Bounded scoped re-check for early wakes. |
| `review-ready-report-state-seed` | `-Once -DryRun` | Seeds ready reports into re-eval/watch flow. |
| Other children | `-Once -DryRun` | Unchanged by Issue #721 except for registry count and supervisor health expectations. |

## Liveness model

- Event-driven webhook traffic reaches the listener when AO emits wake-relevant notifications.
- During webhook silence, orchestrator-facing liveness is the escalation-router poll cadence.
- Supervisor stall detection now ignores the removed heartbeat child because it is no longer
  registered or expected to write progress.

## Key child details

### listener

| Field | Operator detail |
| --- | --- |
| **Trigger** | AO `webhook` notifier POST to loopback `http://127.0.0.1:17487/ao-wake`. |
| **Expected action** | Filter wake-relevant semantic types, preserve `merge.ready` / `ready_for_review` actuation, emit `escalation-handoff-envelope`, stamp progress, and log accepted wakes. |
| **Bound surfaces** | `gh`, review-trigger helpers, listener side-effect lock, shared dedup state. |
| **Verify (read-only)** | `pwsh -NoProfile -File scripts/orchestrator-wake-listener.ps1 -DryRun` and a synthetic POST. |

### escalation-router

| Field | Operator detail |
| --- | --- |
| **Trigger** | Periodic tick (registry 30 s). |
| **Expected action** | Deliver or redeliver outstanding `llm-orchestrator` escalation records until validated ack; this is the remaining orchestrator-pane delivery surface. |
| **Bound surfaces** | `scripts/lib/Orchestrator-Escalation.ps1`, escalation state store, `journaled-worker-send.ps1`, orchestrator ack helper. |
| **Verify (read-only)** | `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-escalation-router.ps1 -OrchestratorSessionId op-orchestrator -Once` |

### review-trigger-reconcile

Periodic open-PR coverage and degraded-CI reconciliation. Issue #721 does not change its
business logic; it now relies on the escalation-only delivery model rather than any FYI wake
paste path.

### review-trigger-reeval

Bounded deferred-head follow-up for early wakes. Remains registered and side-effecting after
#721.

### review-ready-report-state-seed

Seeds accepted `ready_for_review` worker reports into the deferred-head watch flow. This child
remains part of the fleet and is still referenced by
[`orchestrator-wake-runbook.md`](orchestrator-wake-runbook.md).

### ci-green-wake-reconcile

Handles CI-green worker wake decisions. No heartbeat dependency remains after #721.

### dead-worker-reconcile

Performs dead-worker recovery checks and emits recovery escalations when needed.

### review-finding-delivery-confirm

Confirms review finding delivery using the stdout-first pipeline contract.

### worker-message-submit-reconcile

Maintains worker submit-adoption reconciliation. Unchanged by #721.

### review-run-recovery

Repairs stuck review runs and remains supervised as a side-effecting child.

### review-stuck-run-reaper

Reaps review runs stuck beyond bounded thresholds. Registry membership unchanged.

### review-start-claim-reaper

Reaps stale review-start claims and preserves claim-store hygiene.

### ci-failure-notification-reconcile

Produces CI-failure notifications and degraded-CI escalation records.

### ci-failure-notification-reaction

Non-side-effecting reaction child that evaluates CI-failure notification state.

## Fleet scenarios

### F1

Normal supervised fleet operation: listener accepts webhook traffic, other registry children
advance their own polls, and escalation-router owns orchestrator-facing liveness.

### F1b

Event silence: the listener may log quiet periods while escalation-router continues its poll
cadence. This is the intended post-#721 liveness model.

### F2

Recovery posture: if a session-bound child stalls or crashes, the supervisor restarts it from
the current registry roster without reviving the retired heartbeat child.

### Child crash / crash-loop backoff

Supervisor crash backoff remains unchanged. A retired heartbeat process should never appear in
Status output after #721; if it does, recycle the supervisor from a current checkout.

### Stall detection

Supervisor liveness is keyed to the registered children only. If `listener` or
`escalation-router` stop updating their progress files without a side-effect lock in flight,
the supervisor may restart them.

### Session-id changes

The supervisor still re-targets session-bound children when the orchestrator session id
changes. After #721, those children are `listener` and `escalation-router`.

## When to update this document

Update this reference whenever `scripts/orchestrator-side-process-registry.json` changes,
when a child’s operator-facing verify path changes, or when orchestrator-facing liveness moves
between children.
