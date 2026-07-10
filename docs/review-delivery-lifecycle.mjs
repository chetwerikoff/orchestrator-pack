/**
 * Review delivery lifecycle + deterministic dedup (Issue #718).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeSha } from './review-reconcile-primitives.mjs';
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';

export const REVIEW_DELIVERY_LIFECYCLE_SCHEMA_VERSION = 1;
export const DEFAULT_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const ENV_TERMINAL_RETENTION_DAYS = 'AO_REVIEW_DELIVERY_TERMINAL_RETENTION_DAYS';

export const LIFECYCLE_STARTED = 'started';
export const LIFECYCLE_VERDICT_RECORDED = 'verdict_recorded';
export const LIFECYCLE_DELIVERY_CLAIMED = 'delivery_claimed';
export const LIFECYCLE_DELIVERY_ATTEMPTED = 'delivery_attempted';
export const TERMINAL_DELIVERED = 'delivered';
export const TERMINAL_ESCALATED = 'escalated';
export const TERMINAL_SUPERSEDED = 'superseded';

const TERMINAL_STATUSES = new Set([TERMINAL_DELIVERED, TERMINAL_ESCALATED, TERMINAL_SUPERSEDED]);

/**
 * @param {unknown} findings
 */
export function hashReviewFindings(findings) {
  const payload = JSON.stringify(Array.isArray(findings) ? findings : []);
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/**
 * @param {{ prNumber?: number, headSha?: string, verdictSource?: string, findingsHash?: string }} input
 */
export function buildDeterministicDeliveryKey(input) {
  const prNumber = Number(input.prNumber ?? 0);
  const headSha = normalizeSha(input.headSha);
  const verdictSource = String(input.verdictSource ?? 'wrapper-stdout').trim();
  const findingsHash = String(input.findingsHash ?? '').trim();
  if (!prNumber || !headSha || !findingsHash) {
    return null;
  }
  return `pr:${prNumber}:head:${headSha}:src:${verdictSource}:findings:${findingsHash}`;
}

/**
 * @param {string} key
 * @returns {{ prNumber: number, headSha: string, verdictSource: string, findingsHash: string } | null}
 */
export function parseDeterministicDeliveryKey(key) {
  const text = String(key ?? '').trim();
  const match = text.match(/^pr:(\d+):head:([^:]+):src:([^:]+):findings:([^:]+)$/);
  if (!match) {
    return null;
  }
  const prNumber = Number(match[1]);
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    return null;
  }
  const headSha = normalizeSha(match[2]);
  const verdictSource = String(match[3] ?? '').trim();
  const findingsHash = String(match[4] ?? '').trim().toLowerCase();
  if (!headSha || !verdictSource || !findingsHash) {
    return null;
  }
  return { prNumber, headSha, verdictSource, findingsHash };
}

/**
 * @param {Record<string, unknown>} journal
 * @param {string} incomingKey
 */
export function findSameHeadJournalConflict(journal, incomingKey) {
  const incoming = parseDeterministicDeliveryKey(incomingKey);
  if (!incoming) {
    return null;
  }
  for (const record of Object.values(journal ?? {})) {
    if (!record || typeof record !== 'object') {
      continue;
    }
    const parsed = parseDeterministicDeliveryKey(String(record.deterministicKey ?? ''));
    if (!parsed) {
      continue;
    }
    if (parsed.prNumber !== incoming.prNumber) {
      continue;
    }
    if (parsed.headSha !== incoming.headSha) {
      continue;
    }
    if (parsed.verdictSource !== incoming.verdictSource) {
      continue;
    }
    if (parsed.findingsHash === incoming.findingsHash) {
      continue;
    }
    return record;
  }
  return null;
}

/**
 * @param {string} sessionId
 * @param {string} deterministicKey
 */
export function buildDeterministicDeliveryId(sessionId, deterministicKey) {
  const sid = String(sessionId ?? '').trim();
  const key = String(deterministicKey ?? '').trim();
  if (!sid || !key) {
    return null;
  }
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 24);
  return `${sid}:pack-send:det:${digest}`;
}

/**
 * @param {Record<string, string | undefined>} [env]
 */
export function resolveTerminalRetentionMs(env = process.env) {
  const raw = String(env[ENV_TERMINAL_RETENTION_DAYS] ?? '').trim();
  const days = Number.parseInt(raw, 10);
  if (Number.isFinite(days) && days > 0) {
    return Math.max(days * 24 * 60 * 60 * 1000, DEFAULT_TERMINAL_RETENTION_MS);
  }
  return DEFAULT_TERMINAL_RETENTION_MS;
}

/**
 * @param {unknown} store
 */
