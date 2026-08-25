import { afterEach, describe, expect, it } from 'vitest';
import { runPackGptReviewCommand } from './pack-gpt-review.ts';

const HEAD_SHA = 'a'.repeat(40);

afterEach(() => {
  delete process.env.PACK_REVIEW_RUN_STALE_MINUTES;
});

describe('public Browser-GPT review timeout', () => {
  it('forwards the configured stale-run grace instead of a short live timeout', async () => {
    process.env.PACK_REVIEW_RUN_STALE_MINUTES = '20';
    let observedTimeout: unknown;

    const execution = await runPackGptReviewCommand({
      prNumber: 1608,
    }, {
      env: process.env,
      stderr: { write: () => undefined },
      startReview: async (input) => {
        observedTimeout = input.timeoutSeconds;
        return {
          created: false,
          reused: false,
          reason: 'fixture_timeout_capture',
          prNumber: 1608,
          headSha: HEAD_SHA,
          status: 'pending',
        };
      },
    });

    expect(execution.exitCode).toBe(1);
    expect(observedTimeout).toBe(1_200);
  });
});
