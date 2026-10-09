// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import * as targetContext from '../lib/target-context.ts';
import {
  classifyFleetPane,
  collectFleetDiagnostics,
  parseSweepCli,
  FileFleetStateStore,
  formatFleetDiagnostics,
  defaultWorkspaceRegex,
  isBusyScreen,
  runFleetSweep,
  selectAgentTerminals,
  type FleetPollingStore,
  type FleetPaneObservation,
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
  shows: Readonly<Record<string, Record<string, unknown>>> = {},
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
    if (args[0] === 'terminal' && args[1] === 'show') {
      const handle = args[args.indexOf('--terminal') + 1] ?? '';
      return shows[handle] ? result(JSON.stringify({ ok: true, result: { terminal: shows[handle] } })) : result('', false);
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

  it('ignores a quoted status bar in scrollback of an idle pane', () => {
    const screen = readFileSync(new URL('./fixtures/cursor-idle-quoted-opencode-status.screen.txt', import.meta.url), 'utf8');
    expect(screen).toMatch(/esc interrupt/u);
    expect(isBusyScreen(screen)).toBe(false);
    expect(classifyFleetPane(screen, 'p1', new MemoryPollingStore())).toBe('STOPPED');
  });

  it('still sees the marker of a busy pane below a quoted status bar', () => {
    const screen = readFileSync(new URL('./fixtures/cursor-idle-quoted-opencode-status.screen.txt', import.meta.url), 'utf8')
      .replace(/→ Add a follow-up\s*$/mu, '→ Add a follow-up                                   ctrl+c to stop');
    expect(isBusyScreen(screen)).toBe(true);
  });

  it('classifies stopped and parked panes', () => {
    const store = new MemoryPollingStore();
    expect(classifyFleetPane('finished\n>', 'p1', store)).toBe('STOPPED');
    expect(classifyFleetPane('done\nPARKED on PR #1 merged; resume step: x\n>', 'p2', store)).toBe('PARKED');
  });

  it.each([
    '> PARKED on PR #1 merged',
    'User: End your turn with\nPARKED on PR #1 merged',
    'Tool: orca terminal read --terminal foreign\nforeign output\nPARKED on PR #1 merged',
    'finished own task\n> foreign pane: PARKED on PR #1 merged',
    'PARKED on PR #1 merged\nfinished new work',
    'PARKED on PR #1 merged\nMay I deploy?',
    '```text\nPARKED on PR #1 merged\n```',
    'PARKED on PR #1 merged\n\nImplementation complete; no dependency remains.',
  ])('does not treat quoted, foreign or superseded text as an own wait: %s', (screen) => {
    expect(classifyFleetPane(screen, 'p1', new MemoryPollingStore())).toBe('STOPPED');
  });

  it('recognizes a final rendered and wrapped own outcome', () => {
    expect(classifyFleetPane('┃ PARKED: wait PR #1\n┃ merged; resume step: deploy\n>', 'p1', new MemoryPollingStore())).toBe('PARKED');
  });

  it('separates the exact CLI read header from a foreign pane header inside the screen', () => {
    const terminals = [pane('own', 'OpenCode worker')];
    const outer = 'handle: own\nstatus: running\nsource: screen\n\n';
    const sweep = (screen: string) => runFleetSweep({
      primary, terminals, store: new MemoryPollingStore(),
      executor: fakeExecutor(terminals, { own: `${outer}${screen}` }),
    })[0]?.state;
    expect(sweep('PARKED on PR #1 merged')).toBe('PARKED');
    expect(sweep('Tool: foreign pane\nhandle: foreign\nsource: screen\nPARKED on PR #1 merged')).toBe('STOPPED');
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
      projectId: 'orchestrator-pack',
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
  it.each([true, false])('one-off sweep consumes the exact optional ARCHITECT_HANDLE: %s (#2422)', (exclude) => {
    const handle = 'term_721dce76-e932-460a-8ebe-e9f80da9f056';
    const census = [pane(handle, 'Claude Code architect', primary), pane('worker', 'OpenCode worker'), pane('other', 'Claude Code architect')];
    const calls: string[][] = [];
    try {
      vi.stubEnv('ARCHITECT_HANDLE', exclude ? ` ${handle} ` : '');
      const observed = runFleetSweep({
        primary, workspaceRe: /\/home\/user\//u, terminals: census, store: new MemoryPollingStore(),
        executor: fakeExecutor(census, { [handle]: 'Ready.\n>', worker: 'done', other: 'Ready.\n>' }, calls),
      });
      expect(observed.map((item) => [item.handle, item.state])).toEqual([
        ...(!exclude ? [[handle, 'STOPPED']] : []), ['worker', 'STOPPED'], ['other', 'STOPPED'],
      ]);
      expect(calls.some((call) => call[1] === 'read' && call.includes(handle))).toBe(!exclude);
    } finally { vi.unstubAllEnvs(); }
  });

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
      projectId: 'orchestrator-pack',
      primary,
      executor: fakeExecutor([pane('a', 'OpenCode worker')], { a: 'done\nline-a' }),
      store: new MemoryPollingStore(),
      lines: 0,
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]?.lines).toEqual([]);
  });
});

