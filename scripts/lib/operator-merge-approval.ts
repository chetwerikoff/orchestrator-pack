import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const OPERATOR_MERGE_APPROVAL_SCHEMA_VERSION = 1;
export const OPERATOR_MERGE_APPROVAL_EVENT = 'operator_merge_approved';
const RECORD_RENAME_ATTEMPTS = 4;
const RECORD_RENAME_BACKOFF_MS = 10;
const TRANSIENT_RENAME_ERROR_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

export interface OperatorMergeApprovalRecord {
  schemaVersion: 1;
  event: typeof OPERATOR_MERGE_APPROVAL_EVENT;
  approvalId: string;
  projectId: string;
  repoSlug: string;
  prNumber: number;
  headSha: string;
  reason: string;
  actor: string;
  createdAtUtc: string;
  revokedAtUtc?: string;
  revocationReason?: string;
}

export interface OperatorMergeApprovalStoreOptions {
  projectId?: string;
  repoSlug?: string;
  storeRoot?: string;
}

export interface OperatorMergeApprovalLookup {
  approved: boolean;
  reason: 'approved' | 'missing' | 'head_mismatch' | 'revoked' | 'malformed';
  record?: OperatorMergeApprovalRecord;
}

export interface ApproveOperatorMergeInput extends OperatorMergeApprovalStoreOptions {
  repoSlug: string;
  prNumber: number;
  headSha: string;
  reason: string;
  actor?: string;
  now?: Date;
}

export interface RevokeOperatorMergeInput extends OperatorMergeApprovalStoreOptions {
  prNumber: number;
  headSha: string;
  reason: string;
  now?: Date;
}

function requiredText(value: unknown, name: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`operator merge approval requires ${name}`);
  return text;
}

function normalizeRepoSlug(value: unknown): string {
  const repoSlug = requiredText(value, 'repoSlug');
  if (!/^[^/\s]+\/[^/\s]+$/.test(repoSlug)) {
    throw new Error(`invalid operator merge approval repoSlug '${repoSlug}'`);
  }
  return repoSlug;
}

function requireIsoTimestamp(value: unknown, name: string): string {
  const text = requiredText(value, name);
  if (!Number.isFinite(Date.parse(text))) {
    throw new Error(`operator merge approval requires an ISO timestamp for ${name}`);
  }
  return text;
}

function sleepSync(milliseconds: number): void {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(cell, 0, 0, milliseconds);
}

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code ?? '')
    : '';
}

function renameRecordWithRetry(temporary: string, destination: string): void {
  for (let attempt = 1; attempt <= RECORD_RENAME_ATTEMPTS; attempt += 1) {
    try {
      renameSync(temporary, destination);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (!TRANSIENT_RENAME_ERROR_CODES.has(code)) throw error;
      if (attempt === RECORD_RENAME_ATTEMPTS) {
        throw new Error(
          `operator merge approval atomic replace failed: rename_retry_exhausted code=${code} attempts=${RECORD_RENAME_ATTEMPTS} destination=${destination}`,
          { cause: error },
        );
      }
      sleepSync(RECORD_RENAME_BACKOFF_MS * attempt);
    }
  }
}

export function normalizeOperatorMergeApprovalProjectId(value = 'orchestrator-pack'): string {
  const normalized = requiredText(value, 'projectId')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');
  if (!normalized) throw new Error(`invalid operator merge approval project id '${value}'`);
  return normalized;
}

export function normalizeOperatorMergeApprovalPrNumber(value: unknown): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`operator merge approval requires a positive PR number; got '${String(value)}'`);
  }
  return number;
}

export function normalizeOperatorMergeApprovalHeadSha(value: unknown): string {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`operator merge approval requires a full 40-hex head SHA; got '${String(value)}'`);
  }
  return sha;
}

export function resolveOperatorMergeApprovalStoreRoot(
  options: OperatorMergeApprovalStoreOptions = {},
): string {
  if (options.storeRoot) return resolve(options.storeRoot);
  const explicit = process.env.OPERATOR_MERGE_APPROVAL_STORE_ROOT?.trim();
  if (explicit) return resolve(explicit);
  const stateRoot = process.env.ORCHESTRATOR_PACK_STATE_ROOT?.trim()
    || join(homedir(), '.local', 'state', 'orchestrator-pack');
  return join(
    resolve(stateRoot),
    'operator-merge-approvals',
    normalizeOperatorMergeApprovalProjectId(options.projectId),
  );
}

export function operatorMergeApprovalRecordPath(
  prNumber: number,
  options: OperatorMergeApprovalStoreOptions = {},
): string {
  return join(
    resolveOperatorMergeApprovalStoreRoot(options),
    `pr-${normalizeOperatorMergeApprovalPrNumber(prNumber)}.json`,
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('operator merge approval record must be a JSON object');
  }
  return value as Record<string, unknown>;
}

