#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { topologyArtifactPath } from './lib/vitest-heavy-topology.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.OPK_REPO_ROOT?.replace(/\\/g, '/') || join(scriptDir, '..');
const child = spawnSync(
  'node',
  ['docs/orchestrator-message-registry.mjs', 'generate-map', repoRoot],
  {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  },
);
const artifact = {
  heavyShardCount: 1,
  heavyShardMatrix: [1],
  fallbackClassification: 'pr768-message-map-generation',
  discovered: [],
  fullDiscovered: [],
  heavyFiles: [],
  lightFiles: [],
  postMergeWallclockFiles: [],
  parkedFiles: [],
  heavyShards: [{ shard: 1, files: [], totalRuntimeMs: 0 }],
  messageMapGeneration: {
    status: child.status,
    signal: child.signal,
    error: child.error?.message ?? null,
    generatedMap: child.stdout ?? '',
    stderr: child.stderr ?? '',
  },
};
writeFileSync(topologyArtifactPath(repoRoot), `${JSON.stringify(artifact, null, 2)}\n`);
if (process.argv.includes('--gha-output')) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error('GITHUB_OUTPUT is not set');
  appendFileSync(outputPath, 'heavy_shard_count=1\n');
  appendFileSync(outputPath, 'heavy_shard_matrix=[1]\n');
  appendFileSync(outputPath, 'fallback_classification=pr768-message-map-generation\n');
}
console.log(JSON.stringify({ ...artifact, messageMapGeneration: { ...artifact.messageMapGeneration, generatedMap: `${(child.stdout ?? '').length} characters captured in artifact` } }));
