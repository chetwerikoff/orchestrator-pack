# Orca runtime caller census (#1248)

Source revision: `#1248` as read on 2026-08-03. Machine-readable authority: `scripts/runtime/caller-census.ts`.

## Classification rule

A call belongs on `RuntimeAdapter` only when it controls or observes a worker/terminal lifecycle: readiness, workspace selection for a task, spawn, input dispatch, bounded output, liveness, stop, or worker recovery. AO review triggering, review reports, config/plugin reads, and operator daemon lifecycle are service operations and remain owned by #1250.

## Runtime-port work

| Surface | Operations | Disposition | Current consumer / note |
|---|---|---|---|
| `scripts/launch-watch/watch.ts` | readiness, list/find, read, liveness | `already-runtime-neutral` | Reference caller from #1245. |
| `scripts/worker-smoke-run.ts` | current workspace, spawn, send, read, liveness, stop | `use-runtime-interface` | Stable surface delegates through `scripts/runtime/task-compat.ts`; dispatch keeps the closed three-state outcome and no ambiguous resend. |
| `scripts/lib/worker-smoke-bounded-create.ts` | spawn | `use-runtime-interface` | Existing smoke lifecycle reservation still precedes the adapter side effect. Runtime linkage is never claim authority. |
| `scripts/lib/Worker-Recovery.ps1` | list/find/spawn/recovery | `port-to-ts-here` | Live consumers: `dead-worker-reconcile.ps1`, `invoke-worker-recovery.ps1`. Split review-service calls from lifecycle calls before deletion. |
| `scripts/journaled-worker-send.ps1` | send | `port-to-ts-here` | Preserve `dispatched | send_failed | dispatch_unknown`; ambiguous delivery is terminal for that attempt. |
| `scripts/lib/Orchestrator-WakeSupervisorLease.ps1` | supervisor startup, singleton lease | `port-to-ts-here` | Mandatory runtime-neutral invariant currently consumed by the wake supervisor. |
| `scripts/lib/Orchestrator-SideEffectFence.ps1` | side-effect fence | `port-to-ts-here` | Mandatory invariant used by review wake/reeval and supervised children. |
| `scripts/lib/Orchestrator-SideProcessCrashBackoff.ps1` | crash backoff, degraded rearm | `port-to-ts-here` | Mandatory invariant. AO daemon-health classification inside the file is service usage and must be separated rather than put on `RuntimeAdapter`. |
| `scripts/lib/Review-StartClaimLifecycle.ps1` | claim TOCTOU | `port-to-ts-here` | Mandatory invariant. The TypeScript claim store is already authoritative; the PowerShell bridge is the replacement target. |

## Non-runtime AO service usage deferred to #1250

| Surface | Operations | Disposition |
|---|---|---|
| `scripts/lib/Invoke-AoReviewApi.ps1` | review trigger/list/report | `defer-1250` |
| `scripts/pack-review-runner.ts` | scripted review service | `defer-1250` |
| `scripts/lib/Invoke-AoCliJson.ps1` service branches | config, status, plugin hooks, operator daemon lifecycle | `defer-1250` |

Session/worker operations reached through `Invoke-AoCliJson.ps1` are not covered by that defer row; their owning callers are runtime-port rows above.

## Boundary mechanics in this change

`RuntimeTaskCompatibilityFacade` is caller policy expressed only against `RuntimeAdapter`. The default facade is composed once through `scripts/runtime/registry.ts`. The focused test invokes the same caller function with `OrcaTaskRuntimeAdapter` and `DeterministicRuntimeAdapter` without an adapter-type branch.

The Orca task adapter performs one close attempt only after exact owned `id + generation` revalidation. The current upstream Orca CLI exposes handle-only close; therefore the adapter does not claim atomic compare-and-close. It preserves the existing close transport while refusing external or stale-generation workers and treating ambiguous close transport as a failure with no resend/retry.

## Remaining deletion cut

The four mandatory PowerShell invariant rows and the mixed recovery/send callers remain explicit `port-to-ts-here` work. They are not reclassified as #1250 service work and cannot be deleted by #1250 until TypeScript consumers replace them. This document intentionally makes that unfinished cut visible rather than disguising it as legacy compatibility.
