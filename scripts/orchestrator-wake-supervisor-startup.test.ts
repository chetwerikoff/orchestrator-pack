import {
  aoStub,
  describe,
  expect,
  fixtureDir,
  fs,
  it,
  isAlive,
  makeStateDir,
  managedChildRoles,
  path,
  readMarker,
  repoRoot,
  runSupervisor,
  spawn,
  spawnSync,
  startSupervisorBackground,
  supervisorScript,
  waitForCondition,
  waitForMarkerPidChange,
  waitForMarkers,
  waitForSupervisorLogMatch,
  fixedObservationWindow,
} from './orchestrator-wake-supervisor.shared.js';

const genericChildRole = 'review-trigger-reconcile' as const;
const sessionBoundRole = 'escalation-router' as const;

describe('orchestrator-wake-supervisor', () => {
  it('starts every registry-defined managed child as a separate process', async () => {
    const stateDir = makeStateDir();
    const child = startSupervisorBackground(stateDir, [
      '-OrchestratorSessionId',
      'op-test-override',
    ]);
    await waitForMarkers(stateDir);

    const markers = await Promise.all(managedChildRoles.map((role) => readMarker(stateDir, role)));
    const pids = new Set(markers.map((marker) => marker.pid));
    expect(pids.size).toBe(managedChildRoles.length);
    const router = markers.find((marker) => marker.role === sessionBoundRole);
    expect(router?.orchestratorSessionId).toBe('op-test-override');
    child.kill('SIGTERM');
  });

  it('prepends pack scripts in wake-supervisor child environment', () => {
    const supervisorLib = path.join(repoRoot, 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1');
    const result = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `. '${supervisorLib.replace(/'/g, "''")}'; $stateRoot = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString()); New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null; $paths = Get-OrchestratorWakeSupervisorPaths -StateRoot $stateRoot; $entry = Get-OrchestratorWakeSupervisorChildEntry -ChildId 'review-trigger-reconcile'; $envMap = New-OrchestratorWakeSupervisorChildEnvironment -Paths $paths -Entry $entry -ChildId 'review-trigger-reconcile' -OrchestratorSessionId 'op-test' -ProjectId 'orchestrator-pack'; $pack = Get-OrchestratorSideProcessPackScriptsDir; $head = ($envMap['PATH'] -split [IO.Path]::PathSeparator)[0]; if ($head -ne $pack) { exit 1 }; if ($envMap['GH_FLEET_CACHE_AUDIT'] -ne '1') { exit 3 }; if ($envMap['GH_WRAPPER_AUDIT'] -ne '1') { exit 4 }; if ($envMap['AO_SIDE_PROCESS_CHILD_ID'] -ne 'review-trigger-reconcile') { exit 5 }; $savedPath = $env:PATH; $env:PATH = $envMap['PATH']; try { $gh = (Get-Command gh -ErrorAction Stop).Source; if ($gh -ne (Join-Path $pack 'gh')) { exit 2 } } finally { $env:PATH = $savedPath }; exit 0`,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
  });

  it('resolves the orchestrator session id for the session-bound router', async () => {
    const stateDir = makeStateDir();
    const statusFixture = path.join(fixtureDir, 'status-orchestrator-op-old.json');
    const child = startSupervisorBackground(stateDir, ['-FixturePath', statusFixture]);
    await waitForMarkers(stateDir);

    const router = await readMarker(stateDir, sessionBoundRole);
    expect(router.orchestratorSessionId).toBe('op-orchestrator-old');
    child.kill('SIGTERM');
  });

  it('passes supervisor ProjectId to surviving children', async () => {
    const stateDir = makeStateDir();
    const child = startSupervisorBackground(stateDir, [
      '-OrchestratorSessionId',
      'op-project-pass',
      '-ProjectId',
      'custom-ao-project',
    ]);
    await waitForMarkers(stateDir);

    const marker = await readMarker(stateDir, genericChildRole);
    expect(marker.projectId).toBe('custom-ao-project');
    child.kill('SIGTERM');
  });

  it('restarts a surviving child after it exits', async () => {
    const stateDir = makeStateDir();
    const child = startSupervisorBackground(stateDir, ['-OrchestratorSessionId', 'op-restart'], {
      AO_WAKE_SUPERVISOR_RESTART_STAGGER_MS: '0',
      AO_WAKE_SUPERVISOR_ID_DEBOUNCE_POLLS: '1',
      AO_WAKE_SUPERVISOR_SESSION_GLITCH_POLLS: '1',
      AO_WAKE_SUPERVISOR_CRASH_MAX_RAPID_EXITS: '99',
      AO_WAKE_SUPERVISOR_CRASH_TERMINAL_RAPID_EXITS: '99',
      AO_WAKE_SUPERVISOR_TEST_MODE_review_trigger_reconcile: 'instant-exit',
    });
    await waitForMarkers(stateDir, 25_000, [genericChildRole, sessionBoundRole]);

    const first = await readMarker(stateDir, genericChildRole);
    await waitForMarkerPidChange(stateDir, genericChildRole, first.pid, 90_000);
    child.kill('SIGTERM');
  }, 120_000);

  it('does not share fate between surviving children', async () => {
    const stateDir = makeStateDir();
    const child = startSupervisorBackground(stateDir, [
      '-OrchestratorSessionId',
      'op-independent',
    ]);
    await waitForMarkers(stateDir, 25_000, [genericChildRole, sessionBoundRole]);

    const generic = await readMarker(stateDir, genericChildRole);
    const router = await readMarker(stateDir, sessionBoundRole);
    const routerPidAtKill = router.pid;
    if (isAlive(generic.pid)) {
      process.kill(generic.pid, 'SIGKILL');
    }
    await fixedObservationWindow(2000);
    expect(isAlive(routerPidAtKill)).toBe(true);
    child.kill('SIGTERM');
  });

  it('waits when no orchestrator session exists, then starts the fleet', async () => {
    const stateDir = makeStateDir();
    const dynamicFixture = path.join(stateDir, 'ao-status.json');
    fs.writeFileSync(dynamicFixture, fs.readFileSync(path.join(fixtureDir, 'status-no-orchestrator.json')));

    const child = spawn(
      'pwsh',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        supervisorScript,
        '-Action',
        'Start',
        '-Foreground',
        '-TestMode',
        '-StateDir',
        stateDir,
        '-FixturePath',
        dynamicFixture,
        '-PollSeconds',
        '1',
        '-WaitSeconds',
        '15',
        '-MaxLoopSeconds',
        '12',
      ],
      {
        cwd: repoRoot,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    await waitForSupervisorLogMatch(stateDir, /waiting for orchestrator session/, 8_000);
    expect(stdout).toContain('waiting for orchestrator session');

    fs.writeFileSync(
      dynamicFixture,
      fs.readFileSync(path.join(fixtureDir, 'status-orchestrator-op-old.json')),
    );

    await waitForCondition(
      async () => {
        try {
          const router = await readMarker(stateDir, sessionBoundRole, 500);
          return router.orchestratorSessionId === 'op-orchestrator-old';
        } catch {
          return false;
        }
      },
      10_000,
      300,
      'session-bound child to start after orchestrator appears',
    );

    child.kill('SIGTERM');
    const router = await readMarker(stateDir, sessionBoundRole);
    expect(router.orchestratorSessionId).toBe('op-orchestrator-old');
  });

  it('exits with an actionable message when no orchestrator session appears within bound', () => {
    const stateDir = makeStateDir();
    const statusFixture = path.join(fixtureDir, 'status-no-orchestrator.json');
    const run = runSupervisor(
      [
        '-Action',
        'Start',
        '-TestMode',
        '-StateDir',
        stateDir,
        '-FixturePath',
        statusFixture,
        '-AoCommand',
        aoStub,
        '-WaitSeconds',
        '2',
        '-PollSeconds',
        '1',
      ],
      { AO_WAKE_SUPERVISOR_FIXTURE: statusFixture },
    );
    expect(run.status).not.toBe(0);
    const combined = `${run.stdout}\n${run.stderr}`;
    expect(combined).toContain('orchestrator-pack');
    expect(combined).toMatch(/orchestrator session exists/i);
  });

  it('restarts the session-bound router when orchestrator session id changes', async () => {
    const stateDir = makeStateDir();
    const dynamicFixture = path.join(stateDir, 'ao-status.json');
    fs.writeFileSync(
      dynamicFixture,
      fs.readFileSync(path.join(fixtureDir, 'status-orchestrator-op-old.json')),
    );

    const child = startSupervisorBackground(stateDir, ['-FixturePath', dynamicFixture], {
      AO_WAKE_SUPERVISOR_ID_DEBOUNCE_POLLS: '1',
    });
    await waitForMarkers(stateDir);

    const oldRouter = await readMarker(stateDir, sessionBoundRole);
    fs.writeFileSync(
      dynamicFixture,
      fs.readFileSync(path.join(fixtureDir, 'status-orchestrator-op-new.json')),
    );

    await waitForCondition(
      async () => {
        try {
          const router = await readMarker(stateDir, sessionBoundRole, 500);
          return (
            router.orchestratorSessionId === 'op-orchestrator-new' &&
            router.pid !== oldRouter.pid
          );
        } catch {
          return false;
        }
      },
      90_000,
      500,
      'session-bound router restart on orchestrator change',
    );
    const newRouter = await readMarker(stateDir, sessionBoundRole);
    expect(newRouter.orchestratorSessionId).toBe('op-orchestrator-new');
    expect(newRouter.pid).not.toBe(oldRouter.pid);
    child.kill('SIGTERM');
  }, 120_000);
});
