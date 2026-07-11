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
  waitForMarkerPidChange,
  waitForMarkers,
  waitForProcessesStopped,
  waitForSupervisorLogMatch,
  fixedObservationWindow,
  sleepMs,
  type WakeMarker,
} from './orchestrator-wake-supervisor.shared.js';

function writeRecoveryState(
  stateDir: string,
  childId: string,
  recovery: Record<string, unknown>,
): void {
  const statePath = path.join(stateDir, 'state.json');
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const childRecovery = {
    ...((payload.childRecovery as Record<string, unknown> | undefined) ?? {}),
    [childId]: recovery,
  };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    statePath,
    `${JSON.stringify({ ...payload, childRecovery }, null, 2)}\n`,
    'utf8',
  );
}

function currentBootId(): string {
  return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
}

function readRecoveryState(stateDir: string, childId: string): Record<string, unknown> {
  const statePath = path.join(stateDir, 'state.json');
  try {
    const payload = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
      childRecovery?: Record<string, Record<string, unknown>>;
    };
    return payload.childRecovery?.[childId] ?? {};
  } catch {
    return {};
  }
}

async function stopDetachedSupervisorPreservingState(stateDir: string): Promise<void> {
  const supervisorPidPath = path.join(stateDir, 'supervisor.pid');
  const supervisorPid = Number(fs.readFileSync(supervisorPidPath, 'utf8').trim());
  if (supervisorPid > 0 && isAlive(supervisorPid)) {
    process.kill(supervisorPid, 'SIGTERM');
    await waitForProcessesStopped([supervisorPid], 10_000);
  }
}

