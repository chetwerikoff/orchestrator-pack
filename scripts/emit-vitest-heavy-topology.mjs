#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const repoRoot = process.cwd();
const runner = join(repoRoot, 'scripts', 'run-vitest-with-harness.mjs');
const config = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'vitest-ci-lanes.config.json'), 'utf8'));
const lightFiles = Object.entries(config.classification)
  .filter(([, lane]) => lane === 'light')
  .map(([file]) => file)
  .sort();
const chunkSize = 6;
const chunks = [];
for (let index = 0; index < lightFiles.length; index += chunkSize) {
  chunks.push(lightFiles.slice(index, index + chunkSize));
}
const maxCapture = 500_000;
const appendBounded = (current, chunk) => {
  const next = current + String(chunk);
  return next.length > maxCapture ? next.slice(-maxCapture) : next;
};
function signalTree(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {}
}
function runChunk(files, index) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [runner, 'run', ...files, '--reporter=verbose'], {
      cwd: repoRoot,
      detached: process.platform !== 'win32',
      env: { ...process.env, CI: 'true', OPK_TESTMODE_FLEET_WORKSPACE_ROOT: repoRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer = null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      signalTree(child, 'SIGTERM');
      killTimer = setTimeout(() => signalTree(child, 'SIGKILL'), 8_000);
    }, 180_000);
    const finish = (status, signal, error = null) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const result = {
        index,
        files,
        status,
        signal,
        timedOut,
        error,
        durationMs: Date.now() - started,
        stdout,
        stderr,
      };
      console.log(JSON.stringify({ chunk: index, status, signal, timedOut, durationMs: result.durationMs, files }));
      resolve(result);
    };
    child.once('error', (error) => finish(null, null, error.message));
    child.once('close', (status, signal) => finish(status, signal));
  });
}
async function pool(items, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await runChunk(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}
const results = await pool(chunks, 4);
const artifact = {
  schemaVersion: 1,
  diagnostic: 'issue-752-light-chunks',
  lightFileCount: lightFiles.length,
  chunkSize,
  results,
};
writeFileSync(join(repoRoot, 'scripts', 'vitest-heavy-topology.plan.json'), `${JSON.stringify(artifact, null, 2)}\n`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, 'heavy_shard_count=0\nheavy_shard_matrix=[]\nfallback_classification=false\n');
}
process.exit(0);
