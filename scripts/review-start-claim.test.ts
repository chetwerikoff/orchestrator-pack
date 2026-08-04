import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acquireReviewStartClaim,
  completeReviewStartClaim,
  getActiveRecords,
} from './lib/review-start-claim-store.ts';

describe('review-start claim TypeScript authority', () => {
  it('admits one exact PR/head owner and rejects an overlapping owner', () => {
    const namespace = mkdtempSync(path.join(os.tmpdir(), 'opk-claim-authority-'));
    try {
      const input = {
        projectId: 'orchestrator-pack',
        prNumber: 1248,
        headSha: 'c'.repeat(40),
        surface: 'claim-authority-test',
        startReason: 'claim-authority-test',
        namespace,
        reviewRuns: [],
      };
      const first = acquireReviewStartClaim(input);
      const second = acquireReviewStartClaim({ ...input, surface: 'overlap-test' });
      expect(first.acquired, JSON.stringify(first)).toBe(true);
      expect(second).toMatchObject({ acquired: false, reason: 'claimed' });
      expect(getActiveRecords(namespace)).toHaveLength(1);
      expect(completeReviewStartClaim(first, 'test_complete')).toMatchObject({ ok: true });
      expect(getActiveRecords(namespace)).toHaveLength(0);
    } finally {
      rmSync(namespace, { recursive: true, force: true });
    }
  });

  it('keeps the removed PowerShell bridge absent', () => {
    expect(existsSync(path.resolve('scripts/lib/Review-StartClaimLifecycle.ps1'))).toBe(false);
  });
});
