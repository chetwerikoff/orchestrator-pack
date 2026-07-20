import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  BINDING_SOURCE_BACKFILL_RESOLVER,
  createDefaultPrSessionBindingCache,
  lookupBindingByPr,
  registerPrSessionBindingRecord,
  resolvePrSessionBindingForConsumer,
} from '../../../docs/pr-session-binding-cache.mjs';
import { preRunHeadReadyRecheck } from '../../../docs/review-head-ready.mjs';
import { resolveSessionPrBinding } from '../../../docs/session-pr-binding-resolver.mjs';
import {
  fixture,
  installEgressTrap,
  readCapture,
  runGit,
  tempRoot,
} from './task-311-common.test-support.js';

declare global {
  interface Array<T> {
    findLast(
      predicate: (value: T, index: number, array: T[]) => unknown,
      thisArg?: unknown,
    ): T | undefined;
  }
}

describe('TASK-311 real surviving review-cycle assembly gate', () => {
  it('diagnostic: drives the real pre-run and binding/cache subjects', () => {
    const trapRoot = tempRoot('task-311-egress-');
    const trap = installEgressTrap(trapRoot);
    try {
      const { row: session } = readCapture();
      const headSha = runGit(['rev-parse', 'HEAD']).trim().toLowerCase();
      const sessionId = String(session.id);
      const prNumber = fixture.assembly.prNumber;
      const openPr = {
        number: prNumber,
        headRefOid: headSha,
        headRefName: `issue-${prNumber}-task-311`,
        state: 'OPEN',
        repoSlug: fixture.repoSlug,
        headCommittedAt: '2026-07-06T05:00:00.000Z',
      };
      const checks = [
        { name: 'Verify orchestrator-pack structure', state: 'SUCCESS' },
        { name: 'PR scope guard', state: 'SUCCESS' },
        { name: 'Run pack contract tests', state: 'SUCCESS' },
        { name: 'Self-architect lint', state: 'SUCCESS' },
      ];
      const preRun = preRunHeadReadyRecheck({
        prNumber,
        headSha,
        sessionId,
        startReason: 'task_311_three_subject_gate',
      }, {
        openPrs: [openPr],
        reviewRuns: [],
        sessions: [session as any],
        ciChecks: checks,
        ownerResolution: { sessionId, reason: 'capture_owner', failClosed: false },
        nowMs: Date.parse('2026-07-19T02:00:00.000Z'),
        workerDeliveries: [],
      });
      expect(preRun.emitReviewRun, preRun.reason).toBe(true);

      const sessionBinding = resolveSessionPrBinding(session as any, [openPr], { headSha });
      expect(sessionBinding.bound).toBe(true);
      expect(sessionBinding.prNumber).toBe(prNumber);
      const store = createDefaultPrSessionBindingCache();
      const registered = registerPrSessionBindingRecord(store, {
        sessionId,
        prNumber,
        repoSlug: fixture.repoSlug,
        issueNumber: prNumber,
        headSha,
        source: BINDING_SOURCE_BACKFILL_RESOLVER,
        openPrs: [openPr],
      }, Date.parse('2026-07-19T02:00:00.000Z'));
      expect(registered.ok).toBe(true);
      const cacheRecord = lookupBindingByPr(store, fixture.repoSlug, prNumber);
      expect(cacheRecord).toMatchObject({ sessionId, prNumber, headSha });
      const consumer = resolvePrSessionBindingForConsumer({
        store,
        repoSlug: fixture.repoSlug,
        prNumber,
        headSha,
        sessions: [session as any],
        openPrs: [openPr],
        nowMs: Date.parse('2026-07-19T02:00:00.000Z'),
        writeBackfill: false,
        isLive: () => true,
      });
      expect(consumer).toMatchObject({ sessionId, source: 'cache', reason: 'cache_hit', failClosed: false });
      expect(trap.attempts()).toEqual([]);
    } finally {
      trap.restore();
      rmSync(trapRoot, { recursive: true, force: true });
    }
  });
});
