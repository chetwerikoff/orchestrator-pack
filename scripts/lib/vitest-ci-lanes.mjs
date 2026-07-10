#!/usr/bin/env node
/**
 * Vitest CI lane discovery, classification, and runtime-weighted heavy shard
 * assignment (Issue #556). Heavy shard count is derived from measured weight
 * (Issue #695).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHeavyTopology, parseTopologyPolicy, validateTopologyPolicy } from './vitest-heavy-topology.mjs';

const libDir = dirname(fileURLToPath(import.meta.url));
export const defaultRepoRoot = join(libDir, '..', '..');

export function resolveRepoRoot(repoRoot = defaultRepoRoot) {
  return repoRoot.replace(/\\/g, '/').replace(/\/$/, '');
}

export function lanesConfigPath(repoRoot = defaultRepoRoot) {
  return join(resolveRepoRoot(repoRoot), 'scripts/vitest-ci-lanes.config.json');
}

export function runtimeHistoryPath(repoRoot = defaultRepoRoot) {
  return join(resolveRepoRoot(repoRoot), 'scripts/vitest-runtime-history.json');
}

export function discoverVitestFiles(repoRoot = defaultRepoRoot) {
  const root = resolveRepoRoot(repoRoot);
  const files = [];

  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const absolute = join(dir, entry);
      const stats = statSync(absolute);
      if (stats.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.endsWith('.test.ts')) {
        continue;
      }
      const rel = relative(root, absolute).replace(/\\/g, '/');
      if (rel.startsWith('plugins/') || rel.startsWith('scripts/')) {
        files.push(rel);
      }
    }
  }

  walk(join(root, 'plugins'));
  walk(join(root, 'scripts'));

  const testsDir = join(root, 'tests');
  if (existsSync(testsDir)) {
    for (const entry of readdirSync(testsDir)) {
      if (!entry.startsWith('agents-md-') || !entry.endsWith('.test.ts')) {
        continue;
      }
      const rel = `tests/${entry}`.replace(/\\/g, '/');
      if (!files.includes(rel)) {
        files.push(rel);
      }
    }
  }

  return files.sort();
}

export function loadLanesConfig(repoRoot = defaultRepoRoot) {
  const path = lanesConfigPath(repoRoot);
  if (!existsSync(path)) {
    throw new Error(`missing lanes config: ${relative(resolveRepoRoot(repoRoot), path)}`);
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const lightMaxWorkers = Number(raw.lightMaxWorkers);
  const heavyDefaultRuntimeMs = Number(raw.heavyDefaultRuntimeMs);
  const topologyPolicy = parseTopologyPolicy(raw);
  const policyErrors = validateTopologyPolicy(topologyPolicy);
  const heavyForkPoolMinRuntimeMs = Number(raw.heavyForkPoolMinRuntimeMs ?? heavyDefaultRuntimeMs);
  if (!Number.isFinite(lightMaxWorkers) || lightMaxWorkers < 1 || lightMaxWorkers > 4) {
    throw new Error('vitest-ci-lanes.config.json lightMaxWorkers must be 1..4');
  }
  if (!Number.isFinite(heavyDefaultRuntimeMs) || heavyDefaultRuntimeMs <= 0) {
    throw new Error('vitest-ci-lanes.config.json heavyDefaultRuntimeMs must be positive');
  }
  if (policyErrors.length > 0) {
    throw new Error(policyErrors.join('; '));
  }
  if (!Number.isFinite(heavyForkPoolMinRuntimeMs) || heavyForkPoolMinRuntimeMs <= 0) {
    throw new Error('vitest-ci-lanes.config.json heavyForkPoolMinRuntimeMs must be positive');
  }
  const classification = raw.classification ?? {};
  const heavyPerTestIsolate = Array.isArray(raw.heavyPerTestIsolate)
    ? raw.heavyPerTestIsolate.map((entry) => String(entry).replace(/\\/g, '/'))
    : [];
  const parkedWallclockE2e =
    raw.parkedWallclockE2e && typeof raw.parkedWallclockE2e === 'object' && !Array.isArray(raw.parkedWallclockE2e)
      ? {
          trackingIssue: Number(raw.parkedWallclockE2e.trackingIssue),
          trackingNote: String(raw.parkedWallclockE2e.trackingNote ?? ''),
          files: Array.isArray(raw.parkedWallclockE2e.files)
            ? raw.parkedWallclockE2e.files.map((entry) => String(entry).replace(/\\/g, '/'))
            : [],
        }
      : { trackingIssue: 694, trackingNote: '', files: [] };
  return {
    lightMaxWorkers,
    heavyDefaultRuntimeMs,
    heavyTopology: topologyPolicy,
    heavyForkPoolMinRuntimeMs,
    heavyPerTestIsolate,
    classification,
    parkedWallclockE2e,
  };
}

export function loadRuntimeHistory(repoRoot = defaultRepoRoot) {
  const path = runtimeHistoryPath(repoRoot);
  if (!existsSync(path)) {
    throw new Error(
      'missing runtime history: scripts/vitest-runtime-history.json (post-#691 harvest artifact required; fail-closed)',
    );
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return raw.files ?? {};
}

export function resolveHeavyLaneFingerprint(repoRoot = defaultRepoRoot) {
  const configPath = join(resolveRepoRoot(repoRoot), 'vitest.config.ts');
  if (!existsSync(configPath)) {
    throw new Error('missing vitest.config.ts for heavy-lane fingerprint derivation');
  }
  const text = readFileSync(configPath, 'utf8');
  if (!/VITEST_CI_LIGHT_LANE/.test(text)) {
    throw new Error('vitest.config.ts missing VITEST_CI_LIGHT_LANE gate for fingerprint derivation');
  }
  const matches = [
    ...text.matchAll(/fileParallelism:\s*(true|false)\s*,\s*\n\s*maxWorkers:\s*([^,\n]+)/g),
  ];
  const heavy = matches.find((match) => match[1] === 'false');
  if (!heavy) {
    throw new Error('vitest.config.ts missing heavy-lane fileParallelism:false branch');
  }
  const maxWorkersRaw = heavy[2].trim();
  if (!/^\d+$/.test(maxWorkersRaw)) {
    throw new Error(
      `vitest.config.ts heavy-lane maxWorkers must be a literal for fingerprinting, got ${maxWorkersRaw}`,
    );
  }
  return `CI=true maxWorkers=${maxWorkersRaw} fileParallelism=false`;
}

export function validateClassification(discoveredFiles, classification) {
  const errors = [];
  const classified = new Set(Object.keys(classification));

  for (const file of discoveredFiles) {
    const lane = classification[file];
    if (!lane) {
      errors.push(`classification-required: ${file} (new, renamed, or unclassified)`);
      continue;
    }
    if (lane !== 'light' && lane !== 'heavy' && lane !== 'parked') {
      errors.push(`invalid lane for ${file}: ${lane}`);
    }
  }

  for (const file of classified) {
    if (!discoveredFiles.includes(file)) {
      errors.push(`stale classification entry (file missing from discovery): ${file}`);
    }
  }

  return errors;
}

export function partitionByLane(discoveredFiles, classification) {
  const light = [];
  const heavy = [];
  const parked = [];
  for (const file of discoveredFiles) {
    const lane = classification[file];
    if (lane === 'light') {
      light.push(file);
    } else if (lane === 'heavy') {
      heavy.push(file);
    } else if (lane === 'parked') {
      parked.push(file);
    }
  }
  return { light, heavy, parked };
}

export function validateParkedWallclockE2e(classification, parkedWallclockE2e) {
  const errors = [];
  const trackingIssue = Number(parkedWallclockE2e?.trackingIssue);
  if (!Number.isFinite(trackingIssue) || trackingIssue !== 694) {
    errors.push('parkedWallclockE2e.trackingIssue must be 694');
  }
  const trackingNote = String(parkedWallclockE2e?.trackingNote ?? '').trim();
  if (!trackingNote.includes('239-ci-vitest-wallclock-e2e-separate-stage')) {
    errors.push('parkedWallclockE2e.trackingNote must reference #694 wall-clock stage draft');
  }
  const parkedFiles = new Set(parkedWallclockE2e?.files ?? []);
  for (const file of parkedFiles) {
    if (classification[file] !== 'parked') {
      errors.push(`parkedWallclockE2e file must be classified parked: ${file}`);
    }
  }
  for (const [file, lane] of Object.entries(classification)) {
    if (lane === 'parked' && !parkedFiles.has(file)) {
      errors.push(`classified parked file missing from parkedWallclockE2e.files: ${file}`);
    }
  }
  return errors;
}

export function resolveHeavyRuntimeMs(file, runtimeHistory, defaultRuntimeMs) {
  const value = runtimeHistory[file];
  if (Number.isFinite(Number(value)) && Number(value) > 0) {
    return Number(value);
  }
  return defaultRuntimeMs;
}


/**
 * Long subprocess suites may exceed Vitest birpc's 60s onTaskUpdate ceiling per test.
 * forks keeps the parent responsive; threads is cheaper for shorter files.
 */
