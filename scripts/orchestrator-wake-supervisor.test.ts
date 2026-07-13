import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupSupervisorTests,
  freezeSupervisorPid,
  isAlive,
  makeStateDir,
  thawFrozenSupervisorPids,
  readChildPid,
  repoRoot,
  runSupervisor,
  runSupervisorAsync,
  startSupervisorBackground,
  waitForMarker,
  waitForSupervisorHealthyStatus,
} from './supervisor-recovery.test-helpers.js';

const supervisorScript = path.join(repoRoot, 'scripts/orchestrator-wake-supervisor.ps1');
const aoStub = path.join(repoRoot, 'scripts/fixtures/orchestrator-wake-supervisor/ao-stub.sh');
const genericChildRole = 'review-trigger-reconcile' as const;
const sessionBoundRole = 'escalation-router' as const;
const fleetTimeoutMs = 360_000;
const fleetLeaseEnv: Record<string, string> = {
  AO_WAKE_SUPERVISOR_LEASE_HEARTBEAT_TTL_MS: '600000',
  AO_WAKE_SUPERVISOR_LEASE_STALE_GRACE_MS: '30000',
  AO_WAKE_SUPERVISOR_RESTART_STAGGER_MS: '0',
  AO_WAKE_SUPERVISOR_ID_DEBOUNCE_POLLS: '1',
  AO_WAKE_SUPERVISOR_START_HANDOFF_TIMEOUT_SEC: '90',
};

afterEach(() => {
  cleanupSupervisorTests();
}, fleetTimeoutMs);

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLease(stateDir: string, timeoutMs = 120_000): Promise<void> {
  const leasePath = path.join(stateDir, 'supervisor.lock');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(leasePath) && fs.readFileSync(leasePath, 'utf8').trim().length > 0) {
      return;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for supervisor.lock at ${leasePath}`);
}

async function waitForSupervisorPid(stateDir: string, timeoutMs = 180_000): Promise<number> {
  const pidPath = path.join(stateDir, 'supervisor.pid');
  const leasePath = path.join(stateDir, 'supervisor.lock');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let pid = 0;
    if (fs.existsSync(leasePath)) {
      try {
        const lease = JSON.parse(fs.readFileSync(leasePath, 'utf8')) as { holderPid?: number };
        pid = Number(lease.holderPid ?? 0);
      } catch {
        pid = 0;
      }
    }
    if (pid <= 0 && fs.existsSync(pidPath)) {
      pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
    }
    if (pid > 0 && isAlive(pid)) {
      return pid;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for live supervisor holder at ${pidPath}`);
}

function tryReadChildPid(stateDir: string, childId: string): number {
  const pidPath = path.join(stateDir, `${childId}.pid`);
  if (!fs.existsSync(pidPath)) {
    return 0;
  }
  const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
  return Number.isFinite(pid) ? pid : 0;
}

function readLease(stateDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'supervisor.lock'), 'utf8')) as Record<
    string,
    unknown
  >;
}

function capturedSupervisorCommandLine(stateDir: string): string {
  return [
    'pwsh',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    supervisorScript,
    '-Action',
    'Start',
    '-SupervisorLoop',
    '-ProjectId',
    'orchestrator-pack',
    '-PollSeconds',
    '120',
    '-StateDir',
    stateDir,
  ].join(' ');
}

