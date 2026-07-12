#!/usr/bin/env node
/**
 * Emit canonical heavy Vitest topology artifact and optional GitHub Actions outputs
 * (Issue #695).
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
  if (!outputPath) throw new Error('GITHUB_OUTPUT is not set');
  appendFileSync(outputPath, `heavy_shard_count=${topology.heavyShardCount}\n`);
  appendFileSync(outputPath, `heavy_shard_matrix=${JSON.stringify(topology.heavyShardMatrix)}\n`);
  appendFileSync(outputPath, `fallback_classification=${topology.fallbackClassification}\n`);
}

function runVerifyDiagnostic(repoRoot) {
  if (process.env.CI !== 'true' || process.env.OPK_SKIP_VERIFY_DIAGNOSTIC === '1') {
    return null;
  }
  const child = spawnSync(
    'pwsh',
    ['-NoProfile', '-File', join(repoRoot, 'scripts', 'verify.ps1')],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 240_000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        OPK_DISABLE_PRE_TOPOLOGY_MEASUREMENT: '1',
        OPK_SKIP_VERIFY_DIAGNOSTIC: '1',
      },
    },
  );
  const combined = `${child.stdout ?? ''}\n${child.stderr ?? ''}`
    .split(/\r?\n/)
    .filter(Boolean);
  return {
    status: child.status,
    signal: child.signal,
    error: child.error?.message ?? null,
    tail: combined.slice(-140),
  };
}

const { ghaOutput, failOnGuard, repoRoot } = parseArgs(process.argv);
const changedPathManifest = parseChangedPathManifestFromEnv();
const changedFiles = (changedPathManifest?.entries ?? [])
  .map((entry) => entry.path)
  .filter((path) => path.endsWith('.test.ts'));
const laneOptions = {
  changedFiles,
  changedPathManifest,
  prScopeMode: normalizePrScopeMode(),
};

let result = buildLanePlan(repoRoot, laneOptions);
if (result.ok && shouldMeasurePreTopology(repoRoot, laneOptions)) {
  const targets = resolvePreTopologyMeasurementTargets(result, laneOptions);
  if (targets.length > 0) {
    const preTopologyMeasurements = measurePreTopologyFiles(repoRoot, targets, laneOptions);
    result = buildLanePlan(repoRoot, { ...laneOptions, preTopologyMeasurements });
  }
}

if (!result.ok) {
  console.error(result.errors.join('\n'));
  process.exit(1);
}

const artifactPath = topologyArtifactPath(repoRoot);
const artifact = {
  ...result.topology,
  discovered: result.discovered,
  fullDiscovered: result.fullDiscovered ?? result.discovered,
  heavyFiles: result.heavy,
  lightFiles: result.light,
  postMergeWallclockFiles: result.postMergeWallclock,
  parkedFiles: result.parked,
  heavyShards: result.heavyShards,
  verifyDiagnostic: runVerifyDiagnostic(repoRoot),
};
writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

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

const guardFailures = formatOversizedGuardFailures(result);
if (failOnGuard && guardFailures.length > 0) {
  console.error(guardFailures.join('\n'));
  process.exit(1);
}
if (ghaOutput) writeGhaOutput(result.topology);
console.log(JSON.stringify(artifact));
