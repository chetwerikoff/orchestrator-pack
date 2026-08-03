# Orca runtime caller census (#1248)

Source revision: `#1248-hard-cut-r2`, 2026-08-03. Machine-readable authority: `scripts/runtime/caller-census.ts`.

## Classification rule

A call belongs on `RuntimeAdapter` when it controls or observes worker/runtime lifecycle: readiness, workspace selection, spawn, input dispatch, bounded output, liveness, stop, workspace removal, or recovery. AO review triggering, review reports, config/plugin reads, and operator daemon lifecycle are service operations and remain #1250 work.

Compatibility with AO-era callers, PowerShell bridges, old result envelopes, and fixture-only identities is not preserved. Active runtime rows finish as `use-runtime-interface` or `already-runtime-neutral`; replaced files finish as `delete-dead`.

## Active runtime surfaces

| Surface | Operations | Disposition | Result |
|---|---|---|---|
| `scripts/launch-watch/watch.ts` | readiness, list/find, read, liveness | `already-runtime-neutral` | Reference observation caller from #1245. |
| `scripts/worker-smoke-run.ts` | readiness, spawn, send, read, liveness, stop | `use-runtime-interface` | Selected adapter, composite identity, one dispatch attempt, exact-generation stop. |
| `scripts/invoke-gated-worker-nudge.ts` | find, send | `use-runtime-interface` | Issue/PR keyed claim and journal admission before one dispatch. |
| `scripts/lib/pack-review-worker-notification.ts` | find, send | `use-runtime-interface` | Preserves `dispatched | send_failed | dispatch_unknown`; unknown is terminal and never resent. |
| `scripts/invoke-worker-recovery.ts` | list/find, liveness, workspace remove, spawn | `use-runtime-interface` | One claim spans exact cleanup and spawn; cleanup target is not reused as the spawn target. |
| `scripts/runtime/worker-recovery.ts` | list/find, liveness, workspace remove, spawn | `use-runtime-interface` | Reobserves every exact-workspace worker after claim; live or unknown ownership blocks cleanup. |
| `scripts/orchestrator-wake-supervisor.ts` | supervisor startup | `already-runtime-neutral` | Node-only supervisor entrypoint. |
| `scripts/lib/orchestrator-side-process-supervisor.ts` | singleton lease, crash backoff, terminal circuit | `already-runtime-neutral` | Uses TypeScript invariants and launches only the Node scheduler. |
| `scripts/runtime/side-effect-fence.ts` | side-effect fence | `already-runtime-neutral` | Exact owner release and inode-bound stale reclamation. |
| `scripts/runtime/crash-backoff.ts` | crash backoff, degraded rearm | `already-runtime-neutral` | Pure transition; no AO-health authority or retry scheduler. |
| `scripts/runtime/single-instance-lease.ts` | singleton lease | `already-runtime-neutral` | PID + process start ticks + generation ownership. |
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

- Claims are acquired before workspace or terminal side effects.
- Runtime-reported linkage such as Orca `linkedPR` is never claim authority.
- Worker identities are composite `runtime + id + generation`.
- Stop and workspace removal are prevalidated and attempted once.
- `dispatch_unknown` is journaled as uncertain and never automatically resent.
- The same direct lifecycle caller runs with Orca and deterministic adapters without adapter-type branches.
- Canonical side-process topology is Node supervisor → Node `pr2-scheduler`; no PowerShell child remains in the registry.
