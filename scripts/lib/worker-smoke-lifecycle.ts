import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import * as base from './worker-smoke-lifecycle-base.ts';

export * from './worker-smoke-lifecycle-base.ts';

interface CloseReceipt {
  version: 1;
  runId: string;
  terminalHandle: string;
  closeOutcome: string;
  recordedAtMs: number;
}

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const blockingState = (registry: base.SmokeLifecycleRegistry): boolean =>
  registry.spawnState !== 'clean' && registry.spawnState !== 'abandoned_unbound';

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  renameSync(temporary, path);
}

function readJson(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function cleanCloseOutcome(outcome: string): boolean {
  return outcome === 'closed_owned_handle'
    || outcome === 'closed_owned_handle_already_absent';
}

export const smokeCloseReceiptPath = (artifactDir: string): string =>
  join(artifactDir, 'close-receipt.json');

function readCloseReceipt(
  artifactDir: string,
  runId: string,
  terminalHandle: string,
): CloseReceipt | undefined {
  const value = readJson(smokeCloseReceiptPath(artifactDir));
  if (!isRecord(value)) return undefined;
  const receipt: CloseReceipt = {
    version: 1,
    runId: String(value.runId ?? '').trim(),
    terminalHandle: String(value.terminalHandle ?? '').trim(),
    closeOutcome: String(value.closeOutcome ?? '').trim(),
    recordedAtMs: Number(value.recordedAtMs),
  };
  if (
    Number(value.version) !== 1
    || receipt.runId !== runId
    || receipt.terminalHandle !== terminalHandle
    || !cleanCloseOutcome(receipt.closeOutcome)
    || !Number.isFinite(receipt.recordedAtMs)
  ) return undefined;
  return receipt;
}

function recordCloseReceipt(input: {
  artifactDir: string;
  runId: string;
  terminalHandle: string;
  closeOutcome: string;
  nowMs: number;
}): boolean {
  if (!cleanCloseOutcome(input.closeOutcome)) return false;
  try {
    atomicJson(smokeCloseReceiptPath(input.artifactDir), {
      version: 1,
      runId: input.runId,
      terminalHandle: input.terminalHandle,
      closeOutcome: input.closeOutcome,
      recordedAtMs: input.nowMs,
    } satisfies CloseReceipt);
    return true;
  } catch {
    return false;
  }
}

function closeWithReceipt(input: {
  artifactDir: string;
  runId: string;
  terminalHandle: string;
  nowMs: number;
  closeBoundHandle: (handle: string, artifactDir: string) => string;
}): string {
  const existing = readCloseReceipt(
    input.artifactDir,
    input.runId,
    input.terminalHandle,
  );
  if (existing) return existing.closeOutcome;

  const outcome = input.closeBoundHandle(input.terminalHandle, input.artifactDir);
  if (outcome === 'close_failed:channel_stale_handle') {
    return 'close_failed:unproven_channel_stale_handle';
  }
  if (!cleanCloseOutcome(outcome)) return outcome;
  return recordCloseReceipt({
    artifactDir: input.artifactDir,
    runId: input.runId,
    terminalHandle: input.terminalHandle,
    closeOutcome: outcome,
    nowMs: input.nowMs,
  })
    ? outcome
    : 'close_receipt_write_failed';
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
    if (existsSync(base.smokeLifecycleRegistryPath(artifactDir))) continue;
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
      return closeWithReceipt({
        artifactDir,
        runId: registry.runId,
        terminalHandle: handle,
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
  return base.cleanupSmokeLifecycle({
    ...input,
    closeBoundHandle: (handle) => closeWithReceipt({
      artifactDir: input.artifactDir,
      runId: input.runId,
      terminalHandle: handle,
      nowMs,
      closeBoundHandle: (ownedHandle) => input.closeBoundHandle(ownedHandle),
    }),
  });
}
