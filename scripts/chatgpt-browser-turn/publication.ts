import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';
import type { PublicationStatusV1 } from './contracts.ts';
import { atomicJson, fsyncDirectory, profileDirs, sha256 } from './storage-common.ts';

export const PUBLICATION_SCHEMA = 'chatgpt-browser-turn-publication/v1' as const;

export interface PublicationRecordV1 {
  readonly schema: typeof PUBLICATION_SCHEMA;
  readonly version: 1;
  readonly configured_profile_key: string;
  readonly invocation_id: string;
  readonly output_path: string;
  readonly output_identity: string;
  readonly temp_path: string;
  readonly temp_dev: string;
  readonly temp_ino: string;
  readonly owner_pid: number;
  readonly state: 'prepared' | 'committed' | 'collision';
  readonly failure_cause?: string;
  readonly output_bytes?: number;
  readonly output_sha256?: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PublicationTestHooks {
  readonly afterPreparedRecord?: () => void;
}

function validInvocationId(invocationId: string): boolean {
  return invocationId.length > 0
    && invocationId.length <= 128
    && basename(invocationId) === invocationId
    && /^[A-Za-z0-9._-]+$/.test(invocationId);
}

function publicationPath(profileKey: string, invocationId: string): string {
  if (!validInvocationId(invocationId)) throw new Error('publication_invocation_invalid');
  return join(profileDirs(profileKey).publications, `${invocationId}.json`);
}

function status(
  profileKey: string,
  invocationId: string,
  state: PublicationStatusV1['state'],
  outputPath?: string,
  cause?: string,
): PublicationStatusV1 {
  return {
    schema: 'publication-status/v1',
    state,
    configured_profile_key: profileKey,
    invocation_id: invocationId,
    ...(outputPath ? { output_path: outputPath } : {}),
    ...(cause ? { cause } : {}),
  };
}

function likelyCaseInsensitive(path: string): boolean {
  return process.platform === 'win32' || /^\/mnt\/[a-z](?:\/|$)/i.test(path);
}

function expectedOutputIdentity(path: string): string {
  const identityPath = likelyCaseInsensitive(dirname(path)) ? path.toLowerCase() : path;
  return `output-${sha256(identityPath)}`;
}

function validTempPath(record: PublicationRecordV1): boolean {
  if (resolve(record.output_path) !== record.output_path || resolve(record.temp_path) !== record.temp_path) return false;
  if (dirname(record.temp_path) !== dirname(record.output_path)) return false;
  const prefix = `.${basename(record.output_path)}.${record.invocation_id}.`;
  const name = basename(record.temp_path);
  if (!name.startsWith(prefix) || !name.endsWith('.tmp')) return false;
  const nonce = name.slice(prefix.length, -4);
  return /^[0-9a-f-]{16,64}$/i.test(nonce);
}

function isCompatiblePublication(value: unknown, profileKey: string, invocationId?: string): value is PublicationRecordV1 {
  if (!value || typeof value !== 'object') return false;
  const record = value as PublicationRecordV1;
  if (record.schema !== PUBLICATION_SCHEMA
    || record.version !== 1
    || record.configured_profile_key !== profileKey
    || !validInvocationId(record.invocation_id)
    || (invocationId !== undefined && record.invocation_id !== invocationId)
    || typeof record.output_path !== 'string'
    || typeof record.output_identity !== 'string'
    || typeof record.temp_path !== 'string'
    || !/^\d+$/.test(record.temp_dev)
    || !/^\d+$/.test(record.temp_ino)
    || !Number.isInteger(record.owner_pid)
    || record.owner_pid <= 0
    || !['prepared', 'committed', 'collision'].includes(record.state)
    || !validTempPath(record)
    || record.output_identity !== expectedOutputIdentity(record.output_path)
    || !Number.isFinite(Date.parse(record.created_at))
    || !Number.isFinite(Date.parse(record.updated_at))) {
    return false;
  }
  if (record.state === 'committed') {
    return Number.isInteger(record.output_bytes)
      && Number(record.output_bytes) >= 0
      && typeof record.output_sha256 === 'string'
      && /^[0-9a-f]{64}$/.test(record.output_sha256)
      && record.failure_cause === undefined;
  }
  if (record.output_bytes !== undefined || record.output_sha256 !== undefined) return false;
  if (record.state === 'collision') return typeof record.failure_cause === 'string' && record.failure_cause.length > 0;
  return record.failure_cause === undefined || typeof record.failure_cause === 'string';
}

export function publicationRecordCompatible(path: string, profileKey: string): boolean {
  try {
    return isCompatiblePublication(JSON.parse(readFileSync(path, 'utf8')), profileKey);
  } catch {
    return false;
  }
}

function writeRecord(profileKey: string, record: PublicationRecordV1): void {
  atomicJson(publicationPath(profileKey, record.invocation_id), record);
}

function sameObject(path: string, dev: string, ino: string): boolean {
  try {
    const current = lstatSync(path, { bigint: true });
    return current.isFile() && String(current.dev) === dev && String(current.ino) === ino;
  } catch {
    return false;
  }
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : '';
    if (code === 'ENOENT') return false;
    throw error;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return true;
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Best effort only; no body bytes have been written before the prepared record is durable.
  }
}

