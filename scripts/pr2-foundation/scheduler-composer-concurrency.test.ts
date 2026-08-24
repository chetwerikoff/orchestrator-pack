// @vitest-ci-lane light
// @vitest-pre-topology-seconds 1
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createUnsentComposerWatchState,
  runSupervisorUnsentComposerTick,
  type UnsentComposerSubmitDeps,
} from '../cursor-unsent-composer-submit.ts';

const POKE = 'You have 1 orchestration message. Run `orca orchestration check --run run_event_pointer`.';
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
        identity: { runtime: 'orca', id: 'cursor-worker', generation: 'generation-scheduler-test' },
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

describe('event-driven composer submission', () => {
  it('uses one bounded screen observation for an exact pointer', async () => {
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

  it('keeps Cursor composer reads out of the periodic scheduler path', () => {
    const source = readFileSync(new URL('./scheduler.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('runSupervisorUnsentComposerTick');
    expect(source).not.toContain('runComposerPass');
    expect(source).not.toContain('composer:');
    expect(source).toContain('const result = await runSchedulerTick(boundary);');
  });
});
