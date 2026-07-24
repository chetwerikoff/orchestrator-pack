#!/usr/bin/env node
/**
 * Finding-disposition ledger guard (Issue #575, review economics Issue #975).
 * Legacy callers retain the original addressed-only protected behavior. The #975
 * economics/progression/acceptance contract is enabled explicitly through phase
 * options so historical consumers are not silently migrated.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  collectProtectedSignalMatches,
  loadProtectedSignalReceipt,
  suppressProtectedSignalHits,
} from './lib/protected-signal-receipt.mjs';

export const PROTECTED_TYPES = new Set(['security', 'scope-violation']);

const REVIEW_ECONOMICS_MARKER = 'review-economics-contract: v1';
const M5_CLEAN_TOKEN = 'SIMPLIFICATION_CLEAN';
const NO_FINDINGS_TOKEN = 'NO_FINDINGS';
const REVIEWER_STAGES = new Set(['competitive', 'architectural', 'architectural-final']);
const PRE_LENS_REVIEWER_STAGES = new Set(['competitive', 'architectural']);
const ANY_TYPE_PATTERN = /(?<!binding-)\btype:\s*([a-z][a-z0-9-]*)\b/gi;
const FINDING_ID_PATTERN = /(?<!binding-)\bid:\s*([A-Za-z0-9._-]+)\b/gi;
const FINDING_ID_EXTRACT = /(?<!binding-)\bid:\s*([A-Za-z0-9._-]+)\b/i;
const UNTYPED_FINDING_LINE = /^(?:\s*)(?:\[(P[0-3])\]|(P[0-3]))\s*[-–—:]\s*(.+)$/;
const ECHOED_ARTIFACT_MARKER = /^--- ARTIFACT\s/m;
const ECHOED_DRAFT_REVIEW_PROMPT = /^#\s+Codex draft\/spec review prompt/m;
const REVIEW_CAPTURE_NAME = /^pass-(\d+)-(competitive|architectural|architectural-lens|architectural-final)\.capture\.txt$/;
const FIELD_LINE = /^(id|type|severity|title|evidence|recommendation|persistent-machinery|cheapest-sufficient-alternative|stakes-price|trade-in|simplification-cut-candidate):\s*(.*)$/i;
const M3_LENS_LINE = /^m3-protected:\s*id=([A-Za-z0-9._-]+)\s*\|\s*revision=([^|]+?)\s*\|\s*contest=(none|contested|contest-withdrawn)\s*\|\s*outcome=(none|activate|non-activate)(?:\s*\|\s*evidence=([^|]*?))?(?:\s*\|\s*why-now=(.*))?\s*$/i;

const PROTECTED_SIGNAL_PATTERNS = [
  { type: 'security', pattern: /\btype:\s*security\b/i, nominationMetadata: true },
  { type: 'security', pattern: /\[(?:P[0-3]\s+)?security\]/i },
  { type: 'security', pattern: /\bsecurity\s+issue\b/i },
  { type: 'security', pattern: /\bvulnerabilit(?:y|ies)\b/i },
  { type: 'scope-violation', pattern: /\btype:\s*scope-violation\b/i, nominationMetadata: true },
  { type: 'scope-violation', pattern: /\[(?:P[0-3]\s+)?scope-violation\]/i },
  { type: 'scope-violation', pattern: /\bscope[- ]violation\b/i },
  { type: 'scope-violation', pattern: /\bout of scope\b/i },
  { type: 'scope-violation', pattern: /\bdenylist\b/i },
  { type: 'scope-violation', pattern: /\ballowed_roots\b/i },
];

const PROTECTED_EVIDENCE_PATTERNS = {
  security: [
    /\[(?:P[0-3]\s+)?security\]/i,
    /\bsecurity\s+issue\b/i,
    /\bvulnerabilit(?:y|ies)\b/i,
  ],
  'scope-violation': [
    /\[(?:P[0-3]\s+)?scope-violation\]/i,
    /\bscope[- ]violation\b/i,
    /\bout of scope\b/i,
    /\bdenylist\b/i,
    /\ballowed_roots\b/i,
  ],
};

function isCleanNoFindings(capture) {
  return capture.trim() === NO_FINDINGS_TOKEN;
}

function lineHasExactToken(text, token) {
  return text.split(/\r?\n/).some((line) => line.trim() === token);
}

function stringField(row, ...keys) {
  for (const key of keys) {
    if (typeof row?.[key] === 'string') return row[key].trim();
  }
  return '';
}

function booleanField(row, ...keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value === true || value === false) return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'yes' || normalized === 'true') return true;
      if (normalized === 'no' || normalized === 'false') return false;
    }
  }
  return false;
}

function parseProtectedActivation(row) {
  const value = row?.protectedActivation ?? row?.['protected-activation'];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      authority: stringField(value, 'authority').toLowerCase(),
      signal: stringField(value, 'signal', 'realSignal', 'real-signal'),
      whyNow: stringField(value, 'whyNow', 'why-now'),
    };
  }
  const authority = stringField(row, 'protectedActivationAuthority', 'protected-activation-authority').toLowerCase();
  const signal = stringField(row, 'protectedActivationSignal', 'protected-activation-signal');
  const whyNow = stringField(row, 'protectedActivationWhyNow', 'protected-activation-why-now');
  return authority || signal || whyNow ? { authority, signal, whyNow } : null;
}

export function detectUntypedFindingsInCapture(capture) {
  const scanText = extractFindingsScanText(capture);
  if (isCleanNoFindings(scanText) || scanText.length === 0) return [];
  const findings = [];
  const lines = scanText.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(UNTYPED_FINDING_LINE);
    if (!match) continue;
    const blockLines = [line];
    let next = index + 1;
    while (next < lines.length && !UNTYPED_FINDING_LINE.test(lines[next])) {
      blockLines.push(lines[next]);
      next += 1;
    }
    const block = blockLines.join('\n');
    if (/\btype:\s*[a-z][a-z0-9-]*\b/i.test(block)) {
      index = next - 1;
      continue;
    }
    const idMatch = block.match(FINDING_ID_EXTRACT);
    findings.push({
      id: idMatch ? idMatch[1] : `untyped-${findings.length + 1}`,
      hasCaptureId: Boolean(idMatch),
      type: 'untyped',
      anchor: index,
      summary: match[3].trim().slice(0, 160),
    });
    index = next - 1;
  }
  return findings;
}

export function stripMarkdownFencedCodeBlocks(text) {
  return text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
}

export function maskDelimitedMarkdownQuotes(text) {
  const preserveLines = (match) => match.replace(/[^\n]/g, ' ');
  const blankSpan = (match) => ' '.repeat(match.length);
  const blankExampleCodeSpan = (match, offset, fullText) => {
    if (/^`type:\s*(?:security|scope-violation)`$/i.test(match)) return blankSpan(match);
    const priorBreak = fullText.lastIndexOf('\n', offset - 1);
    const linePrefix = fullText.slice(priorBreak + 1, offset).trimEnd();
    return /\b(?:inline code span|quoted(?:\s+(?:example|tag|term|text))?|quote|example|regex pattern|test[- ]fixture string)\s*:\s*$/i.test(linePrefix)
      ? blankSpan(match)
      : match;
  };
  return [
    [/^```[^\n]*\n[\s\S]*?^```\s*$/gm, preserveLines],
    [/`[^`\n]+`/g, blankExampleCodeSpan],
    [/^>[^\n]*(?:\n|$)/gm, preserveLines],
    [/"(?:\\.|[^"\\\n])+"/g, blankSpan],
    [/(?<![A-Za-z0-9])'(?:\\.|[^'\\\n])+'(?![A-Za-z0-9])/g, blankSpan],
  ].reduce((current, [pattern, replacer]) => current.replace(pattern, replacer), text);
}

function hasEchoedReviewContext(text) {
  return ECHOED_ARTIFACT_MARKER.test(text) || ECHOED_DRAFT_REVIEW_PROMPT.test(text);
}

const TYPED_FINDING_LINE = /^(?<!binding-)\btype:\s*[a-z][a-z0-9-]*\b/i;

function isReviewerFindingLine(line) {
  const trimmed = line.trim();
  return trimmed === NO_FINDINGS_TOKEN || UNTYPED_FINDING_LINE.test(line) || TYPED_FINDING_LINE.test(trimmed);
}

function indexOfFirstReviewerFindingLine(text, fromIndex = 0) {
  const lines = text.slice(fromIndex).split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (isReviewerFindingLine(lines[index])) {
      const prefix = lines.slice(0, index).join('\n');
      return fromIndex + prefix.length + (index > 0 ? 1 : 0);
    }
  }
  return -1;
}

const INLINE_PROTECTED_FINDING_PATTERN = /(?<!binding-)\btype:\s*(security|scope-violation)\b[^\n]{0,320}?(?<!binding-)\bid:\s*[A-Za-z0-9._-]+\b|(?<!binding-)\bid:\s*[A-Za-z0-9._-]+\b[^\n]{0,320}?(?<!binding-)\btype:\s*(security|scope-violation)\b/i;

function indexOfInlineProtectedFinding(text, fromIndex = 0) {
  const match = INLINE_PROTECTED_FINDING_PATTERN.exec(text.slice(fromIndex));
  return match ? fromIndex + match.index : -1;
}

function indexOfFirstFindingSignal(text, fromIndex = 0) {
  const headerIdx = indexOfFirstReviewerFindingLine(text, fromIndex);
  const inlineIdx = indexOfInlineProtectedFinding(text, fromIndex);
  if (headerIdx < 0 && inlineIdx < 0) return -1;
  if (headerIdx < 0) return inlineIdx;
  if (inlineIdx < 0) return headerIdx;
  return Math.min(headerIdx, inlineIdx);
}

export function extractFindingsScanText(capture) {
  const withoutFences = maskDelimitedMarkdownQuotes(capture);
  if (isCleanNoFindings(withoutFences)) return withoutFences;
  if (!hasEchoedReviewContext(withoutFences)) return withoutFences;
  let scanFrom = 0;
  const artifactMatch = withoutFences.match(ECHOED_ARTIFACT_MARKER);
  if (artifactMatch?.index !== undefined) scanFrom = artifactMatch.index;
  else {
    const headerMatch = withoutFences.match(ECHOED_DRAFT_REVIEW_PROMPT);
    if (headerMatch?.index !== undefined) scanFrom = headerMatch.index;
  }
  const findingStart = indexOfFirstFindingSignal(withoutFences, scanFrom);
  if (findingStart < 0) return '';
  const tail = withoutFences.slice(findingStart).trimStart();
  if (tail === NO_FINDINGS_TOKEN) return NO_FINDINGS_TOKEN;
  return withoutFences.slice(findingStart);
}

export function parseLedger(ledgerText) {
  let parsed;
  try {
    parsed = JSON.parse(ledgerText);
  } catch (error) {
    throw new Error(`finding-ledger guard: ledger is not valid JSON (${error.message})`);
  }
  if (!Array.isArray(parsed.findings)) {
    throw new Error('finding-ledger guard: ledger must include a findings array');
  }
  const findings = parsed.findings.map((row, index) => {
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    const summary = typeof row.summary === 'string' ? row.summary.trim() : '';
    const type = typeof row.type === 'string' ? row.type.trim().toLowerCase() : '';
    const disposition = typeof row.disposition === 'string' ? row.disposition.trim().toLowerCase() : '';
    const rejectReason = stringField(row, 'rejectReason', 'reject-reason');
    if (!id) throw new Error(`finding-ledger guard: findings[${index}] missing id`);
    if (!summary) throw new Error(`finding-ledger guard: findings[${index}] missing summary`);
    if (!type) throw new Error(`finding-ledger guard: findings[${index}] missing type`);
    if (disposition !== 'addressed' && disposition !== 'rejected') {
      throw new Error(`finding-ledger guard: findings[${index}] disposition must be addressed or rejected`);
    }
    if (disposition === 'rejected' && !rejectReason) {
      throw new Error(`finding-ledger guard: findings[${index}] rejected findings require rejectReason`);
    }
    return {
      id,
      summary,
      type,
      disposition,
      rejectReason,
      persistentMachinery: stringField(row, 'persistentMachinery', 'persistent-machinery').toLowerCase(),
      cheapestSufficientAlternative: stringField(row, 'cheapestSufficientAlternative', 'cheapest-sufficient-alternative'),
      stakesPrice: stringField(row, 'stakesPrice', 'stakes-price'),
      tradeIn: stringField(row, 'tradeIn', 'trade-in'),
      proposalOutcome: stringField(row, 'proposalOutcome', 'proposal-outcome').toLowerCase(),
      proposalReason: stringField(row, 'proposalReason', 'proposal-reason'),
      simplificationCutCandidate: booleanField(row, 'simplificationCutCandidate', 'simplification-cut-candidate'),
      architectPending: booleanField(row, 'architectPending', 'architect-pending'),
      architectRequired: booleanField(row, 'architectRequired', 'architect-required'),
      protectedActivation: parseProtectedActivation(row),
    };
  });
  return { version: parsed.version ?? 1, draft: parsed.draft ?? null, findings };
}

export function detectTypedFindingsInCapture(capture) {
  const scanText = extractFindingsScanText(capture);
  if (isCleanNoFindings(scanText) || scanText.length === 0) return [];
  const findings = [];
  const seen = new Set();
  let match;
  ANY_TYPE_PATTERN.lastIndex = 0;
  while ((match = ANY_TYPE_PATTERN.exec(scanText)) !== null) {
    const type = match[1].toLowerCase();
    const key = `type:${type}@${match.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const windowStart = Math.max(0, match.index - 400);
    const windowEnd = Math.min(scanText.length, match.index + 120);
    const before = scanText.slice(windowStart, match.index);
    const after = scanText.slice(match.index, windowEnd);
    const idMatch = after.match(FINDING_ID_EXTRACT) ?? [...before.matchAll(FINDING_ID_PATTERN)].at(-1);
    findings.push({
      id: idMatch ? idMatch[1] : `capture-${type}@${match.index}`,
      hasCaptureId: Boolean(idMatch),
      type,
      anchor: match.index,
      summary: `${before}${after}`.replace(/\s+/g, ' ').trim().slice(0, 160),
    });
  }
  return findings;
}

export function detectProtectedSignalsInCapture(capture, options = {}) {
  const scanText = extractFindingsScanText(capture);
  if (isCleanNoFindings(scanText) || scanText.length === 0) return [];
  const patternSpecs = options.excludeNominationMetadata
    ? PROTECTED_SIGNAL_PATTERNS.filter(({ nominationMetadata }) => !nominationMetadata)
    : PROTECTED_SIGNAL_PATTERNS;
  const signals = [];
  for (const { type, pattern } of patternSpecs) {
    if (pattern.test(scanText)) signals.push(type);
    pattern.lastIndex = 0;
  }
  const hitSignals = [...new Set(signals)];
  const receipt = options.receipt ?? loadProtectedSignalReceipt(options);
  const matches = collectProtectedSignalMatches(
    scanText,
    patternSpecs.map(({ type, pattern }) => ({ signal: type, pattern })),
  );
  return suppressProtectedSignalHits(hitSignals, matches, receipt, 'finding-ledger', options.consumedReceiptEntries).hits;
}

function ledgerHasProtectedCoverage(ledger, protectedType) {
  return ledger.findings.some((row) => row.type === protectedType && row.disposition === 'addressed');
}

function ledgerHasProtectedRejection(ledger) {
  return ledger.findings.filter((row) => PROTECTED_TYPES.has(row.type) && row.disposition === 'rejected');
}

function ledgerRowForCaptureFinding(captureFinding, ledger, consumedLedgerIds = new Set()) {
  if (captureFinding.hasCaptureId) return ledger.findings.find((row) => row.id === captureFinding.id);
  return ledger.findings.find((row) => row.type === captureFinding.type && !consumedLedgerIds.has(row.id));
}

function validateCaptureFindingInLedger(captureFinding, ledger, errors, consumedLedgerIds, { reviewEconomics = false } = {}) {
  const row = ledgerRowForCaptureFinding(captureFinding, ledger, consumedLedgerIds);
  if (!row) {
    if (captureFinding.type === 'untyped') {
      errors.push(`untyped capture finding (id: ${captureFinding.id}) is missing from the ledger — add type: when normalizing`);
      return;
    }
    if (captureFinding.hasCaptureId) {
      errors.push(`capture finding type: ${captureFinding.type} (id: ${captureFinding.id}) is missing from the ledger`);
      return;
    }
    errors.push(`capture finding type: ${captureFinding.type} has no matching ledger row — normalize the reviewer finding into the ledger`);
    return;
  }
  consumedLedgerIds.add(row.id);
  if (captureFinding.type === 'untyped') return;
  if (PROTECTED_TYPES.has(captureFinding.type) && row.type !== captureFinding.type) {
    errors.push(`protected finding ${captureFinding.id} was reclassified in the ledger as type: ${row.type} (capture type: ${captureFinding.type})`);
    return;
  }
  if (!reviewEconomics && PROTECTED_TYPES.has(captureFinding.type) && row.disposition !== 'addressed') {
    errors.push(`protected finding ${captureFinding.id} (type: ${captureFinding.type}) must be disposition addressed`);
  }
}

export function mergeCaptureFindings(captures) {
  const merged = new Map();
  const errors = [];
  for (const capture of captures) {
    for (const finding of [...detectTypedFindingsInCapture(capture), ...detectUntypedFindingsInCapture(capture)]) {
      const existing = merged.get(finding.id);
      if (existing && existing.type !== finding.type) {
        if (existing.type === 'untyped' || finding.type === 'untyped') {
          merged.set(finding.id, finding.type === 'untyped' ? existing : finding);
          continue;
        }
        errors.push(`capture finding ${finding.id} has conflicting types across passes (${existing.type} vs ${finding.type})`);
      }
      merged.set(finding.id, finding);
    }
  }
  return { findings: [...merged.values()], errors };
}

function parseCaptureMetadata(captures, options, errors) {
  const supplied = Array.isArray(options.captureMetadata) ? options.captureMetadata : [];
  const metadata = captures.map((text, index) => {
    const raw = supplied[index] ?? {};
    const name = typeof raw.name === 'string' ? raw.name : `capture-${index + 1}.capture.txt`;
    const match = name.match(REVIEW_CAPTURE_NAME);
    const timestampMs = Number(raw.timestampMs);
    return {
      index,
      text,
      name,
      pass: match ? Number(match[1]) : null,
      stage: match ? match[2] : null,
      timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
    };
  });
  for (const meta of metadata) {
    if (meta.stage && meta.timestampMs === null) errors.push(`review-economics: capture ${meta.name} missing chronology timestamp`);
  }
  return metadata.sort((a, b) => {
    if (a.timestampMs !== null && b.timestampMs !== null && a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
    if (a.pass !== null && b.pass !== null && a.pass !== b.pass) return a.pass - b.pass;
    return a.index - b.index;
  });
}

function parseFindingBlocks(text) {
  const lines = text.split(/\r?\n/);
  const idIndexes = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^id:\s*[A-Za-z0-9._-]+\s*$/i.test(lines[index].trim())) idIndexes.push(index);
  }
  const findings = [];
  const errors = [];
  const seenIds = new Set();
  for (let ordinal = 0; ordinal < idIndexes.length; ordinal += 1) {
    const start = idIndexes[ordinal];
    const end = ordinal + 1 < idIndexes.length ? idIndexes[ordinal + 1] : lines.length;
    const fields = new Map();
    let currentKey = null;
    const addField = (key, value) => {
      const values = fields.get(key) ?? [];
      values.push(value);
      fields.set(key, values);
    };
    for (let index = start; index < end; index += 1) {
      const line = lines[index];
      const match = line.trim().match(FIELD_LINE);
      if (match) {
        currentKey = match[1].toLowerCase();
        addField(currentKey, match[2].trim());
      } else if (!line.trim() || [REVIEW_ECONOMICS_MARKER, NO_FINDINGS_TOKEN, M5_CLEAN_TOKEN].includes(line.trim())) {
        currentKey = null;
      } else if (currentKey && line.trim()) {
        const values = fields.get(currentKey);
        values[values.length - 1] = `${values.at(-1)}\n${line.trim()}`.trim();
      }
    }
    const one = (key) => (fields.get(key) ?? [])[0] ?? '';
    const id = one('id').trim();
    const type = one('type').trim().toLowerCase();
    const evidence = one('evidence').trim();
    const recommendation = one('recommendation').trim();
    const persistentMachinery = one('persistent-machinery').trim().toLowerCase();
    const price = {
      cheapestSufficientAlternative: one('cheapest-sufficient-alternative').trim(),
      stakesPrice: one('stakes-price').trim(),
      tradeIn: one('trade-in').trim(),
    };
    const candidateValues = fields.get('simplification-cut-candidate') ?? [];
    let cutCandidate = false;
    if (candidateValues.length > 1) errors.push(`review-economics: finding ${id || '<missing-id>'} has duplicate simplification-cut-candidate discriminator`);
    else if (candidateValues.length === 1) {
      if (candidateValues[0].trim() !== 'yes') errors.push(`review-economics: finding ${id || '<missing-id>'} has invalid simplification-cut-candidate value`);
      else cutCandidate = true;
    }
    if (!id) {
      errors.push('review-economics: governed finding missing stable id');
      continue;
    }
    if (seenIds.has(id)) errors.push(`review-economics: governed capture repeats finding id ${id}`);
    seenIds.add(id);
    if (!type) errors.push(`review-economics: finding ${id} missing type`);
    if (!evidence) errors.push(`review-economics: finding ${id} missing evidence`);
    if (!recommendation) errors.push(`review-economics: finding ${id} missing recommendation`);
    if (persistentMachinery !== 'yes' && persistentMachinery !== 'no') errors.push(`review-economics: finding ${id} persistent-machinery must be yes or no`);
    const missingPrice = persistentMachinery === 'yes'
      ? Object.entries(price).filter(([, value]) => !value).map(([key]) => key)
      : [];
    findings.push({ id, type, evidence, recommendation, persistentMachinery, ...price, missingPrice, cutCandidate });
  }
  const typedCount = (text.match(/^(?<!binding-)type:\s*[a-z][a-z0-9-]*\s*$/gim) ?? []).length;
  if (typedCount > findings.length) errors.push('review-economics: governed typed finding missing a stable id block');
  return {
    marker: lineHasExactToken(text, REVIEW_ECONOMICS_MARKER),
    noFindings: lineHasExactToken(text, NO_FINDINGS_TOKEN),
    simplificationClean: lineHasExactToken(text, M5_CLEAN_TOKEN),
    findings,
    errors,
  };
}

function parseEvidenceByFindingId(text) {
  const lines = text.split(/\r?\n/);
  const result = new Map();
  let currentId = '';
  let collectingEvidence = false;
  let evidence = [];
  const flush = () => {
    if (currentId && evidence.length > 0) result.set(currentId, evidence.join('\n').trim());
  };
  for (const line of lines) {
    const idMatch = line.trim().match(/^id:\s*([A-Za-z0-9._-]+)\s*$/i);
    if (idMatch) {
      flush();
      currentId = idMatch[1];
      collectingEvidence = false;
      evidence = [];
      continue;
    }
    if (/^evidence:\s*/i.test(line.trim())) {
      collectingEvidence = true;
      evidence = [line.trim().replace(/^evidence:\s*/i, '')];
      continue;
    }
    if (/^[a-z][a-z0-9-]*:\s*/i.test(line.trim())) {
      collectingEvidence = false;
      continue;
    }
    if (collectingEvidence && line.trim()) evidence.push(line.trim());
  }
  flush();
  return result;
}

