import type { ControlResultV1 } from './contracts.ts';
import { acquireDomainLock, type DomainLock } from './coordination.ts';
import {
  capabilityStatus as readCapabilityStatus,
  writeCapability as writeCapabilityRaw,
  type CapabilityBinding,
  type CapabilityRecordV1,
} from './state-core.ts';

export * from './state-core.ts';

const CAPABILITY_LEASE_TTL_MS = 4 * 60 * 60 * 1000;
const CAPABILITY_MUTATION_LOCK_STALE_MS = 5_000;
const CAPABILITY_MUTATION_LOCK_WAIT_MS = 10_000;
const CAPABILITY_MUTATION_LOCK_RETRY_MS = 10;

interface CapabilityAdmissionSnapshot {
  readonly state: string;
  readonly downgradeGeneration: number | null;
}

const capabilityAdmissions = new Map<string, CapabilityAdmissionSnapshot>();
const selfDowngradeGenerations = new Map<string, number>();

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

function generationOf(
  current: ControlResultV1 & { capability?: CapabilityRecordV1 },
): number | null {
  return current.capability?.downgrade_generation ?? null;
}

function completionMatchesCapability(
  capability: CapabilityRecordV1,
  completion: CapabilityTurnCompletion,
): boolean {
  return capability.candidate_digest === completion.expectedBinding.candidate_digest
    && capability.build_digest === completion.expectedBinding.build_digest
    && capability.config_digest === completion.expectedBinding.config_digest
    && capability.gate_digest === completion.expectedBinding.gate_digest
    && capability.browser_provenance === completion.browserProvenance;
}

function snapshotAdmission(
  current: ControlResultV1 & { capability?: CapabilityRecordV1 },
): CapabilityAdmissionSnapshot {
  return {
    state: current.state,
    downgradeGeneration: generationOf(current),
  };
}

function productionCompletionStillEligible(
  profileKey: string,
  current: ControlResultV1 & { capability?: CapabilityRecordV1 },
  completion: CapabilityTurnCompletion,
): boolean {
  if (current.state === 'profile_blocked') return false;

  const admission = capabilityAdmissions.get(profileKey) ?? snapshotAdmission(current);
  const selfDowngradeGeneration = selfDowngradeGenerations.get(profileKey);
  const ranSerialized = admission.state !== 'ok' || selfDowngradeGeneration !== undefined;
  const admittedGeneration = selfDowngradeGeneration ?? admission.downgradeGeneration;

  if (generationOf(current) !== admittedGeneration) return false;
  if (ranSerialized) return true;

  return current.capability?.parallel_eligible === true
    && completionMatchesCapability(current.capability, completion);
}

export interface CapabilityTurnCompletion {
  readonly expectedBinding: CapabilityBinding;
  readonly browserProvenance: string;
  readonly evidenceDigest: string;
  readonly witnessed: boolean;
}

export type CapabilityMutationOutcome =
  | { applied: true; reason?: undefined; error?: undefined }
  | { applied: false; reason: 'not_witnessed' | 'not_eligible' | 'write_failed'; error?: unknown };

export function capabilityStatus(
  profileKey: string,
  expected?: CapabilityBinding,
): ControlResultV1 & { capability?: CapabilityRecordV1 } {
  const result = readCapabilityStatus(profileKey, expected);
  if (!capabilityAdmissions.has(profileKey)) {
    capabilityAdmissions.set(profileKey, snapshotAdmission(result));
  }
  return result;
}

export function planCapabilityAfterSuccessfulTurn(
  current: ControlResultV1 & { capability?: CapabilityRecordV1 },
  completion: CapabilityTurnCompletion,
): Omit<CapabilityRecordV1, 'schema' | 'version' | 'configured_profile_key'> {
  if (!completion.witnessed || current.state === 'profile_blocked') {
    throw new Error('capability_not_eligible');
  }

  const observedAt = new Date();
  const observedIso = observedAt.toISOString();
  const proposedExpires = new Date(observedAt.getTime() + CAPABILITY_LEASE_TTL_MS).toISOString();
  const existing = current.capability;

  if (existing?.parallel_eligible && completionMatchesCapability(existing, completion)) {
    const existingExpires = Date.parse(existing.expires_at);
    const proposedExpiresMs = Date.parse(proposedExpires);
    const expiresAt = Number.isFinite(existingExpires) && existingExpires > proposedExpiresMs
      ? existing.expires_at
      : proposedExpires;
    return {
      candidate_digest: existing.candidate_digest,
      build_digest: existing.build_digest,
      browser_provenance: existing.browser_provenance,
      config_digest: existing.config_digest,
      gate_digest: existing.gate_digest,
      evidence_digest: completion.evidenceDigest,
      observed_at: observedIso,
      expires_at: expiresAt,
      downgrade_generation: existing.downgrade_generation,
      parallel_eligible: true,
    };
  }

  if (current.state === 'ok') throw new Error('capability_not_eligible');

  return {
    ...completion.expectedBinding,
    browser_provenance: completion.browserProvenance,
    evidence_digest: completion.evidenceDigest,
    observed_at: observedIso,
    expires_at: proposedExpires,
    downgrade_generation: (existing?.downgrade_generation ?? 0) + 1,
    parallel_eligible: true,
  };
}

export function writeCapabilityAfterSuccessfulTurn(
  profileKey: string,
  currentAtWrite: ControlResultV1 & { capability?: CapabilityRecordV1 },
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

  try {
    const current = readCapabilityStatus(profileKey, completion.expectedBinding);
    if (!productionCompletionStillEligible(profileKey, current, completion)) {
      return { applied: false, reason: 'not_eligible' };
    }
    return writeCapabilityAfterSuccessfulTurn(profileKey, current, completion);
  } finally {
    capabilityAdmissions.delete(profileKey);
    selfDowngradeGenerations.delete(profileKey);
    lock.release();
  }
}

export function writeCapability(
  profileKey: string,
  record: Omit<CapabilityRecordV1, 'schema' | 'version' | 'configured_profile_key'>,
): void {
  const lock = acquireCapabilityMutationLock(profileKey);
  try {
    writeCapabilityRaw(profileKey, record);
  } finally {
    lock.release();
  }
}

export function downgradeCapability(profileKey: string): void {
  const lock = acquireCapabilityMutationLock(profileKey);
  try {
    const current = readCapabilityStatus(profileKey);
    const capability = current.capability;
    if (!capability || current.state === 'profile_blocked') return;

    const nextGeneration = capability.downgrade_generation + 1;
    writeCapabilityRaw(profileKey, {
      candidate_digest: capability.candidate_digest,
      build_digest: capability.build_digest,
      browser_provenance: capability.browser_provenance,
      config_digest: capability.config_digest,
      gate_digest: capability.gate_digest,
      evidence_digest: capability.evidence_digest,
      observed_at: capability.observed_at,
      expires_at: capability.expires_at,
      downgrade_generation: nextGeneration,
      parallel_eligible: false,
    });
    selfDowngradeGenerations.set(profileKey, nextGeneration);
  } finally {
    lock.release();
  }
}
