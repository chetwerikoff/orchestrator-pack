import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';
import { startLiveStoreGuard } from './lib/vitest-live-store-harness.mjs';
import {
  OPK_VITEST_HARNESS_ENV,
  sharedDefaultEscalationStatePath,
  sharedDefaultHealthSpoolDir,
  sharedDefaultOperatorInboxDir,
} from './test-harness-escalation-env.js';

function pwshExpectFail(script: string, env: Record<string, string> = {}) {
  const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  expect(result.status).not.toBe(0);
  return `${result.stderr ?? ''}${result.stdout ?? ''}`;
}

function pwshJson(script: string, env: Record<string, string> = {}) {
  const stdout = runPwsh(script, env);
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}');
}

describe('escalation state store test isolation (#664)', () => {
  let cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AC#1: test emits resolve an isolated store via harness bootstrap', () => {
    const sharedDefault = sharedDefaultEscalationStatePath();
    const sharedExisted = existsSync(sharedDefault);
    const sharedMtime = sharedExisted ? statSync(sharedDefault).mtimeMs : 0;

    const parsed = pwshJson(`
      . ./scripts/lib/Invoke-OrchestratorEscalationEmit.ps1
      $r = Invoke-OrchestratorEscalationEmit -EscalationClassId 'escalation-dead-worker-recovery' -SourceProcess 'escalation-state-test-isolation' -CorrelationKey 'corr:isolation:ac1' -DedupeKey 'dedupe:isolation:ac1' -Diagnosis @{ reason = 'ambiguous_claim' } -OrchestratorSessionId 'orch-test' -DryRun
      $statePath = Get-OrchestratorEscalationStatePath
      [pscustomobject]@{
        status = [string]$r.status
        statePath = [string]$statePath
        stateExists = (Test-Path -LiteralPath $statePath)
        sharedDefault = ${psString(sharedDefault)}
        pathsMatch = ([string]$statePath -eq ${psString(sharedDefault)})
      } | ConvertTo-Json -Compress
    `);

    expect(parsed.status).toBe('delivered');
    expect(parsed.stateExists).toBe(true);
    expect(parsed.pathsMatch).toBe(false);
    if (sharedExisted) {
      expect(statSync(sharedDefault).mtimeMs).toBe(sharedMtime);
    } else {
      expect(existsSync(sharedDefault)).toBe(false);
    }
  });

  it('AC#2: fail-closed on shared-default surfaces from any path source', () => {
    const sharedState = sharedDefaultEscalationStatePath();
    const sharedInbox = sharedDefaultOperatorInboxDir();
    const sharedHealth = sharedDefaultHealthSpoolDir();
    const markerEnv = { [OPK_VITEST_HARNESS_ENV]: '1' };

    const fallbackState = pwshExpectFail(`
      Remove-Item Env:AO_ORCHESTRATOR_ESCALATION_STATE -ErrorAction SilentlyContinue
      . ./scripts/lib/Orchestrator-Escalation.ps1
      Get-OrchestratorEscalationStatePath | Out-Null
    `, markerEnv);
    expect(fallbackState).toMatch(/resolves to shared[\s\S]*under test harness/i);

    const envState = pwshExpectFail(`
      $env:AO_ORCHESTRATOR_ESCALATION_STATE = ${psString(sharedState)}
      . ./scripts/lib/Orchestrator-Escalation.ps1
      Get-OrchestratorEscalationStatePath | Out-Null
    `, markerEnv);
    expect(envState).toMatch(/resolves to shared[\s\S]*under test harness/i);

    const paramState = pwshExpectFail(`
      . ./scripts/lib/Orchestrator-Escalation.ps1
      Get-OrchestratorEscalationStatePath -StatePath ${psString(sharedState)} | Out-Null
    `, markerEnv);
    expect(paramState).toMatch(/resolves to shared[\s\S]*under test harness/i);

    const fallbackInbox = pwshExpectFail(`
      Remove-Item Env:AO_OPERATOR_ESCALATION_INBOX -ErrorAction SilentlyContinue
      . ./scripts/lib/Orchestrator-Escalation.ps1
      Get-OrchestratorEscalationOperatorInboxDir | Out-Null
    `, markerEnv);
    expect(fallbackInbox).toMatch(/resolves to shared[\s\S]*under test harness/i);

    const envInbox = pwshExpectFail(`
      $env:AO_OPERATOR_ESCALATION_INBOX = ${psString(sharedInbox)}
      . ./scripts/lib/Orchestrator-Escalation.ps1
      Get-OrchestratorEscalationOperatorInboxDir | Out-Null
    `, markerEnv);
    expect(envInbox).toMatch(/resolves to shared[\s\S]*under test harness/i);

    const paramInbox = pwshExpectFail(`
      . ./scripts/lib/Orchestrator-Escalation.ps1
      Get-OrchestratorEscalationOperatorInboxDir -OperatorInboxDir ${psString(sharedInbox)} | Out-Null
    `, markerEnv);
    expect(paramInbox).toMatch(/resolves to shared[\s\S]*under test harness/i);

    const fallbackHealth = pwshExpectFail(`
      Remove-Item Env:AO_ESCALATION_HEALTH_SPOOL -ErrorAction SilentlyContinue
      . ./scripts/lib/Orchestrator-Escalation.ps1
      Get-OrchestratorEscalationHealthSpoolDir | Out-Null
    `, markerEnv);
    expect(fallbackHealth).toMatch(/resolves to shared[\s\S]*under test harness/i);

    const envHealth = pwshExpectFail(`
      $env:AO_ESCALATION_HEALTH_SPOOL = ${psString(sharedHealth)}
      . ./scripts/lib/Orchestrator-Escalation.ps1
      Get-OrchestratorEscalationHealthSpoolDir | Out-Null
    `, markerEnv);
    expect(envHealth).toMatch(/resolves to shared[\s\S]*under test harness/i);

    const paramHealth = pwshExpectFail(`
      . ./scripts/lib/Orchestrator-Escalation.ps1
      Get-OrchestratorEscalationHealthSpoolDir -HealthSpoolDir ${psString(sharedHealth)} | Out-Null
    `, markerEnv);
    expect(paramHealth).toMatch(/resolves to shared[\s\S]*under test harness/i);
  });

  it('AC#3: production path unchanged without marker; isolated publish succeeds', () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), 'opk-vitest-escalation-prod-proof-'));
    cleanupDirs.push(isolatedRoot);
    const isolatedState = join(isolatedRoot, 'state.json');
    const isolatedInbox = join(isolatedRoot, 'inbox');
    const isolatedHealth = join(isolatedRoot, 'health');

    const resolved = pwshJson(`
      Remove-Item Env:OPK_VITEST_HARNESS -ErrorAction SilentlyContinue
      Remove-Item Env:AO_ORCHESTRATOR_ESCALATION_STATE -ErrorAction SilentlyContinue
      Remove-Item Env:AO_OPERATOR_ESCALATION_INBOX -ErrorAction SilentlyContinue
      Remove-Item Env:AO_ESCALATION_HEALTH_SPOOL -ErrorAction SilentlyContinue
      . ./scripts/lib/Orchestrator-Escalation.ps1
      [pscustomobject]@{
        state = [string](Get-OrchestratorEscalationStatePath)
        inbox = [string](Get-OrchestratorEscalationOperatorInboxDir)
        health = [string](Get-OrchestratorEscalationHealthSpoolDir)
      } | ConvertTo-Json -Compress
    `, {
      OPK_VITEST_HARNESS: '',
      AO_ORCHESTRATOR_ESCALATION_STATE: '',
      AO_OPERATOR_ESCALATION_INBOX: '',
      AO_ESCALATION_HEALTH_SPOOL: '',
    });

    expect(resolved.state).toBe(sharedDefaultEscalationStatePath());
    expect(resolved.inbox).toBe(sharedDefaultOperatorInboxDir());
    expect(resolved.health).toBe(sharedDefaultHealthSpoolDir());

    const sharedDefault = sharedDefaultEscalationStatePath();
    const sharedExistedBefore = existsSync(sharedDefault);
    const sharedMtimeBefore = sharedExistedBefore ? statSync(sharedDefault).mtimeMs : 0;

    const published = pwshJson(`
      Remove-Item Env:OPK_VITEST_HARNESS -ErrorAction SilentlyContinue
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $r = Publish-OrchestratorEscalation -EscalationClassId 'escalation-dead-worker-recovery' -CorrelationKey 'corr:prod-proof:isolated' -Payload @{ reason = 'isolated_proof' } -StatePath ${psString(isolatedState)} -OperatorInboxDir ${psString(isolatedInbox)} -HealthSpoolDir ${psString(isolatedHealth)} -OrchestratorSessionId 'orch-proof' -NowMs 1000 -DryRun
      [pscustomobject]@{ status = [string]$r.status; stateExists = (Test-Path -LiteralPath ${psString(isolatedState)}) } | ConvertTo-Json -Compress
    `, {
      OPK_VITEST_HARNESS: '',
      AO_ORCHESTRATOR_ESCALATION_STATE: '',
      AO_OPERATOR_ESCALATION_INBOX: '',
      AO_ESCALATION_HEALTH_SPOOL: '',
    });

    expect(published.status).toBe('delivered');
    expect(published.stateExists).toBe(true);
    if (sharedExistedBefore) {
      expect(statSync(sharedDefault).mtimeMs).toBe(sharedMtimeBefore);
    }
  });

  it('AC#4: snapshot-preserving guard tolerates an unchanged mock production store', () => {
    const mockProductionRoot = mkdtempSync(join(tmpdir(), 'opk-vitest-mock-production-'));
    cleanupDirs.push(mockProductionRoot);
    const mockTmp = join(mockProductionRoot, 'tmp');
    const mockHome = join(mockProductionRoot, 'home');
    const mockWake = join(mockHome, '.local', 'state', 'orchestrator-pack-wake-supervisor');
    const mockAoBase = join(mockHome, '.agent-orchestrator');
    const mockSharedDefault = join(mockTmp, 'orchestrator-escalation-state.json');
    mkdirSync(mockTmp, { recursive: true });
    const preexisting = JSON.stringify({ schemaVersion: 1, records: {}, wakeWindows: {}, audit: {} });

    const marker = process.env.OPK_VITEST_HARNESS;
    process.env.OPK_VITEST_HARNESS = '';
    try {
      writeFileSync(mockSharedDefault, preexisting, 'utf8');
    } finally {
      process.env.OPK_VITEST_HARNESS = marker;
    }

    const guard = startLiveStoreGuard({
      ...process.env,
      OPK_VITEST_HARNESS: '1',
      OPK_VITEST_PRODUCTION_HOME: mockHome,
      OPK_VITEST_PRODUCTION_TMP: mockTmp,
      OPK_VITEST_PRODUCTION_AO_BASE: mockAoBase,
      OPK_VITEST_PRODUCTION_WAKE_ROOT: mockWake,
      HOME: mockHome,
      TMPDIR: mockTmp,
      TEMP: mockTmp,
      TMP: mockTmp,
      AO_BASE_DIR: '',
      AO_WAKE_SUPERVISOR_STATE_DIR: '',
      ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR: '',
    });

    const emit = pwshJson(`
      . ./scripts/lib/Invoke-OrchestratorEscalationEmit.ps1
      $r = Invoke-OrchestratorEscalationEmit -EscalationClassId 'escalation-review-start-claim' -SourceProcess 'escalation-state-test-isolation' -CorrelationKey 'corr:guard:ac4' -DedupeKey 'dedupe:guard:ac4' -Diagnosis @{ reason = 'guard_proof' } -OrchestratorSessionId 'orch-test' -DryRun
      [pscustomobject]@{ status = [string]$r.status } | ConvertTo-Json -Compress
    `);
    expect(emit.status).toBe('delivered');
    expect(() => guard.stop()).not.toThrow();
    expect(readFileSync(mockSharedDefault, 'utf8')).toBe(preexisting);
  });

  it('AC#5: bypass-path child pwsh inherits marker and isolated paths from bootstrap', () => {
    expect(process.env.OPK_VITEST_HARNESS).toBe('1');
    expect(process.env.AO_ORCHESTRATOR_ESCALATION_STATE).toBeTruthy();
    expect(process.env.AO_OPERATOR_ESCALATION_INBOX).toBeTruthy();
    expect(process.env.AO_ESCALATION_HEALTH_SPOOL).toBeTruthy();

    const script = `
      [pscustomobject]@{
        marker = [string]$env:OPK_VITEST_HARNESS
        state = [string]$env:AO_ORCHESTRATOR_ESCALATION_STATE
        inbox = [string]$env:AO_OPERATOR_ESCALATION_INBOX
        health = [string]$env:AO_ESCALATION_HEALTH_SPOOL
      } | ConvertTo-Json -Compress
    `;
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env },
    });
    expect(result.status, `${result.stderr}${result.stdout}`).toBe(0);
    const parsed = JSON.parse(`${result.stdout}`.trim().split('\n').at(-1) ?? '{}');

    expect(parsed.marker).toBe('1');
    expect(parsed.state).toBe(process.env.AO_ORCHESTRATOR_ESCALATION_STATE);
    expect(parsed.inbox).toBe(process.env.AO_OPERATOR_ESCALATION_INBOX);
    expect(parsed.health).toBe(process.env.AO_ESCALATION_HEALTH_SPOOL);
    expect(parsed.state).not.toBe(sharedDefaultEscalationStatePath());

    const laneScript = join(repoRoot, 'scripts/run-vitest-light-lane.ps1');
    const laneSource = readFileSync(laneScript, 'utf8');
    expect(laneSource).toMatch(/Set-OpkVitestHarnessEnv/);
  });
});
