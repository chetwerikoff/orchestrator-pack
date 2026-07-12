import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..');

function ps(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function runPwsh(script: string, env: Record<string, string> = {}) {
  return spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('orchestrator escalation router', () => {
  let tempDir = '';

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('worker degraded-ci handoff records llm-orchestrator escalation and router delivers it', () => {
    tempDir = join(tmpdir(), `worker-degraded-ci-${process.pid}-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    const state = join(tempDir, 'escalation-state.json');
    const inbox = join(tempDir, 'operator-inbox');
    const health = join(tempDir, 'health');
    const pendingFixture = join(
      repoRoot,
      'scripts/fixtures/side-process-launch-contract/pending-llm-orchestrator-escalation.json',
    );

    const emit = runPwsh(
      `
      . ./scripts/lib/Invoke-WorkerDegradedCiHandoff.ps1
      $result = Invoke-WorkerDegradedCiHandoff -PrNumber 48 -PrHeadSha 'handoff48' -WorkerSessionId 'op-worker-48' -Reason 'required checks missing' -PrUrl 'https://github.com/chetwerikoff/orchestrator-pack/pull/48' -OrchestratorSessionId 'orch-test' -DryRun
      $state = Get-Content -LiteralPath ${ps(state)} -Raw | ConvertFrom-Json
      $record = $state.records.PSObject.Properties.Value | Select-Object -First 1
      [pscustomobject]@{
        ok = [bool]$result.ok
        status = [string]$result.status
        escalationClassId = [string]$record.escalationClassId
        route = [string]$record.route
        attempts = [int]$record.attempts
      } | ConvertTo-Json -Compress
    `,
      {
        AO_ORCHESTRATOR_ESCALATION_STATE: state,
        AO_ORCHESTRATOR_ESCALATION_OPERATOR_INBOX: inbox,
        AO_ORCHESTRATOR_ESCALATION_HEALTH_SPOOL: health,
      },
    );
    expect(emit.status, `${emit.stdout}\n${emit.stderr}`).toBe(0);
    const emitted = JSON.parse(emit.stdout.trim().split('\n').at(-1) ?? '{}') as {
      ok: boolean;
      status: string;
      escalationClassId: string;
      route: string;
      attempts: number;
    };
    expect(emitted.ok).toBe(true);
    expect(emitted.status).toBe('delivered');
    expect(emitted.escalationClassId).toBe('escalation-worker-degraded-ci-handoff');
    expect(emitted.route).toBe('llm-orchestrator');
    expect(emitted.attempts).toBe(1);

    writeFileSync(state, readFileSync(pendingFixture, 'utf8'));
    const prepareFixture = runPwsh(
      `
      $doc = Get-Content -LiteralPath ${ps(state)} -Raw | ConvertFrom-Json
      $record = $doc.records.PSObject.Properties.Value | Select-Object -First 1
      $record.escalationClassId = 'escalation-worker-degraded-ci-handoff'
      $record.correlationKey = 'corr:worker-degraded-ci:48:handoff48'
      $record.lastPayload = @{
        prNumber = 48
        prHeadSha = 'handoff48'
        workerSessionId = 'op-worker-48'
        reason = 'required checks missing'
      }
      $record.lastMessage = 'worker degraded-ci handoff fixture'
      $record.status = 'pending'
      $record.attempts = 0
      $doc.wakeWindows = @{}
      $doc | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath ${ps(state)}
    `,
    );
    expect(prepareFixture.status, `${prepareFixture.stdout}\n${prepareFixture.stderr}`).toBe(0);

    const router = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        'scripts/orchestrator-escalation-router.ps1',
        '-OrchestratorSessionId',
        'orch-test',
        '-Once',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          AO_ESCALATION_FORCE_SEND_FAILURE: '1',
          AO_ORCHESTRATOR_ESCALATION_STATE: state,
          AO_ORCHESTRATOR_ESCALATION_OPERATOR_INBOX: inbox,
          AO_ORCHESTRATOR_ESCALATION_HEALTH_SPOOL: health,
        },
      },
    );
    expect(router.status, `${router.stdout}\n${router.stderr}`).toBe(0);
    expect(router.stdout).toMatch(/tick complete redelivered=/);

    const helperSource = readFileSync(
      join(repoRoot, 'scripts/lib/Invoke-WorkerDegradedCiHandoff.ps1'),
      'utf8',
    );
    expect(helperSource).not.toMatch(/\bao send\b/);

    const after = JSON.parse(readFileSync(state, 'utf8')) as {
      records: Record<
        string,
        {
          escalationClassId?: string;
          correlationKey?: string;
          route?: string;
          status?: string;
          attempts?: number;
          acknowledgedAtMs?: number | null;
        }
      >;
    };
    const canonicalRecord = Object.values(after.records).find(
      (record) =>
        record.escalationClassId === 'escalation-worker-degraded-ci-handoff' &&
        record.correlationKey === 'corr:worker-degraded-ci:48:handoff48' &&
        record.route === 'llm-orchestrator' &&
        (record.attempts ?? 0) > 0,
    );
    expect(canonicalRecord).toBeDefined();
    expect(canonicalRecord?.status).toBe('pending');
    expect(canonicalRecord?.acknowledgedAtMs ?? null).toBeNull();
  });

  it('preserves earlier in-memory router mutations when a later replay reloads state', () => {
    tempDir = join(tmpdir(), `router-state-merge-${process.pid}-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    const state = join(tempDir, 'escalation-state.json');
    const inbox = join(tempDir, 'operator-inbox');
    const health = join(tempDir, 'health');

    const seed = runPwsh(
      `
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $first = Publish-OrchestratorEscalation -EscalationClassId 'escalation-worker-degraded-ci-handoff' -CorrelationKey 'corr:worker-degraded-ci:51:head-a' -Payload @{ prNumber = 51; prHeadSha = 'head-a'; workerSessionId = 'worker-51'; reason = 'required checks missing' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -OrchestratorSessionId 'orch-test' -NowMs 1000 -DryRun
      $second = Publish-OrchestratorEscalation -EscalationClassId 'escalation-worker-degraded-ci-handoff' -CorrelationKey 'corr:worker-degraded-ci:52:head-b' -Payload @{ prNumber = 52; prHeadSha = 'head-b'; workerSessionId = 'worker-52'; reason = 'required checks missing' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -OrchestratorSessionId 'orch-test' -NowMs 2000 -DryRun
      $doc = Get-MechanicalJsonStateFile -Path ${ps(state)} -DefaultState $Script:OrchestratorEscalationDefaultState
      $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      $firstRecord = $doc.records[$first.escalationId]
      $secondRecord = $doc.records[$second.escalationId]
      $firstRecord.status = 'pending'
      $firstRecord.attempts = 1
      $firstRecord.firstAttemptAtMs = $now
      $firstRecord.lastAttemptAtMs = $now
      $secondRecord.status = 'pending'
      $secondRecord.attempts = 0
      $secondRecord.firstAttemptAtMs = 0
      $secondRecord.lastAttemptAtMs = 0
      $doc.wakeWindows = @{}
      Set-MechanicalJsonStateFile -Path ${ps(state)} -State $doc -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
    `,
    );
    expect(seed.status, `${seed.stdout}\n${seed.stderr}`).toBe(0);

    const router = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        'scripts/orchestrator-escalation-router.ps1',
        '-OrchestratorSessionId',
        'orch-test',
        '-Once',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          AO_ESCALATION_FORCE_SEND_FAILURE: '1',
          AO_ORCHESTRATOR_ESCALATION_STATE: state,
          AO_ORCHESTRATOR_ESCALATION_OPERATOR_INBOX: inbox,
          AO_ORCHESTRATOR_ESCALATION_HEALTH_SPOOL: health,
        },
      },
    );
    expect(router.status, `${router.stdout}\n${router.stderr}`).toBe(0);

    const after = JSON.parse(readFileSync(state, 'utf8')) as {
      records: Record<
        string,
        {
          correlationKey?: string;
          status?: string;
          attempts?: number;
        }
      >;
    };
    const firstRecord = Object.values(after.records).find(
      (record) => record.correlationKey === 'corr:worker-degraded-ci:51:head-a',
    );
    const secondRecord = Object.values(after.records).find(
      (record) => record.correlationKey === 'corr:worker-degraded-ci:52:head-b',
    );

    expect(firstRecord?.status).toBe('backoff_waiting');
    expect(secondRecord?.attempts ?? 0).toBeGreaterThan(0);
  });

  it('quarantines malformed or foreign records with visibility and recoverable release/delete paths', () => {
    tempDir = join(tmpdir(), `router-quarantine-${process.pid}-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    const state = join(tempDir, 'escalation-state.json');
    const inbox = join(tempDir, 'operator-inbox');
    const health = join(tempDir, 'health');

    const seeded = runPwsh(
      `
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $foreign = Publish-OrchestratorEscalation -EscalationClassId 'escalation-dead-worker-recovery' -CorrelationKey 'foreign:dead-worker:test' -Payload @{ reason = 'spawn_denied'; source_process = 'vitest-foreign' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -OrchestratorSessionId 'orch-test' -NowMs 1000 -DryRun
      $unknown = Publish-OrchestratorEscalation -EscalationClassId 'escalation-dead-worker-recovery' -CorrelationKey 'corr:unknown-class:test' -Payload @{ reason = 'spawn_denied' } -StatePath ${ps(state)} -OperatorInboxDir ${ps(inbox)} -HealthSpoolDir ${ps(health)} -OrchestratorSessionId 'orch-test' -NowMs 2000 -DryRun
      $doc = Get-MechanicalJsonStateFile -Path ${ps(state)} -DefaultState $Script:OrchestratorEscalationDefaultState
      $doc.records[$unknown.escalationId].escalationClassId = 'escalation-unknown-class'
      Set-MechanicalJsonStateFile -Path ${ps(state)} -State $doc -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
      [pscustomobject]@{ foreignId = [string]$foreign.escalationId; unknownId = [string]$unknown.escalationId } | ConvertTo-Json -Compress
    `,
    );
    expect(seeded.status, `${seeded.stdout}\n${seeded.stderr}`).toBe(0);
    const ids = JSON.parse(seeded.stdout.trim().split('\n').at(-1) ?? '{}') as { foreignId: string; unknownId: string };

    const router = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        'scripts/orchestrator-escalation-router.ps1',
        '-OrchestratorSessionId',
        'orch-test',
        '-Once',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          AO_ORCHESTRATOR_ESCALATION_STATE: state,
          AO_ORCHESTRATOR_ESCALATION_OPERATOR_INBOX: inbox,
          AO_ORCHESTRATOR_ESCALATION_HEALTH_SPOOL: health,
        },
      },
    );
    expect(router.status, `${router.stdout}\n${router.stderr}`).toBe(0);

    const beforeRelease = JSON.parse(readFileSync(state, 'utf8')) as {
      records: Record<
        string,
        {
          status?: string;
          terminalState?: string;
          terminalReason?: string;
          operatorOutbox?: string;
          operatorInboxPath?: string;
        }
      >;
    };
    expect(beforeRelease.records[ids.foreignId]?.status).toBe('quarantined');
    expect(beforeRelease.records[ids.foreignId]?.terminalReason).toBe('foreign_record');
    expect(beforeRelease.records[ids.foreignId]?.operatorOutbox).toBe('published');
    expect(beforeRelease.records[ids.foreignId]?.operatorInboxPath).toBeTruthy();
    expect(beforeRelease.records[ids.unknownId]?.status).toBe('quarantined');
    expect(beforeRelease.records[ids.unknownId]?.terminalReason).toBe('unknown_escalation_class');

    const actions = runPwsh(
      `
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $release = Write-OrchestratorEscalationQuarantineAction -EscalationId ${ps(ids.foreignId)} -Action release -StatePath ${ps(state)} -NowMs 5000
      $delete = Write-OrchestratorEscalationQuarantineAction -EscalationId ${ps(ids.unknownId)} -Action delete -StatePath ${ps(state)} -NowMs 6000
      [pscustomobject]@{ release = $release; delete = $delete } | ConvertTo-Json -Compress -Depth 10
    `,
    );
    expect(actions.status, `${actions.stdout}\n${actions.stderr}`).toBe(0);
    const actionResult = JSON.parse(actions.stdout.trim().split('\n').at(-1) ?? '{}') as {
      release: { ok: boolean; status: string };
      delete: { ok: boolean; status: string };
    };
    expect(actionResult.release).toMatchObject({ ok: true, status: 'released' });
    expect(actionResult.delete).toMatchObject({ ok: true, status: 'deleted' });

    const finalState = JSON.parse(readFileSync(state, 'utf8')) as {
      records: Record<
        string,
        {
          status?: string;
          terminalState?: string;
          quarantineReleasedAtMs?: number;
        }
      >;
    };
    expect(finalState.records[ids.foreignId]?.status).toBe('pending');
    expect(finalState.records[ids.foreignId]?.terminalState).toBe('open');
    expect(finalState.records[ids.foreignId]?.quarantineReleasedAtMs).toBeTruthy();
    expect(finalState.records[ids.unknownId]).toBeUndefined();
  });
});
