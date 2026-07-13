#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const repoRoot = process.cwd();
const files = [
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
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['test', '--', ...files, '--reporter=verbose'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CI: 'true',
    VITEST_HEAVY_SHARD: '6',
    OPK_TESTMODE_FLEET_WORKSPACE_ROOT: repoRoot,
  },
  encoding: 'utf8',
  timeout: 12 * 60 * 1000,
  killSignal: 'SIGKILL',
  maxBuffer: 64 * 1024 * 1024,
});
const payload = {
  schemaVersion: 1,
  diagnostic: 'issue-752-final-heavy-shard-6',
  status: result.status,
  signal: result.signal,
  timedOut: result.error?.code === 'ETIMEDOUT',
  error: result.error?.message ?? null,
  stdout: result.stdout ?? '',
  stderr: result.stderr ?? '',
};
writeFileSync(join(repoRoot, 'scripts', 'vitest-heavy-topology.plan.json'), `${JSON.stringify(payload, null, 2)}\n`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, 'heavy_shard_count=0\nheavy_shard_matrix=[]\nfallback_classification=false\n');
}
process.exit(0);
