import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  deliverPackReviewVerdict,
  resumePackReviewVerdictDelivery,
  type PackReviewWorkerNotificationRequest,
} from './lib/pack-review-delivery.ts';
import {
  createPackReviewRun,
  getPackReviewRun,
  updatePackReviewRun,
  type PackReviewRunRecord,
} from './lib/pack-review-run-store.ts';
import { sendPackReviewWorkerNotification } from './lib/pack-review-worker-notification.ts';
import { DeterministicRuntimeAdapter } from './runtime/test-adapter.ts';
import type { RuntimeWorker } from './runtime/contracts.ts';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectId = 'orchestrator-pack';
const headSha = 'a'.repeat(40);

function writeSessionBinding(
  sessionRoot: string,
  sessionId: string,
  worker: RuntimeWorker,
): void {
  mkdirSync(sessionRoot, { recursive: true });
  writeFileSync(path.join(sessionRoot, `${sessionId}.json`), `${JSON.stringify({
    runtimeHandle: {
      runtime: worker.identity.runtime,
      id: worker.identity.id,
      generation: worker.identity.generation,
      data: {
        workspacePath: worker.workspacePath,
        headSha,
      },
    },
  })}\n`, 'utf8');
}

function persistedOutcome(
  state: 'succeeded' | 'delivered' | 'failed' | 'escalated',
  reason: string,
  idempotencyKey: string,
) {
  return {
    state,
    reason,
    idempotencyKey,
    recordedAtUtc: new Date().toISOString(),
  } as const;
}

function createBoundRun(input: {
  root: string;
  adapter: DeterministicRuntimeAdapter;
  prNumber: number;
  sessionId: string;
}): {
  run: PackReviewRunRecord;
  worker: RuntimeWorker;
  storeRoot: string;
  sessionRoot: string;
} {
  const storeRoot = path.join(input.root, 'run-store');
  const sessionRoot = path.join(input.root, 'sessions');
  const spawned = input.adapter.spawnWorker({
    title: `bound-review-worker-${input.prNumber}`,
    command: 'test-worker',
    workspace: repoRoot,
  });
  if (spawned.status !== 'ok') throw new Error('fixture_worker_spawn_failed');
  writeSessionBinding(sessionRoot, input.sessionId, spawned.value);
  const previousRoot = process.env.PACK_REVIEW_SESSION_METADATA_ROOT;
  process.env.PACK_REVIEW_SESSION_METADATA_ROOT = sessionRoot;
  try {
    const run = createPackReviewRun({
      projectId,
      storeRoot,
      prNumber: input.prNumber,
      headSha,
      linkedSessionId: input.sessionId,
      startReason: 'test',
      surface: 'generation-binding-test',
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      canonicalRepository: 'chetwerikoff/orchestrator-pack',
    }).run;
    return { run, worker: spawned.value, storeRoot, sessionRoot };
  } finally {
    if (previousRoot === undefined) delete process.env.PACK_REVIEW_SESSION_METADATA_ROOT;
    else process.env.PACK_REVIEW_SESSION_METADATA_ROOT = previousRoot;
  }
}

function notifier(input: {
  root: string;
  adapter: DeterministicRuntimeAdapter;
  run: PackReviewRunRecord;
  storeRoot: string;
  sessionId: string;
  suffix: string;
}) {
  return (request: PackReviewWorkerNotificationRequest) => sendPackReviewWorkerNotification({
    trustedPackRoot: repoRoot,
    projectId,
    storeRoot: input.storeRoot,
    sessionId: input.sessionId,
    adapter: input.adapter,
    journalPath: path.join(input.root, `${input.suffix}-dispatch.json`),
    claimNamespace: path.join(input.root, `${input.suffix}-claims`),
    sideEffectFencePath: path.join(input.root, `${input.suffix}-fence.lock`),
    request,
  });
}

