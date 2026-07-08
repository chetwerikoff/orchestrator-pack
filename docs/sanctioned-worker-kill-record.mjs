import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runStdinJsonCli, readStdinJson } from './review-mechanical-cli.mjs';

function normalizeString(value) {
  return String(value ?? '').trim();
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeSanctionedWorkerKillRecord(row = {}, nowMs = Date.now()) {
  return {
    sessionId: normalizeString(row.sessionId),
    issueNumber: numberOrZero(row.issueNumber),
    prNumber: numberOrZero(row.prNumber),
    killKind: normalizeString(row.killKind || 'manual'),
    timestampMs: numberOrZero(row.timestampMs) || nowMs,
  };
}

export function readSanctionedWorkerKillSurface(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed.records) ? parsed.records : [];
    return { healthy: true, records: records.map((row) => normalizeSanctionedWorkerKillRecord(row)) };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { healthy: true, records: [] };
    }
    return { healthy: false, reason: 'sanctioned_kill_record_unreadable', detail: error?.message ?? String(error), records: [] };
  }
}

export function appendSanctionedWorkerKillRecord(path, record, nowMs = Date.now()) {
  const surface = readSanctionedWorkerKillSurface(path);
  const records = surface.healthy ? surface.records : [];
  const next = [...records, normalizeSanctionedWorkerKillRecord(record, nowMs)];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return { healthy: true, records: next };
}

runStdinJsonCli('sanctioned-worker-kill-record.mjs', {
  read: () => readSanctionedWorkerKillSurface(readStdinJson().path),
  append: () => {
    const payload = readStdinJson();
    return appendSanctionedWorkerKillRecord(payload.path, payload.record, numberOrZero(payload.nowMs) || Date.now());
  },
});
