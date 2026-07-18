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
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  packReviewDeliveryNeedsResume,
  resumePackReviewVerdictDelivery,
  sendPackReviewWorkerNotification,
} from './lib/pack-review-delivery.js';
import {
  createPackReviewRun,
  getPackReviewRun,
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
  reason: string = state,
): PackReviewDeliveryOutcome {
  return {
    state,
    recordedAtUtc: '2026-07-17T12:00:00.000Z',
    reason,
    idempotencyKey,
  };
}

function createRun(storeRoot: string): PackReviewRunRecord {
  return createPackReviewRun({
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
}

function journalFields(run: PackReviewRunRecord): Pick<PackReviewRunRecord,
  'reviewVerdict' | 'findingCount' | 'findings' | 'journalOutcome'> {
  return {
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
  };
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pack review worker notification admission (Issue #894)', () => {
  it.each(['failed', 'escalated'] as const)(
    'treats terminal %s worker outcomes as complete instead of automatic resume',
    (workerState) => {
      const storeRoot = tempRoot(`opk-worker-terminal-${workerState}-`);
      const run = createRun(storeRoot);
      const terminal = updatePackReviewRun(run.id, {
        status: 'changes_requested',
        latestRunStatus: 'changes_requested',
        ...journalFields(run),
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

  it.each(['failed', 'escalated'] as const)(
    'preserves terminal %s worker outcome while another channel resumes',
    async (workerState) => {
      const storeRoot = tempRoot(`opk-worker-terminal-other-channel-${workerState}-`);
      const run = createRun(storeRoot);
      const workerOutcome = deliveryOutcome(
        workerState,
        `worker-notification:${run.id}:${HEAD_SHA}`,
        `worker_${workerState}`,
      );
      const journaled = updatePackReviewRun(run.id, {
        status: 'changes_requested',
        latestRunStatus: 'changes_requested',
        ...journalFields(run),
        deliveryOutcomes: {
          githubComment: deliveryOutcome(
            'failed',
            `github-comment:${run.id}:${HEAD_SHA}`,
            'comment_channel_down',
          ),
          requiredStatus: deliveryOutcome(
            'succeeded',
            `required-status:orchestrator-pack/pack-review:${HEAD_SHA}`,
          ),
          workerNotification: workerOutcome,
        },
      }, { projectId: 'orchestrator-pack', storeRoot });
      const postGithubComment = vi.fn(async () => {
        updatePackReviewRun(run.id, {
          githubReviewId: 89402,
          githubReviewUrl: 'fixture://review/89402',
          githubReviewEvent: 'COMMENT',
          githubReviewReconciliation: {
            phase: 'complete',
          } as PackReviewRunRecord['githubReviewReconciliation'],
        }, { projectId: 'orchestrator-pack', storeRoot });
        return { id: 89402, url: 'fixture://review/89402', event: 'COMMENT' as const };
      });
      const writeRequiredStatus = vi.fn(async () => undefined);
      const notifyWorker = vi.fn(async () => ({ state: 'delivered' as const, reason: 'unexpected_retry' }));

      expect(packReviewDeliveryNeedsResume(journaled)).toBe(true);
      const result = await resumePackReviewVerdictDelivery({
        projectId: 'orchestrator-pack',
        storeRoot,
        run: journaled,
        postGithubComment,
        writeRequiredStatus,
        notifyWorker,
      });

      expect(result).toMatchObject({ ok: true, status: 'changes_requested' });
      expect(postGithubComment).toHaveBeenCalledTimes(1);
      expect(writeRequiredStatus).not.toHaveBeenCalled();
      expect(notifyWorker).not.toHaveBeenCalled();
      expect(getPackReviewRun(run.id, { projectId: 'orchestrator-pack', storeRoot })).toMatchObject({
        status: 'changes_requested',
        deliveryOutcomes: {
          githubComment: { state: 'succeeded' },
          requiredStatus: { state: 'succeeded' },
          workerNotification: workerOutcome,
        },
      });
    },
  );

  it.each(['failed', 'escalated'] as const)(
    'terminalizes a reviewing run after persisted %s worker outcome without retrying any channel',
    async (workerState) => {
      const storeRoot = tempRoot(`opk-worker-terminal-before-run-terminal-${workerState}-`);
      const run = createRun(storeRoot);
      const workerOutcome = deliveryOutcome(
        workerState,
        `worker-notification:${run.id}:${HEAD_SHA}`,
        `worker_${workerState}`,
      );
      const journaled = updatePackReviewRun(run.id, {
        status: 'reviewing',
        latestRunStatus: 'reviewing',
        ...journalFields(run),
        githubReviewId: 89403,
        githubReviewUrl: 'fixture://review/89403',
        githubReviewEvent: 'COMMENT',
        githubReviewReconciliation: {
          phase: 'complete',
        } as PackReviewRunRecord['githubReviewReconciliation'],
        deliveryOutcomes: {
          githubComment: deliveryOutcome('succeeded', `github-comment:${run.id}:${HEAD_SHA}`),
          requiredStatus: deliveryOutcome(
            'succeeded',
            `required-status:orchestrator-pack/pack-review:${HEAD_SHA}`,
          ),
          workerNotification: workerOutcome,
        },
      }, { projectId: 'orchestrator-pack', storeRoot });
      const postGithubComment = vi.fn(async () => ({
        id: 89404,
        url: 'fixture://review/89404',
        event: 'COMMENT' as const,
      }));
      const writeRequiredStatus = vi.fn(async () => undefined);
      const notifyWorker = vi.fn(async () => ({ state: 'delivered' as const, reason: 'unexpected_retry' }));

      expect(packReviewDeliveryNeedsResume(journaled)).toBe(true);
      const result = await resumePackReviewVerdictDelivery({
        projectId: 'orchestrator-pack',
        storeRoot,
        run: journaled,
        postGithubComment,
        writeRequiredStatus,
        notifyWorker,
      });

      expect(result).toMatchObject({ ok: true, status: 'changes_requested' });
      expect(postGithubComment).not.toHaveBeenCalled();
      expect(writeRequiredStatus).not.toHaveBeenCalled();
      expect(notifyWorker).not.toHaveBeenCalled();
      expect(getPackReviewRun(run.id, { projectId: 'orchestrator-pack', storeRoot })).toMatchObject({
        status: 'changes_requested',
        latestRunStatus: 'changes_requested',
        deliveryOutcomes: {
          workerNotification: workerOutcome,
        },
      });
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
        "appendFileSync(process.env.PACK_REVIEW_FAKE_AO_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');",
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

      const invocations = readFileSync(aoLog, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
      const sends = invocations.filter((args) => args[0] === 'send'
        && args.includes('--session')
        && args.includes('--message'));
      expect(sends).toHaveLength(1);
      expect(readFileSync(dispatchJournal, 'utf8')).toContain(deliveryKey);
    },
  );
});
