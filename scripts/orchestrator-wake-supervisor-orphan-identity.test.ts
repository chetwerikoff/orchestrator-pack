import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupSupervisorTests,
  isAlive,
  makeStateDir,
  repoRoot,
  runPwsh,
} from './supervisor-recovery.test-helpers.js';

const supervisorLib = path.join(repoRoot, 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1');

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
