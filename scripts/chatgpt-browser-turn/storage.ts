import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  RECORD_SCHEMA, RECORD_VERSION, type CommonIncidentRecordV1, type ControlResultV1,
  type PublicationStatusV1, type StatusItemV1,
} from './contracts.ts';

const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });
const STORE_ROOT = process.env.CHATGPT_BROWSER_TURN_STATE_DIR
  ? resolve(process.env.CHATGPT_BROWSER_TURN_STATE_DIR)
  : join(homedir(), '.local', 'state', 'orchestrator-pack', 'chatgpt-browser-turn');

export function sha256(value: string|Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function configuredProfileKey(profile: string, cdp: string): string {
  const normalizedProfile = process.platform === 'win32' ? resolve(profile).toLowerCase() : resolve(profile);
  const normalizedCdp = new URL(cdp).toString().replace(/\/$/, '');
  return `profile-${sha256(`${normalizedProfile}\n${normalizedCdp}`).slice(0, 32)}`;
}

export interface InputSnapshot {
  text: string;
  bytes: Uint8Array;
  dev: bigint;
  ino: bigint;
}

export function readStableInput(path: string): InputSnapshot {
  const absolute = resolve(path);
  const before = lstatSync(absolute, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('input_invalid:not_regular_nonsymlink');
  const bytes = readFileSync(absolute);
  const after = lstatSync(absolute, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || BigInt(bytes.byteLength) !== after.size) {
    throw new Error('input_invalid:changed_during_snapshot');
  }
  if (bytes.byteLength === 0) throw new Error('input_invalid:empty');
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error('input_invalid:bom');
  if (bytes.includes(0)) throw new Error('input_invalid:nul');
  let text: string;
  try { text = UTF8_FATAL.decode(bytes); } catch { throw new Error('input_invalid:utf8'); }
  if (/(^|[^\r])\r(?!\n)/.test(text)) throw new Error('input_invalid:bare_cr');
  return { text, bytes, dev: before.dev, ino: before.ino };
}

interface ProfileDirs {
  root: string;
  records: string;
  quarantine: string;
  tombstones: string;
  resolved: string;
  reservations: string;
  publications: string;
  capability: string;
  locks: string;
}

function dirs(profileKey: string): ProfileDirs {
  const root = join(STORE_ROOT, profileKey);
  const result = {
    root,
    records: join(root, 'records'),
    quarantine: join(root, 'quarantine'),
    tombstones: join(root, 'tombstones'),
    resolved: join(root, 'resolved'),
    reservations: join(root, 'reservations'),
    publications: join(root, 'publications'),
    capability: join(root, 'capability.json'),
    locks: join(root, 'locks'),
  };
  for (const path of [root, result.records, result.quarantine, result.tombstones, result.resolved, result.reservations, result.publications, result.locks]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  return result;
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temp, path);
}

function bodyFreeToken(value: Omit<CommonIncidentRecordV1, 'evidence_token'>): string {
  return sha256(JSON.stringify(value));
}

export function writeIncident(
  profileKey: string,
  input: Omit<CommonIncidentRecordV1, 'schema'|'version'|'configured_profile_key'|'evidence_token'|'created_at'|'updated_at'>,
): { identity: string; record: CommonIncidentRecordV1 } {
  const d = dirs(profileKey);
  const now = new Date().toISOString();
  const base = {
    schema: RECORD_SCHEMA,
    version: RECORD_VERSION,
    configured_profile_key: profileKey,
    created_at: now,
    updated_at: now,
    ...input,
  } as Omit<CommonIncidentRecordV1, 'evidence_token'>;
  const record: CommonIncidentRecordV1 = { ...base, evidence_token: bodyFreeToken(base) };
  const identity = `record-${randomUUID()}`;
  atomicJson(join(d.records, `${identity}.json`), record);
  return { identity, record };
}

export function updateIncident(profileKey: string, identity: string, patch: Partial<CommonIncidentRecordV1>): CommonIncidentRecordV1 {
  const path = join(dirs(profileKey).records, `${identity}.json`);
  const current = readKnownRecord(path, profileKey);
  const base = { ...current, ...patch, updated_at: new Date().toISOString() };
  delete (base as { evidence_token?: string }).evidence_token;
  const next = { ...base, evidence_token: bodyFreeToken(base) } as CommonIncidentRecordV1;
  atomicJson(path, next);
  return next;
}

function readKnownRecord(path: string, profileKey: string): CommonIncidentRecordV1 {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as CommonIncidentRecordV1;
  if (parsed.schema !== RECORD_SCHEMA || parsed.version !== RECORD_VERSION || parsed.configured_profile_key !== profileKey) {
    throw new Error('incompatible_record');
  }
  if (!Number.isInteger(parsed.generation) || parsed.generation < 0 || !parsed.kind || !parsed.phase) throw new Error('incompatible_record');
  const base = { ...parsed } as CommonIncidentRecordV1 & { evidence_token?: string };
  const token = base.evidence_token;
  delete base.evidence_token;
  if (!token || token !== bodyFreeToken(base as Omit<CommonIncidentRecordV1, 'evidence_token'>)) throw new Error('incompatible_record');
  return parsed;
}

function generationForOpaque(path: string): number {
  const s = statSync(path, { bigint: true });
  return Number((s.mtimeNs ^ s.size ^ s.ino) & 0x7fffffffn);
}

function opaqueStatusItem(path: string): StatusItemV1 {
  const bytes = readFileSync(path);
  const digest = sha256(bytes);
  return {
    identity: `opaque:${basename(path)}:${digest}`,
    kind: 'opaque_record',
    generation: generationForOpaque(path),
    evidence_token: digest,
    opaque: true,
  };
}

interface TombstoneV1 {
  schema: 'chatgpt-browser-turn-tombstone/v1';
  version: 1;
  configured_profile_key: string;
  identity: string;
  generation: number;
  source_identity: string;
  source_generation: number;
  source_digest: string;
  quarantine_name: string;
  state: 'preparing'|'active';
  adjudication_evidence_sha256?: string;
  created_at: string;
  updated_at: string;
}

function readTombstone(path: string, profileKey: string): TombstoneV1 {
  const t = JSON.parse(readFileSync(path, 'utf8')) as TombstoneV1;
  if (t.schema !== 'chatgpt-browser-turn-tombstone/v1' || t.version !== 1 || t.configured_profile_key !== profileKey) throw new Error('bad_tombstone');
  return t;
}

export function statusList(profileKey: string): ControlResultV1 {
  const d = dirs(profileKey);
  const items: StatusItemV1[] = [];
  let blocked = false;
  for (const name of readdirSync(d.records).sort()) {
    const path = join(d.records, name);
    try {
      const record = readKnownRecord(path, profileKey);
      items.push({
        identity: name.replace(/\.json$/, ''), kind: record.kind, generation: record.generation,
        phase: record.phase, evidence_token: record.evidence_token, conversation_id: record.conversation_id,
        provisional_id: record.provisional_id, cause: record.cause,
      });
    } catch {
      blocked = true;
      try { items.push(opaqueStatusItem(path)); } catch {
        items.push({ identity: `opaque:${name}:unreadable`, kind: 'opaque_record', generation: 0, evidence_token: 'unreadable', opaque: true });
      }
    }
  }
  for (const name of readdirSync(d.tombstones).sort()) {
    blocked = true;
    try {
      const t = readTombstone(join(d.tombstones, name), profileKey);
      items.push({ identity: t.identity, kind: 'blocking_tombstone', generation: t.generation, evidence_token: t.source_digest, opaque: true });
    } catch {
      items.push({ identity: `tombstone:${name}:unreadable`, kind: 'blocking_tombstone', generation: 0, evidence_token: 'unreadable', opaque: true });
    }
  }
  return {
    schema: 'control-result/v1', operation: 'status/list',
    state: blocked ? 'profile_blocked' : (items.length ? 'ok' : 'none'),
    configured_profile_key: profileKey, complete: !blocked, items,
  };
}

function ownerAlive(record: CommonIncidentRecordV1): boolean {
  if (!record.owner?.pid) return false;
  try { process.kill(record.owner.pid, 0); return true; } catch { return false; }
}

export function clearReadable(profileKey: string, identity: string, generation: number, evidenceToken: string): ControlResultV1 {
  const d = dirs(profileKey);
  const path = join(d.records, `${identity}.json`);
  if (!existsSync(path)) return control('clear', 'not_found', profileKey);
  let record: CommonIncidentRecordV1;
  try { record = readKnownRecord(path, profileKey); } catch { return control('clear', 'profile_blocked', profileKey, 'opaque_record'); }
  if (record.generation !== generation) return control('clear', 'stale_generation', profileKey);
  if (record.evidence_token !== evidenceToken) return control('clear', 'evidence_changed', profileKey);
  if (ownerAlive(record)) return control('clear', 'refused_active', profileKey);
  if (record.lock_key && !clearDomainLock(profileKey, record.lock_key)) return control('clear', 'refused_active', profileKey);
  unlinkSync(path);
  return control('clear', 'cleared', profileKey);
}

export function quarantineOpaque(profileKey: string, identity: string, generation: number): ControlResultV1 {
  const d = dirs(profileKey);
  const match = /^opaque:([^:]+):([0-9a-f]{64})$/.exec(identity);
  if (!match) return control('clear', 'not_found', profileKey);
  const source = join(d.records, match[1]);
  if (!existsSync(source)) return control('clear', 'not_found', profileKey);
  const current = opaqueStatusItem(source);
  if (current.identity !== identity || current.generation !== generation) return control('clear', 'stale_generation', profileKey);
  const tombIdentity = `tombstone-${randomUUID()}`;
  const quarantineName = `${tombIdentity}.opaque`;
  const now = new Date().toISOString();
  const tomb: TombstoneV1 = {
    schema: 'chatgpt-browser-turn-tombstone/v1', version: 1, configured_profile_key: profileKey,
    identity: tombIdentity, generation: 1, source_identity: identity, source_generation: generation,
    source_digest: current.evidence_token, quarantine_name: quarantineName, state: 'preparing', created_at: now, updated_at: now,
  };
  const tombPath = join(d.tombstones, `${tombIdentity}.json`);
  atomicJson(tombPath, tomb);
  renameSync(source, join(d.quarantine, quarantineName));
  tomb.state = 'active'; tomb.updated_at = new Date().toISOString();
  atomicJson(tombPath, tomb);
  return control('clear', 'quarantined', profileKey);
}

export function adjudicateTombstone(profileKey: string, identity: string, generation: number, evidenceSha256: string): ControlResultV1 {
  if (!/^[0-9a-f]{64}$/.test(evidenceSha256)) return control('clear', 'evidence_changed', profileKey, 'invalid_evidence_digest');
  const d = dirs(profileKey);
  const path = join(d.tombstones, `${identity}.json`);
  if (!existsSync(path)) return control('clear', 'not_found', profileKey);
  let tomb: TombstoneV1;
  try { tomb = readTombstone(path, profileKey); } catch { return control('clear', 'profile_blocked', profileKey); }
  if (tomb.generation !== generation) return control('clear', 'stale_generation', profileKey);
  if (tomb.adjudication_evidence_sha256 && tomb.adjudication_evidence_sha256 !== evidenceSha256) {
    return control('clear', 'evidence_changed', profileKey);
  }
  if (!tomb.adjudication_evidence_sha256) {
    tomb.adjudication_evidence_sha256 = evidenceSha256;
    tomb.updated_at = new Date().toISOString();
    atomicJson(path, tomb);
  }
  const resolved = { ...tomb, resolved_at: new Date().toISOString() };
  atomicJson(join(d.resolved, `${identity}.json`), resolved);
  unlinkSync(path);
  return control('clear', 'cleared', profileKey);
}

function control(operation: ControlResultV1['operation'], state: string, profileKey: string, cause?: string): ControlResultV1 {
  return { schema: 'control-result/v1', operation, state, configured_profile_key: profileKey, ...(cause ? { cause } : {}) };
}

export interface CapabilityRecordV1 {
  schema: 'chatgpt-browser-turn-capability/v1';
  version: 1;
  configured_profile_key: string;
  candidate_digest: string;
  build_digest: string;
  browser_provenance: string;
  config_digest: string;
  gate_digest: string;
  evidence_digest: string;
  observed_at: string;
  expires_at: string;
  downgrade_generation: number;
  parallel_eligible: boolean;
}

export function writeCapability(profileKey: string, record: Omit<CapabilityRecordV1, 'schema'|'version'|'configured_profile_key'>): void {
  const observed = Date.parse(record.observed_at); const expires = Date.parse(record.expires_at);
  if (!Number.isFinite(observed) || !Number.isFinite(expires) || expires <= observed || expires - observed > 24*60*60*1000) throw new Error('invalid_capability_ttl');
  atomicJson(dirs(profileKey).capability, { schema: 'chatgpt-browser-turn-capability/v1', version: 1, configured_profile_key: profileKey, ...record });
}

export function capabilityStatus(profileKey: string): ControlResultV1 & { capability?: CapabilityRecordV1 } {
  const listed = statusList(profileKey);
  if (listed.state === 'profile_blocked') return { ...control('capability', 'profile_blocked', profileKey), complete: false };
  const path = dirs(profileKey).capability;
  if (!existsSync(path)) return control('capability', 'no_evidence', profileKey);
  let cap: CapabilityRecordV1;
  try { cap = JSON.parse(readFileSync(path, 'utf8')) as CapabilityRecordV1; } catch { return control('capability', 'profile_blocked', profileKey, 'capability_unreadable'); }
  if (cap.schema !== 'chatgpt-browser-turn-capability/v1' || cap.version !== 1 || cap.configured_profile_key !== profileKey) return control('capability', 'profile_blocked', profileKey, 'capability_incompatible');
  const now = Date.now(); const observed = Date.parse(cap.observed_at); const expires = Date.parse(cap.expires_at);
  if (!Number.isFinite(observed) || !Number.isFinite(expires) || expires <= observed || expires - observed > 24*60*60*1000 || now > expires) {
    return { ...control('capability', 'expired', profileKey), capability: cap };
  }
  if (!cap.parallel_eligible) return { ...control('capability', 'downgraded', profileKey), capability: cap };
  return { ...control('capability', 'ok', profileKey), capability: cap };
}

export interface DomainLock {
  key: string;
  generation: number;
  phase: 'pre_send'|'possible_delivery';
  updatePhase(phase: 'pre_send'|'possible_delivery'): void;
  release(): void;
}

interface LockRecordV1 {
  schema: 'chatgpt-browser-turn-lock/v1';
  version: 1;
  configured_profile_key: string;
  key: string;
  generation: number;
  pid: number;
  process_start_token: string;
  nonce: string;
  phase: 'pre_send'|'possible_delivery';
  created_at: string;
  updated_at: string;
}

function processStartToken(pid: number): string {
  if (process.platform !== 'linux') return pid === process.pid ? `${process.pid}:${process.uptime().toFixed(3)}` : '';
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    return fields[19] ?? '';
  } catch { return ''; }
}

function lockPath(profileKey: string, key: string): string {
  return join(dirs(profileKey).locks, `${sha256(key)}.lock`);
}

function writeLockExclusive(path: string, value: LockRecordV1): boolean {
  let fd: number;
  try { fd = openSync(path, 'wx', 0o600); } catch { return false; }
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
  return true;
}

function readLock(path: string): LockRecordV1 | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as LockRecordV1;
    if (value.schema !== 'chatgpt-browser-turn-lock/v1' || value.version !== 1) return null;
    return value;
  } catch { return null; }
}

