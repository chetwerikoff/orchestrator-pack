import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');
const supervisorScript = path.join(repoRoot, 'scripts/orchestrator-wake-supervisor.ps1');
const fixtureDir = path.join(repoRoot, 'scripts/fixtures/orchestrator-wake-supervisor');
const aoStub = path.join(fixtureDir, 'ao-stub.sh');

const tmpRoots: string[] = [];
const supervisorHookTimeoutMs = 120_000;

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
        { cwd: repoRoot, stdio: 'pipe', timeout: supervisorHookTimeoutMs },
      );
    } catch {
      // best effort
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}, supervisorHookTimeoutMs);

function makeStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-supervisor-test-'));
  tmpRoots.push(dir);
  return dir;
}

function runSupervisor(
  args: string[],
  env: Record<string, string> = {},
): { stdout: string; stderr: string; status: number | null } {
  const savedEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  const result = spawnSync(
    'pwsh',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', supervisorScript, ...args],
    {
      cwd: repoRoot,
      env: process.env,
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  for (const [key, previous] of Object.entries(savedEnv)) {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
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
  const savedEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  const child = spawn(
    'pwsh',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', supervisorScript, ...args],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: 'ignore',
    },
  );
  child.on('exit', () => {
    for (const [key, previous] of Object.entries(savedEnv)) {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });
  return child;
}

const detachedSupervisorTimeoutMs = 60_000;

const managedChildRoles = [
  'listener',
  'heartbeat',
  'review-trigger-reconcile',
  'review-trigger-reeval',
  'ci-green-wake-reconcile',
  'ci-failure-notification-reconcile',
  'ci-failure-notification-reaction',
  'review-send-reconcile',
  'review-finding-delivery-confirm',
  'worker-message-submit-reconcile',
] as const;

type ManagedChildRole = (typeof managedChildRoles)[number];

async function waitForMarkers(
  stateDir: string,
  timeoutMs = 25_000,
  roles: readonly ManagedChildRole[] = managedChildRoles,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = roles.every((role) =>
      fs.existsSync(path.join(stateDir, 'markers', `${role}.marker.json`)),
    );
    if (ready) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for supervisor child markers: ${roles.join(', ')}`);
}

type WakeMarker = {
  role: string;
  pid: number;
  orchestratorSessionId: string;
  projectId?: string;
};

async function readMarker(
  stateDir: string,
  role: ManagedChildRole,
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
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(sawNew).toBe(true);
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
    expect(statusUp.stdout).toContain('listener:   working');
    expect(statusUp.stdout).toContain('heartbeat:  working');
    expect(statusUp.stdout).toContain('review-send-reconcile: working');

    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));

    const stop = runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
    expect(stop.status).toBe(0);

    const statusDown = runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
    expect(statusDown.status).not.toBe(0);
    expect(statusDown.stdout).toContain('stopped');
  });

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
  });

  it(
    'captures per-child logs and survives launching shell exit when detached',
    () => {
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

    const childLogs = managedChildRoles.map((role) => path.join(stateDir, `${role}.log`));
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (childLogs.every((logPath) => fs.existsSync(logPath))) {
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
    for (const logPath of childLogs) {
      expect(fs.existsSync(logPath)).toBe(true);
    }

    const statusMid = runSupervisor(['-Action', 'Status', '-StateDir', stateDir]);
    expect(statusMid.status).toBe(0);

    runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
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
    expect(observedPids.size).toBeLessThanOrEqual(4);
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
    },
    45_000,
  );
});

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
