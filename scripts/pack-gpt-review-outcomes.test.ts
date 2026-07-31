import { describe, expect, it } from 'vitest';
import { runPackGptReviewCommand } from './pack-gpt-review.js';
import { PACK_REVIEW_BOUND_REVIEWER_ENV } from './lib/resolve-pack-reviewer.js';

const HEAD = 'b'.repeat(40);

function refusedRunner(
  env: NodeJS.ProcessEnv,
  refusalReason: string,
  status?: string,
): {
  startReview: NonNullable<Parameters<typeof runPackGptReviewCommand>[1]>['startReview'];
  browserSendCount: () => number;
} {
  let sends = 0;
  return {
    startReview: async (input) => {
      expect(env[PACK_REVIEW_BOUND_REVIEWER_ENV]).toBe('gpt');
      if (refusalReason.length > 0) {
        return {
          ok: false,
          created: false,
          reused: true,
          reason: refusalReason,
          prNumber: input.prNumber,
          headSha: HEAD,
          ...(status ? { status } : {}),
        };
      }
      sends += 1;
      return { ok: true, created: true, prNumber: input.prNumber, headSha: HEAD };
    },
    browserSendCount: () => sends,
  };
}

describe('canonical Browser-GPT no-start outcomes (Issue #1111)', () => {
  it('maps an active same-head run to review_not_started without a GPT send', async () => {
    const env: NodeJS.ProcessEnv = { PACK_REVIEWER: 'codex' };
    const stderr: string[] = [];
    const runner = refusedRunner(env, 'active_run_exists', 'running');

    const execution = await runPackGptReviewCommand({ prNumber: 1139 }, {
      env,
      stderr: { write: (chunk) => stderr.push(chunk) },
      startReview: runner.startReview,
    });

    expect(execution.exitCode).toBe(1);
    expect(execution.result).toMatchObject({
      outcome: 'review_not_started',
      runnerReason: 'active_run_exists',
      prNumber: 1139,
      headSha: HEAD,
      status: 'running',
    });
    expect(runner.browserSendCount()).toBe(0);
    expect(stderr).toEqual([]);
    expect(env.PACK_REVIEWER).toBe('codex');
    expect(env[PACK_REVIEW_BOUND_REVIEWER_ENV]).toBeUndefined();
  });

  it('maps start-claim refusal to review_not_started without a GPT send', async () => {
    const env: NodeJS.ProcessEnv = {
      PACK_REVIEWER: 'claude',
      [PACK_REVIEW_BOUND_REVIEWER_ENV]: 'codex',
    };
    const stderr: string[] = [];
    const runner = refusedRunner(env, 'claim_already_active');

    const execution = await runPackGptReviewCommand({ prNumber: 1139 }, {
      env,
      stderr: { write: (chunk) => stderr.push(chunk) },
      startReview: runner.startReview,
    });

    expect(execution.exitCode).toBe(1);
    expect(execution.result).toMatchObject({
      outcome: 'review_not_started',
      runnerReason: 'claim_already_active',
      prNumber: 1139,
      headSha: HEAD,
    });
    expect(runner.browserSendCount()).toBe(0);
    expect(stderr).toEqual([]);
    expect(env.PACK_REVIEWER).toBe('claude');
    expect(env[PACK_REVIEW_BOUND_REVIEWER_ENV]).toBe('codex');
  });
});
