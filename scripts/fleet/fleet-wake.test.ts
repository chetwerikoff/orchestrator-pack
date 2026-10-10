// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import * as targetContext from '../lib/target-context.ts';
import { describe, expect, it, vi } from 'vitest';
import {
  FileFleetWakeStateStore,
  bannerOwnerPane,
  listTerminalEnvelopes,
  potentiallySentUnboundEnvelope,
  fleetAlarmMessage,
  fleetWakeConfigFromEnv,
  managerBannerMessage,
  runFleetAlarmTick,
  runFleetDiagnosticTick,
  type FleetAlarmTickOptions,
  type FleetWakeConfig,
  type FleetWakeStateStore,
  type OpenPullHead,
  type TerminalEnvelopeEvent,
} from './fleet-wake.ts';
import { resolveWakeSupervisorStateRoot } from '../pr2-foundation/wake-supervisor-state-root.ts';
import type { ChatErrorBanner, ProjectChat } from './chat-error-banners.ts';
import { FileFleetStateStore, type FleetPaneObservation, type FleetTerminal, type OrcaCommandResult, type OrcaExecutor } from './fleet-sweep.ts';
import { runLaunch, readTerminalEnvelope } from '../flow-manager-long-running-child.ts';
import { configuredProfileKey } from '../chatgpt-browser-turn/storage-common.ts';
import { admitStateLightTurnObservation, transitionStateLightTurnObservation } from '../chatgpt-browser-turn/state-light-turn-observation.ts';

