import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import {
  acquireReviewStartClaim,
  bindReviewStartClaimToInitiatingRun,
  completeAfterRunInvoke,
  completeReviewStartClaim,
  getActiveRecords,
} from './lib/review-start-claim-store.ts';
import {
  createPackReviewRun, setPackReviewRunTerminal, updatePackReviewRun,
} from './lib/pack-review-run-store.ts';

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
  function currentRunFixture() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'opk-2679-terminal-'));
    const namespace = path.join(root, 'claims');
    const storeRoot = path.join(root, 'runs');
    const projectId = 'orchestrator-pack';
    const prNumber = 267901;
    const headSha = 'e'.repeat(40);
    const makeRun = () => createPackReviewRun({
      projectId, storeRoot, prNumber, headSha,
      trustedPackRoot: process.cwd(), sourceRepoRoot: process.cwd(),
    }).run;
    const acquire = () => acquireReviewStartClaim({
      namespace, projectId, prNumber, headSha, surface: 'unit-owner',
      startReason: 'unit', reviewRuns: [],
    });
    return { root, namespace, storeRoot, projectId, prNumber, headSha, makeRun, acquire };
  }

  it.each(['failed', 'timed_out', 'cancelled'] as const)(
    'audits exact %s current-invocation terminal completion without a covering run', (status) => {
      const fx = currentRunFixture();
      try {
        const claim = fx.acquire();
        expect(claim.acquired).toBe(true);
        const run = fx.makeRun();
        expect(bindReviewStartClaimToInitiatingRun(claim, run.id, fx)).toMatchObject({
          ok: true, boundRunId: run.id,
        });
        setPackReviewRunTerminal(run.id, status, {}, fx);
        const began = performance.now();
        const outcome = completeAfterRunInvoke(claim, [], {
          runId: run.id, projectId: fx.projectId, storeRoot: fx.storeRoot,
        });
        expect(performance.now() - began).toBeLessThan(5_000);
        expect(outcome).toMatchObject({ ok: true, outcome: 'released_after_run_terminalized' });
        const terminal = JSON.parse(readFileSync(String(outcome.terminalPath), 'utf8'));
        const audit = JSON.parse(readFileSync(String(outcome.auditPath), 'utf8'));
        expect(terminal).toMatchObject({
          state: 'terminal', outcome: 'released_after_run_terminalized',
          runId: run.id, boundRunId: run.id, runStatus: status, latestRunStatus: status,
        });
        expect(audit).toMatchObject({
          outcome: 'released_after_run_terminalized', decisionSource: 'completion',
          runId: run.id, runStatus: status, latestRunStatus: status,
        });
        expect(getActiveRecords(fx.namespace)).toHaveLength(0);
      } finally {
        rmSync(fx.root, { recursive: true, force: true });
      }
    },
  );

  it('rejects an older failed run A and in-flight run B as current-write claim evidence', () => {
    const fx = currentRunFixture();
    try {
      const old = fx.makeRun();
      setPackReviewRunTerminal(old.id, 'failed', {}, fx);
      const live = fx.makeRun();
      expect(live.id).not.toBe(old.id);
      const claim = fx.acquire();
      expect(claim.acquired).toBe(true);
      expect(bindReviewStartClaimToInitiatingRun(claim, live.id, fx)).toMatchObject({ ok: true });
      expect(completeReviewStartClaim(claim, 'released_after_run_terminalized', [], {}, {
        runId: old.id, projectId: fx.projectId, storeRoot: fx.storeRoot,
      })).toMatchObject({ ok: false, reason: 'initiating_run_mismatch' });
      expect(completeReviewStartClaim(claim, 'released_after_run_terminalized', [], {}, {
        runId: live.id, projectId: fx.projectId, storeRoot: fx.storeRoot,
      })).toMatchObject({ ok: false, reason: 'initiating_terminal_evidence_missing' });
      // A stale consumer projection must not transform an on-disk running B into failed.
      updatePackReviewRun(live.id, { status: 'running', latestRunStatus: 'running' }, fx);
      expect(completeReviewStartClaim(claim, 'released_after_run_terminalized',
        [{ ...live, status: 'failed', latestRunStatus: 'failed', stale: true }], {}, {
          runId: live.id, projectId: fx.projectId, storeRoot: fx.storeRoot,
        })).toMatchObject({ ok: false, reason: 'initiating_terminal_evidence_missing' });
      expect(getActiveRecords(fx.namespace)).toHaveLength(1);
      setPackReviewRunTerminal(live.id, 'cancelled', {}, fx);
      expect(completeAfterRunInvoke(claim, [], { runId: live.id, projectId: fx.projectId, storeRoot: fx.storeRoot }))
        .toMatchObject({ ok: true, outcome: 'released_after_run_terminalized' });
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('rejects wrong store, identity, holder and pre-existing terminal resume authority', () => {
    const fx = currentRunFixture();
    try {
      const run = fx.makeRun();
      const claim = fx.acquire();
      expect(claim.acquired).toBe(true);
      expect(bindReviewStartClaimToInitiatingRun(claim, run.id, fx)).toMatchObject({ ok: true });
      setPackReviewRunTerminal(run.id, 'failed', {}, fx);
      // A journaled failed resume knows the ID, but has NO new terminal-write proof.
      expect(completeReviewStartClaim(claim, 'released_after_run_terminalized'))
        .toMatchObject({ ok: false, reason: 'current_terminal_write_required' });
      const evidence = { runId: run.id, projectId: fx.projectId, storeRoot: fx.storeRoot };
      expect(completeReviewStartClaim(claim, 'released_after_run_terminalized', [], {},
        { ...evidence, storeRoot: path.join(fx.root, 'wrong-store') }))
        .toMatchObject({ ok: false, reason: 'initiating_terminal_evidence_missing' });
      expect(completeReviewStartClaim(claim, 'released_after_run_terminalized', [], {},
        { ...evidence, projectId: 'another-project' }))
        .toMatchObject({ ok: false, reason: 'initiating_run_mismatch' });
      expect(completeReviewStartClaim(claim, 'released_after_run_terminalized', [], {},
        { ...evidence, runId: 'another-run-id' }))
        .toMatchObject({ ok: false, reason: 'initiating_run_mismatch' });
      const lost = { ...claim, claim: { ...claim.claim!,
        holder: { ...claim.claim!.holder, generation: 'lost-generation' },
      } };
      expect(completeReviewStartClaim(lost, 'released_after_run_terminalized', [], {}, evidence))
        .toMatchObject({ ok: false, reason: 'lost_ownership' });
      expect(getActiveRecords(fx.namespace)).toHaveLength(1);
      expect(completeReviewStartClaim(claim, 'test_cleanup')).toMatchObject({ ok: true });
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

});