function makeForeignCheckoutDir(): string {
  const checkoutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-checkout-b-'));
  const scriptsDir = path.join(checkoutDir, 'scripts');
  const libDir = path.join(scriptsDir, 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  fs.copyFileSync(supervisorScript, path.join(scriptsDir, 'orchestrator-wake-supervisor.ps1'));
  for (const file of [
    'orchestrator-side-process-registry.json',
    'orchestrator-wake-supervisor-test-child.ps1',
  ]) {
    fs.copyFileSync(path.join(repoRoot, 'scripts', file), path.join(scriptsDir, file));
  }
  for (const name of fs.readdirSync(path.join(repoRoot, 'scripts/lib'))) {
    if (!name.endsWith('.ps1')) {
      continue;
    }
    fs.copyFileSync(path.join(repoRoot, 'scripts/lib', name), path.join(libDir, name));
  }
  return path.join(scriptsDir, 'orchestrator-wake-supervisor.ps1');
}

function startDetachedLeaseHolder(stateDir: string, sessionId: string) {
  return runSupervisorAsync(
    [
      '-Action',
      'Start',
      '-SkipInitialWait',
      '-OrchestratorSessionId',
      sessionId,
      '-StateDir',
      stateDir,
      '-PollSeconds',
      '5',
    ],
    fleetLeaseEnv,
    fleetTimeoutMs,
  );
}

function freezeProcess(pid: number): void {
  freezeSupervisorPid(pid);
}

async function startAfterStaleLiveGrace(
  stateDir: string,
  sessionId: string,
  env: Record<string, string>,
  holderPid: number,
) {
  freezeProcess(holderPid);
  await sleep(3500);
  const startArgs = [
    '-Action',
    'Start',
    '-SkipInitialWait',
    '-OrchestratorSessionId',
    sessionId,
    '-StateDir',
    stateDir,
    '-PollSeconds',
    '1',
  ];
  let result = await runSupervisorAsync(startArgs, env, fleetTimeoutMs);
  let audit = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  for (let attempt = 0; attempt < 5 && !/wake-supervisor-audit kind=stale-live-reclaim/.test(audit); attempt++) {
    if (!/grace pending|reclaim failed|lease contended/i.test(audit)) {
      break;
    }
    await sleep(800);
    result = await runSupervisorAsync(startArgs, env, fleetTimeoutMs);
    audit = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  }
  return { result, audit };
}

function startTestSupervisorLoop(stateDir: string, sessionId: string) {
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
      '-SupervisorLoop',
      '-TestMode',
      '-SkipInitialWait',
      '-StateDir',
      stateDir,
      '-OrchestratorSessionId',
      sessionId,
      '-PollSeconds',
      '5',
    ],
    { cwd: repoRoot, stdio: 'ignore' },
  );
}

function spawnAmbiguousSleepPid(): number {
  const result = spawnSync(
    'bash',
    ['-c', "nohup pwsh -NoProfile -Command 'Start-Sleep 300' >/dev/null 2>&1 & echo $!"],
    { encoding: 'utf8', env: { ...process.env, ...fleetLeaseEnv } },
  );
  return Number((result.stdout ?? '').trim());
}

function spawnAmbiguousSupervisorFleet(stateDir: string): {
  fixturePath: string;
  firstPid: number;
  secondPid: number;
} {
  const fixturePath = path.join(stateDir, 'cmdline-fixture.json');
  const commandLine = capturedSupervisorCommandLine(stateDir);
  const firstPid = spawnAmbiguousSleepPid();
  const secondPid = spawnAmbiguousSleepPid();
  expect(firstPid).toBeGreaterThan(0);
  expect(secondPid).toBeGreaterThan(0);
  fs.writeFileSync(
    fixturePath,
    JSON.stringify({
      [String(firstPid)]: commandLine,
      [String(secondPid)]: commandLine,
    }),
  );
  fs.writeFileSync(path.join(stateDir, 'supervisor.pid'), String(firstPid));
  return { fixturePath, firstPid, secondPid };
}

