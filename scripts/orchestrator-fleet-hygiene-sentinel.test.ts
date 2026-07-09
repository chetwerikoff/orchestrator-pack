import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupSupervisorTests,
  makeStateDir,
  psString,
  repoRoot,

} from './supervisor-recovery.test-helpers.js';

const sentinelScript = path.join(repoRoot, 'scripts/orchestrator-fleet-hygiene-sentinel.ps1');
const hygieneLib = path.join(repoRoot, 'scripts/lib/Orchestrator-FleetHygiene.ps1');
const supervisorLib = path.join(repoRoot, 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1');
const wakeSupervisorScript = path.join(repoRoot, 'scripts/orchestrator-wake-supervisor.ps1');
const guardScript = path.join(repoRoot, 'scripts/check-fleet-hygiene-sentinel.ps1');

const registryRoles = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'scripts/orchestrator-side-process-registry.json'), 'utf8'),
).requiredChildIds as string[];
const testChildScript = path.join(repoRoot, 'scripts/orchestrator-wake-supervisor-test-child.ps1');

function buildCleanRegistryFleetFixtures(stateDir: string, supervisorPid: number) {
  const cmdMap: Record<number, string> = {
    [supervisorPid]: supervisorCommandLine(stateDir),
  };
  const envMap: Record<number, Record<string, string>> = {};
  const pids = [supervisorPid];
  let nextPid = supervisorPid + 1;
  for (const role of registryRoles) {
    const pid = nextPid++;
    pids.push(pid);
    cmdMap[pid] =
      `pwsh -NoProfile -File ${testChildScript} -Role ${role} -MarkerDir ${path.join(stateDir, 'markers')}`;
    envMap[pid] = {
      AO_SIDE_PROCESS_STATE_DIR: stateDir,
      AO_SIDE_PROCESS_CHILD_ID: role,
    };
    fs.writeFileSync(path.join(stateDir, `${role}.pid`), String(pid));
  }
  fs.writeFileSync(path.join(stateDir, 'supervisor.pid'), String(supervisorPid));
  return { cmdMap, envMap, pids };
}


vi.setConfig({ testTimeout: 420_000, hookTimeout: 30_000 });


function runPwshWithEnv(script: string, env: Record<string, string> = {}) {
  return spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 300_000,
  });
}

afterEach(() => {
  cleanupSupervisorTests();
});

function runSentinel(args: string[], env: Record<string, string> = {}) {
  return spawnSync(
    'pwsh',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', sentinelScript, ...args],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 300_000,
    },
  );
}

function supervisorCommandLine(stateDir: string, extraArgs: string[] = []): string {
  return [
    'pwsh',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    wakeSupervisorScript,
    '-Action',
    'Start',
    '-SupervisorLoop',
    '-ProjectId',
    'orchestrator-pack',
    '-PollSeconds',
    '120',
    '-OrchestratorSessionId',
    'op-fleet-hygiene',
    '-StateDir',
    stateDir,
    '-TestMode',
    ...extraArgs,
  ].join(' ');
}

function writeCmdlineFixture(fixturePath: string, pidMap: Record<number, string>): void {
  const payload: Record<string, string> = {};
  for (const [pid, commandLine] of Object.entries(pidMap)) {
    payload[String(pid)] = commandLine;
  }
  fs.writeFileSync(fixturePath, JSON.stringify(payload));
}

function writeEnvFixture(
  fixturePath: string,
  pidMap: Record<number, Record<string, string>>,
): void {
  const payload: Record<string, Record<string, string>> = {};
  for (const [pid, env] of Object.entries(pidMap)) {
    payload[String(pid)] = env;
  }
  fs.writeFileSync(fixturePath, JSON.stringify(payload));
}