function ownerProvablyDead(lock: LockRecordV1): boolean {
  const current = processStartToken(lock.pid);
  return !current || current !== lock.process_start_token;
}

export function acquireDomainLock(profileKey: string, key: string, staleMs = 120_000): DomainLock | null {
  const path = lockPath(profileKey, key);
  const now = new Date().toISOString();
  const create = (generation: number): LockRecordV1 => ({
    schema: 'chatgpt-browser-turn-lock/v1', version: 1, configured_profile_key: profileKey,
    key, generation, pid: process.pid, process_start_token: processStartToken(process.pid), nonce: randomUUID(),
    phase: 'pre_send', created_at: now, updated_at: now,
  });
  let record = create(1);
  if (!writeLockExclusive(path, record)) {
    const previous = readLock(path);
    if (!previous || previous.configured_profile_key !== profileKey || previous.key !== key) return null;
    const age = Date.now() - Date.parse(previous.updated_at);
    if (previous.phase !== 'pre_send' || age < staleMs || !ownerProvablyDead(previous)) return null;
    try { unlinkSync(path); } catch { return null; }
    record = create(previous.generation + 1);
    if (!writeLockExclusive(path, record)) return null;
  }
  const assertOwned = (): LockRecordV1 => {
    const current = readLock(path);
    if (!current || current.nonce !== record.nonce || current.process_start_token !== record.process_start_token) throw new Error('lock_ownership_lost');
    return current;
  };
  return {
    key, generation: record.generation, phase: record.phase,
    updatePhase(phase) {
      const current = assertOwned();
      record = { ...current, phase, updated_at: new Date().toISOString() };
      atomicJson(path, record);
      this.phase = phase;
    },
    release() {
      assertOwned();
      unlinkSync(path);
    },
  };
}

