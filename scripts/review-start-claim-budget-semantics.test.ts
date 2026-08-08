import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveClaimLifecycleConfig } from '../docs/review-start-claim-lifecycle.mjs';

describe('review-start claim budget after the #1248 hard cut', () => {
  it('keeps the bounded budget in the TypeScript lifecycle authority', () => {
    const config = resolveClaimLifecycleConfig(
      { readinessEnvelopeMs: 30_000 },
      { OPK_REVIEW_CLAIM_READINESS_ENVELOPE_MS: '90000' },
    );
    expect(config.readinessEnvelopeMs).toBe(30_000);
    expect(config.holdBudgetMs).toBeLessThanOrEqual(config.readinessEnvelopeMs);
    expect(config.reaperPeriodSeconds).toBeLessThanOrEqual(30);
  });

  it('does not retain a PowerShell budget or claim bridge', () => {
    expect(existsSync(path.resolve('scripts/lib/Review-StartClaimLifecycle.ps1'))).toBe(false);
    const store = readFileSync(path.resolve('scripts/lib/review-start-claim-store.ts'), 'utf8');
    expect(store).toContain('confirmReviewStartClaimLaunchGate');
    expect(store).not.toContain('Review-StartClaimLifecycle.ps1');
  });
});
