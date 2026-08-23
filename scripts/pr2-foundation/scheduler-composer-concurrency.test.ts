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

  it('rechecks after the quiet deadline when the composer changes during verification', async () => {
    vi.useFakeTimers();
    try {
      const submitted: string[] = [];
      const target = {
        runtime: 'orca' as const,
        id: 'composer-race',
        generation: 'generation-1',
      };
      const first = ['→ first orchestration payload', ...CURSOR_SCREEN.slice(1)];
      const replacement = ['→ replacement orchestration payload', ...CURSOR_SCREEN.slice(1)];
      let composer = first;
      let reads = 0;
      const deps: UnsentComposerSubmitDeps = {
        listWorkers: () => ({ ok: true, workers: [{
          identity: target,
          workspacePath: '/tmp/composer-race',
          title: 'composer-race',
          provenance: 'external' as const,
        }] }),
        listWorkersAsync: async () => ({ ok: true, workers: [{
          identity: target,
          workspacePath: '/tmp/composer-race',
          title: 'composer-race',
          provenance: 'external' as const,
        }] }),
        read: () => ({ ok: true, lines: composer, source: 'screen' }),
        readAsync: async () => {
          reads += 1;
          return { ok: true, lines: reads <= 2 ? first : composer, source: 'screen' };
        },
        submit: () => {
          submitted.push(target.id);
          return { status: 'dispatched' };
        },
      };
      setTimeout(() => { composer = replacement; }, 4_005);
      const pass = runSupervisorUnsentComposerTick(deps, createUnsentComposerWatchState());
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_005);
      expect(submitted).toEqual([]);
      await vi.advanceTimersByTimeAsync(QUIET_AFTER_PRINT_MS + 100);
      expect(submitted).toEqual([target.id]);
      await pass;
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

  it('dispatches a late-arriving target while many unrelated async reads remain slow', async () => {
    vi.useFakeTimers();
    try {
      const submitted: string[] = [];
      const target = {
        identity: { runtime: 'orca', id: 'late-target', generation: 'generation-1' },
        workspacePath: '/tmp/late-target',
        title: 'late-target',
        provenance: 'external' as const,
      };
      const unrelated = Array.from({ length: 70 }, (_, index) => ({
        identity: { runtime: 'orca', id: `unrelated-${index}`, generation: 'generation-1' },
        workspacePath: `/tmp/unrelated-${index}`,
        title: `unrelated-${index}`,
        provenance: 'external' as const,
      }));
      const started: string[] = [];
      const deps: UnsentComposerSubmitDeps = {
        listWorkers: () => ({ ok: true, workers: [target, ...unrelated] }),
        listWorkersAsync: async () => ({ ok: true, workers: [target, ...unrelated] }),
        read: () => ({ ok: true, lines: CURSOR_SCREEN, source: 'screen' }),
        readAsync: (identity) => new Promise((resolve) => {
          started.push(identity.id);
          setTimeout(() => resolve({ ok: true, lines: CURSOR_SCREEN, source: 'screen' }), identity.id === target.identity.id ? 100 : 70_000);
        }),
        submit: (identity) => {
          submitted.push(identity.id);
          return { status: 'dispatched' };
        },
      };
      const pass = runSupervisorUnsentComposerTick(deps, createUnsentComposerWatchState());
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);
      expect(started).toHaveLength(71);
      await vi.advanceTimersByTimeAsync(QUIET_AFTER_PRINT_MS);
      await vi.advanceTimersByTimeAsync(100);
      expect(submitted).toEqual([target.identity.id]);
      await vi.advanceTimersByTimeAsync(150_000);
      const settled = await pass;
      expect(settled.terminals.find((row) => row.terminal === target.identity.id)?.reason).toBe('enter_sent');
      expect(submitted.filter((id) => id === target.identity.id)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls a late composer arrival while fleet remains unresolved', async () => {
    vi.useFakeTimers();
    try {
      const submitted: string[] = [];
      const target = {
        identity: { runtime: 'orca', id: 'late-target', generation: 'generation-1' },
        workspacePath: '/tmp/late-target',
        title: 'late-target',
        provenance: 'external' as const,
      };
      const unrelated = Array.from({ length: 70 }, (_, index) => ({
        identity: { runtime: 'orca', id: `unrelated-${index}`, generation: 'generation-1' },
        workspacePath: `/tmp/unrelated-${index}`,
        title: `unrelated-${index}`,
        provenance: 'external' as const,
      }));
      const emptyClaude = ['prior transcript', '────────────────────────────────', '❯', '────────────────────────────────'];
      let targetVisible = false;
      let fleetComplete = false;
      let enteredAt: number | undefined;
      const targetChangeDelayMs = 10_000;
      const targetChangedAt = Date.now() + targetChangeDelayMs;
      const fleet = new Promise<void>((resolve) => setTimeout(() => { fleetComplete = true; resolve(); }, 70_000));
      const deps: UnsentComposerSubmitDeps = {
        listWorkers: () => ({ ok: true, workers: [target, ...unrelated] }),
        listWorkersAsync: async () => ({ ok: true, workers: [target, ...unrelated] }),
        read: () => ({ ok: true, lines: emptyClaude, source: 'screen' }),
        readAsync: (identity) => new Promise((resolve) => {
          setTimeout(() => resolve({
            ok: true,
            lines: identity.id === target.identity.id && targetVisible ? CURSOR_SCREEN : emptyClaude,
            source: 'screen' as const,
          }), 0);
        }),
        submit: (identity) => {
          submitted.push(identity.id);
          if (identity.id === target.identity.id) enteredAt = Date.now();
          return { status: 'dispatched' };
        },
      };
      setTimeout(() => { targetVisible = true; }, targetChangeDelayMs);
      const pass = runSupervisorUnsentComposerTick(deps, createUnsentComposerWatchState(), { fleetSettled: fleet });
      await vi.advanceTimersByTimeAsync(targetChangeDelayMs);
      expect(fleetComplete).toBe(false);
      const acceptedLatencyMs = QUIET_AFTER_PRINT_MS + 1_500;
      await vi.advanceTimersByTimeAsync(acceptedLatencyMs);
      await Promise.resolve();
      expect(enteredAt).toBeDefined();
      expect((enteredAt ?? 0) - targetChangedAt).toBeLessThanOrEqual(acceptedLatencyMs);
      expect(submitted).toEqual([target.identity.id]);
      await vi.advanceTimersByTimeAsync(60_000);
      const settled = await pass;
      expect(fleetComplete).toBe(true);
      expect(settled.terminals.find((row) => row.terminal === target.identity.id)?.reason).toBe('enter_sent');
      expect(submitted.filter((id) => id === target.identity.id)).toHaveLength(1);
      expect(submitted.some((id) => id.startsWith('unrelated-'))).toBe(false);
    } finally {
      vi.useRealTimers();
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
