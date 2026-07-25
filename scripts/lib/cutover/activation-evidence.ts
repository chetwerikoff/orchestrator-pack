import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { openSync as openDirSync } from 'node:fs';
import type { ActivationFollowUp, PhaseOneEnvelope, CutoverStep } from './types.ts';
import { sha256Canonical, stableStringify } from './stable-stringify.ts';

function syncParent(path: string): void {
  let fd: number | undefined;
  try {
    fd = openDirSync(dirname(path), 'r');
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function durableWriteJson(path: string, value: unknown): void {
  const bytes = `${stableStringify(value)}\n`;
  const fd = openSync(path, 'w', 0o600);
  try {
    writeFileSync(fd, bytes, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncParent(path);
}

export function readPhaseOne(path: string, epochId: string, nonce: string): PhaseOneEnvelope {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PhaseOneEnvelope;
    if (parsed.epochId !== epochId || parsed.nonce !== nonce || !Array.isArray(parsed.entries)) {
      throw new Error('phase1_identity_mismatch');
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schemaVersion: 1, epochId, nonce, entries: [] };
    }
    throw error;
  }
}

export function appendPhaseEntry(
  path: string,
  envelope: PhaseOneEnvelope,
  step: CutoverStep,
  detail: unknown,
  completedAt = new Date().toISOString(),
): PhaseOneEnvelope {
  const expectedSequence = envelope.entries.length + 1;
  if (envelope.entries.some((entry) => entry.step === step)) throw new Error(`phase1_duplicate_step:${step}`);
  const next: PhaseOneEnvelope = {
    ...envelope,
    entries: [...envelope.entries, {
      sequence: expectedSequence,
      step,
      completedAt,
      detailDigest: sha256Canonical(detail),
    }],
  };
  if (step === 'import-begun') next.importBegunAt = completedAt;
  durableWriteJson(path, next);
  return next;
}

export function sealPhaseOne(envelope: PhaseOneEnvelope): string {
  const sequences = envelope.entries.map((entry) => entry.sequence);
  if (sequences.some((value, index) => value !== index + 1)) throw new Error('phase1_sequence_gap');
  return sha256Canonical(envelope);
}

export function validateFollowUps(rows: ActivationFollowUp[]): void {
  const seen = new Set<number>();
  rows.forEach((row, index) => {
    if (row.sequence !== index + 1 || seen.has(row.sequence)) throw new Error('followup_sequence_invalid');
    seen.add(row.sequence);
    if (!row.step || !row.completedAt || !row.detailDigest) throw new Error('followup_row_incomplete');
  });
}

export function makeFollowUp(epochId: string, rows: ActivationFollowUp[], step: string, detail: unknown): ActivationFollowUp {
  validateFollowUps(rows);
  return {
    epochId,
    sequence: rows.length + 1,
    step,
    completedAt: new Date().toISOString(),
    detailDigest: sha256Canonical(detail),
  };
}
