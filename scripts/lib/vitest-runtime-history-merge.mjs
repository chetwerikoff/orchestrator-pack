#!/usr/bin/env node
/**
 * Runtime-history refresh producer: provenance-gated merge with smoothing (Issue #691).
 * heavyShardCount is topology-derived (Issue #695).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadLanesConfig,
  partitionByLane,
  discoverVitestFiles,
} from './vitest-ci-lanes.mjs';
import { buildHeavyTopology } from './vitest-heavy-topology.mjs';
import { parseVitestReportFile } from './vitest-json-report.mjs';

const libDir = dirname(fileURLToPath(import.meta.url));
export const defaultRepoRoot = join(libDir, '..', '..');

export const SMOOTHING_RULE = 'median-of-last-5-samples';
export const MAX_RECENT_SAMPLES = 5;
export const MEASURED_SOURCE = 'ci-measured';
export const SEEDED_SOURCE = 'ci-baseline-estimates';
export const COVERAGE_SHORTFALL_THRESHOLD = 0.5;
export const SUPPLEMENTAL_TARGET = 'scripts/pack-reviewer-preference.test.ts';
export const SUPPLEMENTAL_META_SCHEMA =
  'orchestrator-pack/vitest-runtime-history-supplemental/v1';
export const TARGET_REPOSITORY = 'chetwerikoff/orchestrator-pack';
export const MAX_SUPPLEMENTAL_REPORT_BYTES = 1024 * 1024;

const PROVENANCE_VALUES = new Set(['measured', 'seeded', 'fallback']);
const HISTORY_MEMBERSHIP_FIELDS = ['files', 'provenance', 'recentSamples', 'fileChangedAt'];
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

export function medianMs(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return null;
  }
  const sorted = [...samples]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return Math.round(sorted[mid]);
}

export function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function cloneHistory(history) {
  return JSON.parse(JSON.stringify(history));
}

export function emptyHistoryShape() {
  return {
    issue: 556,
    source: SEEDED_SOURCE,
    dataChangedAt: null,
    smoothingRule: SMOOTHING_RULE,
    files: {},
    provenance: {},
    recentSamples: {},
    fileChangedAt: {},
  };
}

export function normalizeHistory(raw) {
  const history = emptyHistoryShape();
  if (!raw || typeof raw !== 'object') {
    return history;
  }
  history.issue = raw.issue ?? 556;
  history.source = typeof raw.source === 'string' ? raw.source : SEEDED_SOURCE;
  history.dataChangedAt = raw.dataChangedAt ?? null;
  history.smoothingRule = raw.smoothingRule ?? SMOOTHING_RULE;
  history.files = { ...(raw.files ?? {}) };
  history.provenance = { ...(raw.provenance ?? {}) };
  history.recentSamples = { ...(raw.recentSamples ?? {}) };
  history.fileChangedAt = { ...(raw.fileChangedAt ?? {}) };

  for (const file of Object.keys(history.files)) {
    if (!history.provenance[file]) {
      history.provenance[file] = 'seeded';
    }
  }

  return history;
}

function normalizeInventory(paths) {
  return [...new Set((paths ?? []).map((entry) => String(entry).replace(/\\/g, '/')))]
    .sort((left, right) => left.localeCompare(right));
}

export function runtimeHistoryInventory(history) {
  return Object.keys(normalizeHistory(history).provenance).sort((left, right) =>
    left.localeCompare(right),
  );
}

export function diffRuntimeHistoryInventories(leftPaths, rightPaths) {
  const left = normalizeInventory(leftPaths);
  const right = normalizeInventory(rightPaths);
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const leftOnly = left.filter((file) => !rightSet.has(file));
  const rightOnly = right.filter((file) => !leftSet.has(file));
  return {
    equal: leftOnly.length === 0 && rightOnly.length === 0,
    leftOnly,
    rightOnly,
  };
}

export function reconcileTrustedInventory(history, currentFiles) {
  const normalized = normalizeHistory(history);
  const currentInventory = normalizeInventory(currentFiles);
  const currentSet = new Set(currentInventory);

  for (const field of HISTORY_MEMBERSHIP_FIELDS) {
    for (const file of Object.keys(normalized[field] ?? {})) {
      if (!currentSet.has(file)) {
        delete normalized[field][file];
      }
    }
  }

  for (const file of currentInventory) {
    const weight = Number(normalized.files[file]);
    const hasWeight = Number.isFinite(weight) && weight > 0;
    const provenance = normalized.provenance[file];

    if (provenance === 'fallback' || !hasWeight) {
      delete normalized.files[file];
      delete normalized.recentSamples[file];
      delete normalized.fileChangedAt[file];
      normalized.provenance[file] = 'fallback';
      continue;
    }

    if (!PROVENANCE_VALUES.has(provenance)) {
      normalized.provenance[file] = 'seeded';
    }
  }

  return normalized;
}

export function loadHistoryFromFile(path) {
  if (!existsSync(path)) {
    return emptyHistoryShape();
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return normalizeHistory(raw);
}

export function historyBytes(history) {
  return stableStringify(history);
}

export function buildSyntheticVitestReport(files, repoRoot = defaultRepoRoot) {
  const root = repoRoot.replace(/\\/g, '/');
  const testResults = files.map(({ file, durationMs }) => {
    const start = 1_700_000_000_000;
    const end = start + durationMs;
    return {
      name: `${root}/${file}`,
      startTime: start,
      endTime: end,
      assertionResults: [{ title: 'fixture', duration: durationMs }],
    };
  });
  return { testResults };
}

export function classifyHeavyFiles(repoRoot = defaultRepoRoot) {
  const config = loadLanesConfig(repoRoot);
  const discovered = discoverVitestFiles(repoRoot);
  const { heavy } = partitionByLane(discovered, config.classification);
  const topologyResult = buildHeavyTopology(repoRoot);
  if (!topologyResult.ok) {
    throw new Error(topologyResult.errors.join('; '));
  }
  return {
    heavy: [...heavy].sort(),
    classification: config.classification,
    heavyShardCount: topologyResult.topology.heavyShardCount,
  };
}

export function validateShardMeta(meta, expectedCommitSha, shard) {
  if (!meta || typeof meta !== 'object') {
    return 'missing shard metadata';
  }
  if (Number(meta.shard) !== shard) {
    return `shard metadata mismatch: expected ${shard}, got ${meta.shard}`;
  }
  if (meta.success !== true) {
    return `shard ${shard} metadata reports success=false`;
  }
  if (String(meta.commitSha ?? '') !== String(expectedCommitSha ?? '')) {
    return `shard ${shard} commit mismatch: expected ${expectedCommitSha}, got ${meta.commitSha}`;
  }
  return null;
}

export function extractReportDurations(reportPath, repoRoot, classification) {
  let parsed;
  try {
    parsed = parseVitestReportFile(reportPath, repoRoot);
  } catch {
    return { error: 'unparseable report', durations: new Map() };
  }
  if (!parsed) {
    return { error: 'zero-file report', durations: new Map() };
  }
  if (parsed.files.length === 0) {
    return { error: 'zero-file report', durations: new Map() };
  }

  const durations = new Map();
  for (const entry of parsed.files) {
    const lane = classification[entry.file];
    if (!lane) {
      return { error: `unclassified path in report: ${entry.file}`, durations: new Map() };
    }
    if (lane !== 'heavy') {
      return { error: `non-heavy path in heavy shard report: ${entry.file}`, durations: new Map() };
    }
    if (!Number.isFinite(entry.durationMs) || entry.durationMs <= 0) {
      continue;
    }
    durations.set(entry.file, Math.round(entry.durationMs));
  }

  if (durations.size === 0) {
    return { error: 'zero-file report', durations: new Map() };
  }

  return { error: null, durations };
}

/**
 * @param {Map<number, { reportPath?: string, metaPath?: string, meta?: object }>} shardReports
 */
