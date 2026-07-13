#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { topologyArtifactPath } from './lib/vitest-heavy-topology.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.OPK_REPO_ROOT?.replace(/\\/g, '/') || join(scriptDir, '..');
const files = [
  'scripts/orchestrator-wake-supervisor-startup.test.ts',
  'scripts/orchestrator-wake-supervisor-lifecycle.test.ts',
  'scripts/orchestrator-wake-supervisor-side-process-registry.test.ts',
  'scripts/orchestrator-wake-supervisor-empty-pid.test.ts',
];

function runFile(file) {
  const child = spawnSync(
    'timeout',
    ['--kill-after=5s', '75s', 'npm', 'test', '--', file, '--reporter=default'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 90_000,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        CI: 'true',
        OPK_TESTMODE_FLEET_WORKSPACE_ROOT: repoRoot,
      },
    },
  );
  const output = `${child.stdout ?? ''}\n${child.stderr ?? ''}`.trim();
  return {
    file,
    status: child.status,
    signal: child.signal,
    error: child.error?.message ?? null,
    output,
  };
}

const results = files.map(runFile);
const artifact = {
  heavyShardCount: 1,
  heavyShardMatrix: [1],
  fallbackClassification: 'supervisor-suite-isolated-diagnostic',
  discovered: files,
  fullDiscovered: files,
  heavyFiles: [],
  lightFiles: [],
  postMergeWallclockFiles: files,
  parkedFiles: [],
  heavyShards: [{ shard: 1, files: [], totalRuntimeMs: 0 }],
  supervisorSuiteDiagnostics: results,
};
writeFileSync(topologyArtifactPath(repoRoot), `${JSON.stringify(artifact, null, 2)}\n`);
if (process.argv.includes('--gha-output')) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error('GITHUB_OUTPUT is not set');
  appendFileSync(outputPath, 'heavy_shard_count=1\n');
  appendFileSync(outputPath, 'heavy_shard_matrix=[1]\n');
  appendFileSync(outputPath, 'fallback_classification=supervisor-suite-isolated-diagnostic\n');
}
console.log(JSON.stringify({ ...artifact, supervisorSuiteDiagnostics: results.map(({ file, status, signal, error, output }) => ({ file, status, signal, error, output: `${output.split(/\r?\n/).length} lines captured in artifact` })) }));
