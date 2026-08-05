import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import * as base from './worker-smoke-lifecycle-base.ts';
import {
  isCleanCloseOutcome,
  readCloseReceipt,
  recordCloseReceipt,
  smokeCloseReceiptPath,
  writeAtomicJson,
} from './worker-smoke-receipt.ts';

export * from './worker-smoke-lifecycle-base.ts';
export { smokeCloseReceiptPath } from './worker-smoke-receipt.ts';

export interface SmokeAdmissionDecision extends base.SmokeAdmissionResult {
  allowed?: false;
  blockingScope?: 'worker_smoke_only';
  workerMayContinue?: true;
}

export type HistoricalSmokeReconciliation =
  | { state: 'not_applicable' }
  | { state: 'blocked'; reason: string }
  | { state: 'reconciled'; registry: base.SmokeLifecycleRegistry };

const blockingState = (registry: base.SmokeLifecycleRegistry): boolean =>
  registry.spawnState !== 'clean' && registry.spawnState !== 'abandoned_unbound';

const acceptedHistoricalStaleOutcomes = new Set([
  'close_failed:terminal_handle_stale',
  'close_failed:channel_stale_handle',
  'close_failed:unproven_channel_stale_handle',
]);

function smokeOnlyRefusal(
  reason: string,
  diagnostics: string[] = [],
): SmokeAdmissionDecision {
  return {
    admitted: false,
    allowed: false,
    blockingScope: 'worker_smoke_only',
    workerMayContinue: true,
    reason,
    diagnostics,
  };
}

function closeWithReceipt(input: {
  artifactDir: string;
  runId: string;
  terminalHandle: string;
  settlementId?: string;
  settlementReason?: string;
  nowMs: number;
  closeBoundHandle: (handle: string, artifactDir: string) => string;
}): string {
  const registry = base.readSmokeLifecycleRegistry(input.artifactDir);
  if (
    !registry
    || registry.runId !== input.runId
    || registry.terminalHandle !== input.terminalHandle
    || registry.closeAttemptedAtMs === undefined
  ) return 'close_failed:registry_unreadable';
  const existing = readCloseReceipt(input.artifactDir, registry);
  if (existing.state === 'closed') return existing.receipt.closeOutcome;
  if (existing.state !== 'missing') return 'close_receipt_invalid';

  const settlementId = input.settlementId ?? `${registry.runId}:post-settlement`;
  const settlementReason = input.settlementReason ?? 'post_settlement_cleanup';
  const settlementAtMs = input.nowMs;
  try {
    writeAtomicJson(smokeCloseReceiptPath(input.artifactDir), {
      version: 2,
      phase: 'settlement_recorded',
      runId: registry.runId,
      terminalHandle: registry.terminalHandle,
      headSha: registry.headSha,
      artifactDir: resolve(registry.artifactDir),
      settlementId,
      settlementReason,
      settlementAtMs,
      closeAttemptedAtMs: registry.closeAttemptedAtMs,
      closeOutcome: '',
      recordedAtMs: settlementAtMs,
    });
  } catch {
    return 'settlement_record_failed';
  }

  const outcome = input.closeBoundHandle(input.terminalHandle, input.artifactDir);
  if (outcome === 'close_failed:channel_stale_handle') {
    return 'close_failed:unproven_channel_stale_handle';
  }
  if (outcome === 'closed_owned_handle_already_absent') {
    return 'close_failed:unproven_already_absent';
  }
  if (!isCleanCloseOutcome(outcome)) return outcome;
  return recordCloseReceipt({
    artifactDir: input.artifactDir,
    registry,
    settlementId,
    settlementReason,
    settlementAtMs,
    closeOutcome: outcome,
    nowMs: input.nowMs,
  })
    ? outcome
    : 'close_receipt_write_failed';
}

export function hasValidSmokeCloseReceipt(artifactDir: string): boolean {
  const registry = base.readSmokeLifecycleRegistry(artifactDir);
  return Boolean(
    registry
    && readCloseReceipt(artifactDir, registry).state === 'closed',
  );
}

function runDirectories(repoRoot: string): string[] | undefined {
  const root = join(repoRoot, base.SMOKE_LIFECYCLE_ROOT);
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch {
    return undefined;
  }
}

function extraRegistrylessEvidence(artifactDir: string): string[] {
  const evidence: string[] = [];
  if (existsSync(base.smokeCancelRequestPath(artifactDir))) evidence.push('cancel_request');
  if (existsSync(base.smokeTerminalRecordPath(artifactDir))) evidence.push('terminal_record');
  if (existsSync(smokeCloseReceiptPath(artifactDir))) evidence.push('close_receipt');
  return evidence;
}

