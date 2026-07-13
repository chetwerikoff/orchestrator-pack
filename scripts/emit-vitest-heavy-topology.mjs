#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { topologyArtifactPath } from './lib/vitest-heavy-topology.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.OPK_REPO_ROOT?.replace(/\\/g, '/') || join(scriptDir, '..');

function commandDiagnostic(command, args, timeout) {
  const child = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, OPK_DISABLE_PRE_TOPOLOGY_MEASUREMENT: '1' },
  });
  const lines = `${child.stdout ?? ''}\n${child.stderr ?? ''}`
    .split(/\r?\n/)
    .filter(Boolean);
  return {
    command: [command, ...args].join(' '),
    status: child.status,
    signal: child.signal,
    error: child.error?.message ?? null,
    tail: lines.slice(-240),
  };
}

const configPath = join(repoRoot, 'scripts', 'vitest-ci-lanes.config.json');
const cleanVitestConfig = JSON.parse(readFileSync(configPath, 'utf8'));
delete cleanVitestConfig.classification['scripts/orchestrator-wake-listener-evaluate.test.ts'];

const artifact = {
  heavyShardCount: 1,
  heavyShardMatrix: [1],
  fallbackClassification: 'pr768-diagnostic',
  discovered: [],
  fullDiscovered: [],
  heavyFiles: [],
  lightFiles: [],
  postMergeWallclockFiles: [],
  parkedFiles: [],
  heavyShards: [{ shard: 1, files: [], totalRuntimeMs: 0 }],
  pr768Diagnostic: process.env.CI === 'true'
    ? {
        cleanVitestConfig,
        typecheck: commandDiagnostic('npx', ['tsc', '--project', 'tsconfig.base.json', '--noEmit'], 180_000),
        waitInventory: commandDiagnostic('node', ['scripts/lib/supervisor-test-wait-inventory.mjs', 'production'], 90_000),
        lightLane: commandDiagnostic('pwsh', ['-NoProfile', '-File', 'scripts/run-vitest-light-lane.ps1'], 300_000),
      }
    : { cleanVitestConfig },
};

writeFileSync(topologyArtifactPath(repoRoot), `${JSON.stringify(artifact, null, 2)}\n`);
if (process.argv.includes('--gha-output')) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error('GITHUB_OUTPUT is not set');
  appendFileSync(outputPath, 'heavy_shard_count=1\n');
  appendFileSync(outputPath, 'heavy_shard_matrix=[1]\n');
  appendFileSync(outputPath, 'fallback_classification=pr768-diagnostic\n');
}
console.log(JSON.stringify(artifact));
