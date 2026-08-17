import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sendPackReviewWorkerNotification } from './lib/pack-review-worker-notification.ts';
import { DeterministicRuntimeAdapter } from './runtime/test-adapter.ts';

describe('worker message submission through the runtime boundary', () => {
  it('submits once and suppresses a duplicate without a PowerShell sender', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'opk-worker-submit-'));
    try {
      const adapter = new DeterministicRuntimeAdapter();
      const spawned = adapter.spawnWorker({ title: 'worker', command: 'fixture', workspace: process.cwd() });
      if (spawned.status !== 'ok') throw new Error('fixture_worker_spawn_failed');
      const request = {
        trustedPackRoot: process.cwd(),
        workerId: spawned.value.identity.id,
        expectedWorkerGeneration: spawned.value.identity.generation,
        prNumber: 1248,
        projectId: 'orchestrator-pack',
        adapter,
        journalPath: path.join(root, 'dispatch.json'),
        claimNamespace: path.join(root, 'claims'),
        sideEffectFencePath: path.join(root, 'dispatch.lock'),
        request: { message: 'continue issue 1248', idempotencyKey: 'issue-1248-worker-message' },
      } as const;
      await expect(sendPackReviewWorkerNotification(request)).resolves.toMatchObject({
        state: 'escalated',
        reason: 'runtime_dispatch_submitted',
      });
      const duplicate = await sendPackReviewWorkerNotification(request);
      expect(duplicate.state).toBe('escalated');
      expect(duplicate.reason).toMatch(/duplicate|terminal|served/);
      expect(readFileSync(request.journalPath, 'utf8')).toContain('issue-1248-worker-message');
      expect(existsSync(path.resolve('scripts/journaled-worker-send.ps1'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
