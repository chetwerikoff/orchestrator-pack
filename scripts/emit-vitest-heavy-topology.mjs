#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const repoRoot = process.cwd();
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const probes = [
  ['light-escalation-isolation', 'scripts/escalation-state-test-isolation.test.ts'],
  ['shard-1-fleet-reaper-wallclock', 'scripts/testmode-fleet-reaper-wallclock.test.ts'],
  ['shard-2-submit-reconcile', 'scripts/worker-message-submit-reconcile.test.ts'],
  ['shard-3-dead-worker-reconcile', 'scripts/dead-worker-reconcile.test.ts'],
  ['shard-4-mechanical-json-state', 'scripts/mechanical-json-state.test.ts'],
  ['shard-5-worker-recovery-cleanup', 'scripts/worker-recovery-branch-cleanup.test.ts'],
  ['shard-6-audit-jsonl-retention', 'scripts/audit-jsonl-retention.test.ts'],
  ['shard-7-review-trigger-reconcile', 'scripts/review-trigger-reconcile.test.ts'],
  ['shard-8-testmode-fleet-reaper', 'scripts/testmode-fleet-reaper.test.ts'],
];

const maxCapture = 240_000;
function appendBounded(current, chunk) {
  const next = current + String(chunk);
  return next.length > maxCapture ? next.slice(-maxCapture) : next;
}

function runProbe([name, file]) {
  return new Promise((resolve) => {
    const timeoutCommand = process.platform === 'win32' ? npm : 'timeout';
    const timeoutArgs = process.platform === 'win32'
      ? ['test', '--', file, '--reporter=verbose']
      : ['--signal=TERM', '--kill-after=10s', '150s', npm, 'test', '--', file, '--reporter=verbose'];
    const child = spawn(timeoutCommand, timeoutArgs, {
      cwd: repoRoot,
      env: {
        ...process.env,
        CI: 'true',
        OPK_TESTMODE_FLEET_WORKSPACE_ROOT: repoRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.on('error', (error) => {
      resolve({ name, file, status: null, signal: null, error: error.message, stdout, stderr });
    });
    child.on('close', (status, signal) => {
      resolve({ name, file, status, signal, error: null, stdout, stderr });
    });
  });
}

async function runPool(items, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await runProbe(items[index]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

const results = await runPool(probes, 3);
const artifact = {
  schemaVersion: 1,
  diagnostic: 'issue-752-common-ci-failure-isolation',
  head: process.env.GITHUB_SHA ?? null,
  results,
};
writeFileSync(join(repoRoot, 'scripts', 'vitest-heavy-topology.plan.json'), `${JSON.stringify(artifact, null, 2)}\n`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, 'heavy_shard_count=0\nheavy_shard_matrix=[]\nfallback_classification=false\n');
}
console.log(JSON.stringify({ diagnostic: artifact.diagnostic, statuses: results.map(({ name, status, signal }) => ({ name, status, signal })) }));
