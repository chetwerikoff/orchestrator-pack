import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  packReviewDeliveryNeedsResume,
  sendPackReviewWorkerNotification,
} from './lib/pack-review-delivery.js';
import {
  createPackReviewRun,
  updatePackReviewRun,
  type PackReviewDeliveryOutcome,
  type PackReviewRunRecord,
} from './lib/pack-review-run-store.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEAD_SHA = '8'.repeat(40);
const originalEnv = { ...process.env };
const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function deliveryOutcome(
  state: PackReviewDeliveryOutcome['state'],
  idempotencyKey: string,
  reason = state,
): PackReviewDeliveryOutcome {
  return {
    state,
    recordedAtUtc: '2026-07-17T12:00:00.000Z',
    reason,
    idempotencyKey,
  };
}

afterEach(() => {
  process.env = { ...originalEnv };
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pack review worker notification admission (Issue #894)', () => {
  it.each(['failed', 'escalated'] as const)(
    'treats terminal %s worker outcomes as complete instead of automatic resume',
    (workerState) => {
      const storeRoot = tempRoot(`opk-worker-terminal-${workerState}-`);
      const run = createPackReviewRun({
        projectId: 'orchestrator-pack',
        storeRoot,
        prNumber: 894,
        headSha: HEAD_SHA,
        linkedSessionId: 'worker-894',
        startReason: 'test',
        surface: 'pack-review-worker-notification-test',
        trustedPackRoot: repoRoot,
        sourceRepoRoot: repoRoot,
      }).run;
      const terminal = updatePackReviewRun(run.id, {
        status: 'changes_requested',
        latestRunStatus: 'changes_requested',
        reviewVerdict: 'findings',
        findingCount: 1,
        findings: [{ severity: 'error' }],
        journalOutcome: {
          state: 'persisted',
          recordedAtUtc: '2026-07-17T12:00:00.000Z',
          reason: 'verdict_persisted',
          idempotencyKey: `verdict:${run.id}:${HEAD_SHA}`,
          attempts: 1,
        },
        githubReviewId: 89401,
        githubReviewReconciliation: {
          phase: 'complete',
        } as PackReviewRunRecord['githubReviewReconciliation'],
        deliveryOutcomes: {
          githubComment: deliveryOutcome('succeeded', `github-comment:${run.id}:${HEAD_SHA}`),
          requiredStatus: deliveryOutcome(
            'succeeded',
            `required-status:orchestrator-pack/pack-review:${HEAD_SHA}`,
          ),
          workerNotification: deliveryOutcome(
            workerState,
            `worker-notification:${run.id}:${HEAD_SHA}`,
          ),
        },
      }, { projectId: 'orchestrator-pack', storeRoot });

      expect(packReviewDeliveryNeedsResume(terminal)).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'uses gated deterministic send and suppresses a crash retry after dispatch',
    async () => {
      const root = tempRoot('opk-worker-notification-gated-');
      const fakeBin = path.join(root, 'bin');
      const aoLog = path.join(root, 'ao-send.log');
      const dispatchJournal = path.join(root, 'worker-message-dispatch.json');
      mkdirSync(fakeBin, { recursive: true });
      const fakeAo = path.join(fakeBin, 'ao');
      writeFileSync(fakeAo, [
        '#!/usr/bin/env node',
        "const { appendFileSync } = require('node:fs');",
        "appendFileSync(process.env.PACK_REVIEW_FAKE_AO_LOG, process.argv.slice(2).join(' ') + '\\n');",
        '',
      ].join('\n'), 'utf8');
      chmodSync(fakeAo, 0o755);

      const sessionId = 'worker-894-gated';
      const runId = 'prr-worker-notification-crash-boundary';
      const deliveryKey = `worker-notification:${runId}:${HEAD_SHA}`;
      const message = [
        'Pack review completed for PR #894.',
        `Run: ${runId}`,
        `Head: ${HEAD_SHA}`,
        'Verdict: findings',
        'Findings: 1',
        'Merge status: failure',
      ].join('\n');

      Object.assign(process.env, {
        OPK_VITEST_HARNESS: '1',
        PACK_REVIEW_WORKER_NOTIFICATION_REAL_ADAPTER: '1',
        PACK_REVIEW_WORKER_NOTIFICATION_FIXTURE_TARGET: `${sessionId}:${sessionId}`,
        AO_SESSION_ID: 'orchestrator-autonomous-surface',
        AO_BASE_DIR: path.join(root, 'ao-base'),
        AO_JOURNALED_SEND_ASSUME_CONTRACT: '1',
        AO_WORKER_MESSAGE_DISPATCH_JOURNAL: dispatchJournal,
        PACK_REVIEW_FAKE_AO_LOG: aoLog,
        PATH: `${fakeBin}:${originalEnv.PATH ?? ''}`,
      });

      const notify = () => sendPackReviewWorkerNotification({
        trustedPackRoot: repoRoot,
        sessionId,
        request: { message, idempotencyKey: deliveryKey },
      });
      expect(await notify()).toMatchObject({
        state: 'delivered',
        reason: 'explicit_send_dispatched',
      });
      expect(await notify()).toMatchObject({
        state: 'delivered',
        reason: 'journal_duplicate_no_op',
      });

      const sends = readFileSync(aoLog, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.startsWith('send ')
          && line.includes('--session')
          && line.includes('--message'));
      expect(sends).toHaveLength(1);
      expect(readFileSync(dispatchJournal, 'utf8')).toContain(deliveryKey);
    },
  );
});
