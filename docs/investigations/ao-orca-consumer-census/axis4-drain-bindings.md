# Axis 4 — durable store drain bindings

Inspected revision: `dcda4ed83ffb9027948607860bcdd5276abb2752`

**Unit:** pack store (axis-4 consumer) × canonical AO semantic surface × **drain** class.  
Zero-consumer for surface `S` includes every drain binding whose **canonical AO surface** column equals `S`.

Summary table in [`census.md`](./census.md) §5.4 is derived from this inventory.

| Store (consumer) | Canonical AO surface | Persisted AO identity | Supported readers | Drained condition (summary) | Producer | Observation surface | Provable? |
|---|---|---|---|---|---|---|---|
| `worker-report-store` | `context.worker-handoff` | `sessionId` + PR/repo/head per report | `pack-worker-report`, `show-worker-status-report.ps1` | No reader treats report row as live AO command target | `docs/worker-report-store.mjs` | `node docs/worker-report-store.mjs` stdin JSON CLI | yes |
| `worker-report-store` | `context.session-id` | `sessionId` per report | same | Session field inert for messaging/resume | same | same | yes |
| `pr-session-binding-cache` | `context.session-id` | `sessionId` in bindings | `docs/pr-session-binding-cache.mjs`, review reconcile | Bindings for terminated sessions inert | `docs/pr-session-binding-cache.mjs` | `node docs/pr-session-binding-cache.mjs` contract CLI | yes |
| `worker-status-store` | `context.session-id` | `sessionId` keyed status | `Get-WorkerStatusDecisionSessions`, `show-worker-status-report.ps1` | Status rows for dead sessions ignored | `scripts/show-worker-status-report.ps1` | `scripts/show-worker-status-report.ps1 --json` | yes |
| `worker-message-dispatch-journal` | `send.message` | sender `AO_SESSION_ID` in dispatch records | submit reconcile, `docs/worker-message-dispatch-observe.mjs` | No pending dispatch requiring AO send | `docs/worker-message-dispatch-observe.mjs` | `node docs/worker-message-dispatch-observe.mjs` stdin JSON CLI | yes |
| `review-run-store` | `review.session-list` | `linkedSessionId` on run rows | `pack-review-runner.ts list` | No in-flight runs referencing AO session for action | `scripts/pack-review-runner.ts` | `node --experimental-strip-types scripts/pack-review-runner.ts list` | yes |
| `review-start-claim-namespace` | `review.trigger` | claim-holder session / generation | `review-start-claim-store.ts`, review runner | No active claim blocking review start | `docs/review-start-claim-lifecycle.mjs` | `node docs/review-start-claim-lifecycle.mjs` stdin JSON CLI | yes |
| `worker-nudge-claim-namespace` | `send.message` | nudge claim holder session | `Worker-NudgeClaim.ps1`, nudge gate | No live nudge claim requiring send | `docs/worker-nudge-gate.mjs` | `node docs/worker-nudge-gate.mjs` stdin JSON CLI | yes |
| `mechanical-transport` | `send.message` | target session in transport payload | `journaled-worker-send.ps1`, mechanical reconcile | No unconsumed transport files targeting AO sessions | — | — | **presently unprovable** — owner PR7 |
| `dead-worker-reconcile-state` | `session.lifecycle` | last known worker `sessionId` | `dead-worker-reconcile.ps1` | Reconcile terminal / session respawned | `docs/dead-worker-reconciler.mjs` | `node docs/dead-worker-reconciler.mjs` stdin JSON CLI | yes |
| `orchestrator-escalation-state` | `send.message` | orchestrator `sessionId` in escalation records | `Orchestrator-Escalation.ps1` | No open escalation requiring live orchestrator session | — | — | **presently unprovable** — owner PR7 |
| `review-handoff-wake-admission` | `review.trigger` | `sessionId` in admission audit rows | `Record-ReviewHandoffWakeAdmission.ps1`, review wake filters | No admission row treated as actionable AO session target | `docs/review-handoff-wake-admission.mjs` | `node docs/review-handoff-wake-admission.mjs` contract CLI | yes |

**Binding rows:** 13 (11 stores; `worker-report-store` spans two semantic surfaces)