function hasExtraAbandonmentEvidence(artifactDir: string): boolean {
  return extraRegistrylessEvidence(artifactDir).length > 0;
}

export function canAbandonAmbiguousUnbound(
  registry: base.SmokeLifecycleRegistry,
): boolean {
  return base.canAbandonAmbiguousUnbound(registry)
    && !hasExtraAbandonmentEvidence(registry.artifactDir);
}

export function abandonAmbiguousUnbound(
  artifactDir: string,
  nowMs = Date.now(),
): base.SmokeLifecycleRegistry {
  const registry = base.readSmokeLifecycleRegistry(artifactDir);
  if (!registry || !canAbandonAmbiguousUnbound(registry)) {
    throw new Error(`ambiguous reservation is not abandonable: ${registry?.runId ?? artifactDir}`);
  }
  return base.abandonAmbiguousUnbound(artifactDir, nowMs);
}

type TerminalCleanupRecord = {
  version: 1;
  runId: string;
  reason: string;
  closeOutcome: string;
  operatorFilesCleared: boolean;
  cleanupClean: boolean;
  completedAtMs: number;
};

function readHistoricalTerminalCleanup(
  artifactDir: string,
  registry: base.SmokeLifecycleRegistry,
): TerminalCleanupRecord | undefined {
  try {
    const value = JSON.parse(
      readFileSync(base.smokeTerminalRecordPath(artifactDir), 'utf8'),
    ) as Record<string, unknown>;
    const record: TerminalCleanupRecord = {
      version: 1,
      runId: String(value.runId ?? '').trim(),
      reason: String(value.reason ?? '').trim(),
      closeOutcome: String(value.closeOutcome ?? '').trim(),
      operatorFilesCleared: value.operatorFilesCleared === true,
      cleanupClean: value.cleanupClean === true,
      completedAtMs: Number(value.completedAtMs),
    };
    if (
      Number(value.version) !== 1
      || record.runId !== registry.runId
      || !registry.cleanup
      || record.reason !== registry.cleanup.reason
      || record.closeOutcome !== registry.cleanup.closeOutcome
      || record.operatorFilesCleared !== registry.cleanup.operatorFilesCleared
      || record.cleanupClean
      || !Number.isFinite(record.completedAtMs)
      || record.completedAtMs !== registry.cleanup.completedAtMs
    ) return undefined;
    return record;
  } catch {
    return undefined;
  }
}

export function reconcileHistoricalSmokeLifecycle(
  artifactDir: string,
  nowMs = Date.now(),
): HistoricalSmokeReconciliation {
  const registry = base.readSmokeLifecycleRegistry(artifactDir);
  if (!registry || registry.spawnState !== 'cleanup_failed') {
    return { state: 'not_applicable' };
  }
  const cleanup = registry.cleanup;
  const staleOutcome = cleanup?.closeOutcome ?? '';
  if (
    !cleanup
    || cleanup.reason !== 'restart_recovery'
    || !registry.terminalHandle
    || registry.closeAttemptedAtMs === undefined
    || !acceptedHistoricalStaleOutcomes.has(staleOutcome)
  ) {
    return {
      state: 'blocked',
      reason: `unsupported_historical_cleanup:${registry.runId}`,
    };
  }

  const receipt = readCloseReceipt(artifactDir, registry);
  if (receipt.state !== 'closed') {
    return {
      state: 'blocked',
      reason: `historical_cleanup_receipt_${receipt.state}:${registry.runId}`,
    };
  }
  if (
    receipt.receipt.closeOutcome !== 'closed_owned_handle'
    || receipt.receipt.recordedAtMs > cleanup.completedAtMs
  ) {
    return {
      state: 'blocked',
      reason: `historical_cleanup_receipt_conflict:${registry.runId}`,
    };
  }
  const terminal = readHistoricalTerminalCleanup(artifactDir, registry);
  if (!terminal) {
    return {
      state: 'blocked',
      reason: `historical_cleanup_terminal_conflict:${registry.runId}`,
    };
  }

  const operator = base.tombstoneSmokeOperatorFiles(artifactDir, nowMs);
  if (!operator.cleared) {
    return {
      state: 'blocked',
      reason: `historical_cleanup_operator_files_uncleared:${registry.runId}`,
    };
  }

  const reconciliationReason = `restart_recovery_receipt_reconciled:${staleOutcome}`;
  const reconciledCleanup = {
    reason: reconciliationReason,
    cooperativeAcknowledgementObserved: cleanup.cooperativeAcknowledgementObserved,
    closeOutcome: receipt.receipt.closeOutcome,
    operatorFilesCleared: true,
    completedAtMs: nowMs,
  };
  try {
    writeAtomicJson(base.smokeTerminalRecordPath(artifactDir), {
      version: 1,
      runId: registry.runId,
      reason: reconciliationReason,
      cooperativeAcknowledgementObserved: cleanup.cooperativeAcknowledgementObserved,
      closeOutcome: receipt.receipt.closeOutcome,
      operatorFilesCleared: true,
      cleanupClean: true,
      completedAtMs: nowMs,
      reconciliation: {
        kind: 'receipt_first_historical_cleanup',
        priorReason: cleanup.reason,
        priorCloseOutcome: staleOutcome,
        acceptedReceiptOutcome: receipt.receipt.closeOutcome,
        reconciledAtMs: nowMs,
      },
    });
    writeAtomicJson(base.smokeLifecycleRegistryPath(artifactDir), {
      ...registry,
      spawnState: 'clean',
      updatedAtMs: nowMs,
      cleanup: reconciledCleanup,
    });
  } catch {
    return {
      state: 'blocked',
      reason: `historical_cleanup_reconciliation_write_failed:${registry.runId}`,
    };
  }

  const reread = base.readSmokeLifecycleRegistry(artifactDir);
  if (
    !reread
    || reread.spawnState !== 'clean'
    || reread.cleanup?.reason !== reconciliationReason
    || reread.cleanup.closeOutcome !== receipt.receipt.closeOutcome
    || !reread.cleanup.operatorFilesCleared
  ) {
    return {
      state: 'blocked',
      reason: `historical_cleanup_reconciliation_readback_failed:${registry.runId}`,
    };
  }
  return { state: 'reconciled', registry: reread };
}