export function clearDomainLock(profileKey: string, key: string): boolean {
  const path = lockPath(profileKey, key);
  if (!existsSync(path)) return true;
  const lock = readLock(path);
  if (!lock || !ownerProvablyDead(lock)) return false;
  try { unlinkSync(path); return true; } catch { return false; }
}

export interface Reservation { identity: string; release(): void; }

export function reserveDestination(profileKey: string, outputPath: string): Reservation {
  const absolute = resolve(outputPath);
  const parent = realpathSync(dirname(absolute));
  const canonical = join(parent, basename(absolute));
  if (existsSync(canonical)) throw new Error('output_conflict:exists');
  const keyPath = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const identity = `output-${sha256(keyPath)}`;
  const reservation = join(dirs(profileKey).reservations, `${identity}.lock`);
  const fd = openSync(reservation, 'wx', 0o600);
  writeFileSync(fd, `${JSON.stringify({ version: 1, profile: profileKey, output_identity: identity, pid: process.pid, created_at: new Date().toISOString() })}\n`);
  fsyncSync(fd); closeSync(fd);
  return { identity, release() { try { unlinkSync(reservation); } catch {} } };
}

interface PublicationRecordV1 {
  schema: 'chatgpt-browser-turn-publication/v1';
  version: 1;
  configured_profile_key: string;
  invocation_id: string;
  output_path: string;
  output_identity: string;
  temp_path: string;
  temp_dev: string;
  temp_ino: string;
  state: 'prepared'|'committed'|'collision';
  output_bytes?: number;
  output_sha256?: string;
  created_at: string;
  updated_at: string;
}

