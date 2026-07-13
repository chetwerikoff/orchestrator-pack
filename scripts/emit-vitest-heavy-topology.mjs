#!/usr/bin/env node
// Diagnostic run marker: fast-v2.
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const repoRoot = process.cwd();
const runner = join(repoRoot, 'scripts', 'run-vitest-with-harness.mjs');
const files = [
  'scripts/autonomous-spawn-budget.test.ts',
  'scripts/ci-failure-progress-stale.test.ts',
  'scripts/gh-wrapper.test.ts',
  'scripts/mechanical-json-state.test.ts',
  'scripts/merge-triage.test.ts',
  'scripts/review-cycle-cap.test.ts',
  'scripts/review-start-claim-budget-semantics.test.ts',
  'scripts/review-start-claim-run-binding.test.ts',
  'scripts/review-start-claim.test.ts',
  'scripts/review-start-preflight-shield-matrix.test.ts',
  'scripts/seed-snapshot-failure-bounded-read-economy.test.ts',
  'scripts/supervisor-child-openprs-null.test.ts',
  'plugins/ao-task-declaration/tests/declare.test.ts',
  'scripts/audit-jsonl-retention.test.ts',
  'scripts/autonomous-worker-nudge-boundary.test.ts',
  'scripts/command-runtime-bootstrap.test.ts',
  'scripts/github-fleet-cache-coalesce.test.ts',
  'scripts/orchestrator-wake-supervisor-orphan-identity.test.ts',
  'scripts/pr-scope-check.test.ts',
  'scripts/review-head-ready.test.ts',
  'scripts/review-start-preflight-shield.integration.test.ts',
  'scripts/review-start-scoped-gh-json-capture.test.ts',
  'scripts/spawn-worktree-branch-operand-binding.test.ts',
  'scripts/worker-iteration-cycle.test.ts',
];
const MAX_CAPTURE = 96_000;
const TIMEOUT_MS = 90_000;

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
      const result = {
        file,
        status,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        error,
        stdout,
        stderr,
      };
      console.log(JSON.stringify({ file, status, signal, timedOut, durationMs: result.durationMs }));
      resolve(result);
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

const results = await runPool(files, 12);
const artifact = {
  schemaVersion: 1,
  diagnostic: 'issue-752-heavy-file-isolation',
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
console.log(JSON.stringify({ diagnostic: artifact.diagnostic, failures: results.filter((r) => r.status !== 0).map((r) => r.file) }));
