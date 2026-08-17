import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcess } from '../kernel/subprocess.ts';
import {
  publishCurrentWorkerAssignment,
  resolveWorkerAssignmentStorePath,
} from '../lib/worker-assignment-store.ts';
import {
  readFleetReconciliationHandoff,
  resolveFleetReconciliationHandoffPath,
} from './fleet-reconciliation-handoff.ts';
import type { FleetObserverSource } from './fleet-observer.ts';
import type { RuntimeCallOptions, RuntimeWorker, RuntimeWorkerIdentity } from '../runtime/contracts.ts';
import { productionFleetObserverSource, runSchedulerTick, type SchedulerBoundary } from './scheduler.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-1420-process-'));
  roots.push(root);
  return root;
}

function writeEpoch(file: string, epochId: string, nonce: string): void {
  writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    currentEpochId: epochId,
    records: [{
      epochId,
      nonce,
      hostId: 'host-1420',
      repoRoot: process.cwd(),
      installedCommitSha: 'a'.repeat(40),
      snapshotDigests: {},
      importDigests: {},
      registryHash: 'a',
      preCommitLogDigest: 'b',
      commitAt: '2026-08-15T00:00:00.000Z',
    }],
  }));
}

function installOrcaFixture(root: string): string {
  const executable = path.join(root, 'orca');
  const source = `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2).filter((value) => value !== '--json');
const fixturePath = String(process.env.OPK_PROCESS_FIXTURE_PATH ?? '');
const state = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const get = (name) => { const index = args.indexOf(name); return index < 0 ? '' : String(args[index + 1] ?? ''); };
const operation = args.slice(0, 2).join(' ');
const save = () => fs.writeFileSync(fixturePath, JSON.stringify(state));
const out = (value) => { save(); process.stdout.write(JSON.stringify(value) + '\\n'); };
const terminal = (worker) => ({
  handle: worker.id,
  incarnationId: worker.generation,
  worktreePath: worker.worktreePath ?? process.cwd(),
  title: 'fixture-' + worker.id,
  status: worker.liveness === 'gone' ? 'exited' : 'running',
});
if (!fixturePath) process.exit(2);
switch (operation) {
  case 'worktree current':
    out({ ok: true, result: { worktree: { path: process.cwd(), head: 'a'.repeat(40), linkedIssue: null } } });
    break;
  case 'terminal list':
    const requestedWorktree = get('--worktree');
    const requestedPath = requestedWorktree.startsWith('path:')
      ? requestedWorktree.slice('path:'.length)
      : requestedWorktree;
    state.listWorkerWorktrees = [...(state.listWorkerWorktrees ?? []), requestedPath];
    const terminals = state.workers
      .filter((worker) => worker.liveness !== 'gone')
      .filter((worker) => !requestedPath || path.resolve(worker.worktreePath ?? process.cwd()) === path.resolve(requestedPath))
      .map(terminal);
    out({ ok: true, result: { terminals } });
    break;
  case 'terminal show': {
    const worker = state.workers.find((candidate) => candidate.id === get('--terminal') && candidate.liveness !== 'gone');
    out(worker
      ? { ok: true, result: { terminal: terminal(worker) } }
      : { ok: false, error: { code: 'terminal_not_found', message: 'terminal not found' } });
    break;
  }
  case 'orchestration worker-show': {
    state.resolveCalls = Number(state.resolveCalls ?? 0) + 1;
    const dispatch = get('--dispatch');
    const dropAt = Number(state.dropResolutionAtCall ?? 0);
    const resolutionAllowed = dropAt <= 0 || state.resolveCalls < dropAt;
    const matches = resolutionAllowed
      ? state.workers.filter((candidate) => candidate.bindingKey === dispatch && candidate.liveness !== 'gone')
      : [];
    const worker = matches.length === 1 ? matches[0] : null;
    out(worker
      ? { ok: true, result: { worker: { agent_terminal_handle: worker.id }, terminal: { handle: worker.id }, observation: { exactWorker: true, status: 'running' } } }
      : { ok: true, result: { observation: { exactWorker: false, status: 'unknown' } } });
    break;
  }
  case 'terminal read': {
    const worker = state.workers.find((candidate) => candidate.id === get('--terminal') && candidate.liveness !== 'gone');
    if (!worker) {
      out({ ok: false, error: { code: 'terminal_not_found', message: 'terminal not found' } });
      break;
    }
    const cursor = get('--cursor');
    const start = cursor ? Math.max(0, Number(cursor) || 0) : 0;
    const lines = worker.lines.slice(start);
    out({ ok: true, result: { terminal: {
      handle: worker.id,
      status: 'running',
      tail: lines,
      nextCursor: String(worker.lines.length),
      latestCursor: String(worker.lines.length),
    } } });
    break;
  }
  case 'terminal wait': {
    const worker = state.workers.find((candidate) => candidate.id === get('--terminal'));
    if (!worker || worker.liveness === 'gone') {
      out({ ok: true, result: { wait: { handle: get('--terminal'), status: 'exited', satisfied: false } } });
      break;
    }
    out({ ok: true, result: { wait: {
      handle: worker.id,
      status: 'running',
      satisfied: worker.liveness === 'idle',
    } } });
    break;
  }
  case 'terminal send': {
    state.sendCalls = Number(state.sendCalls ?? 0) + 1;
    const worker = state.workers.find((candidate) => candidate.id === get('--terminal') && candidate.liveness !== 'gone');
    if (!worker) {
      out({ ok: false, error: { code: 'terminal_not_found', message: 'terminal not found' } });
      break;
    }
    if (state.dispatchOutcome === 'dispatch_unknown') {
      process.stdout.write('{');
      process.exit(0);
    }
    if (state.dispatchOutcome === 'send_failed') {
      out({ ok: false, error: { code: 'send_rejected', message: 'send rejected' } });
      break;
    }
    const message = get('--text');
    state.dispatches = [...(state.dispatches ?? []), { workerId: worker.id, message }];
    worker.lines = [...worker.lines, message];
    if (state.corruptJournalAfterSend) {
      fs.writeFileSync(String(process.env.OPK_WORKER_MESSAGE_DISPATCH_JOURNAL ?? ''), '{not-json', 'utf8');
    }
    out({ ok: true, result: { send: { accepted: true } } });
    break;
  }
  default:
    out({ ok: false, error: { code: 'unexpected_operation', message: operation } });
}
`;
  writeFileSync(executable, source, 'utf8');
  chmodSync(executable, 0o755);
  return executable;
}