describe('pack review persisted worker generation binding', () => {
  it('rejects the normal delivery path after same-id runtime recreation', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'opk-worker-generation-normal-'));
    try {
      const adapter = new DeterministicRuntimeAdapter();
      const binding = createBoundRun({
        root,
        adapter,
        prNumber: 894,
        sessionId: 'review-session-894',
      });
      expect(binding.run.workerNotificationBinding).toEqual({
        schemaVersion: 1,
        runtime: binding.worker.identity.runtime,
        id: binding.worker.identity.id,
        generation: binding.worker.identity.generation,
        workspacePath: path.resolve(binding.worker.workspacePath),
        headSha,
      });

      const recreated = adapter.recreateWorker(binding.worker.identity);
      writeSessionBinding(binding.sessionRoot, 'review-session-894', recreated);
      expect(recreated.identity.id).toBe(binding.worker.identity.id);
      expect(recreated.identity.generation).not.toBe(binding.worker.identity.generation);
      expect(getPackReviewRun(binding.run.id, {
        projectId,
        storeRoot: binding.storeRoot,
      })?.workerNotificationBinding?.generation).toBe(binding.worker.identity.generation);

      const dispatch = vi.spyOn(adapter, 'dispatchInput');
      const result = await deliverPackReviewVerdict({
        run: binding.run,
        payload: {
          verdict: 'findings',
          findingCount: 1,
          findings: [{ severity: 'blocking', summary: 'fixture finding' }],
        },
        projectId,
        storeRoot: binding.storeRoot,
        postGithubComment: async () => ({ id: 1, url: 'https://example.test/review/1', event: 'COMMENT' }),
        writeRequiredStatus: async () => {},
        notifyWorker: notifier({
          root,
          adapter,
          run: binding.run,
          storeRoot: binding.storeRoot,
          sessionId: 'review-session-894',
          suffix: 'normal',
        }),
      });

      expect(result.reason).toBe('completed_with_delivery_failures');
      expect(dispatch).not.toHaveBeenCalled();
      expect(getPackReviewRun(binding.run.id, {
        projectId,
        storeRoot: binding.storeRoot,
      })?.deliveryOutcomes.workerNotification).toMatchObject({
        state: 'escalated',
        reason: 'worker_generation_mismatch',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects the journal-resume delivery path after same-id runtime recreation', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'opk-worker-generation-resume-'));
    try {
      const adapter = new DeterministicRuntimeAdapter();
      const binding = createBoundRun({
        root,
        adapter,
        prNumber: 895,
        sessionId: 'review-session-895',
      });
      const journaled = updatePackReviewRun(binding.run.id, {
        status: 'reviewing',
        latestRunStatus: 'reviewing',
        reviewVerdict: 'findings',
        findingCount: 1,
        findings: [{ severity: 'blocking', summary: 'fixture finding' }],
        journalOutcome: {
          state: 'persisted',
          recordedAtUtc: new Date().toISOString(),
          reason: 'verdict_persisted',
          idempotencyKey: `verdict:${binding.run.id}:${headSha}`,
          attempts: 1,
        },
        deliveryOutcomes: {
          githubComment: persistedOutcome(
            'succeeded',
            'comment_posted',
            `github-comment:${binding.run.id}:${headSha}`,
          ),
          requiredStatus: persistedOutcome(
            'succeeded',
            'status_failure',
            `required-status:orchestrator-pack/pack-review:${headSha}`,
          ),
        },
      }, { projectId, storeRoot: binding.storeRoot });

      const recreated = adapter.recreateWorker(binding.worker.identity);
      writeSessionBinding(binding.sessionRoot, 'review-session-895', recreated);
      const dispatch = vi.spyOn(adapter, 'dispatchInput');
      const postGithubComment = vi.fn(async () => {
        throw new Error('completed GitHub channel must not be replayed');
      });
      const writeRequiredStatus = vi.fn(async () => {
        throw new Error('completed required-status channel must not be replayed');
      });

      const result = await resumePackReviewVerdictDelivery({
        run: journaled,
        projectId,
        storeRoot: binding.storeRoot,
        postGithubComment,
        writeRequiredStatus,
        notifyWorker: notifier({
          root,
          adapter,
          run: binding.run,
          storeRoot: binding.storeRoot,
          sessionId: 'review-session-895',
          suffix: 'resume',
        }),
      });

      expect(result.reason).toBe('completed_with_delivery_failures');
      expect(postGithubComment).not.toHaveBeenCalled();
      expect(writeRequiredStatus).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(getPackReviewRun(binding.run.id, {
        projectId,
        storeRoot: binding.storeRoot,
      })?.deliveryOutcomes.workerNotification).toMatchObject({
        state: 'escalated',
        reason: 'worker_generation_mismatch',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
