import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProcessSync } from '../scripts/kernel/subprocess.ts';

const repoRoot = join(import.meta.dirname, '..');

function ps(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

type OperatorWriterMatrix = {
  tieOk: boolean;
  tieStatus: string;
  tieAtMs: number;
  tieUpdatedAtMs: number;
  tieAttempts: number;
  tieFirstAttemptAtMs: number;
  newerOk: boolean;
  newerStatus: string;
  newerAtMs: number;
  newerUpdatedAtMs: number;
};

let root = '';
let matrix!: OperatorWriterMatrix;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'escalation-terminal-writers-operator-'));
  const tiePath = join(root, 'operator-tie.json');
  const newerPath = join(root, 'operator-newer.json');

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

        Set-FixtureState -Path ${ps(tiePath)} -Record (New-FixtureRecord)
        $tieMemory = Get-MechanicalJsonStateFile -Path ${ps(tiePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
        $tieMemory.records['alpha'].updatedAtMs = 1100
        $tieMemory.records['alpha'].attempts = 5
        $tieMemory.records['alpha'].firstAttemptAtMs = 901
        $tieAck = Write-OperatorEscalationAck -EscalationId 'alpha' -AckToken 'token-alpha' -StatePath ${ps(tiePath)} -NowMs 1100
        $tieDisk = Get-MechanicalJsonStateFile -Path ${ps(tiePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
        $tieMerged = Merge-OrchestratorEscalationRouterWritebackState -State $tieMemory -DiskState $tieDisk -DirtyRecordKeys @('alpha') -SnapshotLoadedAtMs 1000

        Set-FixtureState -Path ${ps(newerPath)} -Record (New-FixtureRecord @{ updatedAtMs = 1100 })
        $newerMemory = Get-MechanicalJsonStateFile -Path ${ps(newerPath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
        $newerAck = Write-OperatorEscalationAck -EscalationId 'alpha' -AckToken 'token-alpha' -StatePath ${ps(newerPath)} -NowMs 1101
        $newerDisk = Get-MechanicalJsonStateFile -Path ${ps(newerPath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
        $newerMerged = Merge-OrchestratorEscalationRouterWritebackState -State $newerMemory -DiskState $newerDisk -DirtyRecordKeys @('alpha') -SnapshotLoadedAtMs 1000

        [pscustomobject]@{
          tieOk = [bool]$tieAck.ok
          tieStatus = [string]$tieMerged.records['alpha'].operatorStatus
          tieAtMs = [long]$tieMerged.records['alpha'].operatorAckedAtMs
          tieUpdatedAtMs = [long]$tieDisk.records['alpha'].updatedAtMs
          tieAttempts = [int]$tieMerged.records['alpha'].attempts
          tieFirstAttemptAtMs = [long]$tieMerged.records['alpha'].firstAttemptAtMs
          newerOk = [bool]$newerAck.ok
          newerStatus = [string]$newerMerged.records['alpha'].operatorStatus
          newerAtMs = [long]$newerMerged.records['alpha'].operatorAckedAtMs
          newerUpdatedAtMs = [long]$newerMerged.records['alpha'].updatedAtMs
        } | ConvertTo-Json -Compress
      `,
    ],
    cwd: repoRoot,
    inheritParentEnv: true,
  });

  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  matrix = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as OperatorWriterMatrix;
}, 120_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('escalation-store operator ACK writers', () => {
  it('preserves a same-millisecond operator ACK and bookkeeping', () => {
    expect(matrix).toMatchObject({
      tieOk: true,
      tieStatus: 'acked',
      tieAtMs: 1100,
      tieUpdatedAtMs: 1100,
      tieAttempts: 5,
      tieFirstAttemptAtMs: 901,
    });
  });
  it('preserves a strictly newer operator ACK', () => {
    expect(matrix).toMatchObject({
      newerOk: true,
      newerStatus: 'acked',
      newerAtMs: 1101,
      newerUpdatedAtMs: 1101,
    });
  });
});
