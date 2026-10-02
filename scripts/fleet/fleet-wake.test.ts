// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FileFleetWakeStateStore,
  findTerminalEnvelopeForInvocation,
  fleetAlarmMessage,
  managerBannerMessage,
  runFleetAlarmTick,
  type FleetWakeConfig,
  type FleetWakeStateStore,
} from './fleet-wake.ts';
import { FileFleetStateStore, type FleetTerminal, type OrcaCommandResult, type OrcaExecutor } from './fleet-sweep.ts';

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
  findTerminalEnvelope?: (invocationId: string) => string | undefined;
  checkRunsCompleted?: (repository: string, sha: string) => boolean;
}) {
  const calls: string[][] = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  const store = input.store ?? new MemoryWakeStore();
  const result = await runFleetAlarmTick({
    config: input.config ?? config(),
    executor: fakeOrca(input.screens, calls, input.terminals),
    store,
    sleepMs: async (ms) => { sleeps.push(ms); },
    log: (line) => { logs.push(line); },
    ...(input.findTerminalEnvelope ? { findTerminalEnvelope: input.findTerminalEnvelope } : {}),
    ...(input.checkRunsCompleted ? { checkRunsCompleted: input.checkRunsCompleted } : {}),
  });
  return { result, calls, logs, sleeps, store };
}

function sends(calls: readonly string[][]): string[][] {
  return calls.filter((call) => call[0] === 'terminal' && call[1] === 'send');
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

  it('wakes a PARKED GPT turn only with matching terminal evidence and never repeats an invocation', async () => {
    const store = new MemoryWakeStore();
    const invocationId = '887cc977-f28e-4ab1-b498-e4ebced05551';
    const envelopePath = '/tmp/opencode/ff1-terminal.json';
    const screens = {
      coord: 'idle',
      one: `PARKED on GPT turn ${invocationId} (self-wake armed).`,
      two: 'working\nesc interrupt',
    };

    const missing = await tick({
      screens,
      store,
      findTerminalEnvelope: () => undefined,
    });
    expect(sends(missing.calls)).toHaveLength(0);

    const matched = await tick({
      screens,
      store,
      findTerminalEnvelope: (observed) => observed === invocationId ? envelopePath : undefined,
    });
    expect(sends(matched.calls)).toEqual([[
      'terminal', 'send', '--terminal', 'one',
      '--text', `Wake: GPT turn ${invocationId} ended, read ${envelopePath}`,
      '--enter',
    ], ['terminal', 'send', '--terminal', 'one', '--enter']]);

    const repeated = await tick({
      screens,
      store,
      findTerminalEnvelope: () => envelopePath,
    });
    expect(sends(repeated.calls)).toHaveLength(0);
  });

  it('matches GPT terminal evidence by observed_invocation_id under /tmp/opencode shape', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-wake-terminal-'));
    try {
      const nested = join(root, 'nested');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(root, 'wrong-terminal.json'), JSON.stringify({ observed_invocation_id: 'other' }), 'utf8');
      const matching = join(nested, 'matching-terminal.json');
      writeFileSync(matching, JSON.stringify({ observed_invocation_id: '887cc977-f28e-4ab1-b498-e4ebced05551' }), 'utf8');

      expect(findTerminalEnvelopeForInvocation('887cc977-f28e-4ab1-b498-e4ebced05551', root)).toBe(matching);
      expect(findTerminalEnvelopeForInvocation('887cc977', root)).toBe(matching);
      expect(findTerminalEnvelopeForInvocation('missing', root)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('wakes PARKED CI only after every check-run is completed and never repeats a sha', async () => {
    const store = new MemoryWakeStore();
    const sha = 'a'.repeat(40);
    const wakeConfig = config({
      chatScope: {
        projectUrl: 'https://chatgpt.com/g/g-p/project/test',
        repository: 'chetwerikoff/orchestrator-pack',
      },
    });
    const screens = {
      coord: 'idle',
      one: `PARKED on CI on ${sha}; resume step: smoke.`,
      two: 'working\nesc interrupt',
    };

    const incomplete = await tick({
      screens,
      store,
      config: wakeConfig,
      checkRunsCompleted: (repository, observedSha) => {
        expect(repository).toBe('chetwerikoff/orchestrator-pack');
        expect(observedSha).toBe(sha);
        return false;
      },
    });
    expect(sends(incomplete.calls)).toHaveLength(0);

    const completed = await tick({
      screens,
      store,
      config: wakeConfig,
      checkRunsCompleted: () => true,
    });
    expect(sends(completed.calls)).toEqual([[
      'terminal', 'send', '--terminal', 'one',
      '--text', `Wake: CI on ${sha} finished`,
      '--enter',
    ], ['terminal', 'send', '--terminal', 'one', '--enter']]);

    const repeated = await tick({
      screens,
      store,
      config: wakeConfig,
      checkRunsCompleted: () => true,
    });
    expect(sends(repeated.calls)).toHaveLength(0);
  });

  it('does not wake merged-Issue or orchestrator-answer PARKED panes', async () => {
    const observed = await tick({
      config: config({
        chatScope: {
          projectUrl: 'https://chatgpt.com/g/g-p/project/test',
          repository: 'chetwerikoff/orchestrator-pack',
        },
      }),
      screens: {
        coord: 'idle',
        one: 'PARKED on #2351 merged',
        two: 'PARKED on orchestrator answer',
      },
      findTerminalEnvelope: () => '/tmp/opencode/unrelated-terminal.json',
      checkRunsCompleted: () => true,
    });
    expect(sends(observed.calls)).toHaveLength(0);
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

  it('never invokes orchestration, git, or gh and mutates Orca only through terminal send to the resolved coordinator', async () => {
    const observed = await tick({ screens: { coord: 'idle', one: 'done', two: 'working\nesc to interrupt' } });
    expect(observed.calls.some((call) => call[0] === 'orchestration' || call[0] === 'git' || call[0] === 'gh')).toBe(false);
    const mutating = observed.calls.filter((call) => call[1] === 'send');
    expect(mutating).toHaveLength(2);
    expect(mutating.every((call) => call[0] === 'terminal' && call[call.indexOf('--terminal') + 1] === 'coord')).toBe(true);
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
