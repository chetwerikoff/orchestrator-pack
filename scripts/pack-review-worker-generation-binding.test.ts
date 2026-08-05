import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runProcess } from './kernel/subprocess.ts';
import { createPackReviewRun } from './lib/pack-review-run-store.ts';
import { sendPackReviewWorkerNotification } from './lib/pack-review-worker-notification.ts';
import { DeterministicRuntimeAdapter } from './runtime/test-adapter.ts';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('pack review persisted worker generation binding', () => {
  it('rejects normal and resumed delivery after same-id runtime recreation', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'opk-worker-generation-binding-'));
    try {
      const storeRoot = path.join(root, 'run-store');
      const sessionRoot = path.join(root, 'sessions');
      const adapter = new DeterministicRuntimeAdapter();
      const head = await runProcess({
        command: 'git',
        args: ['-C', repoRoot, 'rev-parse', 'HEAD'],
        cwd: repoRoot,
        inheritParentEnv: true,
        allowEmptyStdout: false,
      });
      if (!head.ok) throw new Error('fixture_head_unresolved');
      const headSha = head.stdout.trim().toLowerCase();
      const spawned = adapter.spawnWorker({
        title: 'bound-review-worker',
        command: 'test-worker',
        workspace: repoRoot,
      });
      if (spawned.status !== 'ok') throw new Error('fixture_worker_spawn_failed');
      const worker = spawned.value;
      const run = createPackReviewRun({
        projectId: 'orchestrator-pack',
        storeRoot,
        prNumber: 894,
        headSha,
        linkedSessionId: 'review-session-894',
        startReason: 'test',
        surface: 'generation-binding-test',
        trustedPackRoot: repoRoot,
        sourceRepoRoot: repoRoot,
        canonicalRepository: 'chetwerikoff/orchestrator-pack',
      }).run;
      mkdirSync(sessionRoot, { recursive: true });
      writeFileSync(path.join(sessionRoot, 'review-session-894.json'), `${JSON.stringify({
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
      const recreated = adapter.recreateWorker(worker.identity);
      expect(recreated.identity.id).toBe(worker.identity.id);
      expect(recreated.identity.generation).not.toBe(worker.identity.generation);

      const notify = (suffix: string) => sendPackReviewWorkerNotification({
        trustedPackRoot: repoRoot,
        projectId: 'orchestrator-pack',
        storeRoot,
        adapter,
        sessionMetadataRoot: sessionRoot,
        journalPath: path.join(root, `${suffix}-dispatch.json`),
        claimNamespace: path.join(root, `${suffix}-claims`),
        sideEffectFencePath: path.join(root, `${suffix}-fence.lock`),
        request: {
          message: `review findings ${suffix}`,
          idempotencyKey: `worker-notification:${run.id}:${headSha}:${suffix}`,
          reviewRunId: run.id,
        },
      });

      expect(await notify('normal')).toEqual({
        state: 'escalated',
        reason: 'worker_generation_mismatch',
      });
      expect(await notify('resume')).toEqual({
        state: 'escalated',
        reason: 'worker_generation_mismatch',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
