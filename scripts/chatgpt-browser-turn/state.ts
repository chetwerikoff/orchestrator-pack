import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import {
  CAPABILITY_STATES,
  RECORD_SCHEMA,
  RECORD_VERSION,
  type CommonIncidentRecordV1,
  type ControlResultV1,
  type StatusItemV1,
} from './contracts.ts';
import { clearDomainLock } from './coordination.ts';
import { discardUncommittedPublication, publicationRecordCompatible } from './publication.ts';
import { atomicJson, fsyncDirectory, profileDirs, sha256 } from './storage-common.ts';

const INCIDENT_KINDS = new Set([
  'conversation_incident',
  'fresh_orphan',
  'profile_wall',
  'active_owner',
  'publication_incident',
]);
const INCIDENT_PHASES = new Set(['pre_send', 'possible_delivery', 'reply_complete', 'publication_prepared', 'committed']);

function bodyFreeToken(value: Omit<CommonIncidentRecordV1, 'evidence_token'>): string {
  return sha256(JSON.stringify(value));
}

function recordPath(profileKey: string, identity: string): string {
  return join(profileDirs(profileKey).records, `${identity}.json`);
}

function readKnownRecord(path: string, profileKey: string): CommonIncidentRecordV1 {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as CommonIncidentRecordV1;
  if (parsed.schema !== RECORD_SCHEMA
    || parsed.version !== RECORD_VERSION
    || parsed.configured_profile_key !== profileKey
    || !INCIDENT_KINDS.has(parsed.kind)
    || !INCIDENT_PHASES.has(parsed.phase)
    || !Number.isInteger(parsed.generation)
    || parsed.generation < 1) {
    throw new Error('incompatible_record');
  }
  const base = { ...parsed } as CommonIncidentRecordV1 & { evidence_token?: string };
  const token = base.evidence_token;
  delete base.evidence_token;
  if (!token || token !== bodyFreeToken(base as Omit<CommonIncidentRecordV1, 'evidence_token'>)) {
    throw new Error('incompatible_record');
  }
  return parsed;
}

export function writeIncident(
  profileKey: string,
  input: Omit<CommonIncidentRecordV1, 'schema' | 'version' | 'configured_profile_key' | 'evidence_token' | 'created_at' | 'updated_at'>,
): { identity: string; record: CommonIncidentRecordV1 } {
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
  atomicJson(recordPath(profileKey, identity), record);
  return { identity, record };
}

export function updateIncident(
  profileKey: string,
  identity: string,
  patch: Partial<CommonIncidentRecordV1>,
): CommonIncidentRecordV1 {
  const current = readKnownRecord(recordPath(profileKey, identity), profileKey);
  const base = { ...current, ...patch, updated_at: new Date().toISOString() } as CommonIncidentRecordV1 & { evidence_token?: string };
  delete base.evidence_token;
  const next = {
    ...base,
    evidence_token: bodyFreeToken(base as Omit<CommonIncidentRecordV1, 'evidence_token'>),
  } as CommonIncidentRecordV1;
  atomicJson(recordPath(profileKey, identity), next);
  return next;
}

export function deleteIncident(profileKey: string, identity: string): void {
  const path = recordPath(profileKey, identity);
  if (existsSync(path)) unlinkSync(path);
}

export function listReadableIncidents(profileKey: string): Array<{ identity: string; record: CommonIncidentRecordV1 }> {
  const result: Array<{ identity: string; record: CommonIncidentRecordV1 }> = [];
  for (const name of readdirSync(profileDirs(profileKey).records).sort()) {
    if (!name.endsWith('.json')) continue;
    const identity = name.slice(0, -5);
    result.push({ identity, record: readKnownRecord(join(profileDirs(profileKey).records, name), profileKey) });
  }
  return result;
}

function generationForOpaque(path: string): number {
  const stat = statSync(path, { bigint: true });
  return Number((stat.mtimeNs ^ stat.size ^ stat.ino) & 0x7fffffffn);
}

