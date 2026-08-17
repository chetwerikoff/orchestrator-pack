import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { atomicJson, fsyncDirectory, profileDirs, profileStatePaths } from './storage-common.ts';

export const STATE_LIGHT_TURN_OBSERVATION_SCHEMA = 'state-light-turn-observation/v1' as const;
export type StateLightTurnObservationPhase =
  | 'prepared'
  | 'dispatching'
  | 'not_sent'
  | 'sent_unbound'
  | 'sent_unharvested'
  | 'harvested';

export type StateLightTurnSendWitness = 'none' | 'numeric_send_count' | 'owned_marker';

export interface StateLightTurnPrimaryBinding {
  readonly target: string;
  readonly byte_length: number;
  readonly sha256: string;
}

export interface StateLightTurnObservationRecord {
  readonly schema: typeof STATE_LIGHT_TURN_OBSERVATION_SCHEMA;
  readonly version: 1;
  readonly invocation_id: string;
  readonly profile_key: string;
  readonly marker: string;
  readonly phase: StateLightTurnObservationPhase;
  readonly send_count?: number;
  readonly send_witness: StateLightTurnSendWitness;
  readonly conversation_url: string | null;
  readonly primary?: StateLightTurnPrimaryBinding;
  readonly transitioned_at: string;
  readonly transition_reason: string;
}

export interface ObservationMutationLease {
  readonly profileKey: string;
  readonly recordKey: string;
  readonly owner: string;
  readonly slotPath: string;
  readonly ownerChildPath: string;
}

const LEGAL_NEXT: Readonly<Record<StateLightTurnObservationPhase, ReadonlySet<StateLightTurnObservationPhase>>> = {
  prepared: new Set(['prepared', 'dispatching', 'not_sent']),
  dispatching: new Set(['dispatching', 'sent_unbound', 'sent_unharvested']),
  not_sent: new Set(['not_sent']),
  sent_unbound: new Set(['sent_unbound', 'sent_unharvested']),
  sent_unharvested: new Set(['sent_unharvested', 'harvested']),
  harvested: new Set(['harvested']),
};

function observationRoot(profileKey: string): string {
  return join(profileDirs(profileKey).root, 'observations');
}

export function observationRecordKey(invocationId: string): string {
  return createHash('sha256').update(invocationId, 'utf8').digest('hex');
}

export function observationRecordPath(profileKey: string, invocationId: string): string {
  return join(profileStatePaths(profileKey).root, 'observations', `${observationRecordKey(invocationId)}.json`);
}

function parseRecord(raw: string): StateLightTurnObservationRecord {
  const value = JSON.parse(raw) as StateLightTurnObservationRecord;
  if (value.schema !== STATE_LIGHT_TURN_OBSERVATION_SCHEMA
    || value.version !== 1
    || typeof value.invocation_id !== 'string'
    || value.invocation_id.length === 0
    || typeof value.profile_key !== 'string'
    || value.profile_key.length === 0
    || typeof value.marker !== 'string'
    || value.marker.length === 0
    || !(value.phase in LEGAL_NEXT)
    || !['none', 'numeric_send_count', 'owned_marker'].includes(value.send_witness)
    || (value.conversation_url !== null && typeof value.conversation_url !== 'string')
    || typeof value.transitioned_at !== 'string'
    || typeof value.transition_reason !== 'string') {
    throw new Error('observation_record_malformed');
  }
  if (value.send_count !== undefined && (!Number.isSafeInteger(value.send_count) || value.send_count < 0)) {
    throw new Error('observation_send_count_invalid');
  }
  if (value.primary) {
    if (typeof value.primary.target !== 'string'
      || !Number.isSafeInteger(value.primary.byte_length)
      || value.primary.byte_length < 0
      || !/^[0-9a-f]{64}$/u.test(value.primary.sha256)) {
      throw new Error('observation_primary_binding_invalid');
    }
  }
  return value;
}

function rereadExact(path: string): StateLightTurnObservationRecord {
  return parseRecord(readFileSync(path, 'utf8'));
}

export function readStateLightTurnObservation(
  profileKey: string,
  invocationId: string,
): StateLightTurnObservationRecord {
  const path = observationRecordPath(profileKey, invocationId);
  const record = rereadExact(path);
  if (record.profile_key !== profileKey || record.invocation_id !== invocationId) {
    throw new Error('observation_identity_mismatch');
  }
  if (observationRecordKey(record.invocation_id) !== basename(path, '.json')) {
    throw new Error('observation_record_key_mismatch');
  }
  return record;
}

