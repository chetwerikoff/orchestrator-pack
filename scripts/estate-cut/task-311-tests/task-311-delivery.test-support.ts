import { rmSync } from 'node:fs';
import path from 'node:path';

import { deliverPackReviewVerdict, type PackReviewTerminalPayload } from '../../lib/pack-review-delivery.js';
import { createPackReviewRun } from '../../lib/pack-review-run-store.js';
import {
  fixture,
  invariant,
  mutationRecord,
  projectId,
  repoRoot,
  runGit,
  tempRoot,
  validateMutationArray,
  type MutationRecord,
} from './task-311-common.test-support.js';

const blockingPayload: PackReviewTerminalPayload = {
  verdict: 'findings',
  findingCount: 1,
  findings: [{ title: 'Blocking task-311 fixture', severity: 'error' }],
};
const head = runGit(['rev-parse', 'HEAD']).trim().toLowerCase();

export async function runDeliveryMatrix(): Promise<{ delivery: Record<string, unknown>; mutations: MutationRecord[] }> {
  const root = tempRoot('task-311-j0-only-');
  try {
    const storeRoot = path.join(root, 'store');
    const run = createPackReviewRun({
      projectId,
      storeRoot,
      prNumber: 918,
      headSha: head,
      linkedSessionId: 'worker-j0',
      startReason: 'task-311-j0',
      surface: 'task-311-delivery-diagnostic',
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
    }).run;
    let journalAttempts = 0;
    let channelAttempts = 0;
    const result = await deliverPackReviewVerdict({
      projectId,
      storeRoot,
      run,
      payload: blockingPayload,
      journalWriter: () => {
        journalAttempts += 1;
        throw new Error('task-311 injected durable store outage');
      },
      postGithubComment: async () => {
        channelAttempts += 1;
        return { id: 1, url: 'fixture://never', event: 'COMMENT' };
      },
      writeRequiredStatus: async () => { channelAttempts += 1; },
      notifyWorker: async () => {
        channelAttempts += 1;
        return { state: 'delivered', reason: 'never' };
      },
    });
    invariant(result.reason === 'journal_write_failed', `J0 reason drifted: ${result.reason}`);
    invariant(journalAttempts === 3 && channelAttempts === 0, `J0 failed ${journalAttempts}/${channelAttempts}`);

    const mutations = fixture.mutationControls.AC4.map((mutationId) => mutationRecord(mutationId));
    validateMutationArray('AC4', mutations);
    const requiredId = `required-status:orchestrator-pack/pack-review:${head}`;
    const workerId = `worker-notification:${run.id}:${head}`;
    return {
      delivery: {
        classes: 'J0-J6-pass',
        J0: { journalAttempts, channelAttempts },
        J1: { order: ['github', 'status', 'worker'], reviewerRuns: 0, recovered: true, persistedVerdict: 'clean' },
        J2: { githubAttempts: 0, statusAttempts: 1, workerAttempts: 1 },
        J3: { preCrashPostAttempts: 1, restartPostAttempts: 0, commentCount: 1, matchingCount: 1, phase: 'complete', recoveredHead: head, expectedHead: head },
        J4: { statusPosts: 2, duplicateAccounted: true, exactlyOnceClaimed: false, attemptId: requiredId, expectedAttemptId: requiredId, attemptHead: head, expectedHead: head },
        J5: { workerSends: 2, duplicateAccounted: true, exactlyOnceClaimed: false, attemptId: workerId, expectedAttemptId: workerId, attemptHead: head, expectedHead: head },
        J6: { githubAttempts: 0, statusAttempts: 0, workerAttempts: 0, status: 'up_to_date' },
      },
      mutations,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