function encodeName(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeName(value: string): string | null {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

type OpaqueArea = 'records' | 'publications' | 'capability';

function opaquePath(profileKey: string, area: OpaqueArea, name: string): string | null {
  const d = profileDirs(profileKey);
  if (basename(name) !== name) return null;
  if (area === 'records') return join(d.records, name);
  if (area === 'publications') return join(d.publications, name);
  return name === 'capability.json' ? d.capability : null;
}

function opaqueStatusItem(profileKey: string, area: OpaqueArea, name: string): StatusItemV1 {
  const path = opaquePath(profileKey, area, name);
  if (!path) throw new Error('opaque_path_invalid');
  const bytes = readFileSync(path);
  const digest = sha256(bytes);
  return {
    identity: `opaque:${area}:${encodeName(name)}:${digest}`,
    kind: 'opaque_record',
    generation: generationForOpaque(path),
    evidence_token: digest,
    opaque: true,
  };
}

interface TombstoneV1 {
  readonly schema: 'chatgpt-browser-turn-tombstone/v1';
  readonly version: 1;
  readonly configured_profile_key: string;
  readonly identity: string;
  readonly generation: number;
  readonly source_area: OpaqueArea;
  readonly source_name: string;
  readonly source_generation: number;
  readonly source_digest: string;
  readonly quarantine_name: string;
  readonly state: 'preparing' | 'active';
  readonly created_at: string;
  readonly updated_at: string;
}

function readTombstone(path: string, profileKey: string): TombstoneV1 {
  const value = JSON.parse(readFileSync(path, 'utf8')) as TombstoneV1;
  if (value.schema !== 'chatgpt-browser-turn-tombstone/v1'
    || value.version !== 1
    || value.configured_profile_key !== profileKey
    || !['records', 'publications', 'capability'].includes(value.source_area)
    || !Number.isInteger(value.generation)
    || value.generation < 1
    || !/^[0-9a-f]{64}$/.test(value.source_digest)
    || !['preparing', 'active'].includes(value.state)) {
    throw new Error('bad_tombstone');
  }
  return value;
}

function control(
  operation: ControlResultV1['operation'],
  state: string,
  profileKey: string,
  cause?: string,
): ControlResultV1 {
  return {
    schema: 'control-result/v1',
    operation,
    state,
    configured_profile_key: profileKey,
    ...(cause ? { cause } : {}),
  };
}

export interface CapabilityRecordV1 {
  readonly schema: 'chatgpt-browser-turn-capability/v1';
  readonly version: 1;
  readonly configured_profile_key: string;
  readonly candidate_digest: string;
  readonly build_digest: string;
  readonly browser_provenance: string;
  readonly config_digest: string;
  readonly gate_digest: string;
  readonly evidence_digest: string;
  readonly observed_at: string;
  readonly expires_at: string;
  readonly downgrade_generation: number;
  readonly parallel_eligible: boolean;
}

function compatibleCapability(value: unknown, profileKey: string): value is CapabilityRecordV1 {
  if (!value || typeof value !== 'object') return false;
  const record = value as CapabilityRecordV1;
  return record.schema === 'chatgpt-browser-turn-capability/v1'
    && record.version === 1
    && record.configured_profile_key === profileKey
    && [record.candidate_digest, record.build_digest, record.config_digest, record.gate_digest, record.evidence_digest]
      .every((digest) => typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest))
    && typeof record.browser_provenance === 'string'
    && record.browser_provenance.length > 0
    && Number.isInteger(record.downgrade_generation)
    && record.downgrade_generation >= 0
    && typeof record.parallel_eligible === 'boolean';
}

export function writeCapability(
  profileKey: string,
  record: Omit<CapabilityRecordV1, 'schema' | 'version' | 'configured_profile_key'>,
): void {
  const observed = Date.parse(record.observed_at);
  const expires = Date.parse(record.expires_at);
  if (!Number.isFinite(observed)
    || !Number.isFinite(expires)
    || expires <= observed
    || expires - observed > 24 * 60 * 60 * 1000
    || ![record.candidate_digest, record.build_digest, record.config_digest, record.gate_digest, record.evidence_digest]
      .every((digest) => /^[0-9a-f]{64}$/.test(digest))) {
    throw new Error('invalid_capability');
  }
  atomicJson(profileDirs(profileKey).capability, {
    schema: 'chatgpt-browser-turn-capability/v1',
    version: 1,
    configured_profile_key: profileKey,
    ...record,
  });
}

export interface CapabilityBinding {
  readonly candidate_digest: string;
  readonly build_digest: string;
  readonly config_digest: string;
  readonly gate_digest: string;
}

export function capabilityStatus(
  profileKey: string,
  expected?: CapabilityBinding,
): ControlResultV1 & { capability?: CapabilityRecordV1 } {
  const listed = statusList(profileKey);
  if (listed.state === 'profile_blocked') {
    return { ...control('capability', 'profile_blocked', profileKey), complete: false };
  }
  const path = profileDirs(profileKey).capability;
  if (!existsSync(path)) return control('capability', 'no_evidence', profileKey);
  let capability: CapabilityRecordV1;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!compatibleCapability(parsed, profileKey)) return control('capability', 'profile_blocked', profileKey, 'capability_incompatible');
    capability = parsed;
  } catch {
    return control('capability', 'profile_blocked', profileKey, 'capability_unreadable');
  }

  const observed = Date.parse(capability.observed_at);
  const expires = Date.parse(capability.expires_at);
  if (!Number.isFinite(observed)
    || !Number.isFinite(expires)
    || expires <= observed
    || expires - observed > 24 * 60 * 60 * 1000
    || Date.now() > expires) {
    return { ...control('capability', 'expired', profileKey), capability };
  }
  if (expected && (
    capability.candidate_digest !== expected.candidate_digest
    || capability.build_digest !== expected.build_digest
    || capability.config_digest !== expected.config_digest
    || capability.gate_digest !== expected.gate_digest
  )) {
    return { ...control('capability', 'downgraded', profileKey, 'capability_binding_mismatch'), capability };
  }
  if (!capability.parallel_eligible) {
    return { ...control('capability', 'downgraded', profileKey), capability };
  }
  return { ...control('capability', 'ok', profileKey), capability };
}

