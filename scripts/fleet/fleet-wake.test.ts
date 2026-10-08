// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
import { resolveWakeSupervisorStateRoot } from '../pr2-foundation/wake-supervisor-state-root.ts';
import { FileFleetStateStore, type FleetPaneObservation, type FleetTerminal, type OrcaCommandResult, type OrcaExecutor } from './fleet-sweep.ts';
import { runLaunch, readTerminalEnvelope } from '../flow-manager-long-running-child.ts';
import { configuredProfileKey } from '../chatgpt-browser-turn/storage-common.ts';
import { admitStateLightTurnObservation, transitionStateLightTurnObservation } from '../chatgpt-browser-turn/state-light-turn-observation.ts';

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
  rearmParkedWakeEvents(observedKeys: ReadonlyMap<string, string | null>): void {
    for (const key of this.parkedWakeEvents) {
      for (const [handle, activeKey] of observedKeys) {
        if (!key.startsWith(`parked:${handle}:`)) continue;
        if (key !== activeKey) this.parkedWakeEvents.delete(key);
        break;
      }
    }
  }
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
  store?: FleetWakeStateStore;
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

// One owning shared prefix/footer; reconstruction preserves each observed UTF-8 byte.
function realOpenCodePane(kind: 'ack' | 'tool'): string {
  const collection = JSON.parse(readFileSync(new URL('./fixtures/opencode-external-wait.collection.json', import.meta.url), 'utf8')) as {
    prefix: string[]; responses: Record<'ack' | 'tool', string[]>; suffix: string[];
  };
  const pane = [...collection.prefix, ...collection.responses[kind], ...collection.suffix].join('\n') + '\n';
  const original = {
    ack: { bytes: 1270, sha256: '275c7961e5a0bb8ee345fd0186343a2df034636610c79e57f7523a41e65f88e6' },
    tool: { bytes: 1428, sha256: 'df19e9185526b71d992aa20133b7a1933c0369b10c4698c245c54f1ee0f73909' },
  }[kind];
  expect(Buffer.byteLength(pane, 'utf8')).toBe(original.bytes);
  expect(createHash('sha256').update(pane, 'utf8').digest('hex')).toBe(original.sha256);
  return pane;
}

