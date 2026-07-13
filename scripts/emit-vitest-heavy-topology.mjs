#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const repoRoot = process.cwd();
const runner = join(repoRoot, 'scripts', 'run-vitest-with-harness.mjs');
const files = [
  'plugins/_shared/tests/declaration_schema.test.ts',
  'plugins/_shared/tests/git_fixture.test.ts',
  'plugins/_shared/tests/issue_parser.test.ts',
  'plugins/_shared/tests/normalize.test.ts',
  'plugins/ao-codex-pr-reviewer/tests/review.test.ts',
  'plugins/ao-scope-guard/tests/check.test.ts',
  'plugins/ao-scope-guard/tests/declaration_loader.test.ts',
  'plugins/ao-scope-guard/tests/normalize_edge.test.ts',
  'plugins/ao-task-declaration/tests/amendment.test.ts',
  'plugins/ao-task-declaration/tests/baseline.test.ts',
  'plugins/ao-task-declaration/tests/iteration.test.ts',
  'plugins/ao-task-declaration/tests/snapshot.test.ts',
  'plugins/ao-task-declaration/tests/validate.test.ts',
  'plugins/ao-token-chain-ledger/tests/aggregate.test.ts',
  'plugins/ao-token-chain-ledger/tests/convergence.test.ts',
  'plugins/ao-token-chain-ledger/tests/finding_signature.test.ts',
  'plugins/ao-token-chain-ledger/tests/session_cost.test.ts',
  'plugins/ao-token-chain-ledger/tests/writer.test.ts',
  'scripts/_test-stub-pack-import-closure.test.ts',
  'scripts/ao-0-10-review-trigger.test.ts',
  'scripts/ao-events-correlation-degraded.test.ts',
  'scripts/ao-session-adapter.test.ts',
  'scripts/ao-spawn-shape.test.ts',
  'scripts/check-supervisor-test-wait-inventory.test.ts',
  'scripts/contract-evidence.test.ts',
  'scripts/cursor-agent-tui-shim.test.ts',
  'scripts/draft-author-relocation-contract.test.ts',
  'scripts/draft-discipline.test.ts',
  'scripts/escalation-state-test-isolation.test.ts',
  'scripts/event-consumer-rebind-scenario-matrix.test.ts',
  'scripts/events-optional-consumer-signal-recovery.test.ts',
  'scripts/external-output-shape-guard.test.ts',
  'scripts/finding-ledger-guard.test.ts',
  'scripts/gh-inventory-static-guard.test.ts',
  'scripts/guard-direct-edit.test.ts',
  'scripts/harness-post-submit-pn-content-shape.test.ts',
  'scripts/harness-review-bridge.test.ts',
  'scripts/launch-argv-inventory.test.ts',
  'scripts/orchestrator-escalation.test.ts',
  'scripts/orchestrator-review-start-preflight-audit.test.ts',
  'scripts/orchestrator-wake-heartbeat.test.ts',
  'scripts/orchestrator-wake-supervisor-pr-lane-static.test.ts',
  'scripts/pr-session-binding-cache.test.ts',
  'scripts/protected-signal-receipt.test.ts',
  'scripts/reaction-config-messages.test.ts',
  'scripts/reverify-bound-issue-snapshot.test.ts',
  'scripts/review-bulk-send-diagnose.test.ts',
  'scripts/review-delivery.test.ts',
  'scripts/review-producer-contract-mapping.test.ts',
  'scripts/review-producer-contract.test.ts',
  'scripts/review-ready-report-state-seed.test.ts',
  'scripts/review-ready-stuck-guard.test.ts',
  'scripts/review-send-reconcile.test.ts',
  'scripts/review-start-claim-lifecycle.test.ts',
  'scripts/review-start-preflight-shield-classifier.test.ts',
  'scripts/review-start-repeat-classifier.test.ts',
  'scripts/reviewer-contract-mapping.test.ts',
  'scripts/reviewer-failure-evidence.test.ts',
  'scripts/run-vitest-heavy-shard.test.ts',
  'scripts/sanctioned-worker-kill-record.test.ts',
  'scripts/scripted-review-confirmed-delivery-gate.test.ts',
  'scripts/session-pr-binding-resolver.test.ts',
  'scripts/stage-completeness-guard.test.ts',
  'scripts/supervisor-test-wait-race.fixture.test.ts',
  'scripts/tier-gate-guard.test.ts',
  'scripts/trust-ao-worktree.test.ts',
  'scripts/vestigial-fleet-retirement-pr-b.test.ts',
  'scripts/vestigial-fleet-retirement.test.ts',
  'scripts/worker-nudge-task-continuation-pr-facet.test.ts',
  'scripts/worker-nudge-task-continuation-tuple.test.ts',
  'scripts/worker-report-store.test.ts',
  'scripts/worker-status-store.test.ts',
  'scripts/worktree-gate-claim-completion-seam.test.ts',
  'tests/agents-md-relocation.test.ts',
  'tests/agents-md-size-budget.test.ts',
];
const MAX_CAPTURE = 48_000;
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
      resolve({ file, status, signal, timedOut, durationMs: Date.now() - startedAt, error, stdout, stderr });
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

const results = await runPool(files, 15);
const artifact = {
  schemaVersion: 1,
  diagnostic: 'issue-752-light-files-after-optimization',
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
console.log(JSON.stringify({
  diagnostic: artifact.diagnostic,
  failures: results.filter((result) => result.status !== 0).map((result) => ({
    file: result.file,
    status: result.status,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
  })),
}));
