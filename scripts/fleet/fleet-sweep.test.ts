// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60
import { readFileSync } from 'node:fs';
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

describe('fleet sweep on real OpenCode screens', () => {
  const fixture = (name: string): string =>
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  // The captured screen shows `$ sleep 60 && …` as finished scrollback followed by newer work.
  // Rebuild the same real screen as it looked while that command was still running: the command
  // line carries OpenCode's spinner and is directly followed by the model line and status bar.
  const runningSleepScreen = (): string => {
    const lines = fixture('opencode-stale-sleep.screen.txt').split('\n');
    const command = lines.findIndex((line) => line.includes('$ sleep 60 && scripts/gh pr checks 2095'));
    const chrome = lines.findIndex((line) => line.includes('Pack-Opk-') && !line.includes('OpenAI'));
    return [
      ...lines.slice(0, command),
      lines[command]!.replace('$ sleep', '\u280f sleep'),
      lines[command + 1]!,
      ...lines.slice(chrome),
    ].join('\n');
  };

  it('reports POLLING on the second sweep while a wrapped sleep command is running', () => {
    const screen = runningSleepScreen();
    const store = new MemoryPollingStore();
    expect(classifyFleetPane(screen, 'p1', store)).toBe('busy');
    expect(classifyFleetPane(screen, 'p1', store)).toBe('POLLING');
  });

  it('keeps a pane busy when the only sleep is stale scrollback behind newer work', () => {
    const screen = fixture('opencode-stale-sleep.screen.txt');
    const store = new MemoryPollingStore();
    expect(classifyFleetPane(screen, 'p1', store)).toBe('busy');
    expect(classifyFleetPane(screen, 'p1', store)).toBe('busy');
  });

  it('prints content lines, not TUI frame, model line or status bar', () => {
    const terminals = [pane('p1', 'OC | worker')];
    const [observation] = runFleetSweep({
      primary,
      terminals,
      lines: 4,
      executor: fakeExecutor(terminals, { p1: runningSleepScreen() }),
      store: new MemoryPollingStore(),
    });
    expect(observation?.lines.length).toBeGreaterThan(0);
    for (const line of observation?.lines ?? []) {
      expect(line).not.toMatch(/[┃╹▀⬝■▣]|Pack-Opk-|esc interrupt|ctrl\+p commands|\(\d+%\)/u);
    }
    expect(observation?.lines.at(-2)).toMatch(/^sleep 60 && scripts\/gh pr checks 2095/u);
  });
});

describe('fleet sweep pane selection and reads', () => {
  it('includes primary-worktree agents while excluding the coordinator, outside worktrees, and plain shells', () => {
    const workspacePrimary = '/home/user/orca/workspaces/project/primary';
    const terminals = [
      pane('worker', 'OpenCode — manager'),
      pane('shell', 'zsh'),
      pane('outside', 'Cursor', '/tmp/other'),
      pane('primary-agent', 'OpenCode — primary agent', workspacePrimary),
      pane('coordinator', 'Cursor coordinator', workspacePrimary),
      pane('claude', 'Claude Code'),
    ];
    expect(selectAgentTerminals(terminals, workspacePrimary, defaultWorkspaceRegex(workspacePrimary)).map((item) => item.handle))
      .toEqual(['worker', 'primary-agent', 'claude']);
  });

  it('sweeps primary-worktree agent panes but excludes the exact coordinator pane', () => {
    const workspacePrimary = '/home/che/orca/workspaces/orchestrator-pack/smoke-2124';
    const terminals = [
      pane('primary-agent', 'OpenCode — smoke worker', workspacePrimary),
      pane('coordinator', 'OpenCode fixture-coordinator', workspacePrimary),
      pane('sibling-a', 'OpenCode — agent', '/home/che/orca/workspaces/orchestrator-pack/other-checkout'),
      pane('sibling-b', 'Claude Code — agent', '/home/che/orca/workspaces/orchestrator-pack/another-checkout'),
    ];
    const observed = runFleetSweep({
      primary: workspacePrimary,
      coordinatorHandle: 'coordinator',
      terminals,
      executor: fakeExecutor(terminals, {
        'primary-agent': 'done\n>',
        'sibling-a': 'working\nesc interrupt\n',
        'sibling-b': 'done\n',
      }),
      store: new MemoryPollingStore(),
    });

    expect(observed.map(({ handle }) => handle)).toEqual(['primary-agent', 'sibling-a', 'sibling-b']);
    expect(observed.some(({ handle }) => handle === 'coordinator')).toBe(false);
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
