#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const repoRoot = process.cwd();
const runner = join(repoRoot, 'scripts', 'run-vitest-with-harness.mjs');
const probes = [
  ['light-escalation-isolation', 'scripts/escalation-state-test-isolation.test.ts'],
  ['shard-2-submit-reconcile', 'scripts/worker-message-submit-reconcile.test.ts'],
  ['shard-6-audit-jsonl-retention', 'scripts/audit-jsonl-retention.test.ts'],
  ['shard-8-testmode-fleet-reaper', 'scripts/testmode-fleet-reaper.test.ts'],
];

const maxCapture = 300_000;
function appendBounded(current, chunk) {
  const next = current + String(chunk);
  return next.length > maxCapture ? next.slice(-maxCapture) : next;
}

function signalProcessTree(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // The process may already have exited.
  }
}

function runProbe([name, file]) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runner, 'run', file, '--reporter=verbose'], {
      cwd: repoRoot,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        CI: 'true',
        OPK_TESTMODE_FLEET_WORKSPACE_ROOT: repoRoot,
      },
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
      signalProcessTree(child, 'SIGTERM');
      killTimer = setTimeout(() => signalProcessTree(child, 'SIGKILL'), 8_000);
    }, 90_000);
    const finish = (status, signal, error = null) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const result = { name, file, status, signal, timedOut, error, stdout, stderr };
      console.log(JSON.stringify({ probe: name, status, signal, timedOut, error }));
      resolve(result);
    };
    child.once('error', (error) => finish(null, null, error.message));
    child.once('close', (status, signal) => finish(status, signal));
  });
}

const results = await Promise.all(probes.map(runProbe));
const artifact = {
  schemaVersion: 1,
  diagnostic: 'issue-752-transport-fix-validation',
  head: process.env.GITHUB_SHA ?? null,
  results,
};
writeFileSync(join(repoRoot, 'scripts', 'vitest-heavy-topology.plan.json'), `${JSON.stringify(artifact, null, 2)}\n`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, 'heavy_shard_count=0\nheavy_shard_matrix=[]\nfallback_classification=false\n');
}
console.log(JSON.stringify({ diagnostic: artifact.diagnostic, statuses: results.map(({ name, status, signal, timedOut }) => ({ name, status, signal, timedOut })) }));
