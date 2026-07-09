import * as ows from './orchestrator-wake-supervisor.shared.js';

describe('orchestrator-wake-supervisor lifecycle', () => {
  ows.it(
    'stops children when orchestrator session disappears at runtime',
    async () => {
    const stateDir = ows.makeStateDir();
    const dynamicFixture = ows.path.join(stateDir, 'ao-status.json');
    ows.fs.writeFileSync(
      dynamicFixture,
      ows.fs.readFileSync(ows.path.join(ows.fixtureDir, 'status-orchestrator-op-old.json')),
    );

    const child = ows.startSupervisorBackground(stateDir, ['-FixturePath', dynamicFixture]);
    await ows.waitForMarkers(stateDir, 25_000, ['listener', 'heartbeat']);

    const listenerBefore = await ows.readMarker(stateDir, 'listener');
    const heartbeatBefore = await ows.readMarker(stateDir, 'heartbeat');
    ows.fs.writeFileSync(
      dynamicFixture,
      ows.fs.readFileSync(ows.path.join(ows.fixtureDir, 'status-no-orchestrator.json')),
    );
    await ows.waitForProcessesStopped([listenerBefore.pid, heartbeatBefore.pid], 25_000);
    ows.expect(ows.isAlive(listenerBefore.pid)).toBe(false);
    ows.expect(ows.isAlive(heartbeatBefore.pid)).toBe(false);
    child.kill('SIGTERM');
    },
    ows.detachedSupervisorTimeoutMs,
  );

  ows.it(
    'reports status and stops both children cleanly',
    async () => {
    const stateDir = ows.makeStateDir();
    const child = ows.startSupervisorBackground(stateDir, [
      '-OrchestratorSessionId',
      'op-status-stop',
    ]);
    await ows.waitForMarkers(stateDir, 25_000, ['listener', 'heartbeat']);

    const statusUp = await ows.waitForSupervisorHealthyStatus(stateDir);
    ows.expect(statusUp.status).toBe(0);
    ows.expect(statusUp.stdout).toContain('supervisor: running');
    ows.expect(statusUp.stdout).toContain('listener:   working');
    ows.expect(statusUp.stdout).toContain('heartbeat:  working');

    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));

    const stop = ows.runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
    ows.expect(stop.status).toBe(0);

    const statusDown = ows.runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
    ows.expect(statusDown.status).not.toBe(0);
    ows.expect(statusDown.stdout).toContain('stopped');
    },
    ows.detachedSupervisorTimeoutMs,
  );

  ows.it(
    'stops supervisor before children so no orphan wake processes remain',
    async () => {
    const stateDir = ows.makeStateDir();
    ows.startSupervisorBackground(stateDir, ['-OrchestratorSessionId', 'op-stop-order']);
    await ows.waitForMarkers(stateDir, 25_000, ['listener', 'heartbeat']);

    const listenerBefore = await ows.readMarker(stateDir, 'listener');
    const heartbeatBefore = await ows.readMarker(stateDir, 'heartbeat');
    ows.expect(ows.isAlive(listenerBefore.pid)).toBe(true);
    ows.expect(ows.isAlive(heartbeatBefore.pid)).toBe(true);

    const stop = ows.runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
    ows.expect(stop.status).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 1500));
    ows.expect(ows.isAlive(listenerBefore.pid)).toBe(false);
    ows.expect(ows.isAlive(heartbeatBefore.pid)).toBe(false);

    const statusDown = ows.runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
    ows.expect(statusDown.stdout).toContain('stopped');
    },
    ows.detachedSupervisorTimeoutMs,
  );

  ows.it('status exits non-zero when supervisor is stopped but children remain', async () => {
    const stateDir = ows.makeStateDir();
    const child = ows.startSupervisorBackground(stateDir, [
      '-OrchestratorSessionId',
      'op-status-orphan',
    ]);
    await ows.waitForMarkers(stateDir);

    const supervisorPid = Number(
      ows.fs.readFileSync(ows.path.join(stateDir, 'supervisor.pid'), 'utf8').trim(),
    );
    const listener = await ows.readMarker(stateDir, 'listener');
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));

    if (ows.isAlive(supervisorPid)) {
      process.kill(supervisorPid, 'SIGKILL');
    }
    await new Promise((resolve) => setTimeout(resolve, 300));

    if (ows.isAlive(listener.pid)) {
      const statusOrphan = ows.runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
      ows.expect(statusOrphan.status).not.toBe(0);
      ows.expect(statusOrphan.stdout).toContain('supervisor: stopped');
      process.kill(listener.pid, 'SIGKILL');
    }

    ows.runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
  }, ows.detachedSupervisorTimeoutMs);

  ows.it(
    'captures per-child logs and survives launching shell exit when detached',
    async () => {
    const stateDir = ows.makeStateDir();
    const start = ows.runSupervisor([
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
    ows.expect(start.status).toBe(0);
    ows.expect(start.stdout).toContain('supervisor detached');

    const supervisorPid = Number(
      ows.fs.readFileSync(ows.path.join(stateDir, 'supervisor.pid'), 'utf8').trim(),
    );
    ows.expect(supervisorPid).toBeGreaterThan(0);

    const childLogs = ows.managedChildRoles.map((role) => ows.path.join(stateDir, `${role}.log`));
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (childLogs.every((logPath) => ows.fs.existsSync(logPath))) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    for (const logPath of childLogs) {
      ows.expect(ows.fs.existsSync(logPath)).toBe(true);
    }

    await new Promise((resolve) => setTimeout(resolve, 2500));
    ows.expect(ows.isAlive(supervisorPid)).toBe(true);

    const statusMid = ows.runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
    ows.expect(statusMid.status).toBe(0);
    ows.expect(statusMid.stdout).toContain('supervisor: running');
    ows.expect(statusMid.stdout).toMatch(/listener:.*working/);

    const stop = ows.runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
    ows.expect(stop.status).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    ows.expect(ows.isAlive(supervisorPid)).toBe(false);
    },
    ows.detachedSupervisorTimeoutMs,
  );

  ows.it.skipIf(process.platform === 'win32')(
    'quotes all launcher arguments on Unix when detached',
    { timeout: ows.detachedSupervisorTimeoutMs },
    () => {
      const stateDir = ows.makeStateDir();
      const projectId = 'proj&evil;|meta';
      const start = ows.runSupervisor([
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
      ows.expect(start.status).toBe(0);

      const launcher = ows.path.join(stateDir, 'launch-supervisor.sh');
      ows.expect(ows.fs.existsSync(launcher)).toBe(true);
      const script = ows.fs.readFileSync(launcher, 'utf8');
      const quotedProjectId = `'${projectId.replace(/'/g, "'\\''")}'`;
      ows.expect(script).toContain(`'-ProjectId' ${quotedProjectId}`);
      ows.expect(script).not.toMatch(/-ProjectId proj&/);
      ows.expect(script).not.toMatch(/nohup pwsh -NoProfile /);
      ows.expect(script).toContain('command -v setsid');
      ows.expect(script).toMatch(/setsid nohup pwsh/);
      ows.expect(script).toMatch(/POSIX::setsid/);

      const apostropheDir = ows.makeStateDir();
      const apostropheProject = "team's-pack";
      const startApostrophe = ows.runSupervisor([
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
      ows.expect(startApostrophe.status).toBe(0);
      const launcherApostrophe = ows.path.join(apostropheDir, 'launch-supervisor.sh');
      const apostropheScript = ows.fs.readFileSync(launcherApostrophe, 'utf8');
      ows.expect(apostropheScript).toContain(`'-ProjectId' 'team'\\''s-pack'`);
      ows.expect(apostropheScript).not.toContain("'\\\\''");

      ows.runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
      ows.runSupervisor(['-Action', 'Stop', '-StateDir', apostropheDir]);
    },
  );

  ows.it(
    'throttles crash-loop restarts for a child that exits immediately',
    async () => {
    const stateDir = ows.makeStateDir();
    const child = ows.startSupervisorBackground(
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
    const logPath = ows.path.join(stateDir, 'supervisor.log');

    try {
      await ows.readMarker(stateDir, 'listener', 20_000);
    } catch {
      // listener may restart quickly between attempts
    }

    let supervisorLog = '';
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      try {
        const marker = await ows.readMarker(stateDir, 'listener', 500);
        observedPids.add(marker.pid);
      } catch {
        // child may be between restarts
      }
      if (ows.fs.existsSync(logPath)) {
        supervisorLog = ows.fs.readFileSync(logPath, 'utf8');
        if (/crash backoff: listener/.test(supervisorLog)) {
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (!supervisorLog && ows.fs.existsSync(logPath)) {
      supervisorLog = ows.fs.readFileSync(logPath, 'utf8');
    }
    ows.expect(supervisorLog).toMatch(/crash backoff: listener/);
    // Listener-only crash backoff; allow one extra PID when the registry grows.
    ows.expect(observedPids.size).toBeLessThanOrEqual(5);
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    ows.runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
    },
    45_000,
  );
});
