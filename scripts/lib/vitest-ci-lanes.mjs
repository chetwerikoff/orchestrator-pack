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
  if (!Number.isFinite(lightMaxWorkers) || lightMaxWorkers < 1 || lightMaxWorkers > 4) {
    throw new Error('vitest-ci-lanes.config.json lightMaxWorkers must be 1..4');
  }
  if (!Number.isFinite(heavyDefaultRuntimeMs) || heavyDefaultRuntimeMs <= 0) {
    throw new Error('vitest-ci-lanes.config.json heavyDefaultRuntimeMs must be positive');
  }
  if (policyErrors.length > 0) {
    throw new Error(policyErrors.join('; '));
  }
  const classification = raw.classification ?? {};
  return {
    lightMaxWorkers,
    heavyDefaultRuntimeMs,
    heavyTopology: topologyPolicy,
    classification,
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

export function validateClassification(discoveredFiles, classification) {
  const errors = [];
  const classified = new Set(Object.keys(classification));

  for (const file of discoveredFiles) {
    const lane = classification[file];
    if (!lane) {
      errors.push(`classification-required: ${file} (new, renamed, or unclassified)`);
      continue;
    }
    if (lane !== 'light' && lane !== 'heavy') {
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
  for (const file of discoveredFiles) {
    const lane = classification[file];
    if (lane === 'light') {
      light.push(file);
    } else if (lane === 'heavy') {
      heavy.push(file);
    }
  }
  return { light, heavy };
}

export function resolveHeavyRuntimeMs(file, runtimeHistory, defaultRuntimeMs) {
  const value = runtimeHistory[file];
  if (Number.isFinite(Number(value)) && Number(value) > 0) {
    return Number(value);
  }
  return defaultRuntimeMs;
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

  const { topology, discovered, light, heavy, runtimeHistory, lanesConfig } = topologyResult;
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