describe.sequential.skip('orchestrator-wake-supervisor fleet cardinality (#709) [parked wall-clock e2e → #694]', () => {
  beforeEach(() => {
    thawFrozenSupervisorPids();
  });

  it(
    'C1: second Start on same checkout is idempotent when lease holder is live',
    async () => {
      const stateDir = makeStateDir();
      const first = await startDetachedLeaseHolder(stateDir, 'fleet-c1');
      expect(first.status).toBe(0);
      expect(first.stdout).toContain('supervisor detached');
      await waitForLease(stateDir);
      await waitForSupervisorPid(stateDir);

      const second = await runSupervisorAsync(
        [
          '-Action',
          'Start',
          '-SkipInitialWait',
          '-OrchestratorSessionId',
          'fleet-c1',
          '-StateDir',
          stateDir,
        ],
        fleetLeaseEnv,
        fleetTimeoutMs,
      );
      expect(second.status).toBe(0);
      expect(second.stderr + second.stdout).toMatch(/already running/i);

      runSupervisor(['-Action', 'Stop', '-Force', '-StateDir', stateDir], fleetLeaseEnv);
    },
    fleetTimeoutMs,
  );

  it(
    'C3: cross-checkout Start refuses when state-root lease is already held',
    async () => {
      const stateDir = makeStateDir();
      const foreignScript = makeForeignCheckoutDir();
      const holder = await startDetachedLeaseHolder(stateDir, 'fleet-c3-holder');
      expect(holder.status).toBe(0);
      await waitForLease(stateDir);
      await waitForSupervisorHealthyStatus(stateDir, 60_000);

      const blocked = spawnSync(
        'pwsh',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          foreignScript,
          '-Action',
          'Start',
          '-SkipInitialWait',
          '-OrchestratorSessionId',
          'fleet-c3',
          '-StateDir',
          stateDir,
          '-PollSeconds',
          '5',
        ],
        {
          cwd: path.dirname(foreignScript),
          encoding: 'utf8',
          timeout: fleetTimeoutMs,
          env: { ...process.env, ...fleetLeaseEnv },
        },
      );
      expect(blocked.status).not.toBe(0);
      expect((blocked.stderr ?? '') + (blocked.stdout ?? '')).toMatch(
        /cross-checkout|foreign|already running/i,
      );

      const foreignStatus = spawnSync(
        'pwsh',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          foreignScript,
          '-Action',
          'Status',
          '-StateDir',
          stateDir,
        ],
        { cwd: path.dirname(foreignScript), encoding: 'utf8', timeout: 60_000 },
      );
      expect(foreignStatus.stdout).toMatch(/supervisor: running/i);

      const lease = readLease(stateDir);
      const holderPid = Number(lease.holderPid);
      expect(holderPid).toBeGreaterThan(0);
      expect(isAlive(holderPid)).toBe(true);

      runSupervisor(['-Action', 'Stop', '-Force', '-StateDir', stateDir], fleetLeaseEnv);
    },
    fleetTimeoutMs,
  );

  it(
    'C10: ordinary Stop blocks on ambiguous fleet; Force clears supervisors and children',
    async () => {
      const stateDir = makeStateDir();
      const { fixturePath, firstPid, secondPid } = spawnAmbiguousSupervisorFleet(stateDir);
      const fixtureEnv = { ...fleetLeaseEnv, AO_WAKE_SUPERVISOR_PROCESS_CMDLINE_FIXTURE: fixturePath };

      const ordinary = runSupervisor(['-Action', 'Stop', '-StateDir', stateDir], fixtureEnv);
      expect(ordinary.status).not.toBe(0);
      expect(ordinary.stderr + ordinary.stdout).toMatch(/ambiguous|blocked|Force/i);

      const forced = runSupervisor(['-Action', 'Stop', '-Force', '-StateDir', stateDir], fixtureEnv);
      expect(forced.status).toBe(0);
      const audit = forced.stdout + forced.stderr;
      expect(audit).toMatch(/wake-supervisor-audit kind=force-stop/);
      expect(audit).toMatch(/matchedSupervisorCount=/);
      expect(audit).toMatch(/matchedChildCount=/);
      expect(audit).toMatch(/leaseEpoch=/);
      expect(audit).toMatch(/killed=/);

      for (const pid of [firstPid, secondPid]) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
      await sleep(2000);
      const status = runSupervisor(['-Action', 'Status', '-StateDir', stateDir], fixtureEnv);
      expect(status.stdout).toContain('supervisor: stopped');
    },
    fleetTimeoutMs,
  );

  it(
    'lease file is created and held by detached supervisor loop (#552 / AC#13-14)',
    async () => {
      const stateDir = makeStateDir();
      const start = await startDetachedLeaseHolder(stateDir, 'fleet-lease-detach');
      expect(start.status).toBe(0);
      await waitForLease(stateDir);
      const holderPid = await waitForSupervisorPid(stateDir);
      const lease = readLease(stateDir);
      expect(Number(lease.holderPid)).toBe(holderPid);
      expect(isAlive(holderPid)).toBe(true);

      runSupervisor(['-Action', 'Stop', '-Force', '-StateDir', stateDir], fleetLeaseEnv);
    },
    fleetTimeoutMs,
  );

  it('legacy no-lock holder blocks Start until Force (AC#8b)', async () => {
    const stateDir = makeStateDir();
    const legacy = startTestSupervisorLoop(stateDir, 'fleet-legacy');
    await waitForSupervisorPid(stateDir, 90_000);
    if (fs.existsSync(path.join(stateDir, 'supervisor.lock'))) {
      fs.unlinkSync(path.join(stateDir, 'supervisor.lock'));
    }
    await sleep(3000);

    const blocked = await runSupervisorAsync(
      [
        '-Action',
        'Start',
        '-SkipInitialWait',
        '-OrchestratorSessionId',
        'fleet-legacy-2',
        '-StateDir',
        stateDir,
      ],
      fleetLeaseEnv,
      fleetTimeoutMs,
    );
    expect(blocked.status).not.toBe(0);
    const blockedText = `${blocked.stderr ?? ''}${blocked.stdout ?? ''}`;
    if (!/legacy|already running/i.test(blockedText)) {
      const logPath = path.join(stateDir, 'supervisor.log');
      const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
      expect(blockedText + logText).toMatch(/legacy|already running/i);
    }

    legacy.kill('SIGTERM');
    runSupervisor(['-Action', 'Stop', '-Force', '-StateDir', stateDir], fleetLeaseEnv);
  }, fleetTimeoutMs);

  it('stale dead-pid lease is reclaimed on Start (AC#10)', async () => {
    const stateDir = makeStateDir();
    const leasePath = path.join(stateDir, 'supervisor.lock');
    fs.writeFileSync(
      leasePath,
      JSON.stringify({
        epoch: 1,
        holderPid: 999999,
        holderStartTimeMs: 1,
        bootId: 'dead-pid-fixture',
        heartbeatMs: 1,
        projectId: 'orchestrator-pack',
        holderScriptPath: supervisorScript,
        staleGraceStartMs: 0,
      }),
    );

    const start = await runSupervisorAsync(
      [
        '-Action',
        'Start',
        '-SkipInitialWait',
        '-OrchestratorSessionId',
        'fleet-stale-dead',
        '-StateDir',
        stateDir,
        '-PollSeconds',
        '5',
      ],
      fleetLeaseEnv,
      fleetTimeoutMs,
    );
    expect(start.status).toBe(0);
    await waitForLease(stateDir);
    const lease = readLease(stateDir);
    expect(Number(lease.holderPid)).toBeGreaterThan(0);
    expect(Number(lease.holderPid)).not.toBe(999999);
    expect(isAlive(Number(lease.holderPid))).toBe(true);

    runSupervisor(['-Action', 'Stop', '-Force', '-StateDir', stateDir], fleetLeaseEnv);
  }, fleetTimeoutMs);

  it('C9: session flap restarts the session-bound child without duplicates', async () => {
    const stateDir = makeStateDir();
    const fixturePath = path.join(stateDir, 'session-fixture.json');
    fs.copyFileSync(
      path.join(repoRoot, 'scripts/fixtures/orchestrator-wake-supervisor/status-orchestrator-op-old.json'),
      fixturePath,
    );
    const supervisor = startSupervisorBackground(
      stateDir,
      ['-FixturePath', fixturePath, '-AoCommand', aoStub],
      fleetLeaseEnv,
    );
    await waitForMarker(stateDir, sessionBoundRole, 150_000);
    const firstPid = readChildPid(stateDir, sessionBoundRole);
    expect(firstPid).toBeGreaterThan(0);

    fs.copyFileSync(
      path.join(repoRoot, 'scripts/fixtures/orchestrator-wake-supervisor/status-orchestrator-op-new.json'),
      fixturePath,
    );
    const deadline = Date.now() + 120_000;
    let secondPid = 0;
    while (Date.now() < deadline) {
      const markerPath = path.join(stateDir, 'markers', `${sessionBoundRole}.marker.json`);
      if (fs.existsSync(markerPath)) {
        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as {
          pid?: number;
          orchestratorSessionId?: string;
        };
        if (
          marker.orchestratorSessionId === 'op-orchestrator-new' &&
          marker.pid &&
          marker.pid > 0 &&
          marker.pid !== firstPid
        ) {
          secondPid = marker.pid;
          break;
        }
      }
      await sleep(500);
    }
    expect(secondPid).toBeGreaterThan(0);
    expect(secondPid).not.toBe(firstPid);
    expect(isAlive(firstPid)).toBe(false);
    expect(isAlive(secondPid)).toBe(true);

    supervisor.kill('SIGTERM');
    runSupervisor(['-Action', 'Stop', '-Force', '-StateDir', stateDir], fleetLeaseEnv);
  }, fleetTimeoutMs);


  it('C11: enumerate-all reap leaves at most one duplicate managed child', async () => {
    const stateDir = makeStateDir();
    const markerDir = path.join(stateDir, 'markers');
    fs.mkdirSync(markerDir, { recursive: true });
    const sessionId = 'fleet-c11';
    const spawnTestChild = (role: string): number => {
      const child = spawn(
        'pwsh',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(repoRoot, 'scripts/orchestrator-wake-supervisor-test-child.ps1'),
          '-Role',
          role,
          '-OrchestratorSessionId',
          sessionId,
          '-ProjectId',
          'orchestrator-pack',
          '-MarkerDir',
          markerDir,
        ],
        {
          detached: true,
          stdio: 'ignore',
          env: {
            ...process.env,
            ...fleetLeaseEnv,
            AO_WAKE_SUPERVISOR_TEST_MARKER_DIR: markerDir,
            AO_SIDE_PROCESS_STATE_DIR: stateDir,
          },
        },
      );
      child.unref();
      return child.pid ?? 0;
    };
    const start = await startDetachedLeaseHolder(stateDir, sessionId);
    expect(start.status).toBe(0);
    await waitForSupervisorPid(stateDir);
    const dup1 = spawnTestChild(genericChildRole);
    const dup2 = spawnTestChild(genericChildRole);
    const dup3 = spawnTestChild(genericChildRole);
    expect(dup1).toBeGreaterThan(0);
    expect(dup2).toBeGreaterThan(0);
    expect(dup3).toBeGreaterThan(0);
    fs.writeFileSync(path.join(stateDir, `${genericChildRole}.pid`), String(dup1));
    await sleep(2000);
    const lib = path.join(repoRoot, 'scripts/lib/Orchestrator-WakeSupervisor.ps1').replace(/'/g, "''");
    const countCommand = `. '${lib}'; $paths = Get-OrchestratorWakeSupervisorPaths -StateRoot '${stateDir.replace(/'/g, "''")}'; $pids = Find-OrchestratorWakeSupervisorManagedChildCandidatesForState -Paths $paths -ProjectId orchestrator-pack -ChildId '${genericChildRole}'; Write-Output (($pids | Sort-Object -Unique).Count)`;
    const deadline = Date.now() + 120_000;
    let liveCount = 3;
    while (Date.now() < deadline) {
      const countResult = spawnSync(
        'pwsh',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', countCommand],
        { encoding: 'utf8', env: { ...process.env, ...fleetLeaseEnv } },
      );
      liveCount = Number((countResult.stdout ?? '').trim());
      if (liveCount <= 1) {
        break;
      }
      await sleep(1000);
    }
    expect(liveCount).toBeLessThanOrEqual(1);
    runSupervisor(['-Action', 'Stop', '-Force', '-StateDir', stateDir], fleetLeaseEnv);
  }, fleetTimeoutMs);


  it(
    'C2: concurrent Start leaves at most one live lease holder',
    async () => {
      const stateDir = makeStateDir();
      const startArgs = [
        '-Action',
        'Start',
        '-SkipInitialWait',
        '-OrchestratorSessionId',
        'fleet-c2',
        '-StateDir',
        stateDir,
        '-PollSeconds',
        '5',
      ];
      const [first, second] = await Promise.all([
        runSupervisorAsync(startArgs, fleetLeaseEnv, fleetTimeoutMs),
        runSupervisorAsync(startArgs, fleetLeaseEnv, fleetTimeoutMs),
      ]);
      const outputs = [first, second].map((r) => (r.stderr ?? '') + (r.stdout ?? ''));
      const anyDetached = outputs.some((o) => /supervisor detached|already running/i.test(o));
      const anyBlocked = outputs.some((o) => /already running|start.*in progress|start blocked/i.test(o));
      const anySuccess = [first, second].some((r) => r.status === 0);
      expect(anySuccess || anyDetached || anyBlocked).toBe(true);
      const holderPid = await waitForSupervisorPid(stateDir);
      expect(isAlive(holderPid)).toBe(true);
      expect(anyBlocked || first.status !== second.status || anyDetached).toBe(true);
      runSupervisor(['-Action', 'Stop', '-Force', '-StateDir', stateDir], fleetLeaseEnv);
    },
    fleetTimeoutMs,
  );

  it('pid-reuse stale lease is reclaimed on Start (AC#11)', async () => {
    const stateDir = makeStateDir();
    const sleeper = spawnSync(
      'bash',
      ['-c', "nohup pwsh -NoProfile -Command 'Start-Sleep 120' >/dev/null 2>&1 & echo $!"],
      { encoding: 'utf8' },
    );
    const reusedPid = Number((sleeper.stdout ?? '').trim());
    expect(reusedPid).toBeGreaterThan(0);
    const leasePath = path.join(stateDir, 'supervisor.lock');
    fs.writeFileSync(
      leasePath,
      JSON.stringify({
        epoch: 3,
        holderPid: reusedPid,
        holderStartTimeMs: 1,
        bootId: 'pid-reuse-fixture',
        heartbeatMs: Date.now(),
        projectId: 'orchestrator-pack',
        holderScriptPath: supervisorScript,
        staleGraceStartMs: 0,
      }),
    );

    const start = await runSupervisorAsync(
      [
        '-Action',
        'Start',
        '-SkipInitialWait',
        '-OrchestratorSessionId',
        'fleet-pid-reuse',
        '-StateDir',
        stateDir,
        '-PollSeconds',
        '5',
      ],
      fleetLeaseEnv,
      fleetTimeoutMs,
    );
    expect(start.status).toBe(0);
    await waitForLease(stateDir);
    const holderPid = await waitForSupervisorPid(stateDir, 240_000);
    expect(holderPid).not.toBe(reusedPid);
    const lease = readLease(stateDir);
    expect(Number(lease.holderPid)).toBe(holderPid);
    try {
      process.kill(reusedPid, 'SIGKILL');
    } catch {
      // ignore
    }
    runSupervisor(['-Action', 'Stop', '-Force', '-StateDir', stateDir], fleetLeaseEnv);
  }, fleetTimeoutMs);

  it('stale-live heartbeat reclaim emits audit after grace (AC#12)', async () => {
    const stateDir = makeStateDir();
    const staleEnv = {
      ...fleetLeaseEnv,
      AO_WAKE_SUPERVISOR_LEASE_HEARTBEAT_TTL_MS: '1000',
      AO_WAKE_SUPERVISOR_LEASE_STALE_GRACE_MS: '500',
    };
    const holder = await runSupervisorAsync(
      [
        '-Action',
        'Start',
        '-SkipInitialWait',
        '-OrchestratorSessionId',
        'fleet-stale-live',
        '-StateDir',
        stateDir,
        '-PollSeconds',
        '5',
      ],
      staleEnv,
      fleetTimeoutMs,
    );
    expect(holder.status).toBe(0);
    const firstPid = await waitForSupervisorPid(stateDir);
    const firstEpoch = Number(readLease(stateDir).epoch);
    const { result: reclaim, audit } = await startAfterStaleLiveGrace(
      stateDir,
      'fleet-stale-live-2',
      staleEnv,
      firstPid,
    );
    try {
      process.kill(firstPid, 'SIGCONT');
    } catch {
      // ignore
    }
    expect(reclaim.status).toBe(0);
    expect(audit).toMatch(/wake-supervisor-audit kind=stale-live-reclaim/);
    const newPid = await waitForSupervisorPid(stateDir, 240_000);
    const newLease = readLease(stateDir);
    expect(newPid).toBeGreaterThan(0);
    expect(Number(newLease.epoch)).toBeGreaterThanOrEqual(firstEpoch);
    expect(newPid).not.toBe(firstPid);
    try {
      process.kill(firstPid, 'SIGKILL');
    } catch {
      // ignore
    }
    runSupervisor(['-Action', 'Stop', '-Force', '-StateDir', stateDir], staleEnv);
  }, fleetTimeoutMs);

  it('C4: supervisor loop exits after lease is stolen by reclaim', async () => {
    const stateDir = makeStateDir();
    const stealEnv = {
      ...fleetLeaseEnv,
      AO_WAKE_SUPERVISOR_LEASE_HEARTBEAT_TTL_MS: '1000',
      AO_WAKE_SUPERVISOR_LEASE_STALE_GRACE_MS: '500',
    };
    const loop = spawn(
      'pwsh',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        supervisorScript,
        '-Action',
        'Start',
        '-SupervisorLoop',
        '-TestMode',
        '-SkipInitialWait',
        '-StateDir',
        stateDir,
        '-OrchestratorSessionId',
        'fleet-c4',
        '-PollSeconds',
        '1',
      ],
      { cwd: repoRoot, stdio: 'ignore', env: { ...process.env, ...stealEnv } },
    );
    const firstPid = await waitForSupervisorPid(stateDir, 90_000);
    const { result: challenger } = await startAfterStaleLiveGrace(
      stateDir,
      'fleet-c4-new',
      stealEnv,
      firstPid,
    );
    expect(challenger.status).toBe(0);
    const deadline = Date.now() + 60_000;
    let lost = false;
    while (Date.now() < deadline) {
      const log = fs.existsSync(path.join(stateDir, 'supervisor.log'))
        ? fs.readFileSync(path.join(stateDir, 'supervisor.log'), 'utf8')
        : '';
      if (/lease lost/i.test(log)) {
        lost = true;
        break;
      }
      if (!isAlive(firstPid)) {
        lost = true;
        break;
      }
      await sleep(500);
    }
    expect(lost).toBe(true);
    try {
      loop.kill('SIGTERM');
    } catch {
      // ignore
    }
    runSupervisor(['-Action', 'Stop', '-Force', '-StateDir', stateDir], stealEnv);
  }, fleetTimeoutMs);

  it('AC#6: force-stop child discovery filters by project on shared state root', async () => {
    const stateDir = makeStateDir();
    const markerRoot = path.join(stateDir, 'markers');
    const packMarkerDir = path.join(markerRoot, 'pack');
    const foreignMarkerDir = path.join(markerRoot, 'foreign');
    fs.mkdirSync(packMarkerDir, { recursive: true });
    fs.mkdirSync(foreignMarkerDir, { recursive: true });
    const spawnTaggedChild = (projectId: string, markerDir: string): number => {
      const child = spawn(
        'pwsh',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(repoRoot, 'scripts/orchestrator-wake-supervisor-test-child.ps1'),
          '-Role',
          genericChildRole,
          '-OrchestratorSessionId',
          'fleet-force-project',
          '-ProjectId',
          projectId,
          '-MarkerDir',
          markerDir,
        ],
        {
          detached: true,
          stdio: 'ignore',
          env: {
            ...process.env,
            AO_WAKE_SUPERVISOR_TEST_MARKER_DIR: markerDir,
            AO_SIDE_PROCESS_STATE_DIR: stateDir,
          },
        },
      );
      child.unref();
      return child.pid ?? 0;
    };
    const packPid = spawnTaggedChild('orchestrator-pack', packMarkerDir);
    const foreignPid = spawnTaggedChild('other-ao-project', foreignMarkerDir);
    expect(packPid).toBeGreaterThan(0);
    expect(foreignPid).toBeGreaterThan(0);
    await sleep(3000);
    const lib = path.join(repoRoot, 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1').replace(/'/g, "''");
    const stateEsc = stateDir.replace(/'/g, "''");
    const identityCommand = (pid: number, projectId: string) =>
      `. '${lib}'; Write-Output ([bool](Test-OrchestratorWakeSupervisorManagedChildProjectIdentity -ProcessId ${pid} -Role '${genericChildRole}' -ProjectId '${projectId}'))`;
    const packIdentity = spawnSync(
      'pwsh',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', identityCommand(packPid, 'orchestrator-pack')],
      { encoding: 'utf8', env: { ...process.env, ...fleetLeaseEnv } },
    );
    const foreignIdentity = spawnSync(
      'pwsh',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', identityCommand(foreignPid, 'orchestrator-pack')],
      { encoding: 'utf8', env: { ...process.env, ...fleetLeaseEnv } },
    );
    expect((packIdentity.stdout ?? '').trim()).toBe('True');
    expect((foreignIdentity.stdout ?? '').trim()).toBe('False');
    const findCommand = `. '${lib}'; $paths = Get-OrchestratorWakeSupervisorPaths -StateRoot '${stateEsc}'; $pids = Find-OrchestratorWakeSupervisorManagedChildCandidatesForState -Paths $paths -ProjectId orchestrator-pack -ChildId '${genericChildRole}'; Write-Output (($pids | Sort-Object -Unique) -join ',')`;
    const findResult = spawnSync(
      'pwsh',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', findCommand],
      { encoding: 'utf8', env: { ...process.env, ...fleetLeaseEnv } },
    );
    const matched = (findResult.stdout ?? '')
      .trim()
      .split(',')
      .map((v) => Number(v))
      .filter((v) => v > 0);
    expect(matched).toContain(packPid);
    expect(matched).not.toContain(foreignPid);

    const adoptCommand = `. '${lib}'; $paths = Get-OrchestratorWakeSupervisorPaths -StateRoot '${stateEsc}'; $map = Find-OrchestratorWakeSupervisorAdoptableProcesses -Paths $paths -ProjectId orchestrator-pack; if ($map.ContainsKey('${genericChildRole}')) { Write-Output $map['${genericChildRole}'] } else { Write-Output '0' }`;
    const adoptResult = spawnSync(
      'pwsh',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', adoptCommand],
      { encoding: 'utf8', env: { ...process.env, ...fleetLeaseEnv } },
    );
    expect(Number((adoptResult.stdout ?? '').trim())).toBe(packPid);

    const childPidPath = path.join(stateDir, `${genericChildRole}.pid`);
    fs.writeFileSync(childPidPath, String(foreignPid));
    const foreignStatusCommand = `. '${lib}'; $paths = Get-OrchestratorWakeSupervisorPaths -StateRoot '${stateEsc}'; $s = Get-OrchestratorWakeSupervisorChildStatusEntry -Paths $paths -ChildId '${genericChildRole}' -ProjectId orchestrator-pack; Write-Output $s.Alive`;
    const foreignStatus = spawnSync(
      'pwsh',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', foreignStatusCommand],
      { encoding: 'utf8', env: { ...process.env, ...fleetLeaseEnv } },
    );
    expect((foreignStatus.stdout ?? '').trim()).toBe('False');
    fs.writeFileSync(childPidPath, String(packPid));
    const packStatus = spawnSync(
      'pwsh',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', foreignStatusCommand],
      { encoding: 'utf8', env: { ...process.env, ...fleetLeaseEnv } },
    );
    expect((packStatus.stdout ?? '').trim()).toBe('True');

    const heartbeatChild = spawn(
      'pwsh',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(repoRoot, 'scripts/orchestrator-wake-supervisor-test-child.ps1'),
        '-Role',
        'heartbeat',
        '-OrchestratorSessionId',
        'fleet-force-project',
        '-MarkerDir',
        packMarkerDir,
      ],
      {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          AO_WAKE_SUPERVISOR_TEST_MARKER_DIR: packMarkerDir,
          AO_SIDE_PROCESS_STATE_DIR: stateDir,
        },
      },
    );
    heartbeatChild.unref();
    const heartbeatPid = heartbeatChild.pid ?? 0;
    expect(heartbeatPid).toBeGreaterThan(0);
    await sleep(2000);
    const heartbeatFindCommand = `. '${lib}'; $paths = Get-OrchestratorWakeSupervisorPaths -StateRoot '${stateEsc}'; $pids = Find-OrchestratorWakeSupervisorManagedChildCandidatesForState -Paths $paths -ProjectId orchestrator-pack -ChildId heartbeat; Write-Output (($pids | Sort-Object -Unique) -join ',')`;
    const heartbeatFind = spawnSync(
      'pwsh',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', heartbeatFindCommand],
      { encoding: 'utf8', env: { ...process.env, ...fleetLeaseEnv } },
    );
    const heartbeatMatched = (heartbeatFind.stdout ?? '')
      .trim()
      .split(',')
      .map((v) => Number(v))
      .filter((v) => v > 0);
    expect(heartbeatMatched).toContain(heartbeatPid);

    try {
      process.kill(packPid, 'SIGKILL');
      process.kill(foreignPid, 'SIGKILL');
      if (heartbeatPid > 0) process.kill(heartbeatPid, 'SIGKILL');
    } catch {
      // ignore
    }
    runSupervisor(['-Action', 'Stop', '-Force', '-StateDir', stateDir], fleetLeaseEnv);
  }, fleetTimeoutMs);

  it('AC#8a: Start blocked while stop maintenance epoch is active', async () => {
    const stateDir = makeStateDir();
    fs.writeFileSync(
      path.join(stateDir, 'maintenance.epoch'),
      JSON.stringify({ reason: 'fixture', startedMs: Date.now() }),
    );
    const blocked = await runSupervisorAsync(
      [
        '-Action',
        'Start',
        '-SkipInitialWait',
        '-OrchestratorSessionId',
        'fleet-8a',
        '-StateDir',
        stateDir,
      ],
      fleetLeaseEnv,
      fleetTimeoutMs,
    );
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr + blocked.stdout).toMatch(/maintenance epoch active/i);
    fs.unlinkSync(path.join(stateDir, 'maintenance.epoch'));
  }, fleetTimeoutMs);
  it('AC#8c: ordinary Stop enters maintenance epoch to block concurrent Start', async () => {
    const stateDir = makeStateDir();
    const sessionId = 'fleet-8c';
    const start = await runSupervisorAsync(
      [
        '-Action',
        'Start',
        '-SkipInitialWait',
        '-OrchestratorSessionId',
        sessionId,
        '-StateDir',
        stateDir,
      ],
      fleetLeaseEnv,
      fleetTimeoutMs,
    );
    expect(start.status).toBe(0);
    await waitForSupervisorPid(stateDir);

    const maintenancePath = path.join(stateDir, 'maintenance.epoch');
    const stopPromise = runSupervisorAsync(
      ['-Action', 'Stop', '-StateDir', stateDir],
      fleetLeaseEnv,
      fleetTimeoutMs,
    );

    let sawMaintenance = false;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(maintenancePath)) {
        sawMaintenance = true;
        const blocked = await runSupervisorAsync(
          [
            '-Action',
            'Start',
            '-SkipInitialWait',
            '-OrchestratorSessionId',
            sessionId,
            '-StateDir',
            stateDir,
          ],
          fleetLeaseEnv,
          30_000,
        );
        expect(blocked.status).not.toBe(0);
        expect(blocked.stderr + blocked.stdout).toMatch(/maintenance epoch active/i);
        break;
      }
      await sleep(200);
    }
    expect(sawMaintenance).toBe(true);
    const stop = await stopPromise;
    expect(stop.status).toBe(0);
    expect(fs.existsSync(maintenancePath)).toBe(false);
  }, fleetTimeoutMs);

});
