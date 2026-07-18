# Review-status consumer inventory

Canonical inventory of live pack-owned consumers after the review-runner cutover.
Review operations: [`pack-review-runbook.md`](pack-review-runbook.md).

## Review-run consumers

| Consumer | Role | Review source |
| --- | --- | --- |
| `scripts/review-trigger-reconcile.ps1` | plans uncovered current-head review starts | `Get-AoReviewRuns` pack-store compatibility view |
| `scripts/review-trigger-reeval.ps1` | re-evaluates deferred current heads | pack-store compatibility view |
| `scripts/lib/Invoke-ReviewReadyReportStateSeed.ps1` | seeds missing review starts from report state | pack-store compatibility view |
| `scripts/lib/Get-ClaimedReviewStartSnapshot.ps1` | pre-run claim/readiness snapshot | pack-store compatibility view |
| `scripts/lib/Invoke-ReviewWakeTrigger.ps1` | current event/wake adapter where still reachable | pack-store compatibility view |
| `scripts/ci-green-wake-reconcile.ps1` | wakes pre-handoff workers after CI turns green | pack review coverage + worker status store |
| `scripts/worker-message-submit-reconcile.ps1` | reconciles worker message submit outcomes | dispatch journal, not review daemon state |
| `scripts/dead-worker-reconcile.ps1` | classifies dead worker recovery | worker stores; review coverage from pack store when needed |
| `scripts/orchestrator-diagnose.ps1` | operator diagnostics | pack review store + worker stores + GitHub |
| `scripts/lib/Invoke-AoReviewApi.ps1` | compatibility adapter name | delegates start/list to `pack-review-runner.ts` |
| `scripts/pack-review-runner.ts` | authoritative invocation and operational status entrypoint | pack store + GitHub |
| `scripts/lib/pack-review-run-store.ts` | durable run/verdict/outcome store | local atomic JSON records |

The compatibility names `Get-AoReviewRuns` and `Invoke-AoReviewApi.ps1` do not imply
AO session-review HTTP. Production review decisions must not substitute daemon
review rows.

## Worker readiness consumers

| Consumer | Worker source | Terminated policy |
| --- | --- | --- |
| review reconcile / re-evaluation | `Get-WorkerStatusDecisionSessions` | live owners only |
| report-state seed | `Get-WorkerStatusDecisionSessionsIncludingTerminated` when recovery requires it | explicit terminated-inclusive path |
| CI-green wake | worker report/status stores | live owners only |
| worker-message submit reconcile | worker report/status stores + dispatch journal | live owners only |
| dead-worker reconcile | terminated-inclusive worker status | explicit recovery classification |
| diagnostics | worker status/report stores | prints degraded/unknown evidence |

## Result consumers

Consumers must distinguish:

- reviewer process outcome;
- parsed/journaled `reviewVerdict` and `findings`;
- GitHub COMMENT outcome;
- required-status outcome;
- worker-notification outcome;
- overall operational run status.

No consumer may infer one delivery channel from another. Merge policy reads the
current-head GitHub status `orchestrator-pack/pack-review`, not an old daemon run
column.

## Removed consumers

Historical references to the deleted wake listener, deleted finding-confirm child,
and daemon review producer are not live inventory rows. Closed issue drafts and
captured fixtures may preserve them as history.

## Reader rules

1. Review coverage binds to exact PR number and full target SHA.
2. Corrupt, duplicate, or ambiguous pack-store records fail closed.
3. Worker readiness comes from the pack worker-report/status stores.
4. GitHub is re-read for current PR head, state, mergeability, and required checks.
5. Compatibility adapters may preserve public function names but not retired
   transport behavior.
6. Diagnostics must identify the source path and degraded state rather than silently
   returning an empty result.
