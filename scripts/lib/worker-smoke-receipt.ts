import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SMOKE_REPORT_PRODUCER, type SmokeReport } from './worker-smoke-core.ts';

export const WORKER_SMOKE_RECEIPT_SCHEMA = 'worker-smoke-receipt/v1';

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