function reconcileHistoricalDirectories(
  repoRoot: string,
  nowMs = Date.now(),
): { reasons: string[]; diagnostics: string[] } {
  const directories = runDirectories(repoRoot);
  if (!directories) {
    return { reasons: ['lifecycle_root_unreadable'], diagnostics: [] };
  }
  const reasons: string[] = [];
  const diagnostics: string[] = [];
  for (const artifactDir of directories) {
    const result = reconcileHistoricalSmokeLifecycle(artifactDir, nowMs);
    if (result.state === 'blocked') reasons.push(result.reason);
    if (result.state === 'reconciled') {
      diagnostics.push(`reconciled_historical_cleanup:${result.registry.runId}`);
    }
  }
  return { reasons, diagnostics };
}

export function evaluateSmokeLifecycleCleanliness(
  repoRoot: string,
): base.SmokeLifecycleCleanliness {
  const reconciliation = reconcileHistoricalDirectories(repoRoot);
  const evaluated = base.evaluateSmokeLifecycleCleanliness(repoRoot);
  const reasons = [...reconciliation.reasons, ...evaluated.reasons];
  const blockingRunIds = [...evaluated.blockingRunIds];
  const directories = runDirectories(repoRoot);
  if (!directories) return evaluated;

  for (const artifactDir of directories) {
    if (existsSync(base.smokeLifecycleRegistryPath(artifactDir))) {
      const registry = base.readSmokeLifecycleRegistry(artifactDir);
      if (registry?.spawnState === 'clean' && !hasValidSmokeCloseReceipt(artifactDir)) {
        const reason = `unproven_cleanup_receipt:${registry.runId}`;
        if (!reasons.includes(reason)) reasons.push(reason);
        if (!blockingRunIds.includes(registry.runId)) blockingRunIds.push(registry.runId);
      }
      continue;
    }
    const evidence = extraRegistrylessEvidence(artifactDir);
    if (evidence.length === 0) continue;
    const runId = basename(artifactDir);
    const reason = `unregistered_execution_evidence:${runId}:${evidence.join(',')}`;
    if (!reasons.includes(reason)) reasons.push(reason);
    if (!blockingRunIds.includes(runId)) blockingRunIds.push(runId);
  }
  return {
    clean: reasons.length === 0,
    reasons: [...new Set(reasons)],
    blockingRunIds: [...new Set(blockingRunIds)],
  };
}

