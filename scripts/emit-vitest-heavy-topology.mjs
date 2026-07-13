#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { topologyArtifactPath } from './lib/vitest-heavy-topology.mjs';
import { buildLanePlan } from './lib/vitest-ci-lanes.mjs';
import { resolvePreTopologyMeasurementTargets } from './lib/vitest-pre-topology-measurement.mjs';
import {
  normalizePrScopeMode,
  parseChangedPathManifestFromEnv,
} from './lib/vitest-pr-scoped-selection.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.OPK_REPO_ROOT?.replace(/\\/g, '/') || join(scriptDir, '..');
const rawChangedPathManifest = parseChangedPathManifestFromEnv();
const changedPathManifest = rawChangedPathManifest
  ? {
      ...rawChangedPathManifest,
      entries: (rawChangedPathManifest.entries ?? []).filter((entry) => entry.status !== 'D'),
      entryCount: (rawChangedPathManifest.entries ?? []).filter((entry) => entry.status !== 'D').length,
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

const result = buildLanePlan(repoRoot, laneOptions);
let targets = [];
let targetError = null;
if (result.ok) {
  try {
    targets = resolvePreTopologyMeasurementTargets(result, laneOptions);
  } catch (error) {
    targetError = error instanceof Error ? error.message : String(error);
  }
}
const diagnostic = {
  initialPlanOk: result.ok,
  initialPlanErrors: result.ok ? [] : result.errors,
  changedFiles,
  changedEntries: changedPathManifest?.entries ?? [],
  unresolvedGuardWeights: result.ok ? result.topology.unresolvedGuardWeights : [],
  targets,
  targetError,
};
const artifact = {
  heavyShardCount: 1,
  heavyShardMatrix: [1],
  fallbackClassification: 'pr768-topology-target-diagnostic',
  discovered: [],
  fullDiscovered: [],
  heavyFiles: [],
  lightFiles: [],
  postMergeWallclockFiles: [],
  parkedFiles: [],
  heavyShards: [{ shard: 1, files: [], totalRuntimeMs: 0 }],
  topologyTargetDiagnostic: diagnostic,
};
writeFileSync(topologyArtifactPath(repoRoot), `${JSON.stringify(artifact, null, 2)}\n`);
if (process.argv.includes('--gha-output')) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error('GITHUB_OUTPUT is not set');
  appendFileSync(outputPath, 'heavy_shard_count=1\n');
  appendFileSync(outputPath, 'heavy_shard_matrix=[1]\n');
  appendFileSync(outputPath, 'fallback_classification=pr768-topology-target-diagnostic\n');
}
console.log(JSON.stringify(artifact));
