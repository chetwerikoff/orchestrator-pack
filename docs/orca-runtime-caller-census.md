# Orca runtime caller census (#1248)

Source revision: `#1248-r14`, 2026-08-05. Machine-readable authority: `scripts/runtime/caller-census.ts`.

## Classification rule

A call belongs on `RuntimeAdapter` when it controls or observes worker/runtime lifecycle: readiness, workspace selection, spawn, input dispatch, bounded output, liveness, stop, workspace removal, or recovery. AO review triggering, review reports, config/plugin reads, and operator daemon lifecycle are service operations and remain #1250 work.

Compatibility with AO-era callers, PowerShell bridges, old result envelopes, and fixture-only identities is not preserved. Active runtime rows finish as `use-runtime-interface` or `already-runtime-neutral`; replaced files finish as `delete-dead`. The focused test derives adapter-method callers from tracked production TypeScript files and rejects missing rows or operations.

## Active runtime surfaces

| Surface | Operations | Disposition | Result |
|---|---|---|---|
| `scripts/launch-watch/watch.ts` | readiness, list/find, read, liveness | `already-runtime-neutral` | Reference observation caller from #1245. |
| `scripts/worker-smoke-run.ts` | readiness, spawn, send, read, liveness, stop | `use-runtime-interface` | Selected adapter, composite identity, exactly one dispatch attempt, exact-generation stop. |
| `scripts/runtime/task-lifecycle.ts` | spawn, send, read, liveness, stop | `already-runtime-neutral` | Direct lifecycle caller retains exact spawned identity after ambiguous dispatch and never resends. |
| `scripts/pr2-foundation/fleet-observer.ts` | list/find, read, liveness | `already-runtime-neutral` | Observer-only fleet census through `RuntimeAdapter`; no actuation or compatibility bridge. |
| `scripts/invoke-gated-worker-nudge.ts` | find, send | `use-runtime-interface` | Issue/PR keyed claim and journal admission before one dispatch. |
| `scripts/lib/pack-review-worker-notification.ts` | find, send | `use-runtime-interface` | Preserves `dispatched | send_failed | dispatch_unknown`; unknown is terminal and never resent. |
| `scripts/pack-review-worker-notification.cases.ts` | spawn, find, send | `already-runtime-neutral` | Focused review-delivery coverage exercises exact lookup and one closed dispatch attempt. |
| `scripts/invoke-worker-recovery.ts` | list/find, liveness, workspace remove, spawn | `use-runtime-interface` | One claim spans generation/head-bound cleanup and a distinct spawn selector. |
| `scripts/runtime/worker-recovery.ts` | list/find, liveness, workspace remove, spawn | `use-runtime-interface` | Revalidates exact id + generation + provenance after claim; live, unknown, or mismatched ownership blocks cleanup. |
| `scripts/orchestrator-wake-supervisor.ts` | supervisor startup | `already-runtime-neutral` | Node-only supervisor entrypoint. |
| `scripts/lib/orchestrator-side-process-supervisor.ts` | singleton lease, crash backoff, terminal circuit | `already-runtime-neutral` | Uses TypeScript invariants and launches only the Node scheduler. |
| `scripts/runtime/side-effect-fence.ts` | side-effect fence | `already-runtime-neutral` | Stable kernel-held lock serializes stale replacement and exact owner release. |
| `scripts/runtime/crash-backoff.ts` | crash backoff, degraded rearm | `already-runtime-neutral` | Pure transition; no AO-health authority or retry scheduler. |
| `scripts/runtime/single-instance-lease.ts` | singleton lease | `already-runtime-neutral` | Stable kernel-held lock with PID + process start ticks + generation payload. |
| `scripts/lib/review-start-claim-store.ts` | claim TOCTOU | `already-runtime-neutral` | Sole TypeScript claim lifecycle authority. |
| `scripts/orchestrator-side-process-registry.json` | child selection | `already-runtime-neutral` | Contains only `pr2-scheduler` with Node runtime. |

## Deleted runtime surfaces

| Deleted surface | Replacement |
|---|---|
| `scripts/lib/worker-smoke-bounded-create.ts` | `worker-smoke-run.ts` through `RuntimeAdapter.spawnWorker` |
| `scripts/invoke-gated-worker-nudge.ps1` | `scripts/invoke-gated-worker-nudge.ts` |
| `scripts/journaled-worker-send.ps1` | `scripts/lib/pack-review-worker-notification.ts` |
| `scripts/invoke-worker-recovery.ps1` | `scripts/invoke-worker-recovery.ts` |
| `scripts/lib/Worker-Recovery.ps1` | `scripts/runtime/worker-recovery.ts` |
| `scripts/lib/Worker-RecoveryClaim.ps1` | `scripts/runtime/worker-recovery-claim.ts` |
| `scripts/lib/Orchestrator-WakeSupervisorLease.ps1` | `scripts/runtime/single-instance-lease.ts` |
| `scripts/lib/Orchestrator-SideEffectFence.ps1` | `scripts/runtime/side-effect-fence.ts` |
| `scripts/lib/Orchestrator-SideProcessCrashBackoff.ps1` | `scripts/runtime/crash-backoff.ts` |
| `scripts/lib/Orchestrator-SideProcessDegradedBackoff.ps1` | `scripts/runtime/crash-backoff.ts` explicit healthy-replacement rearm |
| `scripts/lib/Review-StartClaimLifecycle.ps1` | `scripts/lib/review-start-claim-store.ts` |

The old worker-smoke compatibility/regression seams were also deleted rather than adapted to synthetic generations.

## Non-runtime AO service usage deferred to #1250

| Surface | Operations | Disposition |
|---|---|---|
| `scripts/lib/Invoke-AoReviewApi.ps1` | review trigger/list/report | `defer-1250` |
| `scripts/pack-review-runner.ts` | scripted review service | `defer-1250` |
| `scripts/lib/Invoke-AoCliJson.ps1` service branches | config, status, plugin hooks, operator daemon lifecycle | `defer-1250` |

Those rows do not own worker lifecycle, dispatch, cleanup, recovery claims, supervisor leases, fences, or crash backoff.

## Safety properties

- Claims are acquired before workspace or terminal side effects and stay kernel-locked through settlement.
- Runtime-reported linkage such as Orca `linkedPR` is never claim authority.
- Worker identities are composite `runtime + id + generation`; destructive recovery also requires the expected workspace head.
- Cleanup and spawn selectors must differ before runtime calls or claim acquisition.
- Stop, workspace removal, and dispatch are attempted once; ambiguous transport never creates a retry authority.
- `dispatch_unknown` retains the exact spawned identity for explicit recovery and is never automatically resent.
- Worker-smoke output heuristics are observation-only and cannot trigger a second submit.
- The same direct lifecycle caller runs with Orca and deterministic adapters without adapter-type branches.
- Canonical side-process topology is Node supervisor → Node `pr2-scheduler`; no PowerShell child remains in the registry.