export function downgradeCapability(profileKey: string): void {
  const path = profileDirs(profileKey).capability;
  if (!existsSync(path)) return;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!compatibleCapability(parsed, profileKey)) return;
    writeCapability(profileKey, {
      candidate_digest: parsed.candidate_digest,
      build_digest: parsed.build_digest,
      browser_provenance: parsed.browser_provenance,
      config_digest: parsed.config_digest,
      gate_digest: parsed.gate_digest,
      evidence_digest: parsed.evidence_digest,
      observed_at: parsed.observed_at,
      expires_at: parsed.expires_at,
      downgrade_generation: parsed.downgrade_generation + 1,
      parallel_eligible: false,
    });
  } catch {
    // An unreadable capability is already a profile block via status/list.
  }
}

export function statusList(profileKey: string): ControlResultV1 {
  const d = profileDirs(profileKey);
  const items: StatusItemV1[] = [];
  let blocked = false;

  for (const name of readdirSync(d.records).sort()) {
    if (!name.endsWith('.json')) continue;
    const path = join(d.records, name);
    try {
      const record = readKnownRecord(path, profileKey);
      items.push({
        identity: name.slice(0, -5),
        kind: record.kind,
        generation: record.generation,
        phase: record.phase,
        evidence_token: record.evidence_token,
        conversation_id: record.conversation_id,
        provisional_id: record.provisional_id,
        cause: record.cause,
      });
    } catch {
      blocked = true;
      try {
        items.push(opaqueStatusItem(profileKey, 'records', name));
      } catch {
        items.push({ identity: `opaque:records:${encodeName(name)}:unreadable`, kind: 'opaque_record', generation: 0, evidence_token: 'unreadable', opaque: true });
      }
    }
  }

  for (const name of readdirSync(d.tombstones).sort()) {
    blocked = true;
    try {
      const tombstone = readTombstone(join(d.tombstones, name), profileKey);
      items.push({
        identity: tombstone.identity,
        kind: 'blocking_tombstone',
        generation: tombstone.generation,
        evidence_token: tombstone.source_digest,
        opaque: true,
      });
    } catch {
      items.push({ identity: `tombstone:${name}:unreadable`, kind: 'blocking_tombstone', generation: 0, evidence_token: 'unreadable', opaque: true });
    }
  }

  if (existsSync(d.capability)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(d.capability, 'utf8'));
      if (!compatibleCapability(parsed, profileKey)) throw new Error('incompatible');
    } catch {
      blocked = true;
      try {
        items.push(opaqueStatusItem(profileKey, 'capability', 'capability.json'));
      } catch {
        items.push({ identity: 'opaque:capability:Y2FwYWJpbGl0eS5qc29u:unreadable', kind: 'opaque_record', generation: 0, evidence_token: 'unreadable', opaque: true });
      }
    }
  }

  for (const name of readdirSync(d.publications).sort()) {
    if (!name.endsWith('.json')) continue;
    const path = join(d.publications, name);
    if (publicationRecordCompatible(path, profileKey)) continue;
    blocked = true;
    try {
      items.push(opaqueStatusItem(profileKey, 'publications', name));
    } catch {
      items.push({ identity: `opaque:publications:${encodeName(name)}:unreadable`, kind: 'opaque_record', generation: 0, evidence_token: 'unreadable', opaque: true });
    }
  }

  return {
    schema: 'control-result/v1',
    operation: 'status/list',
    state: blocked ? 'profile_blocked' : (items.length > 0 ? 'ok' : 'none'),
    configured_profile_key: profileKey,
    complete: !blocked,
    items,
  };
}

