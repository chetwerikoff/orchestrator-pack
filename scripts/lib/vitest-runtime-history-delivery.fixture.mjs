#!/usr/bin/env node
/**
 * Fixture suite for Issue #731 delivery-path guards.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  DELIVERY_PATH,
  evaluateDeliveryState,
  validateDeliveryFiles,
} from '../vitest-runtime-history-delivery.mjs';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runGit(cwd, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    ...options,
  });
  return result;
}

function makeProtectedBranchFixture() {
  const root = mkdtempSync(join(tmpdir(), 'opk-vhr-delivery-'));
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  mkdirSync(work, { recursive: true });
  runGit(root, ['init', '--bare', remote]);
  runGit(root, ['clone', remote, work]);
  runGit(work, ['config', 'user.name', 'fixture']);
  runGit(work, ['config', 'user.email', 'fixture@example.test']);
  mkdirSync(join(work, 'scripts'), { recursive: true });
  writeFileSync(
    join(work, DELIVERY_PATH),
    JSON.stringify({ source: 'ci-baseline-estimates', files: { 'a.test.ts': 45000 } }, null, 2),
    'utf8',
  );
  runGit(work, ['add', DELIVERY_PATH]);
  runGit(work, ['commit', '-m', 'seed']);
  runGit(work, ['branch', '-M', 'main']);
  runGit(work, ['push', 'origin', 'main']);

  const hook = `#!/bin/sh
while read oldrev newrev refname; do
  if [ "$refname" = "refs/heads/main" ]; then
    echo "remote: error: GH006: Protected branch update failed for refs/heads/main." >&2
    exit 1
  fi
done
exit 0
`;
  writeFileSync(join(remote, 'hooks', 'pre-receive'), hook, { encoding: 'utf8', mode: 0o755 });

  writeFileSync(
    join(work, DELIVERY_PATH),
    JSON.stringify({ source: 'measured-heavy-shards', files: { 'a.test.ts': 12345 } }, null, 2),
    'utf8',
  );
  runGit(work, ['add', DELIVERY_PATH]);
  runGit(work, ['commit', '-m', 'refresh']);

  return { root, work };
}

function testProtectedBranchRejectionThenBranchSuccess() {
  const fixture = makeProtectedBranchFixture();
  try {
    const rejected = runGit(fixture.work, ['push', 'origin', 'HEAD:main']);
    assert(rejected.status !== 0, 'direct push to protected main must fail');
    assert(
      `${rejected.stderr}${rejected.stdout}`.includes('GH006'),
      'protected-branch rejection should surface GH006',
    );

    const delivered = runGit(fixture.work, ['push', 'origin', 'HEAD:refs/heads/ci/vitest-runtime-history-refresh']);
    assert(delivered.status === 0, 'push to delivery branch must succeed');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function testSinglePathGate() {
  const ok = validateDeliveryFiles([{ filename: DELIVERY_PATH }]);
  assert(ok.ok, 'single runtime-history path should pass');

  const bad = validateDeliveryFiles([
    { filename: DELIVERY_PATH },
    { filename: '.github/workflows/vitest-runtime-history-refresh.yml' },
  ]);
  assert(!bad.ok, 'extra delivery paths must fail closed');
}

function testCheckDecisionMatrix() {
  const merge = evaluateDeliveryState({
    pr: { head: { sha: 'abc' }, mergeable: true, mergeable_state: 'clean' },
    files: [{ filename: DELIVERY_PATH }],
    checks: [
      { name: 'Verify orchestrator-pack structure', state: 'SUCCESS', bucket: 'pass' },
      { name: 'Contract evidence legacy list guard', state: 'SUCCESS', bucket: 'pass' },
    ],
    requiredChecks: ['Verify orchestrator-pack structure', 'Contract evidence legacy list guard'],
    expectedHeadSha: 'abc',
  });
  assert(merge.action === 'merge', 'passing required checks should merge');

  const pending = evaluateDeliveryState({
    pr: { head: { sha: 'abc' }, mergeable: true, mergeable_state: 'unknown' },
    files: [{ filename: DELIVERY_PATH }],
    checks: [{ name: 'Verify orchestrator-pack structure', state: 'pending', bucket: 'pending' }],
    requiredChecks: ['Verify orchestrator-pack structure', 'Contract evidence legacy list guard'],
    expectedHeadSha: 'abc',
  });
  assert(pending.action === 'wait', 'missing or pending required checks should wait');

  const failed = evaluateDeliveryState({
    pr: { head: { sha: 'abc' }, mergeable: true, mergeable_state: 'clean' },
    files: [{ filename: DELIVERY_PATH }],
    checks: [
      { name: 'Verify orchestrator-pack structure', state: 'SUCCESS', bucket: 'pass' },
      { name: 'Contract evidence legacy list guard', state: 'failure', bucket: 'fail' },
    ],
    requiredChecks: ['Verify orchestrator-pack structure', 'Contract evidence legacy list guard'],
    expectedHeadSha: 'abc',
  });
  assert(failed.action === 'fail', 'failing required checks should fail closed');
}

function testSupersededHead() {
  const result = evaluateDeliveryState({
    pr: { head: { sha: 'newer' }, mergeable: true, mergeable_state: 'clean' },
    files: [{ filename: DELIVERY_PATH }],
    checks: [
      { name: 'Verify orchestrator-pack structure', state: 'SUCCESS', bucket: 'pass' },
      { name: 'Contract evidence legacy list guard', state: 'SUCCESS', bucket: 'pass' },
    ],
    requiredChecks: ['Verify orchestrator-pack structure', 'Contract evidence legacy list guard'],
    expectedHeadSha: 'older',
  });
  assert(result.action === 'superseded', 'stale monitor runs must yield to newer heads');
}

function main() {
  const tests = [
    testProtectedBranchRejectionThenBranchSuccess,
    testSinglePathGate,
    testCheckDecisionMatrix,
    testSupersededHead,
  ];
  const failures = [];
  for (const test of tests) {
    try {
      test();
    } catch (error) {
      failures.push(`${test.name}: ${error.message}`);
    }
  }

  if (failures.length > 0) {
    console.error('[FAIL] runtime-history delivery fixtures:');
    for (const failure of failures) {
      console.error(` - ${failure}`);
    }
    process.exit(1);
  }

  console.log('[PASS] runtime-history delivery fixtures OK');
}

main();
