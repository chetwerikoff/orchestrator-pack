import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
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

function runTick(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const result = spawnSync(
    process.execPath,
    [path.resolve('scripts/pr2-foundation/scheduler.ts'), 'tick'],
    { cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000 },
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
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

function fixture(file: string): {
  workers: Array<{ id: string; generation: string; bindingKey: string; lines: string[]; liveness: string }>;
  dispatchOutcome?: string;
  dispatches?: Array<{ workerId: string; message: string }>;
} {
  return JSON.parse(readFileSync(file, 'utf8')) as ReturnType<typeof fixture>;
}

describe('scheduler bounded-child production composition', () => {
  it('restores one S1 lineage across separate child processes and dispatches one existing S2 episode', () => {
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

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPK_VITEST_HARNESS: '1',
      OPK_RUNTIME_ADAPTER: 'process-fixture',
      OPK_PROCESS_FIXTURE_PATH: fixturePath,
      OPK_BASE_DIR: path.join(root, 'opk'),
      OPK_SIDE_PROCESS_STATE_DIR: path.join(root, 'side-state'),
      OPK_WORKER_NUDGE_CLAIM_DIR: path.join(root, 'claims'),
      OPK_WORKER_MESSAGE_DISPATCH_JOURNAL: path.join(root, 'dispatch-journal.json'),
      OPK_REPOSITORY: 'chetwerikoff/orchestrator-pack',
      OPK_FLEET_OBSERVER_CONFIG: configPath,
      ORCHESTRATOR_CUTOVER_EPOCH_AUTHORITY: epochPath,
      ORCHESTRATOR_CUTOVER_EPOCH_ID: 'epoch-1420',
      ORCHESTRATOR_CUTOVER_NONCE: 'nonce-1420',
    };
    const assignment = publishCurrentWorkerAssignment({
      file: resolveWorkerAssignmentStorePath('orchestrator-pack', env),
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1420,
      taskId: 'task-1420',
      kind: 'local',
      provider: 'process-fixture',
      bindingKey: 'dispatch-1',
    });
    expect(assignment.ok).toBe(true);

    const first = runTick(env);
    const second = runTick(env);
    const afterSecond = fixture(fixturePath);
    expect(afterSecond.dispatches).toHaveLength(1);
    const third = runTick(env);
    const afterThird = fixture(fixturePath);
    expect(afterThird.dispatches).toHaveLength(1);

    const firstObserver = observerResult(first);
    const secondObserver = observerResult(second);
    const thirdObserver = observerResult(third);
    expect(firstObserver.schedulerGeneration).toBe(secondObserver.schedulerGeneration);
    expect(secondObserver.schedulerGeneration).toBe(thirdObserver.schedulerGeneration);
    expect([firstObserver.tickSequence, secondObserver.tickSequence, thirdObserver.tickSequence]).toEqual([1, 2, 3]);

    const secondScheduler = schedulerResult(second);
    const secondNudge = secondScheduler.fleetNudge as Record<string, unknown>;
    expect(secondNudge.dispatched).toBe(1);
    expect(secondNudge.sendAttempts).toBe(1);
    const thirdNudge = schedulerResult(third).fleetNudge as Record<string, unknown>;
    expect(thirdNudge.dispatched).toBe(0);
  });

  it('starts a fresh baseline after an activation epoch change', () => {
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
    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      OPK_VITEST_HARNESS: '1', OPK_RUNTIME_ADAPTER: 'process-fixture', OPK_PROCESS_FIXTURE_PATH: fixturePath,
      OPK_BASE_DIR: path.join(root, 'opk'), OPK_SIDE_PROCESS_STATE_DIR: path.join(root, 'side-state'),
      OPK_WORKER_NUDGE_CLAIM_DIR: path.join(root, 'claims'), OPK_WORKER_MESSAGE_DISPATCH_JOURNAL: path.join(root, 'journal.json'),
      OPK_REPOSITORY: 'chetwerikoff/orchestrator-pack', OPK_FLEET_OBSERVER_CONFIG: configPath,
      ORCHESTRATOR_CUTOVER_EPOCH_AUTHORITY: epochPath, ORCHESTRATOR_CUTOVER_EPOCH_ID: 'epoch-a', ORCHESTRATOR_CUTOVER_NONCE: 'nonce-a',
    };
    expect(publishCurrentWorkerAssignment({
      file: resolveWorkerAssignmentStorePath('orchestrator-pack', baseEnv), repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1420, taskId: 'task-1420', kind: 'local', provider: 'process-fixture', bindingKey: 'dispatch-1',
    }).ok).toBe(true);
    const first = runTick(baseEnv);

    writeEpoch(epochPath, 'epoch-b', 'nonce-b');
    const changedEnv = { ...baseEnv, ORCHESTRATOR_CUTOVER_EPOCH_ID: 'epoch-b', ORCHESTRATOR_CUTOVER_NONCE: 'nonce-b' };
    const second = runTick(changedEnv);
    expect(observerResult(second).schedulerGeneration).not.toBe(observerResult(first).schedulerGeneration);
    expect(observerResult(second).tickSequence).toBe(1);
    expect(fixture(fixturePath).dispatches).toHaveLength(0);
  });

  it('preserves dispatch_unknown without automatic retry in a later child', () => {
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
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPK_VITEST_HARNESS: '1', OPK_RUNTIME_ADAPTER: 'process-fixture', OPK_PROCESS_FIXTURE_PATH: fixturePath,
      OPK_BASE_DIR: path.join(root, 'opk'), OPK_SIDE_PROCESS_STATE_DIR: path.join(root, 'side'),
      OPK_WORKER_NUDGE_CLAIM_DIR: path.join(root, 'claims'), OPK_WORKER_MESSAGE_DISPATCH_JOURNAL: path.join(root, 'journal.json'),
      OPK_REPOSITORY: 'chetwerikoff/orchestrator-pack', OPK_FLEET_OBSERVER_CONFIG: configPath,
      ORCHESTRATOR_CUTOVER_EPOCH_AUTHORITY: epochPath, ORCHESTRATOR_CUTOVER_EPOCH_ID: 'epoch-unknown', ORCHESTRATOR_CUTOVER_NONCE: 'nonce-unknown',
    };
    expect(publishCurrentWorkerAssignment({
      file: resolveWorkerAssignmentStorePath('orchestrator-pack', env), repository: 'chetwerikoff/orchestrator-pack', issueNumber: 1420,
      taskId: 'task-1420', kind: 'local', provider: 'process-fixture', bindingKey: 'dispatch-1',
    }).ok).toBe(true);
    runTick(env);
    const second = runTick(env);
    const third = runTick(env);
    const secondOutcomes = ((schedulerResult(second).fleetNudge as Record<string, unknown>).outcomes as Array<Record<string, unknown>>);
    expect(secondOutcomes.some((row) => row.outcome === 'dispatch_unknown')).toBe(true);
    const thirdNudge = schedulerResult(third).fleetNudge as Record<string, unknown>;
    expect(thirdNudge.sendAttempts).toBe(0);
    expect(fixture(fixturePath).dispatches).toHaveLength(0);
  });
});