function evidenceHasProtectedSignal(type, evidence) {
  return (PROTECTED_EVIDENCE_PATTERNS[type] ?? []).some((pattern) => pattern.test(evidence));
}

function parseM3LensLines(text, errors, sourceName) {
  const records = [];
  const seenIds = new Set();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^m3-protected:/i.test(trimmed)) continue;
    const match = trimmed.match(M3_LENS_LINE);
    if (!match) {
      const idMatch = trimmed.match(/^m3-protected:\s*id=([A-Za-z0-9._-]+)/i);
      errors.push(`review-economics: ${sourceName} has malformed m3-protected record${idMatch ? ` for ${idMatch[1]}` : ''}`);
      continue;
    }
    const id = match[1];
    if (seenIds.has(id)) {
      errors.push(`review-economics: ${sourceName} has duplicate m3-protected records for ${id}`);
      continue;
    }
    seenIds.add(id);
    records.push({
      id,
      revision: match[2].trim(),
      contest: match[3].toLowerCase(),
      outcome: match[4].toLowerCase(),
      evidence: (match[5] ?? '').trim(),
      whyNow: (match[6] ?? '').trim(),
    });
  }
  return records;
}

function foldM3LensState(metadata, currentRevision, errors) {
  const histories = new Map();
  for (const meta of metadata) {
    if (meta.stage !== 'architectural-lens') continue;
    for (const record of parseM3LensLines(meta.text, errors, meta.name)) {
      const history = histories.get(record.id) ?? [];
      history.push({ record, meta });
      histories.set(record.id, history);
    }
  }

  const states = new Map();
  for (const [id, history] of histories) {
    const latest = history.at(-1);
    if (!latest || !currentRevision || latest.record.revision !== currentRevision) {
      states.set(id, { record: latest?.record ?? null, current: false, contestOpen: false });
      continue;
    }

    let effective = null;
    let contestOpen = false;
    for (const { record } of history) {
      if (record.revision !== currentRevision) continue;
      if (record.outcome === 'activate' || record.outcome === 'non-activate') {
        contestOpen = false;
        effective = record;
        continue;
      }
      if (record.contest === 'contest-withdrawn') {
        contestOpen = false;
        effective = record;
        continue;
      }
      if (record.contest === 'contested') {
        contestOpen = true;
        effective = record;
        continue;
      }
      if (record.contest === 'none' && !contestOpen) effective = record;
    }
    states.set(id, { record: effective, current: Boolean(effective), contestOpen });
  }
  return states;
}

