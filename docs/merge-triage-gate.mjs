#!/usr/bin/env node
/**
 * At-cap merge triage gate (Issue #648).
 * Vitest: scripts/merge-triage.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdinJson, printJson } from './review-mechanical-cli.mjs';

export const TRIAGE_SCHEMA_VERSION = 1;
export const TERMINAL_AT_CAP_OPEN_FINDINGS = 'at_cap_open_findings';
export const TERMINAL_CLEAN_EARLY_STOP = 'clean_early_stop';
export const TERMINAL_MERGE_TRIAGE_CLEARED = 'merge_triage_cleared';
export const VERDICT_BLOCK = 'BLOCK';
export const VERDICT_DEFER = 'DEFER';
export const VERDICT_PENDING_ARCHITECT = 'PENDING_ARCHITECT';
export const VERDICT_PENDING_OPERATOR = 'PENDING_OPERATOR';
export const DEFAULT_MARKER_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'merge-triage-markers.v1.json');

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function normalizeTriageText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function buildFindingText(finding) {
  return `${finding?.title ?? ''}\n${finding?.body ?? finding?.details ?? ''}`;
}

function normalizeMarker(marker) {
  return normalizeTriageText(String(marker).replaceAll('…', '...'));
}

function markerMatches(normalizedText, marker) {
  const normalizedMarker = normalizeMarker(marker);
  if (!normalizedMarker) return false;
  if (!normalizedMarker.includes('...')) return normalizedText.includes(normalizedMarker);
  const parts = normalizedMarker.split('...').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  let offset = 0;
  for (const part of parts) {
    const found = normalizedText.indexOf(part, offset);
    if (found < 0) return false;
    offset = found + part.length;
  }
  return true;
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function loadMarkerList(markerFile = DEFAULT_MARKER_FILE) {
  if (!markerFile || !existsSync(markerFile)) {
    throw new Error(`merge triage marker file missing: ${markerFile || '<empty>'}`);
  }
  const raw = readFileSync(markerFile, 'utf8');
  const parsed = JSON.parse(raw);
  if (Number(parsed.schema_version) !== 1 || !Array.isArray(parsed.block_markers) || !Array.isArray(parsed.defer_markers)) {
    throw new Error('merge triage marker file malformed');
  }
  if (parsed.block_markers.length === 0 || parsed.defer_markers.length === 0) {
    throw new Error('merge triage marker file has empty marker list');
  }
  return {
    schemaVersion: Number(parsed.schema_version),
    blockMarkers: parsed.block_markers.map(String),
    deferMarkers: parsed.defer_markers.map(String),
    conditionalQualifierStems: toArray(parsed.conditional_qualifier_stems).map(String),
    unconditionalBlockMarkers: toArray(parsed.unconditional_block_markers).map(String),
    denylistPathMarkers: toArray(parsed.denylist_path_markers).map(String),
    markerListHash: sha256(raw),
    markerFile,
  };
}

function hasConditionalQualifier(normalizedText, markers) {
  return markers.some((marker) => {
    const stem = String(marker ?? '').replaceAll('…', '...').toLowerCase().replace(/\s+/g, ' ');
    if (stem.endsWith(' ')) {
      return normalizedText.includes(stem);
    }
    return normalizedText.includes(stem.trim());
  });
}

function hasCrashMoveBetweenQualifier(normalizedText) {
  return normalizedText.includes('between') && /(crash|move|moved|head|cut|switch|advance)/i.test(normalizedText);
}

function isScopeViolation(finding, normalizedText) {
  const category = normalizeTriageText(finding?.category ?? '');
  const type = normalizeTriageText(finding?.type ?? '');
  return category === 'scope-violation' || type === 'scope-violation' || normalizedText.includes('[scope-violation]');
}

function denylistMarkerMatchesText(normalizedText, marker) {
  const normalizedMarker = normalizeMarker(marker);
  if (!normalizedMarker) return false;
  if (normalizedMarker.endsWith('/**')) {
    const prefix = normalizedMarker.slice(0, -3);
    return normalizedText.includes(`${prefix}/`);
  }
  return normalizedText.includes(normalizedMarker);
}

function hasDenylistPath(normalizedText, markerList) {
  return markerList.denylistPathMarkers.some((marker) => denylistMarkerMatchesText(normalizedText, marker));
}

export function classifyFinding(finding, markerList = loadMarkerList()) {
  const normalizedText = normalizeTriageText(buildFindingText(finding));
  const findingId = String(finding?.id ?? '');
  const fingerprint = String(finding?.fingerprint ?? findingId);
  if (!normalizedText) {
    return {
      findingId,
      fingerprint,
      verdict: VERDICT_PENDING_ARCHITECT,
      reason: 'empty_finding_text',
      normalizedText,
      normalizedTextHash: sha256(normalizedText),
      matchedBlockMarkers: [],
      matchedDeferMarkers: [],
      matchedMarkers: [],
      conditionalVeto: false,
    };
  }

  const scopeViolation = isScopeViolation(finding, normalizedText);
  const denylistPath = hasDenylistPath(normalizedText, markerList);
  let matchedBlockMarkers = markerList.blockMarkers.filter((marker) => markerMatches(normalizedText, marker));
  let matchedDeferMarkers = markerList.deferMarkers.filter((marker) => markerMatches(normalizedText, marker));
  if (scopeViolation && !matchedDeferMarkers.some((marker) => marker === '[scope-violation]')) {
    matchedDeferMarkers.push('[scope-violation]');
  }
  if (scopeViolation && denylistPath && !matchedBlockMarkers.includes('scope-violation denylist/protected-path')) {
    matchedBlockMarkers.push('scope-violation denylist/protected-path');
  }

  const unconditionalBlock = markerList.unconditionalBlockMarkers.some((marker) => markerMatches(normalizedText, marker));
  const conditionalVeto =
    matchedBlockMarkers.length > 0 &&
    !unconditionalBlock &&
    (hasConditionalQualifier(normalizedText, markerList.conditionalQualifierStems) || hasCrashMoveBetweenQualifier(normalizedText));

  if (scopeViolation && denylistPath) {
    return {
      findingId,
      fingerprint,
      verdict: VERDICT_BLOCK,
      reason: 'scope_violation_denylist',
      normalizedText,
      normalizedTextHash: sha256(normalizedText),
      matchedBlockMarkers,
      matchedDeferMarkers,
      matchedMarkers: [...matchedBlockMarkers, ...matchedDeferMarkers],
      conditionalVeto: false,
    };
  }

  let verdict = VERDICT_PENDING_ARCHITECT;
  let reason = 'ambiguous_no_marker';
  if (matchedBlockMarkers.length > 0 && matchedDeferMarkers.length > 0 && !conditionalVeto) {
    verdict = VERDICT_PENDING_ARCHITECT;
    reason = 'ambiguous_both_marker_lists';
  } else if (conditionalVeto) {
    verdict = VERDICT_DEFER;
    reason = 'conditional_qualifier_veto';
  } else if (matchedBlockMarkers.length > 0) {
    verdict = VERDICT_BLOCK;
    reason = 'block_marker';
  } else if (matchedDeferMarkers.length > 0) {
    verdict = VERDICT_DEFER;
    reason = 'defer_marker';
  }

  const matchedMarkers = [...matchedBlockMarkers, ...matchedDeferMarkers];
  return {
    findingId,
    fingerprint,
    verdict,
    reason,
    normalizedText,
    normalizedTextHash: sha256(normalizedText),
    matchedBlockMarkers,
    matchedDeferMarkers,
    matchedMarkers,
    conditionalVeto,
  };
}

export function resolveStateRoot(input = {}) {
  return path.resolve(String(input.stateRoot ?? process.env.ORCHESTRATOR_PACK_STATE_ROOT ?? path.join(process.env.HOME ?? '.', '.local/state/orchestrator-pack')));
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function statePaths(stateRoot) {
  return {
    root: stateRoot,
    catalog: path.join(stateRoot, 'deferred-findings', 'catalog.jsonl'),
    journal: path.join(stateRoot, 'merge-triage', 'verdict-journal.jsonl'),
    inbox: path.join(stateRoot, 'merge-triage', 'architect-inbox.jsonl'),
    tokens: path.join(stateRoot, 'merge-triage', 'architect-tokens.json'),
    clearanceDir: path.join(stateRoot, 'merge-triage', 'clearance'),
    delivery: path.join(stateRoot, 'merge-triage', 'block-continuation-delivery.jsonl'),
  };
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  writeFileSync(filePath, `${JSON.stringify(row)}\n`, { flag: 'a', mode: 0o600 });
}

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function writeJsonFile(filePath, value) {
  ensureDir(path.dirname(filePath));
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function findAtCapRecord(input = {}) {
  const records = [...toArray(input.terminals), ...toArray(input.terminalRecords)];
  if (input.atCapRecord) records.push(input.atCapRecord);
  const prNumber = Number(input.prNumber);
  return records.find((record) => Number(record?.pr_number ?? record?.prNumber) === prNumber && record?.terminal === TERMINAL_AT_CAP_OPEN_FINDINGS) ?? null;
}

function findCleanEarlyStop(input = {}) {
  const records = [...toArray(input.terminals), ...toArray(input.terminalRecords)];
  if (input.cleanEarlyStopRecord) records.push(input.cleanEarlyStopRecord);
  const prNumber = Number(input.prNumber);
  const headSha = normalizeTriageText(input.headSha ?? input.currentHeadSha ?? '');
  return records.find((record) => {
    const recordPr = Number(record?.pr_number ?? record?.prNumber);
    const recordHead = normalizeTriageText(record?.head_sha ?? record?.headSha ?? record?.terminalHeadSha ?? '');
    return recordPr === prNumber && record?.terminal === TERMINAL_CLEAN_EARLY_STOP && recordHead === headSha;
  }) ?? null;
}

function currentHeadOpenFindings(input = {}) {
  if (input.findingStoreError || input.readerError) throw new Error('finding reader failed');
  const headSha = normalizeTriageText(input.headSha ?? input.currentHeadSha ?? '');
  const findings = toArray(input.openFindings ?? input.findings).filter((finding) => {
    const status = normalizeTriageText(finding?.status ?? 'open');
    const findingHead = normalizeTriageText(finding?.head_sha ?? finding?.headSha ?? finding?.targetSha ?? headSha);
    return status === 'open' && (!headSha || !findingHead || findingHead === headSha);
  });
  return findings;
}

function hasExplicitFindingsInput(input = {}) {
  return input.findings !== undefined || input.openFindings !== undefined;
}

function hasExplicitProjectPath(input = {}) {
  return Boolean(String(input.projectPath ?? '').trim());
}

function resolveOpenFindings(input = {}, { prNumber, headSha, requireSource = false } = {}) {
  if (hasExplicitFindingsInput(input)) {
    return currentHeadOpenFindings({ ...input, prNumber, headSha });
  }
  if (hasExplicitProjectPath(input)) {
    const root = path.resolve(String(input.projectPath));
    const dir = path.join(root, 'code-reviews', 'findings');
    if (!existsSync(dir)) {
      if (requireSource) throw new Error('finding store unavailable: missing findings directory');
      return [];
    }
    return readPackFindingStore({ projectPath: root, prNumber, headSha });
  }
  if (requireSource) {
    throw new Error('open findings require findings array or projectPath');
  }
  return readPackFindingStore({ projectPath: input.projectPath, prNumber, headSha });
}

export function readPackFindingStore({ projectPath, prNumber, headSha } = {}) {
  const root = path.resolve(projectPath ?? process.cwd());
  const dir = path.join(root, 'code-reviews', 'findings');
  if (!existsSync(dir)) return [];
  const results = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(dir, name);
    if (!statSync(full).isFile()) continue;
    const parsed = readJsonFile(full);
    for (const finding of toArray(Array.isArray(parsed) ? parsed : parsed.findings ?? [parsed])) {
      const matchesPr = !prNumber || Number(finding?.pr_number ?? finding?.prNumber ?? prNumber) === Number(prNumber);
      const findingHead = normalizeTriageText(finding?.head_sha ?? finding?.headSha ?? finding?.targetSha ?? '');
      const matchesHead = !headSha || !findingHead || findingHead === normalizeTriageText(headSha);
      if (matchesPr && matchesHead && normalizeTriageText(finding?.status ?? 'open') === 'open') results.push(finding);
    }
  }
  return results;
}

export function computeOpenFindingsSnapshotHash(findings, classifications = null) {
  const rows = findings.map((finding, index) => {
    const classification = classifications ? classifications[index] : null;
    return {
      finding_id: String(finding?.id ?? ''),
      fingerprint: String(finding?.fingerprint ?? finding?.id ?? ''),
      normalized_text: classification?.normalizedText ?? normalizeTriageText(buildFindingText(finding)),
    };
  }).sort((a, b) => `${a.finding_id}\0${a.fingerprint}`.localeCompare(`${b.finding_id}\0${b.fingerprint}`));
  return sha256(stableJson(rows));
}

function catalogRowsByKey(existingRows) {
  const byKey = new Map();
  for (const row of existingRows) byKey.set(`${row.pr_number}:${row.fingerprint}`, row);
  return byKey;
}

function writeDeferredCatalogRows({ paths, prNumber, headSha, gateRunId, findings, classifications }) {
  if (process.env.MERGE_TRIAGE_SIMULATE_CATALOG_ERROR === '1') throw new Error('simulated catalog write failure');
  const existing = readJsonl(paths.catalog);
  const byKey = catalogRowsByKey(existing);
  const now = new Date().toISOString();
  const newRows = [];
  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index];
    const classification = classifications[index];
    if (classification.verdict !== VERDICT_DEFER) continue;
    const key = `${prNumber}:${classification.fingerprint}`;
    const previous = byKey.get(key);
    const row = {
      schema_version: TRIAGE_SCHEMA_VERSION,
      fingerprint: classification.fingerprint,
      finding_id: classification.findingId,
      pr_number: Number(prNumber),
      head_sha: headSha,
      title: String(finding?.title ?? ''),
      severity: String(finding?.severity ?? ''),
      category: String(finding?.category ?? ''),
      details_excerpt: String(finding?.body ?? finding?.details ?? '').slice(0, 4000),
      normalized_text_hash: classification.normalizedTextHash,
      gate_verdict: VERDICT_DEFER,
      deferred_at_utc: previous?.deferred_at_utc ?? now,
      last_seen_at_utc: now,
      gate_run_id: gateRunId,
      run_ids: Array.from(new Set([...toArray(previous?.run_ids), String(finding?.runId ?? '').trim()].filter(Boolean))),
      marker_hits: classification.matchedMarkers,
      promoted_issue: previous?.promoted_issue ?? null,
    };
    byKey.set(key, row);
    if (!previous) newRows.push(row);
  }
  for (const row of newRows) appendJsonl(paths.catalog, row);
  return Array.from(byKey.values()).filter((row) => Number(row.pr_number) === Number(prNumber));
}

function appendVerdictJournal({ paths, prNumber, headSha, gateRunId, finding, classification, actor = 'gate', actorSession = '', provenanceToken = '' }) {
  const row = {
    schema_version: TRIAGE_SCHEMA_VERSION,
    event: 'merge_triage_verdict',
    gate_run_id: gateRunId,
    finding_id: classification.findingId,
    fingerprint: classification.fingerprint,
    pr_number: Number(prNumber),
    head_sha: headSha,
    verdict: classification.verdict,
    matched_markers: classification.matchedMarkers,
    reason: classification.reason,
    actor,
    actor_session: actorSession,
    adjudication_provenance_token_hash: provenanceToken ? sha256(provenanceToken) : '',
    normalized_text_hash: classification.normalizedTextHash,
    title: String(finding?.title ?? ''),
    timestamp_utc: new Date().toISOString(),
  };
  appendJsonl(paths.journal, row);
  return row;
}

function resolveTrustedSessionKind(input = {}) {
  const envKind = normalizeTriageText(process.env.AO_SESSION_KIND ?? '');
  const payloadKind = normalizeTriageText(input.sessionKind ?? '');
  if (envKind && payloadKind && envKind !== payloadKind) {
    throw new Error('session kind disagrees with trusted AO_SESSION_KIND');
  }
  return envKind || payloadKind;
}

function readArchitectTokenRecords(paths) {
  return existsSync(paths.tokens) ? readJsonFile(paths.tokens) : {};
}

function isVerifiedArchitectProvenanceHash(paths, provenanceHash, normalizedTextHash) {
  const hash = String(provenanceHash ?? '').trim();
  if (!hash) return false;
  const records = readArchitectTokenRecords(paths);
  return Object.values(records).some(
    (record) => record.tokenHash === hash && record.normalizedTextHash === normalizedTextHash,
  );
}

function isVerifiedArchitectJournalRow(paths, row) {
  if (row.actor !== 'architect' && row.actor !== 'operator') return false;
  if (row.reason !== 'architect_adjudication') return false;
  if (row.actor === 'architect' && !String(row.actor_session ?? '').trim()) return false;
  return isVerifiedArchitectProvenanceHash(paths, row.adjudication_provenance_token_hash, row.normalized_text_hash);
}

function latestArchitectAdjudicationRow(paths, prNumber, headSha, findingId, fingerprint) {
  const rows = readJsonl(paths.journal);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (Number(row.pr_number) !== Number(prNumber)) continue;
    if (normalizeTriageText(row.head_sha) !== normalizeTriageText(headSha)) continue;
    if (row.finding_id !== findingId || row.fingerprint !== fingerprint) continue;
    if (row.actor !== 'architect' && row.actor !== 'operator') continue;
    if (row.reason !== 'architect_adjudication') continue;
    if (row.verdict !== VERDICT_BLOCK && row.verdict !== VERDICT_DEFER) continue;
    return row;
  }
  return null;
}

function resolveOpenFindingClassification({ paths, prNumber, headSha, finding, markerList, overrideClassification = null }) {
  const findingId = String(finding?.id ?? '');
  const fingerprint = String(finding?.fingerprint ?? findingId);
  const base = classifyFinding(finding, markerList);
  if (
    overrideClassification &&
    overrideClassification.findingId === findingId &&
    overrideClassification.fingerprint === fingerprint
  ) {
    return {
      ...base,
      verdict: overrideClassification.verdict,
      reason: overrideClassification.reason,
    };
  }
  const adjudicated = latestArchitectAdjudicationRow(paths, prNumber, headSha, findingId, fingerprint);
  if (
    adjudicated &&
    adjudicated.normalized_text_hash === base.normalizedTextHash &&
    isVerifiedArchitectJournalRow(paths, adjudicated)
  ) {
    return {
      ...base,
      verdict: adjudicated.verdict,
      reason: adjudicated.reason,
    };
  }
  return base;
}

function appendArchitectInbox({ paths, prNumber, headSha, gateRunId, finding, classification, appealReason = '' }) {
  const adjudicationId = `adj-${sha256(`${prNumber}:${headSha}:${classification.fingerprint}:${classification.normalizedTextHash}`).slice(0, 24)}`;
  const token = randomUUID();
  const publicRow = {
    schema_version: TRIAGE_SCHEMA_VERSION,
    adjudication_id: adjudicationId,
    status: 'pending',
    pr_number: Number(prNumber),
    head_sha: headSha,
    finding_id: classification.findingId,
    fingerprint: classification.fingerprint,
    normalized_text_hash: classification.normalizedTextHash,
    marker_hits: classification.matchedMarkers,
    verdict_reason: classification.reason,
    appeal_reason: appealReason,
    finding_excerpt: classification.normalizedText.slice(0, 1000),
    gate_run_id: gateRunId,
    created_at_utc: new Date().toISOString(),
  };
  appendJsonl(paths.inbox, publicRow);
  const tokens = existsSync(paths.tokens) ? readJsonFile(paths.tokens) : {};
  tokens[adjudicationId] = { token, tokenHash: sha256(token), normalizedTextHash: classification.normalizedTextHash };
  writeJsonFile(paths.tokens, tokens);
  return { ...publicRow, adjudication_provenance_token: token };
}

function readPendingInbox(paths, prNumber, headSha) {
  const latestById = new Map();
  for (const row of readJsonl(paths.inbox)) {
    latestById.set(row.adjudication_id, row);
  }
  return Array.from(latestById.values()).filter((row) => {
    if (row.status !== 'pending') return false;
    if (prNumber && Number(row.pr_number) !== Number(prNumber)) return false;
    if (headSha && normalizeTriageText(row.head_sha) !== normalizeTriageText(headSha)) return false;
    return true;
  });
}

function architectJournalRowsForHead(rows, prNumber, headSha) {
  return rows.filter((row) => {
    if (row.actor !== 'architect') return false;
    if (prNumber && Number(row.pr_number) !== Number(prNumber)) return false;
    if (headSha && normalizeTriageText(row.head_sha) !== normalizeTriageText(headSha)) return false;
    return true;
  });
}


function canEmitMergeTriageClearance(openFindings, openClassifications, pendingInboxCount) {
  if (pendingInboxCount > 0) return false;
  if (openFindings.length === 0) return true;
  return openClassifications.every((classification) => classification.verdict === VERDICT_DEFER);
}

function emitClearance({ paths, prNumber, headSha, gateRunId, markerList, atCapRecord, findings, classifications }) {
  const record = {
    schema_version: TRIAGE_SCHEMA_VERSION,
    terminal: TERMINAL_MERGE_TRIAGE_CLEARED,
    pr_number: Number(prNumber),
    head_sha: headSha,
    source_terminal_ref: atCapRecord,
    gate_run_id: gateRunId,
    marker_list_version: markerList.schemaVersion,
    marker_list_hash: markerList.markerListHash,
    open_findings_snapshot_hash: computeOpenFindingsSnapshotHash(findings, classifications),
    emitted_at_utc: new Date().toISOString(),
    producer: 'orchestrator-pack:merge-triage-gate',
  };
  writeJsonFile(path.join(paths.clearanceDir, `pr-${prNumber}-${headSha || 'unknown'}.json`), record);
  return record;
}

function loadClearance(paths, prNumber, headSha, input = {}) {
  if (input.clearanceRecord) return input.clearanceRecord;
  const file = path.join(paths.clearanceDir, `pr-${prNumber}-${headSha || 'unknown'}.json`);
  if (!existsSync(file)) return null;
  return readJsonFile(file);
}

function isPermissiveArchitectVerdict(row) {
  return row.actor === 'architect' && row.verdict === VERDICT_DEFER;
}

function permissiveBudgetExhausted(paths) {
  const rows = readJsonl(paths.journal);
  let count = 0;
  for (const row of rows) {
    if (row.actor === 'operator' && row.verdict === 'ACK_RESET') count = 0;
    else if (isPermissiveArchitectVerdict(row)) count += 1;
  }
  return count >= 2;
}

export function runMergeTriageGate(input = {}) {
  const stateRoot = resolveStateRoot(input);
  const paths = statePaths(stateRoot);
  const markerList = loadMarkerList(input.markerFile ?? DEFAULT_MARKER_FILE);
  const prNumber = Number(input.prNumber);
  const headSha = normalizeTriageText(input.headSha ?? input.currentHeadSha ?? '');
  const atCapRecord = findAtCapRecord(input);
  if (!atCapRecord) return { ok: true, ran: false, reason: 'no_latched_at_cap_open_findings' };
  const gateRunId = input.gateRunId ?? `merge-triage-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let findings;
  try {
    findings = resolveOpenFindings(input, { prNumber, headSha, requireSource: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, ran: true, reason: 'open_findings_unavailable', message };
  }
  const classifications = findings.map((finding) =>
    resolveOpenFindingClassification({ paths, prNumber, headSha, finding, markerList }),
  );
  const existingClearance = loadClearance(paths, prNumber, headSha, input);
  if (existingClearance) {
    const pendingInbox = readPendingInbox(paths, prNumber, headSha);
    const snapshotHash = computeOpenFindingsSnapshotHash(findings, classifications);
    if (
      pendingInbox.length === 0 &&
      Number(existingClearance.marker_list_version) === markerList.schemaVersion &&
      existingClearance.marker_list_hash === markerList.markerListHash &&
      existingClearance.open_findings_snapshot_hash === snapshotHash
    ) {
      return {
        ok: true,
        ran: true,
        aggregate: VERDICT_DEFER,
        gateRunId: existingClearance.gate_run_id ?? gateRunId,
        classifications,
        clearance: existingClearance,
        reason: 'existing_merge_triage_clearance',
        catalogPath: paths.catalog,
      };
    }
  }
  for (let index = 0; index < findings.length; index += 1) {
    appendVerdictJournal({ paths, prNumber, headSha, gateRunId, finding: findings[index], classification: classifications[index] });
  }
  const pending = [];
  const block = [];
  const defer = [];
  for (let index = 0; index < findings.length; index += 1) {
    const classification = classifications[index];
    if (classification.verdict === VERDICT_PENDING_ARCHITECT) {
      pending.push(appendArchitectInbox({ paths, prNumber, headSha, gateRunId, finding: findings[index], classification }));
    } else if (classification.verdict === VERDICT_BLOCK) {
      block.push({ finding: findings[index], classification });
    } else if (classification.verdict === VERDICT_DEFER) {
      defer.push({ finding: findings[index], classification });
    }
  }
  if (pending.length > 0) {
    return { ok: false, ran: true, aggregate: VERDICT_PENDING_ARCHITECT, gateRunId, classifications, pendingArchitect: pending.map(({ adjudication_provenance_token: _token, ...row }) => row) };
  }
  if (block.length > 0) {
    const deliveryRows = block.map(({ finding, classification }) => ({
      schema_version: TRIAGE_SCHEMA_VERSION,
      event: 'block_bounded_continuation',
      pr_number: prNumber,
      head_sha: headSha,
      gate_run_id: gateRunId,
      finding,
      finding_id: classification.findingId,
      fingerprint: classification.fingerprint,
      delivered_via: 'existing_review_finding_delivery_path',
      distinct_head_budget_increment: 0,
      auto_review_start_suppressed: true,
      created_at_utc: new Date().toISOString(),
    }));
    for (const row of deliveryRows) appendJsonl(paths.delivery, row);
    return { ok: false, ran: true, aggregate: VERDICT_BLOCK, gateRunId, classifications, blockDelivery: deliveryRows };
  }
  writeDeferredCatalogRows({ paths, prNumber, headSha, gateRunId, findings, classifications });
  const clearance = emitClearance({ paths, prNumber, headSha, gateRunId, markerList, atCapRecord, findings, classifications });
  return { ok: true, ran: true, aggregate: VERDICT_DEFER, gateRunId, classifications, clearance, catalogPath: paths.catalog };
}

export function evaluateMergePolicy(input = {}) {
  const stateRoot = resolveStateRoot(input);
  const paths = statePaths(stateRoot);
  const markerList = loadMarkerList(input.markerFile ?? DEFAULT_MARKER_FILE);
  const prNumber = Number(input.prNumber);
  const headSha = normalizeTriageText(input.headSha ?? input.currentHeadSha ?? '');
  if (findCleanEarlyStop(input)) return { allow: true, reason: 'clean_early_stop' };
  const atCapRecord = findAtCapRecord(input);
  if (!atCapRecord) return { allow: true, reason: 'no_at_cap_gate_required' };
  const pending = readPendingInbox(paths, prNumber, headSha);
  if (pending.length > 0) return { allow: false, reason: 'pending_architect_adjudication', pending };
  const clearance = loadClearance(paths, prNumber, headSha, input);
  if (!clearance) return { allow: false, reason: 'at_cap_without_merge_triage_clearance' };
  if (Number(clearance.marker_list_version) !== markerList.schemaVersion || clearance.marker_list_hash !== markerList.markerListHash) {
    return { allow: false, reason: 'marker_list_drift' };
  }
  let findings;
  try {
    findings = resolveOpenFindings(input, { prNumber, headSha, requireSource: true });
  } catch {
    return { allow: false, reason: 'open_findings_unavailable' };
  }
  const liveHash = computeOpenFindingsSnapshotHash(findings);
  if (liveHash !== clearance.open_findings_snapshot_hash) {
    return { allow: false, reason: 'open_findings_snapshot_drift', expected: clearance.open_findings_snapshot_hash, actual: liveHash };
  }
  const architectRows = architectJournalRowsForHead(readJsonl(paths.journal), prNumber, headSha);
  const invalidArchitectRows = architectRows.filter((row) => !isVerifiedArchitectJournalRow(paths, row));
  if (invalidArchitectRows.length > 0) {
    const missingArchitectSession = invalidArchitectRows.some(
      (row) => row.actor === 'architect' && !String(row.actor_session ?? '').trim(),
    );
    return {
      allow: false,
      reason: missingArchitectSession ? 'invalid_architect_actor_session' : 'invalid_architect_provenance',
    };
  }
  return { allow: true, reason: 'merge_triage_cleared', clearance };
}

export function readArchitectInbox(input = {}) {
  const paths = statePaths(resolveStateRoot(input));
  return { pending: readPendingInbox(paths, input.prNumber, input.headSha).map(({ adjudication_provenance_token: _token, ...row }) => row) };
}

export function issueArchitectProvenanceToken(input = {}) {
  const sessionKind = resolveTrustedSessionKind(input);
  if (sessionKind === 'worker' || sessionKind === 'orchestrator-planner') {
    throw new Error('architect token rejected for worker/orchestrator session');
  }
  if (sessionKind !== 'architect') {
    throw new Error(sessionKind ? `unsupported architect token session kind: ${sessionKind}` : 'architect token requires architect session');
  }
  const paths = statePaths(resolveStateRoot(input));
  const adjudicationId = String(input.adjudicationId ?? '');
  const inbox = readPendingInbox(paths, input.prNumber, input.headSha).find((row) => row.adjudication_id === adjudicationId);
  if (!inbox) throw new Error('pending adjudication not found');
  const tokens = existsSync(paths.tokens) ? readJsonFile(paths.tokens) : {};
  const tokenRecord = tokens[adjudicationId];
  if (!tokenRecord?.token || tokenRecord.normalizedTextHash !== inbox.normalized_text_hash) throw new Error('adjudication token unavailable');
  return {
    adjudication_id: adjudicationId,
    adjudication_provenance_token: tokenRecord.token,
    normalized_text_hash: inbox.normalized_text_hash,
  };
}

export function fileWorkerAppeal(input = {}) {
  const stateRoot = resolveStateRoot(input);
  const paths = statePaths(stateRoot);
  const markerList = loadMarkerList(input.markerFile ?? DEFAULT_MARKER_FILE);
  const finding = input.finding;
  const prNumber = Number(input.prNumber);
  const headSha = normalizeTriageText(input.headSha ?? input.currentHeadSha ?? finding?.headSha ?? '');
  const gateRunId = input.gateRunId ?? `merge-triage-appeal-${Date.now()}`;
  const classification = classifyFinding(finding, markerList);
  classification.verdict = VERDICT_PENDING_ARCHITECT;
  classification.reason = 'worker_appeal';
  appendVerdictJournal({ paths, prNumber, headSha, gateRunId, finding, classification, actor: 'worker' });
  const inbox = appendArchitectInbox({ paths, prNumber, headSha, gateRunId, finding, classification, appealReason: String(input.appealReason ?? '') });
  const { adjudication_provenance_token: _token, ...publicInbox } = inbox;
  return { ok: false, verdict: VERDICT_PENDING_ARCHITECT, inbox: publicInbox };
}

export function adjudicateArchitectFinding(input = {}) {
  const sessionKind = resolveTrustedSessionKind(input);
  if (sessionKind === 'worker' || sessionKind === 'orchestrator-planner') {
    throw new Error('architect adjudication rejected for worker/orchestrator session');
  }
  if (!sessionKind) {
    throw new Error('architect adjudication requires session kind');
  }
  if (sessionKind !== 'architect' && sessionKind !== 'operator') {
    throw new Error(`unsupported adjudication session kind: ${sessionKind}`);
  }
  const stateRoot = resolveStateRoot(input);
  const paths = statePaths(stateRoot);
  if (sessionKind === 'architect' && permissiveBudgetExhausted(paths) && input.verdict === VERDICT_DEFER) {
    return { ok: false, verdict: VERDICT_PENDING_OPERATOR, reason: 'architect_permissive_budget_exhausted' };
  }
  const adjudicationId = String(input.adjudicationId ?? '');
  const inboxRows = readJsonl(paths.inbox);
  const inbox = [...inboxRows].reverse().find((row) => row.adjudication_id === adjudicationId && row.status === 'pending');
  if (!inbox) throw new Error('pending adjudication not found');
  const tokens = existsSync(paths.tokens) ? readJsonFile(paths.tokens) : {};
  const tokenRecord = tokens[adjudicationId];
  if (!tokenRecord || tokenRecord.tokenHash !== sha256(input.adjudicationProvenanceToken ?? '')) throw new Error('invalid adjudication provenance token');
  const finding = input.finding;
  const normalizedTextHash = sha256(normalizeTriageText(buildFindingText(finding)));
  if (normalizedTextHash !== inbox.normalized_text_hash || normalizedTextHash !== tokenRecord.normalizedTextHash) throw new Error('stale finding text for adjudication');
  const verdict = input.verdict === VERDICT_BLOCK ? VERDICT_BLOCK : input.verdict === VERDICT_DEFER ? VERDICT_DEFER : null;
  if (!verdict) throw new Error('architect verdict must be BLOCK or DEFER');
  const classification = classifyFinding(finding, loadMarkerList(input.markerFile ?? DEFAULT_MARKER_FILE));
  classification.verdict = verdict;
  classification.reason = 'architect_adjudication';
  const actor = sessionKind === 'operator' ? 'operator' : 'architect';
  const actorSession = String(input.actorSession ?? '').trim();
  if (actor === 'architect' && !actorSession) throw new Error('architect adjudication requires actor_session');
  appendVerdictJournal({
    paths,
    prNumber: inbox.pr_number,
    headSha: inbox.head_sha,
    gateRunId: inbox.gate_run_id,
    finding,
    classification,
    actor,
    actorSession,
    provenanceToken: String(input.adjudicationProvenanceToken ?? ''),
  });
  appendJsonl(paths.inbox, { ...inbox, status: 'resolved', resolved_verdict: verdict, resolved_at_utc: new Date().toISOString() });
  let clearance = null;
  if (verdict === VERDICT_DEFER) {
    const markerList = loadMarkerList(input.markerFile ?? DEFAULT_MARKER_FILE);
    const openFindings = resolveOpenFindings(
      { ...input, prNumber: inbox.pr_number, headSha: inbox.head_sha },
      { prNumber: inbox.pr_number, headSha: inbox.head_sha, requireSource: true },
    );
    const openClassifications = openFindings.map((openFinding) =>
      resolveOpenFindingClassification({
        paths,
        prNumber: inbox.pr_number,
        headSha: inbox.head_sha,
        finding: openFinding,
        markerList,
        overrideClassification: classification,
      }),
    );
    writeDeferredCatalogRows({
      paths,
      prNumber: inbox.pr_number,
      headSha: inbox.head_sha,
      gateRunId: inbox.gate_run_id,
      findings: openFindings,
      classifications: openClassifications,
    });
    const pendingRemaining = readPendingInbox(paths, inbox.pr_number, inbox.head_sha);
    if (canEmitMergeTriageClearance(openFindings, openClassifications, pendingRemaining.length)) {
      clearance = emitClearance({
        paths,
        prNumber: inbox.pr_number,
        headSha: inbox.head_sha,
        gateRunId: inbox.gate_run_id,
        markerList,
        atCapRecord: input.atCapRecord ?? { terminal: TERMINAL_AT_CAP_OPEN_FINDINGS, pr_number: inbox.pr_number, head_sha: inbox.head_sha },
        findings: openFindings,
        classifications: openClassifications,
      });
    }
  }
  return { ok: verdict === VERDICT_DEFER, verdict, clearance };
}

const MERGE_TRIAGE_CLI_HANDLERS = {
  classifyFinding: () => classifyFinding(readStdinJson()),
  runGate: () => runMergeTriageGate(readStdinJson()),
  evaluateMergePolicy: () => evaluateMergePolicy(readStdinJson()),
  readArchitectInbox: () => readArchitectInbox(readStdinJson()),
  issueArchitectToken: () => issueArchitectProvenanceToken(readStdinJson()),
  fileWorkerAppeal: () => fileWorkerAppeal(readStdinJson()),
  adjudicateArchitectFinding: () => adjudicateArchitectFinding(readStdinJson()),
};

function mergeTriageCliShouldExitNonZero(subcommand, result) {
  if (subcommand !== 'runGate' || !result || result.ok !== false || result.ran !== true) {
    return false;
  }
  if (result.reason === 'open_findings_unavailable') {
    return true;
  }
  if (toArray(result.classifications).some((classification) => classification?.reason === 'empty_finding_text')) {
    return true;
  }
  return false;
}

const mergeTriageCliEntry = process.argv[1] ?? '';
const isMergeTriageCli =
  mergeTriageCliEntry.endsWith('merge-triage-gate.mjs') ||
  mergeTriageCliEntry.endsWith('merge-triage-gate.js');
if (isMergeTriageCli) {
  const subcommand = process.argv[2];
  const handler = MERGE_TRIAGE_CLI_HANDLERS[subcommand];
  if (!handler) {
    console.error(`Usage: node merge-triage-gate.mjs <${Object.keys(MERGE_TRIAGE_CLI_HANDLERS).join('|')}>`);
    process.exit(2);
  }
  try {
    const result = handler();
    printJson(result);
    process.exit(mergeTriageCliShouldExitNonZero(subcommand, result) ? 1 : 0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
