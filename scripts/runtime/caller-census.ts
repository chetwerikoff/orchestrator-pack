export const RUNTIME_CALLER_KINDS = [
  'runtime-port',
  'non-runtime-ao-service',
] as const;
export type RuntimeCallerKind = (typeof RUNTIME_CALLER_KINDS)[number];

export const RUNTIME_CALLER_DISPOSITIONS = [
  'use-runtime-interface',
  'already-runtime-neutral',
  'delete-dead',
  'defer-1250',
] as const;
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

export interface RuntimeCallerCensusRow {
  readonly surface: string;
  readonly operations: readonly string[];
  readonly kind: RuntimeCallerKind;
  readonly disposition: RuntimeCallerDisposition;
  readonly replacementSurface?: string;
  readonly note: string;
}

/** Final #1248 hard-cut census. Keep docs/orca-runtime-caller-census.md in lockstep. */
export const RUNTIME_CALLER_CENSUS: readonly RuntimeCallerCensusRow[] = [
  {
    surface: 'scripts/launch-watch/watch.ts',
    operations: ['readiness', 'list', 'find', 'read', 'liveness'],
    kind: 'runtime-port',
    disposition: 'already-runtime-neutral',
    note: 'Migrated by #1245 and remains a reference observation caller.',
  },
  {
    surface: 'scripts/worker-smoke-run.ts',
    operations: ['readiness', 'spawn', 'send', 'read', 'liveness', 'stop'],
    kind: 'runtime-port',
    disposition: 'use-runtime-interface',
    note: 'Uses the selected RuntimeAdapter with composite identity and one dispatch attempt.',
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
    surface: 'scripts/invoke-gated-worker-nudge.ts',
    operations: ['find', 'send'],
    kind: 'runtime-port',
    disposition: 'use-runtime-interface',
    note: 'Issue/PR keyed claim and journal admission precede one RuntimeAdapter dispatch.',
  },
  {
    surface: 'scripts/lib/pack-review-worker-notification.ts',
    operations: ['find', 'send'],
    kind: 'runtime-port',
    disposition: 'use-runtime-interface',
    note: 'Resolves exact runtime generation and preserves dispatched | send_failed | dispatch_unknown.',
  },
  {
    surface: 'scripts/pack-review-worker-notification.cases.ts',
    operations: ['find', 'send'],
    kind: 'runtime-port',
    disposition: 'already-runtime-neutral',
    note: 'Focused review-delivery coverage exercises exact runtime lookup and one closed dispatch attempt.',
  },
  {
    surface: 'scripts/invoke-worker-recovery.ts',
    operations: ['list', 'find', 'liveness', 'workspace-remove', 'spawn'],
    kind: 'runtime-port',
    disposition: 'use-runtime-interface',
    note: 'One pack claim spans head-bound cleanup and a distinct spawn selector.',
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
    note: 'Uses TypeScript process-generation lease and pure crash-backoff transitions without AO health authority.',
  },
  {
    surface: 'scripts/runtime/side-effect-fence.ts',
    operations: ['side-effect-fence'],
    kind: 'runtime-port',
    disposition: 'already-runtime-neutral',
    note: 'Stable kernel-held lock serializes stale replacement and exact owner release.',
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
    surface: 'scripts/lib/worker-smoke-bounded-create.ts',
    operations: ['spawn'],
    kind: 'runtime-port',
    disposition: 'delete-dead',
    replacementSurface: 'scripts/worker-smoke-run.ts + RuntimeAdapter.spawnWorker',
    note: 'Deleted direct Orca creation seam.',
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
    note: 'Deleted AO send wrapper; TypeScript journal records the closed dispatch outcome.',
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
    note: 'Deleted mixed AO/runtime PowerShell recovery implementation.',
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
    note: 'AO-status-driven degraded bridge deleted; rearm now requires an explicit healthy replacement witness.',
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
    surface: 'scripts/lib/Invoke-AoReviewApi.ps1',
    operations: ['review-trigger', 'review-list', 'report'],
    kind: 'non-runtime-ao-service',
    disposition: 'defer-1250',
    note: 'Review service API is not worker/terminal lifecycle and remains outside RuntimeAdapter.',
  },
  {
    surface: 'scripts/pack-review-runner.ts',
    operations: ['review-trigger', 'review-list'],
    kind: 'non-runtime-ao-service',
    disposition: 'defer-1250',
    note: 'Scripted review service transport remains #1250 work.',
  },
  {
    surface: 'scripts/lib/Invoke-AoCliJson.ps1 (config/status/plugin/daemon operations)',
    operations: ['config', 'status', 'plugin-hooks', 'daemon-lifecycle'],
    kind: 'non-runtime-ao-service',
    disposition: 'defer-1250',
    note: 'Only genuinely non-runtime service and operator-daemon usage remains #1250 work.',
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
    if (row.kind === 'non-runtime-ao-service' && row.disposition !== 'defer-1250') {
      errors.push(`service_not_deferred:${row.surface}`);
    }
    if (row.kind === 'runtime-port' && row.disposition === 'defer-1250') {
      errors.push(`runtime_port_deferred:${row.surface}`);
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