function preflightSafetyRefusal(
  input: Parameters<typeof base.preflightSmokeLifecycle>[0],
): SmokeAdmissionDecision | undefined {
  const directories = runDirectories(input.repoRoot);
  if (!directories) return smokeOnlyRefusal('lifecycle_root_unreadable');
  const isAlive = input.isProcessAlive ?? ((pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });

  for (const artifactDir of directories) {
    const runId = basename(artifactDir);
    if (runId === input.runId) continue;
    const lifecyclePath = base.smokeLifecycleRegistryPath(artifactDir);
    if (!existsSync(lifecyclePath)) {
      const evidence = extraRegistrylessEvidence(artifactDir);
      if (evidence.length > 0) {
        return smokeOnlyRefusal(
          `unregistered_execution_evidence:${runId}:${evidence.join(',')}`,
        );
      }
      continue;
    }

    let registry = base.readSmokeLifecycleRegistry(artifactDir);
    if (!registry) {
      return smokeOnlyRefusal(`corrupt_lifecycle_state:${runId}`);
    }
    if (registry.spawnState === 'cleanup_failed') {
      const reconciliation = reconcileHistoricalSmokeLifecycle(artifactDir, input.nowMs);
      if (reconciliation.state === 'reconciled') {
        registry = reconciliation.registry;
      } else {
        return smokeOnlyRefusal(
          reconciliation.state === 'blocked'
            ? reconciliation.reason
            : `blocking_lifecycle:${registry.runId}:cleanup_failed`,
        );
      }
    }
    if (
      registry.spawnState === 'cleanup_pending'
      && (registry.closeAttemptedAtMs !== undefined || registry.cleanup?.closeOutcome)
    ) {
      return smokeOnlyRefusal(`cleanup_attempt_already_settled:${registry.runId}`);
    }
    if (blockingState(registry) && isAlive(registry.supervisorPid)) {
      return smokeOnlyRefusal(`active_smoke_supervisor:${registry.runId}`);
    }
    if (registry.spawnState === 'reserved' || registry.spawnState === 'create_in_progress') {
      return smokeOnlyRefusal(
        `blocking_create_phase:${registry.runId}:${registry.spawnState}`,
      );
    }
    if (
      registry.spawnState === 'ambiguous_unbound'
      && hasExtraAbandonmentEvidence(artifactDir)
    ) {
      return smokeOnlyRefusal(
        `blocking_lifecycle:${registry.runId}:ambiguous_unbound`,
      );
    }
  }
  return undefined;
}

export function preflightSmokeLifecycle(
  input: Parameters<typeof base.preflightSmokeLifecycle>[0],
): SmokeAdmissionDecision {
  const refusal = preflightSafetyRefusal(input);
  if (refusal) return refusal;
  const nowMs = input.nowMs ?? Date.now();
  const admission = base.preflightSmokeLifecycle({
    ...input,
    closeBoundHandle: (handle, artifactDir) => {
      const registry = base.readSmokeLifecycleRegistry(artifactDir);
      if (!registry || registry.terminalHandle !== handle) {
        return 'close_failed:registry_unreadable';
      }
      if (
        registry.spawnState === 'cleanup_failed'
        || (registry.spawnState === 'cleanup_pending' && registry.cleanup?.closeOutcome)
      ) {
        return 'cleanup_attempt_already_settled';
      }
      return closeWithReceipt({
        artifactDir,
        runId: registry.runId,
        terminalHandle: handle,
        settlementId: `${registry.runId}:restart-recovery`,
        settlementReason: 'restart_recovery',
        nowMs,
        closeBoundHandle: input.closeBoundHandle,
      });
    },
  });
  return admission.admitted
    ? admission
    : smokeOnlyRefusal(admission.reason ?? 'lifecycle_preflight_refused', admission.diagnostics);
}

export function cleanupSmokeLifecycle(
  input: Parameters<typeof base.cleanupSmokeLifecycle>[0],
): base.SmokeCleanupResult {
  const nowMs = input.nowMs ?? Date.now();
  const current = base.readSmokeLifecycleRegistry(input.artifactDir);
  if (current?.spawnState === 'cleanup_pending' || current?.spawnState === 'cleanup_failed') {
    return {
      clean: false,
      cooperativeAcknowledgementObserved:
        current.cleanup?.cooperativeAcknowledgementObserved
        ?? input.cooperativeAcknowledgementObserved,
      closeOutcome: current.cleanup?.closeOutcome ?? 'cleanup_attempt_already_settled',
      operatorFilesCleared: current.cleanup?.operatorFilesCleared ?? false,
      reason: current.cleanup?.reason ?? input.reason,
    };
  }
  const result = base.cleanupSmokeLifecycle({
    ...input,
    closeBoundHandle: (handle) => closeWithReceipt({
      artifactDir: input.artifactDir,
      runId: input.runId,
      terminalHandle: handle,
      settlementId: `${input.runId}:${input.reason}`,
      settlementReason: input.reason,
      nowMs,
      closeBoundHandle: (ownedHandle) => input.closeBoundHandle(ownedHandle),
    }),
  });
  if (result.clean && !hasValidSmokeCloseReceipt(input.artifactDir)) {
    return { ...result, clean: false, closeOutcome: 'close_receipt_unproven' };
  }
  return result;
}
