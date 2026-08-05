import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SMOKE_REPORT_PRODUCER, type SmokeReport } from './worker-smoke-core.ts';
import type { SmokeLifecycleRegistry } from './worker-smoke-lifecycle-base.ts';

export const WORKER_SMOKE_RECEIPT_SCHEMA = 'worker-smoke-receipt/v1';
export const SMOKE_CLOSE_SETTLEMENT_REASON = 'owned_terminal_cleanup' as const;

export interface WorkerSmokeReceipt {
  schema: typeof WORKER_SMOKE_RECEIPT_SCHEMA;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  terminalHandle: string;
  orcaExecutable: string;
  producer: string;
  result: SmokeReport['result'];
  publishedAt: string;
}

export interface SmokeCloseSettlementIdentity {
  settlementId: string;
  settlementReason: typeof SMOKE_CLOSE_SETTLEMENT_REASON;
}

interface CloseReceipt {
  version: 2;
  phase: 'settlement_recorded' | 'closed';
  runId: string;
  terminalHandle: string;
  headSha: string;
  artifactDir: string;
  settlementId: string;
  settlementReason: string;
  settlementAtMs: number;
  closeAttemptedAtMs: number;
  closeOutcome: string;
  recordedAtMs: number;
}

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function buildSmokeCloseSettlementIdentity(runId: string): SmokeCloseSettlementIdentity {
  const normalizedRunId = runId.trim();
  return {
    settlementId: `${normalizedRunId}:owned-terminal-cleanup`,
    settlementReason: SMOKE_CLOSE_SETTLEMENT_REASON,
  };
}

export function writeAtomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
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

export const isCleanCloseOutcome = (outcome: string): boolean =>
  outcome === 'closed_owned_handle'
  || outcome === 'closed_owned_handle_already_absent';

export const smokeCloseReceiptPath = (artifactDir: string): string =>
  join(artifactDir, 'close-receipt.json');

export type CloseReceiptRead =
  | { state: 'missing' | 'invalid' }
  | { state: 'settlement_recorded' | 'closed'; receipt: CloseReceipt };

export function readCloseReceipt(
  artifactDir: string,
  registry: SmokeLifecycleRegistry,
): CloseReceiptRead {
  if (!existsSync(smokeCloseReceiptPath(artifactDir))) return { state: 'missing' };
  const value = readJson(smokeCloseReceiptPath(artifactDir));
  if (!isRecord(value)) return { state: 'invalid' };
  const receipt: CloseReceipt = {
    version: 2,
    phase: value.phase === 'closed' ? 'closed' : 'settlement_recorded',
    runId: String(value.runId ?? '').trim(),
    terminalHandle: String(value.terminalHandle ?? '').trim(),
    headSha: String(value.headSha ?? '').trim().toLowerCase(),
    artifactDir: String(value.artifactDir ?? '').trim(),
    settlementId: String(value.settlementId ?? '').trim(),
    settlementReason: String(value.settlementReason ?? '').trim(),
    settlementAtMs: Number(value.settlementAtMs),
    closeAttemptedAtMs: Number(value.closeAttemptedAtMs),
    closeOutcome: String(value.closeOutcome ?? '').trim(),
    recordedAtMs: Number(value.recordedAtMs),
  };
  const expectedSettlement = buildSmokeCloseSettlementIdentity(registry.runId);
  if (
    Number(value.version) !== 2
    || (value.phase !== 'settlement_recorded' && value.phase !== 'closed')
    || receipt.runId !== registry.runId
    || receipt.terminalHandle !== registry.terminalHandle
    || receipt.headSha !== registry.headSha
    || resolve(receipt.artifactDir) !== resolve(registry.artifactDir)
    || receipt.settlementId !== expectedSettlement.settlementId
    || receipt.settlementReason !== expectedSettlement.settlementReason
    || !Number.isFinite(receipt.settlementAtMs)
    || !Number.isFinite(receipt.closeAttemptedAtMs)
    || receipt.closeAttemptedAtMs !== registry.closeAttemptedAtMs
    || receipt.settlementAtMs > receipt.closeAttemptedAtMs
    || !Number.isFinite(receipt.recordedAtMs)
    || (receipt.phase === 'settlement_recorded' && (
      receipt.closeOutcome !== ''
      || receipt.recordedAtMs !== receipt.settlementAtMs
      || receipt.recordedAtMs > receipt.closeAttemptedAtMs
    ))
    || (receipt.phase === 'closed' && (
      !isCleanCloseOutcome(receipt.closeOutcome)
      || receipt.recordedAtMs < receipt.closeAttemptedAtMs
    ))
  ) return { state: 'invalid' };
  return { state: receipt.phase, receipt };
}

