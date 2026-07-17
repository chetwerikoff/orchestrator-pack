import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProcessSync } from '../scripts/kernel/subprocess.ts';

const repoRoot = join(import.meta.dirname, '..');

function ps(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

type WriterCoreMatrix = {
  ackMidTickOk: boolean;
  ackMidTickState: string;
  releaseWriterState: string;
  deleteWriterMissing: boolean;
  publisherAckSuccessState: string;
  publisherAckFailureState: string;
  publisherDeleteMissing: boolean;
  publisherOperatorStatus: string;
  publisherOperatorAckedAtMs: number;
  publisherNewRecordPresent: boolean;
};

let root = '';
let matrix!: WriterCoreMatrix;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'escalation-terminal-writers-core-'));
  const ackPath = join(root, 'ack.json');
  const releasePath = join(root, 'release.json');
  const deletePath = join(root, 'delete.json');
  const publisherAckSuccessPath = join(root, 'publisher-ack-success.json');
  const publisherAckFailurePath = join(root, 'publisher-ack-failure.json');
  const publisherDeletePath = join(root, 'publisher-delete.json');
  const publisherOperatorPath = join(root, 'publisher-operator.json');
  const publisherNewRecordPath = join(root, 'publisher-new-record.json');

  const result = runProcessSync({
    command: 'pwsh',
    args: [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `
        . ./scripts/lib/Orchestrator-Escalation.ps1

        function New-FixtureRecord {
          param([hashtable]$Overrides = @{})
          $record = @{
            schemaVersion = 2
            recordKey = 'alpha'
            escalationId = 'alpha'
            ackToken = 'token-alpha'
            route = 'llm-orchestrator'
            status = 'pending'
            terminalState = 'open'
            operatorStatus = 'pending'
            attempts = 1
            createdAtMs = 900
            updatedAtMs = 1000
          }
          foreach ($key in $Overrides.Keys) { $record[$key] = $Overrides[$key] }
          return $record
        }

        function Set-FixtureState {
          param([string]$Path, [hashtable]$Record)
          $state = @{ schemaVersion = 2; records = @{ alpha = $Record }; wakeWindows = @{}; audit = @{} }
          Set-MechanicalJsonStateFile -Path $Path -State $state -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
        }

        Set-FixtureState -Path ${ps(ackPath)} -Record (New-FixtureRecord)
        $ackMemory = Get-MechanicalJsonStateFile -Path ${ps(ackPath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
        $ackMemory.records['alpha'].status = 'backoff_waiting'
        $ackMemory.records['alpha'].firstAttemptAtMs = 900
        $ackMidTick = Write-OrchestratorEscalationAck -EscalationId 'alpha' -AckToken 'token-alpha' -StatePath ${ps(ackPath)} -NowMs 1100
        $ackDisk = Get-MechanicalJsonStateFile -Path ${ps(ackPath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
        $ackMerged = Merge-OrchestratorEscalationRouterWritebackState -State $ackMemory -DiskState $ackDisk -DirtyRecordKeys @('alpha') -SnapshotLoadedAtMs 1000

        Set-FixtureState -Path ${ps(releasePath)} -Record (New-FixtureRecord @{ terminalState = 'quarantined'; status = 'quarantined'; updatedAtMs = 1000 })
        $releaseMemory = Get-MechanicalJsonStateFile -Path ${ps(releasePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
        $releaseMemory.records['alpha'].updatedAtMs = 1300
        $null = Write-OrchestratorEscalationQuarantineAction -EscalationId 'alpha' -Action release -StatePath ${ps(releasePath)} -NowMs 1100
        $releaseDisk = Get-MechanicalJsonStateFile -Path ${ps(releasePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
        $releaseMerged = Merge-OrchestratorEscalationRouterWritebackState -State $releaseMemory -DiskState $releaseDisk -DirtyRecordKeys @('alpha') -SnapshotLoadedAtMs 1100

        Set-FixtureState -Path ${ps(deletePath)} -Record (New-FixtureRecord @{ terminalState = 'quarantined'; status = 'quarantined'; updatedAtMs = 1000 })
        $deleteMemory = Get-MechanicalJsonStateFile -Path ${ps(deletePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
        $null = Write-OrchestratorEscalationQuarantineAction -EscalationId 'alpha' -Action delete -StatePath ${ps(deletePath)} -NowMs 1100
        $deleteDisk = Get-MechanicalJsonStateFile -Path ${ps(deletePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
        $deleteMerged = Merge-OrchestratorEscalationRouterWritebackState -State $deleteMemory -DiskState $deleteDisk -DirtyRecordKeys @('alpha') -SnapshotLoadedAtMs 1000

        $script:PublisherDeliveryStatePath = ''
        $script:PublisherDeliveryMode = ''
        function Invoke-OrchestratorEscalationLlmDelivery {
          param(
            [Parameter(Mandatory = $true)]$Envelope,
            [string]$OrchestratorSessionId = '',
            [string]$AoPath = 'ao',
            [switch]$DryRun
          )

          if ($script:PublisherDeliveryMode -eq 'delete') {
            $deleteState = Get-MechanicalJsonStateFile -Path $script:PublisherDeliveryStatePath -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
            $deleteRecord = Sync-OrchestratorEscalationMutableRecord -State $deleteState -RecordKey ([string]$Envelope.escalation_id)
            Resolve-OrchestratorEscalationTerminalState -Record $deleteRecord -TerminalState 'quarantined' -Now 1050 -Reason 'fixture_delete' | Out-Null
            Set-MechanicalJsonStateFile -Path $script:PublisherDeliveryStatePath -State $deleteState -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
            $deleteResult = Write-OrchestratorEscalationQuarantineAction -EscalationId ([string]$Envelope.escalation_id) -Action delete -StatePath $script:PublisherDeliveryStatePath -NowMs 1100
            if (-not $deleteResult.ok) { throw "fixture delete failed: $($deleteResult.reason)" }
            return @{ ok = $true; reason = 'fixture_delete' }
          }

          if ($script:PublisherDeliveryMode -eq 'operator-ack') {
            $operatorResult = Write-OperatorEscalationAck -EscalationId ([string]$Envelope.escalation_id) -AckToken ([string]$Envelope.ack_token) -StatePath $script:PublisherDeliveryStatePath -NowMs 1100
            if (-not $operatorResult.ok) { throw "fixture operator ACK failed: $($operatorResult.reason)" }
            return @{ ok = $true; reason = 'fixture_operator_ack' }
          }

          if ($script:PublisherDeliveryMode -eq 'new-record') {
            return @{ ok = $true; reason = 'fixture_new_record' }
          }

          $ackResult = Write-OrchestratorEscalationAck -EscalationId ([string]$Envelope.escalation_id) -AckToken ([string]$Envelope.ack_token) -StatePath $script:PublisherDeliveryStatePath -NowMs 1100
          if (-not $ackResult.ok) { throw "fixture ACK failed: $($ackResult.reason)" }
          if ($script:PublisherDeliveryMode -eq 'ack-failure') { throw 'fixture delivery failed after ACK' }
          return @{ ok = $true; reason = 'fixture_ack' }
        }

        Set-FixtureState -Path ${ps(publisherAckSuccessPath)} -Record (New-FixtureRecord)
        $script:PublisherDeliveryStatePath = ${ps(publisherAckSuccessPath)}
        $script:PublisherDeliveryMode = 'ack-success'
        $null = Publish-OrchestratorEscalation -EscalationClassId 'escalation-dead-worker-recovery' -CorrelationKey 'publisher-success' -Payload @{ failure_kind = 'fixture' } -StatePath ${ps(publisherAckSuccessPath)} -OrchestratorSessionId 'fixture-session' -ReplayEscalationId 'alpha' -SkipWakeSuppression -NowMs 1000
        $publisherAckSuccessDisk = Get-MechanicalJsonStateFile -Path ${ps(publisherAckSuccessPath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking

        Set-FixtureState -Path ${ps(publisherAckFailurePath)} -Record (New-FixtureRecord)
        $script:PublisherDeliveryStatePath = ${ps(publisherAckFailurePath)}
        $script:PublisherDeliveryMode = 'ack-failure'
        $null = Publish-OrchestratorEscalation -EscalationClassId 'escalation-dead-worker-recovery' -CorrelationKey 'publisher-failure' -Payload @{ failure_kind = 'fixture' } -StatePath ${ps(publisherAckFailurePath)} -OrchestratorSessionId 'fixture-session' -ReplayEscalationId 'alpha' -SkipWakeSuppression -NowMs 1000
        $publisherAckFailureDisk = Get-MechanicalJsonStateFile -Path ${ps(publisherAckFailurePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking

        Set-FixtureState -Path ${ps(publisherDeletePath)} -Record (New-FixtureRecord)
        $script:PublisherDeliveryStatePath = ${ps(publisherDeletePath)}
        $script:PublisherDeliveryMode = 'delete'
        $null = Publish-OrchestratorEscalation -EscalationClassId 'escalation-dead-worker-recovery' -CorrelationKey 'publisher-delete' -Payload @{ failure_kind = 'fixture' } -StatePath ${ps(publisherDeletePath)} -OrchestratorSessionId 'fixture-session' -ReplayEscalationId 'alpha' -SkipWakeSuppression -NowMs 1000
        $publisherDeleteDisk = Get-MechanicalJsonStateFile -Path ${ps(publisherDeletePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking

        Set-FixtureState -Path ${ps(publisherOperatorPath)} -Record (New-FixtureRecord)
        $script:PublisherDeliveryStatePath = ${ps(publisherOperatorPath)}
        $script:PublisherDeliveryMode = 'operator-ack'
        $null = Publish-OrchestratorEscalation -EscalationClassId 'escalation-dead-worker-recovery' -CorrelationKey 'publisher-operator' -Payload @{ failure_kind = 'fixture' } -StatePath ${ps(publisherOperatorPath)} -OrchestratorSessionId 'fixture-session' -ReplayEscalationId 'alpha' -SkipWakeSuppression -NowMs 1000
        $publisherOperatorDisk = Get-MechanicalJsonStateFile -Path ${ps(publisherOperatorPath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking

        $script:PublisherDeliveryStatePath = ${ps(publisherNewRecordPath)}
        $script:PublisherDeliveryMode = 'new-record'
        $publisherNewRecord = Publish-OrchestratorEscalation -EscalationClassId 'escalation-dead-worker-recovery' -CorrelationKey 'publisher-new-record' -Payload @{ failure_kind = 'fixture-new-record' } -StatePath ${ps(publisherNewRecordPath)} -OrchestratorSessionId 'fixture-session' -SkipWakeSuppression -NowMs 1000
        $publisherNewRecordDisk = Get-MechanicalJsonStateFile -Path ${ps(publisherNewRecordPath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking

        [pscustomobject]@{
          ackMidTickOk = [bool]$ackMidTick.ok
          ackMidTickState = [string]$ackMerged.records['alpha'].terminalState
          releaseWriterState = [string]$releaseMerged.records['alpha'].terminalState
          deleteWriterMissing = -not $deleteMerged.records.ContainsKey('alpha')
          publisherAckSuccessState = [string]$publisherAckSuccessDisk.records['alpha'].terminalState
          publisherAckFailureState = [string]$publisherAckFailureDisk.records['alpha'].terminalState
          publisherDeleteMissing = -not $publisherDeleteDisk.records.ContainsKey('alpha')
          publisherOperatorStatus = [string]$publisherOperatorDisk.records['alpha'].operatorStatus
          publisherOperatorAckedAtMs = [long]$publisherOperatorDisk.records['alpha'].operatorAckedAtMs
          publisherNewRecordPresent = $publisherNewRecordDisk.records.ContainsKey([string]$publisherNewRecord.escalationId)
        } | ConvertTo-Json -Compress
      `,
    ],
    cwd: repoRoot,
    inheritParentEnv: true,
  });

  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  matrix = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as WriterCoreMatrix;
}, 120_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('escalation-store ACK and quarantine writers', () => {
  it('preserves an ACK written between snapshot and dirty writeback', () => {
    expect(matrix).toMatchObject({ ackMidTickOk: true, ackMidTickState: 'acked' });
  });
  it('preserves an actual quarantine release', () => expect(matrix.releaseWriterState).toBe('open'));
  it('preserves an actual quarantine deletion', () => expect(matrix.deleteWriterMissing).toBe(true));
  it('preserves an ACK written inside successful publisher delivery', () => {
    expect(matrix.publisherAckSuccessState).toBe('acked');
  });
  it('preserves an ACK written before publisher delivery fails', () => {
    expect(matrix.publisherAckFailureState).toBe('acked');
  });
  it('does not resurrect a record deleted inside publisher delivery', () => {
    expect(matrix.publisherDeleteMissing).toBe(true);
  });
  it('preserves an operator ACK written inside publisher delivery', () => {
    expect(matrix).toMatchObject({ publisherOperatorStatus: 'acked', publisherOperatorAckedAtMs: 1100 });
  });
  it('persists a record created by a fresh publisher call', () => {
    expect(matrix.publisherNewRecordPresent).toBe(true);
  });
});
