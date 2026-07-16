import {
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  readCiRedWatchdogLedger,
  resolveCiRedWatchdogStoreDir,
  withCiRedWatchdogLedgerLock,
} from './ci-red-watchdog-ledger.mjs';

function positiveInt(value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
}

function retentionConfig(raw = {}) {
  return {
    resolvedRetentionMs: positiveInt(raw.lookupResolvedRetentionMs, 24 * 60 * 60_000, 1, 30 * 24 * 60 * 60_000),
    parkedRetentionMs: positiveInt(raw.lookupParkedRetentionMs, 7 * 24 * 60 * 60_000, 1, 90 * 24 * 60 * 60_000),
    maxHistory: positiveInt(raw.lookupHistoryMaxEntries, 512, 16, 10_000),
  };
}

function normalizedIdentity(input) {
  if (!input || typeof input !== 'object') return null;
  const repo = String(input.repo ?? '').trim().toLowerCase();
  const prNumber = Number(input.prNumber);
  const requiredCheckContext = String(input.requiredCheckContext ?? '').trim();
  const headSha = String(input.headSha ?? '').trim().toLowerCase();
  if (!repo || !Number.isInteger(prNumber) || prNumber <= 0 || !requiredCheckContext || !/^[0-9a-f]{40}$/.test(headSha)) return null;
  return { repo, prNumber, requiredCheckContext, headSha };
}

function writeLedger(storeDir, ledger) {
  const root = resolveCiRedWatchdogStoreDir(storeDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = path.join(root, 'ledger.json');
  const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  const payload = {
    schemaVersion: ledger.schemaVersion,
    nextSequence: ledger.nextSequence,
    episodes: ledger.episodes ?? {},
    lookupFailures: ledger.lookupFailures ?? {},
    history: Array.isArray(ledger.history) ? ledger.history : [],
    ...(Array.isArray(ledger.quarantinedPaths) ? { quarantinedPaths: ledger.quarantinedPaths } : {}),
  };
  writeFileSync(temp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, target);
}

function compactLookupHistory(ledger, maxEntries, removedKeys = new Set()) {
  const nonLookup = [];
  const lookup = [];
  for (const entry of Array.isArray(ledger.history) ? ledger.history : []) {
    const key = String(entry?.key ?? '');
    if (!key.startsWith('lookup:')) nonLookup.push(entry);
    else if (!removedKeys.has(key)) lookup.push(entry);
  }
  const compactedLookup = lookup.slice(-maxEntries);
  const changed = compactedLookup.length !== lookup.length || removedKeys.size > 0;
  ledger.history = [...nonLookup, ...compactedLookup]
    .sort((left, right) => Number(left?.sequence ?? 0) - Number(right?.sequence ?? 0));
  return changed;
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || snapshot.available !== true || !Array.isArray(snapshot.openPrs)) return null;
  const repo = String(snapshot.repo ?? '').trim().toLowerCase();
  if (!repo) return null;
  const heads = new Map();
  for (const row of snapshot.openPrs) {
    const rowRepo = String(row?.repo ?? repo).trim().toLowerCase();
    const prNumber = Number(row?.prNumber ?? row?.number);
    const headSha = String(row?.headSha ?? row?.headRefOid ?? '').trim().toLowerCase();
    if (rowRepo !== repo || !Number.isInteger(prNumber) || prNumber <= 0 || !/^[0-9a-f]{40}$/.test(headSha)) return null;
    heads.set(prNumber, headSha);
  }
  return { repo, heads };
}

function recordAgeMs(record, state, nowMs) {
  const anchor = state === 'resolved'
    ? Number(record?.resolvedAtMs ?? record?.updatedAtMs ?? record?.createdAtMs ?? nowMs)
    : Number(record?.updatedAtMs ?? record?.createdAtMs ?? nowMs);
  return Math.max(0, nowMs - anchor);
}

function removalReason(record, identity, authoritative, nowMs, retention) {
  const state = String(record?.state ?? '');
  const hasPr = authoritative.heads.has(identity.prNumber);
  const currentHead = authoritative.heads.get(identity.prNumber);
  const ageMs = recordAgeMs(record, state, nowMs);

  if (state === 'parked') {
    return ageMs >= retention.parkedRetentionMs ? 'parked_retention_expired' : '';
  }
  if (state === 'resolved') {
    return ageMs >= retention.resolvedRetentionMs ? 'resolved_retention_expired' : '';
  }
  if (state === 'deferred') {
    if (!hasPr) return 'authoritative_pr_terminal';
    if (currentHead && currentHead !== identity.headSha) return 'authoritative_head_superseded';
  }
  return '';
}

function appendRetentionTombstone(ledger, { key, record, identity, reason, atMs, actor }) {
  ledger.history.push({
    sequence: Number(ledger.nextSequence ?? 1),
    atMs,
    key: 'lookup:retention',
    actor: String(actor || 'ci-red-watchdog'),
    attemptId: '',
    from: String(record?.state ?? ''),
    to: 'pruned',
    reason,
    metadata: {
      lookupKey: key,
      repo: identity.repo,
      prNumber: identity.prNumber,
      requiredCheckContext: identity.requiredCheckContext,
      headSha: identity.headSha,
      lastDeferReason: String(record?.lastDeferReason ?? ''),
      parkedReason: String(record?.parkedReason ?? ''),
    },
  });
  ledger.nextSequence = Number(ledger.nextSequence ?? 1) + 1;
}

export function pruneCiRedWatchdogLookupFailures({
  storeDir = '',
  snapshot,
  nowMs = Date.now(),
  actor = 'ci-failure-notification-reconcile',
  config: rawConfig = {},
} = {}) {
  const retention = retentionConfig(rawConfig);
  const authoritative = normalizeSnapshot(snapshot);
  return withCiRedWatchdogLedgerLock(storeDir, () => {
    const ledger = readCiRedWatchdogLedger(storeDir);
    ledger.lookupFailures ??= {};
    if (!authoritative) {
      return {
        ok: true,
        pruned: false,
        historyCompacted: false,
        reason: 'authoritative_open_pr_snapshot_unavailable',
        removedKeys: [],
        ledger,
      };
    }

    const removed = [];
    const removedKeys = new Set();
    for (const [key, record] of Object.entries(ledger.lookupFailures)) {
      const identity = normalizedIdentity(record?.identity);
      if (!identity || identity.repo !== authoritative.repo) continue;
      const reason = removalReason(record, identity, authoritative, nowMs, retention);
      if (!reason) continue;
      removed.push({ key, record, identity, reason });
      delete ledger.lookupFailures[key];
      removedKeys.add(key);
    }

    let historyChanged = compactLookupHistory(ledger, retention.maxHistory, removedKeys);
    for (const item of removed) {
      appendRetentionTombstone(ledger, { ...item, atMs: nowMs, actor });
    }
    if (removed.length > 0) {
      compactLookupHistory(ledger, retention.maxHistory);
      historyChanged = true;
    }
    if (removed.length > 0 || historyChanged) writeLedger(storeDir, ledger);

    return {
      ok: true,
      pruned: removed.length > 0,
      historyCompacted: historyChanged,
      reason: 'authoritative_lookup_retention_applied',
      removedKeys: [...removedKeys],
      ledger,
    };
  }, { config: rawConfig });
}