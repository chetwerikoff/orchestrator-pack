#!/usr/bin/env node
/**
 * Runtime-history refresh producer: provenance-gated merge with smoothing (Issue #691).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadLanesConfig,
  partitionByLane,
  discoverVitestFiles,
} from './vitest-ci-lanes.mjs';
import { parseVitestReportFile } from './vitest-json-report.mjs';

const libDir = dirname(fileURLToPath(import.meta.url));
export const defaultRepoRoot = join(libDir, '..', '..');

export const SMOOTHING_RULE = 'median-of-last-5-samples';
export const MAX_RECENT_SAMPLES = 5;
export const MEASURED_SOURCE = 'ci-measured';
export const SEEDED_SOURCE = 'ci-baseline-estimates';
export const COVERAGE_SHORTFALL_THRESHOLD = 0.5;

const PROVENANCE_VALUES = new Set(['measured', 'seeded', 'fallback']);

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

  for (const [file, ms] of Object.entries(history.files)) {
    if (!history.provenance[file]) {
      history.provenance[file] =
        history.source === MEASURED_SOURCE ? 'measured' : 'seeded';
    }
  }

  return history;
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
  return {
    heavy: [...heavy].sort(),
    classification: config.classification,
    heavyShardCount: config.heavyShardCount,
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

  const missingHeavy = heavy.filter((file) => !durations.has(file));
  if (missingHeavy.length > 0) {
    const preview = missingHeavy.slice(0, 5).join(', ');
    const suffix =
      missingHeavy.length > 5 ? `, ... (+${missingHeavy.length - 5} more)` : '';
    errors.push(
      `incomplete heavy-file coverage in shard reports: missing ${missingHeavy.length} classified heavy file(s): ${preview}${suffix}`,
    );
    return { ok: false, errors, durations: new Map(), heavy };
  }

  return { ok: true, errors: [], durations, heavy };
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

  for (const [file, durationMs] of durations) {
    const priorSamples = Array.isArray(history.recentSamples[file])
      ? history.recentSamples[file]
      : [];
    const samples = [...priorSamples, durationMs].slice(-MAX_RECENT_SAMPLES);
    const smoothed = medianMs(samples);
    if (smoothed == null) {
      continue;
    }

    const previousWeight = history.files[file];
    history.recentSamples[file] = samples;
    history.provenance[file] = 'measured';

    if (previousWeight !== smoothed) {
      history.files[file] = smoothed;
      history.fileChangedAt[file] = new Date().toISOString();
      anyWeightChanged = true;
    }
  }

  if (anyWeightChanged) {
    history.source = MEASURED_SOURCE;
    history.dataChangedAt = new Date().toISOString();
  }

  history.smoothingRule = SMOOTHING_RULE;

  for (const file of heavyFiles) {
    if (!history.provenance[file]) {
      if (history.files[file] != null) {
        history.provenance[file] = history.source === MEASURED_SOURCE ? 'measured' : 'seeded';
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
  expectedCommitSha,
  repoRoot = defaultRepoRoot,
}) {
  const normalizedBase = normalizeHistory(baseHistory);
  const baseBytes = historyBytes(normalizedBase);
  const validation = validateReportSet(shardReports, expectedCommitSha, repoRoot);

  if (!validation.ok) {
    return {
      ok: false,
      changed: false,
      idempotent: true,
      history: normalizedBase,
      baseBytes,
      outputBytes: baseBytes,
      errors: validation.errors,
      coverage: computeCoverageSignal(normalizedBase, validation.heavy),
      rejected: true,
    };
  }

  const merged = mergeValidatedDurations(normalizedBase, validation.durations, validation.heavy);
  return {
    ok: true,
    changed: merged.changed,
    idempotent: merged.idempotent,
    history: merged.history,
    baseBytes,
    outputBytes: historyBytes(merged.history),
    errors: [],
    coverage: merged.coverage,
    rejected: false,
  };
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
