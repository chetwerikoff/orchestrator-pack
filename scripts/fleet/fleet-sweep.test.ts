// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60
import { describe, expect, it } from 'vitest';
import {
  classifyFleetPane,
  defaultWorkspaceRegex,
  runFleetSweep,
  selectAgentTerminals,
  type FleetPollingStore,
  type FleetTerminal,
  type OrcaCommandResult,
  type OrcaExecutor,
} from './fleet-sweep.ts';

class MemoryPollingStore implements FleetPollingStore {
  readonly marks = new Set<string>();
  hasPollingMark(handle: string): boolean { return this.marks.has(handle); }
  setPollingMark(handle: string): void { this.marks.add(handle); }
  clearPollingMark(handle: string): void { this.marks.delete(handle); }
}

function result(stdout = '', ok = true): OrcaCommandResult {
  return { ok, stdout, stderr: ok ? '' : 'failed', exitCode: ok ? 0 : 1 };
}

function fakeExecutor(
  terminals: readonly FleetTerminal[],
  screens: Readonly<Record<string, string>>,
  calls: string[][] = [],
): OrcaExecutor {
  return (args) => {
    calls.push([...args]);
    if (args[0] === 'terminal' && args[1] === 'list') {
      return result(JSON.stringify({
        ok: true,
        result: { terminals, totalCount: terminals.length, truncated: false },
      }));
    }
    if (args[0] === 'terminal' && args[1] === 'read') {
      const handle = args[args.indexOf('--terminal') + 1] ?? '';
      return handle in screens ? result(screens[handle] ?? '') : result('', false);
    }
    return result('', false);
  };
}

const primary = '/home/user/project';
const workerPath = '/home/user/.local/share/orca/workspaces/project/worker-1';

function pane(handle: string, title: string, worktreePath = workerPath): FleetTerminal {
  return { handle, title, worktreePath };
}

describe('fleet sweep classification', () => {
  it.each([
    ['OpenCode', 'doing work\nesc interrupt\n'],
    ['Cursor', 'doing work\nctrl+c to stop\n'],
    ['Claude', 'doing work\nesc to interrupt\n'],
  ])('classifies %s running-turn marker as busy', (_name, screen) => {
    expect(classifyFleetPane(screen, 'p1', new MemoryPollingStore())).toBe('busy');
  });

  it('classifies stopped and parked panes', () => {
    const store = new MemoryPollingStore();
    expect(classifyFleetPane('finished\n>', 'p1', store)).toBe('STOPPED');
    expect(classifyFleetPane('done\nPARKED on PR #1 merged; resume step: x\n>', 'p2', store)).toBe('PARKED');
  });

  it.each([
    ['sleep', 'running sleep 60 && gh pr view 1\nesc interrupt'],
    ['wait exit', 'WAIT_EXIT=124\nesc interrupt'],
    ['exit code', 'last exit code: 124\nesc interrupt'],
  ])('requires two consecutive sweeps before %s is POLLING and clears the mark after progress', (_name, screen) => {
    const store = new MemoryPollingStore();
    expect(classifyFleetPane(screen, 'p1', store)).toBe('busy');
    expect(store.marks.has('p1')).toBe(true);
    expect(classifyFleetPane(screen, 'p1', store)).toBe('POLLING');
    expect(classifyFleetPane('real work\nesc interrupt', 'p1', store)).toBe('busy');
    expect(store.marks.has('p1')).toBe(false);
    expect(classifyFleetPane(screen, 'p1', store)).toBe('busy');
  });

  it('clears a polling mark when polling text is stale scrollback behind newer busy work', () => {
    const store = new MemoryPollingStore();
    store.setPollingMark('p1');
    expect(classifyFleetPane(
      'sleep 60\nold wait output\nnew useful work\nesc interrupt',
      'p1',
      store,
    )).toBe('busy');
    expect(store.marks.has('p1')).toBe(false);
  });
});

describe('fleet sweep pane selection and reads', () => {
  it('keeps matching agent worktrees and ignores primary, outside worktrees, and plain shells', () => {
    const terminals = [
      pane('worker', 'OpenCode — manager'),
      pane('shell', 'zsh'),
      pane('outside', 'Cursor', '/tmp/other'),
      pane('primary', 'Cursor', primary),
      pane('claude', 'Claude Code'),
    ];
    expect(selectAgentTerminals(terminals, primary, defaultWorkspaceRegex(primary)).map((item) => item.handle))
      .toEqual(['worker', 'claude']);
  });

  it('reads every selected pane exactly once and performs no Orca mutation', () => {
    const calls: string[][] = [];
    const terminals = [pane('a', 'OC | worker'), pane('b', 'Cursor worker')];
    const executor = fakeExecutor(terminals, {
      a: 'working\nesc interrupt\nline-a',
      b: 'done\nline-b',
    }, calls);
    const observed = runFleetSweep({ primary, executor, store: new MemoryPollingStore(), lines: 1 });
    expect(observed.map(({ handle, state, lines }) => ({ handle, state, lines }))).toEqual([
      { handle: 'a', state: 'busy', lines: ['line-a'] },
      { handle: 'b', state: 'STOPPED', lines: ['line-b'] },
    ]);
    expect(calls.filter((call) => call[1] === 'read')).toHaveLength(2);
    expect(calls.every((call) => call[1] === 'list' || call[1] === 'read')).toBe(true);
  });

  it('fails closed on incomplete or malformed terminal census data', () => {
    const terminal = pane('a', 'OpenCode worker');
    const payloads = [
      { ok: true, result: { terminals: [terminal], totalCount: 1, truncated: true } },
      { ok: true, result: { terminals: [terminal], totalCount: 2, truncated: false } },
      { ok: true, result: { terminals: [{ handle: 'a', title: 'OpenCode worker' }], totalCount: 1, truncated: false } },
    ];
    for (const payload of payloads) {
      const executor: OrcaExecutor = (args) => (
        args[0] === 'terminal' && args[1] === 'list'
          ? result(JSON.stringify(payload))
          : result('', false)
      );
      expect(() => runFleetSweep({ primary, executor, store: new MemoryPollingStore() }))
        .toThrow(/terminal list unreadable/u);
    }
  });

  it('returns no pane lines when --lines is zero', () => {
    const observed = runFleetSweep({
      primary,
      executor: fakeExecutor([pane('a', 'OpenCode worker')], { a: 'done\nline-a' }),
      store: new MemoryPollingStore(),
      lines: 0,
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]?.lines).toEqual([]);
  });
});
