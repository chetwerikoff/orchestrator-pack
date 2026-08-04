import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acquireReviewStartClaim,
  bindReviewStartClaimToVisibleRun,
  completeReviewStartClaim,
} from './lib/review-start-claim-store.ts';

describe('review-start claim run binding through the TypeScript store', () => {
  it('binds only the visible exact PR/head run and then terminalizes it', () => {
    const namespace = mkdtempSync(path.join(os.tmpdir(), 'opk-claim-binding-'));
    try {
      const headSha = 'b'.repeat(40);
      const claim = acquireReviewStartClaim({
        projectId: 'orchestrator-pack',
        prNumber: 1248,
        headSha,
        surface: 'claim-binding-test',
        startReason: 'claim-binding-test',
        namespace,
        reviewRuns: [],
      });
      expect(claim.acquired, JSON.stringify(claim)).toBe(true);
      const run = { runId: 'prr-1248-binding', prNumber: 1248, targetSha: headSha, status: 'reviewing' };
      expect(bindReviewStartClaimToVisibleRun(claim, [run])).toMatchObject({
        ok: true,
        boundRunId: run.runId,
      });
      expect(completeReviewStartClaim(claim, 'run_started', [run])).toMatchObject({
        ok: true,
        outcome: 'run_started',
      });
    } finally {
      rmSync(namespace, { recursive: true, force: true });
    }
  });
});
