import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupSupervisorTests,
  fixtureDir,
  isAlive,
  makeStateDir,
  managedChildRoles,
  readMarker,
  repoRoot,
  runSupervisor,
  startSupervisorBackground,
  supervisorScript,
  waitForMarkers,
  waitForSupervisorHealthyStatus,
  waitForProcessesStopped,
  type ManagedChildRole,
  type WakeMarker,
} from './supervisor-recovery.test-helpers.js';

const aoStub = path.join(fixtureDir, 'ao-stub.sh');
const supervisorHookTimeoutMs = 120_000;

afterEach(() => {
  cleanupSupervisorTests();
}, supervisorHookTimeoutMs);

const detachedSupervisorTimeoutMs = 60_000;

describe('Issue #205 side-process registry', () => {
  const issue205TimeoutMs = 60_000;
  it('registry JSON lists all required managed children', () => {
    const registryPath = path.join(repoRoot, 'scripts/orchestrator-side-process-registry.json');
    const doc = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as {
      requiredChildIds: string[];
      children: { id: string; sideEffecting?: boolean; sideEffectLockFile?: string }[];
    };
    for (const id of managedChildRoles) {
      expect(doc.requiredChildIds).toContain(id);
      expect(doc.children.some((c) => c.id === id)).toBe(true);
    }
    const listener = doc.children.find((c) => c.id === 'listener');
    expect(listener?.sideEffecting).toBe(true);
    expect(listener?.sideEffectLockFile).toBe('listener-side-effect.lock');
  });

  it(
    'recovers a hung test child without restarting idle siblings',
    async () => {
    const stateDir = makeStateDir();
    const start = runSupervisor(
      [
        '-Action',
        'Start',
        '-TestMode',
        '-SkipInitialWait',
        '-OrchestratorSessionId',
        'op-stall-test',
        '-StateDir',
        stateDir,
        '-PollSeconds',
        '1',
      ],
      {
        AO_WAKE_SUPERVISOR_TEST_MODE_review_trigger_reconcile: 'hang',
        AO_WAKE_SUPERVISOR_TEST_STALL_SECONDS_review_trigger_reconcile: '5',
      },
    );
    expect(start.status).toBe(0);
    await waitForMarkers(stateDir, 25_000, ['review-trigger-reconcile', 'heartbeat']);

    const first = await readMarker(stateDir, 'review-trigger-reconcile');
    const heartbeatBefore = await readMarker(stateDir, 'heartbeat');
    const deadline = Date.now() + 25_000;
    let recovered = false;
    while (Date.now() < deadline) {
      const current = await readMarker(stateDir, 'review-trigger-reconcile');
      if (current.pid !== first.pid && isAlive(current.pid)) {
        recovered = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(recovered).toBe(true);
    expect(isAlive(heartbeatBefore.pid)).toBe(true);
    runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
    },
    issue205TimeoutMs,
  );

  it(
    'does not restart a child that is merely slow on a side effect',
    async () => {
    const stateDir = makeStateDir();
    const start = runSupervisor(
      [
        '-Action',
        'Start',
        '-TestMode',
        '-SkipInitialWait',
        '-OrchestratorSessionId',
        'op-slow-side-effect',
        '-StateDir',
        stateDir,
        '-PollSeconds',
        '1',
      ],
      { AO_WAKE_SUPERVISOR_TEST_MODE_ci_green_wake_reconcile: 'slow-side-effect' },
    );
    expect(start.status).toBe(0);
    await waitForMarkers(stateDir, 25_000, ['ci-green-wake-reconcile']);

    const first = await readMarker(stateDir, 'ci-green-wake-reconcile');
    await new Promise((resolve) => setTimeout(resolve, 6000));
    const current = await readMarker(stateDir, 'ci-green-wake-reconcile');
    expect(current.pid).toBe(first.pid);
    expect(isAlive(current.pid)).toBe(true);
    runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
    },
    issue205TimeoutMs,
  );
});
