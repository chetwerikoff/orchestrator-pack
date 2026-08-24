# Orca runtime caller census

Machine-readable authority: `scripts/runtime/caller-census.ts`.

## Classification rule

A call belongs on `RuntimeAdapter` or the runtime-owner census when it controls, composes, or observes worker/runtime lifecycle: runtime selection, fleet observation, readiness, workspace selection, spawn, input dispatch, bounded output, liveness, stop, workspace removal, recovery, recovery claims, review-start claims, supervisor ownership, singleton leases, side-effect fences, or crash backoff.

The #1352 hard cut has no deferred retired-runtime service class. Review start/list/status is owned by the pack review runner/store and TypeScript claim authority; deleted daemon/config transports are not census entries. Active runtime rows finish as `use-runtime-interface` or `already-runtime-neutral`; replaced files finish as `delete-dead`.

Worktree lifecycle remains the deliberate narrower exception documented in `docs/orca-runtime-boundary.md`: Git and Orca inventory reconciliation is owned by `scripts/worktree-lifecycle/**` rather than widening `RuntimeAdapter`. Runtime-specific worktree commands and response parsing stay at that exact edge.

## Active runtime surfaces

| Surface | Operations | Disposition | Result |
|---|---|---|---|
| `scripts/launch-watch/watch.ts` | runtime composition, readiness, list/find, read, liveness | `already-runtime-neutral` | Reference observation caller from #1245. |
| `scripts/worker-smoke-run.ts` | runtime composition, readiness, spawn, send, read, liveness, stop, find | `use-runtime-interface` | Selected adapter, exact composite identity, one delivery path, and exact post-close presence proof. |
| `scripts/lib/worker-smoke-bounded-create.ts` | spawn, send, read, liveness, stop, find | `use-runtime-interface` | Current generation-establishment support; #1399 owns the exact Orca observation edge while worker-smoke orchestration remains RuntimeAdapter-based. |
| `scripts/runtime/task-lifecycle.ts` | spawn, send, read, liveness, stop | `already-runtime-neutral` | Direct lifecycle caller retains exact spawned identity after ambiguous dispatch and never resends. |
| `scripts/pr2-foundation/fleet-observer.ts` | list/find, read, liveness | `already-runtime-neutral` | Observer-only fleet census through `RuntimeAdapter`; no actuation or compatibility bridge. |
| `scripts/pr2-foundation/fleet-nudge-production.ts` | find, send | `already-runtime-neutral` | Revalidates the exact current worker and performs the single S2 dispatch attempt through `RuntimeAdapter`. |
| `scripts/lib/worker-assignment-runtime.ts` | liveness | `already-runtime-neutral` | Resolves current logical local ownership through `RuntimeAdapter`; busy/idle exact targets block replacement, while unresolved evidence never becomes `gone`. |
| `scripts/pr2-foundation/remote-worker-assignment.ts` | runtime composition | `use-runtime-interface` | Direct operator remote admission composes `RuntimeAdapter` only to enforce current-local replacement evidence before logical publication. |
| `scripts/pr2-foundation/supervised-worker-start.ts` | runtime composition | `use-runtime-interface` | Governed Orca local start composes `RuntimeAdapter` for current-local replacement admission before ready-receipt assignment publication. |
| `scripts/pr2-foundation/supervised-task-launch-assistant.ts` | runtime composition, spawn, liveness | `use-runtime-interface` | Creates one exact internal RuntimeAdapter worker, proves idle liveness, then delegates successful start to `supervised-worker-start`. |
| `scripts/pr2-foundation/scheduler.ts` | runtime composition, fleet observer, list/find, read, liveness | `use-runtime-interface` | Production scheduler composes the selected runtime and observer; the census resolves each current assignment to its exact worker across assigned worktrees, while the concurrent composer pass uses a rendered-screen read. |
| `scripts/invoke-gated-worker-nudge.ts` | find, send | `use-runtime-interface` | Issue/PR keyed claim and journal admission before one dispatch. |
| `scripts/lib/pack-review-worker-notification.ts` | runtime composition, find, send, side-effect fence | `use-runtime-interface` | Loads persisted exact runtime identity; ambiguous delivery is terminal. |
| `scripts/pack-review-worker-notification.cases.ts` | spawn, find, send | `already-runtime-neutral` | Focused review-delivery coverage. |
| `scripts/invoke-worker-recovery.ts` | runtime composition, recovery, recovery claim | `use-runtime-interface` | Loads exact current assignment and pre-existing cleanup authority, then delegates fenced cleanup; successor start is operator-required. |
| `scripts/runtime/worker-recovery.ts` | liveness, workspace remove | `use-runtime-interface` | Revalidates exact current assignment/runtime evidence; live targets are no-effect and only affirmatively gone targets may reach bounded cleanup. |
| `scripts/orchestrator-wake-supervisor.ts` | supervisor startup | `already-runtime-neutral` | Node-only supervisor entrypoint. |
| `scripts/lib/orchestrator-side-process-supervisor.ts` | singleton lease, crash backoff, terminal circuit | `already-runtime-neutral` | TypeScript invariants only; launches the Node scheduler. |
| `scripts/runtime/side-effect-fence.ts` | side-effect fence | `already-runtime-neutral` | Kernel-held exact-owner lock. |
| `scripts/runtime/crash-backoff.ts` | crash backoff, degraded rearm | `already-runtime-neutral` | Pure transition; no retired-runtime health authority. |
| `scripts/runtime/single-instance-lease.ts` | singleton lease | `already-runtime-neutral` | PID/start-ticks/generation singleton ownership. |
| `scripts/lib/review-start-claim-store.ts` | claim TOCTOU | `already-runtime-neutral` | Sole TypeScript claim lifecycle authority. |
| `scripts/orchestrator-side-process-registry.json` | child selection | `already-runtime-neutral` | Contains only the Node scheduler child. |
| `scripts/cursor-unsent-composer-submit.ts` | runtime composition, list, read, send | `use-runtime-interface` | One immediate submitOnly dispatch when the Cursor composer contains only exact Orca mailbox-pointer lines; ordinary or mixed typing is never submitted. |
| `scripts/json-producers/worker-status-report.ts` | runtime composition, list | `use-runtime-interface` | Builds live worker status from `RuntimeAdapter.listWorkers`. |
| `scripts/lib/operator-publication.ts` | send | `already-runtime-neutral` | Exact zero-or-one operator publication through `RuntimeAdapter.dispatchInput`. |
| `scripts/lib/worker-degraded-ci-handoff.ts` | find, send | `already-runtime-neutral` | One exact freshness lookup before bounded publication. |
| `scripts/runtime/runtime-cli.ts` | runtime composition, readiness, list, find | `already-runtime-neutral` | PowerShell-facing facade exposes only registered runtime operations. |
| `scripts/pack-review-runner.ts` | review trigger/list, claim TOCTOU | `use-runtime-interface` | Pack runner/store and TypeScript claim authority own review start/list/status; no retired review service remains. |

## Deleted runtime surfaces

| Deleted surface | Replacement |
|---|---|
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

## Safety properties

- Claims are acquired before workspace or terminal side effects and stay kernel-locked through settlement.
- Runtime-reported linkage is never claim authority.
- Worker identities are composite `runtime + id + generation`; destructive recovery also requires the expected workspace head.
- Review delivery reloads the persisted runtime binding and rejects same-id generation recreation.
- Cleanup and successor start are separate authorities: recovery may remove an affirmatively gone target workspace but does not automatically spawn or publish a successor.
- Stop, workspace removal, and dispatch are attempted once; ambiguous transport never creates retry authority.
- Worker-smoke output heuristics are observation-only and cannot trigger a second submit.
- Worker-smoke close settlement verifies the exact runtime identity before reporting lifecycle cleanliness.
- Side-effect fence ownership includes process start ticks, preventing a reused PID from impersonating the prior owner.
- Canonical side-process topology is Node supervisor → Node `pr2-scheduler`; no PowerShell child remains in the registry.
