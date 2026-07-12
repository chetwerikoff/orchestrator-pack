import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  closeObsoleteDeliveryPr,
  DELIVERY_PATH,
  evaluateDeliveryState,
  loadDeliverySnapshot,
  selectReusableDeliveryPr,
} from './vitest-runtime-history-delivery.mjs';

const REQUIRED = ['PR scope guard'];
const FILES = [{ filename: DELIVERY_PATH }];
const PASSING_CHECKS = [{ name: 'PR scope guard', state: 'SUCCESS' }];

function decide(overrides = {}) {
  return evaluateDeliveryState({
    pr: {
      head: { sha: 'head-1' },
      mergeable: true,
      mergeable_state: 'clean',
      ...(overrides.pr ?? {}),
    },
    files: overrides.files ?? FILES,
    checks: overrides.checks ?? PASSING_CHECKS,
    requiredChecks: overrides.requiredChecks ?? REQUIRED,
    expectedHeadSha: overrides.expectedHeadSha ?? 'head-1',
  });
}

test('mergeability-computing still waits', () => {
  assert.deepEqual(
    decide({ pr: { mergeable: null, mergeable_state: 'unknown' } }),
    { action: 'wait', reason: 'delivery PR mergeability still computing' },
  );
});

test('clean delivery with passing required checks still merges', () => {
  assert.equal(decide().action, 'merge');
});

test('mergeable=false closes the delivery PR as obsolete', () => {
  assert.deepEqual(
    decide({ pr: { mergeable: false, mergeable_state: 'dirty' } }),
    { action: 'close-as-obsolete', reason: 'delivery PR is conflicted or unmergeable' },
  );
});

test('dirty mergeable_state closes even when mergeable is not false', () => {
  assert.equal(
    decide({ pr: { mergeable: true, mergeable_state: 'dirty' } }).action,
    'close-as-obsolete',
  );
});

test('required-check failures remain failed and actionable', () => {
  assert.deepEqual(decide({ checks: [{ name: 'PR scope guard', state: 'FAILURE' }] }), {
    action: 'fail',
    reason: 'required checks failed: PR scope guard',
  });
});

test('superseded head still wins before conflict handling', () => {
  assert.equal(
    decide({
      expectedHeadSha: 'old-head',
      pr: { head: { sha: 'new-head' }, mergeable: false, mergeable_state: 'dirty' },
    }).action,
    'superseded',
  );
});

test('delivery path violations still fail before conflict handling', () => {
  assert.equal(
    decide({
      files: [{ filename: DELIVERY_PATH }, { filename: 'scripts/unrelated.ts' }],
      pr: { mergeable: false, mergeable_state: 'dirty' },
    }).action,
    'fail',
  );
});

test('missing and pending checks retain wait behavior', () => {
  assert.equal(decide({ checks: [] }).action, 'wait');
  assert.equal(
    decide({ checks: [{ name: 'PR scope guard', state: 'IN_PROGRESS' }] }).action,
    'wait',
  );
});

test('close-as-obsolete executes gh pr close and never update-branch or rebase', () => {
  const calls = [];
  closeObsoleteDeliveryPr({
    repoRoot: '/repo',
    repo: 'owner/repo',
    prNumber: 754,
    reason: 'delivery PR is conflicted or unmergeable',
    runCommand: (...args) => {
      calls.push(args);
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(calls.length, 1);
  const [repoRoot, args, options] = calls[0];
  assert.equal(repoRoot, '/repo');
  assert.deepEqual(args.slice(0, 5), ['pr', 'close', '754', '--repo', 'owner/repo']);
  assert.ok(args.includes('--comment'));
  assert.ok(!args.includes('update-branch'));
  assert.ok(!args.includes('rebase'));
  assert.deepEqual(options, { allowedExitCodes: [0] });
});

test('selectReusableDeliveryPr prefers open PRs and otherwise reuses closed unmerged PRs', () => {
  assert.deepEqual(
    selectReusableDeliveryPr([
      { number: 761, state: 'closed', merged_at: null },
      { number: 762, state: 'open', merged_at: null },
    ]),
    { number: 762, state: 'open', merged_at: null },
  );
  assert.deepEqual(
    selectReusableDeliveryPr([
      { number: 763, state: 'closed', merged_at: '2026-07-12T00:00:00Z' },
      { number: 764, state: 'closed', merged_at: null },
    ]),
    { number: 764, state: 'closed', merged_at: null },
  );
  assert.equal(
    selectReusableDeliveryPr([{ number: 765, state: 'closed', merged_at: '2026-07-12T00:00:00Z' }]),
    null,
  );
});

test('invalid trusted snapshot remains an actionable configuration failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-history-delivery-'));
  const path = join(dir, 'snapshot.json');
  try {
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        capturedBy: {},
        repository: { fullName: 'owner/repo' },
        branchProtection: { requiredStatusChecks: [] },
        maxAgeDays: 30,
      }),
    );
    const { failures } = loadDeliverySnapshot(path);
    assert.ok(failures.includes('snapshot capturedBy.login missing'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('credential and trusted-actor gates remain fail-closed before monitor-pr', () => {
  const workflow = readFileSync(
    '.github/workflows/vitest-runtime-history-delivery.yml',
    'utf8',
  );
  const credentialGate = workflow.indexOf('Require delivery credential and trusted actor');
  const monitorStep = workflow.indexOf('Monitor and merge delivery PR');
  assert.ok(credentialGate >= 0);
  assert.ok(monitorStep > credentialGate);
  assert.match(
    workflow,
    /if \[ -z "\$\{DELIVERY_TOKEN\}" \]; then[\s\S]*?exit 1/,
  );
  assert.match(
    workflow,
    /if \[ "\$\{EVENT_SENDER_LOGIN\}" != "\$\{trusted_actor\}" \]; then[\s\S]*?exit 1/,
  );
});

test('upsert-pr searches all states and reopens reusable closed delivery PRs', () => {
  const source = readFileSync('./scripts/vitest-runtime-history-delivery.mjs', 'utf8');
  assert.match(source, /pulls\?state=all&head=\$\{owner\}:\$\{encodeURIComponent\(options\.branch\)\}&base=\$\{options\.base\}/);
  assert.match(source, /\['pr', 'reopen', String\(number\), '--repo', options\.repo\]/);
});
