import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import * as base from './worker-smoke-lifecycle-base.ts';
import {
  buildSmokeCloseSettlementIdentity,
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

export interface SmokeLifecycleCleanliness extends base.SmokeLifecycleCleanliness {
  allowed?: false;
  blockingScope?: 'worker_smoke_only';
  workerMayContinue?: true;
}

export type HistoricalSmokeReconciliation =
  | { state: 'not_applicable' }
  | { state: 'blocked'; reason: string }
  | { state: 'reconciled'; registry: base.SmokeLifecycleRegistry };

export interface SmokeReconciliationWriteOptions {
  writeTerminalRecord?: (path: string, value: unknown) => void;
  writeLifecycleRegistry?: (path: string, value: unknown) => void;
}

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

function scopeCleanliness(
  cleanliness: base.SmokeLifecycleCleanliness,
): SmokeLifecycleCleanliness {
  return cleanliness.clean
    ? cleanliness
    : {
      ...cleanliness,
      allowed: false,
      blockingScope: 'worker_smoke_only',
      workerMayContinue: true,
    };
}

function closeWithReceipt(input: {
  artifactDir: string;
  runId: string;
  terminalHandle: string;
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

  const settlement = buildSmokeCloseSettlementIdentity(registry.runId);
  const settlementAtMs = registry.closeAttemptedAtMs;
  try {
    writeAtomicJson(smokeCloseReceiptPath(input.artifactDir), {
      version: 2,
      phase: 'settlement_recorded',
      runId: registry.runId,
      terminalHandle: registry.terminalHandle,
      headSha: registry.headSha,
      artifactDir: resolve(registry.artifactDir),
      settlementId: settlement.settlementId,
      settlementReason: settlement.settlementReason,
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
    settlementId: settlement.settlementId,
    settlementReason: settlement.settlementReason,
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

type TerminalReconciliation = {
  kind: string;
  priorReason: string;
  priorCloseOutcome: string;
  settlementId: string;
  settlementReason: string;
  acceptedReceiptOutcome: string;
  reconciledAtMs: number;
};

type TerminalCleanupRecord = {
  version: 1;
  runId: string;
  reason: string;
  cooperativeAcknowledgementObserved: boolean;
  closeOutcome: string;
  operatorFilesCleared: boolean;
  cleanupClean: boolean;
  completedAtMs: number;
  reconciliation?: TerminalReconciliation;
};

function readTerminalCleanupRecord(artifactDir: string): TerminalCleanupRecord | undefined {
  try {
    const value = JSON.parse(
      readFileSync(base.smokeTerminalRecordPath(artifactDir), 'utf8'),
    ) as Record<string, unknown>;
    if (
      Number(value.version) !== 1
      || typeof value.runId !== 'string'
      || typeof value.reason !== 'string'
      || typeof value.cooperativeAcknowledgementObserved !== 'boolean'
      || typeof value.closeOutcome !== 'string'
      || typeof value.operatorFilesCleared !== 'boolean'
      || typeof value.cleanupClean !== 'boolean'
      || !Number.isFinite(Number(value.completedAtMs))
    ) return undefined;
    let reconciliation: TerminalReconciliation | undefined;
    if (value.reconciliation !== undefined) {
      if (!value.reconciliation || typeof value.reconciliation !== 'object' || Array.isArray(value.reconciliation)) {
        return undefined;
      }
      const raw = value.reconciliation as Record<string, unknown>;
      if (
        typeof raw.kind !== 'string'
        || typeof raw.priorReason !== 'string'
        || typeof raw.priorCloseOutcome !== 'string'
        || typeof raw.settlementId !== 'string'
        || typeof raw.settlementReason !== 'string'
        || typeof raw.acceptedReceiptOutcome !== 'string'
        || !Number.isFinite(Number(raw.reconciledAtMs))
      ) return undefined;
      reconciliation = {
        kind: raw.kind,
        priorReason: raw.priorReason,
        priorCloseOutcome: raw.priorCloseOutcome,
        settlementId: raw.settlementId,
        settlementReason: raw.settlementReason,
        acceptedReceiptOutcome: raw.acceptedReceiptOutcome,
        reconciledAtMs: Number(raw.reconciledAtMs),
      };
    }
    return {
      version: 1,
      runId: value.runId.trim(),
      reason: value.reason.trim(),
      cooperativeAcknowledgementObserved: value.cooperativeAcknowledgementObserved,
      closeOutcome: value.closeOutcome.trim(),
      operatorFilesCleared: value.operatorFilesCleared,
      cleanupClean: value.cleanupClean,
      completedAtMs: Number(value.completedAtMs),
      ...(reconciliation ? { reconciliation } : {}),
    };
  } catch {
    return undefined;
  }
}

function sourceHistoricalTerminalMatches(
  record: TerminalCleanupRecord,
  registry: base.SmokeLifecycleRegistry,
): boolean {
  return Boolean(registry.cleanup)
    && record.runId === registry.runId
    && record.reason === registry.cleanup!.reason
    && record.closeOutcome === registry.cleanup!.closeOutcome
    && record.operatorFilesCleared === registry.cleanup!.operatorFilesCleared
    && !record.cleanupClean
    && record.completedAtMs === registry.cleanup!.completedAtMs
    && record.reconciliation === undefined;
}

function targetReconciliationTerminalMatches(input: {
  record: TerminalCleanupRecord;
  registry: base.SmokeLifecycleRegistry;
  kind: 'receipt_first_pending_cleanup' | 'receipt_first_historical_cleanup';
  priorReason: string;
  priorCloseOutcome: string;
  settlementId: string;
  settlementReason: string;
  closeOutcome: string;
}): boolean {
  const reconciliation = input.record.reconciliation;
  return input.record.runId === input.registry.runId
    && input.record.reason === `${input.kind}:${input.priorCloseOutcome}`
    && input.record.closeOutcome === input.closeOutcome
    && input.record.operatorFilesCleared
    && input.record.cleanupClean
    && Boolean(reconciliation)
    && reconciliation!.kind === input.kind
    && reconciliation!.priorReason === input.priorReason
    && reconciliation!.priorCloseOutcome === input.priorCloseOutcome
    && reconciliation!.settlementId === input.settlementId
    && reconciliation!.settlementReason === input.settlementReason
    && reconciliation!.acceptedReceiptOutcome === input.closeOutcome
    && reconciliation!.reconciledAtMs === input.record.completedAtMs;
}

function writeReconciliationTerminal(input: {
  artifactDir: string;
  registry: base.SmokeLifecycleRegistry;
  kind: 'receipt_first_pending_cleanup' | 'receipt_first_historical_cleanup';
  priorReason: string;
  priorCloseOutcome: string;
  settlementId: string;
  settlementReason: string;
  closeOutcome: string;
  cooperativeAcknowledgementObserved: boolean;
  completedAtMs: number;
  writer: (path: string, value: unknown) => void;
}): void {
  const reason = `${input.kind}:${input.priorCloseOutcome}`;
  input.writer(base.smokeTerminalRecordPath(input.artifactDir), {
    version: 1,
    runId: input.registry.runId,
    reason,
    cooperativeAcknowledgementObserved: input.cooperativeAcknowledgementObserved,
    closeOutcome: input.closeOutcome,
    operatorFilesCleared: true,
    cleanupClean: true,
    completedAtMs: input.completedAtMs,
    reconciliation: {
      kind: input.kind,
      priorReason: input.priorReason,
      priorCloseOutcome: input.priorCloseOutcome,
      settlementId: input.settlementId,
      settlementReason: input.settlementReason,
      acceptedReceiptOutcome: input.closeOutcome,
      reconciledAtMs: input.completedAtMs,
    },
  });
}

function writeReconciledLifecycle(input: {
  artifactDir: string;
  registry: base.SmokeLifecycleRegistry;
  reason: string;
  closeOutcome: string;
  cooperativeAcknowledgementObserved: boolean;
  completedAtMs: number;
  writer: (path: string, value: unknown) => void;
}): void {
  input.writer(base.smokeLifecycleRegistryPath(input.artifactDir), {
    ...input.registry,
    spawnState: 'clean',
    updatedAtMs: input.completedAtMs,
    cleanup: {
      reason: input.reason,
      cooperativeAcknowledgementObserved: input.cooperativeAcknowledgementObserved,
      closeOutcome: input.closeOutcome,
      operatorFilesCleared: true,
      completedAtMs: input.completedAtMs,
    },
  });
}

function validateReconciliationReadback(
  artifactDir: string,
  runId: string,
  reason: string,
  closeOutcome: string,
): HistoricalSmokeReconciliation {
  const reread = base.readSmokeLifecycleRegistry(artifactDir);
  if (
    !reread
    || reread.runId !== runId
    || reread.spawnState !== 'clean'
    || reread.cleanup?.reason !== reason
    || reread.cleanup.closeOutcome !== closeOutcome
    || !reread.cleanup.operatorFilesCleared
  ) {
    return {
      state: 'blocked',
      reason: `cleanup_reconciliation_readback_failed:${runId}`,
    };
  }
  return { state: 'reconciled', registry: reread };
}

export function reconcilePendingSmokeLifecycle(
  artifactDir: string,
  nowMs = Date.now(),
  writes: SmokeReconciliationWriteOptions = {},
): HistoricalSmokeReconciliation {
  const registry = base.readSmokeLifecycleRegistry(artifactDir);
  if (!registry || registry.spawnState !== 'cleanup_pending') {
    return { state: 'not_applicable' };
  }
  const receipt = readCloseReceipt(artifactDir, registry);
  if (receipt.state !== 'closed') {
    return {
      state: 'blocked',
      reason: `pending_cleanup_receipt_${receipt.state}:${registry.runId}`,
    };
  }
  const terminalExists = existsSync(base.smokeTerminalRecordPath(artifactDir));
  const terminal = terminalExists ? readTerminalCleanupRecord(artifactDir) : undefined;
  if (terminalExists && !terminal) {
    return {
      state: 'blocked',
      reason: `pending_cleanup_terminal_conflict:${registry.runId}`,
    };
  }
  const kind = 'receipt_first_pending_cleanup' as const;
  const priorReason = 'cleanup_pending';
  const priorCloseOutcome = 'closed_receipt_before_finalization';
  const targetAlreadyWritten = Boolean(terminal) && targetReconciliationTerminalMatches({
    record: terminal!,
    registry,
    kind,
    priorReason,
    priorCloseOutcome,
    settlementId: receipt.receipt.settlementId,
    settlementReason: receipt.receipt.settlementReason,
    closeOutcome: receipt.receipt.closeOutcome,
  });
  const baseCleanTerminal = Boolean(terminal)
    && terminal!.runId === registry.runId
    && terminal!.cleanupClean
    && terminal!.operatorFilesCleared
    && terminal!.closeOutcome === receipt.receipt.closeOutcome
    && terminal!.completedAtMs >= receipt.receipt.recordedAtMs
    && terminal!.reconciliation === undefined;
  if (terminal && !targetAlreadyWritten && !baseCleanTerminal) {
    return {
      state: 'blocked',
      reason: `pending_cleanup_terminal_conflict:${registry.runId}`,
    };
  }

  const operator = base.tombstoneSmokeOperatorFiles(artifactDir, nowMs);
  if (!operator.cleared) {
    return {
      state: 'blocked',
      reason: `pending_cleanup_operator_files_uncleared:${registry.runId}`,
    };
  }
  const completedAtMs = targetAlreadyWritten || baseCleanTerminal
    ? terminal!.completedAtMs
    : nowMs;
  const acknowledged = terminal?.cooperativeAcknowledgementObserved ?? false;
  const reason = `${kind}:${priorCloseOutcome}`;
  try {
    if (!targetAlreadyWritten) {
      writeReconciliationTerminal({
        artifactDir,
        registry,
        kind,
        priorReason,
        priorCloseOutcome,
        settlementId: receipt.receipt.settlementId,
        settlementReason: receipt.receipt.settlementReason,
        closeOutcome: receipt.receipt.closeOutcome,
        cooperativeAcknowledgementObserved: acknowledged,
        completedAtMs,
        writer: writes.writeTerminalRecord ?? writeAtomicJson,
      });
    }
    writeReconciledLifecycle({
      artifactDir,
      registry,
      reason,
      closeOutcome: receipt.receipt.closeOutcome,
      cooperativeAcknowledgementObserved: acknowledged,
      completedAtMs,
      writer: writes.writeLifecycleRegistry ?? writeAtomicJson,
    });
  } catch {
    return {
      state: 'blocked',
      reason: `pending_cleanup_reconciliation_write_failed:${registry.runId}`,
    };
  }
  return validateReconciliationReadback(
    artifactDir,
    registry.runId,
    reason,
    receipt.receipt.closeOutcome,
  );
}

export function reconcileHistoricalSmokeLifecycle(
  artifactDir: string,
  nowMs = Date.now(),
  writes: SmokeReconciliationWriteOptions = {},
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
  const terminal = readTerminalCleanupRecord(artifactDir);
  if (!terminal) {
    return {
      state: 'blocked',
      reason: `historical_cleanup_terminal_conflict:${registry.runId}`,
    };
  }
  const kind = 'receipt_first_historical_cleanup' as const;
  const reason = `${kind}:${staleOutcome}`;
  const targetAlreadyWritten = targetReconciliationTerminalMatches({
    record: terminal,
    registry,
    kind,
    priorReason: cleanup.reason,
    priorCloseOutcome: staleOutcome,
    settlementId: receipt.receipt.settlementId,
    settlementReason: receipt.receipt.settlementReason,
    closeOutcome: receipt.receipt.closeOutcome,
  });
  if (!targetAlreadyWritten && !sourceHistoricalTerminalMatches(terminal, registry)) {
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
  const completedAtMs = targetAlreadyWritten ? terminal.completedAtMs : nowMs;
  try {
    if (!targetAlreadyWritten) {
      writeReconciliationTerminal({
        artifactDir,
        registry,
        kind,
        priorReason: cleanup.reason,
        priorCloseOutcome: staleOutcome,
        settlementId: receipt.receipt.settlementId,
        settlementReason: receipt.receipt.settlementReason,
        closeOutcome: receipt.receipt.closeOutcome,
        cooperativeAcknowledgementObserved: cleanup.cooperativeAcknowledgementObserved,
        completedAtMs,
        writer: writes.writeTerminalRecord ?? writeAtomicJson,
      });
    }
    writeReconciledLifecycle({
      artifactDir,
      registry,
      reason,
      closeOutcome: receipt.receipt.closeOutcome,
      cooperativeAcknowledgementObserved: cleanup.cooperativeAcknowledgementObserved,
      completedAtMs,
      writer: writes.writeLifecycleRegistry ?? writeAtomicJson,
    });
  } catch {
    return {
      state: 'blocked',
      reason: `historical_cleanup_reconciliation_write_failed:${registry.runId}`,
    };
  }
  return validateReconciliationReadback(
    artifactDir,
    registry.runId,
    reason,
    receipt.receipt.closeOutcome,
  );
}

function reconcileHistoricalDirectories(
  repoRoot: string,
  nowMs = Date.now(),
): { reasons: string[]; diagnostics: string[]; blockingRunIds: string[] } {
  const directories = runDirectories(repoRoot);
  if (!directories) {
    return {
      reasons: ['lifecycle_root_unreadable'],
      diagnostics: [],
      blockingRunIds: [],
    };
  }
  const reasons: string[] = [];
  const diagnostics: string[] = [];
  const blockingRunIds: string[] = [];
  for (const artifactDir of directories) {
    const registry = base.readSmokeLifecycleRegistry(artifactDir);
    const result = registry?.spawnState === 'cleanup_pending'
      ? reconcilePendingSmokeLifecycle(artifactDir, nowMs)
      : reconcileHistoricalSmokeLifecycle(artifactDir, nowMs);
    if (result.state === 'blocked') {
      reasons.push(result.reason);
      if (registry && !blockingRunIds.includes(registry.runId)) blockingRunIds.push(registry.runId);
    }
    if (result.state === 'reconciled') {
      diagnostics.push(`reconciled_cleanup:${result.registry.runId}`);
    }
  }
  return { reasons, diagnostics, blockingRunIds };
}

export function evaluateSmokeLifecycleCleanliness(
  repoRoot: string,
): SmokeLifecycleCleanliness {
  const reconciliation = reconcileHistoricalDirectories(repoRoot);
  const evaluated = base.evaluateSmokeLifecycleCleanliness(repoRoot);
  const reasons = [...reconciliation.reasons, ...evaluated.reasons];
  const blockingRunIds = [
    ...reconciliation.blockingRunIds,
    ...evaluated.blockingRunIds,
  ];
  const directories = runDirectories(repoRoot);
  if (!directories) return scopeCleanliness(evaluated);

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
  return scopeCleanliness({
    clean: reasons.length === 0,
    reasons: [...new Set(reasons)],
    blockingRunIds: [...new Set(blockingRunIds)],
  });
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
    if (registry.spawnState === 'cleanup_pending') {
      const reconciliation = reconcilePendingSmokeLifecycle(artifactDir, input.nowMs);
      if (reconciliation.state === 'reconciled') {
        registry = reconciliation.registry;
      } else {
        return smokeOnlyRefusal(
          reconciliation.state === 'blocked'
            ? reconciliation.reason
            : `blocking_lifecycle:${registry.runId}:cleanup_pending`,
        );
      }
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
  const now = input.now ?? (() => Date.now());
  const nowMs = input.nowMs ?? now();
  const admission = base.preflightSmokeLifecycle({
    ...input,
    nowMs,
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
        nowMs,
        closeBoundHandle: input.closeBoundHandle,
      });
    },
  });
  return admission.admitted
    ? admission
    : smokeOnlyRefusal(admission.reason ?? 'lifecycle_preflight_refused', admission.diagnostics);
}

function cleanupResultFromRegistry(
  registry: base.SmokeLifecycleRegistry,
  fallbackReason: string,
): base.SmokeCleanupResult {
  return {
    clean: registry.spawnState === 'clean',
    cooperativeAcknowledgementObserved:
      registry.cleanup?.cooperativeAcknowledgementObserved ?? false,
    closeOutcome: registry.cleanup?.closeOutcome ?? 'close_receipt_unproven',
    operatorFilesCleared: registry.cleanup?.operatorFilesCleared ?? false,
    reason: registry.cleanup?.reason ?? fallbackReason,
  };
}

type SmokeCleanupInvocationInput = Parameters<typeof base.cleanupSmokeLifecycle>[0] & {
  now?: () => number;
};

export function cleanupSmokeLifecycle(
  input: SmokeCleanupInvocationInput,
): base.SmokeCleanupResult {
  const { now, ...baseInput } = input;
  const nowMs = input.nowMs ?? now?.() ?? Date.now();
  const current = base.readSmokeLifecycleRegistry(input.artifactDir);
  if (current?.spawnState === 'cleanup_pending') {
    const reconciliation = reconcilePendingSmokeLifecycle(input.artifactDir, nowMs);
    if (reconciliation.state === 'reconciled') {
      return cleanupResultFromRegistry(reconciliation.registry, input.reason);
    }
    return {
      clean: false,
      cooperativeAcknowledgementObserved: input.cooperativeAcknowledgementObserved,
      closeOutcome: reconciliation.state === 'blocked'
        ? reconciliation.reason
        : 'cleanup_attempt_already_settled',
      operatorFilesCleared: false,
      reason: input.reason,
    };
  }
  if (current?.spawnState === 'cleanup_failed') {
    const reconciliation = reconcileHistoricalSmokeLifecycle(input.artifactDir, nowMs);
    if (reconciliation.state === 'reconciled') {
      return cleanupResultFromRegistry(reconciliation.registry, input.reason);
    }
    return cleanupResultFromRegistry(current, input.reason);
  }
  const result = base.cleanupSmokeLifecycle({
    ...baseInput,
    nowMs,
    closeBoundHandle: (handle) => closeWithReceipt({
      artifactDir: input.artifactDir,
      runId: input.runId,
      terminalHandle: handle,
      nowMs,
      closeBoundHandle: (ownedHandle) => input.closeBoundHandle(ownedHandle),
    }),
  });
  if (result.clean && !hasValidSmokeCloseReceipt(input.artifactDir)) {
    return { ...result, clean: false, closeOutcome: 'close_receipt_unproven' };
  }
  return result;
}
