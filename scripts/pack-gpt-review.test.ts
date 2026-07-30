import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  packGptReviewUsage,
  parsePackGptReviewArgs,
  runPackGptReviewCommand,
} from './pack-gpt-review.js';
import { startPackReview } from './pack-review-runner.js';
import { PACK_REVIEW_BOUND_REVIEWER_ENV } from './lib/resolve-pack-reviewer.js';

const repoRoot = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const HEAD_A = 'a'.repeat(40);
const tempRoots: string[] = [];
const originalEnv = { ...process.env };

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function cleanTerminalPayload(): string {
  return JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] });
}

function harnessEnv(storeRoot: string): {
  capture: string;
  engagement: string;
  invocationLog: string;
} {
  const capture = path.join(storeRoot, 'github-review.json');
  const engagement = path.join(storeRoot, 'gpt-engagements.jsonl');
  const invocationLog = path.join(storeRoot, 'invocations.jsonl');
  process.env.OPK_VITEST_HARNESS = '1';
  process.env.PACK_REVIEWER = 'codex';
  process.env.PACK_REVIEW_GITHUB_REVIEW_CAPTURE_FILE = capture;
  process.env.PACK_REVIEW_RUNNER_GPT_ENGAGEMENT_FILE = engagement;
  process.env.PACK_REVIEW_RUNNER_INVOCATION_LOG = invocationLog;
  process.env.AO_BASE_DIR = path.join(storeRoot, 'ao-base');
  return { capture, engagement, invocationLog };
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

afterEach(() => {
  process.env = { ...originalEnv };
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('canonical Browser-GPT PR command (Issue #1111)', () => {
  it('documents PR number as the only required target argument', () => {
    expect(parsePackGptReviewArgs(['--pr-number', '1111'])).toEqual({
      prNumber: 1111,
      timeoutSeconds: undefined,
    });
    expect(() => parsePackGptReviewArgs([])).toThrow('--pr-number is required');
    expect(() => parsePackGptReviewArgs(['--pr-number', '1111', '--head-sha', HEAD_A])).toThrow("unknown argument '--head-sha'");
    expect(packGptReviewUsage()).toContain('npm run pack-gpt-review -- --pr-number <n>');
    expect(packGptReviewUsage()).toContain('does not accept a caller-supplied head SHA');
  });

  it('resolves a PR-only target, binds GPT over conflicting persistent layers, and emits one start indication', async () => {
    const storeRoot = tempRoot('opk-issue-1111-fresh-');
    const { capture, engagement, invocationLog } = harnessEnv(storeRoot);
    const stderr: string[] = [];

    const execution = await runPackGptReviewCommand({ prNumber: 1111, timeoutSeconds: 37 }, {
      env: process.env,
      stderr: { write: (chunk) => stderr.push(chunk) },
      startReview: runnerFor(storeRoot),
    });

    expect(execution.exitCode).toBe(0);
    expect(execution.result.ok).toBe(true);
    expect(execution.result.created).toBe(true);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(new RegExp(`started pr=1111 head=${HEAD_A} run=prr-[a-z0-9]+ timeout_seconds=37`));
    expect(JSON.parse(readFileSync(invocationLog, 'utf8').trim()).reviewer).toBe('gpt');
    expect(readFileSync(engagement, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(readFileSync(capture, 'utf8')).commitId).toBe(HEAD_A);
    expect(process.env.PACK_REVIEWER).toBe('codex');
    expect(process.env[PACK_REVIEW_BOUND_REVIEWER_ENV]).toBeUndefined();
  });

  it('maps terminal same-head reuse to review_not_started and sends no second GPT request', async () => {
    const storeRoot = tempRoot('opk-issue-1111-terminal-reuse-');
    const { engagement } = harnessEnv(storeRoot);
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

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(1);
    expect(second.result).toMatchObject({
      ok: false,
      created: false,
      outcome: 'review_not_started',
      reason: 'review_not_started',
      runnerReason: 'terminal_run_exists',
      prNumber: 1111,
      headSha: HEAD_A,
    });
    expect(secondStderr).toHaveLength(0);
    expect(readFileSync(engagement, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it.each(['active_run_exists', 'terminal_run_exists', 'start_claim_refused'])(
    'preserves runner reason %s in a deterministic non-success result',
    async (runnerReason) => {
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

      expect(execution.exitCode).toBe(1);
      expect(execution.result).toMatchObject({
        outcome: 'review_not_started',
        reason: 'review_not_started',
        runnerReason,
        prNumber: 1111,
        headSha: HEAD_A,
      });
    },
  );

  it('fails a closed PR before reviewer engagement', async () => {
    const storeRoot = tempRoot('opk-issue-1111-closed-');
    const { engagement } = harnessEnv(storeRoot);
    const execution = await runPackGptReviewCommand({ prNumber: 1111 }, {
      env: process.env,
      stderr: { write: () => undefined },
      startReview: runnerFor(storeRoot, { fixturePrState: 'CLOSED' }),
    });

    expect(execution.exitCode).toBe(1);
    expect(execution.result).toMatchObject({
      ok: false,
      created: false,
      outcome: 'review_target_unavailable',
      prNumber: 1111,
    });
    expect(String(execution.result.reason)).toContain('PR #1111 is not open');
    expect(existsSync(engagement)).toBe(false);
  });

  it('returns a named non-zero timeout result after one foreground start indication', async () => {
    const storeRoot = tempRoot('opk-issue-1111-timeout-');
    harnessEnv(storeRoot);
    const stderr: string[] = [];
    const execution = await runPackGptReviewCommand({ prNumber: 1111, timeoutSeconds: 2 }, {
      env: process.env,
      stderr: { write: (chunk) => stderr.push(chunk) },
      startReview: runnerFor(storeRoot, {
        fixtureReviewStdout: undefined,
        fixtureReviewTimedOut: true,
      }),
    });

    expect(execution.exitCode).toBe(1);
    expect(execution.result.created).toBe(true);
    expect(execution.result.status).toBe('timed_out');
    expect(String(execution.result.reason)).toContain('reviewer process timed out');
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain('timeout_seconds=2');
  });
});