function startSupervisorWithFixture(
  stateDir: string,
  extraArgs: string[] = [],
  env: Record<string, string> = {},
) {
  const aoCommand = path.join(fixtureDir, 'ao-stub.ps1');
  const fixtureIndex = extraArgs.indexOf('-FixturePath');
  const fixtureEnv =
    fixtureIndex >= 0 && fixtureIndex + 1 < extraArgs.length
      ? { AO_WAKE_SUPERVISOR_FIXTURE: extraArgs[fixtureIndex + 1] }
      : {};
  return spawn(
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
      '-SkipInitialWait',
      '-PollSeconds',
      '1',
      '-StateDir',
      stateDir,
      '-AoCommand',
      aoCommand,
      ...extraArgs,
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, ...fixtureEnv, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

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
      if (marker.role === 'listener' || marker.role === 'escalation-router') {
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
    const child = startSupervisorBackground(stateDir, ['-OrchestratorSessionId', 'op-restart'], {
      AO_WAKE_SUPERVISOR_RESTART_STAGGER_MS: '0',
      AO_WAKE_SUPERVISOR_ID_DEBOUNCE_POLLS: '1',
      AO_WAKE_SUPERVISOR_SESSION_GLITCH_POLLS: '1',
      AO_WAKE_SUPERVISOR_CRASH_MAX_RAPID_EXITS: '99',
      AO_WAKE_SUPERVISOR_CRASH_TERMINAL_RAPID_EXITS: '99',
      AO_WAKE_SUPERVISOR_TEST_MODE_listener: 'instant-exit',
    });
    await waitForMarkers(stateDir);

    const first = await readMarker(stateDir, 'listener');
    await waitForMarkerPidChange(stateDir, 'listener', first.pid, 90_000);
    child.kill('SIGTERM');
  }, 120_000);

  it('does not share fate between listener and escalation-router', async () => {
    const stateDir = makeStateDir();
    const child = startSupervisorBackground(stateDir, [
      '-OrchestratorSessionId',
      'op-independent',
    ]);
    await waitForMarkers(stateDir);

    const listener = await readMarker(stateDir, 'listener');
    const router = await readMarker(stateDir, 'escalation-router');
    const routerPidAtKill = router.pid;
    if (isAlive(listener.pid)) {
      process.kill(listener.pid, 'SIGKILL');
    }
    await fixedObservationWindow(2000);
    expect(isAlive(routerPidAtKill)).toBe(true);
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

    await waitForSupervisorLogMatch(stateDir, /waiting for orchestrator session/, 8_000);
    expect(stdout).toContain('waiting for orchestrator session');

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

    const deadline = Date.now() + 90_000;
    let sawNew = false;
    while (Date.now() < deadline) {
      const listener = await readMarker(stateDir, 'listener');
      const router = await readMarker(stateDir, 'escalation-router');
      if (
        listener.orchestratorSessionId === 'op-orchestrator-new' &&
        router.orchestratorSessionId === 'op-orchestrator-new' &&
        listener.pid !== oldListener.pid
      ) {
        sawNew = true;
        break;
      }
      await sleepMs(500);
    }
    expect(sawNew).toBe(true);
    child.kill('SIGTERM');
  }, 120_000);

  it('keeps an outage-class terminal stopped while daemon remains unhealthy, then auto-rearms once health recovers', async () => {
    const stateDir = makeStateDir();
    const dynamicFixture = path.join(stateDir, 'ao-status.json');
    fs.writeFileSync(
      dynamicFixture,
      fs.readFileSync(path.join(fixtureDir, 'status-orchestrator-op-old-unhealthy.json')),
    );
    writeRecoveryState(stateDir, 'listener', {
      terminal: true,
      reason: 'crash-loop circuit breaker',
      rapidExits: 12,
      backoffUntilMs: 0,
      lastExitMs: Date.now() - 30_000,
      terminalDaemonHealthClass: 'unhealthy-confirmed',
      terminalAtMs: Date.now() - 30_000,
      terminalBootId: currentBootId(),
      terminalEpisodeId: 'listener-outage-1',
      terminalRearmAttempts: 0,
      lastDaemonHealthClass: 'unhealthy-confirmed',
      lastDaemonHealthObservedAtMs: Date.now() - 30_000,
    });

    const child = startSupervisorWithFixture(
      stateDir,
      ['-OrchestratorSessionId', 'op-terminal-rearm', '-FixturePath', dynamicFixture],
      {
        AO_WAKE_SUPERVISOR_TERMINAL_REARM_GRACE_SECONDS: '0',
        AO_WAKE_SUPERVISOR_TERMINAL_REARM_TTL_SECONDS: '1',
      },
    );

    await fixedObservationWindow(2000);
    await expect(readMarker(stateDir, 'listener', 800)).rejects.toThrow();
    expect(readRecoveryState(stateDir, 'listener').terminal).toBe(true);

    fs.writeFileSync(
      dynamicFixture,
      fs.readFileSync(path.join(fixtureDir, 'status-orchestrator-op-old.json')),
    );

    const marker = await readMarker(stateDir, 'listener', 20_000);
    expect(marker.pid).toBeGreaterThan(0);

    const recovery = readRecoveryState(stateDir, 'listener');
    expect(recovery.terminal).toBe(false);
    expect(Number(recovery.rapidExits ?? 0)).toBe(0);
    expect(Number(recovery.backoffUntilMs ?? 0)).toBe(0);
    expect(String(recovery.reason ?? '')).toBe('');
    expect(String(recovery.terminalDaemonHealthClass ?? '')).toBe('');

    child.kill('SIGTERM');
    await sleepMs(1000);
    runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
  }, 60_000);

  it('does not auto-reclaim healthy or unknown terminal provenance on cold start', async () => {
    for (const provenance of ['healthy', 'unknown'] as const) {
      const stateDir = makeStateDir();
      const statusFixture = path.join(fixtureDir, 'status-orchestrator-op-old.json');
      writeRecoveryState(stateDir, 'listener', {
        terminal: true,
        reason: `${provenance} terminal`,
        rapidExits: 12,
        backoffUntilMs: 0,
        lastExitMs: Date.now() - 60_000,
        terminalDaemonHealthClass: provenance,
        terminalAtMs: Date.now() - 60_000,
        terminalBootId: 'prior-boot-id',
        terminalEpisodeId: 'listener-locked',
        terminalRearmAttempts: 0,
        lastDaemonHealthClass: 'unhealthy-confirmed',
        lastDaemonHealthObservedAtMs: Date.now() - 60_000,
      });

      const child = startSupervisorWithFixture(
        stateDir,
        ['-OrchestratorSessionId', `op-terminal-${provenance}`, '-FixturePath', statusFixture],
        {
          AO_WAKE_SUPERVISOR_TERMINAL_REARM_GRACE_SECONDS: '0',
          AO_WAKE_SUPERVISOR_TERMINAL_REARM_TTL_SECONDS: '1',
        },
      );

      await fixedObservationWindow(2000);
      await expect(readMarker(stateDir, 'listener', 800)).rejects.toThrow();
      expect(readRecoveryState(stateDir, 'listener').terminal).toBe(true);

      child.kill('SIGTERM');
      await sleepMs(1000);
      runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
    }
  }, 60_000);

  it('restarts an alive outage-class terminal child instead of stopping it into permanence', async () => {
    const stateDir = makeStateDir();
    const statusFixture = path.join(fixtureDir, 'status-orchestrator-op-old.json');
    const child = startSupervisorWithFixture(
      stateDir,
      ['-OrchestratorSessionId', 'op-alive-terminal', '-FixturePath', statusFixture],
      {
        AO_WAKE_SUPERVISOR_TEST_MODE_listener: 'prompt-block',
        AO_WAKE_SUPERVISOR_TEST_PROMPT_BLOCK_DELAY_MS: '15000',
        AO_WAKE_SUPERVISOR_TERMINAL_REARM_GRACE_SECONDS: '0',
        AO_WAKE_SUPERVISOR_TERMINAL_REARM_TTL_SECONDS: '1',
      },
    );
    const first = await readMarker(stateDir, 'listener', 20_000);

    writeRecoveryState(stateDir, 'listener', {
      terminal: true,
      reason: 'outage terminal survivor',
      rapidExits: 12,
      backoffUntilMs: 0,
      lastExitMs: Date.now() - 30_000,
      terminalDaemonHealthClass: 'unhealthy-confirmed',
      terminalAtMs: Date.now() - 30_000,
      terminalBootId: currentBootId(),
      terminalEpisodeId: 'listener-survivor',
      terminalRearmAttempts: 0,
      lastDaemonHealthClass: 'unhealthy-confirmed',
      lastDaemonHealthObservedAtMs: Date.now() - 30_000,
    });

    await waitForMarkerPidChange(stateDir, 'listener', first.pid, 20_000);
    const restarted = await readMarker(stateDir, 'listener', 5_000);
    expect(restarted.pid).not.toBe(first.pid);
    expect(readRecoveryState(stateDir, 'listener').terminal).toBe(false);

    child.kill('SIGTERM');
    await sleepMs(1000);
    runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
  }, 60_000);

  it('reclaims a stale outage-class terminal after boot-id change when daemon is healthy', async () => {
    const stateDir = makeStateDir();
    const statusFixture = path.join(fixtureDir, 'status-orchestrator-op-old.json');
    writeRecoveryState(stateDir, 'listener', {
      terminal: true,
      reason: 'prior boot outage terminal',
      rapidExits: 12,
      backoffUntilMs: 0,
      lastExitMs: Date.now() - 30_000,
      terminalDaemonHealthClass: 'unhealthy-confirmed',
      terminalAtMs: Date.now() - 30_000,
      terminalBootId: 'prior-boot-id',
      terminalEpisodeId: 'listener-prior-boot',
      terminalRearmAttempts: 0,
      lastDaemonHealthClass: 'healthy',
      lastDaemonHealthObservedAtMs: Date.now() - 30_000,
    });

    const child = startSupervisorWithFixture(
      stateDir,
      ['-OrchestratorSessionId', 'op-prior-boot-terminal', '-FixturePath', statusFixture],
      {
        AO_WAKE_SUPERVISOR_TERMINAL_REARM_GRACE_SECONDS: '0',
        AO_WAKE_SUPERVISOR_TERMINAL_REARM_TTL_SECONDS: '3600',
      },
    );

    const marker = await readMarker(stateDir, 'listener', 20_000);
    expect(marker.pid).toBeGreaterThan(0);
    expect(readRecoveryState(stateDir, 'listener').terminal).toBe(false);

    child.kill('SIGTERM');
    await sleepMs(1000);
    runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
  }, 60_000);

  it('keeps the outage re-arm attempt cap across supervisor restarts', async () => {
    const stateDir = makeStateDir();
    const statusFixture = path.join(fixtureDir, 'status-orchestrator-op-old.json');
    writeRecoveryState(stateDir, 'listener', {
      terminal: true,
      reason: 'capped outage terminal',
      rapidExits: 12,
      backoffUntilMs: 0,
      lastExitMs: Date.now() - 30_000,
      terminalDaemonHealthClass: 'unhealthy-confirmed',
      terminalAtMs: Date.now() - 30_000,
      terminalBootId: currentBootId(),
      terminalEpisodeId: 'listener-capped',
      terminalRearmAttempts: 1,
      lastDaemonHealthClass: 'unhealthy-confirmed',
      lastDaemonHealthObservedAtMs: Date.now() - 30_000,
    });

    const env = {
      AO_WAKE_SUPERVISOR_TERMINAL_REARM_GRACE_SECONDS: '0',
      AO_WAKE_SUPERVISOR_TERMINAL_REARM_TTL_SECONDS: '1',
      AO_WAKE_SUPERVISOR_TERMINAL_REARM_MAX_ATTEMPTS: '1',
    };

    const firstRun = startSupervisorWithFixture(
      stateDir,
      ['-OrchestratorSessionId', 'op-capped-terminal', '-FixturePath', statusFixture],
      env,
    );
    await fixedObservationWindow(2000);
    await expect(readMarker(stateDir, 'listener', 800)).rejects.toThrow();
    await stopDetachedSupervisorPreservingState(stateDir);
    firstRun.kill('SIGTERM');

    const secondRun = startSupervisorWithFixture(
      stateDir,
      ['-OrchestratorSessionId', 'op-capped-terminal', '-FixturePath', statusFixture],
      env,
    );
    await fixedObservationWindow(2000);
    await expect(readMarker(stateDir, 'listener', 800)).rejects.toThrow();
    expect(Number(readRecoveryState(stateDir, 'listener').terminalRearmAttempts ?? 0)).toBe(1);

    secondRun.kill('SIGTERM');
    await sleepMs(1000);
    runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
  }, 60_000);
});