type NoReplaceMvMode = 'none-fail' | 'no-clobber';
let noReplaceMvMode: NoReplaceMvMode | null | undefined;

function coreutilsAtLeast830(): boolean {
  const version = runProcessSync({ command: 'mv', args: ['--version'] });
  if (!version.ok) return false;
  const match = /\b(\d+)\.(\d+)(?:\.\d+)?\b/.exec(version.stdout.split('\n', 1)[0] ?? '');
  if (!match?.[1] || !match[2]) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 8 || (major === 8 && minor >= 30);
}

function detectNoReplaceMove(): NoReplaceMvMode | null {
  if (noReplaceMvMode !== undefined) return noReplaceMvMode;
  if (process.platform !== 'linux') {
    noReplaceMvMode = null;
    return null;
  }
  const probe = runProcessSync({ command: 'mv', args: ['--help'] });
  if (!probe.ok
    || !probe.stdout.includes('--no-copy')
    || !probe.stdout.includes('--no-target-directory')) {
    noReplaceMvMode = null;
    return null;
  }
  if (probe.stdout.includes('none-fail')) {
    noReplaceMvMode = 'none-fail';
    return noReplaceMvMode;
  }
  if (probe.stdout.includes('--no-clobber') && coreutilsAtLeast830()) {
    noReplaceMvMode = 'no-clobber';
    return noReplaceMvMode;
  }
  noReplaceMvMode = null;
  return null;
}

function noReplaceMove(tempPath: string, finalPath: string): { ok: boolean; collision: boolean; cause?: string } {
  const mode = detectNoReplaceMove();
  if (!mode) return { ok: false, collision: false, cause: 'atomic_noreplace_primitive_unavailable' };
  const args = mode === 'none-fail'
    ? ['--update=none-fail', '--no-copy', '--no-target-directory', tempPath, finalPath]
    : ['--no-clobber', '--no-copy', '--no-target-directory', tempPath, finalPath];
  const moved = runProcessSync({ command: 'mv', args });
  try {
    if (entryExists(finalPath) && entryExists(tempPath)) {
      return { ok: false, collision: true, cause: 'publication_commit_collision' };
    }
    if (moved.ok && !entryExists(tempPath)) return { ok: true, collision: false };
  } catch {
    return { ok: false, collision: false, cause: 'publication_identity_unreadable' };
  }
  return { ok: false, collision: false, cause: `atomic_rename_failed:${moved.outcome}:${moved.exitCode ?? 'none'}` };
}