async function runTickProcess(env: NodeJS.ProcessEnv) {
  return runProcess({
    command: process.execPath,
    args: [path.resolve('scripts/pr2-foundation/scheduler.ts'), 'tick'],
    cwd: process.cwd(),
    env,
    inheritParentEnv: false,
    allowEmptyStdout: true,
    timeoutMs: 30_000,
  });
}

async function runTick(env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const result = await runTickProcess(env);
  expect(result.ok, result.stderr || result.stdout || result.error).toBe(true);
  const line = result.stdout.trim().split(/\r?\n/u).at(-1) ?? '';
  expect(line).not.toBe('');
  return JSON.parse(line) as Record<string, unknown>;
}

async function runTickFailure(env: NodeJS.ProcessEnv): Promise<string> {
  const result = await runTickProcess(env);
  expect(result.ok, result.stdout || result.stderr || result.error).toBe(false);
  return result.stderr || result.error || result.stdout;
}

function schedulerResult(value: Record<string, unknown>): Record<string, unknown> {
  const scheduler = value.scheduler;
  expect(scheduler && typeof scheduler === 'object').toBe(true);
  return scheduler as Record<string, unknown>;
}

function observerResult(value: Record<string, unknown>): Record<string, unknown> {
  const observer = schedulerResult(value).observer;
  expect(observer && typeof observer === 'object').toBe(true);
  return observer as Record<string, unknown>;
}

interface FixtureState {
  workers: Array<{ id: string; generation: string; bindingKey: string; lines: string[]; liveness: string; worktreePath?: string }>;
  dispatchOutcome?: string;
  dispatches?: Array<{ workerId: string; message: string }>;
  listWorkerWorktrees?: string[];
  sendCalls?: number;
  resolveCalls?: number;
  dropResolutionAtCall?: number;
  corruptJournalAfterSend?: boolean;
}

function fixture(file: string): FixtureState {
  return JSON.parse(readFileSync(file, 'utf8')) as FixtureState;
}

