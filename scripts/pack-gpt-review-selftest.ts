#!/usr/bin/env -S node --experimental-strip-types

import './toolchain/native-entrypoint-preflight.ts';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  packGptReviewUsage,
  parsePackGptReviewArgs,
  runPackGptReviewCommand,
} from './pack-gpt-review.ts';
import { startPackReview } from './pack-review-runner.ts';
import { PACK_REVIEW_BOUND_REVIEWER_ENV } from './lib/resolve-pack-reviewer.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEAD_A = 'a'.repeat(40);
const originalEnv = { ...process.env };

function cleanTerminalPayload(): string {
  return JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] });
}

function withHarnessEnvironment<T>(action: (context: {
  storeRoot: string;
  capture: string;
  engagement: string;
  invocationLog: string;
}) => Promise<T>): Promise<T> {
  const storeRoot = mkdtempSync(path.join(tmpdir(), 'opk-issue-1111-'));
  const capture = path.join(storeRoot, 'github-review.json');
  const engagement = path.join(storeRoot, 'gpt-engagements.jsonl');
  const invocationLog = path.join(storeRoot, 'invocations.jsonl');
  process.env = {
    ...originalEnv,
    OPK_VITEST_HARNESS: '1',
    PACK_REVIEWER: 'codex',
    PACK_REVIEW_GITHUB_REVIEW_CAPTURE_FILE: capture,
    PACK_REVIEW_RUNNER_GPT_ENGAGEMENT_FILE: engagement,
    PACK_REVIEW_RUNNER_INVOCATION_LOG: invocationLog,
    AO_BASE_DIR: path.join(storeRoot, 'ao-base'),
  };
  return action({ storeRoot, capture, engagement, invocationLog }).finally(() => {
    process.env = { ...originalEnv };
    rmSync(storeRoot, { recursive: true, force: true });
  });
}

function runnerFor(storeRoot: string, overrides: Record<string, unknown> = {}) {
  return (input: Parameters<typeof startPackReview>[0]) => startPackReview({
    ...input,
    projectId: 'orchestrator-pack',
    storeRoot,
    sourceRepoRoot: repoRoot,
    fixtureCurrentPrHeadSha: HEAD_A,
    fixturePrState: 'OPEN',
    fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
    fixturePostReviewHeadSha: HEAD_A,
    fixtureReviewStdout: cleanTerminalPayload(),
    fixtureReviewerLayerOverrides: { Process: 'codex', User: 'claude' },
    fixtureEmulateWin32Selector: true,
    ...overrides,
  });
}

