#!/usr/bin/env node
/**
 * Temporary issue #752 diagnostic: preserve the bounded pre-topology failure in
 * the existing topology artifact. This file is restored after the artifact is read.
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
const flags = new Set(process.argv.slice(2));
const ghaOutput = flags.has('--gha-output');
const failOnGuard = !flags.has('--skip-oversized-guard');
const repoRoot = process.env.OPK_REPO_ROOT?.replace(/\\/g, '/') || defaultRepoRoot;
const changedPathManifest = parseChangedPathManifestFromEnv();
const changedFiles = (changedPathManifest?.entries ?? [])
  .map((entry) => entry.path)
  .filter((path) => path.endsWith('.test.ts'));
const laneOptions = {
  changedFiles,
  changedPathManifest,
  prScopeMode: normalizePrScopeMode(),
};

function writeGhaOutput(topology) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error('GITHUB_OUTPUT is not set');
  appendFileSync(outputPath, `heavy_shard_count=${topology.heavyShardCount}\n`);
  appendFileSync(outputPath, `heavy_shard_matrix=${JSON.stringify(topology.heavyShardMatrix)}\n`);
  appendFileSync(outputPath, `fallback_classification=${topology.fallbackClassification}\n`);
}

let result = buildLanePlan(repoRoot, laneOptions);
if (result.ok && shouldMeasurePreTopology(repoRoot, laneOptions)) {
  const targets = resolvePreTopologyMeasurementTargets(result, laneOptions);
  if (targets.length > 0) {
    try {
      const preTopologyMeasurements = measurePreTopologyFiles(repoRoot, targets, laneOptions);
      result = buildLanePlan(repoRoot, { ...laneOptions, preTopologyMeasurements });
    } catch (error) {
      const diagnostic = {
        issue: 752,
        stage: 'pre-topology-measurement',
        targets,
        error: error instanceof Error ? error.stack : String(error),
        initialTopology: result.topology,
      };
      writeFileSync(topologyArtifactPath(repoRoot), `${JSON.stringify(diagnostic, null, 2)}\n`);
      if (ghaOutput) {
        writeGhaOutput({
          heavyShardCount: 1,
          heavyShardMatrix: [1],
          fallbackClassification: 'issue-752-diagnostic',
        });
      }
      console.error(diagnostic.error);
      process.exit(0);
    }
  }
}

if (!result.ok) {
  console.error(result.errors.join('\n'));
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
const guardFailures = formatOversizedGuardFailures(result);
if (failOnGuard && guardFailures.length > 0) {
  console.error(guardFailures.join('\n'));
  process.exit(1);
}
if (ghaOutput) writeGhaOutput(result.topology);
console.log(JSON.stringify(artifact));
