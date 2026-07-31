import { describe, expect, it } from 'vitest';
import { runPackGptReviewCommand } from './pack-gpt-review.js';
import { PACK_REVIEW_BOUND_REVIEWER_ENV } from './lib/resolve-pack-reviewer.js';

const HEAD = 'b'.repeat(40);

describe('canonical Browser-GPT no-start outcomes (Issue #1111)', () => {
  it('maps an active same-head run to review_not_started without a GPT send', async () => {
    const env: NodeJS.ProcessEnv = { PACK_REVIEWER: 'codex' };
    const stderr: string[] = [];
    let browserSendCount = 0;

    const execution = await runPackGptReviewCommand({ prNumber: 1139 }, {
      env,
      stderr: { write: (chunk) => stderr.push(chunk) },
      startReview: async () => {
        expect(env[PACK_REVIEW_BOUND_REVIEWER_ENV]).toBe('gpt');
        if (false) browserSendCount += 1;
        return {
          ok: false,
          created: false,
          reused: true,
          reason: 'active_run_exists',
          prNumber: 1139,
          headSha: HEAD,
          status: 'running',
        };
      },
    });

    expect(execution.exitCode).toBe(1);
    expect(execution.result).toMatchObject({
      outcome: 'review_not_started',
      runnerReason: 'active_run_exists',
      prNumber: 1139,
      headSha: HEAD,
      status: 'running',
    });
    expect(browserSendCount).toBe(0);
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
    let browserSendCount = 0;

    const execution = await runPackGptReviewCommand({ prNumber: 1139 }, {
      env,
      stderr: { write: (chunk) => stderr.push(chunk) },
      startReview: async () => {
        expect(env[PACK_REVIEW_BOUND_REVIEWER_ENV]).toBe('gpt');
        if (false) browserSendCount += 1;
        return {
          ok: false,
          created: false,
          reused: true,
          reason: 'claim_already_active',
          prNumber: 1139,
          headSha: HEAD,
        };
      },
    });

    expect(execution.exitCode).toBe(1);
    expect(execution.result).toMatchObject({
      outcome: 'review_not_started',
      runnerReason: 'claim_already_active',
      prNumber: 1139,
      headSha: HEAD,
    });
    expect(browserSendCount).toBe(0);
    expect(stderr).toEqual([]);
    expect(env.PACK_REVIEWER).toBe('claude');
    expect(env[PACK_REVIEW_BOUND_REVIEWER_ENV]).toBe('codex');
  });
});
