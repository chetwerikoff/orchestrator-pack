// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FileFleetWakeStateStore,
  bannerOwnerPane,
  listTerminalEnvelopes,
  fleetAlarmMessage,
  managerBannerMessage,
  runFleetAlarmTick,
  type FleetWakeConfig,
  type FleetWakeStateStore,
  type OpenPullHead,
  type TerminalEnvelopeEvent,
} from './fleet-wake.ts';
import { FileFleetStateStore, type FleetPaneObservation, type FleetTerminal, type OrcaCommandResult, type OrcaExecutor } from './fleet-sweep.ts';

class MemoryWakeStore implements FleetWakeStateStore {
  readonly root = '/xdg/fleet-sweep/project';
  readonly marks = new Set<string>();
  readonly parkedWakeEvents = new Set<string>();
  signature: string | null = null;
  hasPollingMark(handle: string): boolean { return this.marks.has(handle); }
  setPollingMark(handle: string): void { this.marks.add(handle); }
  clearPollingMark(handle: string): void { this.marks.delete(handle); }
  readLastSentSignature(): string | null { return this.signature; }
  writeLastSentSignature(signature: string): void { this.signature = signature; }
  clearLastSentSignature(): void { this.signature = null; }
  hasParkedWakeEvent(key: string): boolean { return this.parkedWakeEvents.has(key); }
  markParkedWakeEvent(key: string): void { this.parkedWakeEvents.add(key); }
}

function commandResult(stdout = '', ok = true): OrcaCommandResult {
  return { ok, stdout, stderr: ok ? '' : 'failed', exitCode: ok ? 0 : 1 };
}

const primary = '/home/user/project';
const workerBase = '/home/user/.local/share/orca/workspaces/project';
const terminals: FleetTerminal[] = [
  { handle: 'coord', title: 'Cursor coordinator', worktreePath: primary },
  { handle: 'one', title: 'OpenCode manager one', worktreePath: `${workerBase}/one` },
  { handle: 'two', title: 'Claude manager two', worktreePath: `${workerBase}/two` },
  { handle: 'shell', title: 'zsh', worktreePath: `${workerBase}/shell` },
];

function config(overrides: Partial<FleetWakeConfig> = {}): FleetWakeConfig {
  return {
    projectId: 'orchestrator-pack',
    primary,
    workspaceRe: /orca\/workspaces\/project\//u,
    orchestratorTitleRe: /Cursor/iu,
    busyRe: /(?:esc\s+(?:to\s+)?interrupt|ctrl\+c\s+to\s+stop)/iu,
    intervalSeconds: 300,
    ...overrides,
  };
}

function fakeOrca(
  screens: Readonly<Record<string, string>>,
  calls: string[][],
  customTerminals: readonly FleetTerminal[] = terminals,
): OrcaExecutor {
  return (args) => {
    calls.push([...args]);
    if (args[0] === 'terminal' && args[1] === 'list') {
      return commandResult(JSON.stringify({
        ok: true,
        result: { terminals: customTerminals, totalCount: customTerminals.length, truncated: false },
      }));
    }
    if (args[0] === 'terminal' && args[1] === 'read') {
      const handle = args[args.indexOf('--terminal') + 1] ?? '';
      return handle in screens ? commandResult(screens[handle] ?? '') : commandResult('', false);
    }
    if (args[0] === 'terminal' && args[1] === 'send') return commandResult('');
    return commandResult('', false);
  };
}