export function resolveHeavyFilePool(file, runtimeHistory, defaultRuntimeMs, forkPoolMinRuntimeMs) {
  const historyValue = runtimeHistory[file];
  const forkThreshold = Number(forkPoolMinRuntimeMs ?? defaultRuntimeMs);
  if (Number.isFinite(Number(historyValue)) && Number(historyValue) >= forkThreshold) {
    return 'forks';
  }
  return 'threads';
}

/**
 * @param {string} filePath absolute or repo-relative test file path
 */
export function enumerateVitestFileTestTitles(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const titles = [];
  const pattern = /\bit(?:\.(?:only|skip|todo|fails))?\(\s*(['"`])([\s\S]*?)\1/g;
  for (const match of text.matchAll(pattern)) {
    const title = match[2].replace(/\s+/g, ' ').trim();
    if (title) {
      titles.push(title);
    }
  }
  return titles;
}

/**
 * @param {string} file repo-relative vitest file
 * @param {ReturnType<typeof loadLanesConfig>} config
 * @param {Record<string, number>} runtimeHistory
 * @param {string} repoRoot
 */
export function resolveHeavyFileRunPlan(file, config, runtimeHistory, repoRoot) {
  const pool = resolveHeavyFilePool(
    file,
    runtimeHistory,
    config.heavyDefaultRuntimeMs,
    config.heavyForkPoolMinRuntimeMs,
  );
  if (config.heavyPerTestIsolate.includes(file)) {
    const absolute = join(resolveRepoRoot(repoRoot), file);
    return {
      mode: 'tests',
      pool,
      tests: enumerateVitestFileTestTitles(absolute),
    };
  }
  return { mode: 'file', pool };
}

/**
 * Greedy LPT (longest-processing-time) bin packing for runtime-weighted shards.
 */
export function assignHeavyShards(heavyFiles, runtimeHistory, shardCount, defaultRuntimeMs) {
  const weighted = heavyFiles.map((file) => ({
    file,
    runtimeMs: resolveHeavyRuntimeMs(file, runtimeHistory, defaultRuntimeMs),
  }));
  weighted.sort((a, b) => b.runtimeMs - a.runtimeMs || a.file.localeCompare(b.file));

  const shards = Array.from({ length: shardCount }, (_, index) => ({
    shard: index + 1,
    files: [],
    totalRuntimeMs: 0,
  }));

  for (const entry of weighted) {
    shards.sort((a, b) => a.totalRuntimeMs - b.totalRuntimeMs || a.shard - b.shard);
    const target = shards[0];
    target.files.push(entry.file);
    target.totalRuntimeMs += entry.runtimeMs;
  }

  for (const shard of shards) {
    shard.files.sort();
  }

  return shards;
}

export function buildLanePlan(repoRoot = defaultRepoRoot, options = {}) {
  const topologyResult = buildHeavyTopology(repoRoot, options);
  if (!topologyResult.ok) {
    return {
      ok: false,
      errors: topologyResult.errors,
      discovered: topologyResult.discovered ?? [],
      config: topologyResult.lanesConfig,
    };
  }

  const { topology, discovered, light, heavy, parked, runtimeHistory, lanesConfig } = topologyResult;
  const heavyShards = assignHeavyShards(
    heavy,
    runtimeHistory,
    topology.heavyShardCount,
    lanesConfig.heavyDefaultRuntimeMs,
  );

  return {
    ok: true,
    discovered,
    config: lanesConfig,
    light,
    heavy,
    parked,
    heavyShards,
    runtimeHistory,
    topology,
  };
}

export const workerRpcPatterns = [
  /onTaskUpdate.*(?:RPC|timeout)/i,
  /vitest-worker.*onTaskUpdate/i,
  /STACK_TRACE_ERROR/i,
  /RPC timeout/i,
];

export function scanWorkerRpcSignatures(text) {
  return workerRpcPatterns.filter((pattern) => pattern.test(text));
}
