#!/usr/bin/env node
/**
 * Emit canonical heavy Vitest topology artifact and optional GitHub Actions outputs
 * (Issue #695).
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatOversizedGuardFailures,
  topologyArtifactPath,
} from './lib/vitest-heavy-topology.mjs';
import { buildLanePlan } from './lib/vitest-ci-lanes.mjs';
import {
  measurePreTopologyFiles,
  resolvePreTopologyMeasurementTargets,
  shouldMeasurePreTopology,
} from './lib/vitest-pre-topology-measurement.mjs';
import {
  normalizePrScopeMode,
  parseChangedPathManifestFromEnv,
} from './lib/vitest-pr-scoped-selection.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = join(scriptDir, '..');

function parseArgs(argv) {
  const flags = new Set(argv.slice(2));
  return {
    ghaOutput: flags.has('--gha-output'),
    failOnGuard: !flags.has('--skip-oversized-guard'),
    repoRoot: process.env.OPK_REPO_ROOT?.replace(/\\/g, '/') || defaultRepoRoot,
  };
}

function writeGhaOutput(topology) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    throw new Error('GITHUB_OUTPUT is not set');
  }
  appendFileSync(outputPath, `heavy_shard_count=${topology.heavyShardCount}\n`);
  appendFileSync(outputPath, `heavy_shard_matrix=${JSON.stringify(topology.heavyShardMatrix)}\n`);
  appendFileSync(
    outputPath,
    `fallback_classification=${topology.fallbackClassification}\n`,
  );
}

const { ghaOutput, failOnGuard, repoRoot } = parseArgs(process.argv);
const rawManifest = parseChangedPathManifestFromEnv();
const changedPathManifest = rawManifest
  ? {
      ...rawManifest,
      entries: (rawManifest.entries ?? []).filter((entry) => entry.status !== 'D'),
      entryCount: (rawManifest.entries ?? []).filter((entry) => entry.status !== 'D').length,
    }
  : null;
const changedFiles = (changedPathManifest?.entries ?? [])
  .map((entry) => entry.path)
  .filter((path) => path.endsWith('.test.ts'));
const laneOptions = {
  changedFiles,
  changedPathManifest,
  prScopeMode: normalizePrScopeMode(),
};

let result = buildLanePlan(repoRoot, laneOptions);
let diagnostic = null;
if (result.ok && shouldMeasurePreTopology(repoRoot, laneOptions)) {
  const targets = resolvePreTopologyMeasurementTargets(result, laneOptions);
  if (targets.length > 0) {
    try {
      const measurements = await measurePreTopologyFiles(repoRoot, targets, laneOptions);
      result = buildLanePlan(repoRoot, { ...laneOptions, preTopologyMeasurements: measurements });
    } catch (error) {
      diagnostic = {
        targets,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : null,
      };
    }
  }
}

if (diagnostic) {
  const artifact = {
    heavyShardCount: 1,
    heavyShardMatrix: [1],
    fallbackClassification: 'pre-topology-measurement-failed',
    discovered: [],
    fullDiscovered: [],
    heavyFiles: [],
    lightFiles: [],
    postMergeWallclockFiles: [],
    parkedFiles: [],
    heavyShards: [{ shard: 1, files: [], totalRuntimeMs: 0 }],
    measurementDiagnostic: diagnostic,
  };
  writeFileSync(topologyArtifactPath(repoRoot), `${JSON.stringify(artifact, null, 2)}\n`);
  console.error(JSON.stringify(artifact));
  process.exit(1);
}

if (!result.ok) {
  console.error(result.errors.join('\n'));
  process.exit(1);
}

const guardFailures = formatOversizedGuardFailures(result);
if (failOnGuard && guardFailures.length > 0) {
  console.error(guardFailures.join('\n'));
  process.exit(1);
}

const artifact = {
  ...result.topology,
  discovered: result.discovered,
  fullDiscovered: result.fullDiscovered ?? result.discovered,
  heavyFiles: result.heavy,
  lightFiles: result.light,
  postMergeWallclockFiles: result.postMergeWallclock,
  parkedFiles: result.parked,
  heavyShards: result.heavyShards,
};
writeFileSync(topologyArtifactPath(repoRoot), `${JSON.stringify(artifact, null, 2)}\n`);

if (result.topology.underProvisioned) {
  console.warn(
    `[WARN] heavy shard topology under-provisioned: raw derived count ${result.topology.rawDerivedCount} exceeds maxShardCount ${result.topology.policy.maxShardCount}; clamped to ${result.topology.heavyShardCount}`,
  );
}
if (result.topology.fallbackClassification === 'fixed-fallback') {
  console.warn(
    `[WARN] heavy shard topology using fixed fallback count ${result.topology.heavyShardCount} (${result.topology.weightInputReason})`,
  );
}

if (ghaOutput) {
  writeGhaOutput(result.topology);
}
console.log(JSON.stringify(artifact));
