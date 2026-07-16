#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runProcess } from './kernel/subprocess.mjs';

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
const TIMEOUT_SECONDS = 480;
const CONCURRENCY = 6;

function bounded(value) {
  const text = String(value ?? '');
  return text.length > MAX_CAPTURE ? text.slice(-MAX_CAPTURE) : text;
}

async function runFile(file) {
  const startedAt = Date.now();
  const result = await runProcess({
    command: 'timeout',
    args: [
      '--signal=TERM',
      '--kill-after=5s',
      `${TIMEOUT_SECONDS}s`,
      process.execPath,
      runner,
      'run',
      file,
      '--reporter=verbose',
      '--maxWorkers=1',
    ],
    cwd: repoRoot,
    inheritParentEnv: true,
    env: {
      CI: 'true',
      OPK_TESTMODE_FLEET_WORKSPACE_ROOT: repoRoot,
    },
  });
  const timedOut = result.exitCode === 124 || result.exitCode === 137;
  const entry = {
    file,
    outcome: result.outcome,
    status: result.exitCode,
    signal: result.signal,
    timedOut,
    durationMs: Date.now() - startedAt,
    error: result.error ?? null,
    stdout: bounded(result.stdout),
    stderr: bounded(result.stderr),
  };
  console.log(
    JSON.stringify({
      file,
      status: entry.status,
      signal: entry.signal,
      timedOut,
      durationMs: entry.durationMs,
    }),
  );
  return entry;
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
