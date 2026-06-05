import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');
const supervisorScript = path.join(repoRoot, 'scripts/orchestrator-wake-supervisor.ps1');
const fixtureDir = path.join(repoRoot, 'scripts/fixtures/orchestrator-wake-supervisor');
const aoStub = path.join(fixtureDir, 'ao-stub.sh');

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    try {
      execFileSync(
        'pwsh',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          supervisorScript,
          '-Action',
          'Stop',
          '-StateDir',
          root,
        ],
        { cwd: repoRoot, stdio: 'pipe' },
      );
    } catch {
      // best effort
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-supervisor-test-'));
  tmpRoots.push(dir);
  return dir;
}

function runSupervisor(
  args: string[],
  env: Record<string, string> = {},
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(
    'pwsh',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', supervisorScript, ...args],
    {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

function startSupervisorBackground(
  stateDir: string,
  extraArgs: string[] = [],
  env: Record<string, string> = {},
) {
  const args = [
    '-Action',
    'Start',
    '-Foreground',
    '-TestMode',
    '-SkipInitialWait',
    '-StateDir',
    stateDir,
    '-PollSeconds',
    '1',
    ...extraArgs,
  ];
  const child = spawn(
    'pwsh',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', supervisorScript, ...args],
    {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return child;
}

async function waitForMarkers(stateDir: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listenerPath = path.join(stateDir, 'markers', 'listener.marker.json');
    const heartbeatPath = path.join(stateDir, 'markers', 'heartbeat.marker.json');
    const reviewSendPath = path.join(stateDir, 'markers', 'review-send-reconcile.marker.json');
    if (
      fs.existsSync(listenerPath) &&
      fs.existsSync(heartbeatPath) &&
      fs.existsSync(reviewSendPath)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('timed out waiting for supervisor child markers');
}

type WakeMarker = {
  role: string;
  pid: number;
  orchestratorSessionId: string;
  projectId?: string;
};

async function readMarker(
  stateDir: string,
  role: 'listener' | 'heartbeat' | 'review-send-reconcile',
  timeoutMs = 5000,
): Promise<WakeMarker> {
  const markerPath = path.join(stateDir, 'markers', `${role}.marker.json`);
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (!fs.existsSync(markerPath)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    try {
      const raw = fs.readFileSync(markerPath, 'utf8').trim();
      if (!raw) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      return JSON.parse(raw) as WakeMarker;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError ?? new Error(`timed out reading ${role} marker at ${markerPath}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('orchestrator-wake-supervisor', () => {
  it('starts listener, heartbeat, and review-send-reconcile as separate processes', async () => {
    const stateDir = makeStateDir();
    const child = startSupervisorBackground(stateDir, [
      '-OrchestratorSessionId',
      'op-test-override',
    ]);
    await waitForMarkers(stateDir);

    const listener = await readMarker(stateDir, 'listener');
    const heartbeat = await readMarker(stateDir, 'heartbeat');
    const reviewSend = await readMarker(stateDir, 'review-send-reconcile');
    expect(listener.orchestratorSessionId).toBe('op-test-override');
    expect(heartbeat.orchestratorSessionId).toBe('op-test-override');
    expect(listener.pid).not.toBe(heartbeat.pid);
    expect(reviewSend.pid).not.toBe(listener.pid);
    expect(reviewSend.pid).not.toBe(heartbeat.pid);
    child.kill('SIGTERM');
  });

  it('resolves orchestrator session id from ao status when override unset', async () => {
    const stateDir = makeStateDir();
    const statusFixture = path.join(fixtureDir, 'status-orchestrator-op-old.json');
    const child = startSupervisorBackground(stateDir, ['-FixturePath', statusFixture]);
    await waitForMarkers(stateDir);

    const listener = await readMarker(stateDir, 'listener');
    expect(listener.orchestratorSessionId).toBe('op-orchestrator-old');
    child.kill('SIGTERM');
  });

  it('passes supervisor ProjectId to review-send-reconcile child', async () => {
    const stateDir = makeStateDir();
    const child = startSupervisorBackground(stateDir, [
      '-OrchestratorSessionId',
      'op-project-pass',
      '-ProjectId',
      'custom-ao-project',
    ]);
    await waitForMarkers(stateDir);

    const reviewSend = await readMarker(stateDir, 'review-send-reconcile');
    expect(reviewSend.projectId).toBe('custom-ao-project');
    child.kill('SIGTERM');
  });

  it('restarts review-send-reconcile after it exits', async () => {
    const stateDir = makeStateDir();
    const child = startSupervisorBackground(stateDir, ['-OrchestratorSessionId', 'op-restart-send']);
    await waitForMarkers(stateDir);

    const first = await readMarker(stateDir, 'review-send-reconcile');
    if (isAlive(first.pid)) {
      process.kill(first.pid, 'SIGKILL');
    }
    const deadline = Date.now() + 10_000;
    let restarted = false;
    while (Date.now() < deadline) {
      const current = await readMarker(stateDir, 'review-send-reconcile');
      if (current.pid !== first.pid && isAlive(current.pid)) {
        restarted = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    expect(restarted).toBe(true);
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
    const deadline = Date.now() + 10_000;
    let restarted = false;
    while (Date.now() < deadline) {
      const current = await readMarker(stateDir, 'listener');
      if (current.pid !== first.pid && isAlive(current.pid)) {
        restarted = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    expect(restarted).toBe(true);
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
    if (isAlive(listener.pid)) {
      process.kill(listener.pid, 'SIGKILL');
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(isAlive(heartbeat.pid)).toBe(true);
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

    await new Promise((resolve) => setTimeout(resolve, 1500));
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
      await new Promise((resolve) => setTimeout(resolve, 300));
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
    expect(combined).toMatch(/start.*ao/i);
  });

  it('restarts both children when orchestrator session id changes', async () => {
    const stateDir = makeStateDir();
    const dynamicFixture = path.join(stateDir, 'ao-status.json');
    fs.writeFileSync(
      dynamicFixture,
      fs.readFileSync(path.join(fixtureDir, 'status-orchestrator-op-old.json')),
    );

    const child = startSupervisorBackground(stateDir, ['-FixturePath', dynamicFixture]);
    await waitForMarkers(stateDir);

    const oldListener = await readMarker(stateDir, 'listener');
    fs.writeFileSync(
      dynamicFixture,
      fs.readFileSync(path.join(fixtureDir, 'status-orchestrator-op-new.json')),
    );

    const deadline = Date.now() + 12_000;
    let sawNew = false;
    while (Date.now() < deadline) {
      const current = await readMarker(stateDir, 'listener');
      if (current.orchestratorSessionId === 'op-orchestrator-new' && current.pid !== oldListener.pid) {
        sawNew = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    expect(sawNew).toBe(true);
    const heartbeat = await readMarker(stateDir, 'heartbeat');
    expect(heartbeat.orchestratorSessionId).toBe('op-orchestrator-new');
    child.kill('SIGTERM');
  });

  it('stops children when orchestrator session disappears at runtime', async () => {
    const stateDir = makeStateDir();
    const dynamicFixture = path.join(stateDir, 'ao-status.json');
    fs.writeFileSync(
      dynamicFixture,
      fs.readFileSync(path.join(fixtureDir, 'status-orchestrator-op-old.json')),
    );

    const child = startSupervisorBackground(stateDir, ['-FixturePath', dynamicFixture]);
    await waitForMarkers(stateDir);

    const listenerBefore = await readMarker(stateDir, 'listener');
    const heartbeatBefore = await readMarker(stateDir, 'heartbeat');
    fs.writeFileSync(
      dynamicFixture,
      fs.readFileSync(path.join(fixtureDir, 'status-no-orchestrator.json')),
    );
    await new Promise((resolve) => setTimeout(resolve, 5000));
    expect(isAlive(listenerBefore.pid)).toBe(false);
    expect(isAlive(heartbeatBefore.pid)).toBe(false);
    child.kill('SIGTERM');
  });

  it('reports status and stops both children cleanly', async () => {
    const stateDir = makeStateDir();
    const child = startSupervisorBackground(stateDir, [
      '-OrchestratorSessionId',
      'op-status-stop',
    ]);
    await waitForMarkers(stateDir);

    const statusUp = runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
    expect(statusUp.status).toBe(0);
    expect(statusUp.stdout).toContain('supervisor: running');
    expect(statusUp.stdout).toContain('listener:   running');
    expect(statusUp.stdout).toContain('heartbeat:  running');
    expect(statusUp.stdout).toContain('review-send-reconcile: running');

    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));

    const stop = runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
    expect(stop.status).toBe(0);

    const statusDown = runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
    expect(statusDown.status).not.toBe(0);
    expect(statusDown.stdout).toContain('stopped');
  });

  it('stops supervisor before children so no orphan wake processes remain', async () => {
    const stateDir = makeStateDir();
    startSupervisorBackground(stateDir, ['-OrchestratorSessionId', 'op-stop-order']);
    await waitForMarkers(stateDir);

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
  });

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
  });

  it('captures per-child logs and survives launching shell exit when detached', () => {
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

    const listenerLog = path.join(stateDir, 'listener.log');
    const heartbeatLog = path.join(stateDir, 'heartbeat.log');
    const reviewSendLog = path.join(stateDir, 'review-send-reconcile.log');
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (
        fs.existsSync(listenerLog) &&
        fs.existsSync(heartbeatLog) &&
        fs.existsSync(reviewSendLog)
      ) {
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
    expect(fs.existsSync(listenerLog)).toBe(true);
    expect(fs.existsSync(heartbeatLog)).toBe(true);

    const statusMid = runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
    expect(statusMid.status).toBe(0);

    runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
  });

  it.skipIf(process.platform === 'win32')(
    'quotes all launcher arguments on Unix when detached',
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
});

describe('Issue #207 side-effecting listener registry', () => {
  it('registry classifies listener as side-effecting with lock path', () => {
    const supervisorLib = path.join(repoRoot, 'scripts/lib/Orchestrator-WakeSupervisor.ps1');
    const text = fs.readFileSync(supervisorLib, 'utf8');
    expect(text).toContain('Get-OrchestratorWakeSupervisorChildRegistry');
    expect(text).toContain("Id            = 'listener'");
    expect(text).toContain('SideEffecting = $true');
    expect(text).toContain('listener-side-effect.lock');
  });
});
