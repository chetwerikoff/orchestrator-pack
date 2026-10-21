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
  createPackReviewRun, listPackReviewRuns, setPackReviewRunTerminal, updatePackReviewRun,
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
    const makeRun = (logicalRoundOrdinal?: number) => createPackReviewRun({
      projectId, storeRoot, prNumber, headSha,
      trustedPackRoot: process.cwd(), sourceRepoRoot: process.cwd(),
      ...(logicalRoundOrdinal ? {
        reviewCycleId: 't3-two-round-claim-fixture', logicalRoundOrdinal, logicalRoundCap: 2,
      } : {}),
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

  it('completes bound T3 round 2 over an older same-head findings terminal A', () => {
    const fx = currentRunFixture();
    try {
      const older = fx.makeRun(1);
      setPackReviewRunTerminal(older.id, 'changes_requested', {}, fx);
      const claim = fx.acquire();
      expect(claim.acquired).toBe(true);
      const current = fx.makeRun(2);
      expect(current.id).not.toBe(older.id);
      expect(bindReviewStartClaimToInitiatingRun(claim, current.id, fx))
        .toMatchObject({ ok: true, boundRunId: current.id });
      setPackReviewRunTerminal(current.id, 'up_to_date', {}, fx);
      const reviewRuns = listPackReviewRuns(fx);
      expect(reviewRuns.map((run) => run.id)).toEqual([current.id, older.id]);
      expect(reviewRuns.map((run) => run.logicalRoundOrdinal)).toEqual([2, 1]);

      // Before the fix, the key-only selector chooses older A and returns run_not_visible.
      const completion = completeReviewStartClaim(claim, 'run_started', reviewRuns);
      expect(completion).toMatchObject({ ok: true, outcome: 'run_started' });
      const terminal = JSON.parse(readFileSync(String(completion.terminalPath), 'utf8'));
      const audit = JSON.parse(readFileSync(String(completion.auditPath), 'utf8'));
      expect(terminal).toMatchObject({ state: 'terminal', outcome: 'run_started', boundRunId: current.id });
      expect(audit).toMatchObject({ outcome: 'run_started', decisionSource: 'completion' });
      expect(getActiveRecords(fx.namespace)).toHaveLength(0);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('finishes bound clean T3 round 2 promptly without a false fence from clean round 1', () => {
    const fx = currentRunFixture();
    try {
      const older = fx.makeRun(1);
      setPackReviewRunTerminal(older.id, 'up_to_date', {}, fx);
      const claim = fx.acquire();
      expect(claim.acquired).toBe(true);
      const current = fx.makeRun(2);
      expect(current.id).not.toBe(older.id);
      expect(bindReviewStartClaimToInitiatingRun(claim, current.id, fx))
        .toMatchObject({ ok: true, boundRunId: current.id });
      setPackReviewRunTerminal(current.id, 'up_to_date', {}, fx);
      const reviewRuns = listPackReviewRuns(fx);
      expect(reviewRuns.map((run) => run.id)).toEqual([current.id, older.id]);
      expect(reviewRuns.map((run) => run.logicalRoundOrdinal)).toEqual([2, 1]);

      const start = performance.now();
      const completion = completeAfterRunInvoke(claim, reviewRuns);
      expect(performance.now() - start).toBeLessThan(5_000);
      expect(completion).toMatchObject({ ok: true, outcome: 'run_started' });
      const terminal = JSON.parse(readFileSync(String(completion.terminalPath), 'utf8'));
      const audit = JSON.parse(readFileSync(String(completion.auditPath), 'utf8'));
      expect(terminal).toMatchObject({ state: 'terminal', outcome: 'run_started', boundRunId: current.id });
      expect(audit).toMatchObject({ outcome: 'run_started', decisionSource: 'completion' });
      expect(getActiveRecords(fx.namespace)).toHaveLength(0);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('rejects wrong bound run identity/head/project/status and retains unbound selection', () => {
    const fx = currentRunFixture();
    try {
      const older = fx.makeRun(1);
      setPackReviewRunTerminal(older.id, 'up_to_date', {}, fx);
      const current = fx.makeRun(2);
      setPackReviewRunTerminal(current.id, 'up_to_date', {}, fx);
      const claim = fx.acquire();
      expect(claim.acquired).toBe(true);
      expect(bindReviewStartClaimToInitiatingRun(claim, current.id, fx))
        .toMatchObject({ ok: true, boundRunId: current.id });

      const invalidRows = [
        { ...current, projectId: 'wrong-project' },
        { ...current, prNumber: fx.prNumber + 1 },
        { ...current, targetSha: 'f'.repeat(40) },
        { ...current, headSha: 'f'.repeat(40) },
        { ...current, id: older.id },
        { ...current, runId: older.id },
        { ...current, status: 'failed', latestRunStatus: 'failed' },
      ];
      for (const invalid of invalidRows) {
        expect(completeReviewStartClaim(claim, 'run_started', [invalid, older]))
          .toMatchObject({ ok: false, reason: 'run_not_visible' });
      }
      expect(getActiveRecords(fx.namespace)).toHaveLength(1);
      expect(completeReviewStartClaim(claim, 'run_started', listPackReviewRuns(fx)))
        .toMatchObject({ ok: true, outcome: 'run_started' });
      const unbound = fx.acquire();
      expect(unbound.acquired).toBe(true);
      expect(completeReviewStartClaim(unbound, 'run_started', [older]))
        .toMatchObject({ ok: true, outcome: 'run_started' });
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

});
