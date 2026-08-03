import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeterministicRuntimeAdapter } from './runtime/test-adapter.ts';
import {
  parseWorkerNudgeArgs,
  resolveWorkerNudgeIdentity,
  runGatedWorkerNudge,
} from './invoke-gated-worker-nudge.ts';

describe('TypeScript gated worker nudge', () => {
  it('preserves issue-keyed task continuation and deduplicates before dispatch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-nudge-'));
    try {
      const adapter = new DeterministicRuntimeAdapter();
      const worker = adapter.spawnWorker({ title: 'worker', command: 'cursor-agent' });
      expect(worker.status).toBe('ok');
      if (worker.status !== 'ok') return;
      const options = parseWorkerNudgeArgs([
        '--worker-id', worker.value.identity.id,
        '--issue', '1248',
        '--intent-class', 'task-continuation',
        '--repo-root', root,
      ]);
      const dispatch = vi.spyOn(adapter, 'dispatchInput');
      const common = {
        options,
        message: 'continue the task',
        adapter,
        journalPath: join(root, 'dispatch-journal.json'),
        claimNamespace: join(root, 'claims'),
        sideEffectFencePath: join(root, 'side-effect.lock'),
      };

      const first = await runGatedWorkerNudge(common);
      const second = await runGatedWorkerNudge(common);

      expect(first.sent).toBe(true);
      expect(second.sent).toBe(true);
      expect(second.reason).toMatch(/duplicate/);
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists dispatch_unknown without resending', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-nudge-'));
    try {
      const adapter = new DeterministicRuntimeAdapter();
      const worker = adapter.spawnWorker({ title: 'worker', command: 'cursor-agent' });
      expect(worker.status).toBe('ok');
      if (worker.status !== 'ok') return;
      const dispatch = vi.spyOn(adapter, 'dispatchInput').mockReturnValue({
        status: 'dispatch_unknown',
        reason: 'transport_interrupted',
      });
      const options = parseWorkerNudgeArgs([
        '--worker-id', worker.value.identity.id,
        '--pr', '1281',
        '--intent-class', 'review-findings',
        '--repo-root', root,
      ]);
      const result = await runGatedWorkerNudge({
        options,
        message: 'review findings are ready',
        adapter,
        journalPath: join(root, 'dispatch-journal.json'),
        claimNamespace: join(root, 'claims'),
        sideEffectFencePath: join(root, 'side-effect.lock'),
      });

      expect(result).toMatchObject({ sent: false, reason: 'dispatch_unknown' });
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects PR-keyed intents without a PR number', () => {
    const options = parseWorkerNudgeArgs([
      '--worker-id', 'worker-1',
      '--intent-class', 'review-findings',
    ]);
    expect(() => resolveWorkerNudgeIdentity(options, 'message')).toThrow('pr_number_required');
  });
});
