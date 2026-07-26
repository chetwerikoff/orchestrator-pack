import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256Stable } from './stable-stringify.ts';
import type { FollowupRecord, PhaseOneEnvelope, PhaseRecord } from './types.ts';

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

export function appendPhaseOne(pathName: string, epochId: string, nonce: string, step: string, detail: unknown): PhaseRecord {
  const envelope = readEnvelope(pathName, epochId, nonce);
  const record: PhaseRecord = {
    sequence: envelope.records.length + 1,
    step,
    completedAt: new Date().toISOString(),
    detailDigest: sha256Stable(detail),
  };
  envelope.records.push(record);
  writeDurableJson(pathName, envelope);
  return record;
}

export function finalizePhaseOne(pathName: string, epochId: string, nonce: string): { envelope: PhaseOneEnvelope; digest: string } {
  const envelope = readEnvelope(pathName, epochId, nonce);
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
    case 'final-health-delivery-observed':
      return {
        schedulerOwnershipRecorded: existing.some((row) => row.step === 'scheduler-owned'),
        supervisorStartRecorded: existing.some((row) => row.step === 'typescript-supervisor-started'),
        deliverySurface: 'committed-epoch-scheduler-owner-ready',
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
      appendFollowupRecord(pathName, existing, epochId, nextStep, completionDetail(nextStep, pathName, existing));
    }
  }

  if (existing.length !== requestedIndex) throw new Error(`followup_sequence_gap:${step}`);
  return appendFollowupRecord(pathName, existing, epochId, step, detail);
}
