# Wake-supervisor fleet operator reference

Living operator reference for the registry-backed fleet after Issue #745. The loopback listener,
heartbeat, and four vestigial PR-A children are retired. The supervisor roster is defined only by
`scripts/orchestrator-side-process-registry.json`.

## Supervisor entry point

```powershell
cd <orchestrator-pack-root>
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-wake-supervisor.ps1 -Action Start
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-wake-supervisor.ps1 -Action Status
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-wake-supervisor.ps1 -Action Stop
```

Default state root: `%LOCALAPPDATA%/orchestrator-pack-wake-supervisor/` on Windows and
`$XDG_STATE_HOME/orchestrator-pack-wake-supervisor/` (or `~/.local/state/...`) on Linux.

## Registry roster

| `children[].id` | Script | Cadence (s) | Responsibility |
| --- | --- | ---: | --- |
| `review-trigger-reconcile` | `review-trigger-reconcile.ps1` | 600 | Periodic open-PR review coverage and degraded-CI reconcile |
| `review-trigger-reeval` | `review-trigger-reeval.ps1` | 5 | Bounded deferred-head re-evaluation |
| `review-ready-report-state-seed` | `review-ready-report-state-seed.ps1` | 5 | Seed accepted ready reports into re-evaluation |
| `ci-green-wake-reconcile` | `ci-green-wake-reconcile.ps1` | 60 | CI-green worker hand-off |
| `dead-worker-reconcile` | `dead-worker-reconcile.ps1` | 60 | Dead-worker recovery |
| `worker-message-submit-reconcile` | `worker-message-submit-reconcile.ps1` | 30 | Pending worker-input draft submission |
| `review-start-claim-reaper` | `review-start-claim-reaper.ps1` | 30 | Review-start claim-store hygiene |
| `ci-failure-notification-reconcile` | `ci-failure-notification-reconcile.ps1` | 60 | Red-CI worker notification and escalation |
| `escalation-router` | `orchestrator-escalation-router.ps1` | 30 | Orchestrator-facing escalation delivery |

## Liveness model

- Periodic reconcile children provide work discovery without webhook ingress.
- `escalation-router` is the only child requiring the orchestrator session id.
- Supervisor stall detection and restart behavior apply only to registry children.
- No child binds port 17487 or owns `listener-side-effect.lock`.
- No survivor inherits the retired listener's webhook admission or
  `escalation-handoff-envelope` responsibility.

## Verification

Most reconcile children support `-Once -DryRun`. The escalation router supports `-Once`.
The authoritative fleet checks are:

```powershell
pwsh -NoProfile -File scripts/check-side-process-launch-contract.ps1
pwsh -NoProfile -File scripts/check-vestigial-fleet-children-retired.ps1 -Json
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Status
```

A healthy status reports nine registry children. Any appearance of listener, heartbeat,
review-send-reconcile, or the four PR-A retired child ids is configuration drift.

## Recovery scenarios

### F1 — normal operation

All nine children follow their own cadence; `escalation-router` owns orchestrator-facing
redelivery until acknowledgement.

### F2 — child crash or stall

The supervisor restarts the affected registry child using the existing crash-backoff and
side-effect-lock contracts. It must never revive a retired entrypoint.

### Session-id changes

Only `escalation-router` is session-bound. A confirmed orchestrator session-id change re-targets
that child; all other survivors remain session-independent.

## Operator adoption

After a registry-changing deployment, stop the supervisor, check for identity-matched orphan
processes from the old generation, restart from the updated checkout, and verify the nine-child
status roster. See [`migration_notes.md`](migration_notes.md) for the Issue #745 PR-B sequence.
