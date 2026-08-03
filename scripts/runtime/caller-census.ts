export const RUNTIME_CALLER_KINDS = [
  'runtime-port',
  'non-runtime-ao-service',
] as const;
export type RuntimeCallerKind = (typeof RUNTIME_CALLER_KINDS)[number];

export const RUNTIME_CALLER_DISPOSITIONS = [
  'use-runtime-interface',
  'already-runtime-neutral',
  'delete-dead',
  'legacy-only',
  'defer-1250',
  'port-to-ts-here',
] as const;
export type RuntimeCallerDisposition = (typeof RUNTIME_CALLER_DISPOSITIONS)[number];

export interface RuntimeCallerCensusRow {
  readonly surface: string;
  readonly operations: readonly string[];
  readonly kind: RuntimeCallerKind;
  readonly disposition: RuntimeCallerDisposition;
  readonly currentConsumer?: string;
  readonly removalOwner?: string;
  readonly note: string;
}

/**
 * Current-main caller census for #1248. Keep this manifest and
 * docs/orca-runtime-caller-census.md in lockstep.
 */
export const RUNTIME_CALLER_CENSUS: readonly RuntimeCallerCensusRow[] = [
  {
    surface: 'scripts/launch-watch/watch.ts',
    operations: ['readiness', 'list', 'find', 'read', 'liveness'],
    kind: 'runtime-port',
    disposition: 'already-runtime-neutral',
    note: 'Migrated by #1245 and remains the reference caller.',
  },
  {
    surface: 'scripts/worker-smoke-run.ts',
    operations: ['workspace-current', 'spawn', 'send', 'read', 'liveness', 'stop'],
    kind: 'runtime-port',
    disposition: 'use-runtime-interface',
    note: 'Stable worker-smoke surface now delegates lifecycle operations to scripts/runtime/task-compat.ts.',
  },
  {
    surface: 'scripts/lib/worker-smoke-bounded-create.ts',
    operations: ['spawn'],
    kind: 'runtime-port',
    disposition: 'use-runtime-interface',
    note: 'The existing lifecycle reservation remains caller-owned; only the terminal side effect moved.',
  },
  {
    surface: 'scripts/lib/Worker-Recovery.ps1',
    operations: ['list', 'find', 'spawn', 'recovery'],
    kind: 'runtime-port',
    disposition: 'port-to-ts-here',
    currentConsumer: 'scripts/dead-worker-reconcile.ps1 and scripts/invoke-worker-recovery.ps1',
    note: 'Mixed AO review-service and runtime lifecycle logic must be split before the PowerShell file is deleted.',
  },
  {
    surface: 'scripts/journaled-worker-send.ps1',
    operations: ['send'],
    kind: 'runtime-port',
    disposition: 'port-to-ts-here',
    currentConsumer: 'worker message dispatch/reconcile paths',
    note: 'Must preserve dispatched | send_failed | dispatch_unknown and never retry ambiguous delivery.',
  },
  {
    surface: 'scripts/lib/Orchestrator-WakeSupervisorLease.ps1',
    operations: ['supervisor-startup', 'single-instance-lease'],
    kind: 'runtime-port',
    disposition: 'port-to-ts-here',
    currentConsumer: 'scripts/lib/Orchestrator-WakeSupervisor.ps1',
    note: 'Mandatory invariant row; AO-era name does not make the lease an AO service.',
  },
  {
    surface: 'scripts/lib/Orchestrator-SideEffectFence.ps1',
    operations: ['side-effect-fence'],
    kind: 'runtime-port',
    disposition: 'port-to-ts-here',
    currentConsumer: 'Invoke-ReviewWakeTrigger.ps1 / Invoke-ReviewTriggerReeval.ps1 and supervisor children',
    note: 'Mandatory invariant row; preserve create-new ownership and stale-owner reclamation semantics.',
  },
  {
    surface: 'scripts/lib/Orchestrator-SideProcessCrashBackoff.ps1',
    operations: ['crash-backoff', 'degraded-rearm'],
    kind: 'runtime-port',
    disposition: 'port-to-ts-here',
    currentConsumer: 'scripts/lib/Orchestrator-WakeSupervisor.ps1',
    note: 'Mandatory invariant row; AO daemon health probing inside the file is service usage and must be separated.',
  },
  {
    surface: 'scripts/lib/Review-StartClaimLifecycle.ps1',
    operations: ['claim-toctou'],
    kind: 'runtime-port',
    disposition: 'port-to-ts-here',
    currentConsumer: 'review-trigger and scripted-review callers',
    note: 'Mandatory invariant row; TypeScript store is already authoritative and the PowerShell bridge is the deletion target.',
  },
  {
    surface: 'scripts/lib/Invoke-AoReviewApi.ps1',
    operations: ['review-trigger', 'review-list', 'report'],
    kind: 'non-runtime-ao-service',
    disposition: 'defer-1250',
    note: 'Review service API is not worker/terminal lifecycle and must not be forced into RuntimeAdapter.',
  },
  {
    surface: 'scripts/pack-review-runner.ts',
    operations: ['review-trigger', 'review-list'],
    kind: 'non-runtime-ao-service',
    disposition: 'defer-1250',
    note: 'Scripted review service transport remains outside the runtime interface.',
  },
  {
    surface: 'scripts/lib/Invoke-AoCliJson.ps1 (config/status/plugin/daemon operations)',
    operations: ['config', 'status', 'plugin-hooks', 'daemon-lifecycle'],
    kind: 'non-runtime-ao-service',
    disposition: 'defer-1250',
    note: 'Only session/worker lifecycle consumers are runtime-port work; service and operator daemon calls remain #1250.',
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
    if (row.disposition === 'legacy-only' && (!row.currentConsumer || !row.removalOwner)) {
      errors.push(`legacy_owner_missing:${row.surface}`);
    }
    if (row.kind === 'non-runtime-ao-service' && row.disposition !== 'defer-1250') {
      errors.push(`service_not_deferred:${row.surface}`);
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
    else if (row.disposition !== 'port-to-ts-here') {
      errors.push(`mandatory_disposition_invalid:${mandatory}:${row.disposition}`);
    }
  }
  return errors;
}
