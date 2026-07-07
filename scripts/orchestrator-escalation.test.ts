import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..');

function ps(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function pwsh(script: string, env: Record<string, string> = {}) {
  const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    status: result.status ?? 1,
    stdout: `${result.stdout ?? ''}`,
    stderr: `${result.stderr ?? ''}`,
  };
}

function runJson(script: string, env: Record<string, string> = {}) {
  const result = pwsh(script, env);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}');
}

describe('orchestrator escalation contract (#641)', () => {
  let tempDir = '';
  let state = '';
  let inbox = '';
  let health = '';

  beforeEach(() => {
    tempDir = join(tmpdir(), `escalation-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    state = join(tempDir, 'state.json');
    inbox = join(tempDir, 'operator-inbox');
    health = join(tempDir, 'health');
  });

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('escalation ack stops redelivery and bogus ack is rejected', () => {
    const parsed = runJson(`
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $pub = Publish-OrchestratorEscalation -EscalationClassId 'escalation-dead-worker-recovery' -CorrelationKey 'corr:recovery:s1' -Payload @{ reason = 'spawn_denied' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -OrchestratorSessionId 'orch-test' -NowMs 1000 -DryRun
      $bogus = Write-OrchestratorEscalationAck -EscalationId $pub.escalationId -AckToken 'bogus' -StatePath ${ps(state)} -NowMs 2000
      $good = Write-OrchestratorEscalationAck -EscalationId $pub.escalationId -AckToken $pub.ackToken -StatePath ${ps(state)} -NowMs 3000
      $repub = Publish-OrchestratorEscalation -EscalationClassId 'escalation-dead-worker-recovery' -CorrelationKey 'corr:recovery:s1' -Payload @{ reason = 'spawn_denied' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -OrchestratorSessionId 'orch-test' -NowMs 40000 -DryRun
      [pscustomobject]@{ bogusOk = [bool]$bogus.ok; goodOk = [bool]$good.ok; repubReason = [string]$repub.reason; repubDelivered = [bool]$repub.delivered } | ConvertTo-Json -Compress
    `);
    expect(parsed).toEqual({
      bogusOk: false,
      goodOk: true,
      repubReason: 'already_acked',
      repubDelivered: false,
    });
  });

  it('escalation publish fail closed inbox', () => {
    const parsed = runJson(`
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $env:AO_ESCALATION_FORCE_SEND_FAILURE = '1'
      $r = Publish-OrchestratorEscalation -EscalationClassId 'escalation-dead-worker-recovery' -CorrelationKey 'corr:fail-closed:s1' -Payload @{ reason = 'forced' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -OrchestratorSessionId 'orch-test' -NowMs 1000
      $files = @(Get-ChildItem -LiteralPath ${ps(inbox)} -Filter '*.json' -ErrorAction SilentlyContinue)
      [pscustomobject]@{ ok = [bool]$r.ok; status = [string]$r.status; inboxCount = $files.Count } | ConvertTo-Json -Compress
    `);
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe('fail_closed');
    expect(parsed.inboxCount).toBe(1);
  });

  it('escalation wake storm cap', () => {
    const parsed = runJson(`
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $first = Publish-OrchestratorEscalation -EscalationClassId 'escalation-dead-worker-recovery' -CorrelationKey 'corr:storm:s1' -Payload @{ reason = 'test' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -OrchestratorSessionId 'orch-test' -NowMs 1000 -DryRun
      $second = Publish-OrchestratorEscalation -EscalationClassId 'escalation-dead-worker-recovery' -CorrelationKey 'corr:storm:s1' -Payload @{ reason = 'test' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -OrchestratorSessionId 'orch-test' -NowMs 2000 -DryRun
      [pscustomobject]@{ first = [string]$first.status; second = [string]$second.status; reason = [string]$second.reason } | ConvertTo-Json -Compress
    `);
    expect(parsed.first).toBe('delivered');
    expect(parsed.second).toBe('wake_suppressed');
    expect(parsed.reason).toBe('wake_storm_cap');
  });

  it('escalation meta watchdog writes health spool when inbox is unavailable', () => {
    const parsed = runJson(`
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $env:AO_ESCALATION_FORCE_SEND_FAILURE = '1'
      $env:AO_ESCALATION_FORCE_INBOX_FAILURE = '1'
      $r = Publish-OrchestratorEscalation -EscalationClassId 'escalation-dead-worker-recovery' -CorrelationKey 'corr:watchdog:s1' -Payload @{ reason = 'forced' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -OrchestratorSessionId 'orch-test' -NowMs 1000
      $files = @(Get-ChildItem -LiteralPath ${ps(health)} -Filter '*.json' -ErrorAction SilentlyContinue)
      [pscustomobject]@{ ok = [bool]$r.ok; status = [string]$r.status; healthCount = $files.Count } | ConvertTo-Json -Compress
    `);
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe('fail_closed');
    expect(parsed.healthCount).toBe(1);
    expect(existsSync(health)).toBe(true);
  });

  it('escalation auto retry promotion', () => {
    const parsed = runJson(`
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $statuses = @()
      foreach ($i in 1..5) {
        $r = Publish-OrchestratorEscalation -EscalationClassId 'escalation-ci-green-claim-audit' -CorrelationKey 'corr:ci-green:1:abc' -Payload @{ pr = 1; head = 'abc' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -OrchestratorSessionId 'orch-test' -NowMs (1000 + ($i * 31000)) -DryRun
        $statuses += [string]$r.status
      }
      [pscustomobject]@{ statuses = $statuses } | ConvertTo-Json -Compress
    `);
    expect(parsed.statuses.slice(0, 4)).toEqual([
      'auto_retry_waiting',
      'auto_retry_waiting',
      'auto_retry_waiting',
      'auto_retry_waiting',
    ]);
    expect(parsed.statuses.at(-1)).toBe('delivered');
  });

  it('operator ack validation rejects stale markers', () => {
    const parsed = runJson(`
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $pub = Publish-OrchestratorEscalation -EscalationClassId 'escalation-claim-store-integrity' -CorrelationKey 'corr:claim-store:ns' -Payload @{ failureKind = 'ambiguous_claim' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -NowMs 1000 -DryRun
      $bogus = Write-OperatorEscalationAck -EscalationId $pub.escalationId -AckToken 'bogus' -StatePath ${ps(state)} -NowMs 2000
      $good = Write-OperatorEscalationAck -EscalationId $pub.escalationId -AckToken $pub.ackToken -StatePath ${ps(state)} -NowMs 3000
      [pscustomobject]@{ bogusOk = [bool]$bogus.ok; bogusReason = [string]$bogus.reason; goodOk = [bool]$good.ok; goodStatus = [string]$good.status } | ConvertTo-Json -Compress
    `);
    expect(parsed.bogusOk).toBe(false);
    expect(parsed.bogusReason).toBe('invalid_ack_token');
    expect(parsed.goodOk).toBe(true);
    expect(parsed.goodStatus).toBe('operator_acked');
  });

  it('escalation scenario matrix fixtures are present', () => {
    const fixtureDir = join(repoRoot, 'tests/fixtures/orchestrator-escalation');
    expect(existsSync(fixtureDir)).toBe(true);
    const matrix = JSON.parse(readFileSync(join(fixtureDir, 'scenario-matrix.json'), 'utf8'));
    expect(matrix.classes).toContain('escalation-dead-worker-recovery');
    expect(matrix.classes).toContain('escalation-worker-recovery');
  });
});