export function parseOperatorMergeApprovalRecord(value: unknown): OperatorMergeApprovalRecord {
  const raw = asRecord(value);
  if (Number(raw.schemaVersion) !== OPERATOR_MERGE_APPROVAL_SCHEMA_VERSION) {
    throw new Error(`unsupported operator merge approval schema '${String(raw.schemaVersion)}'`);
  }
  if (raw.event !== OPERATOR_MERGE_APPROVAL_EVENT) {
    throw new Error(`invalid operator merge approval event '${String(raw.event)}'`);
  }
  const approvalId = requiredText(raw.approvalId, 'approvalId');
  const projectId = normalizeOperatorMergeApprovalProjectId(requiredText(raw.projectId, 'projectId'));
  const repoSlug = normalizeRepoSlug(raw.repoSlug);
  const prNumber = normalizeOperatorMergeApprovalPrNumber(raw.prNumber);
  const headSha = normalizeOperatorMergeApprovalHeadSha(raw.headSha);
  const reason = requiredText(raw.reason, 'reason');
  const actor = requiredText(raw.actor, 'actor');
  const createdAtUtc = requireIsoTimestamp(raw.createdAtUtc, 'createdAtUtc');
  const revokedAtUtc = String(raw.revokedAtUtc ?? '').trim()
    ? requireIsoTimestamp(raw.revokedAtUtc, 'revokedAtUtc')
    : undefined;
  const revocationReason = String(raw.revocationReason ?? '').trim() || undefined;
  if (revokedAtUtc && !revocationReason) {
    throw new Error('revoked operator merge approval requires revocationReason');
  }
  return {
    schemaVersion: 1,
    event: OPERATOR_MERGE_APPROVAL_EVENT,
    approvalId,
    projectId,
    repoSlug,
    prNumber,
    headSha,
    reason,
    actor,
    createdAtUtc,
    ...(revokedAtUtc ? { revokedAtUtc } : {}),
    ...(revocationReason ? { revocationReason } : {}),
  };
}

function atomicWrite(path: string, value: OperatorMergeApprovalRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameRecordWithRetry(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function approveOperatorMerge(input: ApproveOperatorMergeInput): OperatorMergeApprovalRecord {
  const projectId = normalizeOperatorMergeApprovalProjectId(input.projectId);
  const prNumber = normalizeOperatorMergeApprovalPrNumber(input.prNumber);
  const headSha = normalizeOperatorMergeApprovalHeadSha(input.headSha);
  const repoSlug = normalizeRepoSlug(input.repoSlug);
  const record: OperatorMergeApprovalRecord = {
    schemaVersion: 1,
    event: OPERATOR_MERGE_APPROVAL_EVENT,
    approvalId: randomUUID(),
    projectId,
    repoSlug,
    prNumber,
    headSha,
    reason: requiredText(input.reason, 'reason'),
    actor: String(input.actor ?? '').trim()
      || process.env.GITHUB_ACTOR?.trim()
      || process.env.USER?.trim()
      || 'operator',
    createdAtUtc: (input.now ?? new Date()).toISOString(),
  };
  atomicWrite(operatorMergeApprovalRecordPath(prNumber, { ...input, projectId }), record);
  return record;
}

export function readOperatorMergeApproval(
  input: OperatorMergeApprovalStoreOptions & { prNumber: number; headSha: string },
): OperatorMergeApprovalLookup {
  const projectId = normalizeOperatorMergeApprovalProjectId(input.projectId);
  const repoSlug = input.repoSlug === undefined ? undefined : normalizeRepoSlug(input.repoSlug);
  const prNumber = normalizeOperatorMergeApprovalPrNumber(input.prNumber);
  const headSha = normalizeOperatorMergeApprovalHeadSha(input.headSha);
  const path = operatorMergeApprovalRecordPath(prNumber, { ...input, projectId });
  if (!existsSync(path)) return { approved: false, reason: 'missing' };
  let record: OperatorMergeApprovalRecord;
  try {
    record = parseOperatorMergeApprovalRecord(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return { approved: false, reason: 'malformed' };
  }
  if (record.projectId !== projectId || record.prNumber !== prNumber) {
    return { approved: false, reason: 'malformed' };
  }
  if (repoSlug !== undefined && record.repoSlug !== repoSlug) {
    return { approved: false, reason: 'malformed' };
  }
  if (record.revokedAtUtc) return { approved: false, reason: 'revoked', record };
  if (record.headSha !== headSha) return { approved: false, reason: 'head_mismatch', record };
  return { approved: true, reason: 'approved', record };
}

export function revokeOperatorMerge(input: RevokeOperatorMergeInput): OperatorMergeApprovalLookup {
  const current = readOperatorMergeApproval(input);
  if (!current.record || current.reason === 'malformed') return current;
  if (current.record.headSha !== normalizeOperatorMergeApprovalHeadSha(input.headSha)) return current;
  if (current.record.revokedAtUtc) return current;
  const revoked: OperatorMergeApprovalRecord = {
    ...current.record,
    revokedAtUtc: (input.now ?? new Date()).toISOString(),
    revocationReason: requiredText(input.reason, 'reason'),
  };
  atomicWrite(operatorMergeApprovalRecordPath(revoked.prNumber, input), revoked);
  return { approved: false, reason: 'revoked', record: revoked };
}
