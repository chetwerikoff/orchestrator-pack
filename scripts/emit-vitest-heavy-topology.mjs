#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const repoRoot = process.cwd();
const result = spawnSync(process.execPath, ['scripts/check-vitest-live-store-isolation.mjs'], {
  cwd: repoRoot,
  env: { ...process.env },
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const artifact = {
  schemaVersion: 1,
  diagnostic: 'issue-752-node-fastpath-selfcheck',
  head: process.env.GITHUB_SHA ?? null,
  heavyShardCount: 0,
  heavyShardMatrix: [],
  fallbackClassification: 'diagnostic',
  result: {
    status: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  },
};
writeFileSync(join(repoRoot, 'scripts', 'vitest-heavy-topology.plan.json'), `${JSON.stringify(artifact, null, 2)}\n`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, 'heavy_shard_count=0\nheavy_shard_matrix=[]\nfallback_classification=diagnostic\n');
}
console.log(JSON.stringify({ diagnostic: artifact.diagnostic, status: result.status }));
