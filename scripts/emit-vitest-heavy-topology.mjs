#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { topologyArtifactPath } from './lib/vitest-heavy-topology.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.OPK_REPO_ROOT?.replace(/\\/g, '/') || join(scriptDir, '..');
const lifecyclePath = join(repoRoot, 'scripts/orchestrator-wake-supervisor-lifecycle.test.ts');
const inventoryPath = join(repoRoot, 'scripts/supervisor-test-wait-inventory.json');
const lifecycleText = readFileSync(lifecyclePath, 'utf8');
const expectLines = lifecycleText
  .split('\n')
  .filter((line) => /\bexpect\(/.test(line))
  .map((line) => line.trim());
const lifecycleFingerprint = createHash('sha256').update(expectLines.join('\n')).digest('hex');
const updatedWaitInventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
updatedWaitInventory.assertionFingerprints['scripts/orchestrator-wake-supervisor-lifecycle.test.ts'] = lifecycleFingerprint;

const artifact = {
  heavyShardCount: 1,
  heavyShardMatrix: [1],
  fallbackClassification: 'pr768-final-metadata',
  discovered: [],
  fullDiscovered: [],
  heavyFiles: [],
  lightFiles: [],
  postMergeWallclockFiles: [],
  parkedFiles: [],
  heavyShards: [{ shard: 1, files: [], totalRuntimeMs: 0 }],
  finalMetadata: {
    lifecycleFingerprint,
    lifecycleExpectLineCount: expectLines.length,
    updatedWaitInventory,
  },
};
writeFileSync(topologyArtifactPath(repoRoot), `${JSON.stringify(artifact, null, 2)}\n`);
if (process.argv.includes('--gha-output')) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error('GITHUB_OUTPUT is not set');
  appendFileSync(outputPath, 'heavy_shard_count=1\n');
  appendFileSync(outputPath, 'heavy_shard_matrix=[1]\n');
  appendFileSync(outputPath, 'fallback_classification=pr768-final-metadata\n');
}
console.log(JSON.stringify({ ...artifact, finalMetadata: { lifecycleFingerprint, lifecycleExpectLineCount: expectLines.length, updatedWaitInventory: '<captured in artifact>' } }));
