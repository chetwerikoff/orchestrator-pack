#!/usr/bin/env node
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { topologyArtifactPath } from './lib/vitest-heavy-topology.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.OPK_REPO_ROOT?.replace(/\\/g, '/') || join(scriptDir, '..');
const captureBindingSha = 'b82efaa61560d351b45b666205d44f42d3f0a108';
const files = [
  'scripts/orchestrator-wake-supervisor-startup.test.ts',
  'scripts/orchestrator-wake-supervisor-lifecycle.test.ts',
  'scripts/orchestrator-wake-supervisor-side-process-registry.test.ts',
  'scripts/orchestrator-wake-supervisor-empty-pid.test.ts',
];

function quotePs(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runPass(index) {
  const root = mkdtempSync(join(tmpdir(), `opk-rpc-pass-${index}-`));
  const helper = join(repoRoot, 'scripts', 'lib', 'Set-OpkVitestHarnessEnv.ps1');
  const fileArgs = files.map(quotePs).join(',');
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${quotePs(helper)}`,
    '$harness = Set-OpkVitestHarnessEnv',
    'try {',
    `  $testFiles = @(${fileArgs})`,
    '  $env:CI = \'true\'',
    '  Remove-Item Env:VITEST_CI_LIGHT_LANE -ErrorAction SilentlyContinue',
    '  & npm test -- @testFiles --reporter=default',
    '  exit $LASTEXITCODE',
    '} finally {',
    '  Remove-Item -LiteralPath $harness.root -Recurse -Force -ErrorAction SilentlyContinue',
    '}',
  ].join('; ');
  const startedAt = new Date().toISOString();
  const started = Date.now();
  try {
    const child = spawnSync('pwsh', ['-NoProfile', '-Command', command], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 160_000,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        CI: 'true',
        OPK_TESTMODE_FLEET_WORKSPACE_ROOT: repoRoot,
      },
    });
    const output = `${child.stdout ?? ''}\n${child.stderr ?? ''}`.trim();
    return {
      id: `pass-${String(index).padStart(3, '0')}`,
      startedAt,
      completedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      status: child.status,
      signal: child.signal,
      error: child.error?.message ?? null,
      command: `CI=true npm test -- ${files.join(' ')} --reporter=default`,
      output,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const passes = [runPass(1), runPass(2), runPass(3)];
const artifact = {
  heavyShardCount: 1,
  heavyShardMatrix: [1],
  fallbackClassification: 'rpc-evidence-capture',
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
    passes,
  },
};
writeFileSync(topologyArtifactPath(repoRoot), `${JSON.stringify(artifact, null, 2)}\n`);
if (process.argv.includes('--gha-output')) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error('GITHUB_OUTPUT is not set');
  appendFileSync(outputPath, 'heavy_shard_count=1\n');
  appendFileSync(outputPath, 'heavy_shard_matrix=[1]\n');
  appendFileSync(outputPath, 'fallback_classification=rpc-evidence-capture\n');
}
if (passes.some((pass) => pass.status !== 0)) {
  console.error(JSON.stringify(artifact));
  process.exit(1);
}
console.log(JSON.stringify(artifact));