test('Issue #1111 canonical Browser-GPT PR command', async (suite) => {
  await suite.test('PR number is the only required target argument', () => {
    assert.deepEqual(parsePackGptReviewArgs(['--pr-number', '1111']), {
      prNumber: 1111,
      timeoutSeconds: undefined,
    });
    assert.throws(() => parsePackGptReviewArgs([]), /--pr-number is required/);
    assert.throws(
      () => parsePackGptReviewArgs(['--pr-number', '1111', '--head-sha', HEAD_A]),
      /unknown argument '--head-sha'/,
    );
    assert.match(packGptReviewUsage(), /npm run pack-gpt-review -- --pr-number <n>/);
    assert.match(packGptReviewUsage(), /does not accept a caller-supplied head SHA/);
  });

  await suite.test('fresh PR-only run binds GPT and emits one start indication', async () => {
    await withHarnessEnvironment(async ({ storeRoot, capture, engagement, invocationLog }) => {
      const stderr: string[] = [];
      const execution = await runPackGptReviewCommand({ prNumber: 1111, timeoutSeconds: 37 }, {
        env: process.env,
        stderr: { write: (chunk) => stderr.push(chunk) },
        startReview: runnerFor(storeRoot),
      });

      assert.equal(execution.exitCode, 0);
      assert.equal(execution.result.ok, true);
      assert.equal(execution.result.created, true);
      assert.equal(stderr.length, 1);
      assert.match(
        stderr[0]!,
        new RegExp(`started pr=1111 head=${HEAD_A} run=prr-[a-z0-9]+ timeout_seconds=37`),
      );
      assert.equal(JSON.parse(readFileSync(invocationLog, 'utf8').trim()).reviewer, 'gpt');
      assert.equal(readFileSync(engagement, 'utf8').trim().split('\n').length, 1);
      assert.equal(JSON.parse(readFileSync(capture, 'utf8')).commitId, HEAD_A);
      assert.equal(process.env.PACK_REVIEWER, 'codex');
      assert.equal(process.env[PACK_REVIEW_BOUND_REVIEWER_ENV], undefined);
    });
  });

  await suite.test('same-head terminal reuse is non-zero and sends no second GPT request', async () => {
    await withHarnessEnvironment(async ({ storeRoot, engagement }) => {
      const first = await runPackGptReviewCommand({ prNumber: 1111 }, {
        env: process.env,
        stderr: { write: () => undefined },
        startReview: runnerFor(storeRoot),
      });
      const secondStderr: string[] = [];
      const second = await runPackGptReviewCommand({ prNumber: 1111 }, {
        env: process.env,
        stderr: { write: (chunk) => secondStderr.push(chunk) },
        startReview: runnerFor(storeRoot),
      });

      assert.equal(first.exitCode, 0);
      assert.equal(second.exitCode, 1);
      assert.deepEqual(
        {
          outcome: second.result.outcome,
          reason: second.result.reason,
          runnerReason: second.result.runnerReason,
          prNumber: second.result.prNumber,
          headSha: second.result.headSha,
        },
        {
          outcome: 'review_not_started',
          reason: 'review_not_started',
          runnerReason: 'terminal_run_exists',
          prNumber: 1111,
          headSha: HEAD_A,
        },
      );
      assert.equal(secondStderr.length, 0);
      assert.equal(readFileSync(engagement, 'utf8').trim().split('\n').length, 1);
    });
  });

  await suite.test('runner no-start reasons remain actionable non-success', async () => {
    for (const runnerReason of ['active_run_exists', 'terminal_run_exists', 'start_claim_refused']) {
      const execution = await runPackGptReviewCommand({ prNumber: 1111 }, {
        env: process.env,
        stderr: { write: () => undefined },
        startReview: async () => ({
          ok: runnerReason !== 'start_claim_refused',
          created: false,
          reused: true,
          reason: runnerReason,
          prNumber: 1111,
          headSha: HEAD_A,
          runId: 'prr-existing',
        }),
      });
      assert.equal(execution.exitCode, 1);
      assert.equal(execution.result.outcome, 'review_not_started');
      assert.equal(execution.result.reason, 'review_not_started');
      assert.equal(execution.result.runnerReason, runnerReason);
      assert.equal(execution.result.prNumber, 1111);
      assert.equal(execution.result.headSha, HEAD_A);
    }
  });

  await suite.test('closed PR fails before reviewer engagement', async () => {
    await withHarnessEnvironment(async ({ storeRoot, engagement }) => {
      const execution = await runPackGptReviewCommand({ prNumber: 1111 }, {
        env: process.env,
        stderr: { write: () => undefined },
        startReview: runnerFor(storeRoot, { fixturePrState: 'CLOSED' }),
      });

      assert.equal(execution.exitCode, 1);
      assert.equal(execution.result.outcome, 'review_target_unavailable');
      assert.match(String(execution.result.reason), /PR #1111 is not open/);
      assert.equal(existsSync(engagement), false);
    });
  });

  await suite.test('timeout stays non-zero after one foreground start indication', async () => {
    await withHarnessEnvironment(async ({ storeRoot }) => {
      const stderr: string[] = [];
      const execution = await runPackGptReviewCommand({ prNumber: 1111, timeoutSeconds: 2 }, {
        env: process.env,
        stderr: { write: (chunk) => stderr.push(chunk) },
        startReview: runnerFor(storeRoot, {
          fixtureReviewStdout: undefined,
          fixtureReviewTimedOut: true,
        }),
      });

      assert.equal(execution.exitCode, 1);
      assert.equal(execution.result.created, true);
      assert.equal(execution.result.status, 'timed_out');
      assert.match(String(execution.result.reason), /reviewer process timed out/);
      assert.equal(stderr.length, 1);
      assert.match(stderr[0]!, /timeout_seconds=2/);
    });
  });
});
