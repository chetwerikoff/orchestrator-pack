/**
 * Stable review-run identity helpers.
 *
 * Review lifecycle, timeout, recovery, and claims are owned by the pack review
 * runner/store. This module intentionally performs no process probing, implicit
 * state-root discovery, terminalization, retry, dispatch, or runtime effect.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function safeId(value) {
  const id = String(value ?? '').trim();
  return SAFE_ID.test(id) ? id : '';
}

/**
 * Stable fingerprint used to bind sidecar evidence to one immutable review-run
 * identity. It is evidence correlation only; it never authorizes a lifecycle
 * effect.
 */
export function fingerprintRun(run) {
  const record = asRecord(run) ?? {};
  const id = safeId(record.id ?? record.runId);
  const createdAt = String(record.createdAt ?? '').trim();
  const reviewerSessionId = safeId(record.reviewerSessionId);
  const linkedSessionId = safeId(record.linkedSessionId);
  const prNumber = Number.isInteger(Number(record.prNumber)) ? String(Number(record.prNumber)) : '';
  const targetSha = String(record.targetSha ?? record.headSha ?? '').trim().toLowerCase();
  return createHash('sha256')
    .update([id, createdAt, reviewerSessionId, linkedSessionId, prNumber, targetSha].join('\n'))
    .digest('hex')
    .slice(0, 32);
}

function readJson(path) {
  try {
    return asRecord(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

function listRunFiles(storeDir) {
  const runsDir = join(String(storeDir ?? ''), 'runs');
  if (!storeDir || !existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(runsDir, entry.name));
}

/**
 * Read-only exact reviewer-session lookup inside an explicitly supplied pack review
 * store. Ambiguous reuse returns null rather than guessing.
 */
export function findRunForReviewerSession(storeDir, reviewerSessionId) {
  const sessionId = safeId(reviewerSessionId);
  if (!sessionId) return null;

  const matches = [];
  for (const path of listRunFiles(storeDir)) {
    const run = readJson(path);
    if (run && safeId(run.reviewerSessionId) === sessionId) {
      matches.push({ path, run });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}
