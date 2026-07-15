import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expectExactKeys,
  expectInteger,
  expectRecord,
  expectString,
  propertyPath,
} from '#opk-kernel/json-contract';
import {
  PRETTY_JSON_WITH_NEWLINE,
  serializeJsonArtifact,
  type JsonArtifactContract,
} from '#opk-kernel/json-artifact';
import {
  argumentValue,
  describeError,
  integerArgument,
  isDirectExecution,
  parseArguments,
} from './cli.js';

export interface SanctionedWorkerKillRecord {
  readonly sessionId: string;
  readonly issueNumber: number;
  readonly prNumber: number;
  readonly killKind: string;
  readonly timestampMs: number;
}

export interface SanctionedWorkerKillSurface {
  readonly healthy: boolean;
  readonly records: readonly SanctionedWorkerKillRecord[];
  readonly reason?: string;
  readonly detail?: string;
}

export interface PersistedSanctionedWorkerKillSurface {
  readonly records: readonly SanctionedWorkerKillRecord[];
}

function validateKillRecord(value: unknown, path: string): SanctionedWorkerKillRecord {
  const record = expectRecord(value, path);
  expectExactKeys(record, path, ['sessionId', 'issueNumber', 'prNumber', 'killKind', 'timestampMs']);
  return {
    sessionId: expectString(record.sessionId, propertyPath(path, 'sessionId')),
    issueNumber: expectInteger(record.issueNumber, propertyPath(path, 'issueNumber')),
    prNumber: expectInteger(record.prNumber, propertyPath(path, 'prNumber')),
    killKind: expectString(record.killKind, propertyPath(path, 'killKind')),
    timestampMs: expectInteger(record.timestampMs, propertyPath(path, 'timestampMs')),
  };
}

function validatePersistedSurface(value: unknown, path: string): PersistedSanctionedWorkerKillSurface {
  const record = expectRecord(value, path);
  expectExactKeys(record, path, ['records']);
  if (!Array.isArray(record.records)) throw new Error(`${propertyPath(path, 'records')} must be an array`);
  return {
    records: record.records.map((entry, index) => validateKillRecord(entry, `${propertyPath(path, 'records')}[${index}]`)),
  };
}

export const SANCTIONED_KILL_SURFACE_CONTRACT: JsonArtifactContract<PersistedSanctionedWorkerKillSurface> = {
  id: 'sanctioned-worker-kill-record/v1',
  validate: validatePersistedSurface,
  format: PRETTY_JSON_WITH_NEWLINE,
};

function stringValue(value: unknown): string {
  return String(value ?? '').trim();
}

function integerValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

export function normalizeSanctionedWorkerKillRecord(
  value: Partial<SanctionedWorkerKillRecord>,
  nowMs = Date.now(),
): SanctionedWorkerKillRecord {
  return {
    sessionId: stringValue(value.sessionId),
    issueNumber: integerValue(value.issueNumber),
    prNumber: integerValue(value.prNumber),
    killKind: stringValue(value.killKind) || 'manual',
    timestampMs: integerValue(value.timestampMs) || nowMs,
  };
}

function parsedRecords(parsed: unknown): readonly unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { records?: unknown }).records)) {
    return (parsed as { records: readonly unknown[] }).records;
  }
  return [];
}

export function readSanctionedWorkerKillSurface(path: string): SanctionedWorkerKillSurface {
  if (!existsSync(path)) {
    return { healthy: false, reason: 'sanctioned_kill_record_surface_absent', records: [] };
  }
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = raw.trim() ? JSON.parse(raw) as unknown : [];
    return {
      healthy: true,
      records: parsedRecords(parsed).map((entry) => normalizeSanctionedWorkerKillRecord(
        entry && typeof entry === 'object' ? entry as Partial<SanctionedWorkerKillRecord> : {},
      )),
    };
  } catch (error) {
    return {
      healthy: false,
      reason: 'sanctioned_kill_record_unreadable',
      detail: describeError(error),
      records: [],
    };
  }
}

function writeSurfaceAtomic(path: string, surface: PersistedSanctionedWorkerKillSurface): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tempPath, serializeJsonArtifact(surface, SANCTIONED_KILL_SURFACE_CONTRACT));
    renameSync(tempPath, path);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export function appendSanctionedWorkerKillRecord(
  path: string,
  record: Partial<SanctionedWorkerKillRecord>,
  nowMs = Date.now(),
): SanctionedWorkerKillSurface {
  const current = readSanctionedWorkerKillSurface(path);
  if (!current.healthy && current.reason !== 'sanctioned_kill_record_surface_absent') {
    throw new Error(current.detail ?? current.reason ?? 'sanctioned_kill_record_unreadable');
  }
  const records = [...current.records, normalizeSanctionedWorkerKillRecord(record, nowMs)];
  writeSurfaceAtomic(path, { records });
  return { healthy: true, records };
}

export function defaultSanctionedWorkerKillPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AO_SANCTIONED_WORKER_KILL_RECORD_PATH) return env.AO_SANCTIONED_WORKER_KILL_RECORD_PATH;
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  return join(repoRoot, 'docs', 'state', 'sanctioned-worker-kills.json');
}

function serializeSurfaceForStdout(surface: SanctionedWorkerKillSurface): Uint8Array {
  return serializeJsonArtifact(surface, {
    id: 'sanctioned-worker-kill-record-cli/v1',
    validate(value, path) {
      const record = expectRecord(value, path);
      const output: Record<string, unknown> = {
        healthy: record.healthy,
        records: record.records,
      };
      if (record.reason !== undefined) output.reason = record.reason;
      if (record.detail !== undefined) output.detail = record.detail;
      return output as unknown as SanctionedWorkerKillSurface;
    },
    format: PRETTY_JSON_WITH_NEWLINE,
  });
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArguments(argv);
  const command = args.positionals[0] ?? '';
  const path = argumentValue(args, 'path', defaultSanctionedWorkerKillPath());
  if (command === 'read') {
    process.stdout.write(serializeSurfaceForStdout(readSanctionedWorkerKillSurface(path)));
    return 0;
  }
  if (command === 'add') {
    const surface = appendSanctionedWorkerKillRecord(path, {
      sessionId: argumentValue(args, 'session-id'),
      issueNumber: integerArgument(args, 'issue-number', 0),
      prNumber: integerArgument(args, 'pr-number', 0),
      killKind: argumentValue(args, 'kill-kind', 'manual'),
      timestampMs: integerArgument(args, 'timestamp-ms', 0),
    });
    process.stdout.write(serializeSurfaceForStdout(surface));
    return 0;
  }
  process.stderr.write('usage: sanctioned-worker-kill-record.ts <read|add> --path <path> [record fields]\n');
  return 2;
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${describeError(error)}\n`);
    return 1;
  });
}
