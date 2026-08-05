# Orca runtime caller census (#1248)

Source revision: `#1248-r14`, 2026-08-05. Machine-readable authority: `scripts/runtime/caller-census.ts`.

## Classification rule

A call belongs on `RuntimeAdapter` or the runtime-owner census when it controls, composes, or observes worker/runtime lifecycle: runtime selection, fleet observation, readiness, workspace selection, spawn, input dispatch, bounded output, liveness, stop, workspace removal, recovery, recovery claims, review-start claims, supervisor ownership, singleton leases, side-effect fences, or crash backoff. AO review transport, review reports, config/plugin reads, and operator daemon lifecycle remain #1250 service work.

Compatibility with AO-era callers, PowerShell bridges, old result envelopes, and fixture-only identities is not preserved. Active runtime rows finish as `use-runtime-interface` or `already-runtime-neutral`; replaced files finish as `delete-dead`. The focused test derives both direct adapter-method calls and lifecycle-owner calls from tracked production TypeScript files and rejects missing rows or operations.

## Active runtime surfaces

| Surface | Operations | Disposition | Result |
|---|---|---|---|
| `scripts/launch-watch/watch.ts` | readiness, list/find, read, liveness | `already-runtime-neutral` | Reference observation caller from #1245. |
| `scripts/worker-smoke-run.ts` | readiness, spawn, send, read, liveness, stop | `use-runtime-interface` | Selected adapter, composite identity, exactly one dispatch attempt, exact-generation stop. |
| `scripts/runtime/task-lifecycle.ts` | spawn, send, read, liveness, stop | `already-runtime-neutral` | Direct lifecycle caller retains exact spawned identity after ambiguous dispatch and never resends. |
| `scripts/pr2-foundation/fleet-observer.ts` | list/find, read, liveness | `already-runtime-neutral` | Observer-only fleet census through `RuntimeAdapter`; no actuation or compatibility bridge. |
| `scripts/pr2-foundation/scheduler.ts` | runtime composition, fleet observer | `use-runtime-interface` | Production scheduler composes the selected runtime and observer and is included in the repository-derived owner census. |
| `scripts/invoke-gated-worker-nudge.ts` | find, send | `use-runtime-interface` | Issue/PR keyed claim and journal admission before one dispatch. |
| `scripts/lib/pack-review-worker-notification.ts` | runtime composition, find, send, side-effect fence | `use-runtime-interface` | Loads the persisted exact runtime + id + generation binding before normal or resumed delivery; `dispatch_unknown` is terminal and never resent. |
| `scripts/pack-review-worker-notification.cases.ts` | spawn, find, send | `already-runtime-neutral` | Focused review-delivery coverage exercises exact lookup and one closed dispatch attempt. |
| `scripts/invoke-worker-recovery.ts` | runtime composition, recovery, recovery claim, workspace remove, spawn | `use-runtime-interface` | Public entrypoint loads pre-existing pack session `runtimeHandle` authority; flags are comparison inputs and cannot mint cleanup ownership. |
| `scripts/runtime/worker-recovery.ts` | list/find, liveness, workspace remove, spawn | `use-runtime-interface` | Revalidates exact id + generation + provenance after claim; live, unknown, or mismatched ownership blocks cleanup. |
| `scripts/orchestrator-wake-supervisor.ts` | supervisor startup | `already-runtime-neutral` | Node-only supervisor entrypoint. |
| `scripts/lib/orchestrator-side-process-supervisor.ts` | singleton lease, crash backoff, terminal circuit | `already-runtime-neutral` | Uses TypeScript invariants and launches only the Node scheduler. |
| `scripts/runtime/side-effect-fence.ts` | side-effect fence | `already-runtime-neutral` | Stable kernel-held lock serializes stale replacement and binds ownership to PID plus process start ticks, so PID reuse cannot wedge the fence. |
| `scripts/runtime/crash-backoff.ts` | crash backoff, degraded rearm | `already-runtime-neutral` | Pure transition; no AO-health authority or retry scheduler. |
| `scripts/runtime/single-instance-lease.ts` | singleton lease | `already-runtime-neutral` | Stable kernel-held lock with PID + process start ticks + generation payload. |
| `scripts/lib/review-start-claim-store.ts` | claim TOCTOU | `already-runtime-neutral` | Sole TypeScript claim lifecycle authority. |
| `scripts/pack-review-runner.ts` | review trigger/list, claim TOCTOU | `use-runtime-interface` | Owns review-start claim lifecycle through the TypeScript authority; the non-runtime review transport itself remains #1250 work. |
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
| `scripts/lib/Invoke-AoCliJson.ps1` service branches | config, status, plugin hooks, operator daemon lifecycle | `defer-1250` |

The review transport still used by `scripts/pack-review-runner.ts` is #1250 service work, but the runner itself stays in the active runtime-owner census because it owns review-start claim admission and settlement.

## Safety properties

- Claims are acquired before workspace or terminal side effects and stay kernel-locked through settlement.
- Runtime-reported linkage such as Orca `linkedPR` is never claim authority.
- Worker identities are composite `runtime + id + generation`; destructive recovery also requires the expected workspace head.
- Recovery cleanup authority comes from pre-existing pack-owned session metadata and must match every CLI comparison field exactly.
- Review delivery reloads the persisted runtime binding and rejects same-id generation recreation for both normal and resumed delivery.
- Cleanup and spawn selectors must differ before runtime calls or claim acquisition.
- Stop, workspace removal, and dispatch are attempted once; ambiguous transport never creates a retry authority.
- `dispatch_unknown` retains the exact spawned identity for explicit recovery and is never automatically resent.
- Worker-smoke output heuristics are observation-only and cannot trigger a second submit.
- Side-effect fence ownership includes process start ticks, preventing a reused PID from impersonating the prior owner.
- The same direct lifecycle caller runs with Orca and deterministic adapters without adapter-type branches.
- Canonical side-process topology is Node supervisor → Node `pr2-scheduler`; no PowerShell child remains in the registry.
