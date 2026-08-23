// @vitest-ci-lane light
// @vitest-pre-topology-seconds 1
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createUnsentComposerWatchState,
  QUIET_AFTER_PRINT_MS,
  runSupervisorUnsentComposerTick,
  type UnsentComposerSubmitDeps,
} from '../cursor-unsent-composer-submit.ts';
import { formatSchedulerError, settleSchedulerAndComposer } from './scheduler.ts';

const CURSOR_SCREEN = [
  '→ stable orchestration payload',
  'Cursor Grok 4.6 High · 40.6% Run Everything',
  '~/projects/orchestrator-pack · main',
];

function composerDeps(submitted: string[]): UnsentComposerSubmitDeps {
  return {
    listWorkers: () => ({
      ok: true,
      workers: [{
        identity: { runtime: 'orca', id: 'cursor-worker', generation: 'generation-1' },
        workspacePath: '/tmp',
        title: 'cursor-worker',
        provenance: 'external',
      }],
    }),
    read: () => ({ ok: true, lines: CURSOR_SCREEN, source: 'screen' }),
    submit: () => {
      submitted.push('enter');
      return { status: 'dispatched' };
    },
  };
}

function changingComposerDeps(submitted: string[]): UnsentComposerSubmitDeps {
  let reads = 0;
  return {
    ...composerDeps(submitted),
    read: () => {
      reads += 1;
      return {
        ok: true,
        lines: reads > 1
          ? ['→ changed orchestration payload', ...CURSOR_SCREEN.slice(1)]
          : CURSOR_SCREEN,
        source: 'screen',
      };
    },
  };
}

describe('scheduler/composer concurrency settlement', () => {
  it.each([
    ['fast', () => Promise.resolve()],
    ['slow', () => new Promise<void>((resolve) => setTimeout(resolve, 20))],
    ['failed', () => Promise.reject(new Error('fleet failed'))],
    ['timed out', () => new Promise<void>((_, reject) => setTimeout(() => reject(new Error('fleet timeout')), 20))],
  ] as const)('dispatches a stable Cursor composer within 5s when the fleet tick is %s', async (_name, fleetTick) => {
    vi.useFakeTimers();
    try {
      const submitted: string[] = [];
      const phases = Promise.allSettled([
        Promise.resolve().then(fleetTick),
        runSupervisorUnsentComposerTick(composerDeps(submitted), createUnsentComposerWatchState()),
      ]);
      await vi.advanceTimersByTimeAsync(QUIET_AFTER_PRINT_MS);
      expect(submitted).toEqual(['enter']);
      const settled = await phases;
      expect(settled[1]?.status).toBe('fulfilled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the changed-second-read follow-up independently of a slow fleet phase', async () => {
    vi.useFakeTimers();
    try {
      const submitted: string[] = [];
      const phases = Promise.allSettled([
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('fleet timeout')), 15_000)),
        runSupervisorUnsentComposerTick(changingComposerDeps(submitted), createUnsentComposerWatchState()),
      ]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(submitted).toEqual(['enter']);
      await vi.advanceTimersByTimeAsync(5_000);
      const settled = await phases;
      expect(settled[1]?.status).toBe('fulfilled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists the quiet observation before the bounded wait completes', async () => {
    vi.useFakeTimers();
    const sentStorePath = join(tmpdir(), `opk-composer-${process.pid}-${Date.now()}.json`);
    try {
      const pass = runSupervisorUnsentComposerTick(
        { ...composerDeps([]), sentStorePath },
        createUnsentComposerWatchState(),
      );
      await Promise.resolve();
      const persisted = JSON.parse(readFileSync(sentStorePath, 'utf8')) as { observations?: unknown[] };
      expect(persisted.observations).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(QUIET_AFTER_PRINT_MS);
      await pass;
    } finally {
      vi.useRealTimers();
      rmSync(sentStorePath, { force: true });
    }
  });

  it('preserves both failures when both concurrent phases reject', () => {
    const schedulerFailure = new Error('fleet failed');
    const composerFailure = new Error('composer failed');

    expect(() => settleSchedulerAndComposer(
      { status: 'rejected', reason: schedulerFailure },
      { status: 'rejected', reason: composerFailure },
    )).toThrowError(AggregateError);

    try {
      settleSchedulerAndComposer(
        { status: 'rejected', reason: schedulerFailure },
        { status: 'rejected', reason: composerFailure },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([schedulerFailure, composerFailure]);
      expect(formatSchedulerError(error)).toContain('fleet failed; composer failed');
    }
  });

  it('promotes a failed composer result so a fleet rejection keeps both causes', () => {
    expect(() => settleSchedulerAndComposer(
      { status: 'rejected', reason: new Error('fleet failed') },
      { status: 'fulfilled', value: { ok: false, terminals: [{ reason: 'screen unavailable' }] } },
    )).toThrow(/scheduler_and_composer_failed/);
    try {
      settleSchedulerAndComposer(
        { status: 'rejected', reason: new Error('fleet failed') },
        { status: 'fulfilled', value: { ok: false, terminals: [{ reason: 'screen unavailable' }] } },
      );
    } catch (error) {
      expect(formatSchedulerError(error)).toContain('fleet failed; composer_pass_failed:screen unavailable');
    }
  });
});