export function publishReply(
  profileKey: string,
  invocationId: string,
  outputPath: string,
  outputIdentity: string,
  reply: string,
  testHooks: PublicationTestHooks = {},
): PublicationStatusV1 {
  if (!validInvocationId(invocationId)) {
    return status(profileKey, invocationId, 'recovery_required', undefined, 'publication_invocation_invalid');
  }
  const finalPath = resolve(outputPath);
  let parent: string;
  try {
    parent = realpathSync.native(dirname(finalPath));
  } catch {
    return status(profileKey, invocationId, 'recovery_required', finalPath, 'publication_parent_unavailable');
  }
  if (join(parent, basename(finalPath)) !== finalPath || outputIdentity !== expectedOutputIdentity(finalPath)) {
    return status(profileKey, invocationId, 'recovery_required', finalPath, 'publication_destination_identity_changed');
  }

  const tempPath = join(parent, `.${basename(finalPath)}.${invocationId}.${randomUUID()}.tmp`);
  let fd = -1;
  let record: PublicationRecordV1 | undefined;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    const parentStat = statSync(parent, { bigint: true });
    const tempStat = fstatSync(fd, { bigint: true });
    if (parentStat.dev !== tempStat.dev) {
      closeSync(fd);
      fd = -1;
      safeUnlink(tempPath);
      return status(profileKey, invocationId, 'recovery_required', finalPath, 'publication_cross_filesystem');
    }

    const now = new Date().toISOString();
    record = {
      schema: PUBLICATION_SCHEMA,
      version: 1,
      configured_profile_key: profileKey,
      invocation_id: invocationId,
      output_path: finalPath,
      output_identity: outputIdentity,
      temp_path: tempPath,
      temp_dev: String(tempStat.dev),
      temp_ino: String(tempStat.ino),
      owner_pid: process.pid,
      state: 'prepared',
      created_at: now,
      updated_at: now,
    };
    try {
      writeRecord(profileKey, record);
    } catch {
      closeSync(fd);
      fd = -1;
      safeUnlink(tempPath);
      return status(profileKey, invocationId, 'recovery_required', finalPath, 'publication_record_prepare_failed');
    }

    testHooks.afterPreparedRecord?.();
    writeFileSync(fd, reply, 'utf8');
    fsyncSync(fd);
  } catch (error) {
    if (fd >= 0) closeSync(fd);
    if (error instanceof Error && error.message.startsWith('test_crash:')) throw error;
    if (record) {
      try {
        record = { ...record, failure_cause: 'publication_temp_write_failed', updated_at: new Date().toISOString() };
        writeRecord(profileKey, record);
      } catch {
        // The already-durable prepared record remains the recovery anchor.
      }
    }
    return status(profileKey, invocationId, 'recovery_required', finalPath, 'publication_temp_write_failed');
  }
  closeSync(fd);

  if (!record || !sameObject(tempPath, record.temp_dev, record.temp_ino)) {
    return status(profileKey, invocationId, 'recovery_required', finalPath, 'publication_identity_unreadable');
  }

  try {
    if (entryExists(finalPath)) {
      record = { ...record, state: 'collision', failure_cause: 'publication_commit_collision', updated_at: new Date().toISOString() };
      writeRecord(profileKey, record);
      return status(profileKey, invocationId, 'recovery_required', finalPath, 'publication_commit_collision');
    }
  } catch {
    record = { ...record, failure_cause: 'publication_destination_unreadable', updated_at: new Date().toISOString() };
    writeRecord(profileKey, record);
    return status(profileKey, invocationId, 'recovery_required', finalPath, 'publication_destination_unreadable');
  }

  const moved = noReplaceMove(tempPath, finalPath);
  if (!moved.ok) {
    record = {
      ...record,
      ...(moved.collision ? { state: 'collision' as const } : {}),
      failure_cause: moved.cause,
      updated_at: new Date().toISOString(),
    };
    writeRecord(profileKey, record);
    return status(profileKey, invocationId, 'recovery_required', finalPath, moved.cause ?? 'publication_commit_failed');
  }

  if (!sameObject(finalPath, record.temp_dev, record.temp_ino)) {
    record = { ...record, failure_cause: 'exclusive_commit_witness_mismatch', updated_at: new Date().toISOString() };
    writeRecord(profileKey, record);
    return status(profileKey, invocationId, 'recovery_required', finalPath, 'exclusive_commit_witness_mismatch');
  }

  try {
    fsyncDirectory(parent);
  } catch {
    record = { ...record, failure_cause: 'publication_directory_fsync_failed', updated_at: new Date().toISOString() };
    writeRecord(profileKey, record);
    return status(profileKey, invocationId, 'recovery_required', finalPath, 'publication_directory_fsync_failed');
  }

  const bytes = readFileSync(finalPath);
  record = {
    ...record,
    state: 'committed',
    output_bytes: bytes.byteLength,
    output_sha256: sha256(bytes),
    failure_cause: undefined,
    updated_at: new Date().toISOString(),
  };
  writeRecord(profileKey, record);
  return {
    ...status(profileKey, invocationId, 'committed_ok', finalPath),
    output_bytes: record.output_bytes,
    output_sha256: record.output_sha256,
  };
}