export function normalizeLifecycleStore(store) {
  const root = store && typeof store === 'object' && !Array.isArray(store) ? store : {};
  return {
    schemaVersion: REVIEW_DELIVERY_LIFECYCLE_SCHEMA_VERSION,
    lastUpdatedMs: Number(root.lastUpdatedMs ?? 0) || Date.now(),
    entries: root.entries && typeof root.entries === 'object' && !Array.isArray(root.entries)
      ? root.entries
      : {},
  };
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * @param {string} path
 */
export function readLifecycleStore(path) {
  try {
    const text = readFileSync(path, 'utf8');
    return normalizeLifecycleStore(JSON.parse(text));
  } catch {
    return normalizeLifecycleStore({});
  }
}

/**
 * @param {Record<string, unknown>} store
 * @param {{ nowMs?: number, retentionMs?: number }} [options]
 */
export function compactLifecycleStore(store, options = {}) {
  const nowMs = Number(options.nowMs ?? Date.now());
  const retentionMs = Number(options.retentionMs ?? DEFAULT_TERMINAL_RETENTION_MS);
  const next = normalizeLifecycleStore(store);
  /** @type {Record<string, Record<string, unknown>>} */
  const kept = {};
  let evicted = 0;
  for (const [key, entry] of Object.entries(next.entries)) {
    const record = entry && typeof entry === 'object' ? entry : {};
    const prActionable = record.prActionable !== false;
    const eviction = canEvictLifecycleEntry({ entry: record, nowMs, retentionMs, prActionable });
    if (eviction.ok) {
      evicted += 1;
      continue;
    }
    kept[key] = record;
  }
  next.entries = kept;
  return { store: next, evicted };
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} store
 * @param {{ nowMs?: number, retentionMs?: number }} [options]
 */
export function writeLifecycleStore(path, store, options = {}) {
  const retentionMs = Number(options.retentionMs ?? resolveTerminalRetentionMs());
  const compacted = compactLifecycleStore(store, {
    nowMs: Number(options.nowMs ?? Date.now()),
    retentionMs,
  });
  const next = compacted.store;
  next.lastUpdatedMs = Date.now();
  writeJsonAtomic(path, next);
  return next;
}

/**
 * @param {Record<string, unknown>} entry
 */
export function isLifecycleTerminal(entry) {
  const status = String(entry?.terminalStatus ?? '').trim();
  return TERMINAL_STATUSES.has(status);
}

/**
 * @param {Record<string, unknown>} entry
 */
export function canResumeDeliveryFromLifecycle(entry) {
  if (!entry || typeof entry !== 'object') {
    return false;
  }
  const state = String(entry.state ?? '').trim();
  if (state !== LIFECYCLE_VERDICT_RECORDED && state !== LIFECYCLE_DELIVERY_CLAIMED && state !== LIFECYCLE_DELIVERY_ATTEMPTED) {
    return false;
  }
  return !isLifecycleTerminal(entry);
}

/**
 * @param {Record<string, unknown> | null | undefined} entry
 */
export function isVerdictSnapshotLost(entry) {
  if (!entry || typeof entry !== 'object') {
    return false;
  }
  if (isLifecycleTerminal(entry)) {
    return false;
  }
  const state = String(entry.state ?? '').trim();
  const needsSnapshot =
    state === LIFECYCLE_STARTED ||
    state === LIFECYCLE_VERDICT_RECORDED ||
    state === LIFECYCLE_DELIVERY_CLAIMED ||
    state === LIFECYCLE_DELIVERY_ATTEMPTED;
  if (!needsSnapshot) {
    return false;
  }
  return !String(entry.stdoutSnapshot ?? '').trim();
}

/**
 * @param {{ entry?: Record<string, unknown>, nowMs?: number, retentionMs?: number, prActionable?: boolean }} input
 */
export function canEvictLifecycleEntry(input) {
  const entry = input.entry ?? {};
  const nowMs = Number(input.nowMs ?? Date.now());
  const retentionMs = Number(input.retentionMs ?? DEFAULT_TERMINAL_RETENTION_MS);
  const prActionable = input.prActionable !== false;

  if (!prActionable) {
    return { ok: true, reason: 'non_actionable_pr' };
  }

  if (!isLifecycleTerminal(entry)) {
    return { ok: false, reason: 'non_terminal_actionable_pr' };
  }

  const terminalAt = Number(entry.terminalAtMs ?? entry.lastUpdatedMs ?? 0);
  if (nowMs - terminalAt < retentionMs) {
    return { ok: false, reason: 'retention_floor' };
  }
  return { ok: true };
}

/**
 * @param {Record<string, unknown>} store
 * @param {string} deliveryKey
 * @param {Record<string, unknown>} patch
 * @param {number} [nowMs]
 */
export function upsertLifecycleEntry(store, deliveryKey, patch, nowMs = Date.now()) {
  const retentionMs = resolveTerminalRetentionMs();
  const compacted = compactLifecycleStore(store, { nowMs, retentionMs });
  const next = compacted.store;
  const key = String(deliveryKey ?? '').trim();
  if (!key) {
    return { ok: false, reason: 'missing_delivery_key', store: next };
  }
  const prior = next.entries[key] && typeof next.entries[key] === 'object'
    ? { ...next.entries[key] }
    : {};
  const merged = {
    ...prior,
    ...patch,
    deliveryKey: key,
    lastUpdatedMs: nowMs,
  };
  next.entries[key] = merged;
  next.lastUpdatedMs = nowMs;
  return { ok: true, store: next, entry: merged };
}

/**
 * @param {Record<string, unknown>} store
 * @param {string} deliveryKey
 */
export function getLifecycleEntry(store, deliveryKey) {
  const next = normalizeLifecycleStore(store);
  const key = String(deliveryKey ?? '').trim();
  return next.entries[key] ?? null;
}

/**
 * @param {Record<string, unknown>} journal
 * @param {string} deterministicKey
 */
export function findJournalEntryByDeterministicKey(journal, deterministicKey) {
  const key = String(deterministicKey ?? '').trim();
  if (!key) {
    return null;
  }
  for (const record of Object.values(journal ?? {})) {
    if (!record || typeof record !== 'object') {
      continue;
    }
    if (String(record.deterministicKey ?? '') === key) {
      return record;
    }
  }
  return null;
}

/**
 * @param {Record<string, unknown>} journal
 * @param {Record<string, unknown>} incoming
 */
export function evaluateDeterministicJournalAdmission(journal, incoming) {
  const deterministicKey = String(incoming.deterministicKey ?? '').trim();
  if (!deterministicKey) {
    return { ok: true, action: 'admit' };
  }

  let matched = null;
  for (const record of Object.values(journal ?? {})) {
    if (!record || typeof record !== 'object') {
      continue;
    }
    if (String(record.deterministicKey ?? '') === deterministicKey) {
      matched = record;
      break;
    }
  }

  if (!matched) {
    const conflict = findSameHeadJournalConflict(journal, deterministicKey);
    if (conflict) {
      return {
        ok: false,
        action: 'escalate_supersede',
        reason: 'different_findings_same_head',
        priorDeliveryId: String(conflict.deliveryId ?? ''),
      };
    }
    return { ok: true, action: 'admit' };
  }

  const outcome = String(matched.dispatchOutcome ?? '').trim();
  const lifecycleTerminal = String(matched.lifecycleTerminal ?? '').trim();
  if (lifecycleTerminal === TERMINAL_DELIVERED || outcome === 'dispatched') {
    return { ok: true, action: 'no_op_terminal', deliveryId: String(matched.deliveryId ?? '') };
  }
  if (outcome === 'dispatch_in_flight' || String(matched.lifecycleState ?? '') === LIFECYCLE_DELIVERY_CLAIMED) {
    return { ok: true, action: 'resume', deliveryId: String(matched.deliveryId ?? '') };
  }
  if (String(incoming.findingsHash ?? '') && String(matched.findingsHash ?? '') && incoming.findingsHash !== matched.findingsHash) {
    return { ok: false, action: 'escalate_supersede', reason: 'different_findings_same_head' };
  }
  return { ok: true, action: 'admit' };
}

runStdinJsonCli('review-delivery-lifecycle.mjs', {
  'hash-findings': () => {
    const payload = readStdinJson();
    return { findingsHash: hashReviewFindings(payload.findings) };
  },
  'build-delivery-key': () => {
    const payload = readStdinJson();
    const deliveryKey = buildDeterministicDeliveryKey(payload);
    if (!deliveryKey) {
      return { ok: false, reason: 'invalid_delivery_key_inputs' };
    }
    return { ok: true, deliveryKey };
  },
  'build-delivery-id': () => {
    const payload = readStdinJson();
    const deliveryId = buildDeterministicDeliveryId(payload.sessionId, payload.deliveryKey);
    if (!deliveryId) {
      return { ok: false, reason: 'invalid_delivery_id_inputs' };
    }
    return { ok: true, deliveryId };
  },
  'read-store': () => {
    const payload = readStdinJson();
    return readLifecycleStore(String(payload.path ?? ''));
  },
  'write-store': () => {
    const payload = readStdinJson();
    return writeLifecycleStore(String(payload.path ?? ''), payload.store ?? {});
  },
  'upsert-entry': () => {
    const payload = readStdinJson();
    const store = readLifecycleStore(String(payload.path ?? ''));
    const result = upsertLifecycleEntry(store, payload.deliveryKey, payload.patch ?? {}, Number(payload.nowMs ?? Date.now()));
    if (!result.ok) {
      return result;
    }
    writeLifecycleStore(String(payload.path ?? ''), result.store);
    return result;
  },
  'get-entry': () => {
    const payload = readStdinJson();
    const store = readLifecycleStore(String(payload.path ?? ''));
    return { entry: getLifecycleEntry(store, payload.deliveryKey) };
  },
  'can-evict': () => canEvictLifecycleEntry(readStdinJson()),
  'verdict-snapshot-lost': () => {
    const payload = readStdinJson();
    return { lost: isVerdictSnapshotLost(payload.entry) };
  },
  'can-resume': () => {
    const payload = readStdinJson();
    return { ok: canResumeDeliveryFromLifecycle(payload.entry) };
  },
  'evaluate-journal-admission': () => {
    const payload = readStdinJson();
    return evaluateDeterministicJournalAdmission(payload.journal ?? {}, payload.incoming ?? {});
  },
  'resolve-retention-ms': () => {
    const payload = readStdinJson();
    return { retentionMs: resolveTerminalRetentionMs(payload.env ?? process.env) };
  },
});
