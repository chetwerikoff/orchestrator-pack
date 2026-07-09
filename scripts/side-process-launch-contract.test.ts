import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..');
const guardScript = join(repoRoot, 'scripts/check-side-process-launch-contract.ps1');
const fixtureRoot = join(repoRoot, 'scripts/fixtures/side-process-launch-contract');
const supervisorLib = join(repoRoot, 'scripts/lib/Orchestrator-WakeSupervisor.ps1');
const pendingEscalationFixture = join(fixtureRoot, 'pending-llm-orchestrator-escalation.json');
const pwshTestTimeoutMs = 120_000;
const integrationTestTimeoutMs = 180_000;

function ps(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function runGuard(args: string[] = []) {
  return spawnSync(
    'pwsh',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', guardScript, ...args],
    { cwd: repoRoot, encoding: 'utf8', timeout: pwshTestTimeoutMs },
  );
}

function runPwsh(script: string, env: Record<string, string> = {}) {
  return spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: pwshTestTimeoutMs,
  });
}

function parseLastJson(stdout: string): unknown {
  const line = stdout.trim().split('\n').filter(Boolean).at(-1) ?? '{}';
  return JSON.parse(line);
}

describe.sequential('side-process launch contract (#659)', { timeout: pwshTestTimeoutMs }, () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('guard passes on aligned fleet registry (AC#4)', () => {
    const result = runGuard();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/validated 15 registry children/i);
  });

  it('guard fails on mismatch fixture reproducing passProjectId-without-ProjectId (AC#3)', () => {
    const result = runGuard([
      '-RegistryPath',
      join(fixtureRoot, 'registry-mismatch.json'),
      '-ScriptsRoot',
      fixtureRoot,
    ]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/ProjectId/i);
  });

  it('guard self-test is green', () => {
    const result = runGuard(['-SelfTest']);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/self-test/i);
  });

  it('supervisor argv derivation includes -ProjectId for passProjectId children (AC#2)', () => {
    const parsed = JSON.parse(
      runPwsh(
        `
        . ${ps(supervisorLib)}
        $entry = Get-OrchestratorWakeSupervisorChildEntry -ChildId 'escalation-router'
        $paths = Get-OrchestratorWakeSupervisorPaths -StateRoot ${ps(mkdtempSync(join(tmpdir(), 'launch-contract-argv-')))}
        $argv = Build-OrchestratorWakeSupervisorChildLaunchArgv -ChildId 'escalation-router' -Entry $entry -ScriptPath $entry.ScriptPath -OrchestratorSessionId 'orch-659' -ProjectId 'orchestrator-pack' -Paths $paths
        [pscustomobject]@{
          switches = ($argv | Where-Object { $_ -like '-*' })
          hasProjectId = ($argv -contains '-ProjectId')
          hasOrchestratorSessionId = ($argv -contains '-OrchestratorSessionId')
        } | ConvertTo-Json -Compress
      `,
      ).stdout.trim(),
    ) as { hasProjectId: boolean; hasOrchestratorSessionId: boolean };

    expect(parsed.hasProjectId).toBe(true);
    expect(parsed.hasOrchestratorSessionId).toBe(true);
  });

  it('escalation-router launched via supervisor child-spawn path completes one tick', { timeout: integrationTestTimeoutMs }, () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'escalation-router-launch-'));
    tempDirs.push(stateRoot);
    const escalationState = join(stateRoot, 'escalation-state.json');
    writeFileSync(
      escalationState,
      JSON.stringify({ schemaVersion: 1, records: {}, wakeWindows: {}, audit: {} }),
    );

    const script = `
      . ${ps(supervisorLib)}
      $stateRoot = ${ps(stateRoot)}
      $paths = Get-OrchestratorWakeSupervisorPaths -StateRoot $stateRoot
      $env:AO_ORCHESTRATOR_ESCALATION_STATE = ${ps(escalationState)}
      $pidVal = Start-OrchestratorWakeSupervisorChild -ChildId 'escalation-router' -OrchestratorSessionId 'orch-659' -Paths $paths -ProjectId 'orchestrator-pack' -ExtraChildArgs @('-Once','-PollSeconds','1')
      if ($pidVal -le 0) { throw 'Start-OrchestratorWakeSupervisorChild returned invalid pid' }
      $mainLogPath = Join-Path $stateRoot 'escalation-router.log'
      $errLogPath = Join-Path $stateRoot 'escalation-router.log.err'
      $deadline = [DateTimeOffset]::UtcNow.AddSeconds(45)
      $mainLog = ''
      while ([DateTimeOffset]::UtcNow -lt $deadline) {
        if ((Test-Path -LiteralPath $mainLogPath) -and ((Get-Item -LiteralPath $mainLogPath).Length -gt 0)) {
          $mainLog = Get-Content -LiteralPath $mainLogPath -Raw
          if ($mainLog -match 'tick complete redelivered=') { break }
        }
        if (-not (Get-Process -Id $pidVal -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 200
      }
      if (-not $mainLog -and (Test-Path -LiteralPath $mainLogPath)) {
        $mainLog = Get-Content -LiteralPath $mainLogPath -Raw
      }
      if (Get-Process -Id $pidVal -ErrorAction SilentlyContinue) {
        Stop-Process -Id $pidVal -Force -ErrorAction SilentlyContinue
      }
      $errLog = if (Test-Path -LiteralPath $errLogPath) {
        [string](Get-Content -LiteralPath $errLogPath -Raw -ErrorAction SilentlyContinue)
      } else { '' }
      [pscustomobject]@{
        mainLog = [string]$mainLog
        errLog = [string]$errLog
      } | ConvertTo-Json -Compress -Depth 4
    `;

    const result = runPwsh(script);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const payload = parseLastJson(result.stdout) as {
      mainLog: string;
      errLog: string | null;
    };
    const errText = payload.errLog ?? '';
    const mainText = payload.mainLog ?? '';
    expect(errText).not.toMatch(/parameter name 'ProjectId'/i);
    expect(mainText).toMatch(/\[orchestrator-escalation-router\] tick complete redelivered=/i);
  });

  it('router tick records a redelivery attempt on seeded pending llm-orchestrator state', { timeout: integrationTestTimeoutMs }, () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'escalation-router-redelivery-'));
    tempDirs.push(stateRoot);
    const escalationState = join(stateRoot, 'escalation-state.json');
    copyFileSync(pendingEscalationFixture, escalationState);

    const before = JSON.parse(readFileSync(escalationState, 'utf8')) as {
      records: Record<string, { attempts?: number }>;
    };
    const recordKey = 'b3e3f9f24cc76d57068e7e4a';
    const attemptsBefore = before.records[recordKey]?.attempts ?? 0;

    const script = `
      . ${ps(supervisorLib)}
      $stateRoot = ${ps(stateRoot)}
      $paths = Get-OrchestratorWakeSupervisorPaths -StateRoot $stateRoot
      $env:AO_ORCHESTRATOR_ESCALATION_STATE = ${ps(escalationState)}
      $env:AO_ESCALATION_FORCE_SEND_FAILURE = '1'
      $pidVal = Start-OrchestratorWakeSupervisorChild -ChildId 'escalation-router' -OrchestratorSessionId 'orch-659' -Paths $paths -ProjectId 'orchestrator-pack' -ExtraChildArgs @('-Once','-PollSeconds','1')
      $mainLogPath = Join-Path $stateRoot 'escalation-router.log'
      $errLogPath = Join-Path $stateRoot 'escalation-router.log.err'
      $deadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
      $mainLog = ''
      while ([DateTimeOffset]::UtcNow -lt $deadline) {
        if ((Test-Path -LiteralPath $mainLogPath) -and ((Get-Item -LiteralPath $mainLogPath).Length -gt 0)) {
          $mainLog = Get-Content -LiteralPath $mainLogPath -Raw
          if ($mainLog -match 'tick complete redelivered=') { break }
        }
        if (-not (Get-Process -Id $pidVal -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 250
      }
      if (-not $mainLog -and (Test-Path -LiteralPath $mainLogPath)) {
        $mainLog = Get-Content -LiteralPath $mainLogPath -Raw
      }
      if (Get-Process -Id $pidVal -ErrorAction SilentlyContinue) {
        Stop-Process -Id $pidVal -Force -ErrorAction SilentlyContinue
      }
      $state = Get-Content -LiteralPath ${ps(escalationState)} -Raw | ConvertFrom-Json
      $recordKey = ${ps(recordKey)}
      $record = $state.records.$recordKey
      $mainLog = if ($mainLog) { [string]$mainLog } else { '' }
      $errLog = if (Test-Path -LiteralPath $errLogPath) {
        [string](Get-Content -LiteralPath $errLogPath -Raw -ErrorAction SilentlyContinue)
      } else { '' }
      [pscustomobject]@{
        attempts = [int]$record.attempts
        mainLog = $mainLog
        errLog = [string]$errLog
      } | ConvertTo-Json -Compress
    `;

    const result = runPwsh(script);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const payload = parseLastJson(result.stdout) as {
      attempts: number;
      mainLog: string | null;
      errLog: string | null;
    };
    const errText = payload.errLog ?? '';
    const mainText = payload.mainLog ?? '';
    expect(errText).not.toMatch(/parameter name 'ProjectId'/i);
    expect(mainText).toMatch(/tick complete redelivered=/i);
    expect(payload.attempts).toBeGreaterThan(attemptsBefore);
  });
});

