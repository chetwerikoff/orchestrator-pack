#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const repoRoot = process.cwd();
const runner = join(repoRoot, 'scripts', 'run-vitest-with-harness.mjs');
const files = [
  'plugins/ao-codex-pr-reviewer/tests/reviewer-budget.test.ts',
  'scripts/autonomous-orchestrator-boundary.test.ts',
  'scripts/autonomous-review-retry.test.ts',
  'scripts/ci-failure-progress-freshness.test.ts',
  'scripts/gh-repo-resolve.test.ts',
  'scripts/github-fleet-repo-tick-snapshot.test.ts',
  'scripts/reverify-e2e-fixture-session.test.ts',
  'scripts/review-ready-seed-revalidation.test.ts',
  'scripts/review-start-preflight-shield-terminal.test.ts',
  'scripts/review-trigger-reconcile.test.ts',
  'scripts/review-wake-trigger.test.ts',
  'scripts/submit-worker-input-draft.test.ts',
];
const MAX_CAPTURE = 160_000;
const TIMEOUT_MS = 480_000;
const CONCURRENCY = 6;

function bounded(current, chunk) {
  const next = current + String(chunk);
  return next.length > MAX_CAPTURE ? next.slice(-MAX_CAPTURE) : next;
}

function runFile(file) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [runner, 'run', file, '--reporter=verbose', '--maxWorkers=1'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CI: 'true',
          OPK_TESTMODE_FLEET_WORKSPACE_ROOT: repoRoot,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    );

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer;
    const startedAt = Date.now();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = bounded(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = bounded(stderr, chunk);
    });

    const finish = (status, signal, error = null) => {
      if (settled) return;
      settled = true;
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
      console.log(
        JSON.stringify({
          file,
          status,
          signal,
          timedOut,
          durationMs: result.durationMs,
        }),
      );
      resolve(result);
    };

    timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32') {
          child.kill('SIGKILL');
        } else {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {}
    }, TIMEOUT_MS);

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

const results = await runPool(files, CONCURRENCY);
const failures = results.filter(
  (result) => result.status !== 0 || result.timedOut || result.error,
);
const artifact = {
  schemaVersion: 1,
  diagnostic: 'issue-885-shard7-file-isolation',
  head: process.env.GITHUB_SHA ?? null,
  heavyShardCount: 0,
  heavyShardMatrix: [],
  fallbackClassification: 'diagnostic',
  results,
};

writeFileSync(
  join(repoRoot, 'scripts', 'vitest-heavy-topology.plan.json'),
  `${JSON.stringify(artifact, null, 2)}\n`,
);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    'heavy_shard_count=0\nheavy_shard_matrix=[]\nfallback_classification=diagnostic\n',
  );
}

console.log(
  JSON.stringify({
    diagnostic: artifact.diagnostic,
    failures: failures.map((result) => result.file),
  }),
);
