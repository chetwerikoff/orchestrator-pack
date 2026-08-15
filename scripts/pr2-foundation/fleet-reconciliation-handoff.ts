import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const FLEET_RECONCILIATION_HANDOFF_SCHEMA = 'fleet-reconciliation-handoff/v1' as const;
export const MAX_FLEET_RECONCILIATION_HANDOFF_BYTES = 16_384 as const;

export type FleetReconciliationReason =
  | 'target_unresolved'
  | 'target_stale'
  | 'observer_untrusted'
  | 'assignment_untrusted'
  | 'remote_not_applicable'
  | 'runtime_unavailable'
  | 'dispatch_unknown'
  | 'effect_untrusted';

export interface FleetReconciliationHandoff {
  readonly schema: typeof FLEET_RECONCILIATION_HANDOFF_SCHEMA;
  readonly projectId: string;
  readonly repository: string;
  readonly activationLineage: string;
  readonly schedulerGeneration: string;
  readonly tickSequence: number;
  readonly decision: 'orchestrator_required';
  readonly reason: FleetReconciliationReason;
  readonly role?: 'manager' | 'worker';
  readonly issueNumber?: number;
  readonly taskId?: string;
  readonly assignmentId?: string;
  readonly assignmentGeneration?: number;
  readonly recordedAtUtc: string;
  readonly payloadDigest: string;
}

export function resolveFleetReconciliationHandoffPath(
  projectId = 'orchestrator-pack',
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root = env.OPK_BASE_DIR?.trim()
    ? path.resolve(env.OPK_BASE_DIR)
    : path.join(env.HOME ?? homedir(), '.orchestrator-pack');
  return path.join(root, 'projects', projectId.trim() || 'orchestrator-pack', 'fleet-reconciliation-handoff.json');
}

function canonicalPayload(input: Omit<FleetReconciliationHandoff, 'payloadDigest'>): string {
  return JSON.stringify(input);
}

function valid(value: unknown): value is FleetReconciliationHandoff {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<FleetReconciliationHandoff>;
  if (row.schema !== FLEET_RECONCILIATION_HANDOFF_SCHEMA
    || !row.projectId || !row.repository || !row.activationLineage
    || !row.schedulerGeneration || !Number.isInteger(row.tickSequence) || Number(row.tickSequence) <= 0
    || row.decision !== 'orchestrator_required'
    || !row.reason || !row.recordedAtUtc || !row.payloadDigest) return false;
  const { payloadDigest, ...payload } = row as FleetReconciliationHandoff;
  return payloadDigest === createHash('sha256').update(canonicalPayload(payload), 'utf8').digest('hex');
}

export function readFleetReconciliationHandoff(file: string): FleetReconciliationHandoff | null {
  if (!existsSync(file)) return null;
  try {
    const bytes = readFileSync(file, 'utf8');
    if (Buffer.byteLength(bytes, 'utf8') > MAX_FLEET_RECONCILIATION_HANDOFF_BYTES) return null;
    const parsed = JSON.parse(bytes) as unknown;
    return valid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function publishFleetReconciliationHandoff(input: {
  readonly file: string;
  readonly projectId?: string;
  readonly repository: string;
  readonly activationLineage: string;
  readonly schedulerGeneration: string;
  readonly tickSequence: number;
  readonly reason: FleetReconciliationReason;
  readonly role?: 'manager' | 'worker';
  readonly issueNumber?: number;
  readonly taskId?: string;
  readonly assignmentId?: string;
  readonly assignmentGeneration?: number;
  readonly now?: () => Date;
}): { readonly ok: true; readonly record: FleetReconciliationHandoff } | { readonly ok: false; readonly reason: string } {
  const payload = {
    schema: FLEET_RECONCILIATION_HANDOFF_SCHEMA,
    projectId: input.projectId?.trim() || 'orchestrator-pack',
    repository: input.repository.trim().toLowerCase(),
    activationLineage: input.activationLineage.trim(),
    schedulerGeneration: input.schedulerGeneration.trim(),
    tickSequence: input.tickSequence,
    decision: 'orchestrator_required' as const,
    reason: input.reason,
    ...(input.role ? { role: input.role } : {}),
    ...(input.issueNumber ? { issueNumber: input.issueNumber } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.assignmentId ? { assignmentId: input.assignmentId } : {}),
    ...(input.assignmentGeneration ? { assignmentGeneration: input.assignmentGeneration } : {}),
    recordedAtUtc: (input.now?.() ?? new Date()).toISOString(),
  };
  if (!payload.repository || !payload.activationLineage || !payload.schedulerGeneration
    || !Number.isInteger(payload.tickSequence) || payload.tickSequence <= 0) {
    return { ok: false, reason: 'handoff_input_invalid' };
  }
  const record: FleetReconciliationHandoff = {
    ...payload,
    payloadDigest: createHash('sha256').update(canonicalPayload(payload), 'utf8').digest('hex'),
  };
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(bytes, 'utf8') > MAX_FLEET_RECONCILIATION_HANDOFF_BYTES) {
    return { ok: false, reason: 'handoff_too_large' };
  }
  const directory = path.dirname(input.file);
  mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${randomUUID().replace(/-/g, '')}.tmp`);
  try {
    writeFileSync(temporary, bytes, { encoding: 'utf8', mode: 0o600 });
    const fd = openSync(temporary, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, input.file);
    const reread = readFleetReconciliationHandoff(input.file);
    if (!reread || reread.payloadDigest !== record.payloadDigest) {
      return { ok: false, reason: 'handoff_readback_failed' };
    }
    return { ok: true, record };
  } catch {
    rmSync(temporary, { force: true });
    return { ok: false, reason: 'handoff_commit_failed' };
  }
}