async function tick(input: {
  screens: Readonly<Record<string, string>>;
  store?: MemoryWakeStore;
  config?: FleetWakeConfig;
  terminals?: readonly FleetTerminal[];
  executor?: OrcaExecutor;
  listTerminalEnvelopes?: () => readonly TerminalEnvelopeEvent[];
  listUnreadRunMessages?: () => readonly { id: string; subject: string; toHandle: string; fromHandle: string }[];
  listOpenPulls?: (repository: string) => readonly OpenPullHead[];
  checkRunsFinishedAt?: (repository: string, sha: string) => number | undefined;
  supervisedPullOwner?: (pull: OpenPullHead, panes: readonly FleetPaneObservation[]) => FleetPaneObservation | undefined;
  readWorktreeHead?: (worktreePath: string) => string | undefined;
}) {
  const calls: string[][] = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  const store = input.store ?? new MemoryWakeStore();
  const baseExecutor = input.executor ?? fakeOrca(input.screens, [], input.terminals);
  const result = await runFleetAlarmTick({
    config: input.config ?? config(),
    executor: (args) => { calls.push([...args]); return baseExecutor(args); },
    store,
    sleepMs: async (ms) => { sleeps.push(ms); },
    log: (line) => { logs.push(line); },
    listTerminalEnvelopes: input.listTerminalEnvelopes ?? (() => []),
    ...(input.listUnreadRunMessages ? { listUnreadRunMessages: input.listUnreadRunMessages } : {}),
    ...(input.listOpenPulls ? { listOpenPulls: input.listOpenPulls } : {}),
    ...(input.checkRunsFinishedAt ? { checkRunsFinishedAt: input.checkRunsFinishedAt } : {}),
    ...(input.supervisedPullOwner ? { supervisedPullOwner: input.supervisedPullOwner } : {}),
    readWorktreeHead: input.readWorktreeHead ?? (() => undefined),
  });
  return { result, calls, logs, sleeps, store };
}

function sends(calls: readonly string[][]): string[][] {
  return calls.filter((call) => call[0] === 'terminal' && call[1] === 'send');
}

function sendsTo(calls: readonly string[][], handle: string): string[][] {
  return sends(calls).filter((call) => call[call.indexOf('--terminal') + 1] === handle);
}

