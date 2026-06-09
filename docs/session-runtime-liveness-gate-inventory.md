# Session runtime liveness gate inventory (Issue #250)

Canonical `runtime` field rule: `docs/session-runtime-liveness.mjs` /
`Test-SessionRuntimeFieldLive` in `scripts/lib/Get-OrchestratorLaunchHealth.ps1`.

| Gate | Location | Side effects | Migration |
|------|----------|--------------|-----------|
| `isRuntimeFieldLive` / `isRuntimeAlive` | `docs/session-runtime-liveness.mjs` | — (shared predicate) | **canonical** |
| `isSessionAlive` | `docs/worker-message-dispatch-observe.mjs` | message submit observation | **migrate** — uses shared runtime rule + `isLiveWorkerSession` |
| `Test-SessionRuntimeFieldLive` | `scripts/lib/Get-OrchestratorLaunchHealth.ps1` | — (shared PS rule) | **canonical** |
| `Test-OrchestratorSessionLaunchHealthy` | `scripts/lib/Get-OrchestratorLaunchHealth.ps1` | orchestrator launch wait | **migrate** — shared runtime rule; orchestrator status disqualifiers unchanged (#91) |
| `review-send-reconcile` | `docs/review-send-reconcile.mjs` | `ao review send` | **migrate** — `isRuntimeAlive` + `preSendRecheck` |
| `ci-green-wake-reconcile` | `docs/ci-green-wake-reconcile.mjs` | `ao send` nudge | **migrate** — `isRuntimeAlive` + `preSendRecheck` |
| `review-ready-stuck-guard` | `docs/review-ready-stuck-guard.mjs` | false-stuck shield / grace | **migrate** — `isRuntimeAlive` + `preShieldRecheck` |
| `worker-message-submit-reconcile` | `docs/worker-message-submit-reconcile.mjs` | draft message submit | **migrate** — via `isSessionAlive` |
| `review-trigger-reconcile` | `docs/review-trigger-reconcile.mjs` | `ao review run` (orchestrator) | **out-of-scope** — uses `isLiveWorkerSession` status set only; no `runtime` field on this path |
| `review-finding-delivery-confirm` | `docs/review-finding-delivery-confirm.mjs` | finding re-delivery | **out-of-scope** — `isLiveWorkerSession` status only |
| `review-wake-trigger` | `docs/review-wake-trigger.mjs` | wake `ao review run` | **out-of-scope** — `isLiveWorkerSession` status only |
| `review-trigger-reeval` | `docs/review-trigger-reeval.mjs` | scoped `ao review run` | **out-of-scope** — `isLiveWorkerSession` status only |

Action-producing gates that read `runtime` all share the missing-vs-present rule and fail
closed on present non-affirmative-live values (including empty string).