function validateRawCodexEconomics(rawResults, errors) {
  if (!Array.isArray(rawResults)) return;
  for (let index = 0; index < rawResults.length; index += 1) {
    const entry = rawResults[index];
    if (!entry || typeof entry !== 'object') {
      errors.push(`review-economics: raw Codex result ${index + 1} is not an object`);
      continue;
    }
    const stage = stringField(entry, 'stage', 'reviewStage', 'review-stage').toLowerCase();
    const raw = entry.raw && typeof entry.raw === 'object' && !Array.isArray(entry.raw) ? entry.raw : entry;
    if (!REVIEWER_STAGES.has(stage)) {
      errors.push(`review-economics: raw Codex result ${index + 1} missing governed stage identity before transcription`);
    }
    const contract = stringField(raw, 'reviewEconomicsContract', 'review-economics-contract');
    if (contract !== 'v1') errors.push(`review-economics: raw Codex result ${index + 1} missing review-economics-contract v1 before transcription`);
    const findings = Array.isArray(raw.findings) ? raw.findings : [];
    const tokens = Array.isArray(raw.terminalTokens) ? raw.terminalTokens : [];
    let hasCutCandidate = false;
    for (const finding of findings) {
      const id = stringField(finding, 'id') || '<missing-id>';
      const evidence = stringField(finding, 'evidence');
      const recommendation = stringField(finding, 'recommendation');
      const persistent = stringField(finding, 'persistentMachinery', 'persistent-machinery').toLowerCase();
      if (!stringField(finding, 'id')) errors.push(`review-economics: raw Codex finding ${id} missing id`);
      if (!evidence) errors.push(`review-economics: raw Codex finding ${id} missing evidence before transcription`);
      if (!recommendation) errors.push(`review-economics: raw Codex finding ${id} missing recommendation before transcription`);
      if (persistent !== 'yes' && persistent !== 'no') errors.push(`review-economics: raw Codex finding ${id} missing persistent-machinery before transcription`);
      if (persistent === 'yes') {
        for (const [label, keys] of [
          ['cheapest-sufficient-alternative', ['cheapestSufficientAlternative', 'cheapest-sufficient-alternative']],
          ['stakes-price', ['stakesPrice', 'stakes-price']],
          ['trade-in', ['tradeIn', 'trade-in']],
        ]) {
          if (!stringField(finding, ...keys)) errors.push(`review-economics: raw Codex finding ${id} missing ${label} before transcription`);
        }
      }
      const candidate = finding.simplificationCutCandidate ?? finding['simplification-cut-candidate'];
      if (candidate !== undefined && candidate !== 'yes' && candidate !== true) {
        errors.push(`review-economics: raw Codex finding ${id} has invalid simplification-cut-candidate before transcription`);
      }
      if (candidate === 'yes' || candidate === true) hasCutCandidate = true;
    }

    if (findings.length === 0 && !tokens.includes(NO_FINDINGS_TOKEN)) {
      errors.push(`review-economics: clean raw Codex result ${index + 1} missing ${NO_FINDINGS_TOKEN} before transcription`);
    }
    if (PRE_LENS_REVIEWER_STAGES.has(stage)) {
      if (hasCutCandidate && tokens.includes(M5_CLEAN_TOKEN)) {
        errors.push(`review-economics: pre-lens raw Codex result ${index + 1} cannot claim ${M5_CLEAN_TOKEN} while cut candidates are present`);
      }
      if (!hasCutCandidate && !tokens.includes(M5_CLEAN_TOKEN)) {
        errors.push(`review-economics: pre-lens raw Codex result ${index + 1} without cut candidate must carry ${M5_CLEAN_TOKEN} before transcription`);
      }
    }
  }
}

