import { rmSync } from 'node:fs';

import {
  acquireReviewStartClaim,
  atomicWriteJson,
  completeReviewStartClaim,
  getActiveRecords,
  readClaimRecord,
  reaperSweep,
} from '../../lib/review-start-claim-store.ts';
import {
  invariant,
  jsonClone,
  mutationRecord,
  tempRoot,
  validateMutationArray,
  type MutationRecord,
} from './task-311-common.test-support.js';

function validateClaimMatrix(candidate: Record<string, unknown>): void {
  const matrix = candidate as any;
  invariant(matrix.classes === 'C1-C7-pass', 'claim class marker missing');
  invariant(matrix.C1?.winners === 1 && matrix.C1?.runStarts === 1, 'C1 failed');
  invariant(matrix.C2?.winners === 1 && matrix.C2?.activeCount === 1, 'C2 failed');
  invariant(matrix.C3?.firstAcquired === true && matrix.C3?.secondAcquired === false, 'C3 duplicate was not suppressed');
  invariant(matrix.C3?.sameOwner === true && matrix.C3?.loserReason === 'claimed', 'C3 live ownership drifted');
  invariant(matrix.C4?.covered === true && matrix.C4?.replacementStarted === false, 'C4 covering run did not suppress replacement');
  invariant(matrix.C5?.reclaimed === true && matrix.C5?.winners === 1 && matrix.C5?.activeCount === 1, 'C5 dead-owner recovery failed');
  invariant(matrix.C6?.blocked === true && matrix.C6?.runStarted === false && matrix.C6?.reason === 'foreign_holder_manual', 'C6 ambiguous ownership did not fail closed');
  invariant(matrix.C7?.firstAcquired === true && matrix.C7?.secondAcquired === true && matrix.C7?.activeCount === 2, 'C7 cross-key isolation failed');
}

function expectActualRowRed(
  baseline: Record<string, unknown>,
  mutationId: string,
  rowName: string,
  actualBadRow: Record<string, unknown>,
): MutationRecord {
  const candidate = jsonClone(baseline) as any;
  candidate[rowName] = actualBadRow;
  let red = false;
  try { validateClaimMatrix(candidate); } catch { red = true; }
  invariant(red, `AC3/${mutationId} actual faulty claim scenario stayed green`);
  validateClaimMatrix(baseline);
  return mutationRecord(mutationId);
}

function claim(namespace: string, prNumber: number, headSha: string, surface: string, reviewRuns: unknown[] = []) {
  return acquireReviewStartClaim({ prNumber, headSha, surface, namespace, reviewRuns });
}

