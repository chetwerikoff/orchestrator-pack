import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
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

describe('Issue #2607 positive dead-holder proof for explicit foreign reviewer replacement', () => {
  it('reclaims an exact generation only after owner death is proven before grace', () => {
    const namespace = mkdtempSync(path.join(os.tmpdir(), 'opk-claim-dead-2607-'));
    try {
      const headSha = 'a'.repeat(40);
      const claim = acquireReviewStartClaim({
        projectId: 'orchestrator-pack', prNumber: 2607, headSha,
        surface: 'pack-gpt-review', startReason: 'manual-browser-gpt',
        namespace, reviewRuns: [],
      });
      expect(claim.acquired).toBe(true);
      const deadPid = 2147483647;
      const file = claim.path!;
      const prior = JSON.parse(readFileSync(file, 'utf8'));
      prior.holder.pid = deadPid;
      prior.holder.startTimeTicks = '1';
      writeFileSync(file, JSON.stringify(prior), 'utf8');
      const original = {
        id: 'prr-2607-original', runId: 'prr-2607-original',
        projectId: 'orchestrator-pack', prNumber: 2607, targetSha: headSha,
        status: 'reviewing', canonicalRepository: 'chetwerikoff/orchestrator-pack',
        reviewCycleId: 'cycle-2607', logicalRoundOrdinal: 1,
        automaticBudgetDisposition: 'consume', resolvedReviewer: 'gpt',
        runnerPid: deadPid,
      };
      const recovered = acquireReviewStartClaim({
        projectId: 'orchestrator-pack', prNumber: 2607, headSha,
        surface: 'pack-gpt-review', startReason: 'manual-browser-gpt',
        namespace, reviewRuns: [original],
        takeover: {
          runId: original.id, existingReviewer: 'gpt', requestedReviewer: 'claude',
          runnerPid: deadPid, reviewCycleId: 'cycle-2607', logicalRoundOrdinal: 1,
          canonicalRepository: 'chetwerikoff/orchestrator-pack',
        },
      });
      expect(recovered).toMatchObject({
        acquired: true, recovered: true, reason: 'dead_foreign_reviewer_reclaimed',
      });
      expect(recovered.claim?.holder.pid).toBe(process.pid);
    } finally {
      rmSync(namespace, { recursive: true, force: true });
    }
  });

  it('refuses a reviewer switch when the original holder is demonstrably still alive', () => {
    const namespace = mkdtempSync(path.join(os.tmpdir(), 'opk-claim-live-2607-'));
    try {
      const headSha = 'b'.repeat(40);
      const original = {
        id: 'prr-2607-live', runId: 'prr-2607-live', projectId: 'orchestrator-pack',
        prNumber: 2608, targetSha: headSha, status: 'reviewing',
        reviewCycleId: 'cycle-2608', logicalRoundOrdinal: 1,
        automaticBudgetDisposition: 'consume', resolvedReviewer: 'gpt',
        canonicalRepository: 'chetwerikoff/orchestrator-pack', runnerPid: process.pid,
      };
      const claim = acquireReviewStartClaim({
        projectId: 'orchestrator-pack', prNumber: 2608, headSha,
        surface: 'pack-gpt-review', startReason: 'manual-browser-gpt',
        namespace, reviewRuns: [],
      });
      expect(claim.acquired).toBe(true);
      const denied = acquireReviewStartClaim({
        projectId: 'orchestrator-pack', prNumber: 2608, headSha,
        surface: 'pack-gpt-review', startReason: 'manual-browser-gpt',
        namespace, reviewRuns: [original],
        takeover: {
          runId: original.id, existingReviewer: 'gpt', requestedReviewer: 'codex',
          runnerPid: process.pid, reviewCycleId: 'cycle-2608', logicalRoundOrdinal: 1,
          canonicalRepository: 'chetwerikoff/orchestrator-pack',
        },
      });
      expect(denied.acquired).toBe(false);
    } finally {
      rmSync(namespace, { recursive: true, force: true });
    }
  });
});
