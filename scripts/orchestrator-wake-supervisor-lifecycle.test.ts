import {
  describe,
  detachedSupervisorTimeoutMs,
  expect,
  fs,
  it,
  isAlive,
  makeStateDir,
  managedChildRoles,
  path,
  readMarker,
  repoRoot,
  runSupervisor,
  startSupervisorBackground,
  waitForMarkers,
  waitForProcessesStopped,
  waitForSupervisorHealthyStatus,
} from './orchestrator-wake-supervisor.shared.js';

describe('orchestrator-wake-supervisor lifecycle', () => {
  it(
    'stops children when orchestrator session disappears at runtime',
    async () => {
    const stateDir = makeStateDir();
    const dynamicFixture = path.join(stateDir, 'ao-status.json');
    fs.writeFileSync(
      dynamicFixture,
      fs.readFileSync(path.join(fixtureDir, 'status-orchestrator-op-old.json')),
    );

    const child = startSupervisorBackground(stateDir, ['-FixturePath', dynamicFixture]);
    await waitForMarkers(stateDir, 25_000, ['listener', 'heartbeat']);

    const listenerBefore = await readMarker(stateDir, 'listener');
    const heartbeatBefore = await readMarker(stateDir, 'heartbeat');
    fs.writeFileSync(
      dynamicFixture,
      fs.readFileSync(path.join(fixtureDir, 'status-no-orchestrator.json')),
    );
    await waitForProcessesStopped([listenerBefore.pid, heartbeatBefore.pid], 25_000);
    expect(isAlive(listenerBefore.pid)).toBe(false);
    expect(isAlive(heartbeatBefore.pid)).toBe(false);
    child.kill('SIGTERM');
    },
    detachedSupervisorTimeoutMs,
  );

  it(
    'reports status and stops both children cleanly',
    async () => {
    const stateDir = makeStateDir();
    const child = startSupervisorBackground(stateDir, [
      '-OrchestratorSessionId',
      'op-status-stop',
    ]);
    await waitForMarkers(stateDir, 25_000, ['listener', 'heartbeat']);

    const statusUp = await waitForSupervisorHealthyStatus(stateDir);
    expect(statusUp.status).toBe(0);
    expect(statusUp.stdout).toContain('supervisor: running');
    expect(statusUp.stdout).toContain('listener:   working');
    expect(statusUp.stdout).toContain('heartbeat:  working');

    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));

    const stop = runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
    expect(stop.status).toBe(0);

    const statusDown = runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
    expect(statusDown.status).not.toBe(0);
    expect(statusDown.stdout).toContain('stopped');
    },
    detachedSupervisorTimeoutMs,
  );

  it(
    'stops supervisor before children so no orphan wake processes remain',
    async () => {
    const stateDir = makeStateDir();
    startSupervisorBackground(stateDir, ['-OrchestratorSessionId', 'op-stop-order']);
    await waitForMarkers(stateDir, 25_000, ['listener', 'heartbeat']);

    const listenerBefore = await readMarker(stateDir, 'listener');
    const heartbeatBefore = await readMarker(stateDir, 'heartbeat');
    expect(isAlive(listenerBefore.pid)).toBe(true);
    expect(isAlive(heartbeatBefore.pid)).toBe(true);

    const stop = runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
    expect(stop.status).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(isAlive(listenerBefore.pid)).toBe(false);
    expect(isAlive(heartbeatBefore.pid)).toBe(false);

    const statusDown = runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
    expect(statusDown.stdout).toContain('stopped');
    },
    detachedSupervisorTimeoutMs,
  );

  it('status exits non-zero when supervisor is stopped but children remain', async () => {
    const stateDir = makeStateDir();
    const child = startSupervisorBackground(stateDir, [
      '-OrchestratorSessionId',
      'op-status-orphan',
    ]);
    await waitForMarkers(stateDir);

    const supervisorPid = Number(
      fs.readFileSync(path.join(stateDir, 'supervisor.pid'), 'utf8').trim(),
    );
    const listener = await readMarker(stateDir, 'listener');
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));

    if (isAlive(supervisorPid)) {
      process.kill(supervisorPid, 'SIGKILL');
    }
    await new Promise((resolve) => setTimeout(resolve, 300));

    if (isAlive(listener.pid)) {
      const statusOrphan = runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
      expect(statusOrphan.status).not.toBe(0);
      expect(statusOrphan.stdout).toContain('supervisor: stopped');
      process.kill(listener.pid, 'SIGKILL');
    }

    runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
  }, detachedSupervisorTimeoutMs);

  it(
    'captures per-child logs and survives launching shell exit when detached',
    async () => {
    const stateDir = makeStateDir();
    const start = runSupervisor([
      '-Action',
      'Start',
      '-TestMode',
      '-SkipInitialWait',
      '-OrchestratorSessionId',
      'op-detached',
      '-StateDir',
      stateDir,
      '-PollSeconds',
      '1',
    ]);
    expect(start.status).toBe(0);
    expect(start.stdout).toContain('supervisor detached');

    const supervisorPid = Number(
      fs.readFileSync(path.join(stateDir, 'supervisor.pid'), 'utf8').trim(),
    );
    expect(supervisorPid).toBeGreaterThan(0);

    const childLogs = managedChildRoles.map((role) => path.join(stateDir, `${role}.log`));
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (childLogs.every((logPath) => fs.existsSync(logPath))) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    for (const logPath of childLogs) {
      expect(fs.existsSync(logPath)).toBe(true);
    }

    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(isAlive(supervisorPid)).toBe(true);

    const statusMid = runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
    expect(statusMid.status).toBe(0);
    expect(statusMid.stdout).toContain('supervisor: running');
    expect(statusMid.stdout).toMatch(/listener:.*working/);

    const stop = runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
    expect(stop.status).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(isAlive(supervisorPid)).toBe(false);
    },
    detachedSupervisorTimeoutMs,
  );

  it.skipIf(process.platform === 'win32')(
    'quotes all launcher arguments on Unix when detached',
    { timeout: detachedSupervisorTimeoutMs },
    () => {
      const stateDir = makeStateDir();
      const projectId = 'proj&evil;|meta';
      const start = runSupervisor([
        '-Action',
        'Start',
        '-TestMode',
        '-SkipInitialWait',
        '-OrchestratorSessionId',
        'op-quote-test',
        '-ProjectId',
        projectId,
        '-StateDir',
        stateDir,
        '-PollSeconds',
        '1',
      ]);
      expect(start.status).toBe(0);

      const launcher = path.join(stateDir, 'launch-supervisor.sh');
      expect(fs.existsSync(launcher)).toBe(true);
      const script = fs.readFileSync(launcher, 'utf8');
      const quotedProjectId = `'${projectId.replace(/'/g, "'\\''")}'`;
      expect(script).toContain(`'-ProjectId' ${quotedProjectId}`);
      expect(script).not.toMatch(/-ProjectId proj&/);
      expect(script).not.toMatch(/nohup pwsh -NoProfile /);
      expect(script).toContain('command -v setsid');
      expect(script).toMatch(/setsid nohup pwsh/);
      expect(script).toMatch(/POSIX::setsid/);

      const apostropheDir = makeStateDir();
      const apostropheProject = "team's-pack";
      const startApostrophe = runSupervisor([
        '-Action',
        'Start',
        '-TestMode',
        '-SkipInitialWait',
        '-OrchestratorSessionId',
        'op-apostrophe',
        '-ProjectId',
        apostropheProject,
        '-StateDir',
        apostropheDir,
        '-PollSeconds',
        '1',
      ]);
      expect(startApostrophe.status).toBe(0);
      const launcherApostrophe = path.join(apostropheDir, 'launch-supervisor.sh');
      const apostropheScript = fs.readFileSync(launcherApostrophe, 'utf8');
      expect(apostropheScript).toContain(`'-ProjectId' 'team'\\''s-pack'`);
      expect(apostropheScript).not.toContain("'\\\\''");

      runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
      runSupervisor(['-Action', 'Stop', '-StateDir', apostropheDir]);
    },
  );

  it(
    'throttles crash-loop restarts for a child that exits immediately',
    async () => {
    const stateDir = makeStateDir();
    const child = startSupervisorBackground(
      stateDir,
      ['-OrchestratorSessionId', 'op-crash-backoff'],
      {
        AO_WAKE_SUPERVISOR_TEST_MODE_listener: 'instant-exit',
        AO_WAKE_SUPERVISOR_CRASH_MAX_RAPID_EXITS: '2',
        AO_WAKE_SUPERVISOR_CRASH_BASE_BACKOFF_SECONDS: '4',
        AO_WAKE_SUPERVISOR_CRASH_RAPID_EXIT_THRESHOLD_MS: '5000',
      },
    );

    const observedPids = new Set<number>();
    const logPath = path.join(stateDir, 'supervisor.log');

    try {
      await readMarker(stateDir, 'listener', 20_000);
    } catch {
      // listener may restart quickly between attempts
    }

    let supervisorLog = '';
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      try {
        const marker = await readMarker(stateDir, 'listener', 500);
        observedPids.add(marker.pid);
      } catch {
        // child may be between restarts
      }
      if (fs.existsSync(logPath)) {
        supervisorLog = fs.readFileSync(logPath, 'utf8');
        if (/crash backoff: listener/.test(supervisorLog)) {
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (!supervisorLog && fs.existsSync(logPath)) {
      supervisorLog = fs.readFileSync(logPath, 'utf8');
    }
    expect(supervisorLog).toMatch(/crash backoff: listener/);
    // Listener-only crash backoff; allow one extra PID when the registry grows.
    expect(observedPids.size).toBeLessThanOrEqual(5);
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
    },
    45_000,
  );
});
