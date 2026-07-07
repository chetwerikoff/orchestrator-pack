import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupSupervisorTests,
  isAlive,
  makeStateDir,
  psString,
  repoRoot,
  runPwsh,
} from './supervisor-recovery.test-helpers.js';

const supervisorLib = path.join(repoRoot, 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1');

vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 });

afterEach(() => {
  cleanupSupervisorTests();
});

function capturedSupervisorCommandLine(stateDir: string): string {
  const scriptPath = path.join(repoRoot, 'scripts/orchestrator-wake-supervisor.ps1');
  return [
    'pwsh',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-Action',
    'Start',
    '-SupervisorLoop',
    '-ProjectId',
    'orchestrator-pack',
    '-PollSeconds',
    '120',
    '-OrchestratorSessionId',
    'op-capture-backed',
    '-StateDir',
    stateDir,
    '-TestMode',
  ].join(' ');
}

function writeCommandLineFixture(
  fixturePath: string,
  pid: number,
  commandLine: string,
): void {
  fs.writeFileSync(fixturePath, JSON.stringify({ [String(pid)]: commandLine }));
}

function testSupervisorCommandLineIdentity(
  commandLine: string,
  projectId: string,
  stateRoot: string,
): boolean {
  const result = runPwsh(
    `. '${supervisorLib.replace(/'/g, "''")}'; Write-Output (Test-OrchestratorWakeSupervisorSupervisorCommandLineIdentity -CommandLine '${commandLine.replace(/'/g, "''")}' -ProjectId '${projectId.replace(/'/g, "''")}' -StateRoot '${stateRoot.replace(/'/g, "''")}')`,
  );
  return result.stdout.trim() === 'True';
}

function testSupervisorCommandLineIdentityTokens(
  tokens: string[],
  projectId: string,
  stateRoot: string,
): boolean {
  const tokenArgs = tokens.map((token) => psString(token)).join(',');
  const result = runPwsh(
    `. '${supervisorLib.replace(/'/g, "''")}'; Write-Output (Test-OrchestratorWakeSupervisorSupervisorCommandLineIdentity -Tokens @(${tokenArgs}) -ProjectId ${psString(projectId)} -StateRoot ${psString(stateRoot)})`,
  );
  return result.stdout.trim() === 'True';
}

function makeStateDirWithSpacesInPath(): string {
  const base = makeStateDir();
  const stateDir = path.join(base, 'wake sup');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'markers'), { recursive: true });
  return stateDir;
}

