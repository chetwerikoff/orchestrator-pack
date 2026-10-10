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

class MemoryWakeStore implements FleetWakeStateStore {
  readonly root = '/xdg/fleet-sweep/project';
  readonly marks = new Set<string>();
  readonly parkedWakeEvents = new Set<string>();
  readonly eventStatus = new Map<string, 'sent' | 'attempted_unverified'>();
  readonly epochs = new Map<string, { key: string; since: number }>();
  signature: string | null = null;
  stalledSeen: string | null = null;
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
  readStalledSeen(): string | null { return this.stalledSeen; }
  writeStalledSeen(urls: string): void { this.stalledSeen = urls; }
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
  sleepMs?: (ms: number) => void | Promise<void>;
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
    sleepMs: async (ms) => { sleeps.push(ms); await input.sleepMs?.(ms); },
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
      expect(settings.selectedRepository).toBe('test/project');
      expect(settings.chatScope?.repository).toBe('test/project');
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


  it('r05: final park line is accepted without a Task or receipt and stays coordinator-quiet', async () => {
    const store = new MemoryWakeStore();
    const parked = { coord: 'idle', one: 'work\nPARKED on unknown-event' };
    const first = await tick({ terminals: [terminals[0]!, terminals[1]!], screens: parked, store });
    expect(first.result.state).toBe('nothing_stopped');
    expect(sends(first.calls)).toHaveLength(0);
    expect(first.calls.filter((args) => args[0] === 'orchestration'
      && ['worker-list', 'worker-show'].includes(args[1] ?? ''))).toHaveLength(0);
    const repeated = await tick({ terminals: [terminals[0]!, terminals[1]!], screens: parked, store });
    expect(sends(repeated.calls)).toHaveLength(0);
  });

  it('alarms a new own question even with the same stopped handle and a busy coordinator', async () => {
    const store = new MemoryWakeStore();
    const screens = { coord: 'working\nctrl+c to stop', one: 'finished', two: 'working\nesc interrupt' };
    expect((await tick({ screens, store })).result.state).toBe('sent');
    expect((await tick({ screens, store })).result.state).toBe('same_stopped_set');
    screens.one = 'May I deploy to staging?';
    expect((await tick({ screens, store })).result.state).toBe('same_stopped_set');
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
    expect(same.logs.some((line) => line.includes('unchanged pane states already notified'))).toBe(true);

    const changed = await tick({
      screens: { coord: 'working\nctrl+c to stop', one: 'done', two: 'also done' },
      store,
    });
    expect(changed.result).toMatchObject({ state: 'sent', coordinatorState: 'busy', count: 1 });
    const message = sends(changed.calls)[0]![sends(changed.calls)[0]!.indexOf('--text') + 1]!;
    expect(message).not.toContain('STOPPED one');
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
    expect(replacement.result).toMatchObject({ state: 'same_stopped_set', coordinator: 'coord-b' });
    expect(sends(replacement.calls)).toHaveLength(0);
  });

  it('r05: PARKED does not alarm on an unknown producer or unrelated STOPPED set changes', async () => {
    const store = new MemoryWakeStore();
    const screens = { coord: 'idle', one: 'working\nesc interrupt', two: 'PARKED on missing-event' };
    const first = await tick({ screens, store });
    expect(first.result.state).toBe('nothing_stopped');
    expect(sends(first.calls)).toHaveLength(0);
    const changed = await tick({ screens: { ...screens, one: 'done' }, store });
    expect(changed.result.state).toBe('sent');
    expect(sendsTo(changed.calls, 'coord')[0]?.join(' ')).toContain('STOPPED one');
    expect(sendsTo(changed.calls, 'coord')[0]?.join(' ')).not.toContain('unresolvable');
    expect(sendsTo(changed.calls, 'two')).toHaveLength(0);
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

  it('retains independent legacy GPT wake to an idle STOPPED launching pane', async () => {
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
      screens: { coord: 'idle', one: 'done and ready for new Task', two: 'working\nesc interrupt' },
      store,
      listTerminalEnvelopes,
    });
    expect(sendsTo(idle.calls, 'one')).toEqual([[
      'terminal', 'send', '--terminal', 'one',
      '--text', `Wake: GPT turn ${envelope.invocationId} ended, read ${envelope.path}`,
      '--enter',
    ], ['terminal', 'send', '--terminal', 'one', '--enter']]);

    const repeated = await tick({
      screens: { coord: 'idle', one: 'done and ready for new Task', two: 'working\nesc interrupt' },
      store,
      listTerminalEnvelopes,
    });
    expect(sendsTo(repeated.calls, 'one')).toHaveLength(0);
  });