function evaluateHygiene(env: Record<string, string>) {
  const packRootArg = env.PACK_ROOT ? `-PackRoot ${psString(env.PACK_ROOT)}` : '';
  const script = `
    . ${psString(hygieneLib)}
    $config = Get-FleetHygieneConfig -StateDir ${psString(env.STATE_DIR ?? '')} ${packRootArg}
    $result = Invoke-FleetHygieneEvaluation -Config $config
    $result | ConvertTo-Json -Depth 6 -Compress
  `;
  const result = runPwshWithEnv(script, env);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout.trim()) as {
    PlatformSupported: boolean;
    AllPass: boolean;
    Assertions: Array<{ Id: string; Code: string; Pass: boolean; Reason: string }>;
  };
}

function runKillFromEvaluation(
  stateDir: string,
  env: Record<string, string>,
): number[] {
  const killLog = path.join(stateDir, 'kill-log.json');
  const script = `
    . ${psString(hygieneLib)}
    $config = Get-FleetHygieneConfig -StateDir ${psString(stateDir)} -KillEnable
    $evaluation = Invoke-FleetHygieneEvaluation -Config $config
    Invoke-FleetHygieneConservativeKill -Config $config -Assertions $evaluation.Assertions | ConvertTo-Json -Compress
  `;
  runPwshWithEnv(script, {
    ...env,
    AO_FLEET_HYGIENE_MOCK_KILL: '1',
    AO_FLEET_HYGIENE_KILL_LOG_FIXTURE: killLog,
  });
  if (!fs.existsSync(killLog)) {
    return [];
  }
  const raw = JSON.parse(fs.readFileSync(killLog, 'utf8')) as
    | number
    | number[]
    | { kills?: number[] }
    | Array<{ kills?: number[] }>;
  if (Array.isArray(raw)) {
    if (raw.length > 0 && typeof raw[0] === 'object' && raw[0] && 'kills' in raw[0]) {
      return (raw as Array<{ kills?: number[] }>).flatMap((entry) => entry.kills ?? []);
    }
    return raw as number[];
  }
  if (typeof raw === 'number') {
    return [raw];
  }
  return raw.kills ?? [];
}