describe('Issue #613 orphan supervisor discovery (unit)', () => {
  it('Stop skips killing a live process that does not match supervisor identity', () => {
    const stateDir = makeStateDir();
    const unrelatedPid = process.pid;

    const result = runPwsh(
      `. '${supervisorLib.replace(/'/g, "''")}'; Stop-OrchestratorWakeSupervisorProcess -ProcessId ${unrelatedPid} -ManagedRole supervisor -ProjectId orchestrator-pack -StateRoot '${stateDir.replace(/'/g, "''")}' -LogPath '${stateDir.replace(/'/g, "''")}/guard.log'; if (Test-Path -LiteralPath '${stateDir.replace(/'/g, "''")}/guard.log') { Get-Content -LiteralPath '${stateDir.replace(/'/g, "''")}/guard.log' -Raw }`,
    );
    expect(result.stdout).toContain('skipping kill');
    expect(isAlive(unrelatedPid)).toBe(true);
  });

  it('identity predicate rejects inert command text that only mentions the script name', () => {
    const stateDir = makeStateDir();
    const commandLine =
      'pwsh -NoProfile -Command "Write-Host orchestrator-wake-supervisor.ps1 is only mentioned here"';

    expect(
      testSupervisorCommandLineIdentity(commandLine, 'orchestrator-pack', stateDir),
    ).toBe(false);
  });

  it('identity predicate accepts a capture-backed detached supervisor command line', () => {
    const stateDir = makeStateDir();

    expect(
      testSupervisorCommandLineIdentity(
        capturedSupervisorCommandLine(stateDir),
        'orchestrator-pack',
        stateDir,
      ),
    ).toBe(true);
  });

  it('detached Start always includes resolved StateDir in supervisor loop args', () => {
    const script = fs.readFileSync(
      path.join(repoRoot, 'scripts/orchestrator-wake-supervisor.ps1'),
      'utf8',
    );
    expect(script).toMatch(/\$loopArgs \+= @\('-StateDir', \$stateRoot\)/);
  });

  it('identity predicate accepts a non-test foreground supervisor command line', () => {
    const stateDir = makeStateDir();
    const scriptPath = path.join(repoRoot, 'scripts/orchestrator-wake-supervisor.ps1');
    const tokens = [
      'pwsh',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-Action',
      'Start',
      '-Foreground',
      '-ProjectId',
      'orchestrator-pack',
      '-StateDir',
      stateDir,
    ];

    expect(
      testSupervisorCommandLineIdentityTokens(tokens, 'orchestrator-pack', stateDir),
    ).toBe(true);
  });

  it('identity predicate preserves argv boundaries for StateDir values containing spaces', () => {
    const stateDir = makeStateDirWithSpacesInPath();
    const scriptPath = path.join(repoRoot, 'scripts/orchestrator-wake-supervisor.ps1');
    const tokens = [
      'pwsh',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-Action',
      'Start',
      '-SupervisorLoop',
      '-ProjectId',
      'orchestrator-pack',
      '-StateDir',
      stateDir,
      '-TestMode',
    ];

    expect(
      testSupervisorCommandLineIdentityTokens(tokens, 'orchestrator-pack', stateDir),
    ).toBe(true);
    expect(
      testSupervisorCommandLineIdentity(tokens.join(' '), 'orchestrator-pack', stateDir),
    ).toBe(false);
  });

  it('Resolve fails closed when supervisor.pid is valid but scan finds duplicate managed supervisors', () => {
    const stateDir = makeStateDir();
    const fixturePath = path.join(stateDir, 'cmdline-fixture.json');
    const commandLine = capturedSupervisorCommandLine(stateDir);
    const sleepArgs = ['-NoProfile', '-Command', 'Start-Sleep 120'];
    const first = spawn('pwsh', sleepArgs, { detached: true, stdio: 'ignore' });
    const second = spawn('pwsh', sleepArgs, { detached: true, stdio: 'ignore' });
    first.unref();
    second.unref();
    const firstPid = first.pid ?? 0;
    const secondPid = second.pid ?? 0;
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

    try {
      const result = runPwsh(
        `$env:AO_WAKE_SUPERVISOR_PROCESS_CMDLINE_FIXTURE='${fixturePath.replace(/'/g, "''")}'; . '${supervisorLib.replace(/'/g, "''")}'; $paths = Get-OrchestratorWakeSupervisorPaths -StateRoot '${stateDir.replace(/'/g, "''")}'; $resolution = Resolve-OrchestratorWakeSupervisorSupervisorPid -Paths $paths -ProjectId orchestrator-pack; Write-Output $resolution.Ambiguous; Write-Output ($resolution.CandidatePids -join ',')`,
      );
      const output = result.stdout.trim();
      expect(output).toContain('True');
      const candidateLine = output
        .split(/\r?\n/)
        .find((line) => /^\d+(,\d+)*$/.test(line));
      expect(candidateLine?.split(',').map((pid) => Number(pid)).sort((a, b) => a - b)).toEqual(
        [firstPid, secondPid].sort((a, b) => a - b),
      );
    } finally {
      for (const pid of [firstPid, secondPid]) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
    }
  });

  it('Stop re-validates discovered pid identity immediately before kill', () => {
    const stateDir = makeStateDir();
    const fixturePath = path.join(stateDir, 'cmdline-fixture.json');
    const livePid = process.pid;
    const badLine =
      'pwsh -NoProfile -Command "Write-Host orchestrator-wake-supervisor.ps1 is only mentioned here"';
    writeCommandLineFixture(fixturePath, livePid, badLine);

    const blocked = runPwsh(
      `$env:AO_WAKE_SUPERVISOR_PROCESS_CMDLINE_FIXTURE='${fixturePath.replace(/'/g, "''")}'; . '${supervisorLib.replace(/'/g, "''")}'; Stop-OrchestratorWakeSupervisorProcess -ProcessId ${livePid} -ManagedRole supervisor -ProjectId orchestrator-pack -StateRoot '${stateDir.replace(/'/g, "''")}' -LogPath '${stateDir.replace(/'/g, "''")}/guard.log'; if (Test-Path -LiteralPath '${stateDir.replace(/'/g, "''")}/guard.log') { Get-Content -LiteralPath '${stateDir.replace(/'/g, "''")}/guard.log' -Raw }`,
    );
    expect(blocked.stdout).toContain('skipping kill');
    expect(isAlive(livePid)).toBe(true);
  });
});
