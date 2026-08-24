export const RUNTIME_CALLER_KINDS = ['runtime-port'] as const;
export type RuntimeCallerKind = (typeof RUNTIME_CALLER_KINDS)[number];

export const RUNTIME_CALLER_DISPOSITIONS = ['use-runtime-interface', 'already-runtime-neutral', 'delete-dead'] as const;
export type RuntimeCallerDisposition = (typeof RUNTIME_CALLER_DISPOSITIONS)[number];

export const RUNTIME_ADAPTER_METHOD_OPERATIONS = {
  readiness: 'readiness',
  listWorkers: 'list',
  findWorkerById: 'find',
  findWorker: 'find',
  spawnWorker: 'spawn',
  dispatchInput: 'send',
  readBoundedOutput: 'read',
  liveness: 'liveness',
  stopWorker: 'stop',
  removeWorkspace: 'workspace-remove',
} as const;

export interface RuntimeOwnerCallPattern {
  readonly operation: string;
  readonly symbol: string;
  readonly form: 'call' | 'new';
  readonly implementationSurfaces: readonly string[];
}

export const RUNTIME_OWNER_CALL_PATTERNS: readonly RuntimeOwnerCallPattern[] = [
  { operation: 'runtime-composition', symbol: 'selectRuntimeAdapter', form: 'call', implementationSurfaces: ['scripts/runtime/registry.ts'] },
  { operation: 'fleet-observer', symbol: 'FleetObserver', form: 'new', implementationSurfaces: ['scripts/pr2-foundation/fleet-observer.ts'] },
  { operation: 'fleet-observer', symbol: 'createUnavailableFleetObserver', form: 'call', implementationSurfaces: ['scripts/pr2-foundation/fleet-observer.ts'] },
  { operation: 'supervisor-startup', symbol: 'runSupervisor', form: 'call', implementationSurfaces: ['scripts/lib/orchestrator-side-process-supervisor.ts'] },
  { operation: 'recovery', symbol: 'recoverRuntimeWorker', form: 'call', implementationSurfaces: ['scripts/runtime/worker-recovery.ts'] },
  { operation: 'recovery-claim', symbol: 'acquireWorkerRecoveryClaim', form: 'call', implementationSurfaces: ['scripts/runtime/worker-recovery-claim.ts'] },
  { operation: 'recovery-claim', symbol: 'finalizeWorkerRecoveryClaim', form: 'call', implementationSurfaces: ['scripts/runtime/worker-recovery-claim.ts'] },
  { operation: 'recovery-claim', symbol: 'releaseWorkerRecoveryClaim', form: 'call', implementationSurfaces: ['scripts/runtime/worker-recovery-claim.ts'] },
  { operation: 'single-instance-lease', symbol: 'acquireSingleInstanceLease', form: 'call', implementationSurfaces: ['scripts/runtime/single-instance-lease.ts'] },
  { operation: 'single-instance-lease', symbol: 'releaseSingleInstanceLease', form: 'call', implementationSurfaces: ['scripts/runtime/single-instance-lease.ts'] },
  { operation: 'side-effect-fence', symbol: 'acquireSideEffectFence', form: 'call', implementationSurfaces: ['scripts/runtime/side-effect-fence.ts'] },
  { operation: 'side-effect-fence', symbol: 'reclaimStaleSideEffectFence', form: 'call', implementationSurfaces: ['scripts/runtime/side-effect-fence.ts'] },
  { operation: 'side-effect-fence', symbol: 'releaseSideEffectFence', form: 'call', implementationSurfaces: ['scripts/runtime/side-effect-fence.ts'] },
  { operation: 'side-effect-fence', symbol: 'withSideEffectFence', form: 'call', implementationSurfaces: ['scripts/runtime/side-effect-fence.ts'] },
  { operation: 'crash-backoff', symbol: 'crashBackoffPolicyFromEnv', form: 'call', implementationSurfaces: ['scripts/runtime/crash-backoff.ts'] },
  { operation: 'crash-backoff', symbol: 'recordChildExit', form: 'call', implementationSurfaces: ['scripts/runtime/crash-backoff.ts'] },
  { operation: 'crash-backoff', symbol: 'restartDecisionAt', form: 'call', implementationSurfaces: ['scripts/runtime/crash-backoff.ts'] },
  { operation: 'degraded-rearm', symbol: 'rearmTerminalCrashState', form: 'call', implementationSurfaces: ['scripts/runtime/crash-backoff.ts'] },
  { operation: 'claim-toctou', symbol: 'acquireReviewStartClaim', form: 'call', implementationSurfaces: ['scripts/lib/review-start-claim-store.ts', 'scripts/lib/review-start-claim-cli.ts'] },
  { operation: 'claim-toctou', symbol: 'completeAfterRunInvoke', form: 'call', implementationSurfaces: ['scripts/lib/review-start-claim-store.ts', 'scripts/lib/review-start-claim-cli.ts'] },
  { operation: 'claim-toctou', symbol: 'releaseAfterRunFailure', form: 'call', implementationSurfaces: ['scripts/lib/review-start-claim-store.ts', 'scripts/lib/review-start-claim-cli.ts'] },
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function discoverRuntimeOwnerOperations(surface: string, source: string): readonly string[] {
  const operations = new Set<string>();
  for (const pattern of RUNTIME_OWNER_CALL_PATTERNS) {
    if (pattern.implementationSurfaces.includes(surface)) continue;
    const symbol = escapeRegExp(pattern.symbol);
    const expression = pattern.form === 'new'
      ? new RegExp(`\\bnew\\s+${symbol}\\s*\\(`)
      : new RegExp(`\\b${symbol}\\s*\\(`);
    if (expression.test(source)) operations.add(pattern.operation);
  }
  return [...operations].sort();
}

export interface RuntimeCallerCensusRow {
  readonly surface: string;
  readonly operations: readonly string[];
  readonly kind: RuntimeCallerKind;
  readonly disposition: RuntimeCallerDisposition;
  readonly replacementSurface?: string;
  readonly note: string;
}

/** Current runtime caller census. Keep docs/orca-runtime-caller-census.md in lockstep. */
export const RUNTIME_CALLER_CENSUS: readonly RuntimeCallerCensusRow[] = [
  {
    surface: 'scripts/launch-watch/watch.ts',
    operations: ['runtime-composition', 'readiness', 'list', 'find', 'read', 'liveness'],
    kind: 'runtime-port',
    disposition: 'already-runtime-neutral',
    note: 'Migrated by #1245 and remains a reference observation caller.',
  },
  {
    surface: 'scripts/worker-smoke-run.ts',
    operations: ['runtime-composition', 'readiness', 'spawn', 'send', 'read', 'liveness', 'stop', 'find'],
    kind: 'runtime-port',
    disposition: 'use-runtime-interface',
    note: 'Uses the selected RuntimeAdapter with composite identity, one dispatch attempt, and exact post-close presence proof.',
  },
  {
    surface: 'scripts/runtime/task-lifecycle.ts',
    operations: ['spawn', 'send', 'read', 'liveness', 'stop'],
    kind: 'runtime-port',
    disposition: 'already-runtime-neutral',
    note: 'Focused direct lifecycle caller; ambiguous dispatch retains exact spawned identity without resend.',
  },
  {
    surface: 'scripts/pr2-foundation/fleet-observer.ts',
    operations: ['list', 'find', 'read', 'liveness'],
    kind: 'runtime-port',
    disposition: 'already-runtime-neutral',
    note: 'Observer-only runtime-neutral fleet census; no actuation or compatibility bridge.',
  },
  {
    surface: 'scripts/pr2-foundation/fleet-nudge-production.ts',
    operations: ['find', 'send'],
    kind: 'runtime-port',
    disposition: 'already-runtime-neutral',
    note: 'Revalidates the exact current RuntimeWorkerIdentity and performs the single S2 dispatch attempt through RuntimeAdapter.',
  },
  {
    surface: 'scripts/lib/worker-assignment-runtime.ts',
    operations: ['liveness'],
    kind: 'runtime-port',
    disposition: 'already-runtime-neutral',
    note: 'Resolves current logical local ownership through RuntimeAdapter and treats busy/idle liveness as replacement-blocking live evidence.',
  },
  {
    surface: 'scripts/lib/operator-primary-target.ts',
    operations: ['find'],
    kind: 'runtime-port',
    disposition: 'already-runtime-neutral',
    note: 'Issue #1532 resolves an explicit logical operator-primary assignment through RuntimeAdapter, then immediately exact-revalidates the in-memory runtime snapshot before one synchronous caller action.',
  },
  {
    surface: 'scripts/pr2-foundation/remote-worker-assignment.ts',
    operations: ['runtime-composition'],
    kind: 'runtime-port',
    disposition: 'use-runtime-interface',
    note: 'Direct operator remote assignment admission composes RuntimeAdapter only to enforce current-local replacement evidence before logical publication.',
  },
  {
    surface: 'scripts/pr2-foundation/supervised-worker-start.ts',
    operations: ['runtime-composition'],
    kind: 'runtime-port',
    disposition: 'use-runtime-interface',
    note: 'Governed Orca local start composes RuntimeAdapter for current-local replacement admission before ready-receipt assignment publication.',
  },
  {
    surface: 'scripts/pr2-foundation/supervised-task-launch-assistant.ts',
    operations: ['runtime-composition', 'spawn', 'liveness'],
    kind: 'runtime-port',
    disposition: 'use-runtime-interface',
    note: 'Launch composition creates one exact internal RuntimeAdapter worker, proves idle liveness, then delegates successful start to supervised-worker-start.',
  },
  {
    surface: 'scripts/pr2-foundation/scheduler.ts',
    operations: ['runtime-composition', 'fleet-observer', 'list', 'find', 'read', 'liveness'],
    kind: 'runtime-port',
    disposition: 'use-runtime-interface',
    note: 'Production scheduler composes the selected runtime and FleetObserver and is census-checked as an owner surface.',
  },
  {
    surface: 'scripts/invoke-gated-worker-nudge.ts',
    operations: ['find', 'send'],
    kind: 'runtime-port',
    disposition: 'use-runtime-interface',
    note: 'Issue/PR keyed claim and journal admission precede one RuntimeAdapter dispatch.',
  },
  {
    surface: 'scripts/lib/pack-review-worker-notification.ts',
    operations: ['runtime-composition', 'find', 'send', 'side-effect-fence'],
    kind: 'runtime-port',
    disposition: 'use-runtime-interface',
    note: 'Loads persisted exact runtime identity and preserves dispatched | send_failed | dispatch_unknown.',
  },
  {
    surface: 'scripts/pack-review-worker-notification.cases.ts',
    operations: ['spawn', 'find', 'send'],
    kind: 'runtime-port',
    disposition: 'already-runtime-neutral',
    note: 'Focused review-delivery coverage exercises exact runtime lookup and one closed dispatch attempt.',
  },
  {
    surface: 'scripts/invoke-worker-recovery.ts',
    operations: ['runtime-composition', 'recovery', 'recovery-claim', 'workspace-remove', 'spawn'],
    kind: 'runtime-port',
    disposition: 'use-runtime-interface',
    note: 'Loads durable runtimeHandle authority before one claim spans cleanup and a distinct spawn selector.',
  },
  {
    surface: 'scripts/runtime/worker-recovery.ts',
    operations: ['list', 'find', 'liveness', 'workspace-remove', 'spawn'],
    kind: 'runtime-port',
    disposition: 'use-runtime-interface',
    note: 'Revalidates exact id + generation + provenance after claim before head-bound cleanup.',
  },
  {
    surface: 'scripts/orchestrator-wake-supervisor.ts',
    operations: ['supervisor-startup'],
    kind: 'runtime-port',
    disposition: 'already-runtime-neutral',
    note: 'Node supervisor launches only the epoch-gated TypeScript scheduler.',
  },
  {
    surface: 'scripts/lib/orchestrator-side-process-supervisor.ts',
    operations: ['single-instance-lease', 'crash-backoff', 'degraded-terminal'],
    kind: 'runtime-port',
    disposition: 'already-runtime-neutral',
    note: 'Uses TypeScript process-generation lease and pure crash-backoff transitions without retired-runtime health authority.',
  },
  {
    surface: 'scripts/runtime/side-effect-fence.ts',
    operations: ['side-effect-fence'],
    kind: 'runtime-port',
    disposition: 'already-runtime-neutral',
    note: 'Stable kernel-held lock serializes stale replacement and exact process-generation owner release.',
  },
  {
    surface: 'scripts/runtime/crash-backoff.ts',
    operations: ['crash-backoff', 'degraded-rearm'],
    kind: 'runtime-port',
    disposition: 'already-runtime-neutral',
    note: 'Pure transition; explicit healthy replacement is required to rearm a terminal circuit.',
  },
  {
    surface: 'scripts/runtime/single-instance-lease.ts',
    operations: ['single-instance-lease'],
    kind: 'runtime-port',
    disposition: 'already-runtime-neutral',
    note: 'Kernel-held singleton lock with PID, process start ticks, and generation payload.',
  },
  {
    surface: 'scripts/lib/review-start-claim-store.ts',
    operations: ['claim-toctou'],
    kind: 'runtime-port',
    disposition: 'already-runtime-neutral',
    note: 'TypeScript claim store is the sole claim lifecycle authority.',
  },
  {
    surface: 'scripts/orchestrator-side-process-registry.json',
    operations: ['supervisor-child-selection'],
    kind: 'runtime-port',
    disposition: 'already-runtime-neutral',
    note: 'Contains only the Node pr2-scheduler child.',
  },
  {
    surface: 'scripts/cursor-unsent-composer-submit.ts',
    operations: ['runtime-composition', 'list', 'read', 'liveness', 'send'],
    kind: 'runtime-port',
    disposition: 'use-runtime-interface',
    note: 'Lists and reads Cursor terminals through RuntimeAdapter rendered-screen observation, then uses bounded liveness to send the exact idle or busy submitOnly gesture.',
  },
  {
    surface: 'scripts/json-producers/worker-status-report.ts',
    operations: ['runtime-composition', 'list'],
    kind: 'runtime-port',
    disposition: 'use-runtime-interface',
    note: 'Builds the live worker-status report from RuntimeAdapter.listWorkers without retired CLI discovery.',
  },
  {
    surface: 'scripts/lib/operator-publication.ts',
    operations: ['send'],
    kind: 'runtime-port',
    disposition: 'already-runtime-neutral',
    note: 'Publishes one operator-primary message through RuntimeAdapter.dispatchInput and preserves ambiguous delivery.',
  },
  {
    surface: 'scripts/lib/worker-degraded-ci-handoff.ts',
    operations: ['find', 'send'],
    kind: 'runtime-port',
    disposition: 'already-runtime-neutral',
    note: 'Revalidates exact runtime identity before delegating a single runtime-neutral operator publication.',
  },
  {
    surface: 'scripts/runtime/runtime-cli.ts',
    operations: ['runtime-composition', 'readiness', 'list', 'find'],
    kind: 'runtime-port',
    disposition: 'already-runtime-neutral',
    note: 'PowerShell-facing runtime-neutral facade exposes only registered RuntimeAdapter readiness/list/find operations.',
  },
  {
    surface: 'scripts/lib/worker-smoke-bounded-create.ts',
    operations: ['spawn', 'send', 'read', 'liveness', 'stop', 'find'],
    kind: 'runtime-port',
    disposition: 'use-runtime-interface',
    note: 'Current worker-smoke generation establishment support; Issue #1399 owns its exact Orca observation edge while worker-smoke orchestration remains RuntimeAdapter-based.',
  },
  {
    surface: 'scripts/invoke-gated-worker-nudge.ps1',
    operations: ['send'],
    kind: 'runtime-port',
    disposition: 'delete-dead',
    replacementSurface: 'scripts/invoke-gated-worker-nudge.ts',
    note: 'Deleted PowerShell gated-send entrypoint.',
  },
  {
    surface: 'scripts/journaled-worker-send.ps1',
    operations: ['send'],
    kind: 'runtime-port',
    disposition: 'delete-dead',
    replacementSurface: 'scripts/lib/pack-review-worker-notification.ts',
    note: 'Deleted retired-runtime send wrapper; TypeScript journal records the closed dispatch outcome.',
  },
  {
    surface: 'scripts/invoke-worker-recovery.ps1',
    operations: ['recovery'],
    kind: 'runtime-port',
    disposition: 'delete-dead',
    replacementSurface: 'scripts/invoke-worker-recovery.ts',
    note: 'Deleted PowerShell public recovery entrypoint.',
  },
  {
    surface: 'scripts/lib/Worker-Recovery.ps1',
    operations: ['list', 'find', 'spawn', 'workspace-remove'],
    kind: 'runtime-port',
    disposition: 'delete-dead',
    replacementSurface: 'scripts/runtime/worker-recovery.ts',
    note: 'Deleted mixed retired/runtime PowerShell recovery implementation.',
  },
  {
    surface: 'scripts/lib/Worker-RecoveryClaim.ps1',
    operations: ['recovery-claim'],
    kind: 'runtime-port',
    disposition: 'delete-dead',
    replacementSurface: 'scripts/runtime/worker-recovery-claim.ts',
    note: 'Deleted retry-oriented PowerShell claim store.',
  },
  {
    surface: 'scripts/lib/Orchestrator-WakeSupervisorLease.ps1',
    operations: ['single-instance-lease'],
    kind: 'runtime-port',
    disposition: 'delete-dead',
    replacementSurface: 'scripts/runtime/single-instance-lease.ts',
    note: 'Mandatory invariant port completed and PowerShell implementation deleted.',
  },
  {
    surface: 'scripts/lib/Orchestrator-SideEffectFence.ps1',
    operations: ['side-effect-fence'],
    kind: 'runtime-port',
    disposition: 'delete-dead',
    replacementSurface: 'scripts/runtime/side-effect-fence.ts',
    note: 'Mandatory invariant port completed and PowerShell implementation deleted.',
  },
  {
    surface: 'scripts/lib/Orchestrator-SideProcessCrashBackoff.ps1',
    operations: ['crash-backoff'],
    kind: 'runtime-port',
    disposition: 'delete-dead',
    replacementSurface: 'scripts/runtime/crash-backoff.ts',
    note: 'Mandatory invariant port completed and PowerShell implementation deleted.',
  },
  {
    surface: 'scripts/lib/Orchestrator-SideProcessDegradedBackoff.ps1',
    operations: ['degraded-rearm'],
    kind: 'runtime-port',
    disposition: 'delete-dead',
    replacementSurface: 'scripts/runtime/crash-backoff.ts',
    note: 'Retired-status-driven degraded bridge deleted; rearm now requires an explicit healthy replacement witness.',
  },
  {
    surface: 'scripts/lib/Review-StartClaimLifecycle.ps1',
    operations: ['claim-toctou'],
    kind: 'runtime-port',
    disposition: 'delete-dead',
    replacementSurface: 'scripts/lib/review-start-claim-store.ts',
    note: 'Mandatory PowerShell-to-Node bridge deleted.',
  },
  {
    surface: 'scripts/pack-review-runner.ts',
    operations: ['review-trigger', 'review-list', 'claim-toctou'],
    kind: 'runtime-port',
    disposition: 'use-runtime-interface',
    note: 'Owns review start/list/status through the pack runner/store and TypeScript claim authority; no retired review service remains.',
  },
] as const;

export function validateRuntimeCallerCensus(
  rows: readonly RuntimeCallerCensusRow[] = RUNTIME_CALLER_CENSUS,
): readonly string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.surface)) errors.push(`duplicate_surface:${row.surface}`);
    seen.add(row.surface);
    if (row.disposition === 'delete-dead' && !row.replacementSurface) {
      errors.push(`deleted_replacement_missing:${row.surface}`);
    }
  }
  for (const mandatory of [
    'scripts/lib/Orchestrator-WakeSupervisorLease.ps1',
    'scripts/lib/Orchestrator-SideEffectFence.ps1',
    'scripts/lib/Orchestrator-SideProcessCrashBackoff.ps1',
    'scripts/lib/Review-StartClaimLifecycle.ps1',
  ]) {
    const row = rows.find((candidate) => candidate.surface === mandatory);
    if (!row) errors.push(`mandatory_row_missing:${mandatory}`);
    else if (row.disposition !== 'delete-dead' || !row.replacementSurface) {
      errors.push(`mandatory_cut_incomplete:${mandatory}:${row.disposition}`);
    }
  }
  return errors;
}