function validateM2(metadata, ledger, options, errors) {
  const adoptionTimestampMs = Number(options.adoptionTimestampMs);
  if (!Number.isFinite(adoptionTimestampMs)) {
    errors.push('review-economics: missing independently known adoption timestamp');
    return { parsedByName: new Map(), latestMarkedById: new Map(), governed: [] };
  }
  const parsedByName = new Map();
  const latestMarkedById = new Map();
  const governed = [];
  for (const meta of metadata) {
    if (!REVIEWER_STAGES.has(meta.stage)) continue;
    if (meta.timestampMs === null) continue;
    if (meta.timestampMs === adoptionTimestampMs) {
      errors.push(`review-economics: adoption chronology is ambiguous for ${meta.name}`);
      continue;
    }
    if (meta.timestampMs < adoptionTimestampMs) continue;

    const parsed = parseFindingBlocks(meta.text);
    governed.push(meta);
    if (!parsed.marker) {
      errors.push(`review-economics: post-adoption reviewer capture ${meta.name} missing ${REVIEW_ECONOMICS_MARKER}`);
      continue;
    }
    parsedByName.set(meta.name, parsed);
    for (const finding of parsed.findings) latestMarkedById.set(finding.id, { finding, meta });
    errors.push(...parsed.errors.map((error) => `${meta.name}: ${error}`));
  }
  if (options.phase === 'final-acceptance' && governed.length === 0) errors.push('review-economics: final acceptance requires governed reviewer evidence after adoption');
  for (const [id, { finding }] of latestMarkedById) {
    const row = ledger.findings.find((candidate) => candidate.id === id);
    if (!row) continue;
    if (row.persistentMachinery !== finding.persistentMachinery) errors.push(`review-economics: finding ${id} ledger persistent-machinery does not match latest marked occurrence`);
    if (finding.persistentMachinery === 'yes') {
      if (finding.missingPrice.length > 0) {
        const declinedMalformed = row.proposalOutcome === 'declined' && row.proposalReason === 'malformed-proposal';
        if (!declinedMalformed) errors.push(`review-economics: finding ${id} malformed persistent-machinery proposal requires row-local malformed-proposal decline`);
      } else {
        if (row.cheapestSufficientAlternative !== finding.cheapestSufficientAlternative) errors.push(`review-economics: finding ${id} cheapest-sufficient-alternative mismatch`);
        if (row.stakesPrice !== finding.stakesPrice) errors.push(`review-economics: finding ${id} stakes-price mismatch`);
        if (row.tradeIn !== finding.tradeIn) errors.push(`review-economics: finding ${id} trade-in mismatch`);
      }
    }
    if (row.simplificationCutCandidate !== finding.cutCandidate) errors.push(`review-economics: finding ${id} simplification-cut-candidate raw/ledger mismatch`);
  }
  return { parsedByName, latestMarkedById, governed };
}

