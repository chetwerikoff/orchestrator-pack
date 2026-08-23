#!/usr/bin/env node
/** Finding-disposition ledger guard (Issues #575, #975, #1150). */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  CLAUDE_PRODUCER_EVIDENCE_SCHEMA,
  STAGE_COMPLETENESS_RECEIPT_SCHEMA,
  deriveReviewEpisodeState,
  findLegacyReceiptPaths,
  resolveCanonicalReviewDirectory,
  validateReviewEpisodeTopology,
} from './lib/stage-completeness-core.ts';
import { checkRemoteAuthorities } from './lib/create-issue-stage-topology.ts';

export const PROTECTED_TYPES = new Set(['security', 'scope-violation']);
const REVIEW_ECONOMICS_MARKER = 'review-economics-contract: v1';
const M5_CLEAN_TOKEN = 'SIMPLIFICATION_CLEAN';
const NO_FINDINGS_TOKEN = 'NO_FINDINGS';
const REVIEWER_STAGES = new Set(['competitive', 'architectural-review', 'architectural', 'architectural-final']);
const PROTECTED_PATTERNS = {
  security: [/\btype:\s*security\b/i, /\bsecurity\s+issue\b/i, /\bvulnerabilit(?:y|ies)\b/i],
  'scope-violation': [/\btype:\s*scope-violation\b/i, /\bscope[- ]violation\b/i, /\bout[- ]of[- ]scope\b/i, /\bdenylist\b/i, /\ballowed_roots\b/i],
};
const FINDING_FIELDS = new Set([
  'id', 'type', 'severity', 'title', 'evidence', 'recommendation',
  'persistent-machinery', 'cheapest-sufficient-alternative', 'stakes-price',
  'trade-in', 'simplification-cut-candidate',
]);
const DEFECT_DISPOSITIONS = new Set(['addressed', 'rejected-as-false', 'unresolved']);
const REMEDY_DISPOSITIONS = new Set(['accepted', 'replaced-by-cheaper-sufficient', 'rejected-as-overengineering']);
const CAPTURE_NAME_RE = /^pass-(\d+)-(competitive|architectural-review|architectural-lens|architectural-final|architectural)(?:-(\d{2}))?\.capture\.txt$/i;
const M3_LINE_RE = /^m3-protected:\s*id=([^|]+?)\s*\|\s*revision=([^|]+?)\s*\|\s*contest=(none|contested|contest-withdrawn)\s*\|\s*outcome=(none|activate|non-activate)(?:\s*\|\s*evidence=([^|]*?))?(?:\s*\|\s*why-now=(.*?))?\s*$/i;
const REQUIRED_COUNT_FIELDS = ['rawFindingCount', 'distinctFindingCount', 'processedDistinctCount'];

function isRecord(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function stringField(row, ...keys) {
  for (const key of keys) if (typeof row?.[key] === 'string') return row[key].trim();
  return '';
}
function booleanField(row, ...keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value === true || value === false) return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'yes' || normalized === 'true') return true;
      if (normalized === 'no' || normalized === 'false' || normalized === '') return false;
    }
  }
  return false;
}
function normalizePersistent(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (text === 'yes' || value === true) return 'yes';
  if (text === 'no' || value === false) return 'no';
  return '';
}
function parseProtectedActivation(row) {
  const raw = row?.['protected-activation'] ?? row?.protectedActivation;
  if (raw === undefined || raw === null || raw === false) return null;
  if (!isRecord(raw)) throw new Error('finding-ledger guard: protectedActivation must be an object');
  return { authority: stringField(raw, 'authority'), signal: stringField(raw, 'signal'), whyNow: stringField(raw, 'why-now', 'whyNow') };
}
function parseProtectedOccurrenceStates(row, rowIndex) {
  const raw = row?.protectedOccurrences ?? row?.['protected-occurrences'];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`finding-ledger guard: findings[${rowIndex}] protectedOccurrences must be an array`);
  const result = [];
  for (let index = 0; index < raw.length; index += 1) {
    const state = raw[index];
    if (state === undefined || state === null) continue;
    if (!isRecord(state)) throw new Error(`finding-ledger guard: findings[${rowIndex}].protectedOccurrences[${index}] must be an object`);
    const occurrenceId = stringField(state, 'occurrenceId', 'occurrence-id');
    if (!occurrenceId) throw new Error(`finding-ledger guard: findings[${rowIndex}].protectedOccurrences[${index}] missing occurrenceId`);
    result.push({
      occurrenceId,
      architectPending: booleanField(state, 'architectPending', 'architect-pending'),
      architectRequired: booleanField(state, 'architectRequired', 'architect-required'),
      protectedActivation: parseProtectedActivation(state),
    });
  }
  return result;
}