export function publicationStatus(profileKey: string, invocationId: string): PublicationStatusV1 {
  if (!validInvocationId(invocationId)) {
    return status(profileKey, invocationId, 'profile_blocked', undefined, 'publication_invocation_invalid');
  }
  const path = publicationPath(profileKey, invocationId);
  try {
    if (!entryExists(path)) return status(profileKey, invocationId, 'not_committed');
  } catch {
    return status(profileKey, invocationId, 'profile_blocked', undefined, 'publication_record_unreadable');
  }

  let record: PublicationRecordV1;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isCompatiblePublication(parsed, profileKey, invocationId)) {
      return status(profileKey, invocationId, 'profile_blocked', undefined, 'publication_record_incompatible');
    }
    record = parsed;
  } catch {
    return status(profileKey, invocationId, 'profile_blocked', undefined, 'publication_record_unreadable');
  }

  if (sameObject(record.output_path, record.temp_dev, record.temp_ino)) {
    const bytes = readFileSync(record.output_path);
    return {
      ...status(profileKey, invocationId, 'committed_ok', record.output_path),
      output_bytes: bytes.byteLength,
      output_sha256: sha256(bytes),
    };
  }

  let finalExists: boolean;
  let tempExists: boolean;
  try {
    finalExists = entryExists(record.output_path);
    tempExists = entryExists(record.temp_path);
  } catch {
    return status(profileKey, invocationId, 'recovery_required', record.output_path, 'publication_identity_unreadable');
  }
  const exactTempExists = tempExists && sameObject(record.temp_path, record.temp_dev, record.temp_ino);
  if (finalExists) return status(profileKey, invocationId, 'recovery_required', record.output_path, 'publication_commit_collision');
  if (record.state === 'committed') return status(profileKey, invocationId, 'conflict', record.output_path, 'committed_output_missing');
  if (record.state === 'collision') {
    return status(profileKey, invocationId, 'recovery_required', record.output_path, record.failure_cause ?? 'publication_commit_collision');
  }
  if (record.failure_cause) {
    return status(profileKey, invocationId, 'recovery_required', record.output_path, record.failure_cause);
  }
  if (exactTempExists) {
    const alive = pidAlive(record.owner_pid);
    return status(
      profileKey,
      invocationId,
      alive ? 'in_progress' : 'recovery_required',
      record.output_path,
      alive ? 'publication_in_progress' : 'prepared_without_live_owner',
    );
  }
  return status(profileKey, invocationId, 'recovery_required', record.output_path, 'publication_identity_missing');
}

export function discardUncommittedPublication(profileKey: string, invocationId: string, outputIdentity: string): boolean {
  if (!validInvocationId(invocationId)) return false;
  const path = publicationPath(profileKey, invocationId);
  let pathExists: boolean;
  try {
    pathExists = entryExists(path);
  } catch {
    return false;
  }
  if (!pathExists) return true;
  let record: PublicationRecordV1;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isCompatiblePublication(parsed, profileKey, invocationId)) return false;
    record = parsed;
  } catch {
    return false;
  }
  if (record.output_identity !== outputIdentity) return false;
  if (sameObject(record.output_path, record.temp_dev, record.temp_ino)) return false;
  let tempExists: boolean;
  try {
    tempExists = entryExists(record.temp_path);
  } catch {
    return false;
  }
  if (tempExists && !sameObject(record.temp_path, record.temp_dev, record.temp_ino)) return false;
  if (tempExists) unlinkSync(record.temp_path);
  unlinkSync(path);
  return true;
}
