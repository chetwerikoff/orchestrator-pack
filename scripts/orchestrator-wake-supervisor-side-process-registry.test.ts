import {
  describe,
  expect,
  fs,
  isAlive,
  issue205TimeoutMs,
  it,
  makeStateDir,
  managedChildRoles,
  path,
  readMarker,
  repoRoot,
  runSupervisor,
  startSupervisorBackground,
  waitForMarkerPidChange,
  waitForMarkers,
  fixedObservationWindow,
} from './orchestrator-wake-supervisor.shared.js';

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
    await waitForMarkers(stateDir, 25_000, ['review-trigger-reconcile', 'escalation-router']);

    const first = await readMarker(stateDir, 'review-trigger-reconcile');
    const escalationRouterBefore = await readMarker(stateDir, 'escalation-router');
    await waitForMarkerPidChange(stateDir, 'review-trigger-reconcile', first.pid, 25_000);
    expect(isAlive(escalationRouterBefore.pid)).toBe(true);
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
    const pidAtWindowStart = first.pid;
    await fixedObservationWindow(6000);
    const current = await readMarker(stateDir, 'ci-green-wake-reconcile');
    expect(current.pid).toBe(pidAtWindowStart);
    expect(isAlive(current.pid)).toBe(true);
    runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
    },
    issue205TimeoutMs,
  );
});