export function validateReportSet(shardReports, expectedCommitSha, repoRoot = defaultRepoRoot) {
  const { heavy, classification, heavyShardCount } = classifyHeavyFiles(repoRoot);
  const errors = [];

  for (let shard = 1; shard <= heavyShardCount; shard += 1) {
    const entry = shardReports.get(shard);
    if (!entry?.reportPath || !existsSync(entry.reportPath)) {
      errors.push(`missing heavy shard report for shard ${shard}`);
      continue;
    }
    const meta = entry.meta ?? null;
    const metaError = validateShardMeta(meta, expectedCommitSha, shard);
    if (metaError) {
      errors.push(metaError);
    }
    const extracted = extractReportDurations(entry.reportPath, repoRoot, classification);
    if (extracted.error?.includes('unclassified') || extracted.error?.includes('non-heavy')) {
      errors.push(extracted.error);
    } else if (extracted.error) {
      errors.push(`shard ${shard}: ${extracted.error}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, durations: new Map(), heavy };
  }

  const durations = new Map();
  for (let shard = 1; shard <= heavyShardCount; shard += 1) {
    const entry = shardReports.get(shard);
    const extracted = extractReportDurations(entry.reportPath, repoRoot, classification);
    for (const [file, ms] of extracted.durations) {
      durations.set(file, ms);
    }
  }

  return { ok: true, errors: [], durations, heavy };
}

export function validateSupplementalTargetMeta(
  meta,
  expectedSourceSha,
  target = SUPPLEMENTAL_TARGET,
  expectedRunId = "",
  expectedRunAttempt = "",
) {
  if (!meta || typeof meta !== 'object') {
    return 'missing supplemental report metadata';
  }
  if (meta.schema !== SUPPLEMENTAL_META_SCHEMA) {
    return 'supplemental report metadata schema is invalid';
  }
  if (meta.repository !== TARGET_REPOSITORY) {
    return 'supplemental report repository is invalid';
  }
  if (meta.target !== target || target !== SUPPLEMENTAL_TARGET) {
    return `supplemental report target mismatch: expected ${SUPPLEMENTAL_TARGET}`;
  }
  if (!FULL_SHA_RE.test(String(expectedSourceSha ?? ''))) {
    return 'expected supplemental source sha must be a full 40-hex commit';
  }
  if (String(meta.commitSha ?? '').toLowerCase() !== String(expectedSourceSha).toLowerCase()) {
    return `supplemental report commit mismatch: expected ${expectedSourceSha}, got ${meta.commitSha}`;
  }
  if (meta.success !== true || meta.conclusion !== 'success') {
    return 'supplemental report metadata does not prove terminal success';
  }
  if (meta.lane !== 'light') {
    return 'supplemental report lane must be light';
  }
  const discovery = meta.discovery;
  if (
    !discovery ||
    typeof discovery !== 'object' ||
    discovery.source !== 'scripts/vitest-ci-lanes.config.json' ||
    discovery.target !== target ||
    discovery.lane !== 'light'
  ) {
    return 'supplemental report discovery identity is invalid';
  }
  if (!/^\d+$/.test(String(meta.runId ?? '')) || !/^\d+$/.test(String(meta.runAttempt ?? ''))) {
    return 'supplemental report run identity is invalid';
  }
  if (String(expectedRunId ?? '').trim() && String(meta.runId) !== String(expectedRunId).trim()) {
    return `supplemental report run mismatch: expected ${expectedRunId}, got ${meta.runId}`;
  }
  if (String(expectedRunAttempt ?? '').trim() && String(meta.runAttempt) !== String(expectedRunAttempt).trim()) {
    return `supplemental report attempt mismatch: expected ${expectedRunAttempt}, got ${meta.runAttempt}`;
  }
  return null;
}

export function extractSupplementalReportDurations(reportPath, repoRoot, target = SUPPLEMENTAL_TARGET) {
  let payload;
  try {
    const raw = readFileSync(reportPath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_SUPPLEMENTAL_REPORT_BYTES) {
      return { error: 'supplemental report exceeds size limit', durations: new Map() };
    }
    payload = JSON.parse(raw);
  } catch {
    return { error: 'unparseable supplemental report', durations: new Map() };
  }
  if (payload?.success !== true || Number(payload?.numFailedTests ?? 1) !== 0) {
    return { error: 'supplemental report did not complete successfully', durations: new Map() };
  }
  let parsed;
  try {
    parsed = parseVitestReportFile(reportPath, repoRoot);
  } catch {
    return { error: 'unparseable supplemental report', durations: new Map() };
  }
  if (!parsed || parsed.files.length !== 1) {
    return { error: 'supplemental report must contain exactly one file', durations: new Map() };
  }
  const entry = parsed.files[0];
  const normalizedFile = entry.file.startsWith('supplemental-source/')
    ? entry.file.slice('supplemental-source/'.length)
    : entry.file;
  if (normalizedFile !== target) {
    return { error: `supplemental report target mismatch: expected ${target}, got ${entry.file}`, durations: new Map() };
  }
  if (!Number.isFinite(entry.durationMs) || entry.durationMs <= 0) {
    return { error: 'supplemental report duration must be finite and positive', durations: new Map() };
  }
  return { error: null, durations: new Map([[target, entry.durationMs]]) };
}

export function validateSupplementalReportSet(
  supplementalReports,
  expectedSourceSha,
  repoRoot = defaultRepoRoot,
  heavyFiles = [],
  expectedRunId = "",
  expectedRunAttempt = "",
) {
  const errors = [];
  const entries = supplementalReports instanceof Map ? [...supplementalReports.entries()] : [];
  if (entries.length !== 1 || entries[0][0] !== SUPPLEMENTAL_TARGET) {
    errors.push(`supplemental report set must contain exactly ${SUPPLEMENTAL_TARGET}`);
    return { ok: false, errors, durations: new Map() };
  }
  const [target, entry] = entries[0];
  if (entry?.duplicate) {
    errors.push('duplicate supplemental report');
  }
  if (!entry?.reportPath || !existsSync(entry.reportPath)) {
    errors.push(`missing supplemental report for ${target}`);
  }
  const metaError = validateSupplementalTargetMeta(
    entry?.meta ?? null,
    expectedSourceSha,
    target,
    expectedRunId,
    expectedRunAttempt,
  );
  if (metaError) {
    errors.push(metaError);
  }
  const extracted = entry?.reportPath && existsSync(entry.reportPath)
    ? extractSupplementalReportDurations(entry.reportPath, repoRoot, target)
    : { error: null, durations: new Map() };
  if (extracted.error) {
    errors.push(extracted.error);
  }
  if (new Set(heavyFiles).has(SUPPLEMENTAL_TARGET)) {
    errors.push('supplemental target overlaps heavy report set');
  }
  return {
    ok: errors.length === 0,
    errors,
    durations: errors.length === 0 ? extracted.durations : new Map(),
  };
}

export function loadSupplementalReportsFromDir(reportsDir) {
  const reportName = 'supplemental-pack-reviewer-preference.json';
  const metaName = `${reportName}.meta.json`;
  const allowed = new Set([reportName, metaName]);
  const entries = readdirSync(reportsDir);
  const unexpected = entries.filter((name) => !allowed.has(name));
  if (unexpected.length > 0) {
    throw new Error(`unexpected supplemental report artifact(s): ${unexpected.join(', ')}`);
  }
  const reportPath = join(reportsDir, reportName);
  const metaPath = join(reportsDir, metaName);
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : null;
  return new Map([[SUPPLEMENTAL_TARGET, { reportPath, metaPath, meta }]]);
}

export function computeCoverageSignal(history, heavyFiles) {
  const counts = { measured: 0, seeded: 0, fallback: 0 };
  for (const file of heavyFiles) {
    const provenance = history.provenance?.[file];
    if (provenance === 'measured') {
      counts.measured += 1;
    } else if (provenance === 'seeded') {
      counts.seeded += 1;
    } else if (history.files[file] != null) {
      counts.seeded += 1;
    } else {
      counts.fallback += 1;
    }
  }
  const total = heavyFiles.length;
  const measuredShare = total === 0 ? 1 : counts.measured / total;
  const shortfall = measuredShare < COVERAGE_SHORTFALL_THRESHOLD;
  return {
    counts,
    total,
    measuredShare,
    shortfall,
    message: `runtime-history measured coverage: ${counts.measured}/${total} heavy files (${(measuredShare * 100).toFixed(1)}%); seeded=${counts.seeded} fallback=${counts.fallback}`,
  };
}

export function mergeValidatedDurations(baseHistory, durations, heavyFiles) {
  const history = normalizeHistory(baseHistory);
  const beforeBytes = historyBytes(history);
  let anyWeightChanged = false;
  let anyMeasuredAccepted = false;

  for (const [file, durationMs] of durations) {
    const priorSamples = Array.isArray(history.recentSamples[file])
      ? history.recentSamples[file]
      : [];
    if (
      priorSamples.length > 0 &&
      priorSamples[priorSamples.length - 1] === durationMs
    ) {
      if (history.provenance[file] !== 'measured') {
        history.provenance[file] = 'measured';
        anyMeasuredAccepted = true;
      }
      continue;
    }
    const samples = [...priorSamples, durationMs].slice(-MAX_RECENT_SAMPLES);
    const smoothed = medianMs(samples);
    if (smoothed == null) {
      continue;
    }

    const previousWeight = history.files[file];
    history.recentSamples[file] = samples;
    history.provenance[file] = 'measured';
    anyMeasuredAccepted = true;

    if (previousWeight !== smoothed) {
      history.files[file] = smoothed;
      history.fileChangedAt[file] = new Date().toISOString();
      anyWeightChanged = true;
    }
  }

  if (anyWeightChanged) {
    history.source = MEASURED_SOURCE;
    history.dataChangedAt = new Date().toISOString();
  } else if (anyMeasuredAccepted) {
    history.source = MEASURED_SOURCE;
  }

  history.smoothingRule = SMOOTHING_RULE;

  for (const file of heavyFiles) {
    if (!history.provenance[file]) {
      if (history.files[file] != null) {
        history.provenance[file] = 'seeded';
      } else {
        history.provenance[file] = 'fallback';
      }
    } else if (!PROVENANCE_VALUES.has(history.provenance[file])) {
      history.provenance[file] = 'seeded';
    }
  }

  const afterBytes = historyBytes(history);
  const changed = beforeBytes !== afterBytes;
  const coverage = computeCoverageSignal(history, heavyFiles);

  return {
    history,
    changed,
    idempotent: !changed,
    coverage,
  };
}

export function refreshRuntimeHistory({
  baseHistory,
  shardReports,
  supplementalReports = null,
  expectedCommitSha,
  expectedSupplementalSourceSha = '',
  expectedSupplementalRunId = '',
  expectedSupplementalRunAttempt = '',
  repoRoot = defaultRepoRoot,
}) {
  const normalizedBase = normalizeHistory(baseHistory);
  const baseBytes = historyBytes(normalizedBase);
  const validation = validateReportSet(shardReports, expectedCommitSha, repoRoot);
  const currentInventory = discoverVitestFiles(repoRoot);
  const supplementalValidation = supplementalReports
    ? validateSupplementalReportSet(
        supplementalReports,
        expectedSupplementalSourceSha,
        repoRoot,
        validation.heavy,
        expectedSupplementalRunId,
        expectedSupplementalRunAttempt,
      )
    : { ok: true, errors: [], durations: new Map() };
  const errors = [...validation.errors, ...supplementalValidation.errors];
  if (
    supplementalReports &&
    supplementalValidation.ok &&
    !currentInventory.includes(SUPPLEMENTAL_TARGET)
  ) {
    errors.push(`supplemental target is absent from trusted workflow inventory: ${SUPPLEMENTAL_TARGET}`);
  }

  if (!validation.ok || !supplementalValidation.ok || errors.length > 0) {
    return {
      ok: false,
      changed: false,
      idempotent: true,
      history: normalizedBase,
      baseBytes,
      outputBytes: baseBytes,
      errors,
      coverage: computeCoverageSignal(normalizedBase, validation.heavy),
      rejected: true,
    };
  }

  const durations = new Map(validation.durations);
  for (const [file, durationMs] of supplementalValidation.durations) {
    durations.set(file, durationMs);
  }
  const merged = mergeValidatedDurations(normalizedBase, durations, validation.heavy);
  const beforeInventoryBytes = historyBytes(merged.history);
  const inventoriedHistory = reconcileTrustedInventory(merged.history, currentInventory);
  const membershipChanged = historyBytes(inventoriedHistory) !== beforeInventoryBytes;
  if (membershipChanged) {
    inventoriedHistory.source = MEASURED_SOURCE;
    inventoriedHistory.dataChangedAt = new Date().toISOString();
  }
  const outputBytes = historyBytes(inventoriedHistory);
  const changed = outputBytes !== baseBytes;
  return {
    ok: true,
    changed,
    idempotent: !changed,
    history: inventoriedHistory,
    baseBytes,
    outputBytes,
    errors: [],
    coverage: computeCoverageSignal(inventoriedHistory, validation.heavy),
    rejected: false,
  };
}

export function reconcileProposedHistoryAgainstRemote(
  proposedHistory,
  remoteHistory,
  options = {},
) {
  const proposed = normalizeHistory(proposedHistory);
  const remote = normalizeHistory(remoteHistory);
  const currentInventory = Array.isArray(options.currentInventory)
    ? normalizeInventory(options.currentInventory)
    : null;

  if (options.requireEqualInventory) {
    if (!currentInventory) {
      throw new Error('trusted current inventory is required for stale-base reconcile');
    }
    const proposedInventory = runtimeHistoryInventory(proposed);
    const diff = diffRuntimeHistoryInventories(proposedInventory, currentInventory);
    if (!diff.equal) {
      throw new Error(
        `inventory drift: proposed-only=${JSON.stringify(diff.leftOnly)} trusted-only=${JSON.stringify(diff.rightOnly)}`,
      );
    }
  }

  const merged = mergeConcurrentRefreshes(remote, [proposed]);
  return currentInventory
    ? reconcileTrustedInventory(merged, currentInventory)
    : merged;
}

export function mergeConcurrentRefreshes(baseHistory, updates) {
  let history = normalizeHistory(baseHistory);
  const sorted = [...updates].sort((a, b) => {
    const aTs = Date.parse(a.dataChangedAt ?? '') || 0;
    const bTs = Date.parse(b.dataChangedAt ?? '') || 0;
    return aTs - bTs;
  });

  for (const update of sorted) {
    const normalized = normalizeHistory(update);
    const changedFiles = Object.keys(normalized.fileChangedAt ?? {});
    for (const file of changedFiles) {
      const ms = normalized.files[file];
      if (!Number.isFinite(ms)) {
        continue;
      }
      const existingFileTs = Date.parse(history.fileChangedAt[file] ?? '') || 0;
      const updateFileTs = Date.parse(normalized.fileChangedAt[file] ?? '') || 0;
      if (updateFileTs >= existingFileTs) {
        history.files[file] = ms;
        history.provenance[file] = normalized.provenance[file] ?? 'measured';
        history.recentSamples[file] = normalized.recentSamples[file] ?? [ms];
        history.fileChangedAt[file] = normalized.fileChangedAt[file];
      }
    }

    const updateTs = Date.parse(normalized.dataChangedAt ?? '') || 0;
    const weightChangedFiles = new Set(changedFiles);
    for (const [file, provenance] of Object.entries(normalized.provenance ?? {})) {
      if (provenance !== 'measured' || weightChangedFiles.has(file)) {
        continue;
      }
      const historyFileTs = Date.parse(history.fileChangedAt?.[file] ?? '') || 0;
      if (historyFileTs > updateTs) {
        continue;
      }
      const proposedSamples = normalized.recentSamples?.[file];
      if (!Array.isArray(proposedSamples) || proposedSamples.length === 0) {
        continue;
      }
      history.provenance[file] = 'measured';
      history.recentSamples[file] = [...proposedSamples];
    }

    const historyTs = Date.parse(history.dataChangedAt ?? '') || 0;
    if (updateTs > historyTs) {
      history.dataChangedAt = normalized.dataChangedAt;
    }
    if (normalized.source === MEASURED_SOURCE) {
      history.source = MEASURED_SOURCE;
    }
  }

  return history;
}

export function loadShardReportsFromDir(reportsDir, heavyShardCount) {
  const shardReports = new Map();
  for (let shard = 1; shard <= heavyShardCount; shard += 1) {
    const reportPath = join(reportsDir, `shard-${shard}.json`);
    const metaPath = join(reportsDir, `shard-${shard}.meta.json`);
    let meta = null;
    if (existsSync(metaPath)) {
      meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    }
    shardReports.set(shard, { reportPath, metaPath, meta });
  }
  return shardReports;
}

export function writeHistoryIfChanged(outputPath, result) {
  if (!result.changed) {
    return false;
  }
  writeFileSync(outputPath, result.outputBytes, 'utf8');
  return true;
}

export function emitCoverageSignal(coverage, logger = console) {
  if (coverage.shortfall) {
    logger.warn(`[WARN] ${coverage.message} (below ${(COVERAGE_SHORTFALL_THRESHOLD * 100).toFixed(0)}% measured threshold)`);
  } else {
    logger.log(`[INFO] ${coverage.message}`);
  }
}

export function runtimeHistoryPath(repoRoot = defaultRepoRoot) {
  return join(
    String(repoRoot ?? defaultRepoRoot).replace(/\\/g, '/').replace(/\/$/, ''),
    'scripts/vitest-runtime-history.json',
  );
}
