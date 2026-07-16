#!/usr/bin/env node
import { appendFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadLanesConfig,
  loadRuntimeHistory,
  resolveHeavyFileRunPlan,
  resolveRepoRoot,
} from './lib/vitest-ci-lanes.mjs';
import { runProcess } from './kernel/subprocess.mjs';

const repoRoot = resolveRepoRoot();
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
const BATCH_SIZE = 4;
const INVOCATION_TIMEOUT_SECONDS = 600;
const MAX_CAPTURE = 240_000;
const config = loadLanesConfig(repoRoot);
const runtimeHistory = loadRuntimeHistory(repoRoot);

function bounded(value) {
  const text = String(value ?? '');
  return text.length > MAX_CAPTURE ? text.slice(-MAX_CAPTURE) : text;
}

function makeInvocation(members, pool) {
  return {
    pool,
    files: [...new Set(members.map((member) => member.file))],
    testPattern: members.length === 1 ? members[0].testPattern : null,
    label:
      members.length === 1
        ? members[0].label
        : `batch(${members.length}): ${members.map((member) => member.label).join(', ')}`,
    members,
  };
}

const invocations = [];
let openMembers = [];
let openPool = null;
function flushBatch() {
  if (openMembers.length > 0) {
    invocations.push(makeInvocation(openMembers, openPool));
  }
  openMembers = [];
  openPool = null;
}

for (const file of shardFiles) {
  const plan = resolveHeavyFileRunPlan(file, config, runtimeHistory, repoRoot);
  if (plan.mode === 'tests') {
    flushBatch();
    for (const title of plan.tests) {
      invocations.push(
        makeInvocation(
          [{ file, label: `${file} > ${title}`, testPattern: title, kind: 'test' }],
          plan.pool,
        ),
      );
    }
    continue;
  }

  const member = { file, label: file, testPattern: null, kind: 'file' };
  if (!plan.batchable) {
    flushBatch();
    invocations.push(makeInvocation([member], plan.pool));
    continue;
  }

  if (openMembers.length === 0) {
    openMembers = [member];
    openPool = plan.pool;
  } else if (openPool === plan.pool && openMembers.length < BATCH_SIZE) {
    openMembers.push(member);
  } else {
    flushBatch();
    openMembers = [member];
    openPool = plan.pool;
  }
}
flushBatch();

console.log(`diagnostic-shard=${shard} files=${shardFiles.length} invocations=${invocations.length}`);
for (const [index, invocation] of invocations.entries()) {
  console.log(
    `PLAN ${index + 1}/${invocations.length} pool=${invocation.pool} files=${invocation.files.join(',')} test=${invocation.testPattern ?? '<all>'}`,
  );
}

const results = [];
let firstFailure = null;
for (const [index, invocation] of invocations.entries()) {
  const reportPath = join(repoRoot, `.issue-885-shard7-${index + 1}.json`);
  if (existsSync(reportPath)) rmSync(reportPath, { force: true });

  const args = [
    '--signal=TERM',
    '--kill-after=5s',
    `${INVOCATION_TIMEOUT_SECONDS}s`,
    'npm',
    'test',
    '--',
    ...invocation.files,
  ];
  if (invocation.pool === 'forks') args.push('--pool=forks');
  if (invocation.testPattern) args.push('-t', invocation.testPattern);
  args.push('--reporter=default', '--reporter=json', `--outputFile=${reportPath}`);

  console.log(`BEGIN ${index + 1}/${invocations.length} ${invocation.label}`);
  const startedAt = Date.now();
  const result = await runProcess({
    command: 'timeout',
    args,
    cwd: repoRoot,
    inheritParentEnv: true,
    env: {
      CI: 'true',
      VITEST_HEAVY_SHARD: String(shard),
      OPK_TESTMODE_FLEET_WORKSPACE_ROOT: repoRoot,
    },
  });
  const timedOut = result.exitCode === 124 || result.exitCode === 137;
  const record = {
    index: index + 1,
    label: invocation.label,
    pool: invocation.pool,
    files: invocation.files,
    testPattern: invocation.testPattern,
    status: result.exitCode,
    signal: result.signal,
    outcome: result.outcome,
    timedOut,
    durationMs: Date.now() - startedAt,
    reportExists: existsSync(reportPath),
    stdout: result.ok ? '' : bounded(result.stdout),
    stderr: result.ok ? '' : bounded(result.stderr),
  };
  results.push(record);
  console.log(
    `END ${index + 1}/${invocations.length} status=${record.status} signal=${record.signal ?? '<none>'} timeout=${record.timedOut} durationMs=${record.durationMs}`,
  );
  if (!result.ok || timedOut) {
    firstFailure = record;
    console.log(`FIRST_FAILURE ${JSON.stringify({ index: record.index, label: record.label, files: record.files, testPattern: record.testPattern, status: record.status, signal: record.signal, timedOut: record.timedOut })}`);
    console.log(`FAILURE_STDOUT_TAIL\n${record.stdout}`);
    console.log(`FAILURE_STDERR_TAIL\n${record.stderr}`);
    break;
  }
}

const artifact = {
  schemaVersion: 1,
  diagnostic: 'issue-885-shard7-exact-invocations',
  head: process.env.GITHUB_SHA ?? null,
  heavyShardCount: 0,
  heavyShardMatrix: [],
  fallbackClassification: 'diagnostic',
  plannedInvocationCount: invocations.length,
  completedInvocationCount: results.length,
  firstFailure,
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
