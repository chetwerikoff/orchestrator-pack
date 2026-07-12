import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  closeObsoleteDeliveryPr,
  DELIVERY_PATH,
  evaluateDeliveryState,
} from './vitest-runtime-history-delivery.mjs';

const files = [{ filename: DELIVERY_PATH }];
const requiredChecks = ['required-check'];
const passingChecks = [{ name: 'required-check', state: 'success' }];

function decide(overrides = {}) {
  return evaluateDeliveryState({
    pr: { mergeable: true, mergeable_state: 'clean', head: { sha: 'head-1' } },
    files,
    checks: passingChecks,
    requiredChecks,
    expectedHeadSha: 'head-1',
    ...overrides,
  });
}

test('mergeability-computing still waits', () => {
  assert.deepEqual(
    decide({ pr: { mergeable: null, mergeable_state: 'unknown', head: { sha: 'head-1' } } }),
    { action: 'wait', reason: 'delivery PR mergeability still computing' },
  );
});

test('clean delivery still merges', () => {
  assert.deepEqual(decide(), {
    action: 'merge',
    reason: 'delivery PR passed required checks',
  });
});

test('dirty or mergeable-false delivery closes as obsolete', () => {
  for (const pr of [
    { mergeable: false, mergeable_state: 'blocked', head: { sha: 'head-1' } },
    { mergeable: true, mergeable_state: 'dirty', head: { sha: 'head-1' } },
  ]) {
    assert.deepEqual(decide({ pr }), {
      action: 'close-as-obsolete',
      reason: 'delivery PR is conflicted or unmergeable',
    });
  }
});

test('genuine required-check failure remains actionable', () => {
  assert.deepEqual(
    decide({ checks: [{ name: 'required-check', state: 'failure' }] }),
    { action: 'fail', reason: 'required checks failed: required-check' },
  );
});

test('advanced head remains superseded', () => {
  assert.deepEqual(
    decide({ pr: { mergeable: true, mergeable_state: 'clean', head: { sha: 'head-2' } } }),
    { action: 'superseded', reason: 'PR head advanced to head-2' },
  );
});

test('close-as-obsolete invokes only gh pr close', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'runtime-history-delivery-'));
  const scriptsDir = join(repoRoot, 'scripts');
  const logPath = join(repoRoot, 'gh-args.json');
  try {
    mkdirSync(scriptsDir, { recursive: true });
    const ghPath = join(scriptsDir, 'gh');
    writeFileSync(
      ghPath,
      [
        '#!/usr/bin/env node',
        "const { writeFileSync } = require('node:fs');",
        'writeFileSync(process.env.GH_ARGS_LOG, JSON.stringify(process.argv.slice(2)));',
      ].join('\n'),
      'utf8',
    );
    chmodSync(ghPath, 0o755);

    const previous = process.env.GH_ARGS_LOG;
    process.env.GH_ARGS_LOG = logPath;
    try {
      closeObsoleteDeliveryPr(
        { repoRoot, repo: 'owner/repo', prNumber: '42' },
        'delivery PR is conflicted or unmergeable',
      );
    } finally {
      if (previous === undefined) delete process.env.GH_ARGS_LOG;
      else process.env.GH_ARGS_LOG = previous;
    }

    const args = JSON.parse(readFileSync(logPath, 'utf8'));
    assert.deepEqual(args.slice(0, 6), ['pr', 'close', '42', '--repo', 'owner/repo', '--comment']);
    assert.match(args[6], /Closing obsolete runtime-history delivery PR/);
    assert.equal(args.includes('update-branch'), false);
    assert.equal(args.includes('rebase'), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('credential and trusted-actor gates remain fail-closed in workflow', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/vitest-runtime-history-delivery.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /VITEST_RUNTIME_HISTORY_DELIVERY_TOKEN is required/);
  assert.match(workflow, /does not match trusted actor/);
  assert.match(workflow, /exit 1/);
});
