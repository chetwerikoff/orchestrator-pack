#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { topologyArtifactPath } from './lib/vitest-heavy-topology.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.OPK_REPO_ROOT?.replace(/\\/g, '/') || join(scriptDir, '..');
const captureBindingSha = 'b30af5b7e716c5d93ab8db81cb8a8ae65f7688b2';
const filePlans = [
  { file: 'scripts/orchestrator-wake-supervisor-startup.test.ts', timeoutSeconds: 140 },
  { file: 'scripts/orchestrator-wake-supervisor-lifecycle.test.ts', timeoutSeconds: 200 },
  { file: 'scripts/orchestrator-wake-supervisor-side-process-registry.test.ts', timeoutSeconds: 70 },
  { file: 'scripts/orchestrator-wake-supervisor-empty-pid.test.ts', timeoutSeconds: 70 },
];
const files = filePlans.map((entry) => entry.file);

function runFile({ file, timeoutSeconds }) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const child = spawnSync(
    'timeout',
    ['--kill-after=10s', `${timeoutSeconds}s`, 'npm', 'test', '--', file, '--reporter=default'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: (timeoutSeconds + 15) * 1000,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        CI: 'true',
        OPK_TESTMODE_FLEET_WORKSPACE_ROOT: repoRoot,
      },
    },
  );
  return {
    file,
    timeoutSeconds,
    startedAt,
    completedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    status: child.status,
    signal: child.signal,
    error: child.error?.message ?? null,
    output: `${child.stdout ?? ''}\n${child.stderr ?? ''}`.trim(),
  };
}

const startedAt = new Date().toISOString();
const started = Date.now();
const runs = filePlans.map(runFile);
const output = runs
  .map((run) => `===== ${run.file} status=${run.status} =====\n${run.output}`)
  .join('\n');
const pass = {
  id: 'pass-003',
  startedAt,
  completedAt: new Date().toISOString(),
  elapsedMs: Date.now() - started,
  status: runs.every((run) => run.status === 0) ? 0 : 1,
  signal: null,
  error: runs.find((run) => run.error)?.error ?? null,
  command: `CI=true serial per-file npm test -- ${files.join(' ')} --reporter=default`,
  output,
  runs,
};
const artifact = {
  heavyShardCount: 1,
  heavyShardMatrix: [1],
  fallbackClassification: 'rpc-evidence-pass-003',
  discovered: files,
  fullDiscovered: files,
  heavyFiles: [],
  lightFiles: [],
  postMergeWallclockFiles: files,
  parkedFiles: [],
  heavyShards: [{ shard: 1, files: [], totalRuntimeMs: 0 }],
  supervisorRpcCapture: {
    captureBindingSha,
    heavyLaneFingerprint: 'CI=true maxWorkers=1 fileParallelism=false',
    files,
    passes: [pass],
  },
};
writeFileSync(topologyArtifactPath(repoRoot), `${JSON.stringify(artifact, null, 2)}\n`);
if (process.argv.includes('--gha-output')) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error('GITHUB_OUTPUT is not set');
  appendFileSync(outputPath, 'heavy_shard_count=1\n');
  appendFileSync(outputPath, 'heavy_shard_matrix=[1]\n');
  appendFileSync(outputPath, 'fallback_classification=rpc-evidence-pass-003\n');
}
console.log(JSON.stringify({ ...artifact, supervisorRpcCapture: { ...artifact.supervisorRpcCapture, passes: [{ ...pass, output: `${output.split(/\r?\n/).length} lines captured in artifact`, runs: runs.map(({ file, status, signal, error, elapsedMs, timeoutSeconds }) => ({ file, status, signal, error, elapsedMs, timeoutSeconds })) }] } }));