  it('r05: former post-send/generation proof is not a Wake skip gate', async () => {
    const store = new MemoryWakeStore();
    const token = '24852485-1111-4111-8111-248524852485';
    const event: TerminalEnvelopeEvent = { path: '/tmp/opencode/r05-' + token + '-terminal.json',
      invocationId: token, observedInvocationId: token };
    const parked = await tick({ store, terminals: [terminals[0]!, terminals[1]!],
      screens: { coord: 'idle', one: 'PARKED on ' + token },
      listTerminalEnvelopes: () => [event],
    });
    expect(sendsTo(parked.calls, 'one').filter((call) => call.includes('--text'))).toHaveLength(1);
    expect(parked.logs.join(' ')).not.toContain('owner_generation_unproven');
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

  it('r05: no foreign legacy event may veto the matching named PARKED event', async () => {
    const id = 'inv-owned';
    const matching = { path: '/tmp/opencode/r05-owned-terminal.json', invocationId: id };
    const foreign = { path: '/tmp/opencode/r05-foreign-terminal.json', invocationId: 'inv-unrelated',
      terminalHandle: 'one' };
    const observed = await tick({ terminals: [terminals[0]!, terminals[1]!],
      screens: { coord: 'idle', one: 'PARKED on GPT turn ' + id },
      listTerminalEnvelopes: () => [foreign, matching] });
    expect(sendsTo(observed.calls, 'one').filter((call) => call.includes('--text'))).toHaveLength(1);
    expect(sendsTo(observed.calls, 'one')[0]?.join(' ')).toContain(matching.path);
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
    const screens = { coord: 'idle', one: 'done', mgr: 'done for now' };
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
    const baseExecutor = fakeOrca({ coord: 'idle', mgr: 'done', foreign: 'working\\nesc interrupt' }, [], [terminals[0]!, manager, foreign]);
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
      screens: { coord: 'idle', mgr: 'done', foreign: 'working\\nesc interrupt' },
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
      screens: { coord: 'idle', mgr: 'done' },
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
      screens: { coord: 'idle', one: 'done' },
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
      screens: { coord: 'idle', one: 'done' },
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


describe('Issue #2463 parked-producer compatibility with r05', () => {
  const head = 'a'.repeat(40);
  const setting = config({ selectedRepository: 'test/project' });
  const textTo = (calls: readonly string[][]) => sendsTo(calls, 'one')
    .filter((row) => row.includes('--text')).map((row) => row[row.indexOf('--text') + 1]!);
  it('observes a finished pack-review run without Task/owner proof and deduplicates the same event', async () => {
    const store = new MemoryWakeStore();
    const step = () => tick({ store, config: setting, terminals: [terminals[0]!, terminals[1]!],
      screens: { coord: 'idle', one: 'PARKED on pack-review PR #268 head ' + head },
      readPackReviewStage: () => ({ state: 'success', description: 'completed' }),
    });
    expect(textTo((await step()).calls)[0]).toContain('stage-success');
    expect(textTo((await step()).calls)).toHaveLength(0);
  });
  it('wakes on completed CI with no owner proof and independently recognizes terminal exit', async () => {
    const ci = await tick({ config: setting, terminals: [terminals[0]!, terminals[1]!],
      screens: { coord: 'idle', one: 'PARKED on CI on ' + head }, checkRunsFinishedAt: () => 17 });
    expect(textTo(ci.calls)[0]).toContain('checks-completed');
    const producer: FleetTerminal = { handle: 'producer', title: 'OpenCode producer',
      worktreePath: '/other/path', incarnationId: 'inc-x', status: 'exited' };
    const exited = await tick({ config: setting, terminals: [terminals[0]!, terminals[1]!, producer],
      screens: { coord: 'idle', one: 'PARKED on terminal producer incarnation inc-x' } });
    expect(textTo(exited.calls)[0]).toContain('terminal-exited');
  });
  it('plain-matches an arbitrary completed CI result ID without owner or Task witness', async () => {
    const id = 'ci:42:' + head + ':17';
    const run = await tick({ config: setting, terminals: [terminals[0]!, terminals[1]!],
      screens: { coord: 'idle', one: 'PARKED on ' + id },
      listOpenPulls: () => [{ number: 42, ref: 'synthetic', sha: head }],
      checkRunsFinishedAt: () => 17,
      readPackReviewStage: () => undefined,
    });
    expect(textTo(run.calls)[0]).toContain('checks-completed');
  });

  it('keeps unmatched PARKED quiet and direct reminders at elapsed 30/60 minutes', async () => {
    const store = new MemoryWakeStore(), screens = { coord: 'idle', one: 'PARKED on missing-event' };
    const step = (now: number) => tick({ store, screens, now: () => now,
      terminals: [terminals[0]!, terminals[1]!] });
    expect(sends((await step(0)).calls)).toHaveLength(0);
    expect(sends((await step(1_799_999)).calls)).toHaveLength(0);
    const thirty = await step(1_800_000);
    expect(textTo(thirty.calls)[0]).toContain('Reminder: parked 30 min');
    expect(sendsTo(thirty.calls, 'coord')).toHaveLength(0);
    expect(textTo((await step(1_800_000)).calls)).toHaveLength(0);
    expect(textTo((await step(3_600_000)).calls)[0]).toContain('Reminder: parked 30 min');
  });
  it('encodes punctuation in terminal paths as shell-inert one-line re-check', async () => {
    const event = { path: '/tmp/opencode/event;not-a-command-terminal.json', invocationId: 'inv-command' };
    const result = await tick({ terminals: [terminals[0]!, terminals[1]!],
      screens: { coord: 'idle', one: 'PARKED on inv-command' }, listTerminalEnvelopes: () => [event] });
    const text = textTo(result.calls)[0] ?? '';
    expect(text).toContain('re-check');
    expect(text).toMatch(/^[A-Za-z0-9 _./:%#=+-]+$/u);
    expect(text).not.toMatch(/[;&|$'"()<>*?\\\x00-\x1f\x7f]/u);
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
    targetId: 'local-fixture', url, issue: 2471, review: false,
    generating: false, banners: [{
      url, issue: 2471, review: false, kind,
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

  it('isolates local attempts from per-pane STOPPED state and fresh local IDs', async () => {
    const store = new MemoryWakeStore();
    const screens = { coord: 'idle', one: 'A decision is needed', two: 'working\nesc interrupt' };
    const step = (at: number, rows: ProjectChat[], paneScreens = screens) =>
      tick({ config: settings, store, screens: paneScreens, now: () => at,
        readChats: async () => rows, listOpenPulls: () => [] });
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
    expect(cadence.result.state).toBe('same_stopped_set');
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


  it('preserves ordinary STOPPED per-pane transitions when a local mark write fails', async () => {
    const store = new MemoryWakeStore();
    const originalMark = store.markParkedWakeEvent.bind(store);
    const markSpy = vi.spyOn(store, 'markParkedWakeEvent').mockImplementation((key, status) => {
      if (key.startsWith('local-chat:')) throw new Error('synthetic local mark storage failure');
      originalMark(key, status);
    });
    const screens = { coord: 'idle', one: 'A decision is needed', two: 'working\nesc interrupt' };
    const changedScreens = { ...screens, two: 'Another decision is needed' };
    const step = (at: number, paneScreens = screens) =>
      tick({ config: settings, store, screens: paneScreens, now: () => at,
        readChats: async () => [row(local)], listOpenPulls: () => [] });

    const first = await step(0);
    expect(first.result.state).toBe('sent');
    expect(sendsTo(first.calls, 'coord')).toHaveLength(2);
    expect(textTo(first.calls, 'coord')).toContain('STOPPED one');
    expect(textTo(first.calls, 'coord')).not.toContain('local-chatgpt:');
    expect(store.parkedWakeEvents.size).toBe(0);
    expect(store.readLastSentSignature()).not.toContain(local);

    const throttled = await step(60_000);
    expect(throttled.result.state).toBe('same_stopped_set');
    expect(sendsTo(throttled.calls, 'coord')).toHaveLength(0);

    const changed = await step(60_001, changedScreens);
    expect(changed.result.state).toBe('sent');
    expect(textTo(changed.calls, 'coord')).toContain('STOPPED two');
    expect(textTo(changed.calls, 'coord')).not.toContain(local);
    markSpy.mockRestore();

    // Storage recovery admits the still-unsent local warning without changing
    // the independent ordinary signature or replaying any previously sent local.
    const localSent = await step(60_002, changedScreens);
    expect(localSent.result.state).toBe('sent');
    expect(textTo(localSent.calls, 'coord')).toContain(local);
    expect([...store.parkedWakeEvents].map((key) => store.readParkedWakeEventStatus(key))).toEqual(['sent']);
    const after = await step(60_003, changedScreens);
    expect(after.result.state).toBe('same_stopped_set');
    expect(sendsTo(after.calls, 'coord')).toHaveLength(0);
  });

  it('withholds local-only notification if the pre-effect mark cannot be written', async () => {
    const store = new MemoryWakeStore();
    vi.spyOn(store, 'markParkedWakeEvent').mockImplementation(() => {
      throw new Error('synthetic local mark write refusal');
    });
    const denied = await tick({ config: settings, store, screens: idle,
      readChats: async () => [row(local)] });
    expect(denied.result.state).toBe('send_failed');
    expect(sendsTo(denied.calls, 'coord')).toHaveLength(0);
    expect(store.parkedWakeEvents.size).toBe(0);
    expect(store.readLastSentSignature()).toBeNull();
  });

  it('never uses an unrelated terminal envelope, stale target or unbound DOM role as local identity', async () => {
    const store = new MemoryWakeStore();
    const envelope: TerminalEnvelopeEvent = {
      path: '/tmp/opencode/child-start-failed-terminal.json', invocationId: 'inv-child-start-failed',
      terminalHandle: 'missing', cwd: '/foreign/worktree',
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
      expect(firstSend).toHaveLength(caseName === 'before-first' ? 0 : caseName === 'failed-second' ? 2 : 1);
      if (firstSend.length > 0) expect(firstSend[0]).toContain('--text');
      if (caseName === 'failed-second') expect(firstSend[1]).not.toContain('--text');
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


describe('Issue #2485 r05: plain event wake, no proof gates and pane-local alarms', () => {
  const id = '24852485-1111-4111-8111-248524852485';
  const event = { path: '/tmp/opencode/2485-r05-terminal.json', invocationId: id, observedInvocationId: id };
  const parked = 'PARKED on GPT turn ' + id;
  const paneText = (calls: readonly string[][], handle: string) => sendsTo(calls, handle)
    .filter((row) => row.includes('--text')).map((row) => row[row.indexOf('--text') + 1]!);
  const simple = (screens: Record<string,string>, store?: FleetWakeStateStore,
    envelopes: readonly TerminalEnvelopeEvent[] = [event]) =>
    tick({ screens, store, terminals: [terminals[0]!, terminals[1]!, terminals[2]!],
      listTerminalEnvelopes: () => envelopes });

  it('AC1/2: matches a terminal envelope filename or ID with no Task, receipt, index or process identity', async () => {
    const first = await simple({ coord: 'idle', one: parked, two: 'working\nesc interrupt' });
    expect(paneText(first.calls, 'one')).toHaveLength(1);
    expect(paneText(first.calls, 'one')[0]).toContain('re-check');
    expect(sendsTo(first.calls, 'coord')).toHaveLength(0);
    const byName = await simple({ coord: 'idle', one: 'PARKED on 2485-r05-terminal.json',
      two: 'working\nesc interrupt' });
    expect(paneText(byName.calls, 'one')).toHaveLength(1);
    expect(paneText(byName.calls, 'one')[0]).toContain(event.path);
    const noProof = byName.calls.filter((row) => row[0] === 'orchestration' && row[1] === 'worker-show');
    expect(noProof).toHaveLength(0);
    const foreign = await simple({ coord: 'idle', one: parked, two: 'working\nesc interrupt' },
      new MemoryWakeStore(), [{ path: '/tmp/opencode/foreign-terminal.json', invocationId: 'different-id' }]);
    expect(paneText(foreign.calls, 'one')).toHaveLength(0);
  });

  it('AC3: ignores legacy global mark, owner/generation conflict and stale claimant order', async () => {
    const store = new MemoryWakeStore();
    store.markParkedWakeEvent('gpt:' + event.path);
    const first = await simple({ coord: 'idle', one: parked, two: parked }, store);
    expect(paneText(first.calls, 'one')).toHaveLength(1);
    expect(paneText(first.calls, 'two')).toHaveLength(1);
    const repeated = await simple({ coord: 'idle', one: parked, two: parked }, store);
    expect(paneText(repeated.calls, 'one')).toHaveLength(0);
    expect(paneText(repeated.calls, 'two')).toHaveLength(0);
    expect([...store.parkedWakeEvents].filter((key) => key.startsWith('event:'))).toHaveLength(2);
    expect(first.logs.join(' ')).not.toContain('owner_generation_unproven');
  });

  it('AC4: sent marker is per-(pane,event), so changed X wakes only its parked pane', async () => {
    const store = new MemoryWakeStore();
    const old = await simple({ coord: 'idle', one: parked, two: parked }, store);
    expect(paneText(old.calls, 'one')).toHaveLength(1);
    expect(paneText(old.calls, 'two')).toHaveLength(1);
    const other = { path: '/tmp/opencode/other-terminal.json', invocationId: 'other-token' };
    const changed = await simple({ coord: 'idle', one: 'PARKED on other-token', two: parked },
      store, [event, other]);
    expect(paneText(changed.calls, 'one')).toHaveLength(1);
    expect(paneText(changed.calls, 'one')[0]).toContain('other-terminal');
    expect(paneText(changed.calls, 'two')).toHaveLength(0);
  });

  it('AC5: bare-shell suspicion is the only Wake veto and raises one coordinator alarm', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-r05-shell-'));
    try {
      const store = new FileFleetWakeStateStore('r05-shell', { XDG_RUNTIME_DIR: root });
      const agent: FleetTerminal = { ...terminals[1]!, title: 'OpenCode manager',
        agentIdentity: 'opencode', incarnationId: 'inc-1',
        branch: 'refs/heads/work', status: 'running' };
      const shell: FleetTerminal = { ...agent, title: 'bash', agentIdentity: undefined };
      const first = await tick({ store, terminals: [terminals[0]!, agent],
        screens: { coord: 'idle', one: 'work\nesc interrupt' }, listTerminalEnvelopes: () => [event] });
      expect(sendsTo(first.calls, 'one')).toHaveLength(0);
      const second = await tick({ store, terminals: [terminals[0]!, shell],
        screens: { coord: 'idle', one: parked }, listTerminalEnvelopes: () => [event] });
      expect(sendsTo(second.calls, 'one')).toHaveLength(0);
      expect(paneText(second.calls, 'coord')[0]).toContain('suspected_bare_shell one');
      const third = await tick({ store, terminals: [terminals[0]!, shell],
        screens: { coord: 'idle', one: parked }, listTerminalEnvelopes: () => [event] });
      expect(sendsTo(third.calls, 'coord')).toHaveLength(0);
      expect(sendsTo(third.calls, 'one')).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('AC6: per-pane alarm state is independent of another pane changing', async () => {
    const store = new MemoryWakeStore();
    const first = await simple({ coord: 'idle', one: 'done', two: 'needs a step' }, store, []);
    expect(first.result).toMatchObject({ state: 'sent', count: 2 });
    const unchanged = await simple({ coord: 'idle', one: 'done', two: 'needs a step' }, store, []);
    expect(unchanged.result.state).toBe('same_stopped_set');
    const parked = await simple({ coord: 'idle', one: 'PARKED on waiting', two: 'needs a step' }, store, []);
    expect(sendsTo(parked.calls, 'coord')).toHaveLength(0);
    const changed = await simple({ coord: 'idle', one: 'done again', two: 'needs a step' }, store, []);
    expect(changed.result).toMatchObject({ state: 'sent', count: 1 });
    expect(paneText(changed.calls, 'coord')[0]).toContain('STOPPED one');
    expect(paneText(changed.calls, 'coord')[0]).not.toContain('STOPPED two');
  });

  it('AC7: deleted proof gates and old unresolvable alarms are absent from the implementation', () => {
    const source = readFileSync(new URL('./fleet-wake.ts', import.meta.url), 'utf8');
    const docs = readFileSync(new URL('../../docs/fleet-alarm.md', import.meta.url), 'utf8');
    for (const removed of ['indexedGptResolution', 'freshIndexedGptOwner',
      'exactParkedTask', 'probeIndexedLauncherPid', 'invocationReceiptLocatorPath',
      'readInvocationReceiptLocator', 'owner_generation_unproven',
      'vetoLegacyKey', 'claimedLegacy', 'park on unresolvable producer']) {
      expect(source).not.toContain(removed);
    }
    expect(docs).not.toContain('park on unresolvable producer');
    expect(source).toContain('suspected_bare_shell');
    expect(docs).toContain('per-project');
  });

  it('AC7: long nonrepresentable envelope evidence does not become a Wake skip gate', async () => {
    const longEvent = { path: '/tmp/opencode/' + 'é'.repeat(200) + '.json', invocationId: 'long-token' };
    const run = await simple({ coord: 'idle', one: 'PARKED on long-token', two: 'working\nesc interrupt' },
      new MemoryWakeStore(), [longEvent]);
    expect(paneText(run.calls, 'one')).toHaveLength(1);
    expect(paneText(run.calls, 'one')[0]).toContain('re-check');
    expect(sendsTo(run.calls, 'coord')).toHaveLength(0);
  });
});