function latestEvidenceById(metadata) {
  const result = new Map();
  for (const meta of metadata) {
    if (!REVIEWER_STAGES.has(meta.stage)) continue;
    for (const [id, evidence] of parseEvidenceByFindingId(meta.text)) result.set(id, { evidence, meta });
  }
  return result;
}

function validateM3(metadata, ledger, captureFindings, options, errors) {
  const protectedFindings = captureFindings.filter((finding) => PROTECTED_TYPES.has(finding.type));
  if (protectedFindings.length === 0) return;
  const evidenceById = latestEvidenceById(metadata);
  const currentRevision = typeof options.issueRevision === 'string' ? options.issueRevision.trim() : '';
  const lensStates = foldM3LensState(metadata, currentRevision, errors);
  for (const finding of protectedFindings) {
    const row = ledger.findings.find((candidate) => candidate.id === finding.id)
      ?? ledger.findings.find((candidate) => candidate.type === finding.type);
    if (!row) continue;
    const rawEvidence = evidenceById.get(finding.id)?.evidence ?? '';
    const zeroSignal = !evidenceHasProtectedSignal(finding.type, rawEvidence);
    const activation = row.protectedActivation;
    const validAuthorActivation = Boolean(
      activation
      && activation.authority === 'author'
      && activation.signal
      && activation.whyNow
      && evidenceHasProtectedSignal(finding.type, activation.signal)
      && !zeroSignal,
    );
    const lensState = lensStates.get(finding.id);
    const lensRecord = lensState?.record ?? null;
    const lensCurrent = Boolean(lensState?.current && lensRecord);
    const architectOutcome = lensCurrent ? lensRecord.outcome : 'none';
    const contestOpen = Boolean(lensState?.contestOpen);
    const contest = lensCurrent ? (contestOpen ? 'contested' : lensRecord.contest) : 'unknown';
    const contestUnambiguousAbsent = contest === 'none' || contest === 'contest-withdrawn';
    const architectRequired = zeroSignal || row.architectRequired || contestOpen || !validAuthorActivation;
    if (options.phase === 'pre-lens') {
      if (architectRequired) {
        if (!row.architectPending) errors.push(`review-economics: protected nomination ${finding.id} requires architect-pending before lens progression`);
        continue;
      }
      if (row.disposition !== 'addressed') errors.push(`review-economics: activated protected nomination ${finding.id} must be disposition addressed`);
      continue;
    }
    if (row.architectPending) {
      errors.push(`review-economics: protected nomination ${finding.id} must clear architect-pending before final acceptance`);
      continue;
    }
    if (!currentRevision) {
      errors.push(`review-economics: final acceptance missing current Issue revision for protected nomination ${finding.id}`);
      continue;
    }
    if (!lensCurrent) {
      errors.push(`review-economics: protected nomination ${finding.id} has unknown/stale architect contest state for revision ${currentRevision}`);
      continue;
    }
    if (architectOutcome === 'activate') {
      if (!lensRecord.evidence || !lensRecord.whyNow || !evidenceHasProtectedSignal(finding.type, lensRecord.evidence)) errors.push(`review-economics: architect activation ${finding.id} lacks current real protected evidence + why-now provenance`);
      if (row.disposition !== 'addressed') errors.push(`review-economics: architect-activated protected nomination ${finding.id} must be disposition addressed`);
      continue;
    }
    if (architectOutcome === 'non-activate') continue;
    if (contestOpen) {
      errors.push(`review-economics: protected nomination ${finding.id} remains architect-pending under current contest`);
      continue;
    }
    if (zeroSignal || row.architectRequired || !validAuthorActivation) {
      errors.push(`review-economics: protected nomination ${finding.id} requires current architect adjudication`);
      continue;
    }
    if (!contestUnambiguousAbsent) {
      errors.push(`review-economics: protected nomination ${finding.id} contest state is not unambiguously absent/withdrawn`);
      continue;
    }
    if (row.disposition !== 'addressed') errors.push(`review-economics: author-activated protected nomination ${finding.id} must be disposition addressed`);
  }
}