export function admitStateLightTurnObservation(input: {
  readonly profileKey: string;
  readonly invocationId: string;
  readonly marker: string;
  readonly now?: Date;
}): StateLightTurnObservationRecord {
  if (!input.invocationId) throw new Error('observation_invocation_id_required');
  const dir = observationRoot(input.profileKey);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const finalPath = observationRecordPath(input.profileKey, input.invocationId);
  const proposed: StateLightTurnObservationRecord = {
    schema: STATE_LIGHT_TURN_OBSERVATION_SCHEMA,
    version: 1,
    invocation_id: input.invocationId,
    profile_key: input.profileKey,
    marker: input.marker,
    phase: 'prepared',
    send_witness: 'none',
    conversation_url: null,
    transitioned_at: (input.now ?? new Date()).toISOString(),
    transition_reason: 'admitted_before_send',
  };
  const tempPath = join(dir, `.${observationRecordKey(input.invocationId)}.${randomUUID()}.tmp`);
  const fd = openSync(tempPath, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(proposed)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const staged = rereadExact(tempPath);
  if (JSON.stringify(staged) !== JSON.stringify(proposed)) {
    try { unlinkSync(tempPath); } catch { /* best effort */ }
    throw new Error('observation_staging_readback_mismatch');
  }
  try {
    linkSync(tempPath, finalPath);
    fsyncDirectory(dir);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : '';
    if (code !== 'EEXIST') throw error;
  } finally {
    try { unlinkSync(tempPath); } catch { /* best effort */ }
  }
  const winner = readStateLightTurnObservation(input.profileKey, input.invocationId);
  if (winner.marker !== input.marker) throw new Error('observation_marker_conflict');
  return winner;
}

function ownerPidProvablyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function mutationSlotPath(profileKey: string, recordKey: string): string {
  return join(profileDirs(profileKey).locks, `state-light-turn-observation-${recordKey}.slot`);
}

function ownerChild(slotPath: string, owner: string): string {
  return join(slotPath, `owner-${owner}.json`);
}

function readOwnerPid(slotPath: string): number | undefined {
  try {
    if (!lstatSync(slotPath).isDirectory()) return undefined;
    const ownerFiles = readdirSync(slotPath);
    if (ownerFiles.length !== 1 || !/^owner-[0-9a-f-]+\.json$/u.test(ownerFiles[0]!)) return undefined;
    const raw = JSON.parse(readFileSync(join(slotPath, ownerFiles[0]!), 'utf8')) as { pid?: unknown };
    return Number.isSafeInteger(raw.pid) && Number(raw.pid) > 0 ? Number(raw.pid) : undefined;
  } catch {
    return undefined;
  }
}

function reclaimDeadOwner(slotPath: string): boolean {
  const pid = readOwnerPid(slotPath);
  if (pid === undefined || !ownerPidProvablyDead(pid)) return false;
  try {
    const children = readdirSync(slotPath);
    if (children.length !== 1) return false;
    unlinkSync(join(slotPath, children[0]!));
    rmdirSync(slotPath);
    return true;
  } catch {
    return false;
  }
}

export function acquireObservationMutation(
  profileKey: string,
  invocationId: string,
): ObservationMutationLease {
  const recordKey = observationRecordKey(invocationId);
  const locks = profileDirs(profileKey).locks;
  const slotPath = mutationSlotPath(profileKey, recordKey);
  for (let attempt = 0; attempt < 2; attempt++) {
    const owner = randomUUID();
    const staging = join(locks, `.state-light-turn-observation-${recordKey}.${owner}.tmp`);
    mkdirSync(staging, { mode: 0o700 });
    const child = ownerChild(staging, owner);
    const fd = openSync(child, 'wx', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify({ owner, pid: process.pid, acquired_at: new Date().toISOString() })}\n`, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const stagedOwner = JSON.parse(readFileSync(child, 'utf8')) as { owner?: string; pid?: number };
    if (stagedOwner.owner !== owner || stagedOwner.pid !== process.pid) {
      throw new Error('observation_mutation_owner_readback_mismatch');
    }
    fsyncDirectory(staging);
    try {
      renameSync(staging, slotPath);
      fsyncDirectory(locks);
      return { profileKey, recordKey, owner, slotPath, ownerChildPath: ownerChild(slotPath, owner) };
    } catch (error) {
      try { unlinkSync(child); } catch { /* best effort */ }
      try { rmdirSync(staging); } catch { /* best effort */ }
      const code = error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : '';
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      if (!reclaimDeadOwner(slotPath)) throw new Error('observation_mutation_busy');
    }
  }
  throw new Error('observation_mutation_busy');
}

export function verifyObservationMutation(lease: ObservationMutationLease): void {
  const raw = JSON.parse(readFileSync(lease.ownerChildPath, 'utf8')) as { owner?: string; pid?: number };
  if (raw.owner !== lease.owner || raw.pid !== process.pid) throw new Error('observation_mutation_owner_lost');
}

export function releaseObservationMutation(lease: ObservationMutationLease): void {
  try { unlinkSync(lease.ownerChildPath); } catch { return; }
  try { rmdirSync(lease.slotPath); } catch { /* committed state remains authoritative */ }
}

function validateTransition(
  current: StateLightTurnObservationRecord,
  next: StateLightTurnObservationRecord,
): void {
  if (current.invocation_id !== next.invocation_id
    || current.profile_key !== next.profile_key
    || current.marker !== next.marker) {
    throw new Error('observation_immutable_identity_changed');
  }
  if (!LEGAL_NEXT[current.phase].has(next.phase)) throw new Error('observation_phase_transition_invalid');
  if (current.primary && JSON.stringify(current.primary) !== JSON.stringify(next.primary)) {
    throw new Error('observation_primary_binding_conflict');
  }
  if (current.conversation_url && next.conversation_url !== current.conversation_url) {
    throw new Error('observation_conversation_rebind');
  }
  if (current.send_count !== undefined && next.send_count !== undefined && next.send_count !== current.send_count) {
    throw new Error('observation_send_count_changed');
  }
}

export function mutateStateLightTurnObservation(
  profileKey: string,
  invocationId: string,
  mutation: (current: StateLightTurnObservationRecord) => StateLightTurnObservationRecord,
): StateLightTurnObservationRecord {
  const lease = acquireObservationMutation(profileKey, invocationId);
  try {
    const current = readStateLightTurnObservation(profileKey, invocationId);
    const next = mutation(current);
    validateTransition(current, next);
    verifyObservationMutation(lease);
    atomicJson(observationRecordPath(profileKey, invocationId), next);
    const committed = readStateLightTurnObservation(profileKey, invocationId);
    if (JSON.stringify(committed) !== JSON.stringify(next)) throw new Error('observation_mutation_readback_mismatch');
    return committed;
  } finally {
    releaseObservationMutation(lease);
  }
}

export function transitionStateLightTurnObservation(input: {
  readonly profileKey: string;
  readonly invocationId: string;
  readonly phase: StateLightTurnObservationPhase;
  readonly reason: string;
  readonly sendCount?: number;
  readonly sendWitness?: StateLightTurnSendWitness;
  readonly conversationUrl?: string | null;
}): StateLightTurnObservationRecord {
  return mutateStateLightTurnObservation(input.profileKey, input.invocationId, (current) => ({
    ...current,
    phase: input.phase,
    ...(input.sendCount !== undefined ? { send_count: input.sendCount } : {}),
    ...(input.sendWitness !== undefined ? { send_witness: input.sendWitness } : {}),
    ...(input.conversationUrl !== undefined ? { conversation_url: input.conversationUrl } : {}),
    transitioned_at: new Date().toISOString(),
    transition_reason: input.reason,
  }));
}

export function bindPrimaryPublication(input: {
  readonly profileKey: string;
  readonly invocationId: string;
  readonly target: string;
  readonly bytes: Uint8Array | string;
}): StateLightTurnObservationRecord {
  const bytes = typeof input.bytes === 'string' ? Buffer.from(input.bytes, 'utf8') : Buffer.from(input.bytes);
  const binding: StateLightTurnPrimaryBinding = {
    target: resolve(input.target),
    byte_length: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  return mutateStateLightTurnObservation(input.profileKey, input.invocationId, (current) => {
    if (current.primary && JSON.stringify(current.primary) !== JSON.stringify(binding)) {
      throw new Error('observation_primary_binding_conflict');
    }
    return {
      ...current,
      primary: current.primary ?? binding,
      transitioned_at: new Date().toISOString(),
      transition_reason: current.primary ? 'primary_binding_verified' : 'primary_binding_established',
    };
  });
}

export function primaryBindingMatches(
  record: StateLightTurnObservationRecord,
  target: string,
  bytes: Uint8Array | string,
): boolean {
  if (!record.primary) return false;
  const payload = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  return record.primary.target === resolve(target)
    && record.primary.byte_length === payload.byteLength
    && record.primary.sha256 === createHash('sha256').update(payload).digest('hex');
}