describe('fleet alarm', () => {
  it('sends every idle interval, names only STOPPED/POLLING panes, and performs exactly text+enter then one extra enter', async () => {
    const store = new MemoryWakeStore();
    const screens = {
      coord: 'idle prompt',
      one: 'finished\n>',
      two: 'PARKED on PR #1 merged; resume step: x',
    };
    const first = await tick({ screens, store });
    expect(first.result).toMatchObject({ state: 'sent', coordinatorState: 'idle', count: 1 });
    expect(sends(first.calls)).toHaveLength(2);
    expect(sends(first.calls)[0]).toEqual(expect.arrayContaining(['--terminal', 'coord', '--text', '--enter']));
    expect(sends(first.calls)[1]).toEqual(['terminal', 'send', '--terminal', 'coord', '--enter']);
    expect(first.sleeps).toEqual([4_000]);
    const message = sends(first.calls)[0]![sends(first.calls)[0]!.indexOf('--text') + 1]!;
    expect(message).toContain('Fleet alarm (idle): 1 pane(s) need a step: STOPPED one OpenCode manager one');
    expect(message).not.toContain('manager two');

    const second = await tick({ screens, store });
    expect(second.result).toMatchObject({ state: 'sent', coordinatorState: 'idle', count: 1 });
    expect(sends(second.calls)).toHaveLength(2);
  });
  it('excludes the coordinator while sweeping agent panes in the same primary worktree', async () => {
    const workspacePrimary = '/home/che/orca/workspaces/project/fixture';
    const observed = await tick({
      config: config({ primary: workspacePrimary }),
      terminals: [
        { handle: 'coord', title: 'Cursor fixture-coordinator', worktreePath: workspacePrimary },
        { handle: 'agent', title: 'OC | fixture-agent', worktreePath: workspacePrimary },
        { handle: 'stopped', title: 'OC | fixture-stopped', worktreePath: workspacePrimary },
      ],
      screens: {
        coord: 'idle prompt',
        agent: 'doing work\nesc interrupt\n',
        stopped: 'done\n>',
      },
    });
    expect(observed.result).toMatchObject({ state: 'sent', coordinator: 'coord', count: 1 });
    const message = sends(observed.calls)[0]![sends(observed.calls)[0]!.indexOf('--text') + 1]!;
    expect(message).toContain('STOPPED stopped OC | fixture-stopped');
    expect(message).not.toContain('fixture-coordinator');
    expect(message).not.toContain('fixture-agent');
  });

  it('suppresses the same stopped set while coordinator is busy, then sends when the set changes', async () => {
    const store = new MemoryWakeStore();
    const first = await tick({
      screens: { coord: 'working\nctrl+c to stop', one: 'done', two: 'working\nesc to interrupt' },
      store,
    });
    expect(first.result).toMatchObject({ state: 'sent', coordinatorState: 'busy', count: 1 });

    const same = await tick({
      screens: { coord: 'working\nctrl+c to stop', one: 'done', two: 'working\nesc to interrupt' },
      store,
    });
    expect(same.result.state).toBe('same_stopped_set');
    expect(sends(same.calls)).toHaveLength(0);
    expect(same.logs).toContain('coord same stopped set already queued');

    const changed = await tick({
      screens: { coord: 'working\nctrl+c to stop', one: 'done', two: 'also done' },
      store,
    });
    expect(changed.result).toMatchObject({ state: 'sent', coordinatorState: 'busy', count: 2 });
    const message = sends(changed.calls)[0]![sends(changed.calls)[0]!.indexOf('--text') + 1]!;
    expect(message).toContain('STOPPED one');
    expect(message).toContain('STOPPED two');
  });

  it('does not suppress the same stopped set after the coordinator pane is replaced', async () => {
    const store = new MemoryWakeStore();
    const workers = terminals.filter((terminal) => terminal.handle !== 'coord');
    const first = await tick({
      terminals: [{ handle: 'coord-a', title: 'Cursor coordinator', worktreePath: primary }, ...workers],
      screens: { 'coord-a': 'working\nctrl+c to stop', one: 'done', two: 'working\nesc to interrupt' },
      store,
    });
    expect(first.result).toMatchObject({ state: 'sent', coordinator: 'coord-a', coordinatorState: 'busy', count: 1 });

    const replacement = await tick({
      terminals: [{ handle: 'coord-b', title: 'Cursor coordinator', worktreePath: primary }, ...workers],
      screens: { 'coord-b': 'working\nctrl+c to stop', one: 'done', two: 'working\nesc to interrupt' },
      store,
    });
    expect(replacement.result).toMatchObject({ state: 'sent', coordinator: 'coord-b', coordinatorState: 'busy', count: 1 });
    expect(sends(replacement.calls)).toHaveLength(2);
  });

  it('sends nothing for busy or PARKED panes and clears the remembered signature', async () => {
    const store = new MemoryWakeStore();
    store.signature = 'STOPPED one';
    const observed = await tick({
      screens: {
        coord: 'idle',
        one: 'working\nesc interrupt',
        two: 'PARKED on dependency merged; resume step: x',
      },
      store,
    });
    expect(observed.result.state).toBe('nothing_stopped');
    expect(observed.store.signature).toBeNull();
    expect(sends(observed.calls)).toHaveLength(0);
    expect(observed.logs).toContain('nothing stopped');
  });
  it('wakes the orchestrator once for each FLEET pane parked on an orchestrator answer', async () => {
    const store = new MemoryWakeStore();
    const fleetTerminal: FleetTerminal = { handle: 'fleet-unit', title: 'OpenCode manager', worktreePath: `${workerBase}/unit` };
    const fleetTerminals = [terminals[0]!, fleetTerminal];
    const first = await tick({ terminals: fleetTerminals, screens: { coord: 'idle', 'fleet-unit': 'work\nPARKED on orchestrator answer: approve deployment' }, store });
    expect(sendsTo(first.calls, 'coord')[0]?.join(' ')).toContain('fleet-unit');
    expect(sendsTo(first.calls, 'coord')[0]?.join(' ')).toContain('approve deployment');
    const repeated = await tick({ terminals: fleetTerminals, screens: { coord: 'idle', 'fleet-unit': 'work\nPARKED on orchestrator answer: approve deployment' }, store });
    expect(sendsTo(repeated.calls, 'coord')).toHaveLength(0);
  });

  it('wakes the orchestrator once per unread run message addressed to it, naming unit and subject', async () => {
    const store = new MemoryWakeStore();
    const fleetTerminal: FleetTerminal = { handle: 'fleet-unit', title: 'OpenCode manager', worktreePath: `${workerBase}/unit` };
    const fleetTerminals = [terminals[0]!, fleetTerminal];
    const listUnreadRunMessages = () => [{ id: 'msg-question-1', subject: 'Need approval', toHandle: 'run:run-1', fromHandle: 'fleet-unit' }];
    const first = await tick({ terminals: fleetTerminals, screens: { coord: 'idle', 'fleet-unit': 'working\nesc interrupt' }, listUnreadRunMessages, store });
    const message = sendsTo(first.calls, 'coord')[0]?.join(' ');
    expect(message).toContain('fleet-unit');
    expect(message).toContain('Need approval');
    const repeated = await tick({ terminals: fleetTerminals, screens: { coord: 'idle', 'fleet-unit': 'working\nesc interrupt' }, listUnreadRunMessages, store });
    expect(sendsTo(repeated.calls, 'coord')).toHaveLength(0);
  });

  it('wakes the idle pane of the launching worktree once per GPT terminal envelope, whatever its park line says', async () => {
    const store = new MemoryWakeStore();
    const envelope = {
      path: '/tmp/opencode/one-terminal.json',
      invocationId: '887cc977-f28e-4ab1-b498-e4ebced05551',
      cwd: `${workerBase}/one/scripts`,
    };
    const listTerminalEnvelopes = () => [envelope];
    const busy = await tick({
      screens: { coord: 'idle', one: 'working\nesc interrupt', two: 'working\nesc interrupt' },
      store,
      listTerminalEnvelopes,
    });
    expect(sendsTo(busy.calls, 'one')).toHaveLength(0);

    const idle = await tick({
      screens: { coord: 'idle', one: 'PARKED on whatever wording', two: 'working\nesc interrupt' },
      store,
      listTerminalEnvelopes,
    });
    expect(sendsTo(idle.calls, 'one')).toEqual([[
      'terminal', 'send', '--terminal', 'one',
      '--text', `Wake: GPT turn ${envelope.invocationId} ended, read ${envelope.path}`,
      '--enter',
    ], ['terminal', 'send', '--terminal', 'one', '--enter']]);

    const repeated = await tick({
      screens: { coord: 'idle', one: 'PARKED on whatever wording', two: 'working\nesc interrupt' },
      store,
      listTerminalEnvelopes,
    });
    expect(sendsTo(repeated.calls, 'one')).toHaveLength(0);
  });

  it('routes a chat banner to the launching pane named by its binding, whatever worktree the turn ran in', () => {
    const fixWorktree = `${workerBase}/issue-132-ruff-format-fix`;
    const terminals: FleetTerminal[] = [
      { handle: 'coord', title: 'Cursor coordinator', worktreePath: primary },
      { handle: 'mgr', title: 'OpenCode manager', worktreePath: `${workerBase}/leopoker-mgr-132`, agentIdentity: 'opencode' },
      { handle: 'sh1', title: 'shell', worktreePath: fixWorktree },
      { handle: 'sh2', title: 'shell', worktreePath: fixWorktree },
    ];
    const url = 'https://chatgpt.com/c/6ac03300-098c-83ec-a6d5-f9d0cec30a5f';
    const binding = { schema: 'chat-binding/v1' as const, conversation_url: url, worktree: fixWorktree, updated_at: '2026-10-03T01:46:20Z' };
    expect(bannerOwnerPane({ url }, terminals, config(), () => binding)).toBeUndefined();
    expect(bannerOwnerPane({ url }, terminals, config(), () => ({ ...binding, terminal_handle: 'mgr' }))?.handle).toBe('mgr');
  });

  it('wakes the launching pane named by a GPT terminal envelope even when the turn ran in another worktree', async () => {
    const listTerminalEnvelopes = () => [{ path: '/tmp/opencode/fix-terminal.json', invocationId: 'inv-h', cwd: '/elsewhere/fix', terminalHandle: 'one' }];
    const observed = await tick({ screens: { coord: 'idle', one: 'PARKED on anything', two: 'working\nesc interrupt' }, listTerminalEnvelopes });
    expect(sendsTo(observed.calls, 'one')[0]).toContain('Wake: GPT turn inv-h ended, read /tmp/opencode/fix-terminal.json');
  });

  it('lists launcher terminal envelopes that name their worktree', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-wake-terminal-'));
    try {
      const nested = join(root, 'nested');
      mkdirSync(nested, { recursive: true });
      const schema = 'flow-manager-long-running-child-terminal/v1';
      const routed = join(nested, 'routed-terminal.json');
      writeFileSync(routed, JSON.stringify({ schema, observed_invocation_id: 'inv-a', cwd: '/w/one' }), 'utf8');
      writeFileSync(join(root, 'unrouted-terminal.json'), JSON.stringify({ schema, observed_invocation_id: 'inv-b' }), 'utf8');
      writeFileSync(join(root, 'other-terminal.json'), JSON.stringify({ schema: 'x/v1', cwd: '/w/one' }), 'utf8');

      expect(listTerminalEnvelopes(root)).toEqual([{ path: routed, invocationId: 'inv-a', cwd: '/w/one' }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('wakes the idle owner of a PR once per finished CI run on its head', async () => {
    const store = new MemoryWakeStore();
    const now = Date.parse('2026-10-02T12:00:00Z');
    const headA = 'a'.repeat(40);
    const headB = 'b'.repeat(40);
    const owned: FleetTerminal[] = [
      { handle: 'coord', title: 'Cursor coordinator', worktreePath: primary },
      { handle: 'one', title: 'OpenCode manager one', worktreePath: `${workerBase}/one`, branch: 'refs/heads/fix/a' },
      { handle: 'mgr', title: 'OpenCode manager', worktreePath: `${workerBase}/leopoker-mgr-2317`, branch: 'refs/heads/chetwerikoff/mgr-2317' },
    ];
    const wakeConfig = config({ chatScope: { projectUrl: 'https://chatgpt.com/g/g-p/project/test', repository: 'chetwerikoff/orchestrator-pack' } });
    const listOpenPulls = () => [
      { number: 7, ref: 'fix/a', sha: headA },
      { number: 8, ref: 'issue-2317-split', sha: headB, issue: 2317 },
    ];
    const screens = { coord: 'idle', one: 'PARKED on any text', mgr: 'done for now' };
    const supervisedPullOwner = (pull: OpenPullHead): FleetPaneObservation | undefined => pull.issue === 2317
      ? { handle: 'mgr', title: 'OpenCode manager', state: 'PARKED', lines: ['PARKED'], worktreePath: `${workerBase}/leopoker-mgr-2317`, branch: 'refs/heads/chetwerikoff/mgr-2317' }
      : undefined;

    const first = await tick({ screens, store, config: wakeConfig, terminals: owned, listOpenPulls, supervisedPullOwner,
      checkRunsFinishedAt: (_repository, sha) => sha === headA ? now - 60_000 : undefined });
    expect(sendsTo(first.calls, 'one')[0]).toContain(`Wake: CI on ${headA} finished for PR #7`);
    expect(sendsTo(first.calls, 'mgr')).toHaveLength(0);

    const second = await tick({ screens, store, config: wakeConfig, terminals: owned, listOpenPulls, supervisedPullOwner,
      checkRunsFinishedAt: () => now - 60_000 });
    expect(sendsTo(second.calls, 'one')).toHaveLength(0);
    expect(sendsTo(second.calls, 'mgr')[0]).toContain(`Wake: CI on ${headB} finished for PR #8`);

    const rerun = await tick({ screens, store, config: wakeConfig, terminals: owned, listOpenPulls, supervisedPullOwner,
      checkRunsFinishedAt: (_repository, sha) => sha === headA ? now : now - 60_000 });
    expect(sendsTo(rerun.calls, 'one')[0]).toContain(`Wake: CI on ${headA} finished for PR #7`);
    expect(sendsTo(rerun.calls, 'mgr')).toHaveLength(0);
  });

  it('wakes only the exact Issue manager when the PR ref and manager worktree/branch differ', async () => {
    const manager: FleetTerminal = {
      handle: 'mgr', title: 'OpenCode manager', worktreePath: `${workerBase}/issue-145-r08-manager`,
      branch: 'refs/heads/chetwerikoff/issue-145-r08-manager', agentIdentity: 'opencode',
    };
    const foreign: FleetTerminal = {
      handle: 'foreign', title: 'OpenCode foreign manager', worktreePath: `${workerBase}/other-work`,
      branch: 'refs/heads/agent/issue-145-bulk-import-passes', agentIdentity: 'opencode',
    };
    const pull = { number: 150, ref: 'agent/issue-145-bulk-import-passes', sha: 'c'.repeat(40), issue: 145 };
    const baseExecutor = fakeOrca({ coord: 'idle', mgr: 'PARKED on CI', foreign: 'working\\nesc interrupt' }, [], [terminals[0]!, manager, foreign]);
    const executor: OrcaExecutor = (args) => {
      if (args[0] !== 'orchestration') return baseExecutor(args);
      if (args[1] === 'run-list') return commandResult(JSON.stringify({ ok: true, result: { runs: [{ id: 'run-145', objective: 'Execute Issue #145' }] } }));
      if (args[1] === 'task-list') return commandResult(JSON.stringify({ ok: true, result: { tasks: [{ id: 'task-145', spec: 'Issue #145 https://github.com/chetwerikoff/LeoPoker/issues/145', status: 'dispatched' }] } }));
      if (args[1] === 'dispatch-show') return commandResult(JSON.stringify({ ok: true, result: { dispatch: { id: 'ctx-manager', status: 'dispatched', assignee_handle: 'mgr' } } }));
      if (args[1] === 'worker-show') return commandResult(JSON.stringify({ ok: true, result: {
        dispatch: { id: 'ctx-manager', taskId: 'task-145', status: 'dispatched' },
        terminal: { handle: 'mgr', worktreePath: manager.worktreePath, branch: manager.branch },
        observation: { status: 'live', exactWorker: true },
      } }));
      return commandResult('', false);
    };
    const observed = await tick({
      terminals: [terminals[0]!, manager, foreign], executor,
      screens: { coord: 'idle', mgr: 'PARKED on CI', foreign: 'working\\nesc interrupt' },
      config: config({ chatScope: { projectUrl: 'https://chatgpt.com/g/g-p/project/test', repository: 'chetwerikoff/LeoPoker' } }),
      listOpenPulls: () => [pull],
      checkRunsFinishedAt: () => Date.parse('2026-10-03T18:00:00Z'),
    });
    expect(sendsTo(observed.calls, 'mgr')[0]).toContain(`Wake: CI on ${pull.sha} finished for PR #150`);
    expect(sendsTo(observed.calls, 'foreign')).toHaveLength(0);
    expect(observed.calls).toContainEqual(['orchestration', 'dispatch-show', '--task', 'task-145', '--json']);
    expect(observed.calls).toContainEqual(['orchestration', 'worker-show', '--dispatch', 'ctx-manager', '--json']);
  });

  it('falls back to the pane on the PR head when no supervised dispatch owns the Issue', async () => {
    const head = 'e'.repeat(40);
    const manager: FleetTerminal = {
      handle: 'mgr', title: 'OpenCode manager', worktreePath: `${workerBase}/leopoker-mgr-148`,
      branch: 'refs/heads/chetwerikoff/leopoker-mgr-148', agentIdentity: 'opencode',
    };
    const observed = await tick({
      terminals: [terminals[0]!, manager],
      screens: { coord: 'idle', mgr: 'PARKED on CI' },
      config: config({ chatScope: { projectUrl: 'https://chatgpt.com/g/g-p/project/test', repository: 'chetwerikoff/LeoPoker' } }),
      listOpenPulls: () => [{ number: 153, ref: 'leopoker-mgr-148', sha: head, issue: 148 }],
      checkRunsFinishedAt: () => Date.parse('2026-10-04T13:21:06Z'),
      supervisedPullOwner: () => undefined,
      readWorktreeHead: (worktreePath) => worktreePath === manager.worktreePath ? head : undefined,
    });
    expect(sendsTo(observed.calls, 'mgr')[0]).toContain(`Wake: CI on ${head} finished for PR #153`);
  });

  it('logs a finished-CI PR without an owner pane once per CI event', async () => {
    const store = new MemoryWakeStore();
    const head = 'f'.repeat(40);
    const input = {
      store,
      terminals: [terminals[0]!, terminals[1]!],
      screens: { coord: 'idle', one: 'PARKED on CI' },
      config: config({ chatScope: { projectUrl: 'https://chatgpt.com/g/g-p/project/test', repository: 'chetwerikoff/LeoPoker' } }),
      listOpenPulls: () => [{ number: 160, ref: 'nobody-here', sha: head, issue: 159 }],
      supervisedPullOwner: () => undefined,
    };
    const first = await tick({ ...input, checkRunsFinishedAt: () => Date.parse('2026-10-04T13:00:00Z') });
    expect(first.logs).toContain(`no owner pane for PR #160: CI finished on ${head}`);
    expect(sendsTo(first.calls, 'one')).toHaveLength(0);

    const repeated = await tick({ ...input, checkRunsFinishedAt: () => Date.parse('2026-10-04T13:00:00Z') });
    expect(repeated.logs.filter((line) => line.startsWith('no owner pane'))).toHaveLength(0);

    const rerun = await tick({ ...input, checkRunsFinishedAt: () => Date.parse('2026-10-04T14:00:00Z') });
    expect(rerun.logs).toContain(`no owner pane for PR #160: CI finished on ${head}`);
  });

  it('does not wake a pane when CI check-runs remain pending regardless of later review status', async () => {
    const observed = await tick({
      terminals: [terminals[0]!, terminals[1]!],
      screens: { coord: 'idle', one: 'PARKED on CI' },
      config: config({ chatScope: { projectUrl: 'https://chatgpt.com/g/g-p/project/test', repository: 'chetwerikoff/LeoPoker' } }),
      listOpenPulls: () => [{ number: 150, ref: 'agent/issue-145-bulk-import-passes', sha: 'd'.repeat(40), issue: 145 }],
      checkRunsFinishedAt: () => undefined,
    });
    expect(sendsTo(observed.calls, 'one')).toHaveLength(0);
  });

  it('honors ORCH_HANDLE, reports no coordinator when unresolved, and skips a failed screen read without throwing', async () => {
    const pinned = await tick({
      config: config({ orchestratorHandle: 'pinned' }),
      terminals: [...terminals, { handle: 'pinned', title: 'OpenCode', worktreePath: '/tmp/pinned' }],
      screens: { pinned: 'idle', one: 'done', two: 'working\nesc to interrupt' },
    });
    expect(pinned.result).toMatchObject({ state: 'sent', coordinator: 'pinned' });
    expect(sends(pinned.calls).every((call) => call.includes('pinned'))).toBe(true);

    const staleWorkerPin = await tick({
      config: config({ orchestratorHandle: 'one' }),
      screens: { one: 'done', two: 'working\nesc to interrupt' },
    });
    expect(staleWorkerPin.result.state).toBe('no_orchestrator');
    expect(sends(staleWorkerPin.calls)).toHaveLength(0);

    const missing = await tick({
      config: config({ orchestratorHandle: 'missing' }),
      screens: { coord: 'idle', one: 'done', two: 'working\nesc to interrupt' },
    });
    expect(missing.result.state).toBe('no_orchestrator');
    expect(sends(missing.calls)).toHaveLength(0);
    expect(missing.logs).toContain('normal fleet result: no orchestrator pane found');
    expect(missing.logs).not.toContain('nothing stopped');

    const unreadable = await tick({ screens: { coord: 'idle', two: 'working\nesc to interrupt' } });
    expect(unreadable.result).toEqual({ state: 'unreadable', handle: 'one' });
    expect(sends(unreadable.calls)).toHaveLength(0);
    expect(unreadable.logs).toContain('one unreadable');
  });

  it('keeps polling marks and the last-sent signature under XDG_RUNTIME_DIR only', () => {
    const xdg = mkdtempSync(join(tmpdir(), 'fleet-wake-xdg-'));
    try {
      const store = new FileFleetWakeStateStore('orchestrator-pack', { ...process.env, XDG_RUNTIME_DIR: xdg });
      store.setPollingMark('one');
      store.writeLastSentSignature('STOPPED one');
      expect(store.hasParkedWakeEvent('gpt:inv-2351')).toBe(false);
      store.markParkedWakeEvent('gpt:inv-2351');
      expect(store.hasParkedWakeEvent('gpt:inv-2351')).toBe(true);
      expect(store.root).toBe(join(xdg, 'fleet-sweep', 'orchestrator-pack'));
      const files = readdirSync(store.root).sort();
      expect(files).toContain('last-sent.signature');
      expect(files.filter((name) => /^parked-wake-[0-9a-f]{32}\.mark$/u.test(name))).toHaveLength(1);
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  });


  it('keeps polling and last-sent state disjoint by projectId even for equal target basenames', () => {
    const xdg = mkdtempSync(join(tmpdir(), 'fleet-wake-project-id-'));
    const env = { ...process.env, XDG_RUNTIME_DIR: xdg };
    try {
      const packPolling = new FileFleetStateStore('orchestrator-pack', env);
      const leoPolling = new FileFleetStateStore('leopoker', env);
      packPolling.setPollingMark('same-handle');
      expect(leoPolling.hasPollingMark('same-handle')).toBe(false);

      const packWake = new FileFleetWakeStateStore('orchestrator-pack', env);
      const leoWake = new FileFleetWakeStateStore('leopoker', env);
      packWake.writeLastSentSignature('same-target-basename');
      expect(leoWake.readLastSentSignature()).toBeNull();
      expect(packWake.root).not.toBe(leoWake.root);
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  });

  it('renders the fleet user unit from stable PACK_ROOT with --project %i and no per-project env file', () => {
    const unit = readFileSync(new URL('./fleet-wake@.service', import.meta.url), 'utf8');
    expect(unit).toContain('{PACK_ROOT}/scripts/fleet/fleet-wake.ts');
    expect(unit).toContain('--project %i');
    expect(unit).not.toContain('EnvironmentFile=');
    expect(unit).not.toContain('${PRIMARY}');
  });

  it('reads the coordinator Run inbox and mutates Orca only through terminal send to the resolved coordinator', async () => {
    const executor: OrcaExecutor = (args) => {
      if (args[0] === 'orchestration' && args[1] === 'run-list') {
        return commandResult(JSON.stringify({ ok: true, result: { runs: [{ id: 'run-1', coordinator_handle: 'coord' }] } }));
      }
      if (args[0] === 'orchestration' && args[1] === 'inbox' && args.includes('run:run-1')) {
        return commandResult(JSON.stringify({ ok: true, result: { messages: [{
          id: 'msg-1', subject: 'Need approval', read: 0, to_handle: 'run:run-1', from_handle: 'one',
        }] } }));
      }
      return fakeOrca({ coord: 'idle', one: 'done', two: 'working\nesc to interrupt' }, [], terminals)(args);
    };
    const observed = await tick({ executor, screens: { coord: 'idle', one: 'done', two: 'working\nesc to interrupt' } });
    expect(observed.calls).toContainEqual(['orchestration', 'run-list', '--json']);
    expect(observed.calls).toContainEqual(['orchestration', 'inbox', '--terminal', 'run:run-1', '--json', '--limit', '1000']);
    expect(sendsTo(observed.calls, 'coord')[0]?.join(' ')).toContain('Need approval');
    expect(sendsTo(observed.calls, 'coord')[0]?.join(' ')).toContain('one');
    expect(observed.calls.some((call) => call[0] === 'git' || call[0] === 'gh')).toBe(false);
    expect(sendsTo(observed.calls, 'one')).toHaveLength(0);
  });
});

describe('Issue #2342 unloadable chat', () => {
  it('asks for a new chat instead of a same-chat continuation', () => {
    const banner = {
      kind: 'unloadable' as const,
      url: 'https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174042',
      text: 'Could not load this ChatGPT conversation',
      retry: false,
    };
    expect(managerBannerMessage(banner)).toContain('continue the task in a new chat');
    expect(managerBannerMessage(banner)).not.toContain('same chat');
    expect(managerBannerMessage({ ...banner, review: true })).toContain('Restart the review in a new chat');
    const alarm = fleetAlarmMessage('idle', [], [banner]);
    expect(alarm).toContain('cannot be loaded');
    expect(alarm).not.toContain('need a continuation');
  });
});
