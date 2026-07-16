#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runProcess } from './kernel/subprocess.mjs';

const repoRoot = process.cwd();
const shard = 7;
const shardFiles = [
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
const planPath = join(repoRoot, 'scripts', 'issue-885-shard7-plan.json');
const runnerPath = join(repoRoot, 'scripts', 'run-vitest-heavy-shard.ps1');
const MAX_CAPTURE = 500_000;

const exactPlan = {
  issue: 885,
  heavyShardCount: 8,
  heavyShardIndices: [1, 2, 3, 4, 5, 6, 7, 8],
  heavyShardMatrix: [1, 2, 3, 4, 5, 6, 7, 8],
  fallbackClassification: 'diagnostic',
  heavyFiles: shardFiles,
  lightFiles: [],
  postMergeWallclockFiles: [],
  parkedFiles: [],
  discovered: shardFiles,
  heavyShards: [
    {
      shard,
      files: shardFiles,
      totalRuntimeMs: 885000,
    },
  ],
};
writeFileSync(planPath, `${JSON.stringify(exactPlan, null, 2)}\n`);

console.log('BEGIN exact PowerShell heavy-shard runner with merge, runtime budget, and hygiene');
const startedAt = Date.now();
const result = await runProcess({
  command: 'timeout',
  args: [
    '--signal=TERM',
    '--kill-after=5s',
    '1050s',
    'pwsh',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    runnerPath,
    '-Shard',
    String(shard),
  ],
  cwd: repoRoot,
  inheritParentEnv: true,
  env: {
    CI: 'true',
    OPK_VITEST_TOPOLOGY_PLAN_PATH: planPath,
    OPK_TESTMODE_FLEET_WORKSPACE_ROOT: repoRoot,
  },
});
const bounded = (value) => {
  const text = String(value ?? '');
  return text.length > MAX_CAPTURE ? text.slice(-MAX_CAPTURE) : text;
};
const diagnostic = {
  schemaVersion: 1,
  diagnostic: 'issue-885-exact-powershell-runner',
  head: process.env.GITHUB_SHA ?? null,
  runner: {
    status: result.exitCode,
    signal: result.signal,
    outcome: result.outcome,
    timedOut: result.exitCode === 124 || result.exitCode === 137,
    durationMs: Date.now() - startedAt,
    stdout: bounded(result.stdout),
    stderr: bounded(result.stderr),
  },
  heavyShardCount: 0,
  heavyShardMatrix: [],
  fallbackClassification: 'diagnostic',
};
console.log(
  `END exact runner status=${diagnostic.runner.status} signal=${diagnostic.runner.signal ?? '<none>'} timeout=${diagnostic.runner.timedOut} durationMs=${diagnostic.runner.durationMs}`,
);
console.log(`RUNNER_STDOUT_TAIL\n${diagnostic.runner.stdout}`);
console.log(`RUNNER_STDERR_TAIL\n${diagnostic.runner.stderr}`);
writeFileSync(
  join(repoRoot, 'scripts', 'vitest-heavy-topology.plan.json'),
  `${JSON.stringify(diagnostic, null, 2)}\n`,
);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    'heavy_shard_count=0\nheavy_shard_matrix=[]\nfallback_classification=diagnostic\n',
  );
}
