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

  it('escalation ack holds the condition terminal until it clears and bogus ack is rejected', () => {
    const parsed = runJson(`
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $pub = Publish-OrchestratorEscalation -EscalationClassId 'escalation-dead-worker-recovery' -CorrelationKey 'corr:recovery:s1' -Payload @{ reason = 'spawn_denied' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -OrchestratorSessionId 'orch-test' -NowMs 1000 -DryRun
      $bogus = Write-OrchestratorEscalationAck -EscalationId $pub.escalationId -AckToken 'bogus' -StatePath ${ps(state)} -NowMs 2000
      $good = Write-OrchestratorEscalationAck -EscalationId $pub.escalationId -AckToken $pub.ackToken -StatePath ${ps(state)} -NowMs 3000
      $repub = Publish-OrchestratorEscalation -EscalationClassId 'escalation-dead-worker-recovery' -CorrelationKey 'corr:recovery:s1' -Payload @{ reason = 'spawn_denied' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -OrchestratorSessionId 'orch-test' -NowMs 40000 -DryRun
      $clear = Resolve-OrchestratorEscalationCondition -EscalationClassId 'escalation-dead-worker-recovery' -Payload @{ reason = 'spawn_denied' } -StatePath ${ps(state)} -NowMs 50000
      $afterClear = Publish-OrchestratorEscalation -EscalationClassId 'escalation-dead-worker-recovery' -CorrelationKey 'corr:recovery:s1' -Payload @{ reason = 'spawn_denied' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -OrchestratorSessionId 'orch-test' -NowMs 60000 -DryRun
      [pscustomobject]@{
        bogusOk = [bool]$bogus.ok
        goodOk = [bool]$good.ok
        repubStatus = [string]$repub.status
        repubReason = [string]$repub.reason
        repubDelivered = [bool]$repub.delivered
        clearStatus = [string]$clear.status
        afterClearStatus = [string]$afterClear.status
        afterClearDelivered = [bool]$afterClear.delivered
      } | ConvertTo-Json -Compress
    `);
    expect(parsed).toEqual({
      bogusOk: false,
      goodOk: true,
      repubStatus: 'acked',
      repubReason: 'already_acked',
      repubDelivered: false,
      clearStatus: 'resolved',
      afterClearStatus: 'delivered',
      afterClearDelivered: true,
    });
  });

  it('dead-lettered conditions stay terminal until the condition clears', () => {
    const parsed = runJson(`
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $pub = Publish-OrchestratorEscalation -EscalationClassId 'escalation-dead-worker-recovery' -CorrelationKey 'corr:dead-letter:s1' -Payload @{ reason = 'spawn_denied' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -OrchestratorSessionId 'orch-test' -NowMs 1000 -DryRun
      $stateFile = Get-MechanicalJsonStateFile -Path ${ps(state)} -DefaultState $Script:OrchestratorEscalationDefaultState
      $record = $stateFile.records[$pub.escalationId]
      Resolve-OrchestratorEscalationTerminalState -Record $record -TerminalState 'dead_lettered' -Now 2000 -Reason 'retry_cap_exhausted' | Out-Null
      Set-MechanicalJsonStateFile -Path ${ps(state)} -State $stateFile -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
      $repub = Publish-OrchestratorEscalation -EscalationClassId 'escalation-dead-worker-recovery' -CorrelationKey 'corr:dead-letter:s1' -Payload @{ reason = 'spawn_denied' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -OrchestratorSessionId 'orch-test' -NowMs 3000 -DryRun
      $clear = Resolve-OrchestratorEscalationCondition -EscalationClassId 'escalation-dead-worker-recovery' -Payload @{ reason = 'spawn_denied' } -StatePath ${ps(state)} -NowMs 4000
      $afterClear = Publish-OrchestratorEscalation -EscalationClassId 'escalation-dead-worker-recovery' -CorrelationKey 'corr:dead-letter:s1' -Payload @{ reason = 'spawn_denied' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -OrchestratorSessionId 'orch-test' -NowMs 50000 -DryRun
      [pscustomobject]@{
        repubStatus = [string]$repub.status
        repubReason = [string]$repub.reason
        repubDelivered = [bool]$repub.delivered
        clearStatus = [string]$clear.status
        afterClearStatus = [string]$afterClear.status
        afterClearDelivered = [bool]$afterClear.delivered
      } | ConvertTo-Json -Compress
    `);
    expect(parsed).toEqual({
      repubStatus: 'dead_lettered',
      repubReason: 'already_terminal',
      repubDelivered: false,
      clearStatus: 'resolved',
      afterClearStatus: 'delivered',
      afterClearDelivered: true,
    });
  });

  it('global condition keys include correlation so unrelated degraded-ci escalations do not collide', () => {
    const parsed = runJson(`
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $first = Publish-OrchestratorEscalation -EscalationClassId 'escalation-review-trigger-degraded-ci' -CorrelationKey 'corr:review-trigger:https://example.test/pr/1:head-a' -Payload @{ prNumber = 1; headSha = 'head-a'; message = 'required checks missing' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -OrchestratorSessionId 'orch-test' -NowMs 1000 -DryRun
      $second = Publish-OrchestratorEscalation -EscalationClassId 'escalation-review-trigger-degraded-ci' -CorrelationKey 'corr:review-trigger:https://example.test/pr/2:head-b' -Payload @{ prNumber = 2; headSha = 'head-b'; message = 'required checks missing' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -OrchestratorSessionId 'orch-test' -NowMs 2000 -DryRun
      $duplicate = Publish-OrchestratorEscalation -EscalationClassId 'escalation-review-trigger-degraded-ci' -CorrelationKey 'corr:review-trigger:https://example.test/pr/1:head-a' -Payload @{ prNumber = 1; headSha = 'head-a'; message = 'required checks missing' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -OrchestratorSessionId 'orch-test' -NowMs 3000 -DryRun
      $clearFirst = Resolve-OrchestratorEscalationCondition -EscalationClassId 'escalation-review-trigger-degraded-ci' -CorrelationKey 'corr:review-trigger:https://example.test/pr/1:head-a' -Payload @{ prNumber = 1; headSha = 'head-a'; message = 'required checks missing' } -StatePath ${ps(state)} -NowMs 4000
      $afterClear = Publish-OrchestratorEscalation -EscalationClassId 'escalation-review-trigger-degraded-ci' -CorrelationKey 'corr:review-trigger:https://example.test/pr/1:head-a' -Payload @{ prNumber = 1; headSha = 'head-a'; message = 'required checks missing' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -OrchestratorSessionId 'orch-test' -NowMs 40000 -DryRun
      [pscustomobject]@{
        firstStatus = [string]$first.status
        secondStatus = [string]$second.status
        duplicateStatus = [string]$duplicate.status
        duplicateReason = [string]$duplicate.reason
        clearFirstStatus = [string]$clearFirst.status
        afterClearStatus = [string]$afterClear.status
        distinctEscalationIds = ([string]$first.escalationId -ne [string]$second.escalationId)
      } | ConvertTo-Json -Compress
    `);
    expect(parsed).toEqual({
      firstStatus: 'delivered',
      secondStatus: 'delivered',
      duplicateStatus: 'open_existing',
      duplicateReason: 'condition_open',
      clearFirstStatus: 'resolved',
      afterClearStatus: 'delivered',
      distinctEscalationIds: true,
    });
  });

  it('escalation publish leaves llm delivery open for router retry', () => {
    const parsed = runJson(`
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $env:AO_ESCALATION_FORCE_SEND_FAILURE = '1'
      $r = Publish-OrchestratorEscalation -EscalationClassId 'escalation-dead-worker-recovery' -CorrelationKey 'corr:fail-closed:s1' -Payload @{ reason = 'forced' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -OrchestratorSessionId 'orch-test' -NowMs 1000
      $files = @(Get-ChildItem -LiteralPath ${ps(inbox)} -Filter '*.json' -ErrorAction SilentlyContinue)
      [pscustomobject]@{ ok = [bool]$r.ok; status = [string]$r.status; inboxCount = $files.Count } | ConvertTo-Json -Compress
    `);
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe('pending');
    expect(parsed.inboxCount).toBe(0);
  });

  it('escalation wake storm cap', () => {
    const parsed = runJson(`
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $first = Publish-OrchestratorEscalation -EscalationClassId 'escalation-dead-worker-recovery' -CorrelationKey 'corr:storm:s1' -Payload @{ reason = 'test' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -OrchestratorSessionId 'orch-test' -NowMs 1000 -DryRun
      $second = Publish-OrchestratorEscalation -EscalationClassId 'escalation-dead-worker-recovery' -CorrelationKey 'corr:storm:s1' -Payload @{ reason = 'test' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -OrchestratorSessionId 'orch-test' -NowMs 2000 -DryRun
      [pscustomobject]@{ first = [string]$first.status; second = [string]$second.status; reason = [string]$second.reason } | ConvertTo-Json -Compress
    `);
    expect(parsed.first).toBe('delivered');
    expect(parsed.second).toBe('open_existing');
    expect(parsed.reason).toBe('condition_open');
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
    expect(parsed.status).toBe('pending');
    expect(parsed.healthCount).toBe(0);
  });

  it('fail-closed persists state under ErrorActionPreference Stop when send and inbox fail', () => {
    const parsed = runJson(`
      $ErrorActionPreference = 'Stop'
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $env:AO_ESCALATION_FORCE_SEND_FAILURE = '1'
      $env:AO_ESCALATION_FORCE_INBOX_FAILURE = '1'
      $r = Publish-OrchestratorEscalation -EscalationClassId 'escalation-dead-worker-recovery' -CorrelationKey 'corr:stop-mode:s1' -Payload @{ reason = 'forced' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -OrchestratorSessionId 'orch-test' -NowMs 1000
      [pscustomobject]@{ ok = [bool]$r.ok; status = [string]$r.status; stateExists = (Test-Path -LiteralPath ${ps(state)}) } | ConvertTo-Json -Compress
    `);
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe('pending');
    expect(parsed.stateExists).toBe(true);
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

  it('operator-route failures preserve operatorFallback details', () => {
    const parsed = runJson(`
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $env:AO_ESCALATION_FORCE_INBOX_FAILURE = '1'
      $pub = Publish-OrchestratorEscalation -EscalationClassId 'escalation-claim-store-integrity' -CorrelationKey 'corr:claim-store:fail' -Payload @{ failureKind = 'ambiguous_claim' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -NowMs 1000
      $stateFile = Get-MechanicalJsonStateFile -Path ${ps(state)} -DefaultState $Script:OrchestratorEscalationDefaultState
      $record = $stateFile.records[$pub.escalationId]
      $healthFiles = @(Get-ChildItem -LiteralPath ${ps(health)} -Filter '*.json' -ErrorAction SilentlyContinue)
      [pscustomobject]@{
        ok = [bool]$pub.ok
        status = [string]$pub.status
        operatorOutbox = [string]$record.operatorOutbox
        fallbackOk = [bool]$record.operatorFallback.ok
        healthSpoolPath = [string]$record.operatorFallback.healthSpoolPath
        healthCount = $healthFiles.Count
      } | ConvertTo-Json -Compress
    `);
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe('pending');
    expect(parsed.operatorOutbox).toBe('failed');
    expect(parsed.fallbackOk).toBe(false);
    expect(parsed.healthSpoolPath).toBeTruthy();
    expect(parsed.healthCount).toBe(1);
  });

  it('capacity-class open records re-arm after the 15-minute source rate-limit window', () => {
    const parsed = runJson(`
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $first = Publish-OrchestratorEscalation -EscalationClassId 'escalation-claim-store-integrity' -CorrelationKey 'corr:capacity:claim-store' -Payload @{ failureKind = 'capacity_guard' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -NowMs 1000 -DryRun
      $withinWindow = Publish-OrchestratorEscalation -EscalationClassId 'escalation-claim-store-integrity' -CorrelationKey 'corr:capacity:claim-store' -Payload @{ failureKind = 'capacity_guard' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -NowMs 2000 -DryRun
      $afterWindow = Publish-OrchestratorEscalation -EscalationClassId 'escalation-claim-store-integrity' -CorrelationKey 'corr:capacity:claim-store' -Payload @{ failureKind = 'capacity_guard' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -NowMs 902000 -DryRun
      [pscustomobject]@{
        firstStatus = [string]$first.status
        withinWindowStatus = [string]$withinWindow.status
        afterWindowStatus = [string]$afterWindow.status
        afterWindowReason = [string]$afterWindow.reason
      } | ConvertTo-Json -Compress
    `);
    expect(parsed.firstStatus).toBe('operator_inbox');
    expect(parsed.withinWindowStatus).toBe('source_rate_limited');
    expect(parsed.afterWindowStatus).toBe('open_existing');
    expect(parsed.afterWindowReason).toBe('condition_open');
  });

  it('operator-route failures remain retryable by later source publishes', () => {
    const parsed = runJson(`
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $env:AO_ESCALATION_FORCE_INBOX_FAILURE = '1'
      $failed = Publish-OrchestratorEscalation -EscalationClassId 'escalation-claim-store-integrity' -CorrelationKey 'corr:claim-store:retryable' -Payload @{ failureKind = 'ambiguous_claim' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -NowMs 1000
      Remove-Item Env:AO_ESCALATION_FORCE_INBOX_FAILURE
      $retried = Publish-OrchestratorEscalation -EscalationClassId 'escalation-claim-store-integrity' -CorrelationKey 'corr:claim-store:retryable' -Payload @{ failureKind = 'ambiguous_claim' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -NowMs 2000
      $stateFile = Get-MechanicalJsonStateFile -Path ${ps(state)} -DefaultState $Script:OrchestratorEscalationDefaultState
      $record = $stateFile.records[$retried.escalationId]
      [pscustomobject]@{
        failedStatus = [string]$failed.status
        retriedStatus = [string]$retried.status
        attempts = [int]$record.attempts
        operatorOutbox = [string]$record.operatorOutbox
      } | ConvertTo-Json -Compress
    `);
    expect(parsed.failedStatus).toBe('pending');
    expect(parsed.retriedStatus).toBe('operator_inbox');
    expect(parsed.attempts).toBe(1);
    expect(parsed.operatorOutbox).toBe('published');
  });

  it('escalation scenario matrix fixtures are present', () => {
    const fixtureDir = join(repoRoot, 'tests/fixtures/orchestrator-escalation');
    expect(existsSync(fixtureDir)).toBe(true);
    const matrix = JSON.parse(readFileSync(join(fixtureDir, 'scenario-matrix.json'), 'utf8'));
    expect(matrix.classes).toContain('escalation-dead-worker-recovery');
    expect(matrix.classes).toContain('escalation-worker-recovery');
    expect(matrix.classes).toContain('escalation-worker-degraded-ci-handoff');
  });
});
