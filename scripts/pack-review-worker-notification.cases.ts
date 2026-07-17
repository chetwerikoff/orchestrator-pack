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
      const now = '2026-07-17T12:00:00.000Z';
      const terminal = updatePackReviewRun(run.id, {
        status: 'changes_requested',
        latestRunStatus: 'changes_requested',
        reviewVerdict: 'findings',
        findingCount: 1,
        findings: [{ severity: 'error' }],
        journalOutcome: {
          state: 'persisted',
          recordedAtUtc: now,
          reason: 'verdict_persisted',
          idempotencyKey: `verdict:${run.id}:${HEAD_SHA}`,
          attempts: 1,
        },
        githubReviewId: 89401,
        githubReviewUrl: 'fixture://review/89401',
        githubReviewEvent: 'COMMENT',
        githubReviewReconciliation: {
          schemaVersion: 1,
          event: 'COMMENT',
          phase: 'complete',
          actorLogin: 'fixture-pack-reviewer',
          commentBody: 'fixture',
          commentReviewId: 89401,
          commentReviewUrl: 'fixture://review/89401',
          pendingDismissalReviewIds: [],
          dismissedReviewIds: [],
          preparedAtUtc: now,
          updatedAtUtc: now,
        },
        deliveryOutcomes: {
          githubComment: {
            state: 'succeeded',
            recordedAtUtc: now,
            reason: 'comment_posted',
            idempotencyKey: `github-comment:${run.id}:${HEAD_SHA}`,
          },
          requiredStatus: {
            state: 'succeeded',
            recordedAtUtc: now,
            reason: 'status_failure',
            idempotencyKey: `required-status:orchestrator-pack/pack-review:${HEAD_SHA}`,
          },
          workerNotification: {
            state: workerState,
            recordedAtUtc: now,
            reason: `worker_${workerState}`,
            idempotencyKey: `worker-notification:${run.id}:${HEAD_SHA}`,
          },
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
        '#!/usr/bin/env bash',
        'printf "%s\\n" "$*" >> "$PACK_REVIEW_FAKE_AO_LOG"',
        'exit 0',
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

      process.env.OPK_VITEST_HARNESS = '1';
      process.env.PACK_REVIEW_WORKER_NOTIFICATION_REAL_ADAPTER = '1';
      process.env.PACK_REVIEW_WORKER_NOTIFICATION_FIXTURE_TARGET = `${sessionId}:${sessionId}`;
      process.env.AO_SESSION_ID = 'orchestrator-autonomous-surface';
      process.env.AO_BASE_DIR = path.join(root, 'ao-base');
      process.env.AO_JOURNALED_SEND_ASSUME_CONTRACT = '1';
      process.env.AO_WORKER_MESSAGE_DISPATCH_JOURNAL = dispatchJournal;
      process.env.PACK_REVIEW_FAKE_AO_LOG = aoLog;
      process.env.PATH = `${fakeBin}:${originalEnv.PATH ?? ''}`;

      const request = { message, idempotencyKey: deliveryKey };
      const first = await sendPackReviewWorkerNotification({
        trustedPackRoot: repoRoot,
        sessionId,
        request,
      });
      expect(first).toMatchObject({ state: 'delivered', reason: 'explicit_send_dispatched' });

      const resumed = await sendPackReviewWorkerNotification({
        trustedPackRoot: repoRoot,
        sessionId,
        request,
      });
      expect(resumed).toMatchObject({ state: 'delivered', reason: 'journal_duplicate_no_op' });

      const sends = readFileSync(aoLog, 'utf8').split(/\r?\n/).filter(Boolean);
      expect(sends).toHaveLength(1);
      expect(readFileSync(dispatchJournal, 'utf8')).toContain(deliveryKey);
    },
  );
});
