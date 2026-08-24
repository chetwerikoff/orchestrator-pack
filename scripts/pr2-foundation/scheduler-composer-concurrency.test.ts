// @vitest-ci-lane light
// @vitest-pre-topology-seconds 1
import { describe, expect, it, vi } from 'vitest';
import {
  createUnsentComposerWatchState,
  runSupervisorUnsentComposerTick,
  type UnsentComposerSubmitDeps,
} from '../cursor-unsent-composer-submit.ts';
import { formatSchedulerError, settleSchedulerAndComposer } from './scheduler.ts';

const POKE = 'You have 1 orchestration message. Run `orca orchestration check --run run_d613a86c140a`.';
const CURSOR_SCREEN = [
  POKE,
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

describe('scheduler/composer concurrency settlement', () => {
  it.each([
    ['fast', () => Promise.resolve()],
    ['slow', () => new Promise<void>((resolve) => setTimeout(resolve, 20))],
    ['failed', () => Promise.reject(new Error('fleet failed'))],
    ['timed out', () => new Promise<void>((_, reject) => setTimeout(() => reject(new Error('fleet timeout')), 20))],
  ] as const)('dispatches an exact Cursor pointer immediately when the fleet tick is %s', async (_name, fleetTick) => {
    vi.useFakeTimers();
    try {
      const submitted: string[] = [];
      const phases = Promise.allSettled([
        Promise.resolve().then(fleetTick),
        runSupervisorUnsentComposerTick(composerDeps(submitted), createUnsentComposerWatchState()),
      ]);
      await Promise.resolve();
      expect(submitted).toEqual(['enter']);
      await vi.advanceTimersByTimeAsync(20);
      const settled = await phases;
      expect(settled[1]?.status).toBe('fulfilled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not wait for a slow fleet phase before submitting the exact pointer', async () => {
    vi.useFakeTimers();
    try {
      const submitted: string[] = [];
      const phases = Promise.allSettled([
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('fleet timeout')), 15_000)),
        runSupervisorUnsentComposerTick(composerDeps(submitted), createUnsentComposerWatchState()),
      ]);
      await Promise.resolve();
      expect(submitted).toEqual(['enter']);
      await vi.advanceTimersByTimeAsync(15_000);
      const settled = await phases;
      expect(settled[1]?.status).toBe('fulfilled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses one async screen observation for an exact pointer', async () => {
    let reads = 0;
    const submitted: string[] = [];
    const deps = composerDeps(submitted);
    const result = await runSupervisorUnsentComposerTick({
      ...deps,
      listWorkersAsync: async () => deps.listWorkers(),
      readAsync: async () => {
        reads += 1;
        return { ok: true, lines: CURSOR_SCREEN, source: 'screen' };
      },
    });
    expect(reads).toBe(1);
    expect(submitted).toEqual(['enter']);
    expect(result.terminals[0]?.reason).toBe('enter_sent');
  });

  it('does not submit mixed human and orchestration text', async () => {
    const submitted: string[] = [];
    const result = await runSupervisorUnsentComposerTick({
      ...composerDeps(submitted),
      read: () => ({ ok: true, lines: ['→ human draft', ...CURSOR_SCREEN], source: 'screen' }),
    });
    expect(submitted).toEqual([]);
    expect(result.terminals[0]?.reason).toBe('composer_not_orchestration_pointer');
  });

  it('rechecks a mixed composer while fleet remains unresolved', async () => {
    vi.useFakeTimers();
    try {
      const submitted: string[] = [];
      let pointerVisible = false;
      const base = composerDeps(submitted);
      const deps: UnsentComposerSubmitDeps = {
        ...base,
        read: () => ({
          ok: true,
          lines: pointerVisible ? CURSOR_SCREEN : ['→ human draft', ...CURSOR_SCREEN],
          source: 'screen',
        }),
      };
      const fleet = new Promise<void>(() => {});
      const pass = runSupervisorUnsentComposerTick(
        deps,
        createUnsentComposerWatchState(),
        { fleetSettled: fleet },
      );

      await Promise.resolve();
      expect(submitted).toEqual([]);
      pointerVisible = true;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(submitted).toEqual(['enter']);
      const settled = await pass;
      expect(settled.terminals[0]?.reason).toBe('enter_sent');
    } finally {
      vi.useRealTimers();
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
      const emptyComposer = ['→ Add a follow-up', ...CURSOR_SCREEN.slice(1)];
      const deps: UnsentComposerSubmitDeps = {
        listWorkers: () => ({ ok: true, workers: [target, ...unrelated] }),
        listWorkersAsync: async () => ({ ok: true, workers: [target, ...unrelated] }),
        read: () => ({ ok: true, lines: emptyComposer, source: 'screen' }),
        readAsync: (identity) => new Promise((resolve) => {
          started.push(identity.id);
          setTimeout(() => resolve({
            ok: true,
            lines: identity.id === target.identity.id ? CURSOR_SCREEN : emptyComposer,
            source: 'screen',
          }), identity.id === target.identity.id ? 100 : 70_000);
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
      expect(submitted).toEqual([target.identity.id]);
      await vi.advanceTimersByTimeAsync(150_000);
      const settled = await pass;
      expect(settled.terminals.find((row) => row.terminal === target.identity.id)?.reason).toBe('enter_sent');
      expect(submitted.filter((id) => id === target.identity.id)).toHaveLength(1);
      expect(submitted.some((id) => id.startsWith('unrelated-'))).toBe(false);
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
      const acceptedLatencyMs = 1_500;
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