function selectM5Anchor(metadata, phase) {
  if (phase === 'pre-lens') return [...metadata].reverse().find((meta) => PRE_LENS_REVIEWER_STAGES.has(meta.stage)) ?? null;
  const latestLensIndex = metadata.map((meta) => meta.stage).lastIndexOf('architectural-lens');
  if (latestLensIndex < 0) return null;
  for (let index = latestLensIndex - 1; index >= 0; index -= 1) {
    if (PRE_LENS_REVIEWER_STAGES.has(metadata[index].stage)) return metadata[index];
  }
  return null;
}

function validateM5(metadata, ledger, parsedByName, options, errors) {
  const adoptionTimestampMs = Number(options.adoptionTimestampMs);
  if (options.phase === 'pre-lens' && options.stageTerminalConfirmed !== true) {
    errors.push('review-economics: pre-lens progression requires existing stage authority to confirm a legal terminal reviewer state');
    return;
  }
  const anchor = selectM5Anchor(metadata, options.phase);
  if (!anchor) {
    errors.push(`review-economics: ${options.phase} cannot resolve a terminal pre-lens M5 anchor`);
    return;
  }
  if (anchor.timestampMs === null || !Number.isFinite(adoptionTimestampMs)) return;
  if (anchor.timestampMs <= adoptionTimestampMs) {
    if (options.phase === 'final-acceptance') errors.push('review-economics: pre-adoption M5 anchor cannot satisfy final acceptance; governed post-adoption pre-lens re-entry is required');
    else errors.push('review-economics: pre-lens M5 anchor must be post-adoption');
    return;
  }
  const parsed = parsedByName.get(anchor.name) ?? parseFindingBlocks(anchor.text);
  if (!parsed.marker) {
    errors.push(`review-economics: M5 anchor ${anchor.name} is not governed/marked`);
    return;
  }
  const candidates = parsed.findings.filter((finding) => finding.cutCandidate);
  if (candidates.length === 0) {
    if (!parsed.simplificationClean) errors.push(`review-economics: M5 anchor ${anchor.name} without cut candidate must carry ${M5_CLEAN_TOKEN}`);
    if (parsed.findings.length === 0 && !parsed.noFindings) errors.push(`review-economics: genuinely clean M5 anchor ${anchor.name} must carry ${NO_FINDINGS_TOKEN}`);
  } else {
    if (parsed.simplificationClean) errors.push(`review-economics: M5 anchor ${anchor.name} cannot claim ${M5_CLEAN_TOKEN} while cut candidates are present`);
    for (const candidate of candidates) {
      const row = ledger.findings.find((item) => item.id === candidate.id);
      if (!row) continue;
      if (options.phase === 'pre-lens' && !row.simplificationCutCandidate) errors.push(`review-economics: M5 cut candidate ${candidate.id} missing matching ledger flag`);
      if (PROTECTED_TYPES.has(row.type) && row.architectPending) continue;
      if (row.disposition !== 'addressed' && row.disposition !== 'rejected') errors.push(`review-economics: M5 cut candidate ${candidate.id} is not dispositioned or architect-pending`);
    }
  }
  if (options.phase === 'pre-lens') {
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    for (const row of ledger.findings) {
      if (row.simplificationCutCandidate && !candidateIds.has(row.id)) errors.push(`review-economics: ledger candidate ${row.id} has no raw yes discriminator in current M5 anchor`);
    }
  }
}

