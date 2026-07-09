import { describe, expect, it, vi } from 'vitest';
import {
  classifyPreflightGhOutcome,
  computePreflightBackoffMs,
  evaluatePreflightRetryBudget,
  parseRateLimitHeadersFromStderr,
} from '../docs/review-start-preflight-shield.mjs';

describe('review-start preflight transient shield (#584)', () => {
  describe('mechanical classifier', () => {
    it('classifies primary rate-limit 403 as transient', () => {
      const result = classifyPreflightGhOutcome({
        exitCode: 1,
        stderr: 'HTTP 403: API rate limit exceeded for user',
      });
      expect(result.disposition).toBe('transient');
      expect(result.reason).toBe('rate_limit');
    });

    it('classifies 429 and 5xx as transient', () => {
      expect(classifyPreflightGhOutcome({ exitCode: 1, stderr: 'HTTP 429: Too Many Requests' }).disposition).toBe(
        'transient',
      );
      expect(classifyPreflightGhOutcome({ exitCode: 1, stderr: 'HTTP 502: Bad Gateway' }).disposition).toBe(
        'transient',
      );
    });

    it('classifies abuse-detection 403 as transient', () => {
      const result = classifyPreflightGhOutcome({
        exitCode: 1,
        stderr:
          'retry-after: 1\nHTTP 403: You have triggered an abuse detection mechanism. Please wait before retrying.',
      });
      expect(result.disposition).toBe('transient');
      expect(result.reason).toBe('rate_limit');
    });

    it('classifies missing gh binary as terminal', () => {
      expect(
        classifyPreflightGhOutcome({
          exitCode: -1,
          stderr: 'gh command not found: /nonexistent/review-start-gh-missing',
        }).reason,
      ).toBe('gh_binary_missing');
    });

    it('classifies auth and parse pollution as terminal', () => {
      expect(classifyPreflightGhOutcome({ exitCode: 1, stderr: 'HTTP 401: Bad credentials' }).disposition).toBe(
        'terminal',
      );
      expect(
        classifyPreflightGhOutcome({ exitCode: 0, parseOk: false, parseReason: 'structured_output_polluted' })
          .disposition,
      ).toBe('terminal');
    });

    it('honors retry-after headers and degrades without headers', () => {
      const headers = parseRateLimitHeadersFromStderr('retry-after: 2\nx-ratelimit-remaining: 0\n');
      const withHeaders = computePreflightBackoffMs({ attempt: 1, headers, injectedJitterMs: 0 });
      expect(withHeaders.backoffMs).toBe(2000);
      expect(withHeaders.headerDegraded).toBe(false);

      const withoutHeaders = computePreflightBackoffMs({ attempt: 1, headers: {}, injectedJitterMs: 50 });
      expect(withoutHeaders.headerDegraded).toBe(true);
      expect(withoutHeaders.backoffMs).toBeGreaterThanOrEqual(1050);
    });

    it('uses random jitter when injectedJitterMs is null', () => {
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      try {
        const result = computePreflightBackoffMs({ attempt: 1, headers: {}, injectedJitterMs: null });
        expect(result.backoffMs).toBe(1100);
        expect(result.headerDegraded).toBe(true);
      } finally {
        randomSpy.mockRestore();
      }
    });

    it('honors explicit zero injected jitter override', () => {
      const result = computePreflightBackoffMs({ attempt: 1, headers: {}, injectedJitterMs: 0 });
      expect(result.backoffMs).toBe(1000);
      expect(result.headerDegraded).toBe(true);
    });

    it('evaluates retry budget exhaustion', () => {
      const exhausted = evaluatePreflightRetryBudget({
        attempt: 4,
        maxAttempts: 4,
        startedMonotonicMs: 0,
        nowMonotonicMs: 1000,
        wallClockBudgetMs: 60_000,
      });
      expect(exhausted.canRetry).toBe(false);
    });

    it('allows the final configured capture when attempt equals maxAttempts', () => {
      const finalCapture = evaluatePreflightRetryBudget({
        attempt: 2,
        maxAttempts: 2,
        startedMonotonicMs: 0,
        nowMonotonicMs: 1000,
        wallClockBudgetMs: 60_000,
      });
      expect(finalCapture.canCapture).toBe(true);
      expect(finalCapture.canRetry).toBe(false);
      expect(finalCapture.attemptsRemaining).toBe(1);
    });
  });

});