export function parseLedger(ledgerText) {
  let parsed;
  try { parsed = JSON.parse(ledgerText || '{}'); }
  catch (error) { throw new Error(`finding-ledger guard: invalid ledger JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!isRecord(parsed)) throw new Error('finding-ledger guard: ledger must be an object');
  if (!Array.isArray(parsed.findings)) throw new Error('finding-ledger guard: findings must be an array');
  const findings = parsed.findings.map((row, index) => {
    if (!isRecord(row)) throw new Error(`finding-ledger guard: findings[${index}] must be an object`);
    const id = stringField(row, 'id');
    if (!id) throw new Error(`finding-ledger guard: findings[${index}] missing id`);
    const legacyDisposition = stringField(row, 'disposition');
    const defectDisposition = stringField(row, 'defectDisposition', 'defect-disposition')
      || (legacyDisposition === 'rejected' ? 'rejected-as-false' : legacyDisposition === 'addressed' ? 'addressed' : '');
    const remedyDisposition = stringField(row, 'remedyDisposition', 'remedy-disposition') || 'accepted';
    const occurrences = Array.isArray(row.occurrences)
      ? row.occurrences.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : [];
    return {
      id, summary: stringField(row, 'summary'), type: stringField(row, 'type').toLowerCase() || 'quality',
      disposition: legacyDisposition, rejectReason: stringField(row, 'rejectReason', 'reject-reason'),
      defectDisposition, remedyDisposition, occurrences,
      persistentMachinery: normalizePersistent(row['persistent-machinery'] ?? row.persistentMachinery),
      cheapestSufficientAlternative: stringField(row, 'cheapest-sufficient-alternative', 'cheapestSufficientAlternative'),
      stakesPrice: stringField(row, 'stakes-price', 'stakesPrice'), tradeIn: stringField(row, 'trade-in', 'tradeIn'),
      proposalOutcome: stringField(row, 'proposal-outcome', 'proposalOutcome'),
      proposalReason: stringField(row, 'proposal-reason', 'proposalReason'),
      simplificationCutCandidate: booleanField(row, 'simplification-cut-candidate', 'simplificationCutCandidate'),
      architectPending: booleanField(row, 'architectPending', 'architect-pending'),
      architectRequired: booleanField(row, 'architectRequired', 'architect-required'),
      protectedActivation: parseProtectedActivation(row),
      protectedOccurrences: parseProtectedOccurrenceStates(row, index),
    };
  });
  return { version: Number.isInteger(parsed.version) ? parsed.version : 1, draft: typeof parsed.draft === 'string' ? parsed.draft : null, counts: isRecord(parsed.counts) ? parsed.counts : null, findings };
}

export function stripMarkdownFencedCodeBlocks(text) { return String(text ?? '').replace(/```[\s\S]*?```/g, (block) => '\n'.repeat((block.match(/\n/g) ?? []).length)); }
export function maskDelimitedMarkdownQuotes(text) { return String(text ?? '').split(/\r?\n/).map((line) => /^\s*>/.test(line) ? '' : line).join('\n'); }
export function extractFindingsScanText(capture) { return maskDelimitedMarkdownQuotes(stripMarkdownFencedCodeBlocks(String(capture ?? ''))); }

function parseFindingBlocks(capture, captureIndex = 0, captureIdentity = null, stage = null) {
  const lines = extractFindingsScanText(capture).split(/\r?\n/); const findings = []; let current = null;
  function flush() {
    if (!current) return;
    current.ordinal = findings.length + 1;
    current.occurrenceId = captureIdentity ? `${captureIdentity}:${current.ordinal}` : `${current.id}@${captureIndex}:${current.ordinal}`;
    current.stage = stage; findings.push(current); current = null;
  }
  for (const line of lines) {
    const match = /^([a-z][a-z0-9-]*):\s*(.*)$/i.exec(line.trim()); if (!match) continue;
    const field = match[1].toLowerCase(); const value = match[2].trim();
    if (field === 'id') { flush(); current = { id: value, hasCaptureId: Boolean(value), fields: {} }; continue; }
    if (!current || !FINDING_FIELDS.has(field)) continue; current.fields[field] = value;
  }
  flush();
  return findings.map((finding) => ({
    id: finding.id, hasCaptureId: finding.hasCaptureId, type: String(finding.fields.type ?? '').toLowerCase() || 'quality',
    severity: String(finding.fields.severity ?? ''), title: String(finding.fields.title ?? ''), evidence: String(finding.fields.evidence ?? ''),
    recommendation: String(finding.fields.recommendation ?? ''), persistentMachinery: normalizePersistent(finding.fields['persistent-machinery']),
    cheapestSufficientAlternative: String(finding.fields['cheapest-sufficient-alternative'] ?? ''), stakesPrice: String(finding.fields['stakes-price'] ?? ''),
    tradeIn: String(finding.fields['trade-in'] ?? ''), candidateText: finding.fields['simplification-cut-candidate'],
    occurrenceId: finding.occurrenceId, ordinal: finding.ordinal, captureIndex, captureIdentity, stage, anchor: finding.ordinal,
    summary: finding.title || finding.evidence || finding.id,
  }));
}
export function detectTypedFindingsInCapture(capture) { return parseFindingBlocks(capture).filter((finding) => Boolean(finding.type)); }
export function detectUntypedFindingsInCapture(capture) {
  const typed = parseFindingBlocks(capture); const result = []; const lines = extractFindingsScanText(capture).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*(?:\[(?:P[0-3])\]|(?:P[0-3]))\s*[-–—:]\s*(.+)$/i.exec(lines[index]);
    if (match) result.push({ id: `UNTYPED-${index + 1}`, hasCaptureId: false, type: '', anchor: index + 1, summary: match[1] });
  }
  return result.filter((candidate) => !typed.some((finding) => finding.anchor === candidate.anchor));
}
export function mergeCaptureFindings(captures) { return { findings: captures.flatMap((capture, index) => parseFindingBlocks(capture, index)), errors: [] }; }
export function detectProtectedSignalsInCapture(capture) {
  const text = extractFindingsScanText(capture);
  return Object.entries(PROTECTED_PATTERNS).filter(([type, patterns]) => {
    const matchers = type === 'scope-violation' ? [/^\s*type:\s*scope-violation\b/im] : patterns;
    return matchers.some((pattern) => pattern.test(text));
  }).map(([type]) => type);
}
function parseCaptureName(name) {
  const match = CAPTURE_NAME_RE.exec(name ?? '');
  if (!match) return { pass: 0, stage: 'architectural', slot: null };
  return { pass: Number(match[1]), stage: match[2].toLowerCase(), slot: match[3] ?? null };
}
function namedCaptureStage(name) {
  const match = CAPTURE_NAME_RE.exec(String(name ?? ''));
  return match ? match[2].toLowerCase() : null;
}
function isLockedT2ArchitecturalOccurrence(occurrence, metadata) {
  if (occurrence.stage !== 'architectural' || !occurrence.captureIdentity) return false;
  const name = String(metadata?.[occurrence.captureIndex]?.name ?? '');
  if (!/^pass-\d+-architectural\.capture\.txt$/i.test(name) || namedCaptureStage(name) !== 'architectural') return false;
  const stages = new Set((Array.isArray(metadata) ? metadata : []).map((item) => namedCaptureStage(item?.name)).filter(Boolean));
  return stages.has('architectural-review') && !stages.has('architectural-lens');
}
function hasExactToken(text, token) { return String(text ?? '').split(/\r?\n/).some((line) => line.trim() === token); }
function protectedEvidenceMatches(type, text) { return (PROTECTED_PATTERNS[type] ?? []).some((pattern) => pattern.test(String(text ?? ''))); }

function parseM3Lines(captures, metadata, errors) {
  const result = new Map();
  captures.forEach((capture, index) => {
    const meta = metadata[index] ?? {}; const stage = parseCaptureName(meta.name).stage;
    for (const line of String(capture).split(/\r?\n/)) {
      if (!/^m3-protected:/i.test(line.trim())) continue;
      const match = M3_LINE_RE.exec(line.trim());
      if (!match) { const id = /^m3-protected:\s*id=([^|]+)/i.exec(line.trim())?.[1]?.trim() ?? '<unknown>'; errors.push(`review-economics: malformed m3-protected record for ${id}`); continue; }
      const record = { id: match[1].trim(), revision: match[2].trim(), contest: match[3].toLowerCase(), outcome: match[4].toLowerCase(), evidence: (match[5] ?? '').trim(), whyNow: (match[6] ?? '').trim(), stage, captureIndex: index, timestampMs: Number(meta.timestampMs ?? 0) };
      const list = result.get(record.id) ?? []; list.push(record); result.set(record.id, list);
    }
  });
  return result;
}

function validateRawCodexResults(rawResults, errors) {
  for (let index = 0; index < (rawResults ?? []).length; index += 1) {
    const wrapper = rawResults[index]; const stage = wrapper?.stage ?? 'architectural'; const raw = wrapper?.raw?.result ?? wrapper?.raw;
    if (!isRecord(raw)) { errors.push(`raw Codex result[${index}] is malformed`); continue; }
    const summary = String(raw.summary ?? ''); if (!hasExactToken(summary, REVIEW_ECONOMICS_MARKER)) errors.push(`raw Codex result[${index}] missing ${REVIEW_ECONOMICS_MARKER}`);
    const findings = Array.isArray(raw.findings) ? raw.findings : []; let hasCandidate = false;
    for (const finding of findings) {
      const parsed = parseFindingBlocks(String(finding?.body ?? ''))[0];
      if (!parsed || !parsed.persistentMachinery) errors.push(`raw Codex result[${index}] persistent-machinery must be yes or no`);
      else if (parsed.persistentMachinery === 'yes' && (!parsed.cheapestSufficientAlternative || !parsed.stakesPrice || !parsed.tradeIn)) errors.push(`raw Codex result[${index}] malformed persistent-machinery proposal`);
      if (parsed?.candidateText !== undefined) {
        const candidate = String(parsed.candidateText).trim().toLowerCase();
        if (candidate !== 'yes' && candidate !== 'no') errors.push(`raw Codex result[${index}] invalid simplification-cut-candidate`);
        if (candidate === 'yes') hasCandidate = true;
      }
    }
    const clean = hasExactToken(summary, M5_CLEAN_TOKEN);
    if (stage !== 'architectural-final') {
      if (hasCandidate && clean) errors.push(`raw Codex result[${index}] cannot claim SIMPLIFICATION_CLEAN with a cut candidate`);
      if (!hasCandidate && !clean) errors.push(`raw Codex result[${index}] without cut candidate must carry SIMPLIFICATION_CLEAN`);
    }
  }
}
function validatePostAdoptionCaptures(captures, metadata, adoptionTimestampMs, errors) {
  if (!Number.isFinite(adoptionTimestampMs)) return;
  captures.forEach((capture, index) => {
    const meta = metadata[index] ?? {}; const { stage } = parseCaptureName(meta.name);
    if (!REVIEWER_STAGES.has(stage) || Number(meta.timestampMs ?? 0) < adoptionTimestampMs) return;
    if (!hasExactToken(capture, REVIEW_ECONOMICS_MARKER)) errors.push(`post-adoption reviewer capture ${meta.name ?? `#${index + 1}`} missing ${REVIEW_ECONOMICS_MARKER}`);
  });
}
function latestByStableId(occurrences, metadata) {
  const map = new Map();
  for (const occurrence of occurrences) {
    const timestamp = Number(metadata[occurrence.captureIndex]?.timestampMs ?? occurrence.captureIndex); const existing = map.get(occurrence.id);
    if (!existing || timestamp >= existing.timestamp) map.set(occurrence.id, { occurrence, timestamp });
  }
  return new Map([...map.entries()].map(([id, value]) => [id, value.occurrence]));
}
function validateM2Legacy(rows, occurrences, metadata, adoptionTimestampMs, errors) {
  const latest = latestByStableId(occurrences, metadata);
  for (const row of rows) {
    const proposal = latest.get(row.id); if (!proposal) continue;
    const proposalTimestamp = Number(metadata[proposal.captureIndex]?.timestampMs ?? proposal.captureIndex);
    if (Number.isFinite(adoptionTimestampMs) && proposalTimestamp < adoptionTimestampMs) continue;
    if (!proposal.persistentMachinery) { errors.push(`review-economics: ${row.id} persistent-machinery must be yes or no`); continue; }
    if (proposal.persistentMachinery === 'yes' && (!proposal.cheapestSufficientAlternative || !proposal.stakesPrice || !proposal.tradeIn)) {
      const declined = row.proposalOutcome === 'declined' && row.proposalReason === 'malformed-proposal';
      if (!declined) errors.push(`review-economics: malformed persistent-machinery proposal for ${row.id}`); continue;
    }
    if (row.persistentMachinery && row.persistentMachinery !== proposal.persistentMachinery) errors.push(`review-economics: ledger persistent-machinery does not match latest proposal for ${row.id}`);
    if (proposal.persistentMachinery === 'yes' && row.persistentMachinery === 'yes') {
      for (const [label, actual, expected] of [['cheapest-sufficient-alternative', row.cheapestSufficientAlternative, proposal.cheapestSufficientAlternative], ['stakes-price', row.stakesPrice, proposal.stakesPrice], ['trade-in', row.tradeIn, proposal.tradeIn]]) if (actual !== expected) errors.push(`review-economics: ledger ${label} does not match latest proposal for ${row.id}`);
    }
  }
}

function sha256(text) { return createHash('sha256').update(text).digest('hex'); }
function bindGovernedCaptureBytes(captures, metadata, episodeState, errors) {
  if (!episodeState) return metadata;
  const byIdentity = new Map(episodeState.governedCaptures.map((capture) => [capture.captureIdentity, capture]));
  const byName = new Map(episodeState.governedCaptures.map((capture) => [capture.name, capture]));
  const seen = new Set(); const normalized = [];
  if (captures.length !== episodeState.governedCaptures.length) errors.push('review-economics: supplied capture text count must equal governedCaptureUnion');
  for (let index = 0; index < captures.length; index += 1) {
    const meta = metadata[index] ?? {}; const text = captures[index];
    const identity = typeof meta.captureIdentity === 'string' ? meta.captureIdentity : '';
    const governed = (identity && byIdentity.get(identity)) || byName.get(meta.name);
    if (!governed) { errors.push(`review-economics: supplied capture ${meta.name ?? `#${index + 1}`} is not governed`); normalized.push(meta); continue; }
    if (seen.has(governed.captureIdentity)) errors.push(`review-economics: governed capture ${governed.captureIdentity} supplied more than once`);
    seen.add(governed.captureIdentity);
    if (meta.name !== governed.name) errors.push(`review-economics: capture ${governed.captureIdentity} name mismatch`);
    if (Buffer.byteLength(text) !== governed.byteLength) errors.push(`review-economics: capture ${governed.captureIdentity} byteLength mismatch`);
    if (sha256(text) !== governed.sha256) errors.push(`review-economics: capture ${governed.captureIdentity} sha256 mismatch`);
    if (parseFindingBlocks(text).length !== governed.rawFindingCount) errors.push(`review-economics: capture ${governed.captureIdentity} rawFindingCount mismatch`);
    normalized.push({ ...meta, name: governed.name, captureIdentity: governed.captureIdentity });
  }
  for (const identity of byIdentity.keys()) if (!seen.has(identity)) errors.push(`review-economics: governed capture ${identity} has no supplied immutable text`);
  return normalized;
}
function buildOccurrences(captures, metadata) {
  return captures.flatMap((capture, index) => parseFindingBlocks(capture, index, metadata[index]?.captureIdentity ?? null, parseCaptureName(metadata[index]?.name).stage));
}

function validateCountsShape(counts, errors) {
  if (!isRecord(counts)) { errors.push('review-economics: receipt-backed ledger requires counts object'); return false; }
  const keys = Object.keys(counts).sort(); const expected = [...REQUIRED_COUNT_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) errors.push('review-economics: counts must contain exactly rawFindingCount, distinctFindingCount, processedDistinctCount');
  for (const field of REQUIRED_COUNT_FIELDS) if (!Number.isInteger(counts[field]) || counts[field] < 0) errors.push(`review-economics: counts.${field} must be a non-negative integer`);
  return REQUIRED_COUNT_FIELDS.every((field) => Number.isInteger(counts[field]) && counts[field] >= 0);
}
function validateOccurrenceLedger(ledger, occurrences, errors) {
  const occurrenceMap = new Map(occurrences.map((item) => [item.occurrenceId, item])); const assigned = new Map();
  for (const row of ledger.findings) {
    if (row.occurrences.length === 0) errors.push(`review-economics: receipt-backed ledger row ${row.id} has no mapped occurrence`);
    for (const id of row.occurrences) {
      if (!occurrenceMap.has(id)) errors.push(`review-economics: ledger row ${row.id} references unknown occurrence ${id}`);
      if (assigned.has(id)) errors.push(`review-economics: occurrence ${id} maps more than once`); assigned.set(id, row.id);
    }
  }
  for (const id of occurrenceMap.keys()) if (!assigned.has(id)) errors.push(`review-economics: occurrence ${id} is not mapped exactly once`);
  const rawFindingCount = occurrences.length; const distinctFindingCount = ledger.findings.length;
  const processedDistinctCount = ledger.findings.filter((row) => row.defectDisposition === 'addressed' || row.defectDisposition === 'rejected-as-false').length;
  if (validateCountsShape(ledger.counts, errors)) {
    for (const [field, value] of Object.entries({ rawFindingCount, distinctFindingCount, processedDistinctCount })) if (ledger.counts[field] !== value) errors.push(`review-economics: ledger count ${field} mismatch`);
  }
  for (const row of ledger.findings) {
    if (!DEFECT_DISPOSITIONS.has(row.defectDisposition)) errors.push(`review-economics: row ${row.id} has invalid defect disposition`);
    if (!REMEDY_DISPOSITIONS.has(row.remedyDisposition)) errors.push(`review-economics: row ${row.id} has invalid remedy disposition`);
    if (row.defectDisposition === 'unresolved') errors.push(`review-economics: row ${row.id} remains unresolved`);
    const mapped = row.occurrences.map((id) => occurrenceMap.get(id)).filter(Boolean);
    const types = new Set(mapped.filter((item) => PROTECTED_TYPES.has(item.type)).map((item) => item.type));
    if (types.size > 1) errors.push(`review-economics: distinct defect ${row.id} mixes protected occurrence identities/types`);
    for (const occurrence of mapped) {
      if (PROTECTED_TYPES.has(occurrence.type) && row.type !== occurrence.type) errors.push(`review-economics: protected occurrence ${occurrence.occurrenceId} type ${occurrence.type} cannot be reclassified as ${row.type}`);
      if (row.remedyDisposition === 'accepted') {
        if (occurrence.persistentMachinery === 'yes') {
          if (row.persistentMachinery !== 'yes') errors.push(`review-economics: accepted persistent-machinery occurrence ${occurrence.occurrenceId} must preserve persistent-machinery: yes`);
          for (const [label, actual, expected] of [['cheapest-sufficient-alternative', row.cheapestSufficientAlternative, occurrence.cheapestSufficientAlternative], ['stakes-price', row.stakesPrice, occurrence.stakesPrice], ['trade-in', row.tradeIn, occurrence.tradeIn]]) if (actual !== expected) errors.push(`review-economics: accepted occurrence ${occurrence.occurrenceId} must preserve ${label}`);
        } else if (occurrence.persistentMachinery === 'no' && row.persistentMachinery === 'yes') errors.push(`review-economics: accepted occurrence ${occurrence.occurrenceId} cannot invent persistent machinery`);
      } else if (!row.proposalReason) errors.push(`review-economics: row ${row.id} non-accepted remedy requires proposalReason`);
    }
  }
  return { occurrenceMap, counts: { rawFindingCount, distinctFindingCount, processedDistinctCount } };
}

function sortM3(records) { return [...records].sort((a, b) => a.timestampMs - b.timestampMs || a.captureIndex - b.captureIndex); }
function validateTerminalDispositionMatrix(ledger, occurrences, metadata, phase, errors) {
  if (phase !== 'final-acceptance') return;
  const terminalOccurrences = occurrences.filter((occurrence) => parseCaptureName(metadata[occurrence.captureIndex]?.name).stage === 'architectural');
  if (terminalOccurrences.length === 0) return;
  const terminalIds = new Set(terminalOccurrences.map((occurrence) => occurrence.occurrenceId));
  const occurrenceById = new Map(occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  const assigned = new Set();
  for (const row of ledger.findings) {
    const mappedTerminal = row.occurrences.filter((occurrenceId) => terminalIds.has(occurrenceId));
    if (mappedTerminal.length === 0) continue;
    for (const occurrenceId of mappedTerminal) assigned.add(occurrenceId);
    const protectedTerminal = mappedTerminal.some((occurrenceId) => PROTECTED_TYPES.has(occurrenceById.get(occurrenceId)?.type));
    if ((row.defectDisposition === 'addressed' && !protectedTerminal) || row.defectDisposition === 'unresolved') {
      errors.push(`blocked_terminal_findings: terminal defect ${row.id} has disposition ${row.defectDisposition}`);
    } else if (row.defectDisposition === 'rejected-as-false' && !row.rejectReason) {
      errors.push(`blocked_terminal_findings: rejected-as-false terminal defect ${row.id} requires defect-side reason/evidence`);
    } else if (!DEFECT_DISPOSITIONS.has(row.defectDisposition)) {
      errors.push(`blocked_terminal_findings: terminal defect ${row.id} has invalid defect disposition`);
    }
  }
  for (const occurrence of terminalOccurrences) {
    if (!assigned.has(occurrence.occurrenceId)) {
      errors.push(`blocked_terminal_findings: terminal occurrence ${occurrence.occurrenceId} is unassigned`);
    }
  }
  if (ledger.findings.some((row) => row.defectDisposition === 'unresolved')) {
    errors.push('blocked_terminal_findings: a governed defect remains unresolved');
  }
}

function contestRemainsOpen(records) {
  let open = false;
  for (const record of sortM3(records)) {
    if (record.contest === 'contested') open = true;
    if (record.contest === 'contest-withdrawn' || record.outcome === 'activate' || record.outcome === 'non-activate') open = false;
  }
  return open;
}
function resolveOccurrenceM3History(occurrenceId, records, issueRevision, errors) {
  const current = sortM3(records.filter((record) => record.revision === issueRevision));
  const byCapture = new Map();
  for (const record of current) { const list = byCapture.get(record.captureIndex) ?? []; list.push(record); byCapture.set(record.captureIndex, list); }
  if ([...byCapture.values()].some((items) => items.length > 1)) { errors.push(`review-economics: duplicate m3-protected records for ${occurrenceId}`); return { current, latest: null, invalid: true }; }
  const terminal = current.filter((record) => record.stage === 'architectural');
  if (terminal.length > 1) { errors.push(`review-economics: duplicate-conflicting terminal m3-protected state for ${occurrenceId}`); return { current, latest: null, invalid: true }; }
  if (terminal.length === 1) {
    const terminalRecord = terminal[0];
    if (current.some((record) => record.stage !== 'architectural' && (record.timestampMs > terminalRecord.timestampMs || (record.timestampMs === terminalRecord.timestampMs && record.captureIndex > terminalRecord.captureIndex)))) {
      errors.push(`review-economics: terminal m3-protected authority for ${occurrenceId} is not the latest current-revision record`); return { current, latest: null, invalid: true };
    }
  }
  return { current, latest: current.at(-1) ?? null, invalid: false };
}
function protectedSharingCaptureId(occurrence, ledger, occurrenceMap) {
  return ledger.findings.flatMap((candidate) => candidate.occurrences.map((id) => occurrenceMap.get(id)).filter((item) => item && PROTECTED_TYPES.has(item.type) && item.id === occurrence.id));
}
function protectedOccurrencesShareCapture(left, right) {
  if (left.captureIdentity && right.captureIdentity) return left.captureIdentity === right.captureIdentity;
  return left.captureIndex === right.captureIndex;
}
function captureIdIsAmbiguous(occurrence, ledger, occurrenceMap) {
  const sharing = protectedSharingCaptureId(occurrence, ledger, occurrenceMap);
  return sharing.filter((item) => protectedOccurrencesShareCapture(item, occurrence)).length > 1;
}
function validateProtectedOccurrenceState({ row, occurrence, state, m3Records, phase, issueRevision, errors, ledger, occurrenceMap, metadata }) {
  if (captureIdIsAmbiguous(occurrence, ledger, occurrenceMap)) {
    errors.push(`review-economics: protected finding ${occurrence.occurrenceId} has ambiguous capture finding id ${occurrence.id}`);
    return;
  }
  const history = resolveOccurrenceM3History(occurrence.occurrenceId, m3Records.get(occurrence.id) ?? m3Records.get(occurrence.occurrenceId) ?? [], issueRevision, errors);
  if (history.invalid) return;
  const current = history.current; const record = history.latest; const activation = state.protectedActivation;
  const activationValid = Boolean(activation?.authority && activation?.signal && activation?.whyNow && protectedEvidenceMatches(occurrence.type, activation.signal));
  const zeroSignal = !protectedEvidenceMatches(occurrence.type, occurrence.evidence); const terminalOnly = occurrence.stage === 'architectural';
  if (state.architectRequired && !record) { errors.push(`review-economics: protected finding ${occurrence.occurrenceId} requires current architect adjudication`); return; }
  if (phase === 'pre-lens') {
    if (!zeroSignal && activationValid) { if (row.defectDisposition !== 'addressed') errors.push(`review-economics: activated protected finding ${occurrence.occurrenceId} must be addressed`); return; }
    if (!state.architectPending && !record) errors.push(`review-economics: protected finding ${occurrence.occurrenceId} requires architect-pending before lens progression`);
    return;
  }
  if (state.architectPending) { errors.push(`review-economics: protected finding ${occurrence.occurrenceId} must clear architect-pending before final acceptance`); return; }
  if (contestRemainsOpen(current)) { errors.push(`review-economics: protected finding ${occurrence.occurrenceId} remains under current contest`); return; }
  if (record) {
    if (record.outcome === 'activate') {
      if (!record.evidence || !record.whyNow || !protectedEvidenceMatches(occurrence.type, record.evidence)) errors.push(`review-economics: architect activation for ${occurrence.occurrenceId} lacks current real protected evidence + why-now provenance`);
      else if (row.defectDisposition !== 'addressed') errors.push(`review-economics: activated protected finding ${occurrence.occurrenceId} must be addressed`);
      return;
    }
    if (record.outcome === 'non-activate') return;
    if ((record.contest === 'none' || record.contest === 'contest-withdrawn') && !zeroSignal && activationValid) { if (row.defectDisposition !== 'addressed') errors.push(`review-economics: activated protected finding ${occurrence.occurrenceId} must be addressed`); return; }
  }
  const lockedT2Architectural = isLockedT2ArchitecturalOccurrence(occurrence, metadata);
  if (!record && lockedT2Architectural && row.defectDisposition === 'rejected-as-false' && !activationValid) {
    return;
  }
  if (terminalOnly && activationValid) { if (row.defectDisposition !== 'addressed') errors.push(`review-economics: activated protected finding ${occurrence.occurrenceId} must be addressed`); return; }
  const lockedArchitecturalReview = occurrence.stage === 'architectural-review' && Boolean(occurrence.captureIdentity);
  if (!record && lockedArchitecturalReview && (row.defectDisposition === 'rejected-as-false' || activationValid)) {
    if (activationValid && row.defectDisposition !== 'addressed') errors.push(`review-economics: activated protected finding ${occurrence.occurrenceId} must be addressed`);
    return;
  }
  errors.push(`review-economics: protected finding ${occurrence.occurrenceId} has unknown/stale architect contest state`);
}
function validateOccurrenceM3(ledger, occurrenceMap, captures, metadata, phase, issueRevision, errors) {
  const m3Records = parseM3Lines(captures, metadata, errors);
  for (const row of ledger.findings) {
    const protectedOccurrences = row.occurrences.map((id) => occurrenceMap.get(id)).filter((item) => item && PROTECTED_TYPES.has(item.type));
    if (protectedOccurrences.length === 0) continue;
    const explicit = new Map();
    for (const state of row.protectedOccurrences) { if (explicit.has(state.occurrenceId)) errors.push(`review-economics: duplicate protected occurrence state ${state.occurrenceId}`); explicit.set(state.occurrenceId, state); }
    for (const occurrence of protectedOccurrences) {
      let state = explicit.get(occurrence.occurrenceId);
      if (!state && protectedOccurrences.length === 1) state = { occurrenceId: occurrence.occurrenceId, architectPending: row.architectPending, architectRequired: row.architectRequired, protectedActivation: row.protectedActivation };
      if (!state) { errors.push(`review-economics: grouped protected distinct defect ${row.id} requires explicit occurrence-level M3 state for ${occurrence.occurrenceId}`); continue; }
      validateProtectedOccurrenceState({ row, occurrence, state, m3Records, phase, issueRevision, errors, ledger, occurrenceMap, metadata });
    }
  }
}

function validateLegacyM3(rows, occurrences, captures, metadata, phase, issueRevision, errors) {
  const m3Records = parseM3Lines(captures, metadata, errors);
  for (const row of rows) {
    if (!PROTECTED_TYPES.has(row.type)) continue;
    const occurrence = [...occurrences].reverse().find((item) => item.id === row.id && item.type === row.type); if (!occurrence) continue;
    const records = m3Records.get(row.id) ?? []; const current = sortM3(records.filter((record) => record.revision === issueRevision));
    const recordsByCapture = new Map(); for (const record of current) recordsByCapture.set(record.captureIndex, (recordsByCapture.get(record.captureIndex) ?? 0) + 1);
    if ([...recordsByCapture.values()].some((count) => count > 1)) errors.push(`review-economics: duplicate m3-protected records for ${row.id}`);
    const terminalRecords = current.filter((record) => record.stage === 'architectural');
    if (terminalRecords.length > 1) {
      const captureIndices = new Set(terminalRecords.map((record) => record.captureIndex)); const states = new Set(terminalRecords.map((record) => `${record.contest}|${record.outcome}`));
      errors.push(captureIndices.size > 1 && states.size > 1 ? `review-economics: duplicate-conflicting terminal m3-protected state for ${row.id}` : `review-economics: duplicate m3-protected records for ${row.id}`);
    }
    if (terminalRecords.length > 0 && current.some((record) => record.stage !== 'architectural')) {
      const terminal = terminalRecords.at(-1); const nonTerminal = current.filter((record) => record.stage !== 'architectural').at(-1);
      if (terminal && nonTerminal && (terminal.outcome !== nonTerminal.outcome || terminal.contest !== nonTerminal.contest) && terminal.captureIndex <= nonTerminal.captureIndex) errors.push(`review-economics: duplicate-conflicting terminal m3-protected state for ${row.id}`);
    }
    const latest = current.at(-1) ?? null; const activation = row.protectedActivation;
    const activationValid = Boolean(activation?.authority && activation?.signal && activation?.whyNow && protectedEvidenceMatches(row.type, activation.signal));
    const zeroSignal = !protectedEvidenceMatches(row.type, occurrence.evidence); const terminalOnly = occurrence.stage === 'architectural';
    if (row.architectRequired && !latest) { errors.push(`review-economics: protected finding ${row.id} requires current architect adjudication`); continue; }
    if (phase === 'pre-lens') { if (!row.architectPending) errors.push(`review-economics: protected finding ${row.id} requires architect-pending before lens progression`); continue; }
    if (row.architectPending) { errors.push(`review-economics: protected finding ${row.id} must clear architect-pending before final acceptance`); continue; }
    if (contestRemainsOpen(current)) { errors.push(`review-economics: protected finding ${row.id} remains under current contest`); continue; }
    const terminalRecordsAnyRevision = records.filter((record) => record.stage === 'architectural' && record.captureIndex >= occurrence.captureIndex);
    if (terminalOnly && terminalRecordsAnyRevision.length > 0 && !terminalRecords.some((record) => record.captureIndex >= occurrence.captureIndex)) { errors.push(`review-economics: protected finding ${row.id} has unknown/stale architect contest state`); continue; }
    if (latest) {
      if (latest.contest === 'contested') { errors.push(`review-economics: protected finding ${row.id} remains under current contest`); continue; }
      if (latest.outcome === 'activate') {
        if (!latest.evidence || !latest.whyNow || !protectedEvidenceMatches(row.type, latest.evidence)) errors.push(`review-economics: architect activation for ${row.id} lacks current real protected evidence + why-now provenance`);
        else if (row.defectDisposition !== 'addressed') errors.push(`review-economics: activated protected finding ${row.id} must be addressed`); continue;
      }
      if (latest.outcome === 'non-activate') continue;
      if ((latest.contest === 'none' || latest.contest === 'contest-withdrawn') && !zeroSignal && activationValid) { if (row.defectDisposition !== 'addressed') errors.push(`review-economics: activated protected finding ${row.id} must be addressed`); continue; }
    }
    if (terminalOnly && activationValid) { if (row.defectDisposition !== 'addressed') errors.push(`review-economics: activated protected finding ${row.id} must be addressed`); continue; }
    errors.push(`review-economics: protected finding ${row.id} has unknown/stale architect contest state`);
  }
}
function validateGlobalProtectedFloor(captures, rows, errors) {
  const signaled = new Set(captures.flatMap((capture) => detectProtectedSignalsInCapture(capture)));
  for (const type of signaled) if (!rows.some((row) => row.type === type)) errors.push(`protected signal type: ${type} present in capture but not addressed in the ledger`);
}
function validateM5(captures, metadata, rows, adoptionTimestampMs, phase, errors) {
  const postAdoptionReviewers = captures.map((text, index) => ({ text, index, meta: metadata[index] ?? {}, parsed: parseCaptureName(metadata[index]?.name) })).filter((item) => REVIEWER_STAGES.has(item.parsed.stage) && (!Number.isFinite(adoptionTimestampMs) || Number(item.meta.timestampMs ?? 0) >= adoptionTimestampMs));
  for (const item of postAdoptionReviewers) {
    const blocks = parseFindingBlocks(item.text); const candidates = blocks.filter((block) => block.candidateText !== undefined);
    for (const block of candidates) { const value = String(block.candidateText).trim().toLowerCase(); if (value !== 'yes' && value !== 'no') errors.push(`review-economics: invalid simplification-cut-candidate for ${block.id}`); }
    const hasCandidate = candidates.some((block) => String(block.candidateText).trim().toLowerCase() === 'yes'); const clean = hasExactToken(item.text, M5_CLEAN_TOKEN);
    if (hasCandidate && clean) errors.push(`review-economics: capture ${item.meta.name} cannot claim SIMPLIFICATION_CLEAN with a cut candidate`);
    if (!hasCandidate && !clean) errors.push(`review-economics: capture ${item.meta.name} without cut candidate must carry SIMPLIFICATION_CLEAN`);
  }
  const latestCandidateById = latestByStableId(postAdoptionReviewers.flatMap((item) => parseFindingBlocks(item.text, item.index)), metadata);
  for (const row of rows) { const raw = latestCandidateById.get(row.id); if (!raw) continue; const rawCandidate = String(raw.candidateText ?? 'no').trim().toLowerCase() === 'yes'; if (rawCandidate !== row.simplificationCutCandidate) errors.push(`review-economics: simplification-cut-candidate raw/ledger mismatch for ${row.id}`); }
  if (phase === 'final-acceptance') {
    const architectural = postAdoptionReviewers.filter((item) => item.parsed.stage === 'architectural');
    if (architectural.length === 0) { errors.push('review-economics: pre-adoption M5 anchor cannot satisfy final acceptance'); return; }
    const latestArchitectural = architectural.sort((a, b) => Number(a.meta.timestampMs ?? 0) - Number(b.meta.timestampMs ?? 0)).at(-1);
    const latestLens = captures.map((text, index) => ({ text, meta: metadata[index] ?? {}, parsed: parseCaptureName(metadata[index]?.name) })).filter((item) => item.parsed.stage === 'architectural-lens').sort((a, b) => Number(a.meta.timestampMs ?? 0) - Number(b.meta.timestampMs ?? 0)).at(-1);
    if (latestLens && Number(latestLens.meta.timestampMs ?? 0) > Number(latestArchitectural.meta.timestampMs ?? 0)) errors.push('review-economics: cannot resolve a terminal architectural M5 anchor after the latest lens');
  }
}
function legacyCheck(captures, ledger, errors) {
  const occurrences = captures.flatMap((capture, index) => parseFindingBlocks(capture, index)); const byId = new Map(ledger.findings.map((row) => [row.id, row]));
  for (const occurrence of occurrences) { const row = byId.get(occurrence.id); if (!row) errors.push(`finding-ledger guard: finding ${occurrence.id} missing from ledger`); else if (PROTECTED_TYPES.has(occurrence.type) && row.disposition === 'rejected') errors.push(`finding-ledger guard: protected finding ${occurrence.id} cannot be disposed rejected`); }
  return occurrences;
}

/** @param {unknown} captureOrCaptures @param {string} ledgerText @param {{ phase?: 'pre-lens'|'post-lens'|'final-acceptance', [key: string]: unknown }} options */
export function checkFindingLedgerGuard(captureOrCaptures, ledgerText, options = {}) {
  const remoteInputs = options.remoteAuthorities ?? (options.remoteAuthority ? [options.remoteAuthority] : []);
  if (options.requireRemoteAuthority === true) {
    if (remoteInputs.length === 0) {
      return { ok: false, errors: ['finding-ledger: remote authority is required for receipt-backed production validation'], ledger: { version: 1, draft: null, counts: null, findings: [] }, captureFindings: [], protectedSignals: [] };
    }
  }
  if (remoteInputs.length > 0) {
    const authority = checkRemoteAuthorities(remoteInputs);
    if (!authority.ok) return { ok: false, errors: authority.errors.map((error) => 'finding-ledger: remote authority ' + error), ledger: { version: 1, draft: null, counts: null, findings: [] }, captureFindings: [], protectedSignals: [] };
  }
  const captures = Array.isArray(captureOrCaptures) ? captureOrCaptures.map(String) : [String(captureOrCaptures ?? '')];
  let metadata = Array.isArray(options.captureMetadata) ? options.captureMetadata : captures.map((_, index) => ({ name: `pass-${String(index + 1).padStart(2, '0')}-architectural.capture.txt`, timestampMs: index + 1 }));
  const errors = []; let ledger;
  try { ledger = parseLedger(ledgerText); }
  catch (error) { return { ok: false, errors: [error instanceof Error ? error.message : String(error)], ledger: { version: 1, draft: null, counts: null, findings: [] }, captureFindings: [], protectedSignals: [] }; }
  const reviewEconomics = options.reviewEconomics === true || options.adoptionTimestampMs !== undefined || options.stageReceipts !== undefined || ledger.version >= 2;
  if (!reviewEconomics) {
    const captureFindings = legacyCheck(captures, ledger, errors); validateGlobalProtectedFloor(captures, ledger.findings, errors);
    return { ok: errors.length === 0, errors, ledger, captureFindings, protectedSignals: captures.flatMap((capture) => detectProtectedSignalsInCapture(capture)) };
  }
  if (options.stageTerminalConfirmed === false) errors.push('review-economics: existing stage authority was not confirmed terminal');
  validateRawCodexResults(options.rawCodexResults, errors); validatePostAdoptionCaptures(captures, metadata, Number(options.adoptionTimestampMs), errors);
  let episodeState;
  if (options.stageReceipts !== undefined) {
    episodeState = deriveReviewEpisodeState(options.stageReceipts, options.verifiedRelayEvidence ?? [], options.episodeAuthority);
    errors.push(...episodeState.errors); errors.push(...validateReviewEpisodeTopology(episodeState, /** @type {'pre-lens'|'post-lens'|'final-acceptance'} */ (options.phase ?? 'final-acceptance')));
    metadata = bindGovernedCaptureBytes(captures, metadata, episodeState, errors);
  } else if (options.enforceT3PreLensTopology === true) errors.push('review-economics: fresh T3 requires explicit stage-completeness-receipt/v1 authority');
  const occurrences = buildOccurrences(captures, metadata); validateGlobalProtectedFloor(captures, ledger.findings, errors); let economicsCounts;
  if (ledger.version >= 2 || options.stageReceipts !== undefined) {
    const occurrenceValidation = validateOccurrenceLedger(ledger, occurrences, errors); economicsCounts = occurrenceValidation.counts;
    validateTerminalDispositionMatrix(ledger, occurrences, metadata, options.phase ?? 'final-acceptance', errors);
    validateOccurrenceM3(ledger, occurrenceValidation.occurrenceMap, captures, metadata, options.phase ?? 'final-acceptance', options.issueRevision ?? '', errors);
  } else {
    validateM2Legacy(ledger.findings, occurrences, metadata, Number(options.adoptionTimestampMs), errors);
    validateLegacyM3(ledger.findings, occurrences, captures, metadata, options.phase ?? 'final-acceptance', options.issueRevision ?? '', errors);
  }
  validateM5(captures, metadata, ledger.findings, Number(options.adoptionTimestampMs), options.phase ?? 'final-acceptance', errors);
  const architecturalReviewIndices = metadata.map((meta, index) => ({ meta, index, parsed: parseCaptureName(meta.name) })).filter((item) => item.parsed.stage === 'architectural-review').map((item) => item.index);
  const candidateOccurrences = occurrences.filter((item) => architecturalReviewIndices.includes(item.captureIndex) && String(item.candidateText ?? '').trim().toLowerCase() === 'yes').map((item) => item.occurrenceId);
  const simplificationAggregate = architecturalReviewIndices.length > 0 ? {
    simplificationClean: architecturalReviewIndices.every((index) => hasExactToken(captures[index], M5_CLEAN_TOKEN)) && candidateOccurrences.length === 0,
    noFindings: architecturalReviewIndices.every((index) => hasExactToken(captures[index], NO_FINDINGS_TOKEN)), candidateOccurrences,
  } : null;
  return { ok: errors.length === 0, errors: [...new Set(errors)], ledger, captureFindings: occurrences, protectedSignals: captures.flatMap((capture) => detectProtectedSignalsInCapture(capture)), ...(episodeState ? { episodeState } : {}), ...(economicsCounts ? { economicsCounts } : {}), simplificationAggregate };
}

function readArg(argv, ...names) { for (const name of names) { const index = argv.indexOf(name); if (index >= 0) return argv[index + 1]; } return undefined; }
function repeatedArgs(argv, name) { const values = []; for (let index = 0; index < argv.length; index += 1) if (argv[index] === name && argv[index + 1]) values.push(argv[index + 1]); return values; }
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function parseAdoptionTimestamp(value) { if (!value) return undefined; if (/^\d+$/.test(value)) return Number(value); const parsed = Date.parse(value); if (!Number.isFinite(parsed)) throw new Error('--adoption-timestamp must be epoch milliseconds or ISO-8601'); return parsed; }
function canonicalReceiptInputs(args) {
  const explicit = repeatedArgs(args, '--stage-receipt').map((path) => resolve(path));
  const intakePath = readArg(args, '--tier-intake');
  if (!intakePath) throw new Error('--tier-intake is required');
  const intake = readJson(intakePath);
  const canonical = resolveCanonicalReviewDirectory(intake);
  const legacyReceiptPath = findLegacyReceiptPaths(intake)[0];
  if (legacyReceiptPath) {
    throw new Error(`legacy_receipt_location_blocked: receipt found outside canonical authority at ${legacyReceiptPath}`);
  }
  if (resolve(intakePath) !== canonical.intakePath) {
    throw new Error(`legacy_receipt_location_blocked: tier intake authority must be ${canonical.intakePath}`);
  }
  const requestedDirectory = readArg(args, '--receipt-directory')
    ? resolve(readArg(args, '--receipt-directory'))
    : explicit[0]
      ? dirname(explicit[0])
      : canonical.directory;
  if (requestedDirectory !== canonical.directory) {
    throw new Error(`legacy_receipt_location_blocked: receipt authority must be ${canonical.directory}`);
  }
  const directory = canonical.directory;
  if (!existsSync(directory)) throw new Error(`canonical receipt directory does not exist: ${directory}`);
  const receipts = [];
  for (const name of readdirSync(directory).filter((item) => item.endsWith('.json')).sort()) {
    const path = resolve(directory, name); let parsed;
    try { parsed = readJson(path); } catch (error) { if (explicit.includes(path) || /stage-completeness-receipt/i.test(name)) throw error; else continue; }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) if (isRecord(item) && item.schema === STAGE_COMPLETENESS_RECEIPT_SCHEMA) receipts.push(item);
  }
  for (const path of explicit) if (dirname(path) !== directory) throw new Error(`stage receipt outside canonical directory: ${path}`);
  receipts.sort((a, b) => a.stageSequence - b.stageSequence || String(a.stageReceiptId).localeCompare(String(b.stageReceiptId)));
  if (receipts.length === 0) throw new Error(`no ${STAGE_COMPLETENESS_RECEIPT_SCHEMA} found`);
  const evidence = repeatedArgs(args, '--claude-producer-evidence').flatMap((path) => { const value = readJson(path); return Array.isArray(value) ? value : [value]; });
  return { receipts, authority: { tierIntake: intake, receiptInventory: { source: 'canonical-review-directory', taskIdentity: intake.taskIdentity, episodeFirstRevision: intake.firstRevision, reviewEpisodeId: `${intake.taskIdentity}@${intake.firstRevision}`, stageReceiptIds: receipts.map((receipt) => receipt.stageReceiptId) }, claudeProducerEvidence: evidence } };
}
function loadRelayEvidence(path) { if (!path) return []; const value = readJson(path); if (Array.isArray(value)) return value; if (isRecord(value) && Array.isArray(value.evidence)) return value.evidence; throw new Error('--verified-relay-evidence must contain an array or {evidence:[...]}'); }
function loadRemoteAuthorities(args) {
  const paths = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--remote-authority') continue;
    const path = args[index + 1];
    if (typeof path !== 'string' || path.length === 0 || path.startsWith('--')) {
      throw new Error('--remote-authority requires a path');
    }
    paths.push(path);
  }
  return paths.flatMap((path) => {
    const value = readJson(path);
    if (Array.isArray(value)) {
      if (value.length === 0) throw new Error('--remote-authority must contain at least one authority object');
      return value;
    }
    if (isRecord(value)) return [value];
    throw new Error('--remote-authority must contain an object or non-empty array');
  });
}
function loadCaptures(args) {
  const explicit = repeatedArgs(args, '--capture-file'); const directory = readArg(args, '--captures-dir');
  const files = explicit.length > 0 ? explicit : directory ? readdirSync(directory).filter((name) => name.endsWith('.capture.txt')).sort().map((name) => join(directory, name)) : [];
  return { files, texts: files.map((file) => readFileSync(file, 'utf8')), metadata: files.map((file) => ({ name: file.split(/[\\/]/).at(-1), timestampMs: statSync(file).mtimeMs })) };
}

export function runCli(argv) {
  const args = argv.slice(2);
  if (args.includes('--raw-codex-only')) {
    const stage = readArg(args, '--raw-codex-stage') ?? 'architectural'; const file = readArg(args, '--raw-codex-file'); if (!file) return 1; const errors = [];
    try { validateRawCodexResults([{ stage, raw: readJson(file) }], errors); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    if (errors.length > 0) { for (const error of errors) console.error(error); return 1; } return 0;
  }
  try {
    const ledgerFile = readArg(args, '--ledger', '--ledger-file'); const loaded = loadCaptures(args); if (!ledgerFile || loaded.files.length === 0) return 1;
    const receiptBacked = Boolean(readArg(args, '--receipt-directory') || repeatedArgs(args, '--stage-receipt').length);
    const reviewEconomicsRequested = args.includes('--review-economics');
    if (reviewEconomicsRequested && !receiptBacked) {
      console.error('finding-ledger: canonical receipt authority is required for --review-economics');
      return 1;
    }
    const receiptInputs = receiptBacked ? canonicalReceiptInputs(args) : null;
    const result = checkFindingLedgerGuard(loaded.texts, readFileSync(ledgerFile, 'utf8'), {
      reviewEconomics: receiptBacked || reviewEconomicsRequested,
      phase: readArg(args, '--phase') ?? 'final-acceptance',
      adoptionTimestampMs: parseAdoptionTimestamp(readArg(args, '--adoption-timestamp')),
      issueRevision: readArg(args, '--issue-revision') ?? '',
      stageTerminalConfirmed: args.includes('--stage-terminal') ? true : undefined,
      captureMetadata: loaded.metadata,
      stageReceipts: receiptInputs?.receipts,
      episodeAuthority: receiptInputs?.authority,
      verifiedRelayEvidence: receiptInputs ? loadRelayEvidence(readArg(args, '--verified-relay-evidence')) : undefined,
      remoteAuthorities: loadRemoteAuthorities(args),
    });
    if (!result.ok) { for (const error of result.errors) console.error(error); return 1; }
    console.log('finding-ledger guard: PASS'); return 0;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
}
if (process.argv[1] && /finding-ledger-guard\.mjs$/.test(process.argv[1])) process.exitCode = runCli(process.argv);
