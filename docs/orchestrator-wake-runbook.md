# Orchestrator wake and side-process runbook

This runbook describes the pack-owned wake supervisor after retirement of the
loopback listener. The listener retirement is backed by the committed disposition
fixture and does not depend on a concrete runtime daemon, webhook bridge, or state
database.

## Current contract

- There is no supervised loopback HTTP listener, port `17487` contract, webhook
  deduplication state, or listener side-effect lock.
- Routine review coverage is owned by `review-trigger-reconcile`.
- Early or not-yet-ready heads are handled by `review-trigger-reeval`.
- Accepted ready reports are bridged by `review-ready-report-state-seed`.
- CI transitions are handled by `ci-green-wake-reconcile` and
  `ci-failure-notification-reconcile`.
- `escalation-router` is the only identity-bound child that delivers escalation
  records to the registered runtime adapter.
- `worker-message-submit-reconcile`, `review-start-claim-reaper`, and
  `dead-worker-reconcile` retain their existing responsibilities.

No surviving child inherits listener admission or the retired handoff-envelope
class.

## Start, status, and stop

```powershell
cd <orchestrator-pack-root>
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Start
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Status
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Stop
```

`-Action Status` must report the nine children defined by
`scripts/orchestrator-side-process-registry.json`. It must not report the listener,
heartbeat, `review-send-reconcile`, or the four retired children from the prior
fleet cut.

## Operator adoption after listener retirement

1. Stop the supervisor before deploying an updated registry.
2. Inspect the supervisor state directory and process command lines for an orphaned
   listener process.
3. Terminate only an identity-matched orphan. Never kill an unrelated process by
   port or PID alone.
4. Restart the supervisor from the updated checkout.
5. Confirm the nine-child roster and observe one normal cadence for crash loops.
6. Confirm no process attempts to bind `127.0.0.1:17487`.
7. Remove host-only webhook routing that existed solely for the retired listener.
   No repository runtime configuration is part of that cleanup.

## Read-only verification

```powershell
pwsh -NoProfile -File scripts/check-vestigial-fleet-children-retired.ps1 -Json
pwsh -NoProfile -File scripts/check-side-process-launch-contract.ps1
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Status
```

The retirement guard checks the listener ID, entrypoint filename, and lock name
across registry, supervisor, inventory, escalation, and message surfaces. Its
self-test exercises every retired child across every binding surface.

## Recovery

Use `docs/orchestrator-recovery-runbook.md` for supervisor lifecycle recovery and
`docs/wake-supervisor-fleet-operator-reference.md` for the living roster and
per-child verification paths. Runtime effects during recovery still require an
adapter-produced `{ runtime, id, generation }` identity; supervisor state or a
process ID alone is not authority.