function validateReviewEconomics(captures, ledger, captureFindings, options, errors) {
  if (options.phase !== 'pre-lens' && options.phase !== 'final-acceptance') {
    errors.push('review-economics: phase must be pre-lens or final-acceptance');
    return;
  }
  validateRawCodexEconomics(options.rawCodexResults, errors);
  const metadata = parseCaptureMetadata(captures, options, errors);
  const { parsedByName } = validateM2(metadata, ledger, options, errors);
  validateM3(metadata, ledger, captureFindings, options, errors);
  validateM5(metadata, ledger, parsedByName, options, errors);
}

export function checkFindingLedgerGuard(captureOrCaptures, ledgerText, options = {}) {
  const captures = Array.isArray(captureOrCaptures) ? captureOrCaptures : [captureOrCaptures];
  const errors = [];
  const ledger = parseLedger(ledgerText);
  const reviewEconomics = options.reviewEconomics === true || Boolean(options.phase);
  const receipt = loadProtectedSignalReceipt(options);
  const consumedReceiptEntries = new Set();
  if (!reviewEconomics) {
    for (const row of ledgerHasProtectedRejection(ledger)) errors.push(`protected finding ${row.id} (type: ${row.type}) cannot be disposed rejected`);
  }
  const { findings: captureFindings, errors: mergeErrors } = mergeCaptureFindings(captures);
  errors.push(...mergeErrors);
  const consumedLedgerIds = new Set();
  for (const captureFinding of captureFindings) validateCaptureFindingInLedger(captureFinding, ledger, errors, consumedLedgerIds, { reviewEconomics });
  const protectedSignals = new Set();
  for (const capture of captures) {
    for (const signal of detectProtectedSignalsInCapture(capture, {
      ...options,
      receipt,
      consumedReceiptEntries,
      excludeNominationMetadata: reviewEconomics,
    })) protectedSignals.add(signal);
  }
  const protectedConsumedLedgerIds = new Set();
  for (const protectedType of protectedSignals) {
    const typedInCapture = captureFindings.some((row) => row.type === protectedType);
    const covered = typedInCapture
      ? captureFindings.filter((row) => row.type === protectedType).every((row) => {
          const ledgerRow = ledgerRowForCaptureFinding(row, ledger, protectedConsumedLedgerIds);
          return ledgerRow && ledgerRow.type === row.type && ledgerRow.disposition === 'addressed';
        })
      : ledgerHasProtectedCoverage(ledger, protectedType);
    if (!covered) errors.push(`protected signal type: ${protectedType} present in capture but not addressed in the ledger`);
  }
  if (!reviewEconomics) {
    for (const row of ledger.findings) {
      if (PROTECTED_TYPES.has(row.type) && row.disposition !== 'addressed' && !errors.some((message) => message.includes(row.id))) {
        errors.push(`protected finding ${row.id} (type: ${row.type}) must be disposition addressed`);
      }
    }
  } else validateReviewEconomics(captures, ledger, captureFindings, options, errors);
  return { ok: errors.length === 0, errors, ledger, captureFindings, protectedSignals: [...protectedSignals] };
}

