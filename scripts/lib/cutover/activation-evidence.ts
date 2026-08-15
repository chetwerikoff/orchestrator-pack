import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256Stable, stableStringify } from './stable-stringify.ts';
import type { FollowupRecord, FoundationAdmissionEvidence, PhaseOneEnvelope, PhaseRecord } from './types.ts';

export const REQUIRED_FOLLOWUP_STEPS = [
  'committed-registry-reprojected',
  'typescript-supervisor-started',
  'scheduler-owned',
  'machine-local-completion-fsync-confirmed',
  'final-step-timestamp-recorded',
  'final-health-delivery-observed',
  'activation-complete',
] as const;

function syncDirectory(directory: string): void {
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function writeDurableFile(target: string, bytes: string | Buffer): void {
  const directory = path.dirname(target);
  mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, target);
  syncDirectory(directory);
}

export function writeDurableJson(target: string, value: unknown): void {
  writeDurableFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

export function foundationEvidenceDigest(evidence: Omit<FoundationAdmissionEvidence, 'observationDigest'>): string {
  return sha256Stable(evidence);
}

export function verifyFoundationEvidenceDigest(evidence: FoundationAdmissionEvidence): void {
  const { observationDigest: _observationDigest, ...unsigned } = evidence;
  if (evidence.producer !== 'orchestrator-pack:foundation-adoption-producer') {
    throw new Error('foundation_evidence_producer_invalid');
  }
  if (evidence.observationDigest !== foundationEvidenceDigest(unsigned)) {
    throw new Error('foundation_evidence_observation_digest_invalid');
  }
}

export function verifyFoundationEvidenceObservation(
  evidence: FoundationAdmissionEvidence,
  observed: {
    typedConfig: unknown;
    appStateVersion: string;
    migrationJournalPaths: readonly string[];
    inertProof: FoundationAdmissionEvidence['inertProof'];
    heartbeats: ReadonlyArray<FoundationAdmissionEvidence['heartbeats'][number]>;
  },
): void {
  verifyFoundationEvidenceDigest(evidence);
  if (
    stableStringify(evidence.typedConfig) !== stableStringify(observed.typedConfig)
    || evidence.preflight.appStateVersion !== observed.appStateVersion
    || stableStringify(evidence.migrationJournalPaths) !== stableStringify(observed.migrationJournalPaths)
    || stableStringify(evidence.inertProof) !== stableStringify(observed.inertProof)
  ) {
    throw new Error('foundation_evidence_observation_mismatch');
  }
  const shape = (row: FoundationAdmissionEvidence['heartbeats'][number]) => ({
    hostId: row.hostId,
    installedCommitSha: row.installedCommitSha,
    active: row.active,
    ...(row.quarantined === true ? { quarantined: true } : {}),
  });
  if (stableStringify(evidence.heartbeats.map(shape)) !== stableStringify(observed.heartbeats.map(shape))) {
    throw new Error('foundation_evidence_observation_mismatch:heartbeats');
  }
}

function readEnvelope(pathName: string, epochId: string, nonce: string): PhaseOneEnvelope {
  if (!existsSync(pathName)) return { schemaVersion: 1, epochId, nonce, records: [] };
  const parsed = JSON.parse(readFileSync(pathName, 'utf8')) as PhaseOneEnvelope;
  if (parsed.schemaVersion !== 1 || parsed.epochId !== epochId || parsed.nonce !== nonce || !Array.isArray(parsed.records)) {
    throw new Error('phase_one_envelope_mismatch');
  }
  parsed.records.forEach((record, index) => {
    if (record.sequence !== index + 1) throw new Error('phase_one_sequence_invalid');
  });
  return parsed;
}

function phaseDetailPath(pathName: string, sequence: number): string {
  return path.join(`${pathName}.details`, `${String(sequence).padStart(4, '0')}.json`);
}

function readDetail(pathName: string, record: PhaseRecord): unknown {
  const detailPath = phaseDetailPath(pathName, record.sequence);
  if (!existsSync(detailPath)) throw new Error(`phase_one_detail_missing:${record.step}`);
  const detail = JSON.parse(readFileSync(detailPath, 'utf8')) as unknown;
  if (sha256Stable(detail) !== record.detailDigest) throw new Error(`phase_one_detail_digest_mismatch:${record.step}`);
  return detail;
}

export function readPhaseOneDetail(pathName: string, epochId: string, nonce: string, step: string): unknown {
  const envelope = readEnvelope(pathName, epochId, nonce);
  const matches = envelope.records.filter((record) => record.step === step);
  if (matches.length !== 1) throw new Error(`phase_one_detail_record_invalid:${step}`);
  return readDetail(pathName, matches[0]!);
}

export function verifyPhaseOneDetails(pathName: string, epochId: string, nonce: string): PhaseOneEnvelope {
  const envelope = readEnvelope(pathName, epochId, nonce);
  for (const record of envelope.records) readDetail(pathName, record);
  return envelope;
}

export function appendPhaseOne(pathName: string, epochId: string, nonce: string, step: string, detail: unknown): PhaseRecord {
  const envelope = readEnvelope(pathName, epochId, nonce);
  const record: PhaseRecord = {
    sequence: envelope.records.length + 1,
    step,
    completedAt: new Date().toISOString(),
    detailDigest: sha256Stable(detail),
  };
  writeDurableFile(phaseDetailPath(pathName, record.sequence), `${stableStringify(detail)}\n`);
  readDetail(pathName, record);
  envelope.records.push(record);
  writeDurableJson(pathName, envelope);
  return record;
}

export function finalizePhaseOne(pathName: string, epochId: string, nonce: string): { envelope: PhaseOneEnvelope; digest: string } {
  const envelope = verifyPhaseOneDetails(pathName, epochId, nonce);
  if (envelope.records.length === 0) throw new Error('phase_one_empty');
  return { envelope, digest: sha256Stable(envelope) };
}

export function verifyPhaseOneDigest(pathName: string, epochId: string, nonce: string, expectedDigest: string): PhaseOneEnvelope {
  const result = finalizePhaseOne(pathName, epochId, nonce);
  if (result.digest !== expectedDigest) throw new Error('precommit_log_digest_mismatch');
  return result.envelope;
}

function readFollowups(pathName: string, epochId: string): FollowupRecord[] {
  const existing = existsSync(pathName)
    ? JSON.parse(readFileSync(pathName, 'utf8')) as FollowupRecord[]
    : [];
  if (!Array.isArray(existing) || existing.some((row) => row.epochId !== epochId)) throw new Error('followup_epoch_mismatch');
  existing.forEach((row, index) => {
    if (row.sequence !== index + 1) throw new Error('followup_sequence_invalid');
    if (row.step !== REQUIRED_FOLLOWUP_STEPS[index]) throw new Error('followup_step_order_invalid');
    if (!Number.isFinite(Date.parse(row.completedAt)) || !row.detailDigest) throw new Error('followup_record_invalid');
  });
  if (existing.length > REQUIRED_FOLLOWUP_STEPS.length) throw new Error('followup_sequence_overflow');
  return existing;
}

function appendFollowupRecord(pathName: string, existing: FollowupRecord[], epochId: string, step: string, detail: unknown): FollowupRecord {
  const record: FollowupRecord = {
    epochId,
    sequence: existing.length + 1,
    step,
    completedAt: new Date().toISOString(),
    detailDigest: sha256Stable(detail),
  };
  existing.push(record);
  writeDurableJson(pathName, existing);
  return record;
}

function completionDetail(step: string, pathName: string, existing: FollowupRecord[]): unknown {
  switch (step) {
    case 'machine-local-completion-fsync-confirmed':
      return {
        followupPath: path.resolve(pathName),
        durableThroughSequence: existing.length,
        durability: 'file-fsync-atomic-rename-parent-fsync',
      };
    case 'final-step-timestamp-recorded':
      return {
        observedAt: new Date().toISOString(),
        durableThroughSequence: existing.length,
      };
    default:
      throw new Error(`followup_auto_step_unsupported:${step}`);
  }
}

export function appendFollowup(pathName: string, epochId: string, step: string, detail: unknown): FollowupRecord {
  const existing = readFollowups(pathName, epochId);
  const requestedIndex = REQUIRED_FOLLOWUP_STEPS.indexOf(step as (typeof REQUIRED_FOLLOWUP_STEPS)[number]);
  if (requestedIndex < 0) throw new Error(`followup_step_unknown:${step}`);
  if (existing.length > requestedIndex) throw new Error(`followup_duplicate_step:${step}`);

  if (step === 'activation-complete') {
    if (existing.length < 3) throw new Error('followup_completion_before_scheduler_ownership');
    while (existing.length < requestedIndex) {
      const nextStep = REQUIRED_FOLLOWUP_STEPS[existing.length];
      if (!nextStep || nextStep === 'activation-complete') throw new Error('followup_completion_gap');
      if (nextStep === 'final-health-delivery-observed') throw new Error('followup_health_delivery_observation_required');
      appendFollowupRecord(pathName, existing, epochId, nextStep, completionDetail(nextStep, pathName, existing));
    }
  }

  if (existing.length !== requestedIndex) throw new Error(`followup_sequence_gap:${step}`);
  return appendFollowupRecord(pathName, existing, epochId, step, detail);
}