class MemoryWakeStore implements FleetWakeStateStore {
  readonly root = '/xdg/fleet-sweep/project';
  readonly marks = new Set<string>();
  readonly parkedWakeEvents = new Set<string>();
  readonly eventStatus = new Map<string, 'sent' | 'attempted_unverified'>();
  readonly epochs = new Map<string, { key: string; since: number }>();
  signature: string | null = null;
  sentAt: number | undefined;
  hasPollingMark(handle: string): boolean { return this.marks.has(handle); }
  setPollingMark(handle: string): void { this.marks.add(handle); }
  clearPollingMark(handle: string): void { this.marks.delete(handle); }
  readLastSentSignature(): string | null { return this.signature; }
  writeLastSentSignature(signature: string): void { this.signature = signature; }
  clearLastSentSignature(): void { this.signature = null; }
  readLastSentAt(): number | undefined { return this.sentAt; }
  writeLastSentAt(at: number): void { this.sentAt = at; }
  clearLastSentAt(): void { this.sentAt = undefined; }
  readParkedEpoch(handle: string): { key: string; since: number } | undefined { return this.epochs.get(handle); }
  writeParkedEpoch(handle: string, epoch: { key: string; since: number }): void { this.epochs.set(handle, epoch); }
  clearParkedEpoch(handle: string): void { this.epochs.delete(handle); }
  pruneParkedEpochs(keys: ReadonlyMap<string, string>): void {
    for (const [handle, epoch] of this.epochs) if (keys.get(handle) !== epoch.key) this.epochs.delete(handle);
  }
  hasParkedWakeEvent(key: string): boolean { return this.parkedWakeEvents.has(key); }
  readParkedWakeEventStatus(key: string): 'sent' | 'attempted_unverified' | undefined {
    return this.parkedWakeEvents.has(key) ? this.eventStatus.get(key) ?? 'sent' : undefined;
  }
  markParkedWakeEvent(key: string, status: 'sent' | 'attempted_unverified' = 'sent'): void {
    this.parkedWakeEvents.add(key);
    this.eventStatus.set(key, status);
  }
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
  readChats?: FleetAlarmTickOptions['readChats'];
  closeChat?: FleetAlarmTickOptions['closeChat'];
  listTerminalEnvelopes?: () => readonly TerminalEnvelopeEvent[];
  listUnreadRunMessages?: () => readonly { id: string; subject: string; toHandle: string; fromHandle: string }[];
  listOpenPulls?: (repository: string) => readonly OpenPullHead[];
  checkRunsFinishedAt?: (repository: string, sha: string) => number | undefined;
  supervisedPullOwner?: (pull: OpenPullHead, panes: readonly FleetPaneObservation[]) => FleetPaneObservation | undefined;
  readWorktreeHead?: (worktreePath: string) => string | undefined;
  readNamedPull?: FleetAlarmTickOptions['readNamedPull'];
  readNamedReview?: FleetAlarmTickOptions['readNamedReview'];
  readPackReviewStage?: FleetAlarmTickOptions['readPackReviewStage'];
  now?: () => number;
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
    ...(input.readChats ? { readChats: input.readChats } : {}),
    ...(input.closeChat ? { closeChat: input.closeChat } : {}),
    listTerminalEnvelopes: input.listTerminalEnvelopes ?? (() => []),
    ...(input.listUnreadRunMessages ? { listUnreadRunMessages: input.listUnreadRunMessages } : {}),
    ...(input.listOpenPulls ? { listOpenPulls: input.listOpenPulls } : {}),
    ...(input.checkRunsFinishedAt ? { checkRunsFinishedAt: input.checkRunsFinishedAt } : {}),
    ...(input.supervisedPullOwner ? { supervisedPullOwner: input.supervisedPullOwner } : {}),
    readWorktreeHead: input.readWorktreeHead ?? (() => undefined),
    ...(input.readNamedPull ? { readNamedPull: input.readNamedPull } : {}),
    ...(input.readNamedReview ? { readNamedReview: input.readNamedReview } : {}),
    ...(input.readPackReviewStage ? { readPackReviewStage: input.readPackReviewStage } : {}),
    ...(input.now ? { now: input.now } : {}),
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
    const ordinaryBinding = () => route === 'launcher' ? { ...binding, terminal_handle: other.handle } : readBinding();
    expect(bannerOwnerPane(banner, [other], settings, ordinaryBinding, () => 'fix/architect')?.handle).toBe('ordinary-worker');
  });

  it.each(['worktree', 'branch', 'issue'])('does not reassign an excluded explicit banner owner through %s fallback (#2422 review)', (route) => {
    const url = 'https://chatgpt.com/c/fixture-excluded-launcher';
    const other = { ...terminals[1]!, worktreePath: `${workerBase}/issue-2422`, branch: 'refs/heads/fix/worker' };
    const binding = { schema: 'chat-binding/v1' as const, conversation_url: url,
      terminal_handle: architectHandle, worktree: route === 'worktree' ? other.worktreePath : '/elsewhere', updated_at: '2026-10-08T00:00:00Z' };
    expect(bannerOwnerPane({ url, issue: 2422, ...(route === 'branch' ? { pull: 1 } : {}) },
      [architect, other], config({ architectHandle, chatScope: { projectUrl: 'https://chatgpt.com/g/g-p/project/test', repository: 'test/project' } }),
      () => binding, () => 'fix/worker')).toBeUndefined();
  });

  it.each([true, false])('passes the operator env file through config to an intercepted tick: %s (#2422 r01)', async (exclude) => {
    // Systemd owns EnvironmentFile loading; no local file, service, browser or GitHub is touched.
    const docs = readFileSync(new URL('../../docs/fleet-alarm.md', import.meta.url), 'utf8');
    expect(docs).toContain('[Service]\nEnvironmentFile=%h/.config/orchestrator-fleet/%i.env');
    const publicTemplate = readFileSync(new URL('./fleet-wake.env.example', import.meta.url), 'utf8');
    const env = parseEnv(`${publicTemplate}\nORCH_HANDLE=coord\n${exclude ? `ARCHITECT_HANDLE= ${architectHandle} ` : ''}\n`);
    const target = vi.spyOn(targetContext, 'resolveTargetContext').mockReturnValue({
      projectId: 'fixture', repository: 'test/project', primaryRoot: primary, defaultBranch: 'main',
      orcaWorkspacePattern: '/home/user/', orchestratorTitlePattern: 'Cursor',
      browserGpt: { projectUrl: 'https://chatgpt.com/g/g-p/project/test' }, packRoot: '/pack', cardPath: '/fixture/card.json',
    });
    try {
      const settings = fleetWakeConfigFromEnv(env, ['--project', 'fixture']);
      expect(settings.architectHandle).toBe(exclude ? architectHandle : undefined);
      expect(settings.orchestratorHandle).toBe('coord');
      const calls: string[][] = [];
      const result = await runFleetAlarmTick({
        config: settings, executor: fakeOrca({ coord: 'idle', [architectHandle]: 'Ready.\n>' }, calls, [terminals[0]!, architect]),
        store: new MemoryWakeStore(), sleepMs: async () => {}, log: () => {},
        readChats: async () => [], closeChat: async () => { throw new Error('unexpected close'); },
        listTerminalEnvelopes: () => [{ path: '/tmp/opencode/architect-terminal.json', invocationId: 'fixture', terminalHandle: architectHandle }],
        listUnreadRunMessages: () => [], listOpenPulls: () => [], readWorktreeHead: () => undefined,
      });
      expect(result.state).toBe(exclude ? 'nothing_stopped' : 'sent');
      expect(calls.some((call) => call[1] === 'read' && call.includes(architectHandle))).toBe(!exclude);
      expect(sendsTo(calls, architectHandle)).toHaveLength(exclude ? 0 : 2);
      if (!exclude) expect(sendsTo(calls, 'coord')[0]?.join(' ')).toContain(architectHandle);
    } finally { target.mockRestore(); }
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
          expect(['sent', 'same_stopped_set', 'nothing_stopped']).toContain(observed.result.state);
          // A new unresolvable-PARKED alarm may go to the coordinator once;
          // unchanged rechecks do not authorize direct unit sends or spam.
          if (!toolWork) expect(sendsTo(observed.calls, 'one')).toHaveLength(0);
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
        for (let index = 0; index < 3; index += 1) {
          expect(['sent', 'same_stopped_set']).toContain((await step()).result.state);
        }
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
  it('throttles an unchanged idle alarm while preserving the two-Enter send', async () => {
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
    expect(second.result).toMatchObject({ state: 'same_stopped_set', coordinator: 'coord' });
    expect(sends(second.calls)).toHaveLength(0);
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

  it('alarms unresolvable PARKED without direct unit sends, then clears an idle signature when nothing is actionable', async () => {
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
    expect(observed.result.state).toBe('sent');
    expect(sendsTo(observed.calls, 'one')).toHaveLength(0);
    expect(sendsTo(observed.calls, 'two')).toHaveLength(0);
    expect(sendsTo(observed.calls, 'coord')[0]?.join(' ')).toContain('unresolvable producer');
    const cleared = await tick({
      screens: { coord: 'idle', one: 'working\nesc interrupt', two: 'working\nesc interrupt' },
      store,
    });
    expect(cleared.result.state).toBe('nothing_stopped');
    expect(store.readLastSentSignature()).toBeNull();
    expect(sends(cleared.calls)).toHaveLength(0);
    expect(cleared.logs).toContain('nothing stopped');
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

  it.each(['throw', 'SIGTERM', 'SIGKILL'])('does not wake a guessed owner for a post-send %s envelope (#2434)', async (exit) => {
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
      expect(sendsTo(first.calls, 'one')).toHaveLength(0);
      expect(first.logs.some((line) => line.includes('owner_generation_unproven'))).toBe(true);
      expect(sendsTo((await tick(input)).calls, 'one')).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });


  it('suppresses both genuine no-result observation-pointer and pointerless ordinary sent-unbound events', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-wake-2434-owner-'));
    try {
      vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', join(root, 'state'));
      const profileKey = configuredProfileKey('synthetic-profile', 'http://127.0.0.1:1');
      const invocationId = 'synthetic-invocation-no-result';
      const record = admitStateLightTurnObservation({
        profileKey, invocationId, marker: 'OPKTURNV100000000000000000000000000000001',
      });
      expect(record.profile_key).toBe(profileKey);
      transitionStateLightTurnObservation({
        profileKey, invocationId, phase: 'dispatching', reason: 'synthetic_dispatch',
      });
      transitionStateLightTurnObservation({
        profileKey, invocationId, phase: 'sent_unbound', reason: 'synthetic_sent_once',
        sendCount: 1, sendWitness: 'numeric_send_count',
      });
      const envelope = {
        path: join(root, 'no-result-terminal.json'), invocationId,
        observedInvocationId: invocationId, sendCount: 1,
        persistedObservationProfileKey: profileKey, terminalHandle: 'one',
      };
      const pointerlessResult = {
        path: join(root, 'ordinary-success-terminal.json'), invocationId,
        observedInvocationId: invocationId, sendCount: 1, terminalHandle: 'one',
      };
      const pointerlessChildState = { ...pointerlessResult, path: join(root, 'child-state-terminal.json') };
      const store = new MemoryWakeStore();
      const input = {
        store, screens: { coord: 'idle', one: 'PARKED on owner', two: 'working\\nesc interrupt' },
        listTerminalEnvelopes: () => [envelope, pointerlessResult, pointerlessChildState],
      };
      expect(potentiallySentUnboundEnvelope(envelope)).toBe(true);
      expect(potentiallySentUnboundEnvelope(pointerlessResult)).toBe(true);
      const first = await tick(input);
      expect(sendsTo(first.calls, 'one')).toHaveLength(0);
      expect(first.logs.filter((line) => line.includes('owner_generation_unproven'))).toHaveLength(3);
      expect(store.hasParkedWakeEvent(`gpt:${envelope.path}`)).toBe(false);
      expect(sendsTo((await tick(input)).calls, 'one')).toHaveLength(0);

      // An unknown/malformed legacy owner is still not a current launch witness.
      const broken = { ...envelope, persistedObservationProfileKey: profileKey + '-missing' };
      expect(potentiallySentUnboundEnvelope(broken)).toBe(true);
      expect(potentiallySentUnboundEnvelope({ ...envelope, observedInvocationId: 'foreign' })).toBe(true);
      expect(potentiallySentUnboundEnvelope({ path: 'other-event', invocationId: 'other', terminalHandle: 'one' })).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not route a producer-shaped zero-count possibly delivered send through a recycled terminal handle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-wake-2434-zero-count-'));
    try {
      const possiblePath = join(root, 'possible-terminal.json');
      const notSentPath = join(root, 'not-sent-terminal.json');
      const base = {
        schema: 'flow-manager-long-running-child-terminal/v1',
        observed_invocation_id: 'synthetic-send-failed',
        terminal_handle: 'one',
        send_count: 0,
      };
      // Result-present send_failed: the composer action may have taken effect
      // even though the numeric send witness was never established.
      writeFileSync(possiblePath, JSON.stringify({
        ...base, delivery: 'POSSIBLY_DELIVERED', turn_result_state: 'send_failed',
      }));
      writeFileSync(notSentPath, JSON.stringify({
        ...base, observed_invocation_id: 'synthetic-before-send', delivery: 'not-sent',
        turn_result_state: 'driver_error',
      }));
      const envelopes = listTerminalEnvelopes(root);
      const possible = envelopes.find((event) => event.path === possiblePath);
      const notSent = envelopes.find((event) => event.path === notSentPath);
      expect(possible).toMatchObject({
        sendCount: 0, delivery: 'POSSIBLY_DELIVERED', terminalHandle: 'one',
        observedInvocationId: 'synthetic-send-failed',
      });
      expect(notSent).toMatchObject({ sendCount: 0, delivery: 'not-sent' });
      expect(potentiallySentUnboundEnvelope(possible!)).toBe(true);
      expect(potentiallySentUnboundEnvelope(notSent!)).toBe(false);
      const store = new MemoryWakeStore();
      const input = {
        store, screens: { coord: 'idle', one: 'PARKED on another turn', two: 'working\\nesc interrupt' },
        listTerminalEnvelopes: () => envelopes,
      };
      const first = await tick(input);
      expect(first.logs.some((line) => line.includes(`owner_generation_unproven gpt:${possiblePath}`))).toBe(true);
      const sentToRecycledHandle = sendsTo(first.calls, 'one');
      expect(sentToRecycledHandle).toHaveLength(2);
      expect(sentToRecycledHandle.flat().join(' ')).toContain(notSentPath);
      expect(sentToRecycledHandle.flat().join(' ')).not.toContain(possiblePath);
      expect(sendsTo((await tick(input)).calls, 'one')).toHaveLength(0);
    } finally {
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
    expect(sendsTo(absent.calls, 'one')).toHaveLength(0);
    expect(sendsTo(absent.calls, 'two')).toHaveLength(0);
    expect(sendsTo(absent.calls, 'coord')[0]?.join(' ')).toContain('unresolvable producer');
    expect(store.hasParkedWakeEvent(`gpt:${envelope.path}`)).toBe(false);

    const withOwner = {
      terminals: [terminals[0]!, terminals[1]!, terminals[2]!],
      screens,
      store,
      listTerminalEnvelopes,
    };
    const delivered = await tick(withOwner);
    expect(sendsTo(delivered.calls, 'two')).toEqual([[
      'terminal', 'send', '--terminal', 'two',
      '--text', `Wake: GPT turn ${envelope.invocationId} ended, read ${envelope.path}`,
      '--enter',
    ], ['terminal', 'send', '--terminal', 'two', '--enter']]);
    expect(sendsTo(delivered.calls, 'one')).toHaveLength(0);
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

      expect(listTerminalEnvelopes(root)).toEqual([{ path: routed, invocationId: 'inv-a', observedInvocationId: 'inv-a', cwd: '/w/one' }]);
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


describe('Issue #2463 parked-producer wake, reminders and alarm cadence', () => {
  const sha = 'a'.repeat(40);
  const invocation = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const repository = 'test/project';
  const nativePull = (merged = false, headSha = sha) => ({
    number: 12, headSha, state: merged ? 'closed' as const : 'open' as const, merged,
  });

  function parkedHarness(wait: string, extraTerminals: FleetTerminal[] = []) {
    const unit: FleetTerminal = {
      ...terminals[1]!, incarnationId: 'inc-2463', branch: 'refs/heads/issue-2463',
      status: 'running', agentIdentity: 'supervised-worker',
    };
    const fleet: FleetTerminal[] = [terminals[0]!, unit, ...extraTerminals];
    const screens: Record<string, string> = { coord: 'idle', one: wait };
    const store = new MemoryWakeStore();
    let currentTime = 0;
    let currentTask = 'task-2463';
    let currentDispatch = 'dispatch-2463';
    let exact = true;
    let failSecondEnter = false;
    let failCoordinatorRead = false;
    let failCoordinatorSend = false;
    const base = fakeOrca(screens, [], fleet);
    const executor: OrcaExecutor = (args) => {
      if (args[0] === 'orchestration' && args[1] === 'worker-list') {
        return commandResult(JSON.stringify({ ok: true, result: {
          workers: [{ agentTerminalHandle: 'one', taskId: currentTask,
            dispatchId: currentDispatch, dispatchStatus: exact ? 'dispatched' : 'failed' }],
          page: { hasMore: false },
        } }));
      }
      if (args[0] === 'orchestration' && args[1] === 'worker-show') {
        return commandResult(JSON.stringify({ ok: true, result: {
          dispatch: { id: currentDispatch, taskId: currentTask, status: 'dispatched' },
          terminal: unit, observation: { status: 'live', exactWorker: true },
        } }));
      }
      if (failSecondEnter && args[0] === 'terminal' && args[1] === 'send'
        && args.includes('one') && !args.includes('--text')) return commandResult('', false);
      if (failCoordinatorRead && args[0] === 'terminal' && args[1] === 'read'
        && args.includes('coord')) return commandResult('', false);
      if (failCoordinatorSend && args[0] === 'terminal' && args[1] === 'send'
        && args.includes('coord')) return commandResult('', false);
      return base(args);
    };
    const step = (overrides: Partial<Parameters<typeof tick>[0]> = {}) => tick({
      screens, store, terminals: fleet, executor, now: () => currentTime,
      config: config({ chatScope: { projectUrl: 'https://chatgpt.com/p/synthetic', repository } }),
      listTerminalEnvelopes: () => [],
      listOpenPulls: () => [],
      checkRunsFinishedAt: () => undefined,
      readNamedPull: () => undefined,
      readNamedReview: () => undefined,
      readPackReviewStage: () => undefined,
      ...overrides,
    });
    return {
      unit, fleet, screens, store, step,
      time: (milliseconds: number) => { currentTime = milliseconds; },
      task: (id: string) => { currentTask = id; currentDispatch = 'dispatch-' + id; },
      exact: (value: boolean) => { exact = value; },
      failSecond: (value: boolean) => { failSecondEnter = value; },
      failCoordRead: (value: boolean) => { failCoordinatorRead = value; },
      failCoordSend: (value: boolean) => { failCoordinatorSend = value; },
    };
  }

  function unitText(calls: readonly string[][]): string[] {
    return sendsTo(calls, 'one').filter((call) => call.includes('--text'))
      .map((call) => call[call.indexOf('--text') + 1]!);
  }

  function expectSafeWake(calls: readonly string[][], state: string): void {
    const text = unitText(calls);
    expect(text).toHaveLength(1);
    expect(text[0]).toMatch(/^Wake: .+ ended state .+ evidence .+ - re-check the producer yourself before continuing$/u);
    expect(text[0]).toContain('ended state ' + state + ' evidence ');
    expect(text[0]).toMatch(/^[A-Za-z0-9 _./:%#=+-]+$/u);
    expect(text[0]).not.toMatch(/[;&|$'"()<>*?\\\x00-\x1f\x7f]/u);
    expect(sendsTo(calls, 'one')).toHaveLength(2);
    expect(text[0]).not.toMatch(/^[!$]/u);
  }

  it('wakes the verified LeoPoker manager for its exact leopoker-272 GPT terminal envelope', async () => {
    // Synthetic fleet-wake@leopoker; no LeoPoker service, terminal or GitHub reads.
    const invocationId = '27227227-1111-4111-8111-272272272272';
    const wrongInvocationId = '27227227-1111-4111-8111-272272272273';
    const envelopePath = `/tmp/opencode/leopoker-272-${invocationId}-terminal.json`;
    const leopokerPrimary = '/synthetic/LeoPoker';
    const unit: FleetTerminal = {
      handle: 'leopoker-manager-272', title: 'OpenCode manager',
      worktreePath: '/synthetic/orca/workspaces/leopoker/272',
      branch: 'refs/heads/issue-272', incarnationId: 'leopoker-inc-272',
      status: 'running', agentIdentity: 'supervised-manager',
    };
    const coordinator: FleetTerminal = {
      handle: 'leopoker-coordinator', title: 'Cursor coordinator', worktreePath: leopokerPrimary,
    };
    const fleet = [coordinator, unit];
    const screens = { [coordinator.handle]: 'idle', [unit.handle]: `PARKED on GPT turn ${invocationId}` };
    const base = fakeOrca(screens, [], fleet);
    const executor: OrcaExecutor = (args) => {
      if (args[0] === 'orchestration' && args[1] === 'worker-list') {
        return commandResult(JSON.stringify({ ok: true, result: {
          workers: [{ agentTerminalHandle: unit.handle, taskId: 'leopoker-task-272',
            dispatchId: 'leopoker-dispatch-272', dispatchStatus: 'dispatched' }],
          page: { hasMore: false },
        } }));
      }
      if (args[0] === 'orchestration' && args[1] === 'worker-show') {
        return commandResult(JSON.stringify({ ok: true, result: {
          dispatch: { id: 'leopoker-dispatch-272', taskId: 'leopoker-task-272', status: 'dispatched' },
          terminal: unit, observation: { status: 'live', exactWorker: true },
        } }));
      }
      return base(args);
    };
    const envelope: TerminalEnvelopeEvent = {
      path: envelopePath, invocationId, observedInvocationId: invocationId,
      terminalHandle: unit.handle, cwd: unit.worktreePath, delivery: 'landed',
    };
    const options = {
      screens, terminals: fleet, executor,
      config: config({
        projectId: 'leopoker', primary: leopokerPrimary,
        workspaceRe: /orca\/workspaces\/leopoker\//u,
        chatScope: { projectUrl: 'https://chatgpt.com/p/synthetic-leopoker', repository: 'chetwerikoff/LeoPoker' },
      }),
      listTerminalEnvelopes: () => [envelope],
      listOpenPulls: () => [], listUnreadRunMessages: () => [],
    };
    const matched = await tick({ ...options, store: new MemoryWakeStore() });
    expect(matched.calls).toContainEqual(['orchestration', 'worker-list', '--json']);
    expect(matched.calls).toContainEqual(['orchestration', 'worker-show', '--dispatch', 'leopoker-dispatch-272', '--json']);
    expect(sendsTo(matched.calls, unit.handle)).toEqual([
      ['terminal', 'send', '--terminal', unit.handle, '--text',
        `Wake: GPT-turn-${invocationId} ended state terminal-envelope evidence ${envelopePath} - re-check the producer yourself before continuing`, '--enter'],
      ['terminal', 'send', '--terminal', unit.handle, '--enter'],
    ]);
    expect(sendsTo(matched.calls, coordinator.handle)).toHaveLength(0);

    // A previously handled legacy envelope cannot validate a different parked UUID.
    const legacySeen = new MemoryWakeStore();
    legacySeen.markParkedWakeEvent(`gpt:${envelopePath}`);
    screens[unit.handle] = `PARKED on GPT turn ${wrongInvocationId}`;
    const wrong = await tick({ ...options, store: legacySeen });
    expect(sendsTo(wrong.calls, unit.handle)).toHaveLength(0);
    expect(sendsTo(wrong.calls, coordinator.handle)[0]?.join(' ')).toContain('park on unresolvable producer');
  });

  it('wakes fleet-wake@leopoker only when pack-gpt-review PR #268 finishes at the exact head', async () => {
    // Synthetic live-shaped LeoPoker unit and GitHub stage; no live service or PR is contacted.
    const repository = 'chetwerikoff/LeoPoker';
    const head = '268'.repeat(13) + '2';
    const wait = 'PARKED on pack-review PR #268 head ' + head;
    const primaryRoot = '/synthetic/LeoPoker';
    const unit: FleetTerminal = {
      handle: 'leopoker-manager-268', title: 'OpenCode manager',
      worktreePath: '/synthetic/orca/workspaces/leopoker/272',
      branch: 'refs/heads/issue-272', incarnationId: 'leopoker-inc-272',
      status: 'running', agentIdentity: 'supervised-manager',
    };
    const coordinator: FleetTerminal = {
      handle: 'leopoker-coordinator', title: 'Cursor coordinator', worktreePath: primaryRoot,
    };
    const fleet = [coordinator, unit];
    const screens: Record<string, string> = { [coordinator.handle]: 'idle', [unit.handle]: wait };
    const base = fakeOrca(screens, [], fleet);
    const executor: OrcaExecutor = (args) => {
      if (args[0] === 'orchestration' && args[1] === 'worker-list') {
        return commandResult(JSON.stringify({ ok: true, result: {
          workers: [{ agentTerminalHandle: unit.handle, taskId: 'leopoker-task-272',
            dispatchId: 'leopoker-dispatch-272', dispatchStatus: 'dispatched' }],
          page: { hasMore: false },
        } }));
      }
      if (args[0] === 'orchestration' && args[1] === 'worker-show') {
        return commandResult(JSON.stringify({ ok: true, result: {
          dispatch: { id: 'leopoker-dispatch-272', taskId: 'leopoker-task-272', status: 'dispatched' },
          terminal: unit, observation: { status: 'live', exactWorker: true },
        } }));
      }
      return base(args);
    };
    let currentHead = head;
    let stage = { state: 'success', description: 'Pack review completed with no findings.' };
    const reads: string[] = [];
    const readNamedPull: NonNullable<FleetAlarmTickOptions['readNamedPull']> = (selectedRepo, number) => {
      reads.push('pull:' + selectedRepo + ':#' + number);
      return selectedRepo === repository && number === 268
        ? { number: 268, headSha: currentHead, state: 'open', merged: false } : undefined;
    };
    const readPackReviewStage: NonNullable<FleetAlarmTickOptions['readPackReviewStage']> = (selectedRepo, sha) => {
      reads.push('stage:' + selectedRepo + ':' + sha);
      return selectedRepo === repository && sha === currentHead ? stage : undefined;
    };
    const readNamedReview = vi.fn(() => ({
      id: 991, commitSha: head, state: 'APPROVED', submittedAt: '2026-10-10T00:00:00Z',
    }));
    const projectConfig = (selectedRepo = repository) => config({
      projectId: 'leopoker', primary: primaryRoot,
      workspaceRe: /orca\/workspaces\/leopoker\//u,
      chatScope: { projectUrl: 'https://chatgpt.com/p/synthetic-leopoker', repository: selectedRepo },
    });
    const options = {
      screens, terminals: fleet, executor, config: projectConfig(),
      readNamedPull, readNamedReview, readPackReviewStage,
      listTerminalEnvelopes: () => [], listOpenPulls: () => [],
      listUnreadRunMessages: () => [], checkRunsFinishedAt: () => undefined,
      now: () => 0,
    };
    const matched = await tick({ ...options, store: new MemoryWakeStore() });
    expect(matched.calls).toContainEqual(['orchestration', 'worker-list', '--json']);
    expect(matched.calls).toContainEqual([
      'orchestration', 'worker-show', '--dispatch', 'leopoker-dispatch-272', '--json',
    ]);
    expect(reads).toEqual(['pull:' + repository + ':#268', 'stage:' + repository + ':' + head]);
    const wake = 'Wake: pack-review-PR-268 ended state stage-complete evidence '
      + 'https://github.com/chetwerikoff/LeoPoker/pull/268/commits/' + head
      + ' - re-check the producer yourself before continuing';
    expect(sendsTo(matched.calls, unit.handle)).toEqual([
      ['terminal', 'send', '--terminal', unit.handle, '--text', wake, '--enter'],
      ['terminal', 'send', '--terminal', unit.handle, '--enter'],
    ]);
    expect(wake).toMatch(/^[A-Za-z0-9 _./:%#=+-]+$/u);
    expect(wake).not.toMatch(/[;&|$'"()<>*?\\\x00-\x1f\x7f]/u);
    expect(sendsTo(matched.calls, coordinator.handle)).toHaveLength(0);
    expect(sends(matched.calls)).toHaveLength(2);
    expect(readNamedReview).not.toHaveBeenCalled();
    // A completed named stage is delivered once, not once per fleet tick.
    expect(sendsTo((await tick({ ...options, store: matched.store })).calls, unit.handle)).toHaveLength(0);

    // A direct submitted review can be semantically successful while the named
    // pack-owned runner is still active: neither that review nor a generic status ends the stage.
    stage = { state: 'success', description: 'pack review evidence is complete for current facts' };
    expect(sendsTo((await tick({ ...options, store: new MemoryWakeStore() })).calls, unit.handle)).toHaveLength(0);
    stage = { state: 'pending', description: 'Pack review is running for this exact head.' };
    expect(sendsTo((await tick({ ...options, store: new MemoryWakeStore() })).calls, unit.handle)).toHaveLength(0);
    expect(readNamedReview).not.toHaveBeenCalled();

    stage = { state: 'success', description: 'Pack review completed with no findings.' };
    const foreign = await tick({ ...options, config: projectConfig('chetwerikoff/OtherPoker'),
      store: new MemoryWakeStore() });
    expect(sendsTo(foreign.calls, unit.handle)).toHaveLength(0);
    screens[unit.handle] = 'PARKED on pack-review PR #269 head ' + head;
    expect(sendsTo((await tick({ ...options, store: new MemoryWakeStore() })).calls, unit.handle)).toHaveLength(0);
    screens[unit.handle] = wait;
    currentHead = 'b'.repeat(40);
    expect(sendsTo((await tick({ ...options, store: new MemoryWakeStore() })).calls, unit.handle)).toHaveLength(0);
  });

  it('wakes only one exact observed GPT invocation and coalesces legacy GPT wake', async () => {
    const h = parkedHarness('PARKED on GPT turn ' + invocation + ' (self-wake armed)');
    const event: TerminalEnvelopeEvent = {
      path: '/tmp/opencode/fixture-terminal.json', invocationId: invocation,
      observedInvocationId: invocation, terminalHandle: 'one',
      cwd: h.unit.worktreePath, delivery: 'landed',
    };
    const options = { listTerminalEnvelopes: () => [event] };
    const first = await h.step(options);
    expectSafeWake(first.calls, 'terminal-envelope');
    expect(unitText((await h.step(options)).calls)).toHaveLength(0);
    expect(sendsTo((await h.step(options)).calls, 'one')).toHaveLength(0);
    const foreign = parkedHarness('PARKED on GPT turn ' + invocation);
    const wrong = await foreign.step({
      listTerminalEnvelopes: () => [{ ...event, observedInvocationId: 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee' }],
    });
    // The strict Task/Dispatch wake is withheld for a mismatched UUID.
    // The pre-existing legacy GPT envelope route is a separate preserved effect.
    expect(unitText(wrong.calls)).toEqual([
      'Wake: GPT turn ' + invocation + ' ended, read ' + event.path,
    ]);
    expect(unitText(wrong.calls)[0]).not.toContain('GPT-turn-');
    expect(sendsTo(wrong.calls, 'coord')[0]?.join(' ')).toContain('park on unresolvable producer');
    const unsafe = parkedHarness('PARKED on GPT turn ' + invocation);
    const uncertain = await unsafe.step({
      listTerminalEnvelopes: () => [{ ...event, delivery: 'POSSIBLY_DELIVERED', conversationLocator: undefined }],
    });
    expect(unitText(uncertain.calls)).toHaveLength(0);
  });

  it('distinguishes aggregate pack-review stage from the named submitted review ID', async () => {
    const pack = parkedHarness('PARKED on pack-review PR #12 head ' + sha);
    const stage = await pack.step({
      readNamedPull: () => nativePull(),
      readPackReviewStage: () => ({ state: 'success', description: 'Pack review completed with no findings.' }),
    });
    expectSafeWake(stage.calls, 'stage-complete');
    const semanticDirectReview = parkedHarness('PARKED on pack-review PR #12 head ' + sha);
    const stillActive = await semanticDirectReview.step({
      readNamedPull: () => nativePull(),
      // A separate clean direct review may project semantic success while the
      // named aggregate runner has not reached a terminal stage.
      readPackReviewStage: () => ({ state: 'success', description: 'pack review evidence is complete for current facts' }),
    });
    expect(unitText(stillActive.calls)).toHaveLength(0);
    const blockingStage = parkedHarness('PARKED on pack-review PR #12 head ' + sha);
    expectSafeWake((await blockingStage.step({
      readNamedPull: () => nativePull(),
      readPackReviewStage: () => ({ state: 'failure', description: 'Pack review found blocking issues.' }),
    })).calls, 'stage-findings');
    const genericFailure = parkedHarness('PARKED on pack-review PR #12 head ' + sha);
    expect(unitText((await genericFailure.step({
      readNamedPull: () => nativePull(),
      readPackReviewStage: () => ({ state: 'failure', description: 'pack review evidence is missing' }),
    })).calls)).toHaveLength(0);
    const pending = parkedHarness('PARKED on pack-review PR #12 head ' + sha);
    expect(unitText((await pending.step({
      readNamedPull: () => nativePull(),
      readPackReviewStage: () => ({ state: 'pending', description: 'Pack review is running for this exact head.' }),
    })).calls)).toHaveLength(0);
    const review = parkedHarness('PARKED on PR #12 review #991 head ' + sha);
    const reviewed = await review.step({
      readNamedPull: () => nativePull(),
      readNamedReview: () => ({ id: 991, commitSha: sha, state: 'APPROVED', submittedAt: '2026-10-10T00:00:00Z' }),
    });
    expectSafeWake(reviewed.calls, 'review-submitted');
    const otherReviewer = parkedHarness('PARKED on PR #12 review #991 head ' + sha);
    expect(unitText((await otherReviewer.step({
      readNamedPull: () => nativePull(),
      readNamedReview: () => ({ id: 992, commitSha: sha, state: 'APPROVED', submittedAt: '2026-10-10T00:00:00Z' }),
    })).calls)).toHaveLength(0);
    const movedHead = parkedHarness('PARKED on PR #12 review #991 head ' + sha);
    expect(unitText((await movedHead.step({
      readNamedPull: () => nativePull(false, 'b'.repeat(40)),
      readNamedReview: () => ({ id: 991, commitSha: sha, state: 'APPROVED', submittedAt: '2026-10-10T00:00:00Z' }),
    })).calls)).toHaveLength(0);
  });

  it('joins CI to a single current open PR head and treats completed failures as terminal', async () => {
    const h = parkedHarness('PARKED on CI PR #12 head ' + sha);
    const input = {
      readNamedPull: () => nativePull(),
      listOpenPulls: () => [{ number: 12, sha, ref: 'issue-2463' }],
      checkRunsFinishedAt: () => 1234,
    };
    expectSafeWake((await h.step(input)).calls, 'checks-completed');
    expect(unitText((await h.step(input)).calls)).toHaveLength(0);
    const pending = parkedHarness('PARKED on CI PR #12 head ' + sha);
    expect(unitText((await pending.step({
      readNamedPull: () => nativePull(), checkRunsFinishedAt: () => undefined,
    })).calls)).toHaveLength(0);
    const ambiguous = parkedHarness('PARKED on CI on ' + sha);
    expect(unitText((await ambiguous.step({
      readNamedPull: () => nativePull(),
      listOpenPulls: () => [
        { number: 12, sha, ref: 'a' }, { number: 13, sha, ref: 'b' },
      ],
      checkRunsFinishedAt: () => 1234,
    })).calls)).toHaveLength(0);
  });

  it('requires native merged=true, not a closed PR or absent merge agent', async () => {
    const h = parkedHarness('PARKED on merge-12');
    expectSafeWake((await h.step({ readNamedPull: () => nativePull(true) })).calls, 'merged');
    const closed = parkedHarness('PARKED on PR #12 merged');
    expect(unitText((await closed.step({
      readNamedPull: () => ({ ...nativePull(), state: 'closed', merged: false }),
    })).calls)).toHaveLength(0);
    const conditional = parkedHarness('PARKED on merge-12 - resume when review settles');
    const alarm = await conditional.step({ readNamedPull: () => nativePull(true) });
    expect(unitText(alarm.calls)).toHaveLength(0);
    expect(sendsTo(alarm.calls, 'coord')[0]?.join(' ')).toContain('park on unresolvable producer');
  });

  it('proves exact native terminal exit only, never disappearance or a bare idle shell', async () => {
    const terminal: FleetTerminal = {
      handle: 'producer-12', incarnationId: 'producer-inc', title: 'zsh',
      worktreePath: '/elsewhere', status: 'exited',
    };
    const h = parkedHarness('PARKED on terminal producer-12 incarnation producer-inc', [terminal]);
    expectSafeWake((await h.step()).calls, 'terminal-exited');
    const gone = parkedHarness('PARKED on terminal producer-12 incarnation producer-inc');
    const unknown = await gone.step();
    expect(unitText(unknown.calls)).toHaveLength(0);
    expect(sendsTo(unknown.calls, 'coord')[0]?.join(' ')).toContain('park on unresolvable producer');
    const recycled = parkedHarness('PARKED on terminal producer-12 incarnation producer-inc',
      [{ ...terminal, incarnationId: 'new-incarnation' }]);
    expect(unitText((await recycled.step()).calls)).toHaveLength(0);
    const formerShell = parkedHarness('PARKED on terminal producer-12 incarnation producer-inc',
      [{ ...terminal, status: 'running' }]);
    expect(unitText((await formerShell.step()).calls)).toHaveLength(0);
    const merge = parkedHarness('PARKED on merge agent terminal producer-12 incarnation producer-inc PR #12', [terminal]);
    expectSafeWake((await merge.step({ readNamedPull: () => nativePull() })).calls, 'terminal-exited');
  });

  it('rejects fallback Task, changed Task, busy pane, and missing coordinator without new unit sends', async () => {
    const h = parkedHarness('PARKED on merge-12');
    h.exact(false);
    const fallback = await h.step({ readNamedPull: () => nativePull(true) });
    expect(unitText(fallback.calls)).toHaveLength(0);
    expect(sendsTo(fallback.calls, 'coord')[0]?.join(' ')).toContain('park on unresolvable producer');
    h.exact(true);
    h.task('next-task');
    h.screens.one = 'Working\nesc interrupt';
    expect(unitText((await h.step({ readNamedPull: () => nativePull(true) })).calls)).toHaveLength(0);
    h.screens.one = 'PARKED on merge-12';
    const noCoord = await h.step({
      config: config({ orchestratorHandle: 'missing',
        chatScope: { projectUrl: 'https://chatgpt.com/p/synthetic', repository } }),
      readNamedPull: () => nativePull(true),
    });
    expect(noCoord.result.state).toBe('no_orchestrator');
    expect(sends(noCoord.calls)).toHaveLength(0);
  });

  it('reminds at elapsed 30/60 minute slots only, preserving the first park epoch', async () => {
    const terminal: FleetTerminal = { handle: 'alive', title: 'zsh', worktreePath: '/elsewhere',
      incarnationId: 'alive-inc', status: 'running', agentIdentity: 'producer' };
    const h = parkedHarness('PARKED on terminal alive incarnation alive-inc', [terminal]);
    const one = await h.step();
    expect(unitText(one.calls)).toHaveLength(0);
    h.time(1_799_999);
    expect(unitText((await h.step()).calls)).toHaveLength(0);
    h.time(1_800_000);
    const thirty = await h.step();
    expect(unitText(thirty.calls)).toEqual([
      'Reminder: parked 30 min on terminal-alive - re-check its envelope or PR or CI state yourself - continue only if ended otherwise re-park with the same line',
    ]);
    expect(unitText((await h.step()).calls)).toHaveLength(0);
    h.time(3_599_999);
    expect(unitText((await h.step()).calls)).toHaveLength(0);
    h.time(3_600_000);
    expect(unitText((await h.step()).calls)).toHaveLength(1);
    expect(h.store.eventStatus.get([...h.store.eventStatus.keys()].find((key) => key.startsWith('reminder:'))!))
      .toBe('sent');
    h.screens.one = 'PARKED on terminal other incarnation future';
    h.time(3_600_001);
    expect(unitText((await h.step()).calls)).toHaveLength(0);
    h.screens.one = 'PARKED on terminal alive incarnation alive-inc';
    h.time(3_600_002);
    expect(unitText((await h.step()).calls)).toHaveLength(0);
  });

  it('keeps pre-effect attempted_unverified after second-Enter failure and never replays', async () => {
    const h = parkedHarness('PARKED on GPT turn ' + invocation);
    const event: TerminalEnvelopeEvent = { path: '/tmp/opencode/partial-terminal.json',
      invocationId: invocation, observedInvocationId: invocation, cwd: h.unit.worktreePath,
      terminalHandle: 'one', delivery: 'landed' };
    h.failSecond(true);
    const first = await h.step({ listTerminalEnvelopes: () => [event] });
    expect(unitText(first.calls)).toHaveLength(1);
    expect([...h.store.eventStatus.values()]).toContain('attempted_unverified');
    expect(sendsTo(first.calls, 'coord')[0]?.join(' ')).toContain('uncertain unit Wake');
    h.failSecond(false);
    const next = await h.step({ listTerminalEnvelopes: () => [event] });
    expect(sendsTo(next.calls, 'one')).toHaveLength(0);
    h.time(1_800_000);
    const reminder = await h.step({ listTerminalEnvelopes: () => [event] });
    expect(unitText(reminder.calls)[0]).toContain('Reminder: parked 30 min');
    const xdg = mkdtempSync(join(tmpdir(), 'fleet-2463-partial-'));
    try {
      const oneStore = new FileFleetWakeStateStore('fixture-2463', { XDG_RUNTIME_DIR: xdg });
      oneStore.markParkedWakeEvent('producer:one:fixture', 'attempted_unverified');
      const restarted = new FileFleetWakeStateStore('fixture-2463', { XDG_RUNTIME_DIR: xdg });
      expect(restarted.hasParkedWakeEvent('producer:one:fixture')).toBe(true);
      const mark = readdirSync(restarted.root).find((filename) => filename.startsWith('parked-wake-'));
      expect(readFileSync(join(restarted.root, mark!), 'utf8')).toContain('attempted_unverified');
    } finally { rmSync(xdg, { recursive: true, force: true }); }
  });


  it('persists GPT legacy suppression across STOPPED and replacement Task ticks and state-store restart', async () => {
    const h = parkedHarness('PARKED on GPT turn ' + invocation);
    const event: TerminalEnvelopeEvent = {
      path: '/tmp/opencode/fixture-cross-task-terminal.json',
      invocationId: invocation, observedInvocationId: invocation,
      terminalHandle: 'one', cwd: h.unit.worktreePath, delivery: 'landed',
    };
    const options = { listTerminalEnvelopes: () => [event] };
    const xdg = mkdtempSync(join(tmpdir(), 'fleet-2463-gpt-dedup-'));
    try {
      const firstStore = new FileFleetWakeStateStore('orchestrator-pack', { XDG_RUNTIME_DIR: xdg });
      expectSafeWake((await h.step({ ...options, store: firstStore })).calls, 'terminal-envelope');
      expect(firstStore.readParkedWakeEventStatus('gpt:' + event.path)).toBe('sent');
      const restarted = new FileFleetWakeStateStore('orchestrator-pack', { XDG_RUNTIME_DIR: xdg });
      expect(restarted.readParkedWakeEventStatus('gpt:' + event.path)).toBe('sent');
      h.task('replacement-task');
      h.screens.one = 'Ready for next Task';
      const replaced = await h.step({ ...options, store: restarted });
      expect(sendsTo(replaced.calls, 'one')).toHaveLength(0);
    } finally { rmSync(xdg, { recursive: true, force: true }); }
  });

  it('persists CI legacy suppression after the same handle is re-bound to another Task', async () => {
    const h = parkedHarness('PARKED on CI PR #12 head ' + sha);
    const input = {
      readNamedPull: () => nativePull(),
      listOpenPulls: () => [{ number: 12, sha, ref: 'issue-2463' }],
      checkRunsFinishedAt: () => 1234,
    };
    expectSafeWake((await h.step(input)).calls, 'checks-completed');
    expect(h.store.readParkedWakeEventStatus('ci:12:' + sha + ':1234')).toBe('sent');
    h.task('replacement-task');
    h.screens.one = 'Ready for new work';
    const later = await h.step(input);
    expect(sendsTo(later.calls, 'one')).toHaveLength(0);
  });

  it.each(['coordinator-send', 'coordinator-read'])(
    'retains uncertain Wake alert after failed second Enter and %s failure, including restart', async (failure) => {
      const h = parkedHarness('PARKED on GPT turn ' + invocation);
      const event: TerminalEnvelopeEvent = {
        path: '/tmp/opencode/fixture-uncertain-terminal.json',
        invocationId: invocation, observedInvocationId: invocation,
        terminalHandle: 'one', cwd: h.unit.worktreePath, delivery: 'landed',
      };
      const root = mkdtempSync(join(tmpdir(), 'fleet-2463-uncertain-'));
      try {
        const firstStore = new FileFleetWakeStateStore('orchestrator-pack', { XDG_RUNTIME_DIR: root });
        h.failSecond(true);
        if (failure === 'coordinator-send') h.failCoordSend(true);
        else h.failCoordRead(true);
        const first = await h.step({ listTerminalEnvelopes: () => [event], store: firstStore });
        expect(unitText(first.calls)).toHaveLength(1);
        expect(first.result.state).toBe(failure === 'coordinator-send' ? 'send_failed' : 'unreadable');
        expect(firstStore.readParkedWakeEventStatus('gpt:' + event.path)).toBe('attempted_unverified');
        h.failSecond(false);
        h.failCoordSend(false);
        h.failCoordRead(false);
        h.time(60_000);
        const restarted = new FileFleetWakeStateStore('orchestrator-pack', { XDG_RUNTIME_DIR: root });
        const recovered = await h.step({ listTerminalEnvelopes: () => [event], store: restarted });
        expect(recovered.result.state).toBe('sent');
        expect(sendsTo(recovered.calls, 'one')).toHaveLength(0);
        expect(sendsTo(recovered.calls, 'coord').find((call) => call.includes('--text'))?.join(' '))
          .toContain('uncertain unit Wake');
        expect((await h.step({ listTerminalEnvelopes: () => [event], store: restarted })).result.state)
          .toBe('same_stopped_set');
        h.time(1_800_000);
        const reminder = await h.step({ listTerminalEnvelopes: () => [event], store: restarted });
        expect(unitText(reminder.calls)[0]).toContain('Reminder: parked 30 min');
      } finally { rmSync(root, { recursive: true, force: true }); }
    },
  );

  it('alarms an identical unsupported park immediately after Task replacement', async () => {
    const h = parkedHarness('PARKED on unsupported external dependency');
    expect((await h.step()).result.state).toBe('sent');
    h.time(60_000);
    expect((await h.step()).result.state).toBe('same_stopped_set');
    h.task('replacement-task');
    const next = await h.step();
    expect(next.result.state).toBe('sent');
    expect(sendsTo(next.calls, 'coord')[0]?.join(' ')).toContain('park on unresolvable producer');
  });

  it('alarms changed STOPPED imperatives immediately but ignores a cosmetic TUI redraw', async () => {
    const store = new MemoryWakeStore();
    const screens = { coord: 'idle', one: 'Please approve staging deployment',
      two: 'working\nesc interrupt' };
    expect((await tick({ store, screens })).result.state).toBe('sent');
    screens.one = 'Please approve staging deployment\n╹▀▀▀▀▀▀▀▀▀▀';
    expect((await tick({ store, screens })).result.state).toBe('same_stopped_set');
    screens.one = 'Please approve production deployment';
    const changed = await tick({ store, screens });
    expect(changed.result.state).toBe('sent');
    expect(sendsTo(changed.calls, 'coord').find((call) => call.includes('--text'))?.join(' '))
      .toContain('Fleet alarm (idle)');
  });

  it.each(['idle', 'busy'])('limits unchanged %s coordinator alarms at 0/60/120/1800 seconds', async (mode) => {
    const h = parkedHarness('PARKED on unsupported external dependency');
    h.screens.coord = mode === 'idle' ? 'idle' : 'working\nctrl+c to stop';
    const first = await h.step();
    expect(first.result.state).toBe('sent');
    h.time(60_000);
    expect((await h.step()).result.state).toBe('same_stopped_set');
    h.time(120_000);
    expect((await h.step()).result.state).toBe('same_stopped_set');
    h.time(1_800_000);
    expect((await h.step()).result.state).toBe('sent');
    h.screens.one = 'Question about next action?';
    h.time(1_800_001);
    expect((await h.step()).result.state).toBe('sent');
  });
});

describe('Issue #2471 local-chatgpt coordinator-only and one-attempt routing', () => {
  const projectUrl = 'https://chatgpt.com/g/g-p/project/test';
  const localScope = { projectUrl, repository: 'test/project' };
  const uuid1 = '123e4567-e89b-12d3-a456-426614174042';
  const uuid2 = '223e4567-e89b-12d3-a456-426614174042';
  const local = `${projectUrl}/c/local-chatgpt:${uuid1}`;
  const saved = `${projectUrl}/c/6ac03300-098c-83ec-a6d5-f9d0cec30a5f`;
  const settings = config({ chatCdpUrl: 'http://127.0.0.1:9222', chatScope: localScope });
  const idle = { coord: 'idle', one: 'working\nesc interrupt', two: 'working\nesc interrupt' };
  const row = (
    url: string, kind: ChatErrorBanner['kind'] = 'error_banner',
    extra: Partial<ProjectChat> = {},
  ): ProjectChat => ({
    targetId: 'local-fixture', url, issue: 2471, pull: 2475, review: false,
    generating: false, banners: [{
      url, issue: 2471, pull: 2475, review: false, kind,
      text: kind === 'stalled' ? 'GPT stopped without a final reply'
        : kind === 'unloadable' ? 'Could not load this ChatGPT conversation' : 'Synthetic red failure',
      retry: kind === 'error_banner',
    }], ...extra,
  });
  const textTo = (calls: readonly string[][], target: string): string =>
    sendsTo(calls, target).find((call) => call.includes('--text'))?.at(-2) ?? '';

  it('rejects local ownership even with a convincing live launcher, branch, PR or Issue fallback', () => {
    const manager = { ...terminals[1]!, worktreePath: `${workerBase}/one-2471`,
      incarnationId: 'current-manager-generation', branch: 'refs/heads/current' };
    let bindingReads = 0;
    const binding = () => {
      bindingReads += 1;
      return { schema: 'chat-binding/v1' as const, conversation_url: local,
        worktree: manager.worktreePath, updated_at: '2026-10-10T00:00:00Z',
        terminal_handle: manager.handle };
    };
    expect(bannerOwnerPane({ url: local, issue: 2471, pull: 2475 }, [manager], settings, binding)).toBeUndefined();
    expect(bannerOwnerPane({ url: local.replace('local-chatgpt:', 'local-chatgpt%3A'), issue: 2471 },
      [manager], settings, binding)).toBeUndefined();
    expect(bindingReads).toBe(0);
    expect(bannerOwnerPane({ url: saved, issue: 2471 }, [manager], settings, () => undefined)?.handle).toBe('one');
  });

  it('emits a role-neutral coordinator warning once for duplicate CDP rows, not to the tempting unit', async () => {
    const store = new MemoryWakeStore();
    const workers = [terminals[0]!, {
      ...terminals[1]!, worktreePath: `${workerBase}/one-2471`, branch: 'refs/heads/target',
      incarnationId: 'inc-mgr', status: 'running',
    }, terminals[2]!];
    const localUpper = local.replace(uuid1, uuid1.toUpperCase()) + '?ctx=1#fragment';
    const candidates = [row(localUpper, 'error_banner', { targetId: 'first', review: true }),
      row(local, 'error_banner', { targetId: 'second' })];
    const first = await tick({ config: settings, store, terminals: workers, screens: idle,
      readChats: async () => candidates, now: () => 0 });
    expect(first.result.state).toBe('sent');
    expect(sendsTo(first.calls, 'one')).toHaveLength(0);
    expect(sendsTo(first.calls, 'two')).toHaveLength(0);
    expect(sendsTo(first.calls, 'coord')).toHaveLength(2);
    const message = textTo(first.calls, 'coord');
    expect(message).toContain(local);
    expect(message).toContain('Owner, workflow role and latest-turn invocation are unproven');
    expect(message).toContain('Never press Retry');
    expect(message).not.toContain('Synthetic red failure');
    expect(message).not.toContain('Доделай и сообщи статус');
    expect(message).not.toContain('Заверши ревью:');
    expect(message).not.toContain('one-2471');
    expect(store.parkedWakeEvents.size).toBe(1);
    const key = [...store.parkedWakeEvents][0]!;
    expect(key).toContain(local);
    expect(store.readParkedWakeEventStatus(key)).toBe('sent');
    expect(store.readLastSentSignature()).not.toContain(local);
    const duplicate = await tick({ config: settings, store, terminals: workers, screens: idle,
      readChats: async () => [row(local, 'error_banner', { targetId: 'recycled-target' })], now: () => 60_000 });
    expect(sendsTo(duplicate.calls, 'coord')).toHaveLength(0);
    expect(store.parkedWakeEvents.size).toBe(1);
    const next = await tick({ config: settings, store, terminals: workers, screens: idle,
      readChats: async () => [row(local.replace(uuid1, uuid2), 'unloadable', { targetId: 'first' })], now: () => 60_100 });
    expect(textTo(next.calls, 'coord')).toContain('local-chatgpt:' + uuid2);
    expect(store.parkedWakeEvents.size).toBe(2);
  });

  it('preserves two-tick stalled admission, generating suppression and malformed/foreign read-only behavior', async () => {
    const store = new MemoryWakeStore();
    const sources = [
      row(local, 'error_banner', { generating: true }),
      row(local.replace(uuid1, 'bad-id')),
      row(local.replace('/project/test/', '/project/foreign/')),
      row('https://elsewhere.invalid/c/local-chatgpt:' + uuid1),
      row(local.replace('local-chatgpt:', 'local-chatgpt%3A')),
    ];
    const invalid = await tick({ config: settings, store, screens: idle,
      readChats: async () => sources });
    expect(invalid.result.state).toBe('nothing_stopped');
    expect(sends(invalid.calls)).toHaveLength(0);
    expect(store.parkedWakeEvents.size).toBe(0);
    const first = await tick({ config: settings, store, screens: idle, readChats: async () => [row(local, 'stalled')] });
    expect(first.result.state).toBe('nothing_stopped');
    const second = await tick({ config: settings, store, screens: idle,
      readChats: async () => [row(local.replace(uuid1, uuid1.toUpperCase()), 'stalled')] });
    expect(textTo(second.calls, 'coord')).toContain('local-chatgpt:' + uuid1);
    expect(sendsTo(second.calls, 'one')).toHaveLength(0);
    expect(sendsTo((await tick({ config: settings, store, screens: idle,
      readChats: async () => [row(local, 'stalled')] })).calls, 'coord')).toHaveLength(0);
    const withoutCoordinator = new MemoryWakeStore();
    const absent = await tick({ config: settings, store: withoutCoordinator,
      screens: { one: 'working\nesc interrupt', two: 'working\nesc interrupt' },
      terminals: terminals.slice(1), readChats: async () => [row(local)] });
    expect(absent.result.state).toBe('no_orchestrator');
    expect(withoutCoordinator.parkedWakeEvents.size).toBe(0);
  });

  it('isolates local attempts from changed STOPPED state, ordinary 30-minute cadence and fresh local IDs', async () => {
    const store = new MemoryWakeStore();
    const screens = { coord: 'idle', one: 'A decision is needed', two: 'working\nesc interrupt' };
    const step = (at: number, rows: ProjectChat[], paneScreens = screens) =>
      tick({ config: settings, store, screens: paneScreens, now: () => at, readChats: async () => rows });
    const first = await step(0, [row(local)]);
    expect(first.result.state).toBe('sent');
    expect(textTo(first.calls, 'coord')).toContain(local);
    const same = await step(60_000, [row(local, 'error_banner', {
      banners: [{ ...row(local).banners[0]!, text: 'Retry changed' }],
    })]);
    expect(same.result.state).toBe('same_stopped_set');
    expect(sendsTo(same.calls, 'coord')).toHaveLength(0);
    const changed = await step(60_001, [row(local)], {
      coord: 'idle', one: 'A decision is needed', two: 'Another decision needed',
    });
    expect(changed.result.state).toBe('sent');
    expect(textTo(changed.calls, 'coord')).toContain('STOPPED two');
    expect(textTo(changed.calls, 'coord')).not.toContain(local);
    expect(changed.result.state === 'sent' ? changed.result.signature : '').not.toContain(local);
    const cadence = await step(1_860_002, [row(local)], {
      coord: 'idle', one: 'A decision is needed', two: 'Another decision needed',
    });
    expect(cadence.result.state).toBe('sent');
    expect(textTo(cadence.calls, 'coord')).not.toContain(local);
    const newChat = await step(1_860_010, [row(local.replace(uuid1, uuid2))], {
      coord: 'idle', one: 'A decision is needed', two: 'Another decision needed',
    });
    expect(textTo(newChat.calls, 'coord')).toContain('local-chatgpt:' + uuid2);
    const repeat = await step(3_660_015, [row(local), row(local.replace(uuid1, uuid2))], {
      coord: 'idle', one: 'A decision is needed', two: 'Another decision needed',
    });
    expect(textTo(repeat.calls, 'coord')).not.toContain('local-chatgpt:');
    expect(store.parkedWakeEvents.size).toBe(2);
  });

  it('never uses an unrelated terminal envelope, stale target or unbound DOM role as local identity', async () => {
    const store = new MemoryWakeStore();
    const envelope: TerminalEnvelopeEvent = {
      path: '/tmp/opencode/child-start-failed-terminal.json', invocationId: 'inv-child-start-failed',
      terminalHandle: 'missing', cwd: '/foreign/worktree', delivery: 'not-sent',
      // A child_start_failed envelope need not carry observedInvocationId.
    };
    const first = await tick({ config: settings, store, screens: idle,
      readChats: async () => [row(local, 'unloadable', { review: true, targetId: 'recycled' })],
      listTerminalEnvelopes: () => [envelope] });
    expect(textTo(first.calls, 'coord')).toContain(local);
    expect(textTo(first.calls, 'coord')).toContain('unproven');
    expect(sendsTo(first.calls, 'one')).toHaveLength(0);
    const after = await tick({ config: settings, store, screens: idle,
      readChats: async () => [row(local, 'error_banner', { review: false, targetId: 'new-target' })],
      listTerminalEnvelopes: () => [{ ...envelope, observedInvocationId: 'inv-child-start-failed' }] });
    expect(sendsTo(after.calls, 'coord')).toHaveLength(0);
    expect(store.parkedWakeEvents.size).toBe(1);
  });

  it.each(['before-first', 'between-enters', 'failed-second', 'thrown-first'])(
    'does not replay uncertain effects when coordinator changes or send fails: %s', async (caseName) => {
      const store = new MemoryWakeStore();
      const initial = [{ ...terminals[0]!, incarnationId: 'coordinator-1', status: 'running' },
        terminals[1]!, terminals[2]!];
      const replacement = [{ ...initial[0]!, incarnationId: 'coordinator-2' }, ...initial.slice(1)];
      let censusCount = 0;
      const executor: OrcaExecutor = (args) => {
        if (args[0] === 'terminal' && args[1] === 'list') censusCount++;
        if (args[0] === 'terminal' && args[1] === 'send') {
          if (caseName === 'thrown-first' && args.includes('--text')) throw Error('unknown delivery');
          if (caseName === 'failed-second' && !args.includes('--text')) return commandResult('', false);
        }
        const changed = caseName === 'before-first' && censusCount >= 2
          || caseName === 'between-enters' && censusCount >= 3;
        return fakeOrca(idle, [], changed ? replacement : initial)(args);
      };
      const first = await tick({ config: settings, store, executor, screens: idle,
        readChats: async () => [row(local)] });
      expect(first.result.state).toBe('send_failed');
      const firstSend = sendsTo(first.calls, 'coord');
      expect(firstSend).toHaveLength(caseName === 'before-first' ? 0 : 1);
      expect(firstSend.every((args) => args.includes('--text'))).toBe(true);
      const statuses = [...store.parkedWakeEvents].map((key) => store.readParkedWakeEventStatus(key));
      expect(statuses).toEqual(caseName === 'before-first' ? [] : ['attempted_unverified']);
      const recovery = await tick({ config: settings, store, screens: idle, readChats: async () => [row(local)] });
      expect(sendsTo(recovery.calls, 'coord')).toHaveLength(caseName === 'before-first' ? 2 : 0);
      if (caseName !== 'before-first') expect([...store.parkedWakeEvents].map((key) =>
        store.readParkedWakeEventStatus(key))).toEqual(['attempted_unverified']);
    },
  );

  it('persists local attempts across a file-store restart while preserving saved-URL ownership and closure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-local-2471-'));
    try {
      const store = new FileFleetWakeStateStore('orchestrator-pack', { XDG_RUNTIME_DIR: root });
      const first = await tick({ config: settings, store, screens: idle,
        readChats: async () => [row(local)] });
      expect(textTo(first.calls, 'coord')).toContain(local);
      const reloaded = new FileFleetWakeStateStore('orchestrator-pack', { XDG_RUNTIME_DIR: root });
      const repeat = await tick({ config: settings, store: reloaded, screens: idle,
        readChats: async () => [row(local)] });
      expect(sendsTo(repeat.calls, 'coord')).toHaveLength(0);
      const owner = { ...terminals[1]!, worktreePath: `${workerBase}/one-2471` };
      const prior = row(saved.replace('6ac03300', '5ac03300'), 'error_banner',
        { banners: [], targetId: 'older-saved' });
      const newest = row(saved, 'error_banner', { banners: [], targetId: 'newer-saved' });
      const closed: string[] = [];
      const liveSaved = await tick({ config: settings, store: reloaded,
        terminals: [terminals[0]!, owner, terminals[2]!], screens: idle,
        readChats: async () => [prior, newest, row(local)],
        closeChat: async (_cdp, target) => { closed.push(target); return true; } });
      expect(closed).toEqual(['older-saved']);
      expect(sendsTo(liveSaved.calls, 'one')).toHaveLength(0);
      expect(sendsTo(liveSaved.calls, 'coord')).toHaveLength(0);
      const canonical = await tick({ config: settings, store: reloaded,
        terminals: [terminals[0]!, owner, terminals[2]!], screens: idle,
        readChats: async () => [row(saved)] });
      expect(sendsTo(canonical.calls, 'one')).toHaveLength(2);
      expect(textTo(canonical.calls, 'one')).toContain('Only for confirmed execution');
      expect(textTo(canonical.calls, 'one')).toContain('Only for confirmed PR review');
      expect(textTo(canonical.calls, 'one')).not.toContain('This is a review chat');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps saved-role guidance conditional even when DOM heading suggests an executable role', () => {
    const base = row(saved).banners[0]!;
    const message = managerBannerMessage(base);
    expect(managerBannerMessage({ ...base, review: true })).toBe(message);
    expect(message).toContain('Only for confirmed execution');
    expect(message).toContain('Only for confirmed PR review');
    expect(message).toContain('Доделай и сообщи статус');
    expect(message).toContain('Заверши ревью:');
    const unloadable = managerBannerMessage({ ...base, kind: 'unloadable', review: false });
    expect(unloadable).toContain('continue the task in a new chat');
    expect(unloadable).toContain('Restart the review in a new chat');
    expect(unloadable).not.toContain('same chat');
    const generic = fleetAlarmMessage('idle', [], [{ ...base, review: true }]);
    expect(generic).toContain('independent role and delivery reconciliation');
    expect(generic).toContain('Only after confirming execution');
    expect(generic).toContain('only after confirming PR review');
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

describe('Issue #2441 read-only diagnostic tick non-interference', () => {
  const worker: FleetTerminal = {
    handle: 'one', title: 'OpenCode manager one', worktreePath: workerBase + '/one',
    incarnationId: 'inc-1', branch: 'refs/heads/diagnostic', agentIdentity: 'opencode',
  };
  const coordinator: FleetTerminal = {
    handle: 'coord', title: 'Cursor coordinator', worktreePath: primary, incarnationId: 'coordinator-inc',
  };
  const withStore = async (body: (store: FileFleetWakeStateStore) => Promise<void>): Promise<void> => {
    const xdg = mkdtempSync(join(tmpdir(), 'fleet-wake-2441-'));
    try { await body(new FileFleetWakeStateStore('orchestrator-pack', { XDG_RUNTIME_DIR: xdg })); }
    finally { rmSync(xdg, { recursive: true, force: true }); }
  };
  const diagnostic = async (input: {
    store: FileFleetWakeStateStore;
    terminals?: readonly FleetTerminal[];
    screens: Record<string, string>;
    now: number;
    retry?: boolean;
  }) => {
    const calls: string[][] = [], logs: string[] = [];
    const rows = input.terminals ?? [coordinator, worker];
    const url = 'https://chatgpt.com/c/synthetic';
    await runFleetDiagnosticTick({
      config: config({
        chatCdpUrl: 'http://127.0.0.1:9222',
        chatScope: { projectUrl: 'https://chatgpt.com/g/g-p/project/project',
          repository: 'chetwerikoff/orchestrator-pack' },
      }),
      executor: fakeOrca(input.screens, calls, rows), store: input.store, terminals: rows,
      now: () => input.now, log: (line) => logs.push(line),
      readChats: async () => [{
        targetId: 'synthetic', url, generating: false,
        banners: [{ kind: 'error_banner', url, text: 'Failed to fetch / Retry shown',
          retry: input.retry === true }],
      }],
      // Adversarial incident data cannot enter this API's send path.
      ...{ listUnreadRunMessages: () => [{ id: 'run-1', toHandle: 'run:coord',
        fromHandle: 'run:one', subject: '; $(touch /tmp/never-run) && echo pwned' }] },
    });
    return { calls, logs };
  };

  it('logs unverified → exited despite the same old delivery signature and never replays a partial send', async () => withStore(async (store) => {
    store.writeLastSentSignature('coord\nsame-screen-stopped');
    store.writeBannerSignature('failed-direct-banner-signature');
    store.markParkedWakeEvent('gpt:prior-event');
    const first = await diagnostic({ store, screens: { one: 'work\nesc interrupt' }, now: 0 });
    const second = await diagnostic({ store, screens: { one: 'work\nesc interrupt' },
      terminals: [coordinator, { ...worker, status: 'exited' }], now: 300_000 });
    expect(first.logs.some((line) => line.includes('reason=agent_unverified'))).toBe(true);
    expect(second.logs.some((line) => line.includes('reason=terminal_exited'))).toBe(true);
    expect([...first.calls, ...second.calls].filter((call) => call[1] === 'send')).toHaveLength(0);
    expect(store.readLastSentSignature()).toBe('coord\nsame-screen-stopped');
    expect(store.readBannerSignature()).toBe('failed-direct-banner-signature');
    expect(store.hasParkedWakeEvent('gpt:prior-event')).toBe(true);
    expect(second.logs.some((line) => /delivered|undelivered|resend suggestion/iu.test(line))).toBe(false);
  }));

  it('records unchanged busy → suspected_hung at t=900 without updating a signature or sending shell metacharacters', async () => withStore(async (store) => {
    store.writeLastSentSignature('unchanged-legacy-signature');
    for (const now of [0, 300_000, 600_000, 900_000]) {
      const observed = await diagnostic({ store, screens: { one: 'work\nesc interrupt' }, now });
      const expected = now === 900_000 ? 'suspected_hung' : 'agent_unverified';
      expect(observed.logs.some((line) => line.includes('reason=' + expected))).toBe(true);
      expect(observed.calls.some((call) => call[1] === 'send')).toBe(false);
      expect(store.readLastSentSignature()).toBe('unchanged-legacy-signature');
    }
  }));

  it('reports ambiguous primary titles without routing and pinned selection without child-liveness assertion', async () => withStore(async (store) => {
    const multiple = [coordinator, { ...coordinator, handle: 'coord-2' }, worker];
    const result = await diagnostic({ store, terminals: multiple, screens: { one: 'done' }, now: 0 });
    expect(result.logs.some((line) => line.includes('reason=coordinator_ambiguous'))).toBe(true);
    const pinnedLogs: string[] = [], pinnedCalls: string[][] = [];
    await runFleetDiagnosticTick({ config: config({ orchestratorHandle: 'coord-2' }),
      store, terminals: multiple, executor: fakeOrca({ one: 'done' }, pinnedCalls, multiple),
      log: (line) => pinnedLogs.push(line) });
    expect(pinnedLogs.some((line) => line.includes('reason=coordinator_unverified selected=coord-2')
      && line.includes('exact_selection_only'))).toBe(true);
    expect(pinnedLogs.some((line) => line.includes('coordinator_ambiguous'))).toBe(false);
    expect([...result.calls, ...pinnedCalls].filter((call) => call[1] === 'send')).toHaveLength(0);
  }));

  it('uses structural Retry=false/true and tentative unbound banner evidence on two zero-send ticks', async () => withStore(async (store) => {
    store.writeBannerSignature('already-observed-even-though-direct-send-failed');
    const first = await diagnostic({ store, screens: { one: 'work\nesc interrupt' }, now: 0, retry: false });
    const second = await diagnostic({ store, screens: { one: 'work\nesc interrupt' }, now: 300_000, retry: true });
    expect(first.logs).toContainEqual(expect.stringContaining('retry_control_observed=false'));
    expect(second.logs).toContainEqual(expect.stringContaining('retry_control_observed=true'));
    expect(first.logs).toContainEqual(expect.stringContaining('attribution=tentative/unbound'));
    expect(first.logs.join('\n')).not.toContain('Failed to fetch / Retry shown');
    expect([...first.calls, ...second.calls].filter((call) => call[1] === 'send')).toHaveLength(0);
    expect(store.readBannerSignature()).toBe('already-observed-even-though-direct-send-failed');
  }));

  it('reports global census failure once, and local unreadability without hiding a readable peer', async () => withStore(async (store) => {
    const malformed: OrcaExecutor = (args) => args[1] === 'list'
      ? commandResult(JSON.stringify({ ok: true, result: { terminals: [worker], truncated: true, totalCount: 2 } }))
      : commandResult('', false);
    const logs: string[] = [];
    await runFleetDiagnosticTick({ config: config(), executor: malformed, store, log: (line) => logs.push(line) });
    expect(logs.filter((line) => line.includes('fleet_census_unreadable'))).toHaveLength(1);
    expect(logs).toHaveLength(1);
    const peer = { ...worker, handle: 'two', incarnationId: 'peer' };
    const result = await diagnostic({ store, terminals: [coordinator, worker, peer],
      screens: { two: 'work\nesc interrupt' }, now: 0 });
    expect(result.logs.some((line) => line.includes('handle=one') && line.includes('screen_unreadable'))).toBe(true);
    expect(result.logs.some((line) => line.includes('handle=two') && line.includes('agent_unverified'))).toBe(true);
    expect(result.calls.filter((call) => call[1] === 'send')).toHaveLength(0);
    const wake = await tick({ store, terminals: [coordinator, worker, peer],
      screens: { coord: 'idle', two: 'work\nesc interrupt' } });
    expect(wake.result).toEqual({ state: 'unreadable', handle: 'one' });
    // A prior injected t=0 may independently age into suspected_hung against the real clock.
    expect(wake.logs.some((line) => line.startsWith('DIAG handle=two') && line.includes('state=busy'))).toBe(true);
    expect(sends(wake.calls)).toHaveLength(0);
  }));

  it('keeps the legacy wake path independent when advisory history cannot be written', async () => withStore(async (store) => {
    vi.spyOn(store, 'writeDiagnosticHistory').mockImplementation(() => { throw new Error('synthetic history write refusal'); });
    const output = await tick({ store, terminals: [coordinator, worker], screens: {
      coord: 'idle', one: 'done',
    } });
    expect(output.logs.some((line) => line.includes('reason=diagnostic_unreadable'))).toBe(true);
    expect(output.result.state).toBe('sent');
    expect(sendsTo(output.calls, 'coord')).toHaveLength(2);
    // The diagnostic failure itself never routes or calls terminal send; old dispatch still owns it.
  }));



  it('sends existing GPT event before browser read and reuses the same post-event CDP snapshot for advisory', async () => {
    const order: string[] = [];
    const custom = [coordinator, worker];
    const calls: string[][] = [];
    const execute = fakeOrca({ coord: 'idle', one: 'done' }, calls, custom);
    let reads = 0;
    const url = 'https://chatgpt.com/c/synthetic-banner';
    const readChats: NonNullable<FleetAlarmTickOptions['readChats']> = async () => {
      reads += 1;
      order.push('cdp');
      return [{ targetId: 'synthetic', url, generating: false,
        banners: [{ kind: 'error_banner', url, text: 'Failed to fetch / Retry shown', retry: false }] }];
    };
    const run = await tick({
      config: config({ chatCdpUrl: 'http://127.0.0.1:9222', chatScope: {
        projectUrl: 'https://chatgpt.com/g/g-p/project/project',
        repository: 'chetwerikoff/orchestrator-pack',
      } }),
      terminals: custom, screens: { coord: 'idle', one: 'done' },
      executor: (args) => {
        if (args[1] === 'send') order.push('legacy-send');
        return execute(args);
      },
      readChats,
      listTerminalEnvelopes: () => [{ path: '/tmp/opencode/synthetic-end.json',
        terminalHandle: 'one', invocationId: 'synthetic-ended' }],
    });
    expect(reads).toBe(1);
    expect(order.indexOf('legacy-send')).toBeLessThan(order.indexOf('cdp'));
    expect(run.logs.some((line) => line.includes('retry_control_observed=false'))).toBe(true);
    expect(run.logs.some((line) => line.includes('attribution=tentative/unbound'))).toBe(true);
    expect(calls.filter((args) => args[1] === 'send').length).toBeGreaterThan(0);
    expect(run.calls.filter((args) => args[1] === 'send')).toHaveLength(
      calls.filter((args) => args[1] === 'send').length);
  });

  it('retains operational PARKED state on a short acknowledgment without advisory rewriting wait data', async () =>
    withStore(async (store) => {
      const fleet = [coordinator, worker];
      const first = await tick({ store, terminals: fleet, screens: {
        coord: 'idle', one: 'PARKED on PR #1 merged',
      } });
      const held = store.readPaneWait('one');
      expect(held?.wait).toBe('PARKED on PR #1 merged');
      expect(first.logs.some((line) => line.includes('handle=one') && line.includes('state=PARKED'))).toBe(true);
      const second = await tick({ store, terminals: fleet, screens: {
        coord: 'idle', one: 'Acknowledged',
      } });
      expect(second.logs.some((line) => line.includes('handle=one') && line.includes('state=PARKED'))).toBe(true);
      expect(store.readPaneWait('one')).toEqual(held);
    }));

  it('adds advisory output to normal wake ticks without making busy agents actionable', async () => {
    const observed = await tick({ terminals: [coordinator, worker], screens: {
      coord: 'work\nctrl+c to stop', one: 'work\nesc interrupt',
    } });
    expect(observed.result.state).toBe('nothing_stopped');
    expect(observed.logs.some((line) => line.includes('reason=agent_unverified'))).toBe(true);
    expect(observed.logs.some((line) => line.includes('reason=coordinator_unverified'))).toBe(true);
    expect(sends(observed.calls)).toHaveLength(0);
  });
});
