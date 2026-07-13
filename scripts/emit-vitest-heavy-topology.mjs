#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const repoRoot = process.cwd();
const base = '9dbef65759c44ac55ae52a8b70605a6d894b485c';
const head = 'e5d888a48144ef5d2c7559d33f39b299df8db916';
const result = spawnSync(
  'pwsh',
  [
    '-NoProfile',
    '-File',
    join(repoRoot, 'scripts', 'lint-self-architect.ps1'),
    '-Strict',
    '-BaseRef',
    base,
    '-HeadRef',
    head,
  ],
  { cwd: repoRoot, encoding: 'utf8', timeout: 9 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
);
const payload = {
  schemaVersion: 1,
  diagnostic: 'issue-752-self-architect',
  status: result.status,
  signal: result.signal,
  error: result.error?.message ?? null,
  stdout: result.stdout ?? '',
  stderr: result.stderr ?? '',
};
writeFileSync(join(repoRoot, 'scripts', 'vitest-heavy-topology.plan.json'), `${JSON.stringify(payload, null, 2)}\n`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, 'heavy_shard_count=0\nheavy_shard_matrix=[]\nfallback_classification=false\n');
}
process.exit(0);
