#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { topologyArtifactPath } from './lib/vitest-heavy-topology.mjs';
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
const repoRoot = process.env.OPK_REPO_ROOT?.replace(/\\/g, '/') || join(scriptDir, '..');
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

const artifact = diagnostic
  ? {
      heavyShardCount: 1,
      heavyShardMatrix: [1],
      fallbackClassification: 'pr768-measurement-diagnostic-2',
      discovered: [],
      fullDiscovered: [],
      heavyFiles: [],
      lightFiles: [],
      postMergeWallclockFiles: [],
      parkedFiles: [],
      heavyShards: [{ shard: 1, files: [], totalRuntimeMs: 0 }],
      measurementDiagnostic: diagnostic,
    }
  : {
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
if (process.argv.includes('--gha-output')) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error('GITHUB_OUTPUT is not set');
  appendFileSync(output, `heavy_shard_count=${artifact.heavyShardCount}\n`);
  appendFileSync(output, `heavy_shard_matrix=${JSON.stringify(artifact.heavyShardMatrix)}\n`);
  appendFileSync(output, `fallback_classification=${artifact.fallbackClassification}\n`);
}
console.log(JSON.stringify(artifact));
