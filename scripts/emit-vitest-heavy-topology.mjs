#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '..');
const result = spawnSync(process.execPath, ['scripts/check-vitest-live-store-isolation.mjs'], {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
  env: process.env,
});
const artifact = {
  issue: 752,
  command: 'node scripts/check-vitest-live-store-isolation.mjs',
  status: result.status,
  signal: result.signal,
  error: result.error ? String(result.error.stack || result.error) : null,
  stdout: result.stdout || '',
  stderr: result.stderr || '',
};
writeFileSync(join(scriptDir, 'vitest-heavy-topology.plan.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, 'heavy_shard_count=1\n');
  appendFileSync(process.env.GITHUB_OUTPUT, 'heavy_shard_matrix=[1]\n');
  appendFileSync(process.env.GITHUB_OUTPUT, 'fallback_classification=issue-752-diagnostic\n');
}
console.log(JSON.stringify({ issue: 752, status: result.status }));
