#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const repoRoot = process.cwd();
const runner = join(repoRoot, 'scripts', 'run-vitest-with-harness.mjs');
const config = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'vitest-ci-lanes.config.json'), 'utf8'));
const files = Object.entries(config.classification ?? {})
  .filter(([, lane]) => lane === 'heavy')
  .map(([file]) => file)
  .filter((file) => existsSync(join(repoRoot, file)))
  .sort();
const MAX_CAPTURE = 64_000;
const TIMEOUT_MS = 240_000;

function bounded(current, chunk) {
  const next = current + String(chunk);
  return next.length > MAX_CAPTURE ? next.slice(-MAX_CAPTURE) : next;
}

function runFile(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runner, 'run', file, '--reporter=verbose', '--maxWorkers=1'], {
      cwd: repoRoot,
      env: { ...process.env, CI: 'true', OPK_TESTMODE_FLEET_WORKSPACE_ROOT: repoRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    const startedAt = Date.now();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = bounded(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = bounded(stderr, chunk); });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }, TIMEOUT_MS);
    const finish = (status, signal, error = null) => {
      clearTimeout(timer);
      resolve({ file, status, signal, timedOut, durationMs: Date.now() - startedAt, error, stdout, stderr });
    };
    child.once('error', (error) => finish(null, null, error.message));
    child.once('close', (status, signal) => finish(status, signal));
  });
}

async function runPool(items, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await runFile(items[index]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

const results = await runPool(files, 20);
const artifact = {
  schemaVersion: 1,
  diagnostic: 'issue-752-heavy-fastpath-current-head',
  head: process.env.GITHUB_SHA ?? null,
  heavyShardCount: 0,
  heavyShardMatrix: [],
  fallbackClassification: 'diagnostic',
  results,
};
writeFileSync(join(repoRoot, 'scripts', 'vitest-heavy-topology.plan.json'), `${JSON.stringify(artifact, null, 2)}\n`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, 'heavy_shard_count=0\nheavy_shard_matrix=[]\nfallback_classification=diagnostic\n');
}
console.log(JSON.stringify({
  diagnostic: artifact.diagnostic,
  count: files.length,
  failures: results.filter((result) => result.status !== 0).map((result) => ({
    file: result.file,
    status: result.status,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
  })),
}));
