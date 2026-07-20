import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { startPackReview } from '../../pack-review-runner.js';
import {
  fixture,
  installEgressTrap,
  readCapture,
  repoRoot,
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
  it('diagnostic: drives runner claim, run-store and delivery without the reviewer wrapper', async () => {
    const trapRoot = tempRoot('task-311-egress-');
    const storeRoot = tempRoot('task-311-runner-');
    const claimRoot = tempRoot('task-311-claim-');
    const trap = installEgressTrap(trapRoot);
    const originalEnv = { ...process.env };
    try {
      const { row: session } = readCapture();
      const headSha = runGit(['rev-parse', 'HEAD']).trim().toLowerCase();
      const sessionId = String(session.id);
      const statusRows: Array<Record<string, unknown>> = [];
      const workerRows: Array<Record<string, unknown>> = [];
      process.env.OPK_VITEST_HARNESS = '1';
      process.env.AO_REVIEW_CLAIM_DIR = claimRoot;
      process.env.AO_REVIEW_START_MONOTONIC_NOW_MS = '1000';
      const result = await startPackReview({
        projectId: 'orchestrator-pack',
        sessionId,
        prNumber: fixture.assembly.prNumber,
        headSha,
        repoRoot,
        sourceRepoRoot: repoRoot,
        baseRef: 'origin/main',
        startReason: 'task_311_runner_diagnostic',
        surface: 'task-311-runner-diagnostic',
        storeRoot,
        fixtureRepoSlug: fixture.repoSlug,
        fixtureReviewStdout: JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] }),
        fixtureGithubReviewId: 31101,
        fixtureRequiredStatusWriter: async (request) => { statusRows.push({ ...request }); },
        fixtureWorkerNotifier: async (request) => {
          workerRows.push({ ...request, sessionId });
          return { state: 'delivered', reason: 'diagnostic_delivered' };
        },
      });
      expect(result).toMatchObject({ ok: true, created: true, status: 'up_to_date' });
      expect(statusRows.some((row) => row.state === 'success')).toBe(true);
      expect(workerRows).toHaveLength(1);
      expect(trap.attempts()).toEqual([]);
    } finally {
      trap.restore();
      for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
      for (const [key, value] of Object.entries(originalEnv)) process.env[key] = value;
      rmSync(trapRoot, { recursive: true, force: true });
      rmSync(storeRoot, { recursive: true, force: true });
      rmSync(claimRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
