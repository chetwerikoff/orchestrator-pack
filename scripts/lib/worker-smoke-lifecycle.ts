import {
  existsSync,
  readdirSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import * as base from './worker-smoke-lifecycle-base.ts';
import {
  isCleanCloseOutcome,
  readCloseReceipt,
  readHistoricalCloseReceipt,
  recordCloseReceipt,
  smokeCloseReceiptPath,
  writeAtomicJson,
} from './worker-smoke-receipt.ts';

export * from './worker-smoke-lifecycle-base.ts';
export { smokeCloseReceiptPath } from './worker-smoke-receipt.ts';

const blockingState = (registry: base.SmokeLifecycleRegistry): boolean =>
  registry.spawnState !== 'clean' && registry.spawnState !== 'abandoned_unbound';

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

export function evaluateSmokeLifecycleCleanliness(
  repoRoot: string,
): base.SmokeLifecycleCleanliness {
  const evaluated = base.evaluateSmokeLifecycleCleanliness(repoRoot);
  const reasons = [...evaluated.reasons];
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
  return { clean: reasons.length === 0, reasons, blockingRunIds };
}

function preflightSafetyRefusal(
  input: Parameters<typeof base.preflightSmokeLifecycle>[0],
): base.SmokeAdmissionResult | undefined {
  const directories = runDirectories(input.repoRoot);
  if (!directories) return undefined;
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
        return {
          admitted: false,
          reason: `unregistered_execution_evidence:${runId}:${evidence.join(',')}`,
          diagnostics: [],
        };
      }
      continue;
    }

    const registry = base.readSmokeLifecycleRegistry(artifactDir);
    if (!registry) continue;
    if (blockingState(registry) && isAlive(registry.supervisorPid)) {
      return {
        admitted: false,
        reason: `active_smoke_supervisor:${registry.runId}`,
        diagnostics: [],
      };
    }
    if (registry.spawnState === 'reserved' || registry.spawnState === 'create_in_progress') {
      return {
        admitted: false,
        reason: `blocking_create_phase:${registry.runId}:${registry.spawnState}`,
        diagnostics: [],
      };
    }
    if (
      registry.spawnState === 'ambiguous_unbound'
      && hasExtraAbandonmentEvidence(artifactDir)
    ) {
      return {
        admitted: false,
        reason: `blocking_lifecycle:${registry.runId}:ambiguous_unbound`,
        diagnostics: [],
      };
    }
  }
  return undefined;
}

export function preflightSmokeLifecycle(
  input: Parameters<typeof base.preflightSmokeLifecycle>[0],
): base.SmokeAdmissionResult {
  const refusal = preflightSafetyRefusal(input);
  if (refusal) return refusal;
  const nowMs = input.nowMs ?? Date.now();
  return base.preflightSmokeLifecycle({
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
        return registry.cleanup?.closeOutcome ?? 'cleanup_attempt_already_settled';
      }
      const historical = readHistoricalCloseReceipt(artifactDir, registry);
      if (historical) return historical.closeOutcome;
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
