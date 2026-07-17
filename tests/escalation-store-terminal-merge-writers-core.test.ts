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
};

let root = '';
let matrix!: WriterCoreMatrix;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'escalation-terminal-writers-core-'));
  const ackPath = join(root, 'ack.json');
  const releasePath = join(root, 'release.json');
  const deletePath = join(root, 'delete.json');

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

        [pscustomobject]@{
          ackMidTickOk = [bool]$ackMidTick.ok
          ackMidTickState = [string]$ackMerged.records['alpha'].terminalState
          releaseWriterState = [string]$releaseMerged.records['alpha'].terminalState
          deleteWriterMissing = -not $deleteMerged.records.ContainsKey('alpha')
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
});