function listCaptureFilesInDir(capturesDir) {
  return readdirSync(capturesDir).filter((name) => name.endsWith('.capture.txt')).sort().map((name) => path.join(capturesDir, name));
}

function parseCliTimestamp(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function runCli(argv) {
  const ledgerFlag = argv.indexOf('--ledger');
  const capturesDirFlag = argv.indexOf('--captures-dir');
  const capturePaths = [];
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--capture' && argv[index + 1]) {
      capturePaths.push(argv[index + 1]);
      index += 1;
    }
  }
  if (capturesDirFlag >= 0) capturePaths.push(...listCaptureFilesInDir(argv[capturesDirFlag + 1]));
  if (ledgerFlag < 0 || capturePaths.length === 0) {
    process.stderr.write('finding-ledger guard: --ledger <path> and at least one --capture <path> or --captures-dir <path> are required\n');
    return 2;
  }
  const ledgerPath = argv[ledgerFlag + 1];
  const draftPathFlag = argv.indexOf('--draft-path');
  const repoRootFlag = argv.indexOf('--repo-root');
  const phaseFlag = argv.indexOf('--phase');
  const adoptionFlag = argv.indexOf('--adoption-timestamp');
  const revisionFlag = argv.indexOf('--issue-revision');
  const captures = capturePaths.map((capturePath) => readFileSync(capturePath, 'utf8'));
  const ledgerText = readFileSync(ledgerPath, 'utf8');
  const options = {
    draftPath: draftPathFlag >= 0 ? argv[draftPathFlag + 1] : undefined,
    repoRoot: repoRootFlag >= 0 ? argv[repoRootFlag + 1] : process.cwd(),
  };
  if (phaseFlag >= 0) {
    const adoptionTimestampMs = parseCliTimestamp(argv[adoptionFlag + 1]);
    options.phase = argv[phaseFlag + 1];
    options.adoptionTimestampMs = adoptionTimestampMs;
    options.issueRevision = revisionFlag >= 0 ? argv[revisionFlag + 1] : '';
    options.stageTerminalConfirmed = argv.includes('--stage-terminal');
    options.captureMetadata = capturePaths.map((capturePath) => ({ name: path.basename(capturePath), timestampMs: statSync(capturePath).mtimeMs }));
    if (adoptionFlag < 0 || adoptionTimestampMs === null) {
      process.stderr.write('finding-ledger guard: --phase requires a valid --adoption-timestamp <ISO-8601>\n');
      return 2;
    }
    if (options.phase === 'final-acceptance' && !options.issueRevision) {
      process.stderr.write('finding-ledger guard: final-acceptance phase requires --issue-revision <identity>\n');
      return 2;
    }
  }
  let result;
  try {
    result = checkFindingLedgerGuard(captures, ledgerText, options);
  } catch (error) {
    process.stderr.write(`finding-ledger guard: ${error.message}\n`);
    return 1;
  }
  if (!result.ok) {
    for (const error of result.errors) process.stderr.write(`finding-ledger guard: ${error}\n`);
    return 1;
  }
  process.stdout.write(`finding-ledger guard: PASS (${captures.length} capture file(s))\n`);
  return 0;
}

function isCliMain() {
  const entry = process.argv[1]?.replace(/\\/g, '/');
  return Boolean(entry?.endsWith('finding-ledger-guard.mjs'));
}

if (isCliMain()) process.exit(runCli(process.argv));
