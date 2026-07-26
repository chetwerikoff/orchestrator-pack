import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256Stable } from './stable-stringify.ts';
import type { FollowupRecord, PhaseOneEnvelope, PhaseRecord } from './types.ts';

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

export function appendFollowup(pathName: string, epochId: string, step: string, detail: unknown): FollowupRecord {
  const existing = existsSync(pathName)
    ? JSON.parse(readFileSync(pathName, 'utf8')) as FollowupRecord[]
    : [];
  if (!Array.isArray(existing) || existing.some((row) => row.epochId !== epochId)) throw new Error('followup_epoch_mismatch');
  existing.forEach((row, index) => {
    if (row.sequence !== index + 1) throw new Error('followup_sequence_invalid');
  });
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
