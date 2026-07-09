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
  waitForCondition,
  readSupervisorLog,
  repoRoot,
  runSupervisor,
  spawn,
  spawnSync,
  startSupervisorBackground,
  supervisorScript,
  waitForMarkerPidChange,
  waitForMarkers,
  fixedObservationWindow,
  sleepMs,
  type WakeMarker,
} from './orchestrator-wake-supervisor.shared.js';

describe('orchestrator-wake-supervisor', () => {
  it('starts all registered managed children as separate processes', async () => {
    const stateDir = makeStateDir();
    const child = startSupervisorBackground(stateDir, [
      '-OrchestratorSessionId',
      'op-test-override',
    ]);
    await waitForMarkers(stateDir);

    const markers = await Promise.all(managedChildRoles.map((role) => readMarker(stateDir, role)));
    const pids = new Set(markers.map((m) => m.pid));
    expect(pids.size).toBe(managedChildRoles.length);
    for (const marker of markers) {
      if (marker.role === 'listener' || marker.role === 'heartbeat') {
        expect(marker.orchestratorSessionId).toBe('op-test-override');
      }
    }
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

  it('resolves orchestrator session id from orchestrator ls when override unset', async () => {
    const stateDir = makeStateDir();
    const statusFixture = path.join(fixtureDir, 'status-orchestrator-op-old.json');
    const child = startSupervisorBackground(stateDir, ['-FixturePath', statusFixture]);
    await waitForMarkers(stateDir);

    const listener = await readMarker(stateDir, 'listener');
    expect(listener.orchestratorSessionId).toBe('op-orchestrator-old');
    child.kill('SIGTERM');
  });

  it('passes supervisor ProjectId to listener child', async () => {
    const stateDir = makeStateDir();
    const child = startSupervisorBackground(stateDir, [
      '-OrchestratorSessionId',
      'op-listener-project-pass',
      '-ProjectId',
      'custom-ao-project',
    ]);
    await waitForMarkers(stateDir);

    const listener = await readMarker(stateDir, 'listener');
    expect(listener.projectId).toBe('custom-ao-project');
    child.kill('SIGTERM');
  });

  it('restarts a child after it exits', async () => {
    const stateDir = makeStateDir();
    const child = startSupervisorBackground(stateDir, ['-OrchestratorSessionId', 'op-restart']);
    await waitForMarkers(stateDir);

    const first = await readMarker(stateDir, 'listener');
    if (isAlive(first.pid)) {
      process.kill(first.pid, 'SIGKILL');
    }
    await waitForMarkerPidChange(stateDir, 'listener', first.pid, 10_000);
    child.kill('SIGTERM');
  });

  it('does not share fate between listener and heartbeat', async () => {
    const stateDir = makeStateDir();
    const child = startSupervisorBackground(stateDir, [
      '-OrchestratorSessionId',
      'op-independent',
    ]);
    await waitForMarkers(stateDir);

    const listener = await readMarker(stateDir, 'listener');
    const heartbeat = await readMarker(stateDir, 'heartbeat');
    const heartbeatPidAtKill = heartbeat.pid;
    if (isAlive(listener.pid)) {
      process.kill(listener.pid, 'SIGKILL');
    }
    await fixedObservationWindow(2000);
    expect(isAlive(heartbeatPidAtKill)).toBe(true);
    child.kill('SIGTERM');
  });

  it('waits when no orchestrator session then starts children when one appears', async () => {
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

    const logGenerationStart = readSupervisorLog(stateDir).length;
    await waitForCondition(
      () =>
        stdout.includes('waiting for orchestrator session') ||
        /waiting for orchestrator session/.test(readSupervisorLog(stateDir).slice(logGenerationStart)),
      1500,
      undefined,
      'orchestrator session wait log or stdout',
    );
    expect(
      stdout.includes('waiting for orchestrator session') ||
        /waiting for orchestrator session/.test(readSupervisorLog(stateDir).slice(logGenerationStart)),
    ).toBe(true);

    fs.writeFileSync(
      dynamicFixture,
      fs.readFileSync(path.join(fixtureDir, 'status-orchestrator-op-old.json')),
    );

    const deadline = Date.now() + 10_000;
    let listener: WakeMarker | null = null;
    while (Date.now() < deadline) {
      try {
        listener = await readMarker(stateDir, 'listener');
        if (listener.orchestratorSessionId === 'op-orchestrator-old') break;
      } catch {
        // not ready yet
      }
      await sleepMs(300);
    }

    child.kill('SIGTERM');
    expect(listener?.orchestratorSessionId).toBe('op-orchestrator-old');
  });

  it('exits with actionable message when no orchestrator session appears within bound', () => {
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

  it('restarts both children when orchestrator session id changes', async () => {
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

    const oldListener = await readMarker(stateDir, 'listener');
    fs.writeFileSync(
      dynamicFixture,
      fs.readFileSync(path.join(fixtureDir, 'status-orchestrator-op-new.json')),
    );

    const deadline = Date.now() + 45_000;
    let sawNew = false;
    while (Date.now() < deadline) {
      const listener = await readMarker(stateDir, 'listener');
      const heartbeat = await readMarker(stateDir, 'heartbeat');
      if (
        listener.orchestratorSessionId === 'op-orchestrator-new' &&
        heartbeat.orchestratorSessionId === 'op-orchestrator-new' &&
        listener.pid !== oldListener.pid
      ) {
        sawNew = true;
        break;
      }
      await sleepMs(500);
    }
    expect(sawNew).toBe(true);
    child.kill('SIGTERM');
  });
});