describe('Issue #2441 observational-only fleet diagnostics', () => {
  const designated = (handle = 'agent', incarnationId = 'inc-1'): FleetTerminal => ({
    handle, incarnationId, title: 'OpenCode manager', worktreePath: workerPath,
    branch: 'refs/heads/diagnostic', agentIdentity: 'opencode',
  });
  const shell = (handle = 'agent', incarnationId = 'inc-1'): FleetTerminal => ({
    handle, incarnationId, title: 'bash', worktreePath: workerPath,
    branch: 'refs/heads/diagnostic',
  });
  const withStore = (run: (store: FileFleetStateStore) => void): void => {
    const xdg = mkdtempSync(join(tmpdir(), 'fleet-2441-'));
    try { run(new FileFleetStateStore('project', { XDG_RUNTIME_DIR: xdg })); }
    finally { rmSync(xdg, { recursive: true, force: true }); }
  };
  const diagnose = (store: FileFleetStateStore, terminals: FleetTerminal[], screens: Record<string, string>, now: number,
    calls: string[][] = [], shows: Readonly<Record<string, Record<string, unknown>>> = {},
    observations?: readonly FleetPaneObservation[]) =>
    collectFleetDiagnostics({ projectId: 'project', primary, workspaceRe: /orca\/workspaces\/project\//u,
      store, terminals, executor: fakeExecutor(terminals, screens, calls, shows), now: () => now,
      ...(observations ? { observations } : {}) });

  it('uses capture-shaped terminal evidence without command/PID/agent_alive and preserves the old classifier', () => withStore((store) => {
    const agent = designated();
    const exited = { ...designated('exited', 'inc-2'), status: 'exited' };
    const captured = designated('captured', 'inc-3');
    // Native Orca terminal metadata contains none of these child-liveness witnesses.
    for (const field of ['agent_alive', 'pid', 'command']) {
      expect(Object.hasOwn(captured, field)).toBe(false);
    }
    const terminals = [agent, exited, captured];
    const calls: string[][] = [];
    const rows = diagnose(store, terminals, {
      agent: 'work\nesc interrupt', captured: 'work\nesc interrupt',
    }, 0, calls);
    expect(rows.map((row) => [row.handle, row.reason])).toEqual([
      ['agent', 'agent_unverified'], ['exited', 'terminal_exited'], ['captured', 'agent_unverified'],
    ]);
    expect(rows[0]?.state).toBe('busy');
    expect(rows[1]?.evidence).toContain('terminal only');
    expect(formatFleetDiagnostics(rows)).not.toMatch(/agent_alive|pid=|command=/u);
    expect(calls.every((call) => call[0] === 'terminal' && call[1] === 'read')).toBe(true);
    expect(calls.some((call) => call.includes('exited'))).toBe(false);
    const standard = runFleetSweep({ projectId: 'project', primary, terminals: [agent],
      store, executor: fakeExecutor([agent], { agent: 'PARKED on PR #1 merged' }) });
    expect(standard[0]?.state).toBe('PARKED');
  }));

  it('requires prior native agentIdentity and exact nonempty composite identity for shell suspicion', () => withStore((store) => {
    const agent = designated();
    const normal = { agent: 'busy\nesc interrupt' };
    expect(diagnose(store, [agent], normal, 0)[0]?.reason).toBe('agent_unverified');
    expect(diagnose(store, [shell()], { agent: 'user@host:~$' }, 300_000)).toMatchObject([
      { handle: 'agent', state: 'STOPPED', reason: 'suspected_bare_shell' },
    ]);
    expect(store.readDiagnosticHistory('agent')?.agentIdentity).toBe('opencode');
    expect(diagnose(store, [shell()], { agent: 'user@host:~$' }, 450_000)[0]?.reason).toBe('suspected_bare_shell');
    expect(diagnose(store, [shell('never')], { never: '$' }, 300_000)).toEqual([]);

    const changed = { ...shell(), incarnationId: 'inc-replaced' };
    expect(diagnose(store, [changed], { agent: '$' }, 600_000)).toEqual([]);
    expect(diagnose(store, [shell()], { agent: '$' }, 900_000)).toEqual([]);
    expect(diagnose(store, [agent], normal, 1_200_000)[0]?.reason).toBe('agent_unverified');
    expect(diagnose(store, [{ ...shell(), branch: 'refs/heads/other' }], { agent: '$' }, 1_500_000)).toEqual([]);
    expect(diagnose(store, [shell()], { agent: '$' }, 1_800_000)).toEqual([]);
    expect(diagnose(store, [{ ...shell(), incarnationId: '' }], { agent: '$' }, 2_100_000)).toEqual([]);
  }));

  it('omits cold/invalid history and title-only prior agent-looking panes', () => withStore((store) => {
    expect(diagnose(store, [shell()], { agent: '$' }, 0)).toEqual([]);
    const titleOnly = { ...designated(), agentIdentity: undefined };
    expect(diagnose(store, [titleOnly], { agent: 'busy\nesc interrupt' }, 300_000)[0]?.reason).toBe('agent_unverified');
    expect(diagnose(store, [shell()], { agent: '$' }, 600_000)).toEqual([]);
    const path = join(store.root, 'diagnostic-' + createHash('sha256').update('agent').digest('hex').slice(0, 24) + '.json');
    writeFileSync(path, JSON.stringify({ key: 'legacy', designatedAgent: true, firstUnchangedObservedAt: 0 }), 'utf8');
    expect(diagnose(store, [shell()], { agent: '$' }, 900_000)).toEqual([]);
    const matchingKey = JSON.stringify(['project', 'agent', 'inc-1', workerPath, 'refs/heads/diagnostic']);
    writeFileSync(path, JSON.stringify({ key: matchingKey, designatedAgent: true,
      tailHash: 'a'.repeat(64), firstUnchangedObservedAt: 0 }), 'utf8');
    expect(diagnose(store, [shell()], { agent: '$' }, 1_200_000)).toEqual([]);
  }));

  it('flags stable busy at >=900s; resets for progress, content, identity and cosmetic chrome', () => withStore((store) => {
    const agent = designated();
    const normal = '┃ working on task\n▣  Pack-Opk-… · GPT-6 · medium\n⬝⬝ esc interrupt';
    const cosmetic = '┃ working on task\n▣  Pack-Opk-… · GPT-6 · medium 12:01\n⬝⬝ esc interrupt';
    const row = (now: number, screen = normal, value: FleetTerminal = agent) =>
      diagnose(store, [value], { agent: screen }, now)[0];
    expect(row(0)?.reason).toBe('agent_unverified');
    expect(row(300_000, cosmetic)?.reason).toBe('agent_unverified');
    expect(row(600_000)?.reason).toBe('agent_unverified');
    expect(row(899_999)?.reason).toBe('agent_unverified');
    expect(row(900_000)?.reason).toBe('suspected_hung');
    expect(row(1_200_000, normal, { ...agent, lastOutputAt: 12 })?.reason).toBe('agent_unverified');
    expect(row(2_100_000, normal, { ...agent, lastOutputAt: 12 })?.reason).toBe('suspected_hung');
    expect(row(2_400_000, '┃ new output\n⬝⬝ esc interrupt', { ...agent, lastOutputAt: 12 })?.reason).toBe('agent_unverified');
    expect(row(3_300_000, normal, designated('agent', 'new-incarnation'))?.reason).toBe('agent_unverified');
  }));

  it('never upgrades own PARKED or an existing polling mark to suspected death', () => withStore((store) => {
    const parked = designated('parked', 'inc-p');
    const poll = designated('poll', 'inc-q');
    store.setPollingMark('poll');
    const stable = { parked: 'PARKED on PR #1 merged', poll: '⠏ sleep 300\nesc interrupt' };
    const operational: FleetPaneObservation[] = [
      { ...parked, state: 'PARKED', lines: [], wait: 'PARKED on PR #1 merged', taskBinding: 'synthetic-exact-binding' },
      { ...poll, state: 'POLLING', lines: [] },
    ];
    expect(diagnose(store, [parked, poll], stable, 0, [], {}, operational).map((row) => row.state)).toEqual(['PARKED', 'POLLING']);
    const late = diagnose(store, [parked, poll], stable, 900_000, [], {}, operational);
    expect(late.map((row) => row.state)).toEqual(['PARKED', 'POLLING']);
    expect(late.every((row) => row.reason === 'agent_unverified')).toBe(true);
  }));

  it('distinguishes one malformed global census from isolated unreadable peer', () => withStore((store) => {
    const agent = designated();
    const peer = designated('peer', 'inc-peer');
    const bad: OrcaExecutor = (args) => args[1] === 'list'
      ? result(JSON.stringify({ ok: true, result: { terminals: [agent], totalCount: 2, truncated: true } }))
      : result('', false);
    const malformed = collectFleetDiagnostics({ projectId: 'project', primary, store, executor: bad });
    expect(malformed).toMatchObject([{ reason: 'fleet_census_unreadable' }]);
    expect(malformed).toHaveLength(1);
    const calls: string[][] = [];
    const good = collectFleetDiagnostics({ projectId: 'project', primary, store,
      executor: fakeExecutor([agent, peer], { peer: 'doing work\nesc interrupt' }, calls), now: () => 0 });
    expect(good.map((row) => [row.handle, row.reason])).toEqual([
      ['agent', 'unverified:screen_unreadable'], ['peer', 'agent_unverified'],
    ]);
    expect(calls.filter((call) => call[1] === 'read')).toHaveLength(2);
    expect(calls.every((call) => call[1] === 'list' || call[1] === 'read')).toBe(true);
  }));


  it.each(['ORCH_HANDLE', 'ARCHITECT_HANDLE'] as const)(
    'forwards %s CLI exclusion into read-only collection without a read or history entry', (variable) => withStore((store) => {
      const parsedTarget = vi.spyOn(targetContext, 'resolveTargetContext').mockReturnValue({
        projectId: 'project', repository: 'example/test', primaryRoot: primary, defaultBranch: 'main',
        orcaWorkspacePattern: '/orca/workspaces/project/', orchestratorTitlePattern: 'Cursor',
        browserGpt: { projectUrl: 'https://chatgpt.com/g/g-p/example/project' },
        packRoot: '/pack', cardPath: '/synthetic/project.json',
      });
      try {
        const parsed = parseSweepCli(['--project', 'project'], primary, { [variable]: ' agent ' });
        const agent = designated(), peer = designated('peer', 'inc-peer');
        const calls: string[][] = [];
        const rows = collectFleetDiagnostics({ ...parsed, terminals: [agent, peer], store,
          executor: fakeExecutor([agent, peer], { agent: 'done', peer: 'done' }, calls), now: () => 0 });
        expect(rows.map((r) => r.handle)).toEqual(['peer']);
        expect(calls.filter((args) => args[1] === 'read' || args[1] === 'show')
          .every((args) => !args.includes('agent'))).toBe(true);
        expect(store.readDiagnosticHistory('agent')).toBeUndefined();
      } finally { parsedTarget.mockRestore(); }
    }),
  );

  it('reads exact native terminal-show metadata when list summary omits branch and agentIdentity', () => withStore((store) => {
    const complete = designated();
    const listOnly = { handle: complete.handle, title: complete.title,
      incarnationId: complete.incarnationId, worktreePath: complete.worktreePath };
    const shown = { agent: { handle: complete.handle, incarnationId: complete.incarnationId,
      worktreePath: complete.worktreePath, branch: complete.branch, agentIdentity: 'opencode', lastOutputAt: 5 } };
    const calls: string[][] = [];
    const first = diagnose(store, [listOnly], { agent: 'work\nesc interrupt' }, 0, calls, shown);
    expect(first[0]?.reason).toBe('agent_unverified');
    expect(store.readDiagnosticHistory('agent')?.agentIdentity).toBe('opencode');
    expect(calls.filter((args) => args[1] === 'show')).toEqual([
      ['terminal', 'show', '--terminal', 'agent', '--json'],
    ]);
    const shellList = { ...listOnly, title: 'bash' };
    const lastShow = { agent: { ...shown.agent, agentIdentity: undefined } };
    expect(diagnose(store, [shellList], { agent: '$' }, 300_000, [], lastShow)[0]?.reason)
      .toBe('suspected_bare_shell');
    expect(store.readDiagnosticHistory('agent')?.agentIdentity).toBe('opencode');
  }));

  it('never manufactures history from missing/mismatched show evidence', () => withStore((store) => {
    const missing = { handle: 'agent', incarnationId: 'inc-1', title: 'OpenCode manager', worktreePath: workerPath };
    const showMismatch = { agent: { handle: 'agent', incarnationId: 'other-inc',
      worktreePath: workerPath, branch: 'refs/heads/diagnostic', agentIdentity: 'opencode' } };
    expect(diagnose(store, [missing], { agent: 'work\nesc interrupt' }, 0, [], showMismatch)[0]?.reason)
      .toBe('agent_unverified');
    expect(store.readDiagnosticHistory('agent')).toBeUndefined();
    expect(diagnose(store, [missing], { agent: 'work\nesc interrupt' }, 900_000)[0]?.reason)
      .toBe('agent_unverified');
    expect(store.readDiagnosticHistory('agent')).toBeUndefined();
    expect(diagnose(store, [{ ...missing, title: 'bash' }], { agent: '$' }, 1_200_000)).toEqual([]);
  }));

  it('reports exact prior agent with missing or unknown new title as unverified, not disappeared or dead', () => withStore((store) => {
    const initial = designated();
    expect(diagnose(store, [initial], { agent: 'work\nesc interrupt' }, 0)[0]?.reason)
      .toBe('agent_unverified');
    const unknown = { ...initial, agentIdentity: undefined, title: '' };
    const calls: string[][] = [];
    const current = diagnose(store, [unknown], { agent: 'current screen' }, 300_000, calls);
    expect(current).toMatchObject([{ handle: 'agent', reason: 'agent_unverified' }]);
    expect(current[0]?.state).toBeUndefined();
    expect(current[0]?.evidence).toContain('prior exact agentIdentity');
    expect(calls.some((args) => args[1] === 'read' && args.includes('agent'))).toBe(true);
    expect(diagnose(store, [{ ...unknown, incarnationId: 'new' }], { agent: 'current screen' }, 600_000)).toEqual([]);
    expect(diagnose(store, [{ ...unknown, handle: 'never' }], { never: 'current screen' }, 600_000)).toEqual([]);
  }));

  it('never reports a stable finished STOPPED pane as hung after 900 seconds', () => withStore((store) => {
    const terminal = designated();
    const operational: FleetPaneObservation[] = [{ ...terminal, state: 'STOPPED', lines: ['done'] }];
    expect(diagnose(store, [terminal], { agent: 'done' }, 0, [], {}, operational)[0]?.reason)
      .toBe('agent_unverified');
    const late = diagnose(store, [terminal], { agent: 'done' }, 900_000, [], {}, operational);
    expect(late[0]?.state).toBe('STOPPED');
    expect(late[0]?.reason).toBe('agent_unverified');
  }));

  it('mirrors retained PARKED acknowledgment and stale wait rejection without writing legacy task state', () => withStore((store) => {
    const terminal = designated();
    const perform = (current: FleetTerminal, screen: string, now: number) => {
      const observations = runFleetSweep({ projectId: 'project', primary, terminals: [current], store,
        executor: fakeExecutor([current], { agent: screen }) });
      const before = store.readPaneWait('agent');
      const rows = diagnose(store, [current], { agent: screen }, now, [], {}, observations);
      expect(store.readPaneWait('agent')).toEqual(before);
      return { state: observations[0]?.state, diagnostic: rows[0]?.state };
    };
    const parked = perform(terminal, 'PARKED on PR #1 merged', 0);
    expect(parked).toEqual({ state: 'PARKED', diagnostic: 'PARKED' });
    const acknowledged = perform(terminal, 'Acknowledged', 300_000);
    expect(acknowledged).toEqual({ state: 'PARKED', diagnostic: 'PARKED' });
    const changed = perform({ ...terminal, incarnationId: 'inc-new' }, 'PARKED on PR #1 merged', 600_000);
    expect(changed).toEqual({ state: 'STOPPED', diagnostic: 'STOPPED' });
  }));

  it('does not assert a bound PARKED state for an unbound screen even if the old operational result says PARKED', () => withStore((store) => {
    const unbound = { ...designated(), incarnationId: undefined };
    const observations = runFleetSweep({ projectId: 'project', primary, terminals: [unbound], store,
      executor: fakeExecutor([unbound], { agent: 'PARKED on PR #1 merged' }) });
    const rows = diagnose(store, [unbound], { agent: 'PARKED on PR #1 merged' }, 0, [], {}, observations);
    expect(observations[0]?.taskBinding).toBeUndefined();
    expect(rows[0]?.state).toBeUndefined();
    expect(rows[0]?.reason).toBe('agent_unverified');
  }));
});
