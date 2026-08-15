import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcess } from '../kernel/subprocess.ts';
import {
  publishCurrentWorkerAssignment,
  resolveWorkerAssignmentStorePath,
} from '../lib/worker-assignment-store.ts';

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
  worktreePath: process.cwd(),
  title: 'fixture-' + worker.id,
  status: worker.liveness === 'gone' ? 'exited' : 'running',
});
if (!fixturePath) process.exit(2);
switch (operation) {
  case 'worktree current':
    out({ ok: true, result: { worktree: { path: process.cwd(), head: 'a'.repeat(40), linkedIssue: null } } });
    break;
  case 'terminal list':
    out({ ok: true, result: { terminals: state.workers.filter((worker) => worker.liveness !== 'gone').map(terminal) } });
    break;
  case 'terminal show': {
    const worker = state.workers.find((candidate) => candidate.id === get('--terminal') && candidate.liveness !== 'gone');
    out(worker
      ? { ok: true, result: { terminal: terminal(worker) } }
      : { ok: false, error: { code: 'terminal_not_found', message: 'terminal not found' } });
    break;
  }
  case 'orchestration worker-show': {
    const dispatch = get('--dispatch');
    const matches = state.workers.filter((candidate) => candidate.bindingKey === dispatch && candidate.liveness !== 'gone');
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

async function runTick(env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const result = await runProcess({
    command: process.execPath,
    args: [path.resolve('scripts/pr2-foundation/scheduler.ts'), 'tick'],
    cwd: process.cwd(),
    env,
    inheritParentEnv: false,
    allowEmptyStdout: false,
    timeoutMs: 30_000,
  });
  expect(result.ok, result.stderr || result.stdout || result.error).toBe(true);
  const line = result.stdout.trim().split(/\r?\n/u).at(-1) ?? '';
  expect(line).not.toBe('');
  return JSON.parse(line) as Record<string, unknown>;
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
  workers: Array<{ id: string; generation: string; bindingKey: string; lines: string[]; liveness: string }>;
  dispatchOutcome?: string;
  dispatches?: Array<{ workerId: string; message: string }>;
}

function fixture(file: string): FixtureState {
  return JSON.parse(readFileSync(file, 'utf8')) as FixtureState;
}

function processEnv(root: string, fixturePath: string, epochPath: string, configPath: string, epochId: string, nonce: string): NodeJS.ProcessEnv {
  installOrcaFixture(root);
  return {
    ...process.env,
    PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}`,
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

describe('scheduler bounded-child production composition', () => {
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
    const assignment = await publishCurrentWorkerAssignment({
      file: resolveWorkerAssignmentStorePath('orchestrator-pack', env),
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1420,
      taskId: 'task-1420',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'dispatch-1',
    });
    expect(assignment.ok).toBe(true);

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
    expect((await publishCurrentWorkerAssignment({
      file: resolveWorkerAssignmentStorePath('orchestrator-pack', baseEnv), repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1420, taskId: 'task-1420', kind: 'local', provider: 'orca', bindingKey: 'dispatch-1',
    })).ok).toBe(true);
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
    expect((await publishCurrentWorkerAssignment({
      file: resolveWorkerAssignmentStorePath('orchestrator-pack', env), repository: 'chetwerikoff/orchestrator-pack', issueNumber: 1420,
      taskId: 'task-1420', kind: 'local', provider: 'orca', bindingKey: 'dispatch-1',
    })).ok).toBe(true);
    await runTick(env);
    const second = await runTick(env);
    const third = await runTick(env);
    const secondOutcomes = (schedulerResult(second).fleetNudge as Record<string, unknown>).outcomes as Array<Record<string, unknown>>;
    expect(secondOutcomes.some((row) => row.outcome === 'dispatch_unknown')).toBe(true);
    const thirdNudge = schedulerResult(third).fleetNudge as Record<string, unknown>;
    expect(thirdNudge.sendAttempts).toBe(0);
    expect(fixture(fixturePath).dispatches).toHaveLength(0);
  });
});