export function recordCloseReceipt(input: {
  artifactDir: string;
  registry: SmokeLifecycleRegistry;
  settlementId: string;
  settlementReason: string;
  settlementAtMs: number;
  closeOutcome: string;
  nowMs: number;
}): boolean {
  if (!isCleanCloseOutcome(input.closeOutcome)) return false;
  const terminalHandle = input.registry.terminalHandle;
  if (!terminalHandle) return false;
  const expectedSettlement = buildSmokeCloseSettlementIdentity(input.registry.runId);
  if (
    input.settlementId !== expectedSettlement.settlementId
    || input.settlementReason !== expectedSettlement.settlementReason
  ) return false;
  try {
    const current = readCloseReceipt(input.artifactDir, input.registry);
    if (
      current.state !== 'settlement_recorded'
      || current.receipt.settlementId !== input.settlementId
      || current.receipt.settlementReason !== input.settlementReason
      || current.receipt.settlementAtMs !== input.settlementAtMs
      || input.nowMs < current.receipt.closeAttemptedAtMs
    ) return false;
    writeAtomicJson(smokeCloseReceiptPath(input.artifactDir), {
      ...current.receipt,
      phase: 'closed',
      closeOutcome: input.closeOutcome,
      recordedAtMs: input.nowMs,
    } satisfies CloseReceipt);
    return true;
  } catch {
    return false;
  }
}

function receiptRoot(): string {
  return process.env.WORKER_SMOKE_RECEIPT_ROOT
    ?? join(homedir(), '.local', 'state', 'orchestrator-pack-wake-supervisor', 'worker-smoke-receipts');
}

function receiptKey(prNumber: number, headSha: string): string {
  return `pr-${prNumber}|${headSha.trim().toLowerCase()}`;
}

function receiptPath(prNumber: number, headSha: string): string {
  return join(receiptRoot(), `${receiptKey(prNumber, headSha)}.json`);
}

export function writeWorkerSmokeReceipt(report: SmokeReport): WorkerSmokeReceipt {
  const receipt: WorkerSmokeReceipt = {
    schema: WORKER_SMOKE_RECEIPT_SCHEMA,
    issueNumber: report.issueNumber,
    prNumber: report.prNumber,
    headSha: report.headSha.trim().toLowerCase(),
    terminalHandle: String(report.terminalHandle ?? '').trim(),
    orcaExecutable: String(report.orcaExecutable ?? '').trim(),
    producer: report.producer ?? SMOKE_REPORT_PRODUCER,
    result: report.result,
    publishedAt: new Date().toISOString(),
  };
  mkdirSync(receiptRoot(), { recursive: true });
  writeFileSync(receiptPath(report.prNumber, report.headSha), `${JSON.stringify(receipt)}\n`, 'utf8');
  return receipt;
}

export function readWorkerSmokeReceipt(prNumber: number, headSha: string): WorkerSmokeReceipt | null {
  try {
    const parsed = JSON.parse(readFileSync(receiptPath(prNumber, headSha), 'utf8')) as WorkerSmokeReceipt;
    if (parsed.schema !== WORKER_SMOKE_RECEIPT_SCHEMA) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function verifySmokeRunReceipt(report: SmokeReport): boolean {
  const receipt = readWorkerSmokeReceipt(report.prNumber, report.headSha);
  if (!receipt) {
    return false;
  }
  return receipt.producer === SMOKE_REPORT_PRODUCER
    && receipt.issueNumber === report.issueNumber
    && receipt.prNumber === report.prNumber
    && receipt.headSha === report.headSha.trim().toLowerCase()
    && receipt.terminalHandle === String(report.terminalHandle ?? '').trim()
    && receipt.orcaExecutable === String(report.orcaExecutable ?? '').trim()
    && receipt.result === report.result;
}
