import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
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
import {
  acquireDomainLock,
  clearDomainLock,
  reconcileAbandonedSchedulingConflicts,
  type DomainLock,
} from './coordination.ts';
import { recordSwallowedDriverException } from './diagnostics.ts';
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

function validRecordIdentity(identity: string): boolean {
  return /^record-[0-9a-f-]{36}$/i.test(identity) && basename(identity) === identity;
}

function recordPath(profileKey: string, identity: string): string {
  if (!validRecordIdentity(identity)) throw new Error('record_identity_invalid');
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
  const { evidence_token: token, ...base } = parsed;
  if (!token || token !== bodyFreeToken(base)) {
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
  const merged: CommonIncidentRecordV1 = { ...current, ...patch, updated_at: new Date().toISOString() };
  const { evidence_token: _previousToken, ...base } = merged;
  const next: CommonIncidentRecordV1 = {
    ...base,
    evidence_token: bodyFreeToken(base),
  };
  atomicJson(recordPath(profileKey, identity), next);
  return next;
}

export function deleteIncident(profileKey: string, identity: string): void {
  if (!validRecordIdentity(identity)) return;
  const path = recordPath(profileKey, identity);
  if (existsSync(path)) unlinkSync(path);
}

export function listReadableIncidents(profileKey: string): Array<{ identity: string; record: CommonIncidentRecordV1 }> {
  const result: Array<{ identity: string; record: CommonIncidentRecordV1 }> = [];
  for (const name of readdirSync(profileDirs(profileKey).records).sort()) {
    if (!name.endsWith('.json')) continue;
    const identity = name.slice(0, -5);
    if (!validRecordIdentity(identity)) throw new Error('incompatible_record');
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

function regularBytes(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('non_regular_state_artifact');
  return readFileSync(path);
}

function opaqueStatusItem(profileKey: string, area: OpaqueArea, name: string): StatusItemV1 {
  const path = opaquePath(profileKey, area, name);
  if (!path) throw new Error('opaque_path_invalid');
  const bytes = regularBytes(path);
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

interface TombstoneResolutionV1 extends TombstoneV1 {
  readonly adjudication_evidence_sha256: string;
  readonly resolved_at: string;
}

export interface AdjudicationTestHooks {
  readonly afterResolutionRecord?: () => void;
  readonly afterResolvedMove?: () => void;
}

function validTombstoneIdentity(identity: string): boolean {
  return /^tombstone-[0-9a-f-]{36}$/i.test(identity) && basename(identity) === identity;
}

function readTombstone(path: string, profileKey: string): TombstoneV1 {
  const value = JSON.parse(regularBytes(path).toString('utf8')) as TombstoneV1;
  const sourceNameValid = basename(value.source_name ?? '') === value.source_name
    && (value.source_area === 'capability' ? value.source_name === 'capability.json' : value.source_name.endsWith('.json'));
  if (value.schema !== 'chatgpt-browser-turn-tombstone/v1'
    || value.version !== 1
    || value.configured_profile_key !== profileKey
    || !validTombstoneIdentity(value.identity)
    || !['records', 'publications', 'capability'].includes(value.source_area)
    || !sourceNameValid
    || !Number.isInteger(value.generation)
    || value.generation < 1
    || !Number.isInteger(value.source_generation)
    || value.source_generation < 0
    || !/^[0-9a-f]{64}$/.test(value.source_digest)
    || basename(value.quarantine_name ?? '') !== value.quarantine_name
    || value.quarantine_name !== `${value.identity}.opaque`
    || !['preparing', 'active'].includes(value.state)
    || !Number.isFinite(Date.parse(value.created_at))
    || !Number.isFinite(Date.parse(value.updated_at))) {
    throw new Error('bad_tombstone');
  }
  return value;
}

function readTombstoneResolution(
  path: string,
  profileKey: string,
  tombstone: TombstoneV1,
  evidenceSha256: string,
): TombstoneResolutionV1 {
  const value = JSON.parse(regularBytes(path).toString('utf8')) as TombstoneResolutionV1;
  if (value.schema !== tombstone.schema
    || value.version !== tombstone.version
    || value.configured_profile_key !== profileKey
    || value.identity !== tombstone.identity
    || value.generation !== tombstone.generation
    || value.source_area !== tombstone.source_area
    || value.source_name !== tombstone.source_name
    || value.source_generation !== tombstone.source_generation
    || value.source_digest !== tombstone.source_digest
    || value.quarantine_name !== tombstone.quarantine_name
    || value.state !== 'active'
    || value.created_at !== tombstone.created_at
    || value.updated_at !== tombstone.updated_at
    || value.adjudication_evidence_sha256 !== evidenceSha256
    || !Number.isFinite(Date.parse(value.resolved_at))) {
    throw new Error('bad_tombstone_resolution');
  }
  return value;
}

function quarantineStatusItem(path: string, identity: string, generation: number, expectedDigest?: string): StatusItemV1 {
  const bytes = regularBytes(path);
  const digest = sha256(bytes);
  return {
    identity,
    kind: 'opaque_quarantine',
    generation,
    evidence_token: digest,
    cause: expectedDigest && digest !== expectedDigest ? 'quarantine_bytes_changed' : undefined,
    opaque: true,
  };
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

export type AdmissionPolicy = 'parallel' | 'serialized';

export interface CapabilityRecordV2 {
  readonly schema: 'chatgpt-browser-turn-capability/v2';
  readonly version: 2;
  readonly configured_profile_key: string;
  readonly candidate_digest: string;
  readonly build_digest: string;
  readonly browser_provenance: string;
  readonly config_digest: string;
  readonly gate_digest: string;
  readonly evidence_digest: string;
  readonly characterized_at: string;
  readonly admission_policy: AdmissionPolicy;
  readonly admission_epoch: number;
}

interface LegacyCapabilityRecordV1 {
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

function validCapabilityDigests(record: {
  readonly candidate_digest: string;
  readonly build_digest: string;
  readonly config_digest: string;
  readonly gate_digest: string;
  readonly evidence_digest: string;
}): boolean {
  return [record.candidate_digest, record.build_digest, record.config_digest, record.gate_digest, record.evidence_digest]
    .every((digest) => typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest));
}

function compatibleLegacyCapabilityV1(value: unknown, profileKey: string): value is LegacyCapabilityRecordV1 {
  if (!value || typeof value !== 'object') return false;
  const record = value as LegacyCapabilityRecordV1;
  return record.schema === 'chatgpt-browser-turn-capability/v1'
    && record.version === 1
    && record.configured_profile_key === profileKey
    && validCapabilityDigests(record)
    && typeof record.browser_provenance === 'string'
    && record.browser_provenance.length > 0
    && Number.isInteger(record.downgrade_generation)
    && record.downgrade_generation >= 0
    && typeof record.parallel_eligible === 'boolean'
    && typeof record.observed_at === 'string'
    && typeof record.expires_at === 'string';
}

function compatibleCapabilityV2(value: unknown, profileKey: string): value is CapabilityRecordV2 {
  if (!value || typeof value !== 'object') return false;
  const record = value as CapabilityRecordV2;
  return record.schema === 'chatgpt-browser-turn-capability/v2'
    && record.version === 2
    && record.configured_profile_key === profileKey
    && validCapabilityDigests(record)
    && typeof record.browser_provenance === 'string'
    && record.browser_provenance.length > 0
    && typeof record.characterized_at === 'string'
    && Number.isFinite(Date.parse(record.characterized_at))
    && (record.admission_policy === 'parallel' || record.admission_policy === 'serialized')
    && Number.isInteger(record.admission_epoch)
    && record.admission_epoch >= 0;
}

function migrateLegacyCapabilityV1(record: LegacyCapabilityRecordV1): CapabilityRecordV2 {
  return {
    schema: 'chatgpt-browser-turn-capability/v2',
    version: 2,
    configured_profile_key: record.configured_profile_key,
    candidate_digest: record.candidate_digest,
    build_digest: record.build_digest,
    browser_provenance: record.browser_provenance,
    config_digest: record.config_digest,
    gate_digest: record.gate_digest,
    evidence_digest: record.evidence_digest,
    characterized_at: record.observed_at,
    admission_policy: 'serialized',
    admission_epoch: record.downgrade_generation,
  };
}

function normalizeCapabilityRecord(value: unknown, profileKey: string): CapabilityRecordV2 | null {
  if (compatibleCapabilityV2(value, profileKey)) return value;
  if (compatibleLegacyCapabilityV1(value, profileKey)) return migrateLegacyCapabilityV1(value);
  return null;
}

const CAPABILITY_MUTATION_LOCK_STALE_MS = 5_000;
const CAPABILITY_MUTATION_LOCK_WAIT_MS = 10_000;
const CAPABILITY_MUTATION_LOCK_RETRY_MS = 10;

export interface CapabilityBinding {
  readonly candidate_digest: string;
  readonly build_digest: string;
  readonly config_digest: string;
  readonly gate_digest: string;
}

export interface CapabilityTurnCompletion {
  readonly expectedBinding: CapabilityBinding;
  readonly browserProvenance: string;
  readonly evidenceDigest: string;
  readonly witnessed: boolean;
  readonly invocationId?: string;
}

export type CapabilityMutationOutcome =
  | { applied: true; reason?: undefined; error?: undefined }
  | { applied: false; reason: 'not_witnessed' | 'not_eligible' | 'write_failed'; error?: unknown };

export type CapabilityPolicyMutationOutcome =
  | { applied: true }
  | { applied: false; reason: 'not_characterized' | 'binding_mismatch' | 'barrier_busy' | 'profile_blocked' | 'invalid_policy' | 'write_failed'; error?: unknown };

interface CapabilityAdmissionSnapshot {
  readonly state: string;
  readonly admissionEpoch: number | null;
}

const capabilityAdmissions = new Map<string, CapabilityAdmissionSnapshot>();
const serializedTransitionEpochs = new Map<string, number>();

function capabilityMutationLockKey(profileKey: string): string {
  return `capability-mutation:${profileKey}`;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

function acquireCapabilityMutationLock(profileKey: string): DomainLock {
  const deadline = Date.now() + CAPABILITY_MUTATION_LOCK_WAIT_MS;
  while (true) {
    const lock = acquireDomainLock(
      profileKey,
      capabilityMutationLockKey(profileKey),
      CAPABILITY_MUTATION_LOCK_STALE_MS,
    );
    if (lock) return lock;
    if (Date.now() >= deadline) throw new Error('capability_mutation_lock_timeout');
    sleepSync(CAPABILITY_MUTATION_LOCK_RETRY_MS);
  }
}

function writeCapabilityRaw(
  profileKey: string,
  record: Omit<CapabilityRecordV2, 'schema' | 'version' | 'configured_profile_key'>,
): void {
  const characterized = Date.parse(record.characterized_at);
  if (!Number.isFinite(characterized)
    || !validCapabilityDigests(record)
    || (record.admission_policy !== 'parallel' && record.admission_policy !== 'serialized')
    || !Number.isInteger(record.admission_epoch)
    || record.admission_epoch < 0) {
    throw new Error('invalid_capability');
  }
  atomicJson(profileDirs(profileKey).capability, {
    schema: 'chatgpt-browser-turn-capability/v2',
    version: 2,
    configured_profile_key: profileKey,
    ...record,
  });
}

function writeCapabilityRecord(profileKey: string, capability: CapabilityRecordV2): void {
  writeCapabilityRaw(profileKey, {
    candidate_digest: capability.candidate_digest,
    build_digest: capability.build_digest,
    browser_provenance: capability.browser_provenance,
    config_digest: capability.config_digest,
    gate_digest: capability.gate_digest,
    evidence_digest: capability.evidence_digest,
    characterized_at: capability.characterized_at,
    admission_policy: capability.admission_policy,
    admission_epoch: capability.admission_epoch,
  });
}

function migrateLegacyCapabilityOnRead(
  profileKey: string,
  parsed: LegacyCapabilityRecordV1,
  mutationLockHeld: boolean,
): CapabilityRecordV2 {
  if (mutationLockHeld) {
    const migrated = migrateLegacyCapabilityV1(parsed);
    writeCapabilityRecord(profileKey, migrated);
    return migrated;
  }

  const lock = acquireCapabilityMutationLock(profileKey);
  try {
    const latest: unknown = JSON.parse(readFileSync(profileDirs(profileKey).capability, 'utf8'));
    if (compatibleCapabilityV2(latest, profileKey)) return latest;
    if (!compatibleLegacyCapabilityV1(latest, profileKey)) throw new Error('capability_incompatible');
    const migrated = migrateLegacyCapabilityV1(latest);
    writeCapabilityRecord(profileKey, migrated);
    return migrated;
  } finally {
    lock.release();
  }
}

/** Test fixture only — production mutations use applyCapabilityAfterSuccessfulTurn / mutateCapabilityAdmissionPolicy. */
export function __testWriteCapability(
  profileKey: string,
  record: Omit<CapabilityRecordV2, 'schema' | 'version' | 'configured_profile_key'>,
): void {
  const lock = acquireCapabilityMutationLock(profileKey);
  try {
    writeCapabilityRaw(profileKey, record);
  } finally {
    lock.release();
  }
}

type CapabilityStatusResult = ControlResultV1 & {
  capability?: CapabilityRecordV2;
  characterization?: { characterized: boolean; characterized_at?: string; evidence_digest?: string };
  admission?: { policy: AdmissionPolicy; epoch: number };
};

function capabilityPresentation(capability: CapabilityRecordV2) {
  return {
    characterization: {
      characterized: true,
      characterized_at: capability.characterized_at,
      evidence_digest: capability.evidence_digest,
    },
    admission: {
      policy: capability.admission_policy,
      epoch: capability.admission_epoch,
    },
  };
}

function readCapabilityStatus(
  profileKey: string,
  expected?: CapabilityBinding,
  mutationLockHeld = false,
): CapabilityStatusResult {
  const listed = statusList(profileKey);
  if (listed.state === 'profile_blocked') {
    return { ...control('capability', 'profile_blocked', profileKey), complete: false };
  }
  const capabilityPath = profileDirs(profileKey).capability;
  if (!existsSync(capabilityPath)) return control('capability', 'no_evidence', profileKey);
  let capability: CapabilityRecordV2;
  try {
    const parsed: unknown = JSON.parse(readFileSync(capabilityPath, 'utf8'));
    const normalized = normalizeCapabilityRecord(parsed, profileKey);
    if (!normalized) return control('capability', 'profile_blocked', profileKey, 'capability_incompatible');
    capability = compatibleLegacyCapabilityV1(parsed, profileKey)
      ? migrateLegacyCapabilityOnRead(profileKey, parsed, mutationLockHeld)
      : normalized;
  } catch {
    return control('capability', 'profile_blocked', profileKey, 'capability_unreadable');
  }

  const presentation = capabilityPresentation(capability);
  if (expected && (
    capability.candidate_digest !== expected.candidate_digest
    || capability.build_digest !== expected.build_digest
    || capability.config_digest !== expected.config_digest
    || capability.gate_digest !== expected.gate_digest
  )) {
    return {
      ...control('capability', 'downgraded', profileKey, 'capability_binding_mismatch'),
      capability,
      ...presentation,
    };
  }
  if (capability.admission_policy !== 'parallel') {
    return {
      ...control('capability', 'downgraded', profileKey),
      capability,
      ...presentation,
    };
  }
  return {
    ...control('capability', 'ok', profileKey),
    capability,
    ...presentation,
  };
}

function admissionEpochOf(current: CapabilityStatusResult): number | null {
  return current.capability?.admission_epoch ?? null;
}

function snapshotAdmission(current: CapabilityStatusResult): CapabilityAdmissionSnapshot {
  return {
    state: current.state,
    admissionEpoch: admissionEpochOf(current),
  };
}

export function capabilityStatus(
  profileKey: string,
  expected?: CapabilityBinding,
): CapabilityStatusResult {
  const result = readCapabilityStatus(profileKey, expected);
  if (!capabilityAdmissions.has(profileKey)) {
    capabilityAdmissions.set(profileKey, snapshotAdmission(result));
  }
  return result;
}

function completionMatchesCapability(
  capability: CapabilityRecordV2,
  completion: CapabilityTurnCompletion,
): boolean {
  return capability.candidate_digest === completion.expectedBinding.candidate_digest
    && capability.build_digest === completion.expectedBinding.build_digest
    && capability.config_digest === completion.expectedBinding.config_digest
    && capability.gate_digest === completion.expectedBinding.gate_digest
    && capability.browser_provenance === completion.browserProvenance;
}

export function planCapabilityAfterSuccessfulTurn(
  current: CapabilityStatusResult,
  completion: CapabilityTurnCompletion,
): Omit<CapabilityRecordV2, 'schema' | 'version' | 'configured_profile_key'> {
  if (!completion.witnessed || current.state === 'profile_blocked') {
    throw new Error('capability_not_eligible');
  }

  const observedIso = new Date().toISOString();
  const existing = current.capability;

  if (existing && completionMatchesCapability(existing, completion)) {
    return {
      candidate_digest: existing.candidate_digest,
      build_digest: existing.build_digest,
      browser_provenance: existing.browser_provenance,
      config_digest: existing.config_digest,
      gate_digest: existing.gate_digest,
      evidence_digest: completion.evidenceDigest,
      characterized_at: observedIso,
      admission_policy: existing.admission_policy,
      admission_epoch: existing.admission_epoch,
    };
  }

  return {
    ...completion.expectedBinding,
    browser_provenance: completion.browserProvenance,
    evidence_digest: completion.evidenceDigest,
    characterized_at: observedIso,
    admission_policy: 'serialized',
    admission_epoch: (existing?.admission_epoch ?? 0) + (existing ? 1 : 0),
  };
}

function commitCapabilityAfterSuccessfulTurn(
  profileKey: string,
  currentAtWrite: CapabilityStatusResult,
  completion: CapabilityTurnCompletion,
): CapabilityMutationOutcome {
  if (!completion.witnessed || currentAtWrite.state === 'profile_blocked') {
    return { applied: false, reason: completion.witnessed ? 'not_eligible' : 'not_witnessed' };
  }
  try {
    writeCapabilityRaw(profileKey, planCapabilityAfterSuccessfulTurn(currentAtWrite, completion));
    return { applied: true };
  } catch (error) {
    if (error instanceof Error && error.message === 'capability_not_eligible') {
      return { applied: false, reason: 'not_eligible' };
    }
    return { applied: false, reason: 'write_failed', error };
  }
}

function bindingMatchesCapability(
  capability: CapabilityRecordV2,
  completion: CapabilityTurnCompletion,
): boolean {
  return capability.candidate_digest === completion.expectedBinding.candidate_digest
    && capability.build_digest === completion.expectedBinding.build_digest
    && capability.config_digest === completion.expectedBinding.config_digest
    && capability.gate_digest === completion.expectedBinding.gate_digest;
}

function productionCompletionStillEligible(
  profileKey: string,
  current: CapabilityStatusResult,
  completion: CapabilityTurnCompletion,
): boolean {
  if (current.state === 'profile_blocked') return false;

  const admission = capabilityAdmissions.get(profileKey) ?? snapshotAdmission(current);
  const invocationEpoch = serializedTransitionEpochs.get(profileKey);
  const startedParallel = admission.state === 'ok';
  const admittedEpoch = invocationEpoch ?? admission.admissionEpoch;
  const currentEpoch = admissionEpochOf(current);

  if (startedParallel
    && admittedEpoch !== null
    && currentEpoch !== null
    && currentEpoch > admittedEpoch) {
    return false;
  }
  if (admittedEpoch !== null && currentEpoch !== null && currentEpoch < admittedEpoch) {
    return false;
  }

  if (!current.capability) return true;
  if (completionMatchesCapability(current.capability, completion)) return true;
  if (bindingMatchesCapability(current.capability, completion)) return true;
  return !startedParallel;
}

export function applyCapabilityAfterSuccessfulTurn(
  profileKey: string,
  completion: CapabilityTurnCompletion,
): CapabilityMutationOutcome {
  if (!completion.witnessed) return { applied: false, reason: 'not_witnessed' };

  let lock: DomainLock;
  try {
    lock = acquireCapabilityMutationLock(profileKey);
  } catch (error) {
    return { applied: false, reason: 'write_failed', error };
  }

  let outcome: CapabilityMutationOutcome;
  try {
    const current = readCapabilityStatus(profileKey, completion.expectedBinding, true);
    if (!productionCompletionStillEligible(profileKey, current, completion)) {
      outcome = { applied: false, reason: 'not_eligible' };
    } else {
      outcome = commitCapabilityAfterSuccessfulTurn(profileKey, current, completion);
    }
  } catch (error) {
    outcome = { applied: false, reason: 'write_failed', error };
  } finally {
    capabilityAdmissions.delete(profileKey);
    serializedTransitionEpochs.delete(profileKey);
    try {
      lock.release();
    } catch (error) {
      if (completion.invocationId) {
        recordSwallowedDriverException(
          profileKey,
          completion.invocationId,
          'capability_mutation_lock_release_failed',
          error,
          { invocation_id: completion.invocationId, operation: 'capability_mutation' },
        );
      }
    }
  }
  return outcome;
}

export function recordSerializedTransitionAnchor(
  profileKey: string,
  observed: CapabilityStatusResult,
): void {
  const epoch = admissionEpochOf(observed);
  if (epoch !== null) {
    serializedTransitionEpochs.set(profileKey, epoch);
  }
}


function serializeBarrierLockReclaimable(profileKey: string): (lockKey: string) => boolean {
  let incidents: ReturnType<typeof listReadableIncidents>;
  try {
    incidents = listReadableIncidents(profileKey);
  } catch {
    return () => false;
  }
  const protectedKeys = new Set(
    incidents
      .filter(({ record }) => {
        if (!record.lock_key) return false;
        if (record.kind === 'fresh_orphan') return true;
        return record.phase === 'possible_delivery'
          || record.phase === 'reply_complete'
          || record.phase === 'publication_prepared'
          || record.phase === 'committed';
      })
      .map(({ record }) => record.lock_key as string),
  );
  return (lockKey: string) => !protectedKeys.has(lockKey);
}

export function mutateCapabilityAdmissionPolicy(
  profileKey: string,
  policy: AdmissionPolicy,
  expected?: CapabilityBinding,
  browserProvenance?: string,
): CapabilityStatusResult & { mutation?: CapabilityPolicyMutationOutcome } {
  if (policy !== 'parallel' && policy !== 'serialized') {
    return {
      ...control('capability', 'driver_error', profileKey, 'invalid_policy'),
      mutation: { applied: false, reason: 'invalid_policy' },
    };
  }

  let barrier: DomainLock | null = null;
  if (policy === 'serialized') {
    const profileBarrierKey = `profile:${profileKey}`;
    barrier = acquireDomainLock(profileKey, profileBarrierKey);
    if (!barrier && reconcileAbandonedSchedulingConflicts(profileKey, profileBarrierKey, 120_000, serializeBarrierLockReclaimable(profileKey))) {
      barrier = acquireDomainLock(profileKey, profileBarrierKey);
    }
    if (!barrier) {
      return {
        ...control('capability', 'profile_busy', profileKey, 'serialize_barrier_busy'),
        mutation: { applied: false, reason: 'barrier_busy' },
      };
    }
  }

  let lock: DomainLock;
  try {
    lock = acquireCapabilityMutationLock(profileKey);
  } catch (error) {
    if (barrier) barrier.release();
    return {
      ...control('capability', 'driver_error', profileKey, 'capability_mutation_failed'),
      mutation: { applied: false, reason: 'write_failed', error },
    };
  }

  try {
    const current = readCapabilityStatus(profileKey, expected, true);
    if (current.state === 'profile_blocked') {
      return {
        ...current,
        mutation: { applied: false, reason: 'profile_blocked' },
      };
    }
    const capability = current.capability;
    if (!capability || !current.characterization?.characterized) {
      return {
        ...control('capability', 'downgraded', profileKey, 'not_characterized'),
        mutation: { applied: false, reason: 'not_characterized' },
      };
    }
    if (expected && (
      capability.candidate_digest !== expected.candidate_digest
      || capability.build_digest !== expected.build_digest
      || capability.config_digest !== expected.config_digest
      || capability.gate_digest !== expected.gate_digest
    )) {
      return {
        ...control('capability', 'downgraded', profileKey, 'capability_binding_mismatch'),
        capability,
        characterization: current.characterization,
        admission: current.admission,
        mutation: { applied: false, reason: 'binding_mismatch' },
      };
    }
    if (policy === 'parallel' && (
      !browserProvenance
      || capability.browser_provenance !== browserProvenance
    )) {
      return {
        ...control('capability', 'downgraded', profileKey, 'capability_binding_mismatch'),
        capability,
        characterization: current.characterization,
        admission: current.admission,
        mutation: { applied: false, reason: 'binding_mismatch' },
      };
    }

    const nextEpoch = policy === 'serialized'
      ? capability.admission_epoch + 1
      : capability.admission_epoch;
    const nextPolicy = policy;
    if (nextPolicy === capability.admission_policy && nextEpoch === capability.admission_epoch) {
      return {
        ...current,
        mutation: { applied: true },
      };
    }

    writeCapabilityRecord(profileKey, { ...capability, admission_policy: nextPolicy, admission_epoch: nextEpoch });
    const refreshed = readCapabilityStatus(profileKey, expected, true);
    return { ...refreshed, mutation: { applied: true } };
  } catch (error) {
    return {
      ...control('capability', 'driver_error', profileKey, 'capability_mutation_failed'),
      mutation: { applied: false, reason: 'write_failed', error },
    };
  } finally {
    try { lock.release(); } catch { /* fail-closed */ }
    if (barrier) {
      try { barrier.release(); } catch { /* fail-closed */ }
    }
  }
}

export function statusList(profileKey: string): ControlResultV1 {
  const d = profileDirs(profileKey);
  const items: StatusItemV1[] = [];
  const referencedQuarantine = new Set<string>();
  let blocked = false;

  for (const name of readdirSync(d.records).sort()) {
    if (!name.endsWith('.json')) continue;
    const path = join(d.records, name);
    try {
      const identity = name.slice(0, -5);
      if (!validRecordIdentity(identity)) throw new Error('incompatible_record');
      const record = readKnownRecord(path, profileKey);
      items.push({
        identity,
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
      referencedQuarantine.add(tombstone.quarantine_name);
      const resolutionPath = join(d.resolved, `${tombstone.identity}.json`);
      const resolutionPending = tombstone.state === 'active' && existsSync(resolutionPath);
      items.push({
        identity: tombstone.identity,
        kind: 'blocking_tombstone',
        generation: tombstone.generation,
        evidence_token: tombstone.source_digest,
        cause: tombstone.state === 'preparing'
          ? 'quarantine_preparation_incomplete'
          : resolutionPending
            ? 'adjudication_resolution_incomplete'
            : undefined,
        opaque: true,
      });
      const quarantinePath = join(d.quarantine, tombstone.quarantine_name);
      try {
        items.push(quarantineStatusItem(
          quarantinePath,
          `quarantine:${tombstone.identity}`,
          tombstone.generation,
          tombstone.source_digest,
        ));
      } catch {
        items.push({
          identity: `quarantine:${tombstone.identity}:unreadable`,
          kind: 'opaque_quarantine',
          generation: tombstone.generation,
          evidence_token: 'unreadable',
          cause: resolutionPending ? 'adjudication_resolution_incomplete' : 'quarantine_missing_or_unreadable',
          opaque: true,
        });
      }
    } catch {
      items.push({ identity: `tombstone:${name}:unreadable`, kind: 'blocking_tombstone', generation: 0, evidence_token: 'unreadable', opaque: true });
    }
  }

  for (const name of readdirSync(d.quarantine).sort()) {
    if (referencedQuarantine.has(name)) continue;
    blocked = true;
    const path = join(d.quarantine, name);
    try {
      const item = quarantineStatusItem(path, `opaque-quarantine:${encodeName(name)}`, generationForOpaque(path));
      items.push(item);
    } catch {
      items.push({
        identity: `opaque-quarantine:${encodeName(name)}:unreadable`,
        kind: 'opaque_quarantine',
        generation: 0,
        evidence_token: 'unreadable',
        cause: 'orphaned_quarantine_unreadable',
        opaque: true,
      });
    }
  }

  if (existsSync(d.capability)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(d.capability, 'utf8'));
      if (!normalizeCapabilityRecord(parsed, profileKey)) throw new Error('incompatible');
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
  if (!validRecordIdentity(identity)) return control('clear', 'not_found', profileKey);
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
  const area = match[1];
  const encodedName = match[2];
  const digest = match[3];
  if (!area || !encodedName || !digest) return null;
  const name = decodeName(encodedName);
  if (!name) return null;
  return { area: area as OpaqueArea, name, digest };
}

function opaqueSourceDirectory(profileKey: string, area: OpaqueArea): string {
  const d = profileDirs(profileKey);
  if (area === 'records') return d.records;
  if (area === 'publications') return d.publications;
  return d.root;
}

function matchingTombstones(
  profileKey: string,
  parsed: { area: OpaqueArea; name: string; digest: string },
  generation: number,
): Array<{ path: string; tombstone: TombstoneV1 }> {
  const d = profileDirs(profileKey);
  const matches: Array<{ path: string; tombstone: TombstoneV1 }> = [];
  for (const name of readdirSync(d.tombstones).sort()) {
    const path = join(d.tombstones, name);
    let tombstone: TombstoneV1;
    try {
      tombstone = readTombstone(path, profileKey);
    } catch {
      continue;
    }
    if (tombstone.source_area === parsed.area
      && tombstone.source_name === parsed.name
      && tombstone.source_generation === generation
      && tombstone.source_digest === parsed.digest) {
      matches.push({ path, tombstone });
    }
  }
  return matches;
}

function finishQuarantine(
  profileKey: string,
  parsed: { area: OpaqueArea; name: string; digest: string },
  requestedIdentity: string,
  generation: number,
  tombstonePath: string,
  tombstone: TombstoneV1,
): ControlResultV1 {
  const d = profileDirs(profileKey);
  const source = opaquePath(profileKey, parsed.area, parsed.name);
  if (!source) return control('clear', 'profile_blocked', profileKey, 'opaque_path_invalid');
  const quarantinePath = join(d.quarantine, tombstone.quarantine_name);
  const sourceExists = existsSync(source);
  const quarantineExists = existsSync(quarantinePath);

  if (tombstone.state === 'active') {
    if (sourceExists || !quarantineExists) return control('clear', 'profile_blocked', profileKey, 'quarantine_active_state_inconsistent');
    try {
      if (sha256(regularBytes(quarantinePath)) !== tombstone.source_digest) {
        return control('clear', 'evidence_changed', profileKey, 'quarantine_bytes_changed');
      }
    } catch {
      return control('clear', 'profile_blocked', profileKey, 'quarantine_bytes_unreadable');
    }
    return control('clear', 'quarantined', profileKey);
  }

  if (sourceExists && quarantineExists) {
    return control('clear', 'profile_blocked', profileKey, 'quarantine_preparation_ambiguous');
  }
  if (!sourceExists && !quarantineExists) {
    return control('clear', 'profile_blocked', profileKey, 'quarantine_preparation_missing_bytes');
  }

  if (sourceExists) {
    let current: StatusItemV1;
    try {
      current = opaqueStatusItem(profileKey, parsed.area, parsed.name);
    } catch {
      return control('clear', 'profile_blocked', profileKey, 'opaque_record_unreadable');
    }
    if (current.identity !== requestedIdentity
      || current.generation !== generation
      || current.evidence_token !== parsed.digest) {
      return control('clear', 'stale_generation', profileKey);
    }
    try {
      renameSync(source, quarantinePath);
      fsyncDirectory(d.quarantine);
      fsyncDirectory(opaqueSourceDirectory(profileKey, parsed.area));
    } catch {
      return control('clear', 'profile_blocked', profileKey, 'quarantine_move_incomplete');
    }
  }

  try {
    if (sha256(regularBytes(quarantinePath)) !== tombstone.source_digest) {
      return control('clear', 'evidence_changed', profileKey, 'quarantine_bytes_changed');
    }
  } catch {
    return control('clear', 'profile_blocked', profileKey, 'quarantine_bytes_unreadable');
  }

  const active: TombstoneV1 = { ...tombstone, state: 'active', updated_at: new Date().toISOString() };
  atomicJson(tombstonePath, active);
  return control('clear', 'quarantined', profileKey);
}

export function quarantineOpaque(profileKey: string, identity: string, generation: number): ControlResultV1 {
  if (validTombstoneIdentity(identity)) {
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
    const parsedFromTombstone = {
      area: tombstone.source_area,
      name: tombstone.source_name,
      digest: tombstone.source_digest,
    };
    const sourceIdentity = `opaque:${tombstone.source_area}:${encodeName(tombstone.source_name)}:${tombstone.source_digest}`;
    return finishQuarantine(
      profileKey,
      parsedFromTombstone,
      sourceIdentity,
      tombstone.source_generation,
      tombstonePath,
      tombstone,
    );
  }

  const parsed = parseOpaqueIdentity(identity);
  if (!parsed) return control('clear', 'not_found', profileKey);

  const existing = matchingTombstones(profileKey, parsed, generation);
  if (existing.length > 1) return control('clear', 'profile_blocked', profileKey, 'duplicate_quarantine_preparation');
  if (existing.length === 1) {
    const match = existing[0]!;
    return finishQuarantine(profileKey, parsed, identity, generation, match.path, match.tombstone);
  }

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
  const tombstone: TombstoneV1 = {
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
  return finishQuarantine(profileKey, parsed, identity, generation, tombstonePath, tombstone);
}

export function adjudicateTombstone(
  profileKey: string,
  identity: string,
  generation: number,
  expectedEvidenceSha256: string,
  actualEvidenceSha256: string,
  testHooks: AdjudicationTestHooks = {},
): ControlResultV1 {
  if (!validTombstoneIdentity(identity)) return control('clear', 'not_found', profileKey);
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
  if (tombstone.identity !== identity || tombstone.generation !== generation) return control('clear', 'stale_generation', profileKey);
  if (tombstone.state !== 'active') return control('clear', 'profile_blocked', profileKey, 'quarantine_preparation_incomplete');

  const quarantinePath = join(d.quarantine, tombstone.quarantine_name);
  const resolutionPath = join(d.resolved, `${identity}.json`);
  const resolvedOpaquePath = join(d.resolved, `${identity}.opaque`);

  if (existsSync(resolutionPath)) {
    try {
      readTombstoneResolution(resolutionPath, profileKey, tombstone, expectedEvidenceSha256);
    } catch {
      return control('clear', 'evidence_changed', profileKey, 'adjudication_resolution_changed');
    }
  } else {
    let quarantineBytes: Buffer;
    try {
      quarantineBytes = regularBytes(quarantinePath);
    } catch {
      return control('clear', 'evidence_changed', profileKey, 'quarantine_bytes_changed');
    }
    if (sha256(quarantineBytes) !== tombstone.source_digest) {
      return control('clear', 'evidence_changed', profileKey, 'quarantine_bytes_changed');
    }
    atomicJson(resolutionPath, {
      ...tombstone,
      adjudication_evidence_sha256: expectedEvidenceSha256,
      resolved_at: new Date().toISOString(),
    } satisfies TombstoneResolutionV1);
    testHooks.afterResolutionRecord?.();
  }

  const quarantineExists = existsSync(quarantinePath);
  const resolvedExists = existsSync(resolvedOpaquePath);
  if (quarantineExists && resolvedExists) {
    return control('clear', 'profile_blocked', profileKey, 'adjudication_resolution_ambiguous');
  }
  if (!quarantineExists && !resolvedExists) {
    return control('clear', 'profile_blocked', profileKey, 'adjudication_resolution_missing_bytes');
  }

  if (quarantineExists) {
    try {
      if (sha256(regularBytes(quarantinePath)) !== tombstone.source_digest) {
        return control('clear', 'evidence_changed', profileKey, 'quarantine_bytes_changed');
      }
      renameSync(quarantinePath, resolvedOpaquePath);
      fsyncDirectory(d.resolved);
      fsyncDirectory(d.quarantine);
    } catch {
      return control('clear', 'profile_blocked', profileKey, 'adjudication_resolution_move_incomplete');
    }
    testHooks.afterResolvedMove?.();
  } else {
    try {
      if (sha256(regularBytes(resolvedOpaquePath)) !== tombstone.source_digest) {
        return control('clear', 'evidence_changed', profileKey, 'resolved_bytes_changed');
      }
    } catch {
      return control('clear', 'profile_blocked', profileKey, 'resolved_bytes_unreadable');
    }
  }

  unlinkSync(tombstonePath);
  fsyncDirectory(d.tombstones);
  return control('clear', 'cleared', profileKey);
}

export function isCapabilityState(value: string): boolean {
  return (CAPABILITY_STATES as readonly string[]).includes(value);
}
