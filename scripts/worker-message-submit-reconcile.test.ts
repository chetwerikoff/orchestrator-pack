// @vitest-ci-lane heavy
// @vitest-pre-topology-seconds 1
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RuntimeAdapter } from './runtime/contracts.ts';
import { sendPackReviewWorkerNotification } from './lib/pack-review-worker-notification.ts';
import {
  createAdapterSubmitDeps,
  submitUnsentCursorComposerOnceForWorker,
} from './cursor-unsent-composer-submit.ts';
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
        state: 'submitted',
        reason: 'runtime_dispatch_submitted',
      });
      const duplicate = await sendPackReviewWorkerNotification(request);
      expect(duplicate.state).toBe('submitted');
      expect(duplicate.reason).toMatch(/duplicate|terminal|served/);
      expect(readFileSync(request.journalPath, 'utf8')).toContain('issue-1248-worker-message');
      expect(existsSync(path.resolve('scripts/journaled-worker-send.ps1'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('performs one immediate exact composer submit while Running', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'opk-worker-event-submit-'));
    const identity = { runtime: 'orca', id: 'event-worker', generation: `generation-${Date.now()}` } as const;
    const worker = {
      identity,
      workspacePath: root,
      title: 'event-worker',
      provenance: 'external' as const,
    };
    const pointer = 'You have 1 orchestration message. Run `orca orchestration check --run run_event_pointer`.';
    const calls: Array<{ text?: string; submitOnly?: boolean }> = [];
    let reads = 0;
    const adapter = {
      id: 'orca',
      findWorkerById: () => ({ status: 'ok' as const, value: worker }),
      liveness: () => ({ status: 'idle' as const, worker: identity }),
      dispatchInput: (input: { text?: string; submitOnly?: boolean }) => {
        calls.push(input);
        return input.submitOnly
          ? { status: 'dispatched' as const }
          : { status: 'dispatch_unknown' as const, reason: 'submit_witness_unavailable' };
      },
      readBoundedOutput: (input: { screen?: boolean }) => {
        reads += 1;
        return {
          status: 'ok' as const,
          value: {
            worker: identity,
            lines: input.screen ? [pointer, 'Cursor Grok 4.6 High · 40.6% Run Everything', '~/projects/orchestrator-pack · main'] : [],
            observationToken: { opaque: 'event-screen' },
            changed: true,
            terminalState: 'running' as const,
            source: 'screen' as const,
          },
        };
      },
      readBoundedOutputAsync: async (input: { screen?: boolean }) => ({
        status: 'ok' as const,
        value: {
          worker: identity,
          lines: (reads += 1) && input.screen
            ? [pointer, 'Cursor Grok 4.6 High · 40.6% Run Everything', '~/projects/orchestrator-pack · main']
            : [],
          observationToken: { opaque: 'event-screen' },
          changed: true,
          terminalState: 'running' as const,
          source: 'screen' as const,
        },
      }),
    } as unknown as RuntimeAdapter;

    try {
      const result = await sendPackReviewWorkerNotification({
        trustedPackRoot: process.cwd(),
        workerId: identity.id,
        expectedWorkerGeneration: identity.generation,
        prNumber: 1587,
        projectId: 'orchestrator-pack',
        adapter,
        journalPath: path.join(root, 'dispatch.json'),
        claimNamespace: path.join(root, 'claims'),
        sideEffectFencePath: path.join(root, 'dispatch.lock'),
        request: { message: 'event delivery', idempotencyKey: `event-worker-${identity.generation}` },
      });

      expect(result).toMatchObject({ state: 'ambiguous', reason: 'dispatch_unknown' });
      await Promise.resolve();
      expect(reads).toBe(1);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.text).toBe('event delivery');
      expect(calls[0]?.submitOnly).toBeUndefined();
      expect(calls[1]).toMatchObject({ submitOnly: true, worker: identity });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