export function runClaimMatrix(): { claim: Record<string, unknown>; mutations: MutationRecord[] } {
  const root = tempRoot('task-311-claim-');
  const shaA = 'a'.repeat(40);
  const shaB = 'b'.repeat(40);
  try {
    const ns1 = `${root}/c1`;
    const c1 = claim(ns1, 311, shaA, 'task-311-c1');
    const c1Run = { id: 'task-311-c1-run', prNumber: 311, targetSha: shaA, status: 'running' };
    const c1Complete = completeReviewStartClaim(c1, 'run_started', [c1Run]) as any;

    const ns2 = `${root}/c2`;
    const c2Rows = Array.from({ length: 6 }, (_, index) => claim(ns2, 312, shaA, `task-311-c2-${index}`));

    const ns3 = `${root}/c3`;
    const c3a = claim(ns3, 313, shaA, 'task-311-c3-a');
    const c3b = claim(ns3, 313, shaA, 'task-311-c3-b');

    const ns4 = `${root}/c4`;
    const c4a = claim(ns4, 314, shaA, 'task-311-c4-a');
    const c4Run = { id: 'task-311-c4-run', prNumber: 314, targetSha: shaA, status: 'running' };
    const c4b = claim(ns4, 314, shaA, 'task-311-c4-b', [c4Run]);

    const ns5 = `${root}/c5`;
    const c5old = claim(ns5, 315, shaA, 'task-311-c5-dead');
    const c5read = readClaimRecord(c5old.path!);
    invariant(c5read.ok && c5read.record, 'C5 seed unreadable');
    c5read.record.holder.pid = 2_147_483_000;
    delete c5read.record.holder.startTimeTicks;
    delete c5read.record.holder.bootIdHash;
    c5read.record.acquiredAtUtc = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    atomicWriteJson(c5old.path!, c5read.record);
    const c5sweep = reaperSweep({ namespace: ns5, projectId: 'orchestrator-pack', reviewRuns: [] }) as any;
    const c5Rows = Array.from({ length: 4 }, (_, index) => claim(ns5, 315, shaA, `task-311-c5-${index}`));

    const ns6 = `${root}/c6`;
    const c6old = claim(ns6, 316, shaA, 'task-311-c6-foreign');
    const c6read = readClaimRecord(c6old.path!);
    invariant(c6read.ok && c6read.record, 'C6 seed unreadable');
    c6read.record.holder.host = 'foreign-task-311.example';
    c6read.record.acquiredAtUtc = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    atomicWriteJson(c6old.path!, c6read.record);
    const c6sweep = reaperSweep({ namespace: ns6, projectId: 'orchestrator-pack', reviewRuns: [] }) as any;
    const c6retry = claim(ns6, 316, shaA, 'task-311-c6-retry');

    const ns7 = `${root}/c7`;
    const c7a = claim(ns7, 317, shaA, 'task-311-c7-a');
    const c7b = claim(ns7, 318, shaB, 'task-311-c7-b');

    const baseline: Record<string, unknown> = {
      classes: 'C1-C7-pass',
      C1: { winners: Number(c1.acquired), runStarts: Number(c1Complete.ok === true) },
      C2: { winners: c2Rows.filter((row) => row.acquired).length, activeCount: getActiveRecords(ns2).length },
      C3: { firstAcquired: c3a.acquired, secondAcquired: c3b.acquired, loserReason: c3b.reason, sameOwner: c3a.claim?.holder.processGuid === c3b.holder?.processGuid },
      C4: { covered: c4b.reason === 'covered_by_run', replacementStarted: c4b.acquired },
      C5: { reclaimed: c5sweep.results?.filter((row: any) => row.reclaimed).length === 1, winners: c5Rows.filter((row) => row.acquired).length, activeCount: getActiveRecords(ns5).length },
      C6: { blocked: c6sweep.results?.some((row: any) => row.blocking || row.manual) === true || c6retry.blocking === true, reason: c6retry.reason, runStarted: c6retry.acquired },
      C7: { firstAcquired: c7a.acquired, secondAcquired: c7b.acquired, activeCount: getActiveRecords(ns7).length },
    };
    validateClaimMatrix(baseline);
    const controls = {
      doubleAcquisition: { winners: 2, activeCount: 2 },
      liveClaimTheft: { firstAcquired: true, secondAcquired: true, loserReason: '', sameOwner: false },
      crossKeyInterference: { firstAcquired: true, secondAcquired: false, activeCount: 1 },
      staleNotRecovered: { reclaimed: false, winners: 0, activeCount: 1 },
      ambiguousRecovered: { blocked: false, reason: 'reclaimed', runStarted: true },
      duplicateVisibleRun: { covered: false, replacementStarted: true },
    };
    const mutations = [
      expectActualRowRed(baseline, 'double-acquisition', 'C2', controls.doubleAcquisition),
      expectActualRowRed(baseline, 'live-claim-theft', 'C3', controls.liveClaimTheft),
      expectActualRowRed(baseline, 'cross-key-interference', 'C7', controls.crossKeyInterference),
      expectActualRowRed(baseline, 'stale-claim-not-recovered', 'C5', controls.staleNotRecovered),
      expectActualRowRed(baseline, 'ambiguous-ownership-recovered', 'C6', controls.ambiguousRecovered),
      expectActualRowRed(baseline, 'duplicate-start-with-visible-run', 'C4', controls.duplicateVisibleRun),
    ];
    validateMutationArray('AC3', mutations);
    return { claim: baseline, mutations };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
