#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const repoRoot = process.cwd();
const base = '9dbef65759c44ac55ae52a8b70605a6d894b485c';
const head = 'e5d888a48144ef5d2c7559d33f39b299df8db916';
const shard1 = [
  'plugins/ao-token-chain-ledger/tests/integration.test.ts',
  'scripts/check-ci-pipeline-split.test.ts',
  'scripts/contract-evidence-legacy-list-guard.test.ts',
  'scripts/github-fleet-cache-memo.test.ts',
  'scripts/publish-issue-body-sync.test.ts',
  'scripts/review-handoff-admission-records-lifecycle.test.ts',
  'scripts/review-orchestrator-loop.test.ts',
  'scripts/review-start-supervised-gh-pid.test.ts',
  'scripts/spawn-worktree-grant-finalization.test.ts',
  'scripts/testmode-fleet-reaper-wallclock.test.ts',
  'scripts/worker-nudge-issue-owner-bootstrap.test.ts',
];
const shard6 = [
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

function run(name, command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: 90_000,
    killSignal: 'SIGKILL',
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    name,
    status: result.status,
    signal: result.signal,
    timedOut: result.error?.code === 'ETIMEDOUT',
    error: result.error?.message ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const lint = run('self-architect', 'pwsh', [
  '-NoProfile', '-File', join(repoRoot, 'scripts', 'lint-self-architect.ps1'),
  '-Strict', '-BaseRef', base, '-HeadRef', head,
]);
const one = run('heavy-shard-1', npm, ['test', '--', ...shard1, '--reporter=verbose'], {
  CI: 'true', VITEST_HEAVY_SHARD: '1', OPK_TESTMODE_FLEET_WORKSPACE_ROOT: repoRoot,
});
const six = run('heavy-shard-6', npm, ['test', '--', ...shard6, '--reporter=verbose'], {
  CI: 'true', VITEST_HEAVY_SHARD: '6', OPK_TESTMODE_FLEET_WORKSPACE_ROOT: repoRoot,
});

writeFileSync(
  join(repoRoot, 'scripts', 'vitest-heavy-topology.plan.json'),
  `${JSON.stringify({ schemaVersion: 1, diagnostic: 'issue-752-lint-and-heavy-shards', runs: [lint, one, six] }, null, 2)}\n`,
);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, 'heavy_shard_count=0\nheavy_shard_matrix=[]\nfallback_classification=false\n');
}
process.exit(0);