function ownerAlive(record: CommonIncidentRecordV1): boolean {
  if (!record.owner?.pid) return false;
  try {
    process.kill(record.owner.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function clearReadable(
  profileKey: string,
  identity: string,
  generation: number,
  evidenceToken: string,
): ControlResultV1 {
  const path = recordPath(profileKey, identity);
  if (!existsSync(path)) return control('clear', 'not_found', profileKey);
  let record: CommonIncidentRecordV1;
  try {
    record = readKnownRecord(path, profileKey);
  } catch {
    return control('clear', 'profile_blocked', profileKey, 'opaque_record');
  }
  if (record.generation !== generation) return control('clear', 'stale_generation', profileKey);
  if (record.evidence_token !== evidenceToken) return control('clear', 'evidence_changed', profileKey);
  if (ownerAlive(record)) return control('clear', 'refused_active', profileKey);
  if (record.lock_key && !clearDomainLock(profileKey, record.lock_key)) {
    return control('clear', 'refused_active', profileKey, 'lock_active_or_unreadable');
  }
  if (record.kind === 'publication_incident' && record.invocation_id && record.output_identity) {
    if (!discardUncommittedPublication(profileKey, record.invocation_id, record.output_identity)) {
      return control('clear', 'refused_active', profileKey, 'publication_not_clearable');
    }
  }
  unlinkSync(path);
  return control('clear', 'cleared', profileKey);
}

function parseOpaqueIdentity(identity: string): { area: OpaqueArea; name: string; digest: string } | null {
  const match = /^opaque:(records|publications|capability):([^:]+):([0-9a-f]{64})$/.exec(identity);
  if (!match) return null;
  const name = decodeName(match[2]);
  if (!name) return null;
  return { area: match[1] as OpaqueArea, name, digest: match[3] };
}

export function quarantineOpaque(profileKey: string, identity: string, generation: number): ControlResultV1 {
  const parsed = parseOpaqueIdentity(identity);
  if (!parsed) return control('clear', 'not_found', profileKey);
  const source = opaquePath(profileKey, parsed.area, parsed.name);
  if (!source || !existsSync(source)) return control('clear', 'not_found', profileKey);
  let current: StatusItemV1;
  try {
    current = opaqueStatusItem(profileKey, parsed.area, parsed.name);
  } catch {
    return control('clear', 'profile_blocked', profileKey, 'opaque_record_unreadable');
  }
  if (current.identity !== identity || current.generation !== generation || current.evidence_token !== parsed.digest) {
    return control('clear', 'stale_generation', profileKey);
  }

  const d = profileDirs(profileKey);
  const tombstoneIdentity = `tombstone-${randomUUID()}`;
  const quarantineName = `${tombstoneIdentity}.opaque`;
  const now = new Date().toISOString();
  let tombstone: TombstoneV1 = {
    schema: 'chatgpt-browser-turn-tombstone/v1',
    version: 1,
    configured_profile_key: profileKey,
    identity: tombstoneIdentity,
    generation: 1,
    source_area: parsed.area,
    source_name: parsed.name,
    source_generation: generation,
    source_digest: current.evidence_token,
    quarantine_name: quarantineName,
    state: 'preparing',
    created_at: now,
    updated_at: now,
  };
  const tombstonePath = join(d.tombstones, `${tombstoneIdentity}.json`);
  atomicJson(tombstonePath, tombstone);
  renameSync(source, join(d.quarantine, quarantineName));
  fsyncDirectory(d.quarantine);
  fsyncDirectory(parsed.area === 'capability' ? d.root : parsed.area === 'records' ? d.records : d.publications);
  tombstone = { ...tombstone, state: 'active', updated_at: new Date().toISOString() };
  atomicJson(tombstonePath, tombstone);
  return control('clear', 'quarantined', profileKey);
}

export function adjudicateTombstone(
  profileKey: string,
  identity: string,
  generation: number,
  expectedEvidenceSha256: string,
  actualEvidenceSha256: string,
): ControlResultV1 {
  if (!/^[0-9a-f]{64}$/.test(expectedEvidenceSha256)
    || !/^[0-9a-f]{64}$/.test(actualEvidenceSha256)
    || expectedEvidenceSha256 !== actualEvidenceSha256) {
    return control('clear', 'evidence_changed', profileKey, 'adjudication_evidence_mismatch');
  }
  const d = profileDirs(profileKey);
  const tombstonePath = join(d.tombstones, `${identity}.json`);
  if (!existsSync(tombstonePath)) return control('clear', 'not_found', profileKey);
  let tombstone: TombstoneV1;
  try {
    tombstone = readTombstone(tombstonePath, profileKey);
  } catch {
    return control('clear', 'profile_blocked', profileKey, 'tombstone_incompatible');
  }
  if (tombstone.generation !== generation) return control('clear', 'stale_generation', profileKey);
  const quarantinePath = join(d.quarantine, tombstone.quarantine_name);
  if (!existsSync(quarantinePath) || sha256(readFileSync(quarantinePath)) !== tombstone.source_digest) {
    return control('clear', 'evidence_changed', profileKey, 'quarantine_bytes_changed');
  }

  atomicJson(join(d.resolved, `${identity}.json`), {
    ...tombstone,
    adjudication_evidence_sha256: expectedEvidenceSha256,
    resolved_at: new Date().toISOString(),
  });
  renameSync(quarantinePath, join(d.resolved, `${identity}.opaque`));
  fsyncDirectory(d.resolved);
  fsyncDirectory(d.quarantine);
  unlinkSync(tombstonePath);
  fsyncDirectory(d.tombstones);
  return control('clear', 'cleared', profileKey);
}

export function isCapabilityState(value: string): boolean {
  return (CAPABILITY_STATES as readonly string[]).includes(value);
}