function processEnv(root: string, fixturePath: string, epochPath: string, configPath: string, epochId: string, nonce: string): NodeJS.ProcessEnv {
  const runtimeCli = installOrcaFixture(root);
  return {
    ...process.env,
    PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}`,
    OPK_RUNTIME_CLI_COMMAND: runtimeCli,
    OPK_PROCESS_FIXTURE_PATH: fixturePath,
    OPK_BASE_DIR: path.join(root, 'opk'),
    OPK_SIDE_PROCESS_STATE_DIR: path.join(root, 'side-state'),
    OPK_WORKER_NUDGE_CLAIM_DIR: path.join(root, 'claims'),
    OPK_WORKER_MESSAGE_DISPATCH_JOURNAL: path.join(root, 'dispatch-journal.json'),
    OPK_REPOSITORY: 'chetwerikoff/orchestrator-pack',
    OPK_FLEET_OBSERVER_CONFIG: configPath,
    ORCHESTRATOR_CUTOVER_EPOCH_AUTHORITY: epochPath,
    ORCHESTRATOR_CUTOVER_EPOCH_ID: epochId,
    ORCHESTRATOR_CUTOVER_NONCE: nonce,
  };
}

function handoff(env: NodeJS.ProcessEnv) {
  return readFleetReconciliationHandoff(resolveFleetReconciliationHandoffPath('orchestrator-pack', env));
}

async function publishLocal(env: NodeJS.ProcessEnv, bindingKey = 'dispatch-1', taskId = 'task-1420') {
  const result = await publishCurrentWorkerAssignment({
    file: resolveWorkerAssignmentStorePath('orchestrator-pack', env),
    repository: 'chetwerikoff/orchestrator-pack',
    issueNumber: 1420,
    taskId,
    kind: 'local',
    provider: 'orca',
    bindingKey,
  });
  expect(result.ok).toBe(true);
  return result;
}

describe('scheduler bounded-child production composition', () => {
  it('publishes an empty census when no current assignment is available', async () => {
    const root = makeRoot();
    const fixturePath = path.join(root, 'fixture.json');
    const epochPath = path.join(root, 'epoch.json');
    const configPath = path.join(root, 'fleet-config.json');
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, livelockTicks: 1 }));
    writeFileSync(fixturePath, JSON.stringify({
      workers: [], dispatches: [],
    }));
    writeEpoch(epochPath, 'epoch-repo-root', 'nonce-repo-root');
    const env = processEnv(root, fixturePath, epochPath, configPath, 'epoch-repo-root', 'nonce-repo-root');
    delete env.OPK_REPOSITORY;

    const result = await runTick(env);
    expect(observerResult(result)).toMatchObject({
      result: 'census-published-observer-only',
      status: 'complete',
      snapshotCommitted: true,
    });
  });

  it('ignores an external operator terminal when no assignments are stored', async () => {
    const root = makeRoot();
    const fixturePath = path.join(root, 'fixture.json');
    const epochPath = path.join(root, 'epoch.json');
    const configPath = path.join(root, 'fleet-config.json');
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, livelockTicks: 1 }));
    writeFileSync(fixturePath, JSON.stringify({
      workers: [{
        id: 'operator-panel',
        generation: 'generation-external',
        bindingKey: 'not-assigned',
        lines: [],
        liveness: 'busy',
        worktreePath: '/home/che/orca/workspaces/orchestrator-pack/mgr1415-sup',
      }],
      dispatches: [],
    }));
    writeEpoch(epochPath, 'epoch-external-only', 'nonce-external-only');
    const env = processEnv(root, fixturePath, epochPath, configPath, 'epoch-external-only', 'nonce-external-only');

    const observer = observerResult(await runTick(env));
    expect(observer).toMatchObject({
      result: 'census-published-observer-only',
      status: 'complete',
      snapshotCommitted: true,
    });
    expect((observer.snapshot as Record<string, unknown>).census).toEqual([]);
  });

  it('publishes an assigned child-worktree worker and excludes external terminals in any tree', async () => {
    const root = makeRoot();
    const fixturePath = path.join(root, 'fixture.json');
    const epochPath = path.join(root, 'epoch.json');
    const configPath = path.join(root, 'fleet-config.json');
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, livelockTicks: 1 }));
    writeFileSync(fixturePath, JSON.stringify({
      workers: [
        {
          id: 'assigned-worker',
          generation: 'generation-assigned',
          bindingKey: 'dispatch-1',
          lines: ['unchanged'],
          liveness: 'idle',
          worktreePath: '/home/che/orca/workspaces/orchestrator-pack/mgr1415-sup',
        },
        {
          id: 'operator-panel',
          generation: 'generation-external',
          bindingKey: 'not-assigned',
          lines: [],
          liveness: 'busy',
          worktreePath: '/home/che/projects/orchestrator-pack',
        },
        {
          id: 'child-external-panel',
          generation: 'generation-external-child',
          bindingKey: 'not-assigned-child',
          lines: [],
          liveness: 'busy',
          worktreePath: '/home/che/orca/workspaces/orchestrator-pack/mgr1415-sup',
        },
      ],
      dispatches: [],
    }));
    writeEpoch(epochPath, 'epoch-shared-worktree', 'nonce-shared-worktree');
    const env = processEnv(root, fixturePath, epochPath, configPath, 'epoch-shared-worktree', 'nonce-shared-worktree');
    await publishLocal(env);

    const observer = observerResult(await runTick(env));
    const census = (observer.snapshot as Record<string, unknown>).census as Array<Record<string, unknown>>;
    expect(census).toHaveLength(1);
    expect(census[0]?.provenance).toBe('internal');
    expect(fixture(fixturePath).listWorkerWorktrees?.[0]).toBe('/home/che/orca/workspaces/orchestrator-pack/mgr1415-sup');
  });

  it('keeps assignment census lookups inside one shared S1 timeout budget', async () => {
    const workers: RuntimeWorker[] = [
      {
        identity: { runtime: 'orca', id: 'budget-worker-a', generation: 'generation-budget-a' },
        workspacePath: '/home/che/orca/workspaces/orchestrator-pack/mgr1415-sup',
        title: 'budget-worker-a',
        provenance: 'internal',
      },
      {
        identity: { runtime: 'orca', id: 'budget-worker-b', generation: 'generation-budget-b' },
        workspacePath: '/home/che/orca/workspaces/orchestrator-pack/mgr1416-sup',
        title: 'budget-worker-b',
        provenance: 'internal',
      },
    ];
    const timeouts: number[] = [];
    const runtime: FleetObserverSource = {
      listWorkers: () => ({ status: 'ok', value: [] }),
      findWorker: (identity: RuntimeWorkerIdentity, options?: RuntimeCallOptions) => {
        timeouts.push(options?.timeoutMs ?? 0);
        if (timeouts.length === 1) {
          const delayDeadline = Date.now() + 20;
          while (Date.now() < delayDeadline) {}
        }
        return { status: 'ok', value: workers.find((worker) => worker.identity.id === identity.id) ?? null };
      },
      readBoundedOutput: () => ({ status: 'failed', operation: 'read_bounded_output', reason: 'unused' }),
      liveness: () => ({ status: 'unknown', worker: workers[0]!.identity }),
    };
    const source = productionFleetObserverSource(runtime, workers.map((worker, index) => ({
      assignmentId: `assignment-budget-${index}`,
      assignmentGeneration: 1,
      issueNumber: 1420,
      taskId: `task-budget-${index}`,
      unitRef: `u-budget-${index}`,
      worker: worker.identity,
    })));

    const result = await source.listWorkers({ workspace: 'active' }, { timeoutMs: 100 });
    expect(result).toMatchObject({ status: 'ok' });
    expect(timeouts).toHaveLength(2);
    expect(timeouts[0]).toBeGreaterThan(timeouts[1]!);
  });

  it('restores one S1 lineage across separate child processes and dispatches one existing S2 episode', async () => {
    const root = makeRoot();
    const fixturePath = path.join(root, 'fixture.json');
    const epochPath = path.join(root, 'epoch.json');
    const configPath = path.join(root, 'fleet-config.json');
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, livelockTicks: 1, maxConcurrency: 2 }));
    writeFileSync(fixturePath, JSON.stringify({
      workers: [{ id: 'worker-1', generation: 'generation-1', bindingKey: 'dispatch-1', lines: ['unchanged'], liveness: 'busy' }],
      dispatches: [],
    }));
    writeEpoch(epochPath, 'epoch-1420', 'nonce-1420');
    const env = processEnv(root, fixturePath, epochPath, configPath, 'epoch-1420', 'nonce-1420');
    await publishLocal(env);

    const first = await runTick(env);
    const second = await runTick(env);
    expect(fixture(fixturePath).dispatches).toHaveLength(1);
    const third = await runTick(env);
    expect(fixture(fixturePath).dispatches).toHaveLength(1);

    const firstObserver = observerResult(first);
    const secondObserver = observerResult(second);
    const thirdObserver = observerResult(third);
    expect(firstObserver.schedulerGeneration).toBe(secondObserver.schedulerGeneration);
    expect(secondObserver.schedulerGeneration).toBe(thirdObserver.schedulerGeneration);
    expect([firstObserver.tickSequence, secondObserver.tickSequence, thirdObserver.tickSequence]).toEqual([1, 2, 3]);

    const secondNudge = schedulerResult(second).fleetNudge as Record<string, unknown>;
    expect(secondNudge.dispatched).toBe(1);
    expect(secondNudge.sendAttempts).toBe(1);
    const thirdNudge = schedulerResult(third).fleetNudge as Record<string, unknown>;
    expect(thirdNudge.dispatched).toBe(0);
  });

  it('classifies a quiet assigned child as idle and dispatches one S2 episode', async () => {
    const root = makeRoot();
    const fixturePath = path.join(root, 'fixture.json');
    const epochPath = path.join(root, 'epoch.json');
    const configPath = path.join(root, 'fleet-config.json');
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, livelockTicks: 2, maxConcurrency: 2 }));
    writeFileSync(fixturePath, JSON.stringify({
      workers: [{
        id: 'quiet-worker',
        generation: 'generation-quiet',
        bindingKey: 'dispatch-quiet',
        lines: ['baseline'],
        liveness: 'busy',
        worktreePath: '/home/che/orca/workspaces/orchestrator-pack/mgr1415-sup',
      }],
      dispatches: [],
    }));
    writeEpoch(epochPath, 'epoch-quiet', 'nonce-quiet');
    const env = processEnv(root, fixturePath, epochPath, configPath, 'epoch-quiet', 'nonce-quiet');
    await publishLocal(env, 'dispatch-quiet');

    const first = await runTick(env);
    const firstCensus = (observerResult(first).snapshot as Record<string, unknown>).census as Array<Record<string, unknown>>;
    expect(firstCensus).toHaveLength(1);
    expect(firstCensus[0]?.class).toBe('unknown');

    const next = fixture(fixturePath);
    next.workers = next.workers.map((worker) => ({ ...worker, liveness: 'idle' }));
    writeFileSync(fixturePath, JSON.stringify(next));

    const second = await runTick(env);
    const secondCensus = (observerResult(second).snapshot as Record<string, unknown>).census as Array<Record<string, unknown>>;
    expect(secondCensus[0]?.class).toBe('idle');
    expect((schedulerResult(second).fleetNudge as Record<string, unknown>).dispatched).toBe(1);
    expect(fixture(fixturePath).dispatches).toHaveLength(1);

    const third = await runTick(env);
    expect((schedulerResult(third).fleetNudge as Record<string, unknown>).dispatched).toBe(0);
    expect(fixture(fixturePath).dispatches).toHaveLength(1);
  });

  it('starts a fresh baseline after an activation epoch change', async () => {
    const root = makeRoot();
    const fixturePath = path.join(root, 'fixture.json');
    const epochPath = path.join(root, 'epoch.json');
    const configPath = path.join(root, 'fleet-config.json');
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, livelockTicks: 1 }));
    writeFileSync(fixturePath, JSON.stringify({
      workers: [{ id: 'worker-1', generation: 'generation-1', bindingKey: 'dispatch-1', lines: ['unchanged'], liveness: 'busy' }],
      dispatches: [],
    }));
    writeEpoch(epochPath, 'epoch-a', 'nonce-a');
    const baseEnv = processEnv(root, fixturePath, epochPath, configPath, 'epoch-a', 'nonce-a');
    await publishLocal(baseEnv);
    const first = await runTick(baseEnv);

    writeEpoch(epochPath, 'epoch-b', 'nonce-b');
    const changedEnv = { ...baseEnv, ORCHESTRATOR_CUTOVER_EPOCH_ID: 'epoch-b', ORCHESTRATOR_CUTOVER_NONCE: 'nonce-b' };
    const second = await runTick(changedEnv);
    expect(observerResult(second).schedulerGeneration).not.toBe(observerResult(first).schedulerGeneration);
    expect(observerResult(second).tickSequence).toBe(1);
    expect(fixture(fixturePath).dispatches).toHaveLength(0);
  });

  it('preserves dispatch_unknown without automatic retry in a later child', async () => {
    const root = makeRoot();
    const fixturePath = path.join(root, 'fixture.json');
    const epochPath = path.join(root, 'epoch.json');
    const configPath = path.join(root, 'fleet-config.json');
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, livelockTicks: 1 }));
    writeFileSync(fixturePath, JSON.stringify({
      workers: [{ id: 'worker-1', generation: 'generation-1', bindingKey: 'dispatch-1', lines: ['unchanged'], liveness: 'busy' }],
      dispatchOutcome: 'dispatch_unknown', dispatches: [],
    }));
    writeEpoch(epochPath, 'epoch-unknown', 'nonce-unknown');
    const env = processEnv(root, fixturePath, epochPath, configPath, 'epoch-unknown', 'nonce-unknown');
    await publishLocal(env);
    await runTick(env);
    const second = await runTick(env);
    const third = await runTick(env);
    const secondOutcomes = (schedulerResult(second).fleetNudge as Record<string, unknown>).outcomes as Array<Record<string, unknown>>;
    expect(secondOutcomes.some((row) => row.outcome === 'dispatch_unknown')).toBe(true);
    const thirdNudge = schedulerResult(third).fleetNudge as Record<string, unknown>;
    expect(thirdNudge.sendAttempts).toBe(0);
    expect(fixture(fixturePath).dispatches).toHaveLength(0);
  });

  it('persists effect_untrusted after send_failed and does not retry the same episode', async () => {
    const root = makeRoot();
    const fixturePath = path.join(root, 'fixture.json');
    const epochPath = path.join(root, 'epoch.json');
    const configPath = path.join(root, 'fleet-config.json');
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, livelockTicks: 1 }));
    writeFileSync(fixturePath, JSON.stringify({
      workers: [{ id: 'worker-1', generation: 'generation-1', bindingKey: 'dispatch-1', lines: ['unchanged'], liveness: 'busy' }],
      dispatchOutcome: 'send_failed', dispatches: [], sendCalls: 0,
    }));
    writeEpoch(epochPath, 'epoch-send-failed', 'nonce-send-failed');
    const env = processEnv(root, fixturePath, epochPath, configPath, 'epoch-send-failed', 'nonce-send-failed');
    await publishLocal(env);
    await runTick(env);
    const second = await runTick(env);
    const secondOutcomes = (schedulerResult(second).fleetNudge as Record<string, unknown>).outcomes as Array<Record<string, unknown>>;
    expect(secondOutcomes.some((row) => row.outcome === 'send_failed')).toBe(true);
    expect(schedulerResult(second).orchestratorRequired).toBe(true);
    expect(handoff(env)).toMatchObject({ reason: 'effect_untrusted', decision: 'orchestrator_required' });
    const third = await runTick(env);
    expect(fixture(fixturePath).sendCalls).toBe(1);
    expect(fixture(fixturePath).dispatches).toHaveLength(0);
    const thirdNudge = schedulerResult(third).fleetNudge as Record<string, unknown>;
    expect(thirdNudge.sendAttempts).toBe(0);
  });

  it('uses the established default S1 config and snapshot authorities across bounded children', async () => {
    const root = makeRoot();
    const fixturePath = path.join(root, 'fixture.json');
    const epochPath = path.join(root, 'epoch.json');
    const legacyHome = path.join(root, 'home');
    const legacyConfig = path.join(legacyHome, '.config', 'orchestrator-pack', 'fleet-observer.json');
    mkdirSync(path.dirname(legacyConfig), { recursive: true });
    writeFileSync(legacyConfig, JSON.stringify({ schemaVersion: 1, livelockTicks: 1 }));
    writeFileSync(fixturePath, JSON.stringify({
      workers: [{ id: 'worker-1', generation: 'generation-1', bindingKey: 'dispatch-1', lines: ['unchanged'], liveness: 'busy' }],
      dispatches: [],
    }));
    writeEpoch(epochPath, 'epoch-defaults', 'nonce-defaults');
    const env = processEnv(root, fixturePath, epochPath, legacyConfig, 'epoch-defaults', 'nonce-defaults');
    delete env.OPK_SIDE_PROCESS_STATE_DIR;
    delete env.OPK_FLEET_OBSERVER_CONFIG;
    env.HOME = legacyHome;
    await publishLocal(env);

    const first = await runTick(env);
    const second = await runTick(env);
    expect(observerResult(first).schedulerGeneration).toBe(observerResult(second).schedulerGeneration);
    expect(fixture(fixturePath).dispatches).toHaveLength(1);
    expect(existsSync(path.join(legacyHome, '.local', 'state', 'orchestrator-pack', 'fleet-observer', 'snapshot.json'))).toBe(true);
  });

  it('re-resolves the persistence-safe Dispatch before S2 claim/send', async () => {
    const root = makeRoot();
    const fixturePath = path.join(root, 'fixture.json');
    const epochPath = path.join(root, 'epoch.json');
    const configPath = path.join(root, 'fleet-config.json');
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, livelockTicks: 1 }));
    writeFileSync(fixturePath, JSON.stringify({
      workers: [{ id: 'worker-1', generation: 'generation-1', bindingKey: 'dispatch-1', lines: ['unchanged'], liveness: 'busy' }],
      dropResolutionAtCall: 3,
      dispatches: [],
    }));
    writeEpoch(epochPath, 'epoch-revalidate', 'nonce-revalidate');
    const env = processEnv(root, fixturePath, epochPath, configPath, 'epoch-revalidate', 'nonce-revalidate');
    await publishLocal(env);
    await runTick(env);
    const second = await runTick(env);
    const outcomes = (schedulerResult(second).fleetNudge as Record<string, unknown>).outcomes as Array<Record<string, unknown>>;
    expect(outcomes.some((row) => row.outcome === 'revalidation_failed')).toBe(true);
    expect(fixture(fixturePath).dispatches).toHaveLength(0);
    expect(handoff(env)?.reason).toBe('target_stale');
  });

  it('fails closed at the process boundary when assignment is missing', async () => {
    const root = makeRoot();
    const fixturePath = path.join(root, 'fixture.json');
    const epochPath = path.join(root, 'epoch.json');
    const configPath = path.join(root, 'fleet-config.json');
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, livelockTicks: 1 }));
    writeFileSync(fixturePath, JSON.stringify({
      workers: [{ id: 'worker-1', generation: 'generation-1', bindingKey: 'dispatch-1', lines: ['unchanged'], liveness: 'idle' }],
      dispatches: [],
    }));
    writeEpoch(epochPath, 'epoch-missing-assignment', 'nonce-missing-assignment');
    const env = processEnv(root, fixturePath, epochPath, configPath, 'epoch-missing-assignment', 'nonce-missing-assignment');
    await runTick(env);
    await runTick(env);
    expect(fixture(fixturePath).dispatches).toHaveLength(0);
  });

  it('fails closed at the process boundary when the current runtime binding is missing', async () => {
    const root = makeRoot();
    const fixturePath = path.join(root, 'fixture.json');
    const epochPath = path.join(root, 'epoch.json');
    const configPath = path.join(root, 'fleet-config.json');
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, livelockTicks: 1 }));
    writeFileSync(fixturePath, JSON.stringify({
      workers: [{ id: 'worker-1', generation: 'generation-1', bindingKey: 'dispatch-other', lines: ['unchanged'], liveness: 'idle' }],
      dispatches: [], sendCalls: 0,
    }));
    writeEpoch(epochPath, 'epoch-missing-runtime', 'nonce-missing-runtime');
    const env = processEnv(root, fixturePath, epochPath, configPath, 'epoch-missing-runtime', 'nonce-missing-runtime');
    await publishLocal(env, 'dispatch-1');
    const first = await runTick(env);
    expect(schedulerResult(first).orchestratorRequired).toBe(true);
    expect(handoff(env)).toMatchObject({
      reason: 'target_unresolved',
      decision: 'orchestrator_required',
      issueNumber: 1420,
      taskId: 'task-1420',
    });
    await runTick(env);
    expect(fixture(fixturePath).sendCalls).toBe(0);
    expect(fixture(fixturePath).dispatches).toHaveLength(0);
  });

  it('does not restore stale S1 authority after assignment generation advances', async () => {
    const root = makeRoot();
    const fixturePath = path.join(root, 'fixture.json');
    const epochPath = path.join(root, 'epoch.json');
    const configPath = path.join(root, 'fleet-config.json');
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, livelockTicks: 1 }));
    writeFileSync(fixturePath, JSON.stringify({
      workers: [{ id: 'worker-1', generation: 'generation-1', bindingKey: 'dispatch-1', lines: ['unchanged'], liveness: 'busy' }],
      dispatches: [],
    }));
    writeEpoch(epochPath, 'epoch-stale-assignment', 'nonce-stale-assignment');
    const env = processEnv(root, fixturePath, epochPath, configPath, 'epoch-stale-assignment', 'nonce-stale-assignment');
    await publishLocal(env, 'dispatch-1', 'task-1');
    await runTick(env);
    await publishLocal(env, 'dispatch-2', 'task-2');
    await runTick(env);
    expect(fixture(fixturePath).dispatches).toHaveLength(0);
  });

  it('fails closed after corrupt persisted S1 continuity instead of sending from it', async () => {
    const root = makeRoot();
    const fixturePath = path.join(root, 'fixture.json');
    const epochPath = path.join(root, 'epoch.json');
    const configPath = path.join(root, 'fleet-config.json');
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, livelockTicks: 1 }));
    writeFileSync(fixturePath, JSON.stringify({
      workers: [{ id: 'worker-1', generation: 'generation-1', bindingKey: 'dispatch-1', lines: ['unchanged'], liveness: 'busy' }],
      dispatches: [],
    }));
    writeEpoch(epochPath, 'epoch-corrupt-continuity', 'nonce-corrupt-continuity');
    const env = processEnv(root, fixturePath, epochPath, configPath, 'epoch-corrupt-continuity', 'nonce-corrupt-continuity');
    await publishLocal(env);
    const first = await runTick(env);
    const snapshotPath = path.join(String(env.OPK_SIDE_PROCESS_STATE_DIR), 'fleet-observer-snapshot.json');
    writeFileSync(snapshotPath, '{not-json', 'utf8');
    const second = await runTick(env);
    expect(observerResult(second).schedulerGeneration).not.toBe(observerResult(first).schedulerGeneration);
    expect(fixture(fixturePath).dispatches).toHaveLength(0);
  });

  it('keeps remote assignments outside local S1/S2 actuation and escalates them durably', async () => {
    const root = makeRoot();
    const fixturePath = path.join(root, 'fixture.json');
    const epochPath = path.join(root, 'epoch.json');
    const configPath = path.join(root, 'fleet-config.json');
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, livelockTicks: 1 }));
    writeFileSync(fixturePath, JSON.stringify({
      workers: [{ id: 'worker-1', generation: 'generation-1', bindingKey: 'dispatch-1', lines: ['unchanged'], liveness: 'idle' }],
      dispatches: [], sendCalls: 0,
    }));
    writeEpoch(epochPath, 'epoch-remote', 'nonce-remote');
    const env = processEnv(root, fixturePath, epochPath, configPath, 'epoch-remote', 'nonce-remote');
    expect((await publishCurrentWorkerAssignment({
      file: resolveWorkerAssignmentStorePath('orchestrator-pack', env),
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1420,
      taskId: 'task-remote',
      kind: 'remote',
      provider: 'orca',
      bindingKey: 'dispatch-1',
    })).ok).toBe(true);
    const first = await runTick(env);
    expect(schedulerResult(first).orchestratorRequired).toBe(true);
    expect(handoff(env)).toMatchObject({
      reason: 'remote_not_applicable',
      decision: 'orchestrator_required',
      issueNumber: 1420,
      taskId: 'task-remote',
    });
    await runTick(env);
    expect(fixture(fixturePath).sendCalls).toBe(0);
    expect(fixture(fixturePath).dispatches).toHaveLength(0);
  });

  it('persists observer_untrusted handoff and returns non-success for an empty-census S1 failure', async () => {
    const root = makeRoot();
    const fixturePath = path.join(root, 'fixture.json');
    const epochPath = path.join(root, 'epoch.json');
    const configPath = path.join(root, 'fleet-config.json');
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 999 }));
    writeFileSync(fixturePath, JSON.stringify({ workers: [], dispatches: [] }));
    writeEpoch(epochPath, 'epoch-s1-failed', 'nonce-s1-failed');
    const env = processEnv(root, fixturePath, epochPath, configPath, 'epoch-s1-failed', 'nonce-s1-failed');
    await publishLocal(env);
    const error = await runTickFailure(env);
    expect(error).toContain('scheduler_fleet_phase_failed:observer-untrusted');
    expect(handoff(env)).toMatchObject({ reason: 'observer_untrusted', decision: 'orchestrator_required' });
  });

  it('persists effect_untrusted handoff and returns non-success when post-send journal settlement fails', async () => {
    const root = makeRoot();
    const fixturePath = path.join(root, 'fixture.json');
    const epochPath = path.join(root, 'epoch.json');
    const configPath = path.join(root, 'fleet-config.json');
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, livelockTicks: 1 }));
    writeFileSync(fixturePath, JSON.stringify({
      workers: [{ id: 'worker-1', generation: 'generation-1', bindingKey: 'dispatch-1', lines: ['unchanged'], liveness: 'busy' }],
      corruptJournalAfterSend: true,
      dispatches: [],
    }));
    writeEpoch(epochPath, 'epoch-settlement', 'nonce-settlement');
    const env = processEnv(root, fixturePath, epochPath, configPath, 'epoch-settlement', 'nonce-settlement');
    await publishLocal(env);
    await runTick(env);
    const error = await runTickFailure(env);
    expect(error).toContain('scheduler_fleet_phase_failed:one-budgeted-gated-nudge-per-new-eligible-episode');
    expect(fixture(fixturePath).dispatches).toHaveLength(1);
    expect(handoff(env)).toMatchObject({ reason: 'effect_untrusted', decision: 'orchestrator_required' });
  });

  it.each([
    ['observer_timeout', () => new Promise<never>(() => {})],
    ['observer_threw', async () => { throw new Error('injected'); }],
  ] as const)('does not turn %s into a successful scheduler tick', async (expectedReason, tick) => {
    const root = makeRoot();
    const epochPath = path.join(root, 'epoch.json');
    writeEpoch(epochPath, `epoch-${expectedReason}`, `nonce-${expectedReason}`);
    const env: NodeJS.ProcessEnv = {
      ORCHESTRATOR_CUTOVER_EPOCH_AUTHORITY: epochPath,
      ORCHESTRATOR_CUTOVER_EPOCH_ID: `epoch-${expectedReason}`,
      ORCHESTRATOR_CUTOVER_NONCE: `nonce-${expectedReason}`,
    };
    const handoffs: Array<{ reason: string; schedulerGeneration: string; tickSequence: number }> = [];
    const boundary: SchedulerBoundary = {
      listCandidates: () => [],
      readCurrentPr: async () => { throw new Error('not called'); },
      readChecks: async () => [],
      listReviewRuns: () => [],
      start: async () => ({ ok: true }),
      schedulerIntervalMs: 40,
      fleetObserver: {
        schedulerGeneration: `sg-${expectedReason}`,
        getEffectiveBudgetMs: () => expectedReason === 'observer_timeout' ? 10 : 100,
        tick,
      },
      publishHandoff: (record) => {
        handoffs.push(record);
        return { ok: true };
      },
    };
    await expect(runSchedulerTick(boundary, env)).rejects.toThrow(`scheduler_observer_untrusted:${expectedReason}`);
    expect(handoffs).toEqual([{
      reason: 'observer_untrusted',
      schedulerGeneration: `sg-${expectedReason}`,
      tickSequence: 1,
    }]);
  });
});