describe('fleet alarm', () => {
  // Incident identity on synthetic screens only; all Orca effects are intercepted.
  const architectHandle = 'term_721dce76-e932-460a-8ebe-e9f80da9f056';
  const architect: FleetTerminal = { handle: architectHandle, title: 'Claude Code architect', worktreePath: primary };

  it.each([true, false])('excludes the idle incident architect only when configured: %s (#2422)', async (exclude) => {
    const observed = await tick({
      terminals: [terminals[0]!, architect],
      screens: { coord: 'idle', [architectHandle]: 'Ready for the next question.\n>' },
      config: config({ workspaceRe: /\/home\/user\//u, ...(exclude ? { architectHandle } : {}) }),
    });
    expect(observed.result.state).toBe(exclude ? 'nothing_stopped' : 'sent');
    expect(observed.calls.some((call) => call[1] === 'read' && call.includes(architectHandle))).toBe(!exclude);
    expect(sendsTo(observed.calls, architectHandle)).toHaveLength(0);
    if (!exclude) expect(sendsTo(observed.calls, 'coord')[0]?.join(' ')).toContain(architectHandle);
  });

  it('keeps stopped ordinary workers and identical architect titles in normal alarms (#2422)', async () => {
    const observed = await tick({
      terminals: [terminals[0]!, architect, terminals[1]!, { ...architect, handle: 'other-architect' }],
      screens: { coord: 'idle', one: 'done', 'other-architect': 'Ready.\n>' },
      config: config({ workspaceRe: /\/home\/user\//u, architectHandle }),
    });
    expect(observed.result).toMatchObject({ state: 'sent', count: 2, coordinator: 'coord' });
    const alarm = sendsTo(observed.calls, 'coord')[0]?.join(' ');
    expect(alarm).toContain('one');
    expect(alarm).toContain('other-architect');
    expect(alarm).not.toContain(architectHandle);
  });

  it('suppresses excluded GPT and CI event owners while ordinary worker events stay routed (#2422)', async () => {
    const head = 'a'.repeat(40);
    const owned = { ...architect, worktreePath: `${workerBase}/issue-2422`, branch: 'refs/heads/fix/architect' };
    const observed = await tick({
      terminals: [terminals[0]!, owned, { ...terminals[1]!, branch: 'refs/heads/fix/worker' }],
      screens: { coord: 'idle', one: 'done' },
      config: config({ architectHandle, chatScope: { projectUrl: 'https://chatgpt.com/g/g-p/project/test', repository: 'test/project' } }),
      listTerminalEnvelopes: () => [
        { path: '/tmp/opencode/architect-terminal.json', invocationId: 'architect', terminalHandle: architectHandle, cwd: `${workerBase}/one` },
        { path: '/tmp/opencode/architect-cwd-terminal.json', invocationId: 'architect-cwd', cwd: owned.worktreePath },
        { path: '/tmp/opencode/worker-terminal.json', invocationId: 'worker', terminalHandle: 'one' },
      ],
      listOpenPulls: () => [{ number: 1, ref: 'fix/architect', sha: 'b'.repeat(40), issue: 2422 }, { number: 2, ref: 'fix/worker', sha: head }],
      supervisedPullOwner: (_pull, panes) => panes.find((pane) => pane.handle === architectHandle),
      readWorktreeHead: () => head,
      checkRunsFinishedAt: () => 1,
    });
    expect(sendsTo(observed.calls, architectHandle)).toHaveLength(0);
    expect(observed.calls.some((call) => call[1] === 'read' && call.includes(architectHandle))).toBe(false);
    const messages = sendsTo(observed.calls, 'one').filter((call) => call.includes('--text')).map((call) => call.join(' '));
    expect(messages).toEqual(expect.arrayContaining([expect.stringContaining('GPT turn worker'), expect.stringContaining('PR #2')]));
    expect(messages.some((message) => message.includes('GPT turn architect') || message.includes('PR #1'))).toBe(false);
  });

  it.each(['launcher', 'worktree', 'branch', 'issue'])('excludes exact architect banner ownership via %s (#2422)', (route) => {
    const url = 'https://chatgpt.com/c/fixture-2422';
    const owned = { ...architect, worktreePath: `${workerBase}/issue-2422`, branch: 'refs/heads/fix/architect' };
    const binding = { schema: 'chat-binding/v1' as const, conversation_url: url, worktree: owned.worktreePath, updated_at: '2026-10-08T00:00:00Z',
      ...(route === 'launcher' ? { terminal_handle: architectHandle } : {}) };
    const readBinding = () => route === 'launcher' || route === 'worktree' ? binding : undefined;
    const banner = { url, ...(route === 'branch' ? { pull: 1 } : { issue: 2422 }) };
    const settings = config({ architectHandle, chatScope: { projectUrl: 'https://chatgpt.com/g/g-p/project/test', repository: 'test/project' } });
    expect(bannerOwnerPane(banner, [owned], settings, readBinding, () => 'fix/architect')).toBeUndefined();
    const other = { ...owned, handle: 'ordinary-worker' };
    expect(bannerOwnerPane(banner, [other], settings, readBinding, () => 'fix/architect')?.handle).toBe('ordinary-worker');
  });

  it.each(['idle acknowledgment', 'busy mid-answer', 'polling mid-answer', 'tool summary', 'raw tool gutter', 'gear tool',
    'gutter # Running inspection', 'gutter → Read scripts/example.ts', 'gutter ⚙ hashline_edit scripts/example.ts',
    'gutter Click to expand', 'gutter { "state": "closed" }'])(
    'attributes the exact real OpenCode fixture across %s', async (mode) => {
      const fixture = realOpenCodePane('ack');
      const root = mkdtempSync(join(tmpdir(), 'fleet-2398-real-pane-'));
      const store = new FileFleetWakeStateStore('real-pane', { XDG_RUNTIME_DIR: root });
      const unit = { ...terminals[1]!, incarnationId: 'real-incarnation', status: 'running', branch: 'manager' };
      const fleet = [terminals[0]!, unit];
      const screens = { coord: 'working\nctrl+c to stop', one: fixture.split('\n').slice(0, 7).join('\n') };
      const executor = fakeOrca(screens, [], fleet);
      const step = () => tick({ screens, store, terminals: fleet, executor });
      try {
        await step();
        const before = store.readPaneWait('one');
        expect(before?.wait).toContain('PARKED on #222 merged');
        if (mode.includes('mid-answer')) {
          const writes = vi.spyOn(store, 'writePaneWait');
          const clears = vi.spyOn(store, 'clearPaneWait');
          screens.one = `${fixture.split('\n').slice(0, 12).join('\n')}\n${mode === 'polling mid-answer' ? 'sleep 60\n' : ''}esc interrupt`;
          await step();
          if (mode === 'polling mid-answer') await step();
          expect(store.readPaneWait('one')).toEqual(before);
          expect(writes).not.toHaveBeenCalled();
          expect(clears).not.toHaveBeenCalled();
          writes.mockRestore();
          clears.mockRestore();
        }
        screens.coord = 'idle prompt';
        const toolWork = ['tool summary', 'raw tool gutter', 'gear tool'].includes(mode) || mode.startsWith('gutter ');
        screens.one = mode === 'raw tool gutter'
          ? realOpenCodePane('tool')
          : toolWork ? fixture.replace(
            '     Принял: park на merge #222 без изменений.',
            mode === 'gear tool' ? '     ⚙ hashline_edit scripts/example.ts\n     Patch summary: applied.'
              : '     → Read scripts/example.ts\n     $ gh pr view 225\n     Inspection summary: the gate was inspected.',
          ) : fixture;
        if (mode.startsWith('gutter ')) {
          const rawTool = realOpenCodePane('tool').split('\n');
          screens.one = [...rawTool.slice(0, 14), `  ┃  ${mode.slice(7)}`, '  ┃', ...rawTool.slice(20)].join('\n');
        }
        for (let index = 0; index < 3; index += 1) {
          const observed = await step();
          expect(observed.result.state).toBe(toolWork ? 'sent' : 'nothing_stopped');
          if (!toolWork) expect(sends(observed.calls)).toHaveLength(0);
          else expect(store.readPaneWait('one')).toBeUndefined();
        }
        if (mode.includes('mid-answer')) {
          screens.one = fixture.replace('     Принял: park на merge #222 без изменений.', '     finished new step');
          expect((await step()).result.state).toBe('sent');
          expect(store.readPaneWait('one')).toBeUndefined();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  // Scrubbed OpenCode pane shapes and acknowledgment excerpts from the architect's live audit.
  it.each(['Принял смену архитектора…', 'Audit: … Keep PARKED…'])(
    'retains an unbound failed-dispatch manager after %s, then invalidates new work', async (acknowledgment) => {
      const root = mkdtempSync(join(tmpdir(), 'fleet-2398-unbound-'));
      const store = new FileFleetWakeStateStore('unbound', { XDG_RUNTIME_DIR: root });
      const unit = { ...terminals[1]!, incarnationId: 'unbound-inc-one', status: 'running', branch: 'manager' };
      const fleet = [terminals[0]!, unit];
      const screens = { coord: 'working\nctrl+c to stop', one: 'PARKED on orchestrator answer: external gate' };
      const base = fakeOrca(screens, [], fleet);
      const executor: OrcaExecutor = (args) => args[0] === 'orchestration' && args[1] === 'worker-list'
        ? commandResult(JSON.stringify({ ok: true, result: { workers: [
          { agentTerminalHandle: 'one', dispatchId: 'old-failed', taskId: 'old-task', dispatchStatus: 'failed' },
        ], page: { hasMore: false } } })) : base(args);
      let projectId = config().projectId;
      const step = () => tick({ screens, store, terminals: fleet, executor, config: config({ projectId }) });
      const park = async () => {
        screens.one = '┃ PARKED: wait orchestrator answer:\n┃ external gate\n>';
        await step();
        screens.one = `┃ ${acknowledgment}\n>\n╹▀▀▀▀▀▀▀▀`;
      };
      try {
        await step();
        screens.one += '\n> Audit: keep the same external wait; no new step is assigned.';
        await step();
        screens.one += `\n${acknowledgment}`;
        await step();
        screens.coord = 'idle prompt';
        screens.one = `${Array.from({ length: 31 }, () => '╹▀▀▀▀▀▀▀▀').join('\n')}\n┃ ${acknowledgment}\n>`;
        for (let index = 0; index < 3; index += 1) {
          const observed = await step();
          expect(observed.result.state).toBe('nothing_stopped');
          expect(sends(observed.calls)).toHaveLength(0);
        }
        screens.one = '$ gh pr view 1\nTool: completed inspection\n\nAssistant: Audit summary: the inspection is complete.';
        expect((await step()).result.state).toBe('sent');
        expect(store.readPaneWait('one')).toBeUndefined();
        await park();
        screens.one = 'Можно продолжать?';
        expect((await step()).result.state).toBe('sent');
        for (const outcome of ['STOPPED', 'done', 'finished', 'handed-off', 'worker_done', 'error', 'one\n\ntwo\n\nthree\n\nfour']) {
          await park();
          screens.one = outcome;
          expect((await step()).result.state).toBe('sent');
          expect(store.readPaneWait('one')).toBeUndefined();
        }
        await park();
        screens.one = 'Проверка без изменений.\nLa condition reste identique.\n依存条件は変わっていません。';
        expect((await step()).result.state).toBe('nothing_stopped');
        screens.one = 'PARKED on orchestrator answer: a different gate';
        expect(sendsTo((await step()).calls, 'coord')[0]?.join(' ')).toContain('a different gate');
        for (const change of ['branch', 'worktree', 'project']) {
          await park();
          if (change === 'branch') unit.branch = 'replacement-manager';
          if (change === 'worktree') unit.worktreePath = '/home/che/orca/workspaces/project/replacement';
          if (change === 'project') projectId = 'replacement-project';
          expect((await step()).result.state).toBe('sent');
          expect(store.readPaneWait('one')).toBeUndefined();
        }
        await park();
        unit.incarnationId = 'unbound-inc-two';
        expect((await step()).result.state).toBe('sent');
        expect(store.readPaneWait('one')).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(['unchanged', 'wrapped', 'question', 'resume', 'task', 'incarnation', 'exited', 'busy', 'polling', 'mail', 'ci', 'gpt-completed', 'gpt-failed', 'gpt-dead', 'task-stale', 'incarnation-stale', 'new-blocker', 'removed'])(
    'retains correction/acknowledgment/redraw across three idle ticks, then handles %s', async (next) => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-2398-sequence-'));
    const store = new FileFleetWakeStateStore('sequence', { XDG_RUNTIME_DIR: root });
    const unit = { ...terminals[1]!, incarnationId: 'inc-one', status: 'running', branch: 'refs/heads/repair' };
    let taskId = 'task-one';
    let dispatchId = 'ctx-one';
    const fleet = [terminals[0]!, unit];
    const screens = { coord: 'working\nctrl+c to stop', one: 'PARKED on orchestrator answer: approve deployment' };
    const base = fakeOrca(screens, [], fleet);
    const executor: OrcaExecutor = (args) => {
      if (args[0] !== 'orchestration') return base(args);
      if (args[1] === 'worker-list') return commandResult(JSON.stringify({ ok: true, result: {
        workers: [{ agentTerminalHandle: 'one', dispatchId, taskId, dispatchStatus: 'dispatched' }],
        page: { hasMore: false },
      } }));
      if (args[1] === 'worker-show') return commandResult(JSON.stringify({ ok: true, result: {
        dispatch: { id: dispatchId, taskId, status: 'dispatched' },
        terminal: unit, observation: { status: 'live', exactWorker: true },
      } }));
      return commandResult('', false);
    };
    const step = () => tick({ screens, store, terminals: fleet, executor });
    try {
      const initial = await step();
      expect(sendsTo(initial.calls, 'coord')[0]?.join(' ')).toContain('approve deployment');
      screens.one += '\n> Correction: retain this unchanged wait; do not reinvestigate.';
      await step();
      screens.one += '\nAcknowledged.';
      await step();
      screens.coord = 'idle prompt';
      screens.one = `${Array.from({ length: 31 }, () => '╹▀▀▀▀▀▀▀▀').join('\n')}\n┃ Acknowledged.\n┃ The external gate is unchanged.\n>`;
      for (let index = 0; index < 3; index += 1) {
        const idle = await step();
        expect(idle.result.state).toBe('nothing_stopped');
        expect(sends(idle.calls)).toHaveLength(0);
      }
      const freshWait = async () => {
        screens.one = 'PARKED on orchestrator answer: approve deployment';
        await step();
        screens.one = 'Acknowledged.';
      };
      if (next === 'wrapped') {
        screens.one = '┃ PARKED: wait orchestrator answer:\n┃ approve deployment';
        expect((await step()).result.state).toBe('nothing_stopped');
        expect(store.readPaneWait('one')?.wait).toBe('PARKED on orchestrator answer: approve deployment');
      } else if (next === 'task-stale' || next === 'incarnation-stale') {
        screens.one = 'PARKED on orchestrator answer: approve deployment';
        if (next === 'task-stale') { taskId = 'task-two'; dispatchId = 'ctx-two'; }
        else unit.incarnationId = 'inc-two';
        for (let index = 0; index < 3; index += 1) expect((await step()).result.state).toBe('sent');
      } else if (next === 'new-blocker') {
        screens.one = 'PARKED on orchestrator answer: approve staging';
        expect(sendsTo((await step()).calls, 'coord')[0]?.join(' ')).toContain('approve staging');
      } else if (next === 'removed') {
        fleet.pop();
        expect((await step()).result.state).toBe('nothing_stopped');
        expect(store.readPaneWait('one')).toBeUndefined();
      } else if (next === 'question' || next === 'resume') {
        screens.one = next === 'question' ? 'May I deploy to staging?' : 'Working on the new step\nesc interrupt';
        const observed = await step();
        expect(observed.result.state).toBe(next === 'question' ? 'sent' : 'nothing_stopped');
        // Busy alone is not a resume; the idle own outcome must supply that evidence.
        screens.one = next === 'resume' ? 'finished new step' : 'Acknowledged.';
        expect((await step()).result.state).toBe('sent');
      } else if (next === 'task' || next === 'incarnation' || next === 'exited') {
        if (next === 'task') { taskId = 'task-two'; dispatchId = 'ctx-two'; }
        if (next === 'incarnation') unit.incarnationId = 'inc-two';
        if (next === 'exited') unit.status = 'exited';
        expect((await step()).result.state).toBe('sent');
        expect(store.readPaneWait('one')).toBeUndefined();
      } else if (next === 'busy' || next === 'polling') {
        screens.one = next === 'busy' ? 'useful work\nesc interrupt' : 'running sleep 60\nesc interrupt';
        expect((await step()).result.state).toBe('nothing_stopped');
        expect((await step()).result.state).toBe(next === 'polling' ? 'sent' : 'nothing_stopped');
      } else if (next === 'mail') {
        const observed = await tick({ screens, store, executor, terminals: fleet, listUnreadRunMessages: () => [
          { id: 'new-question', subject: 'New deployment question', fromHandle: 'one', toHandle: 'run:run-one' },
        ] });
        expect(sendsTo(observed.calls, 'coord')[0]?.join(' ')).toContain('New deployment question');
      } else if (next === 'ci' || next.startsWith('gpt-')) {
        await freshWait();
        const head = 'a'.repeat(40);
        const envelope = join(root, `${next}-terminal.json`);
        if (next.startsWith('gpt-')) writeFileSync(envelope, JSON.stringify({
          schema: 'flow-manager-long-running-child-terminal/v1', observed_invocation_id: next,
          terminal_handle: 'one', cwd: unit.worktreePath, turn_result_cause: next.slice(4),
        }));
        const observed = await tick({ screens, store, executor, terminals: fleet,
          config: config({ chatScope: { projectUrl: 'https://chatgpt.com/g/g-p/project/test', repository: 'chetwerikoff/orchestrator-pack' } }),
          listTerminalEnvelopes: () => listTerminalEnvelopes(root),
          listOpenPulls: () => next === 'ci' ? [{ number: 1, ref: 'repair', sha: head }] : [],
          checkRunsFinishedAt: () => 1234,
        });
        expect(sendsTo(observed.calls, 'one')[0]?.join(' ')).toContain(next === 'ci' ? `CI on ${head} finished` : `GPT turn ${next} ended`);
        expect(store.readPaneWait('one')).toBeUndefined();
        expect((await step()).result.state).toBe('sent');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('alarms a new own question even with the same stopped handle and a busy coordinator', async () => {
    const store = new MemoryWakeStore();
    const screens = { coord: 'working\nctrl+c to stop', one: 'finished', two: 'working\nesc interrupt' };
    expect((await tick({ screens, store })).result.state).toBe('sent');
    expect((await tick({ screens, store })).result.state).toBe('same_stopped_set');
    screens.one = 'May I deploy to staging?';
    expect((await tick({ screens, store })).result.state).toBe('sent');
  });
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
    expect(observed.store.readLastSentSignature()).toBeNull();
    expect(sends(observed.calls)).toHaveLength(0);
    expect(observed.logs).toContain('nothing stopped');
  });
  it('wakes once per PARKED episode and re-arms identical text after the pane resumes', async () => {
    const store = new MemoryWakeStore();
    const fleetTerminal: FleetTerminal = { handle: 'fleet-unit', title: 'OpenCode manager', worktreePath: `${workerBase}/unit` };
    const fleetTerminals = [terminals[0]!, fleetTerminal];
    const parked = { coord: 'idle', 'fleet-unit': 'work\nPARKED on orchestrator answer: approve deployment' };
    const first = await tick({ terminals: fleetTerminals, screens: parked, store });
    expect(sendsTo(first.calls, 'coord')[0]?.join(' ')).toContain('fleet-unit');
    expect(sendsTo(first.calls, 'coord')[0]?.join(' ')).toContain('approve deployment');

    const repeated = await tick({ terminals: fleetTerminals, screens: parked, store });
    expect(sendsTo(repeated.calls, 'coord')).toHaveLength(0);

    const temporarilyMissing = await tick({
      terminals: [terminals[0]!],
      screens: { coord: 'idle' },
      store,
    });
    expect(sendsTo(temporarilyMissing.calls, 'coord')).toHaveLength(0);

    const sameEpisodeAfterMissing = await tick({ terminals: fleetTerminals, screens: parked, store });
    expect(sendsTo(sameEpisodeAfterMissing.calls, 'coord')).toHaveLength(0);

    const changedPark = await tick({
      terminals: fleetTerminals,
      screens: { coord: 'idle', 'fleet-unit': 'work\nPARKED on orchestrator answer: use staging' },
      store,
    });
    expect(sendsTo(changedPark.calls, 'coord')[0]?.join(' ')).toContain('use staging');

    const originalParkAgain = await tick({ terminals: fleetTerminals, screens: parked, store });
    expect(sendsTo(originalParkAgain.calls, 'coord')[0]?.join(' ')).toContain('approve deployment');

    const resumed = await tick({
      terminals: fleetTerminals,
      screens: { coord: 'idle', 'fleet-unit': 'working\nesc to interrupt' },
      store,
    });
    expect(sendsTo(resumed.calls, 'coord')).toHaveLength(0);

    const parkedAgain = await tick({ terminals: fleetTerminals, screens: parked, store });
    expect(sendsTo(parkedAgain.calls, 'coord')[0]?.join(' ')).toContain('approve deployment');
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

  it.each(['throw', 'SIGTERM', 'SIGKILL'])('wakes the fake owner once for a real post-send %s envelope (#2416)', async (exit) => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-wake-2416-'));
    try {
      vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', join(root, 'state'));
      vi.stubEnv('ORCA_TERMINAL_HANDLE', 'one');
      const profile = join(root, 'profile');
      const cdp = 'http://127.0.0.1:1';
      const invocationId = `inv-wake-${exit}`;
      const profileKey = configuredProfileKey(profile, cdp);
      admitStateLightTurnObservation({ profileKey, invocationId, marker: 'OPKTURNV1a97e3f70e9c07fa75c0f03840c0528a2' });
      transitionStateLightTurnObservation({ profileKey, invocationId, phase: 'dispatching', reason: 'fixture' });
      transitionStateLightTurnObservation({ profileKey, invocationId, phase: 'sent_unbound', reason: 'send_observed_fresh_chat', sendCount: 1, sendWitness: 'numeric_send_count' });
      const envelope = join(root, 'turn-terminal.json');
      const source = exit === 'throw' ? 'throw new Error("post-send");' : `process.kill(process.pid, '${exit}');`;
      expect(await runLaunch({ runIdentity: 'run-wake', attemptIdentity: `attempt-${exit}`,
        handoffReceiptPath: join(root, 'handoff.json'), terminalEnvelopePath: envelope, terminalEnvelopeRoot: root,
        browserOutputPath: join(root, 'output.txt'), cwd: process.cwd(), childCommand: process.execPath,
        childArgs: ['-e', source, '--', '--profile', profile, '--cdp', cdp, '--invocation-id', invocationId],
      })).toBe(1);
      expect(readTerminalEnvelope(envelope)).toMatchObject({ delivery: 'POSSIBLY_DELIVERED', send_count: 1, terminal_handle: 'one' });
      const store = new MemoryWakeStore();
      const input = { store, screens: { coord: 'idle', one: `PARKED on GPT turn ${invocationId}`, two: 'working\nesc interrupt' },
        listTerminalEnvelopes: () => listTerminalEnvelopes(root) };
      const first = await tick(input);
      expect(sendsTo(first.calls, 'one').filter((args) => args.includes('--text'))).toHaveLength(1);
      expect(sendsTo((await tick(input)).calls, 'one')).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
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

  it('does not use cwd to wake an unrelated pane when the explicit GPT owner is unobserved', async () => {
    const store = new MemoryWakeStore();
    const envelope = {
      path: '/tmp/opencode/unobserved-owner-terminal.json',
      invocationId: 'inv-explicit-owner',
      cwd: `${workerBase}/one/scripts`,
      terminalHandle: 'two',
    };
    const listTerminalEnvelopes = () => [envelope];
    const screens = {
      coord: 'working\nesc interrupt',
      one: 'PARKED on unrelated turn',
      two: 'PARKED on owner turn',
    };
    const absent = await tick({
      terminals: [terminals[0]!, terminals[1]!],
      screens,
      store,
      listTerminalEnvelopes,
    });
    expect(sends(absent.calls)).toHaveLength(0);
    expect(store.hasParkedWakeEvent(`gpt:${envelope.path}`)).toBe(false);

    const withOwner = {
      terminals: [terminals[0]!, terminals[1]!, terminals[2]!],
      screens,
      store,
      listTerminalEnvelopes,
    };
    const delivered = await tick(withOwner);
    expect(sends(delivered.calls)).toEqual([[
      'terminal', 'send', '--terminal', 'two',
      '--text', `Wake: GPT turn ${envelope.invocationId} ended, read ${envelope.path}`,
      '--enter',
    ], ['terminal', 'send', '--terminal', 'two', '--enter']]);
    expect(store.hasParkedWakeEvent(`gpt:${envelope.path}`)).toBe(true);

    const repeated = await tick(withOwner);
    expect(sends(repeated.calls)).toHaveLength(0);
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
      const parkedKey = 'parked:one:PARKED on orchestrator answer: approve deployment';
      store.markParkedWakeEvent(parkedKey);
      expect(store.hasParkedWakeEvent(parkedKey)).toBe(true);
      store.rearmParkedWakeEvents(new Map([['one', null]]));
      expect(store.hasParkedWakeEvent(parkedKey)).toBe(false);
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

  it('uses inbox message fields directly when the coordinator Run consumer is fenced, resolves a stale Run coordinator, and wakes even when the sender is gone', async () => {
    const previousStateHome = process.env.XDG_STATE_HOME;
    const previousWakeStateDir = process.env.OPK_WAKE_SUPERVISOR_STATE_DIR;
    const stateHome = mkdtempSync(join(tmpdir(), 'fleet-wake-run-pane-key-'));
    process.env.XDG_STATE_HOME = stateHome;
    delete process.env.OPK_WAKE_SUPERVISOR_STATE_DIR;
    const runPaneKeyRoot = resolveWakeSupervisorStateRoot({ projectId: 'leopoker' });
    mkdirSync(runPaneKeyRoot, { recursive: true });
    writeFileSync(
      join(runPaneKeyRoot, 'orchestration-run-pane-keys.json'),
      JSON.stringify({ 'run-1': { handle: 'term_coord_old', paneKey: 'tab-coord:leaf-coord' } }) + '\n',
      'utf8',
    );

    const currentCoordinator: FleetTerminal = { handle: 'term_coord_new', title: 'Cursor coordinator', worktreePath: primary };
    const currentTerminals = [currentCoordinator];
    const currentTerminalJson = {
      handle: 'term_coord_new',
      title: 'Cursor coordinator',
      worktreePath: primary,
      incarnationId: 'generation-coord-new',
    };
    const executor: OrcaExecutor = (args) => {
      if (args[0] === 'terminal' && args[1] === 'list' && args.includes('--include-visual-layouts')) {
        return commandResult(JSON.stringify({
          ok: true,
          result: { visualLayouts: [{ root: { handle: 'term_coord_new', tabId: 'tab-coord', leafId: 'leaf-coord' } }] },
        }));
      }
      if (args[0] === 'terminal' && args[1] === 'show' && args.includes('term_coord_new')) {
        return commandResult(JSON.stringify({ ok: true, result: { terminal: currentTerminalJson } }));
      }
      if (args[0] === 'orchestration' && args[1] === 'run-show') {
        return commandResult(JSON.stringify({
          ok: true,
          result: { run: { id: 'run-1', coordinator_handle: 'term_coord_old' } },
        }));
      }
      if (args[0] === 'orchestration' && args[1] === 'inbox' && args.includes('--full')) {
        return commandResult(JSON.stringify({
          ok: true,
          result: { messages: [{
            id: 'msg-1', run_id: 'run-1', to_handle: 'run:run-1', read: 0,
            subject: 'Need approval', from_handle: 'gone-sender', created_at: '2026-10-06T10:00:00Z',
          }] },
        }));
      }
      if (args[0] === 'orchestration' && args[1] === 'check' && args.includes('run-1')) {
        return commandResult(JSON.stringify({ ok: false, error: { code: 'consumer_fenced' } }), false);
      }
      return fakeOrca({ 'term_coord_new': 'idle' }, [], currentTerminals)(args);
    };

    try {
      const observed = await tick({
        executor,
        terminals: currentTerminals,
        config: config({ projectId: 'leopoker', orchestratorHandle: 'term_coord_new' }),
        screens: { 'term_coord_new': 'idle' },
      });
      expect(observed.calls).toContainEqual(['orchestration', 'inbox', '--full', '--limit', '5000', '--json']);
      expect(observed.calls).toContainEqual(['orchestration', 'run-show', '--id', 'run-1', '--json']);
      expect(observed.calls.some((call) => call[0] === 'orchestration' && call[1] === 'check')).toBe(false);
      expect(sendsTo(observed.calls, 'term_coord_new')[0]?.join(' ')).toContain('Need approval');
      expect(sendsTo(observed.calls, 'term_coord_new')[0]?.join(' ')).toContain('gone-sender');
      expect(observed.calls.some((call) => call[0] === 'git' || call[0] === 'gh')).toBe(false);
      expect(sendsTo(observed.calls, 'gone-sender')).toHaveLength(0);
    } finally {
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousStateHome;
      if (previousWakeStateDir === undefined) delete process.env.OPK_WAKE_SUPERVISOR_STATE_DIR;
      else process.env.OPK_WAKE_SUPERVISOR_STATE_DIR = previousWakeStateDir;
      rmSync(stateHome, { recursive: true, force: true });
    }
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
