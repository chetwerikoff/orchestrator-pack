#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { topologyArtifactPath } from './lib/vitest-heavy-topology.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.OPK_REPO_ROOT?.replace(/\\/g, '/') || join(scriptDir, '..');
const child = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/verify.ps1'], {
  cwd: repoRoot,
  encoding: 'utf8',
  timeout: 480_000,
  maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, CI: 'true' },
});
const lines = `${child.stdout ?? ''}\n${child.stderr ?? ''}`
  .split(/\r?\n/)
  .filter(Boolean);
const artifact = {
  heavyShardCount: 1,
  heavyShardMatrix: [1],
  fallbackClassification: 'pr768-final-verifier-diagnostic',
  discovered: [],
  fullDiscovered: [],
  heavyFiles: [],
  lightFiles: [],
  postMergeWallclockFiles: [],
  parkedFiles: [],
  heavyShards: [{ shard: 1, files: [], totalRuntimeMs: 0 }],
  verifierDiagnostic: {
    status: child.status,
    signal: child.signal,
    error: child.error?.message ?? null,
    tail: lines.slice(-320),
  },
};
writeFileSync(topologyArtifactPath(repoRoot), `${JSON.stringify(artifact, null, 2)}\n`);
if (process.argv.includes('--gha-output')) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error('GITHUB_OUTPUT is not set');
  appendFileSync(outputPath, 'heavy_shard_count=1\n');
  appendFileSync(outputPath, 'heavy_shard_matrix=[1]\n');
  appendFileSync(outputPath, 'fallback_classification=pr768-final-verifier-diagnostic\n');
}
console.log(JSON.stringify({ ...artifact, verifierDiagnostic: { ...artifact.verifierDiagnostic, tail: `${artifact.verifierDiagnostic.tail.length} lines captured in artifact` } }));
