import { describe, expect, it } from 'vitest';
import * as ows from './orchestrator-wake-supervisor.shared.js';

const sessionlessRole = 'review-trigger-reconcile' as const;
const sessionBoundRole = 'escalation-router' as const;

function startBackground(stateDir: string, sessionId: string) {
  return ows.startSupervisorBackground(stateDir, [
    '-OrchestratorSessionId',
    sessionId,
  ]);
}

describe('orchestrator-wake-supervisor lifecycle', () => {
  it(
    'stops the session-bound child when orchestrator session disappears while sessionless children remain',
    async () => {
      const stateDir = ows.makeStateDir();
      const dynamicFixture = ows.path.join(stateDir, 'ao-status.json');
      ows.fs.writeFileSync(
        dynamicFixture,
        ows.fs.readFileSync(ows.path.join(ows.fixtureDir, 'status-orchestrator-op-old.json')),
      );

      const child = ows.startSupervisorBackground(stateDir, ['-FixturePath', dynamicFixture]);
      await ows.waitForMarkers(stateDir, 25_000, [sessionlessRole, sessionBoundRole]);

      const reconcileBefore = await ows.readMarker(stateDir, sessionlessRole);
      const routerBefore = await ows.readMarker(stateDir, sessionBoundRole);
      ows.fs.writeFileSync(
        dynamicFixture,
        ows.fs.readFileSync(ows.path.join(ows.fixtureDir, 'status-no-orchestrator.json')),
      );

      await ows.waitForProcessesStopped([routerBefore.pid], 25_000);
      expect(ows.isAlive(routerBefore.pid)).toBe(false);
      expect(ows.isAlive(reconcileBefore.pid)).toBe(true);
      await ows.stopSupervisorChild(child, stateDir, 1500);
    },
    ows.detachedSupervisorTimeoutMs,
  );

  it(
    'reports status and stops surviving children cleanly',
    async () => {
      const stateDir = ows.makeStateDir();
      const child = startBackground(stateDir, 'op-status-stop');
      await ows.waitForMarkers(stateDir, 25_000, [sessionlessRole, sessionBoundRole]);

      const statusUp = await ows.waitForSupervisorHealthyStatus(stateDir);
      expect(statusUp.status).toBe(0);
      expect(statusUp.stdout).toContain('supervisor: running');
      expect(statusUp.stdout).toContain(`${sessionlessRole}:`);
      expect(statusUp.stdout).toContain(`${sessionBoundRole}:`);
      expect(statusUp.stdout).not.toContain('listener:');

      const supervisorPid = Number(
        ows.fs.readFileSync(ows.path.join(stateDir, 'supervisor.pid'), 'utf8').trim(),
      );
      child.kill('SIGTERM');
      await ows.waitForProcessesStopped([supervisorPid], 500);

      const stop = ows.runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
      expect(stop.status).toBe(0);

      const statusDown = ows.runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
      expect(statusDown.status).not.toBe(0);
      expect(statusDown.stdout).toContain('stopped');
    },
    ows.detachedSupervisorTimeoutMs,
  );

  it(
    'stops supervisor before children so no orphan managed processes remain',
    async () => {
      const stateDir = ows.makeStateDir();
      startBackground(stateDir, 'op-stop-order');
      await ows.waitForMarkers(stateDir, 25_000, [sessionlessRole, sessionBoundRole]);

      const reconcileBefore = await ows.readMarker(stateDir, sessionlessRole);
      const routerBefore = await ows.readMarker(stateDir, sessionBoundRole);
      expect(ows.isAlive(reconcileBefore.pid)).toBe(true);
      expect(ows.isAlive(routerBefore.pid)).toBe(true);

      const stop = ows.runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
      expect(stop.status).toBe(0);

      await ows.waitForProcessesStopped([reconcileBefore.pid, routerBefore.pid], 1500);
      expect(ows.isAlive(reconcileBefore.pid)).toBe(false);
      expect(ows.isAlive(routerBefore.pid)).toBe(false);

      const statusDown = ows.runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
      expect(statusDown.stdout).toContain('stopped');
    },
    ows.detachedSupervisorTimeoutMs,
  );

  it('status exits non-zero when supervisor is stopped but a managed child remains', async () => {
    const stateDir = ows.makeStateDir();
    const child = startBackground(stateDir, 'op-status-orphan');
    await ows.waitForMarkers(stateDir);

    const supervisorPid = Number(
      ows.fs.readFileSync(ows.path.join(stateDir, 'supervisor.pid'), 'utf8').trim(),
    );
    const reconcile = await ows.readMarker(stateDir, sessionlessRole);
    child.kill('SIGTERM');
    await ows.waitForProcessesStopped([supervisorPid], 500);

    if (ows.isAlive(supervisorPid)) {
      process.kill(supervisorPid, 'SIGKILL');
    }
    await ows.sleepMs(300);

    if (ows.isAlive(reconcile.pid)) {
      const statusOrphan = ows.runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
      expect(statusOrphan.status).not.toBe(0);
      expect(statusOrphan.stdout).toContain('supervisor: stopped');
      process.kill(reconcile.pid, 'SIGKILL');
    }

    ows.runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
  }, ows.detachedSupervisorTimeoutMs);

  it(
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
      expect(start.status).toBe(0);
      expect(start.stdout).toContain('supervisor detached');

      const supervisorPid = Number(
        ows.fs.readFileSync(ows.path.join(stateDir, 'supervisor.pid'), 'utf8').trim(),
      );
      expect(supervisorPid).toBeGreaterThan(0);

      const childLogs = ows.managedChildRoles.map((role) => ows.path.join(stateDir, `${role}.log`));
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (childLogs.every((logPath) => ows.fs.existsSync(logPath))) break;
        await ows.sleepMs(300);
      }
      for (const logPath of childLogs) expect(ows.fs.existsSync(logPath)).toBe(true);

      await ows.fixedObservationWindow(2500);
      expect(ows.isAlive(supervisorPid)).toBe(true);

      const statusMid = ows.runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
      expect(statusMid.status).toBe(0);
      expect(statusMid.stdout).toContain('supervisor: running');
      expect(statusMid.stdout).toMatch(/review-trigger-reconcile:.*working/);
      expect(statusMid.stdout).not.toMatch(/listener:.*working/);

      const stop = ows.runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
      expect(stop.status).toBe(0);
      await ows.waitForProcessesStopped([supervisorPid], 500);
      expect(ows.isAlive(supervisorPid)).toBe(false);
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
      expect(start.status).toBe(0);

      const launcher = ows.path.join(stateDir, 'launch-supervisor.sh');
      expect(ows.fs.existsSync(launcher)).toBe(true);
      const script = ows.fs.readFileSync(launcher, 'utf8');
      const quotedProjectId = `'${projectId.replace(/'/g, "'\\''")}'`;
      expect(script).toContain(`'-ProjectId' ${quotedProjectId}`);
      expect(script).not.toMatch(/-ProjectId proj&/);
      expect(script).not.toMatch(/nohup pwsh -NoProfile /);
      expect(script).toContain('command -v setsid');
      expect(script).toMatch(/setsid nohup pwsh/);
      expect(script).toMatch(/POSIX::setsid/);

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
      expect(startApostrophe.status).toBe(0);
      const launcherApostrophe = ows.path.join(apostropheDir, 'launch-supervisor.sh');
      const apostropheScript = ows.fs.readFileSync(launcherApostrophe, 'utf8');
      expect(apostropheScript).toContain(`'-ProjectId' 'team'\\''s-pack'`);
      expect(apostropheScript).not.toContain("'\\\\''");

      ows.runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
      ows.runSupervisor(['-Action', 'Stop', '-StateDir', apostropheDir]);
    },
  );

  it(
    'throttles crash-loop restarts for a surviving child that exits immediately',
    async () => {
      const stateDir = ows.makeStateDir();
      const child = ows.startSupervisorBackground(
        stateDir,
        ['-OrchestratorSessionId', 'op-crash-backoff'],
        {
          AO_WAKE_SUPERVISOR_TEST_MODE_review_trigger_reconcile: 'instant-exit',
          AO_WAKE_SUPERVISOR_CRASH_MAX_RAPID_EXITS: '2',
          AO_WAKE_SUPERVISOR_CRASH_BASE_BACKOFF_SECONDS: '4',
          AO_WAKE_SUPERVISOR_CRASH_RAPID_EXIT_THRESHOLD_MS: '5000',
        },
      );

      const observedPids = new Set<number>();
      const logPath = ows.path.join(stateDir, 'supervisor.log');
      try {
        await ows.readMarker(stateDir, sessionlessRole, 20_000);
      } catch {
        // The child may restart quickly between attempts.
      }

      let supervisorLog = '';
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        try {
          const marker = await ows.readMarker(stateDir, sessionlessRole, 500);
          observedPids.add(marker.pid);
        } catch {
          // The child may be between restarts.
        }
        if (ows.fs.existsSync(logPath)) {
          supervisorLog = ows.fs.readFileSync(logPath, 'utf8');
          if (/crash backoff: review-trigger-reconcile/.test(supervisorLog)) break;
        }
        await ows.sleepMs(250);
      }

      if (!supervisorLog && ows.fs.existsSync(logPath)) {
        supervisorLog = ows.fs.readFileSync(logPath, 'utf8');
      }
      expect(supervisorLog).toMatch(/crash backoff: review-trigger-reconcile/);
      expect(observedPids.size).toBeLessThanOrEqual(5);
      await ows.stopSupervisorChild(child, stateDir, 1500);
    },
    45_000,
  );
});
