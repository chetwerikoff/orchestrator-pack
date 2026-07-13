#!/usr/bin/env node
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '..');
const artifactPath = join(scriptDir, 'vitest-heavy-topology.plan.json');
const originalPath = join(scriptDir, '.issue-752-original-emit.mjs');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 7 * 60 * 1000,
    env: process.env,
    ...options,
  });
  return {
    command: [command, ...args].join(' '),
    status: result.status,
    signal: result.signal,
    error: result.error ? String(result.error.stack || result.error) : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

const diagnostics = {};
diagnostics.verify = run('pwsh', ['-NoProfile', '-File', 'scripts/verify.ps1']);
diagnostics.light = run('pwsh', ['-NoProfile', '-File', 'scripts/run-vitest-light-lane.ps1']);

const show = run('git', ['show', 'HEAD^1:scripts/emit-vitest-heavy-topology.mjs']);
diagnostics.gitShow = { ...show, stdout: show.stdout.slice(0, 2000) };
if (show.status === 0 && show.stdout) {
  writeFileSync(originalPath, show.stdout, 'utf8');
  try {
    diagnostics.topology = run(process.execPath, [originalPath]);
  } finally {
    rmSync(originalPath, { force: true });
  }
} else {
  diagnostics.topology = { command: 'not run', status: null, signal: null, error: 'git show failed', stdout: '', stderr: '' };
}

writeFileSync(artifactPath, `${JSON.stringify({ issue: 752, diagnostics }, null, 2)}\n`, 'utf8');
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, 'heavy_shard_count=1\n');
  appendFileSync(process.env.GITHUB_OUTPUT, 'heavy_shard_matrix=[1]\n');
  appendFileSync(process.env.GITHUB_OUTPUT, 'fallback_classification=issue-752-diagnostic\n');
}
console.log(JSON.stringify({ issue: 752, artifactPath }));