function publicationPath(profileKey: string, invocationId: string): string {
  return join(dirs(profileKey).publications, `${invocationId}.json`);
}

function atomicNoReplaceRename(temp: string, finalPath: string): { ok: boolean; collision: boolean; cause?: string } {
  if (process.platform !== 'linux') return { ok: false, collision: false, cause: 'atomic_noreplace_unsupported_platform' };
  const probe = spawnSync('mv', ['--help'], { encoding: 'utf8' });
  if (probe.status !== 0 || !probe.stdout.includes('none-fail') || !probe.stdout.includes('--no-copy')) {
    return { ok: false, collision: false, cause: 'atomic_noreplace_primitive_unavailable' };
  }
  const run = spawnSync('mv', ['--update=none-fail', '--no-copy', '--no-target-directory', temp, finalPath], { encoding: 'utf8' });
  if (run.status === 0) return { ok: true, collision: false };
  if (existsSync(finalPath) && existsSync(temp)) return { ok: false, collision: true, cause: 'publication_commit_collision' };
  return { ok: false, collision: false, cause: `atomic_rename_failed:${run.status ?? 'signal'}` };
}

export function publishReply(profileKey: string, invocationId: string, outputPath: string, outputIdentity: string, reply: string): PublicationStatusV1 {
  const finalPath = resolve(outputPath);
  if (existsSync(finalPath)) return publication(profileKey, invocationId, 'conflict', finalPath, 'publication_commit_collision');
  const temp = join(dirname(finalPath), `.${basename(finalPath)}.${invocationId}.${randomUUID()}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, reply, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
  const tempStat = statSync(temp, { bigint: true });
  const now = new Date().toISOString();
  const rec: PublicationRecordV1 = {
    schema: 'chatgpt-browser-turn-publication/v1', version: 1, configured_profile_key: profileKey,
    invocation_id: invocationId, output_path: finalPath, output_identity: outputIdentity, temp_path: temp,
    temp_dev: String(tempStat.dev), temp_ino: String(tempStat.ino), state: 'prepared', created_at: now, updated_at: now,
  };
  atomicJson(publicationPath(profileKey, invocationId), rec);
  const moved = atomicNoReplaceRename(temp, finalPath);
  if (!moved.ok) {
    if (moved.collision) { rec.state = 'collision'; rec.updated_at = new Date().toISOString(); atomicJson(publicationPath(profileKey, invocationId), rec); }
    return publication(profileKey, invocationId, moved.collision ? 'recovery_required' : 'conflict', finalPath, moved.cause);
  }
  const finalStat = statSync(finalPath, { bigint: true });
  if (String(finalStat.dev) !== rec.temp_dev || String(finalStat.ino) !== rec.temp_ino) {
    return publication(profileKey, invocationId, 'recovery_required', finalPath, 'exclusive_commit_witness_mismatch');
  }
  const bytes = readFileSync(finalPath);
  rec.state = 'committed'; rec.output_bytes = bytes.byteLength; rec.output_sha256 = sha256(bytes); rec.updated_at = new Date().toISOString();
  atomicJson(publicationPath(profileKey, invocationId), rec);
  return { ...publication(profileKey, invocationId, 'committed_ok', finalPath), output_bytes: rec.output_bytes, output_sha256: rec.output_sha256 };
}

function publication(profileKey: string, invocationId: string, state: PublicationStatusV1['state'], outputPath?: string, cause?: string): PublicationStatusV1 {
  return { schema: 'publication-status/v1', state, configured_profile_key: profileKey, invocation_id: invocationId,
    ...(outputPath ? { output_path: outputPath } : {}), ...(cause ? { cause } : {}) };
}

export function publicationStatus(profileKey: string, invocationId: string): PublicationStatusV1 {
  const path = publicationPath(profileKey, invocationId);
  if (!existsSync(path)) {
    if (statusList(profileKey).state === 'profile_blocked') return publication(profileKey, invocationId, 'profile_blocked');
    return publication(profileKey, invocationId, 'not_committed');
  }
  let rec: PublicationRecordV1;
  try { rec = JSON.parse(readFileSync(path, 'utf8')) as PublicationRecordV1; } catch { return publication(profileKey, invocationId, 'profile_blocked', undefined, 'publication_record_unreadable'); }
  if (rec.schema !== 'chatgpt-browser-turn-publication/v1' || rec.version !== 1 || rec.configured_profile_key !== profileKey || rec.invocation_id !== invocationId) {
    return publication(profileKey, invocationId, 'profile_blocked', undefined, 'publication_record_incompatible');
  }
  if (existsSync(rec.output_path)) {
    const s = statSync(rec.output_path, { bigint: true });
    if (String(s.dev) === rec.temp_dev && String(s.ino) === rec.temp_ino) {
      const bytes = readFileSync(rec.output_path);
      return { ...publication(profileKey, invocationId, 'committed_ok', rec.output_path), output_bytes: bytes.byteLength, output_sha256: sha256(bytes) };
    }
    if (rec.state === 'prepared' || rec.state === 'collision') return publication(profileKey, invocationId, 'conflict', rec.output_path, 'exclusive_commit_witness_mismatch');
  }
  if (rec.state === 'collision') return publication(profileKey, invocationId, 'recovery_required', rec.output_path, 'publication_commit_collision');
  if (rec.state === 'prepared' && existsSync(rec.temp_path)) return publication(profileKey, invocationId, 'in_progress', rec.output_path);
  return publication(profileKey, invocationId, 'not_committed', rec.output_path);
}

export function deleteIncident(profileKey: string, identity: string): void {
  const path = join(dirs(profileKey).records, `${identity}.json`);
  if (existsSync(path)) unlinkSync(path);
}