describe('mandatory-params satisfiability (#701)', { timeout: pwshTestTimeoutMs }, () => {
  it('guard fails on gate-child mandatory-params mismatch fixture', () => {
    const result = runGuard([
      '-RegistryPath',
      join(fixtureRoot, 'registry-mandatory-params-mismatch.json'),
      '-ScriptsRoot',
      fixtureRoot,
    ]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/mandatory parameter 'SessionId'/i);
    expect(`${result.stdout}${result.stderr}`).toMatch(/not satisfiable from supervised launch shape/i);
  });

  it('guard fails on mandatory shorthand [Parameter(Mandatory)] fixture', () => {
    const result = runGuard([
      '-RegistryPath',
      join(fixtureRoot, 'registry-mandatory-shorthand-mismatch.json'),
      '-ScriptsRoot',
      fixtureRoot,
    ]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/mandatory parameter 'SessionId'/i);
    expect(`${result.stdout}${result.stderr}`).toMatch(/mandatory parameter 'RunId'/i);
    expect(`${result.stdout}${result.stderr}`).toMatch(/not satisfiable from supervised launch shape/i);
  });

  it('guard fails on ValidateSet mismatch fixture (cell 4)', () => {
    const result = runGuard([
      '-RegistryPath',
      join(fixtureRoot, 'registry-validateset-mismatch.json'),
      '-ScriptsRoot',
      fixtureRoot,
    ]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/ValidateSet/i);
  });

  it('aligned fleet registry excludes per-review gate child', () => {
    const registry = JSON.parse(
      readFileSync(join(repoRoot, 'scripts/orchestrator-side-process-registry.json'), 'utf8'),
    ) as { children: { id: string }[] };
    expect(registry.children.some((child) => child.id === 'scripted-review-confirmed-delivery-gate')).toBe(
      false,
    );
  });
});
