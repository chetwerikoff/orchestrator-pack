# Session runtime liveness gate inventory

Canonical runtime-field rule: `docs/session-runtime-liveness.mjs` and
`Test-SessionRuntimeFieldLive` in
`scripts/lib/Get-OrchestratorLaunchHealth.ps1`.

## Live action-producing consumers

| Gate | Side effect | Liveness/readiness source |
| --- | --- | --- |
| `worker-message-dispatch-observe` | observes worker message delivery | shared runtime rule + live worker identity |
| orchestrator launch health | waits for/restores orchestrator runtime | shared runtime rule + orchestrator disqualifiers |
| `ci-green-wake-reconcile` | sends a worker nudge | shared runtime rule + pre-send recheck |
| `review-ready-stuck-guard` | shields false-stuck classification | shared runtime rule + pre-shield recheck |
| `worker-message-submit-reconcile` | submits/reconciles worker input | shared live-session predicate |
| `review-trigger-reconcile` | invokes the pack-owned review runner | live owner + current PR/head + readiness + claim recheck |
| `review-trigger-reeval` | invokes the pack-owned review runner | live owner + deferred-head recheck |
| review-ready report seed | invokes the pack-owned review runner | report/status store + exact-head recheck |
| pack review worker notification | sends journaled verdict notification | linked live worker + classified channel outcome |

## Review-specific rule

Review starters do not call an AO reviewer-session command. After liveness,
readiness, CI, and coverage checks they converge on
`scripts/pack-review-runner.ts` with the shared per-(PR, head) claim.

A missing or non-affirmative runtime signal fails closed for side effects. A worker
notification failure is recorded on the pack run and escalated without erasing the
journaled verdict.

## Removed historical rows

The old bulk review-send reconciler, deleted finding-confirm child, and deleted wake
listener are not live action-producing gates. Historical issue drafts and fixtures
may retain their names, but they are not part of this inventory.
