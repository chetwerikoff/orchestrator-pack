# Orchestrator wake and side-process runbook

This runbook describes the post-Issue #745 fleet. The loopback
`orchestrator-wake-listener.ps1` child is retired: the final-base probe bound successfully for
60 seconds and observed zero webhook POSTs, matching the AO 0.10.2 production audit. The
structured disposition evidence is
`tests/fixtures/listener-disposition/retire.json`.

## Current contract

- There is no supervised loopback HTTP listener, port 17487 contract, webhook dedup state, or
  listener side-effect lock.
- Routine review coverage is owned by `review-trigger-reconcile`.
- Early/not-yet-ready heads are handled by `review-trigger-reeval`.
- Accepted ready reports are bridged by `review-ready-report-state-seed`.
- CI transitions are handled by `ci-green-wake-reconcile` and
  `ci-failure-notification-reconcile`.
- `escalation-router` is the only session-bound child that delivers orchestrator-facing
  escalation records.
- `worker-message-submit-reconcile`, `review-start-claim-reaper`, and
  `dead-worker-reconcile` retain their existing responsibilities.

No surviving child inherits listener webhook admission or the retired
`escalation-handoff-envelope` class.

## Start, status, and stop

```powershell
cd <orchestrator-pack-root>
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-wake-supervisor.ps1 -Action Start
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-wake-supervisor.ps1 -Action Status
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-wake-supervisor.ps1 -Action Stop
```

`-Action Status` must report the nine children defined by
`scripts/orchestrator-side-process-registry.json`. It must not report `listener`, heartbeat,
`review-send-reconcile`, or any of the four PR-A retired children.

## Operator adoption after listener retirement

1. Stop the supervisor before deploying the updated registry.
2. Inspect the supervisor state directory and process command lines for an orphaned
   `orchestrator-wake-listener.ps1` process. Terminate only an identity-matched orphan; never kill
   an unrelated process by port or PID alone.
3. Restart the supervisor from the updated checkout.
4. Confirm the nine-child status roster and watch one normal cadence for crash loops.
5. Confirm there is no process attempting to bind `127.0.0.1:17487`.
6. Remove local webhook routing that existed only for the retired listener when cleaning up
   operator configuration. No repository `agent-orchestrator.yaml` edit is part of this change.

## Read-only verification

```powershell
pwsh -NoProfile -File scripts/check-vestigial-fleet-children-retired.ps1 -Json
pwsh -NoProfile -File scripts/check-side-process-launch-contract.ps1
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Status
```

The retirement guard checks the listener id, entrypoint filename, and lock name across registry,
supervisor, inventory, escalation, and message surfaces. Its self-test exercises every retired
child across every binding surface.

## Recovery

For supervisor lifecycle or AO-session recovery, use
[`orchestrator-recovery-runbook.md`](orchestrator-recovery-runbook.md). For the living roster and
per-child verification paths, use
[`wake-supervisor-fleet-operator-reference.md`](wake-supervisor-fleet-operator-reference.md).
