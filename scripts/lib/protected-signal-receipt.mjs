import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const PROTECTED_SIGNAL_RECEIPT_FILENAME = 'protected-signal-receipt.json';

const VALID_GUARDS = new Set(['tier-marker', 'finding-ledger']);
const VALID_REASONS = new Set(['architect-false-positive', 'fixture-self-reference']);
const ISO_8601_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isStrictIso8601Timestamp(value) {
  return ISO_8601_TIMESTAMP_RE.test(value) && Number.isFinite(Date.parse(value));
}

export function normalizeProtectedSignalSpan(value) {
  return String(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

export function fingerprintProtectedSignalSpan(value) {
  const normalized = normalizeProtectedSignalSpan(value);
  return `sha256:${createHash('sha256').update(normalized).digest('hex')}`;
}

function resolveReceiptDir(draftPath, repoRoot = process.cwd()) {
  if (!draftPath) {
    return null;
  }
  const normalizedDraftPath = String(draftPath).replace(/\\/g, '/');
  const stem = path.basename(normalizedDraftPath, '.md');
  if (path.isAbsolute(draftPath)) {
    return path.join(path.dirname(draftPath), '.review', stem);
  }
  return path.join(repoRoot, 'docs/issues_drafts/.review', stem);
}

function isInsideDirectory(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function loadProtectedSignalReceipt(options = {}) {
  const receiptDir = options.receiptDir ?? resolveReceiptDir(options.draftPath, options.repoRoot);
  if (!receiptDir) {
    return { entries: [], invalid: false, reason: 'missing-draft-path' };
  }

  const receiptPath = options.receiptPath ?? path.join(receiptDir, PROTECTED_SIGNAL_RECEIPT_FILENAME);
  if (!existsSync(receiptPath)) {
    return { entries: [], invalid: false, receiptDir, receiptPath };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch {
    return { entries: [], invalid: true, receiptDir, receiptPath, reason: 'invalid-json' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { entries: [], invalid: true, receiptDir, receiptPath, reason: 'invalid-root' };
  }

  const recordedAt = typeof parsed['recorded-at'] === 'string' ? parsed['recorded-at'].trim() : '';
  const decisionLog = typeof parsed['decision-log'] === 'string' ? parsed['decision-log'].trim() : '';
  if (!recordedAt || !isStrictIso8601Timestamp(recordedAt) || !decisionLog) {
    return { entries: [], invalid: true, receiptDir, receiptPath, reason: 'invalid-header' };
  }

  const resolvedReceiptDir = path.resolve(receiptDir);
  const decisionLogPath = path.resolve(receiptDir, decisionLog);
  if (
    path.isAbsolute(decisionLog) ||
    decisionLog.includes('\0') ||
    !isInsideDirectory(resolvedReceiptDir, decisionLogPath) ||
    !existsSync(decisionLogPath)
  ) {
    return { entries: [], invalid: true, receiptDir, receiptPath, reason: 'invalid-decision-log' };
  }

  if (!Array.isArray(parsed.entries)) {
    return { entries: [], invalid: true, receiptDir, receiptPath, reason: 'invalid-entries' };
  }

  const entries = [];
  const seen = new Set();
  for (const [index, entry] of parsed.entries.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { entries: [], invalid: true, receiptDir, receiptPath, reason: `invalid-entry-${index}` };
    }
    const guard = typeof entry.guard === 'string' ? entry.guard.trim() : '';
    const signal = typeof entry.signal === 'string' ? entry.signal.trim() : '';
    const fingerprint = typeof entry.fingerprint === 'string' ? entry.fingerprint.trim() : '';
    const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
    const rationale = typeof entry.rationale === 'string' ? entry.rationale.trim() : '';
    const occurrence = entry.occurrence;
    if (
      !VALID_GUARDS.has(guard) ||
      !signal ||
      !/^sha256:[0-9a-f]{64}$/i.test(fingerprint) ||
      !VALID_REASONS.has(reason) ||
      !rationale
    ) {
      return { entries: [], invalid: true, receiptDir, receiptPath, reason: `invalid-entry-${index}` };
    }
    if (
      occurrence !== undefined &&
      (typeof occurrence !== 'number' || !Number.isInteger(occurrence) || occurrence < 0)
    ) {
      return { entries: [], invalid: true, receiptDir, receiptPath, reason: `invalid-entry-${index}` };
    }
    const key = `${guard}\0${signal}\0${fingerprint.toLowerCase()}\0${occurrence ?? ''}`;
    if (seen.has(key)) {
      return { entries: [], invalid: true, receiptDir, receiptPath, reason: 'duplicate-entry' };
    }
    seen.add(key);
    entries.push({
      guard,
      signal,
      fingerprint: fingerprint.toLowerCase(),
      occurrence,
      reason,
      rationale,
      anchor: entry.anchor,
    });
  }

  return { entries, invalid: false, receiptDir, receiptPath, recordedAt, decisionLogPath };
}

export function collectProtectedSignalMatches(text, patternSpecs) {
  const matches = [];
  for (const spec of patternSpecs) {
    const flags = spec.pattern.flags.includes('g') ? spec.pattern.flags : `${spec.pattern.flags}g`;
    const pattern = new RegExp(spec.pattern.source, flags);
    for (const match of text.matchAll(pattern)) {
      const raw = match[0] ?? '';
      if (!raw) {
        continue;
      }
      matches.push({
        signal: spec.signal,
        raw,
        fingerprint: fingerprintProtectedSignalSpan(raw),
        index: match.index ?? 0,
      });
    }
  }
  matches.sort((a, b) => a.index - b.index || a.signal.localeCompare(b.signal));
  const bySignal = new Map();
  for (const match of matches) {
    const signalMatches = bySignal.get(match.signal) ?? [];
    match.occurrence = signalMatches.length;
    signalMatches.push(match);
    bySignal.set(match.signal, signalMatches);
  }
  return matches;
}

export function suppressProtectedSignalHits(hitSignals, matches, receipt, guard) {
  if (!receipt || receipt.invalid || !Array.isArray(receipt.entries) || receipt.entries.length === 0) {
    return { hits: [...hitSignals], suppressed: [] };
  }

  const consumedEntries = new Set();
  const remainingSignals = [];
  const suppressed = [];
  for (const signal of hitSignals) {
    const signalMatches = matches.filter((match) => match.signal === signal);
    let hasUnmatchedSignal = signalMatches.length === 0;
    for (const match of signalMatches) {
      const sameFingerprintCount = signalMatches.filter(
        (candidate) => candidate.fingerprint === match.fingerprint,
      ).length;
      const entry = receipt.entries.find((candidate) => {
        const entryKey =
          `${candidate.guard}\0${candidate.signal}\0${candidate.fingerprint}\0${candidate.occurrence ?? ''}`;
        return (
          !consumedEntries.has(entryKey) &&
          candidate.guard === guard &&
          candidate.signal === signal &&
          candidate.fingerprint === match.fingerprint &&
          (sameFingerprintCount === 1
            ? candidate.occurrence === undefined || candidate.occurrence === match.occurrence
            : candidate.occurrence === match.occurrence)
        );
      });
      if (entry) {
        consumedEntries.add(
          `${entry.guard}\0${entry.signal}\0${entry.fingerprint}\0${entry.occurrence ?? ''}`,
        );
        suppressed.push({ signal, fingerprint: match.fingerprint, occurrence: match.occurrence });
        continue;
      }
      hasUnmatchedSignal = true;
    }
    if (hasUnmatchedSignal) {
      remainingSignals.push(signal);
    }
  }

  return {
    hits: remainingSignals,
    suppressed,
  };
}