describe('Issue #711 fleet hygiene sentinel', () => {
  it('static guard: sentinel absent from wake supervisor registry (AC#10)', () => {
    const result = spawnSync(
      'pwsh',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', guardScript],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/static guard passed/i);
  });

  it('unsupported platform fail-closed (AC#12)', () => {
    const stateDir = makeStateDir();
    const result = runSentinel(['-Action', 'Hygiene', '-StateDir', stateDir], {
      AO_FLEET_HYGIENE_FORCE_UNSUPPORTED_PLATFORM: '1',
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/unsupported platform/i);
  });

  it('dry-run default: H1 duplicate detects breach without kill (AC#2)', () => {
    const stateDir = makeStateDir();
    const cmdFixture = path.join(stateDir, 'cmdline.json');
    const canonical = 910001;
    const duplicate = 910002;
    writeCmdlineFixture(cmdFixture, {
      [canonical]: supervisorCommandLine(stateDir),
      [duplicate]: supervisorCommandLine(stateDir),
    });
    const killLog = path.join(stateDir, 'kill-log.json');

    const evalResult = evaluateHygiene({
      STATE_DIR: stateDir,
      AO_WAKE_SUPERVISOR_PROCESS_CMDLINE_FIXTURE: cmdFixture,
      AO_FLEET_HYGIENE_PWSH_PIDS_FIXTURE: JSON.stringify([canonical, duplicate]),
      AO_FLEET_HYGIENE_ALIVE_PIDS_FIXTURE: JSON.stringify([canonical, duplicate]),
      AO_FLEET_HYGIENE_STATUS_EXIT_CODE: '0',
    });
    const h1 = evalResult.Assertions.find((row) => row.Id === 'H1');
    expect(h1?.Pass).toBe(false);
    expect(h1?.Code).toBe('H1_DUPLICATE_SUPERVISOR');

    const sentinel = runSentinel(['-Action', 'Sentinel', '-StateDir', stateDir], {
      AO_WAKE_SUPERVISOR_PROCESS_CMDLINE_FIXTURE: cmdFixture,
      AO_FLEET_HYGIENE_PWSH_PIDS_FIXTURE: JSON.stringify([canonical, duplicate]),
      AO_FLEET_HYGIENE_STATUS_EXIT_CODE: '0',
      AO_FLEET_HYGIENE_SKIP_SINGLETON: '1',
      AO_FLEET_HYGIENE_KILL_LOG_FIXTURE: killLog,
      AO_FLEET_HYGIENE_MOCK_KILL: '1',
    });
    expect(sentinel.status).not.toBe(0);
    expect(fs.existsSync(killLog)).toBe(false);
  });

  it('kill mode reaps duplicate supervisor and respects supervisor.lock (AC#3)', () => {
    const stateDir = makeStateDir();
    const cmdFixture = path.join(stateDir, 'cmdline.json');
    const canonical = 920001;
    const duplicate = 920002;
    writeCmdlineFixture(cmdFixture, {
      [canonical]: supervisorCommandLine(stateDir),
      [duplicate]: supervisorCommandLine(stateDir),
    });
    fs.writeFileSync(path.join(stateDir, 'supervisor.lock'), String(canonical));

    const reaped = runKillFromEvaluation(stateDir, {
      AO_WAKE_SUPERVISOR_PROCESS_CMDLINE_FIXTURE: cmdFixture,
      AO_FLEET_HYGIENE_PWSH_PIDS_FIXTURE: JSON.stringify([canonical, duplicate]),
      AO_FLEET_HYGIENE_ALIVE_PIDS_FIXTURE: JSON.stringify([canonical, duplicate]),
      AO_FLEET_HYGIENE_STATUS_EXIT_CODE: '0',
    });

    expect(reaped).toContain(duplicate);
    expect(reaped).not.toContain(canonical);
  });

  it('kill mode without supervisor.lock preserves #613 pid-file heuristic winner (AC#3)', () => {
    const stateDir = makeStateDir();
    const cmdFixture = path.join(stateDir, 'cmdline.json');
    const canonical = 930001;
    const duplicate = 930002;
    writeCmdlineFixture(cmdFixture, {
      [canonical]: supervisorCommandLine(stateDir),
      [duplicate]: supervisorCommandLine(stateDir),
    });
    fs.writeFileSync(path.join(stateDir, 'supervisor.pid'), String(canonical));

    const reaped = runKillFromEvaluation(stateDir, {
      AO_WAKE_SUPERVISOR_PROCESS_CMDLINE_FIXTURE: cmdFixture,
      AO_FLEET_HYGIENE_PWSH_PIDS_FIXTURE: JSON.stringify([canonical, duplicate]),
      AO_FLEET_HYGIENE_ALIVE_PIDS_FIXTURE: JSON.stringify([canonical, duplicate]),
      AO_FLEET_HYGIENE_STATUS_EXIT_CODE: '0',
    });

    expect(reaped).toContain(duplicate);
    expect(reaped).not.toContain(canonical);
  });
  it('H5 delegates to wake-supervisor Status exit code (AC#4)', () => {
    const stateDir = makeStateDir();
    const healthy = evaluateHygiene({
      STATE_DIR: stateDir,
      AO_FLEET_HYGIENE_STATUS_EXIT_CODE: '0',
      AO_FLEET_HYGIENE_PWSH_PIDS_FIXTURE: '[]',
    });
    expect(healthy.Assertions.find((row) => row.Id === 'H5')?.Pass).toBe(true);

    const unhealthy = evaluateHygiene({
      STATE_DIR: stateDir,
      AO_FLEET_HYGIENE_STATUS_EXIT_CODE: '1',
      AO_FLEET_HYGIENE_PWSH_PIDS_FIXTURE: '[]',
    });
    expect(unhealthy.Assertions.find((row) => row.Id === 'H5')?.Pass).toBe(false);
    expect(unhealthy.Assertions.find((row) => row.Id === 'H5')?.Code).toBe('H5_STATUS_UNHEALTHY');
  });

  it('H4 foreign checkout supervisor fails; same-checkout detached passes (AC#5)', () => {
    const stateDir = makeStateDir();
    const cmdFixture = path.join(stateDir, 'cmdline.json');
    const foreignRoot = path.join(os.tmpdir(), 'foreign-pack-root');
    const foreignScript = path.join(foreignRoot, 'scripts/orchestrator-wake-supervisor.ps1');
    const sameCheckoutPid = 930001;
    const foreignPid = 930002;

    writeCmdlineFixture(cmdFixture, {
      [sameCheckoutPid]: supervisorCommandLine(stateDir),
      [foreignPid]: supervisorCommandLine(stateDir).replace(wakeSupervisorScript, foreignScript),
    });

    const result = evaluateHygiene({
      STATE_DIR: stateDir,
      AO_WAKE_SUPERVISOR_PROCESS_CMDLINE_FIXTURE: cmdFixture,
      AO_FLEET_HYGIENE_PWSH_PIDS_FIXTURE: JSON.stringify([sameCheckoutPid, foreignPid]),
      AO_FLEET_HYGIENE_STATUS_EXIT_CODE: '0',
    });

    expect(result.Assertions.find((row) => row.Id === 'H4')?.Pass).toBe(false);
    expect(result.Assertions.find((row) => row.Id === 'H4')?.Code).toBe(
      'H4_FOREIGN_CHECKOUT_SUPERVISOR',
    );

    writeCmdlineFixture(cmdFixture, {
      [sameCheckoutPid]: supervisorCommandLine(stateDir),
    });
    const clean = evaluateHygiene({
      STATE_DIR: stateDir,
      AO_WAKE_SUPERVISOR_PROCESS_CMDLINE_FIXTURE: cmdFixture,
      AO_FLEET_HYGIENE_PWSH_PIDS_FIXTURE: JSON.stringify([sameCheckoutPid]),
      AO_FLEET_HYGIENE_STATUS_EXIT_CODE: '0',
    });
    expect(clean.Assertions.find((row) => row.Id === 'H4')?.Pass).toBe(true);
  });

  it('H3 unmanaged role-tagged pwsh fails; TestMode excluded (AC#6)', () => {
    const stateDir = makeStateDir();
    const envFixture = path.join(stateDir, 'env.json');
    const cmdFixture = path.join(stateDir, 'cmdline.json');
    const unmanaged = 940001;
    const testMode = 940002;

    writeEnvFixture(envFixture, {
      [unmanaged]: { AO_SIDE_PROCESS_CHILD_ID: 'listener', AO_SIDE_PROCESS_STATE_DIR: stateDir },
      [testMode]: {
        AO_WAKE_SUPERVISOR_TEST_MARKER_DIR: path.join(stateDir, 'markers'),
        AO_SIDE_PROCESS_CHILD_ID: 'listener',
      },
    });
    writeCmdlineFixture(cmdFixture, {
      [testMode]: `${supervisorCommandLine(stateDir)} -TestMode`,
    });

    const result = evaluateHygiene({
      STATE_DIR: stateDir,
      AO_FLEET_HYGIENE_PROCESS_ENV_FIXTURE: envFixture,
      AO_WAKE_SUPERVISOR_PROCESS_CMDLINE_FIXTURE: cmdFixture,
      AO_FLEET_HYGIENE_PWSH_PIDS_FIXTURE: JSON.stringify([unmanaged, testMode]),
      AO_FLEET_HYGIENE_STATUS_EXIT_CODE: '0',
    });

    expect(result.Assertions.find((row) => row.Id === 'H3')?.Pass).toBe(false);
    expect(result.Assertions.find((row) => row.Id === 'H3')?.Reason).not.toMatch(/940002/);
  });

  it('H6 counts role-tagged child RSS, not only supervisor RSS (review P2)', () => {
    const stateDir = makeStateDir();
    const cmdFixture = path.join(stateDir, 'cmdline.json');
    const envFixture = path.join(stateDir, 'env.json');
    const supervisorPid = 950001;
    const listenerPid = 950002;
    const testChild = path.join(repoRoot, 'scripts/orchestrator-wake-supervisor-test-child.ps1');
    writeCmdlineFixture(cmdFixture, {
      [supervisorPid]: supervisorCommandLine(stateDir),
      [listenerPid]: `pwsh -NoProfile -File ${testChild} -Role listener -MarkerDir ${path.join(stateDir, 'markers')}`,
    });
    writeEnvFixture(envFixture, {
      [listenerPid]: { AO_SIDE_PROCESS_CHILD_ID: 'listener', AO_SIDE_PROCESS_STATE_DIR: stateDir },
    });

    const result = evaluateHygiene({
      STATE_DIR: stateDir,
      AO_WAKE_SUPERVISOR_PROCESS_CMDLINE_FIXTURE: cmdFixture,
      AO_FLEET_HYGIENE_PROCESS_ENV_FIXTURE: envFixture,
      AO_FLEET_HYGIENE_PWSH_PIDS_FIXTURE: JSON.stringify([supervisorPid, listenerPid]),
      AO_FLEET_HYGIENE_ALIVE_PIDS_FIXTURE: JSON.stringify([supervisorPid, listenerPid]),
      AO_FLEET_HYGIENE_PROCESS_RSS_FIXTURE: JSON.stringify({ [supervisorPid]: 100, [listenerPid]: 500000 }),
      AO_FLEET_HYGIENE_MAX_SUPERVISOR_RSS_KB: '10000',
      AO_FLEET_HYGIENE_PWSH_COUNT_FIXTURE: '2',
      AO_FLEET_HYGIENE_MAX_PWSH_COUNT: '200',
      AO_FLEET_HYGIENE_STATUS_EXIT_CODE: '0',
    });

    expect(result.Assertions.find((row) => row.Id === 'H6')?.Pass).toBe(false);
    expect(result.Assertions.find((row) => row.Id === 'H6')?.Reason).toMatch(/role-tagged RSS/i);
  });

  it('H6/H7 ceiling breaches (AC#7)', () => {
    const stateDir = makeStateDir();
    fs.writeFileSync(path.join(stateDir, 'supervisor.log'), 'terminating duplicate\n'.repeat(6));

    const h6 = evaluateHygiene({
      STATE_DIR: stateDir,
      AO_FLEET_HYGIENE_PWSH_COUNT_FIXTURE: '650',
      AO_FLEET_HYGIENE_MAX_PWSH_COUNT: '200',
      AO_FLEET_HYGIENE_STATUS_EXIT_CODE: '0',
      AO_FLEET_HYGIENE_PWSH_PIDS_FIXTURE: '[]',
    });
    expect(h6.Assertions.find((row) => row.Id === 'H6')?.Pass).toBe(false);

    const h7 = evaluateHygiene({
      STATE_DIR: stateDir,
      AO_FLEET_HYGIENE_STATUS_EXIT_CODE: '0',
      AO_FLEET_HYGIENE_PWSH_PIDS_FIXTURE: '[]',
      AO_FLEET_HYGIENE_DUPLICATE_LOG_STORM_MIN: '5',
    });
    expect(h7.Assertions.find((row) => row.Id === 'H7')?.Pass).toBe(false);
    expect(h7.Assertions.find((row) => row.Id === 'H7')?.Code).toBe('H7_DUPLICATE_LOG_STORM');
  });

  it('sentinel singleton: overlapping run skips duplicate work (AC#8)', async () => {
    const stateDir = makeStateDir();
    const holdScript = `
      . ${psString(hygieneLib)}
      $config = Get-FleetHygieneConfig -StateDir ${psString(stateDir)}
      $lock = Enter-FleetHygieneSentinelSingleton -LockPath $config.SentinelLockPath
      if (-not $lock.Acquired) { Write-Output skipped; exit 2 }
      Start-Sleep -Seconds 4
      & $lock.Release $config.SentinelLockPath
      Write-Output primary-done
    `;
    const secondaryScript = `
      . ${psString(hygieneLib)}
      $config = Get-FleetHygieneConfig -StateDir ${psString(stateDir)}
      $lock = Enter-FleetHygieneSentinelSingleton -LockPath $config.SentinelLockPath
      if (-not $lock.Acquired) { Write-Output skipped; exit 0 }
      Write-Output should-not-run
      exit 1
    `;
    const primary = spawn('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', holdScript], {
      cwd: repoRoot,
      env: process.env,
      stdio: 'ignore',
      detached: true,
    });
    primary.unref();
    const lockPath = path.join(stateDir, 'fleet-hygiene-sentinel.lock');
    const deadline = Date.now() + 120_000;
    while (!fs.existsSync(lockPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(fs.existsSync(lockPath), 'primary did not acquire singleton lock in time').toBe(true);
    const secondary = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', secondaryScript], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
      timeout: 30_000,
    });
    expect(secondary.stdout).toContain('skipped');
    expect(secondary.status).toBe(0);
  });

  it('on-demand Hygiene prints pass lines and exits 0 on clean fixture fleet (AC#9)', () => {
    const stateDir = makeStateDir();
    const cmdFixture = path.join(stateDir, 'cmdline.json');
    const envFixture = path.join(stateDir, 'env.json');
    const supervisorPid = 960001;
    const fleet = buildCleanRegistryFleetFixtures(stateDir, supervisorPid);
    writeCmdlineFixture(cmdFixture, fleet.cmdMap);
    writeEnvFixture(envFixture, fleet.envMap);

    const result = runSentinel(['-Action', 'Hygiene', '-StateDir', stateDir], {
      AO_WAKE_SUPERVISOR_PROCESS_CMDLINE_FIXTURE: cmdFixture,
      AO_FLEET_HYGIENE_PROCESS_ENV_FIXTURE: envFixture,
      AO_FLEET_HYGIENE_PWSH_PIDS_FIXTURE: JSON.stringify(fleet.pids),
      AO_FLEET_HYGIENE_ALIVE_PIDS_FIXTURE: JSON.stringify(fleet.pids),
      AO_FLEET_HYGIENE_STATUS_EXIT_CODE: '0',
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    for (const id of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7']) {
      expect(result.stdout).toMatch(new RegExp(`PASS ${id}:`));
    }
  });


  it('H3/H6 ignore role-tagged processes bound to another state root (review P2)', () => {
    const stateDir = makeStateDir();
    const otherStateDir = path.join(os.tmpdir(), `fleet-hygiene-other-${process.pid}-${Date.now()}`);
    fs.mkdirSync(otherStateDir, { recursive: true });
    const envFixture = path.join(stateDir, 'env.json');
    const foreignPid = 960001;
    writeEnvFixture(envFixture, {
      [foreignPid]: {
        AO_SIDE_PROCESS_CHILD_ID: 'listener',
        AO_SIDE_PROCESS_STATE_DIR: otherStateDir,
      },
    });

    const result = evaluateHygiene({
      STATE_DIR: stateDir,
      AO_FLEET_HYGIENE_PROCESS_ENV_FIXTURE: envFixture,
      AO_FLEET_HYGIENE_PWSH_PIDS_FIXTURE: JSON.stringify([foreignPid]),
      AO_FLEET_HYGIENE_PROCESS_RSS_FIXTURE: JSON.stringify({ [foreignPid]: 500000 }),
      AO_FLEET_HYGIENE_MAX_SUPERVISOR_RSS_KB: '10000',
      AO_FLEET_HYGIENE_PWSH_COUNT_FIXTURE: '1',
      AO_FLEET_HYGIENE_MAX_PWSH_COUNT: '200',
      AO_FLEET_HYGIENE_STATUS_EXIT_CODE: '0',
    });

    expect(result.Assertions.find((row) => row.Id === 'H3')?.Pass).toBe(true);
    expect(result.Assertions.find((row) => row.Id === 'H6')?.Pass).toBe(true);
  });

  it('H4 uses path-boundary containment for adjacent checkout prefixes (review P2)', () => {
    const stateDir = makeStateDir();
    const cmdFixture = path.join(stateDir, 'cmdline.json');
    const packRoot = path.join(os.tmpdir(), 'orchestrator-pack-8');
    const adjacentRoot = path.join(os.tmpdir(), 'orchestrator-pack-81');
    const adjacentScript = path.join(adjacentRoot, 'scripts/orchestrator-wake-supervisor.ps1');
    const foreignPid = 960010;
    writeCmdlineFixture(cmdFixture, {
      [foreignPid]: supervisorCommandLine(stateDir).replace(wakeSupervisorScript, adjacentScript),
    });

    const result = evaluateHygiene({
      STATE_DIR: stateDir,
      PACK_ROOT: packRoot,
      AO_WAKE_SUPERVISOR_PROCESS_CMDLINE_FIXTURE: cmdFixture,
      AO_FLEET_HYGIENE_PWSH_PIDS_FIXTURE: JSON.stringify([foreignPid]),
      AO_FLEET_HYGIENE_STATUS_EXIT_CODE: '0',
    });

    expect(result.Assertions.find((row) => row.Id === 'H4')?.Pass).toBe(false);
    expect(result.Assertions.find((row) => row.Id === 'H4')?.Code).toBe(
      'H4_FOREIGN_CHECKOUT_SUPERVISOR',
    );
  });

  it('kill mode runs after stderr alert without terminating early (review P2)', () => {
    const stateDir = makeStateDir();
    const cmdFixture = path.join(stateDir, 'cmdline.json');
    const canonical = 960101;
    const duplicate = 960102;
    writeCmdlineFixture(cmdFixture, {
      [canonical]: supervisorCommandLine(stateDir),
      [duplicate]: supervisorCommandLine(stateDir),
    });
    fs.writeFileSync(path.join(stateDir, 'supervisor.lock'), String(canonical));
    const killLog = path.join(stateDir, 'kill-log.json');

    const sentinel = runSentinel(
      ['-Action', 'Sentinel', '-StateDir', stateDir, '-KillEnable'],
      {
        AO_WAKE_SUPERVISOR_PROCESS_CMDLINE_FIXTURE: cmdFixture,
        AO_FLEET_HYGIENE_PWSH_PIDS_FIXTURE: JSON.stringify([canonical, duplicate]),
        AO_FLEET_HYGIENE_ALIVE_PIDS_FIXTURE: JSON.stringify([canonical, duplicate]),
        AO_FLEET_HYGIENE_STATUS_EXIT_CODE: '0',
        AO_FLEET_HYGIENE_SKIP_SINGLETON: '1',
        AO_FLEET_HYGIENE_KILL_LOG_FIXTURE: killLog,
        AO_FLEET_HYGIENE_MOCK_KILL: '1',
      },
    );

    expect(sentinel.status).not.toBe(0);
    expect(fs.existsSync(killLog)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(killLog, 'utf8')) as { kills?: number[] };
    expect(raw.kills ?? []).toContain(duplicate);
    expect(raw.kills ?? []).not.toContain(canonical);
  });


  it('H2 fails when a registry role has no managed process (review P2)', () => {
    const stateDir = makeStateDir();
    const cmdFixture = path.join(stateDir, 'cmdline.json');
    const envFixture = path.join(stateDir, 'env.json');
    const supervisorPid = 970001;
    const listenerPid = 970002;
    writeCmdlineFixture(cmdFixture, {
      [supervisorPid]: supervisorCommandLine(stateDir),
      [listenerPid]: `pwsh -NoProfile -File ${testChildScript} -Role listener -MarkerDir ${path.join(stateDir, 'markers')}`,
    });
    writeEnvFixture(envFixture, {
      [listenerPid]: { AO_SIDE_PROCESS_STATE_DIR: stateDir, AO_SIDE_PROCESS_CHILD_ID: 'listener' },
    });
    fs.writeFileSync(path.join(stateDir, 'listener.pid'), String(listenerPid));

    const result = evaluateHygiene({
      STATE_DIR: stateDir,
      AO_WAKE_SUPERVISOR_PROCESS_CMDLINE_FIXTURE: cmdFixture,
      AO_FLEET_HYGIENE_PROCESS_ENV_FIXTURE: envFixture,
      AO_FLEET_HYGIENE_PWSH_PIDS_FIXTURE: JSON.stringify([supervisorPid, listenerPid]),
      AO_FLEET_HYGIENE_ALIVE_PIDS_FIXTURE: JSON.stringify([supervisorPid, listenerPid]),
      AO_FLEET_HYGIENE_STATUS_EXIT_CODE: '0',
    });

    const h2 = result.Assertions.find((row) => row.Id === 'H2');
    expect(h2?.Pass).toBe(false);
    expect(h2?.Code).toBe('H2_MISSING_ROLE');
    expect(h2?.Reason).toMatch(/missing roles:/i);
    expect(h2?.Reason).not.toMatch(/listener/);
  });

  it('class matrix minimum cells (AC#11)', () => {
    const stateDir = makeStateDir();
    const cmdFixture = path.join(stateDir, 'cmdline.json');
    const envFixture = path.join(stateDir, 'env.json');

    // H2 duplicate role
    const roleA = 950010;
    const roleB = 950011;
    const testChild = path.join(repoRoot, 'scripts/orchestrator-wake-supervisor-test-child.ps1');
    writeCmdlineFixture(cmdFixture, {
      [roleA]: `pwsh -NoProfile -File ${testChild} -Role listener -MarkerDir ${path.join(stateDir, 'markers')}`,
      [roleB]: `pwsh -NoProfile -File ${testChild} -Role listener -MarkerDir ${path.join(stateDir, 'markers')}`,
    });
    writeEnvFixture(envFixture, {
      [roleA]: { AO_SIDE_PROCESS_STATE_DIR: stateDir },
      [roleB]: { AO_SIDE_PROCESS_STATE_DIR: stateDir },
    });
    fs.writeFileSync(path.join(stateDir, 'listener.pid'), String(roleA));

    const h2Eval = evaluateHygiene({
      STATE_DIR: stateDir,
      AO_WAKE_SUPERVISOR_PROCESS_CMDLINE_FIXTURE: cmdFixture,
      AO_FLEET_HYGIENE_PROCESS_ENV_FIXTURE: envFixture,
      AO_FLEET_HYGIENE_PWSH_PIDS_FIXTURE: JSON.stringify([roleA, roleB]),
      AO_FLEET_HYGIENE_ALIVE_PIDS_FIXTURE: JSON.stringify([roleA, roleB]),
      AO_FLEET_HYGIENE_STATUS_EXIT_CODE: '0',
    });
    expect(h2Eval.Assertions.find((row) => row.Id === 'H2')?.Pass).toBe(false);
    const h2Killed = runKillFromEvaluation(stateDir, {
      AO_WAKE_SUPERVISOR_PROCESS_CMDLINE_FIXTURE: cmdFixture,
      AO_FLEET_HYGIENE_PROCESS_ENV_FIXTURE: envFixture,
      AO_FLEET_HYGIENE_PWSH_PIDS_FIXTURE: JSON.stringify([roleA, roleB]),
      AO_FLEET_HYGIENE_ALIVE_PIDS_FIXTURE: JSON.stringify([roleA, roleB]),
      AO_FLEET_HYGIENE_STATUS_EXIT_CODE: '0',
    });
    expect(h2Killed).toContain(roleB);
    expect(h2Killed).not.toContain(roleA);
  });
});
