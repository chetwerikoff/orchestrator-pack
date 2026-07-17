import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProcessSync } from '../scripts/kernel/subprocess.ts';

const repoRoot = join(import.meta.dirname, '..');

function ps(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

type WriterAuxMatrix = {
  operatorWriterTieOk: boolean;
  operatorWriterTieStatus: string;
  operatorWriterTieAtMs: number;
  operatorWriterTieUpdatedAtMs: number;
  operatorWriterTieAttempts: number;
  operatorWriterTieFirstAttemptAtMs: number;
  operatorWriterNewerOk: boolean;
  operatorWriterNewerStatus: string;
  operatorWriterNewerAtMs: number;
  operatorWriterNewerUpdatedAtMs: number;
  replayAckOk: boolean;
  replayTerminalState: string;
  beforeAckOk: boolean;
  beforeState: string;
  afterAckOk: boolean;
  afterState: string;
};

let root = '';
let matrix!: WriterAuxMatrix;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'escalation-terminal-writers-aux-'));
  const operatorTiePath = join(root, 'operator-tie.json');
  const operatorNewerPath = join(root, 'operator-newer.json');
  const replayPath = join(root, 'replay.json');
  const safePath = join(root, 'safe.json');

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

        $tokens = $null
        $errors = $null
        $routerAst = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path './scripts/orchestrator-escalation-router.ps1'), [ref]$tokens, [ref]$errors)
        if ($errors.Count -gt 0) { throw ($errors | Out-String) }
        $mergeAst = $routerAst.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Merge-EscalationRouterReplayState' }, $true)
        if ($null -eq $mergeAst) { throw 'replay merge function not found' }
        Invoke-Expression $mergeAst.Extent.Text

        Set-FixtureState -Path ${ps(operatorTiePath)} -Record (New-FixtureRecord)
        $operatorTieMemory = Get-MechanicalJsonStateFile -Path ${ps(operatorTiePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
        $operatorTieMemory.records['alpha'].updatedAtMs = 1100
        $operatorTieMemory.records['alpha'].attempts = 5
        $operatorTieMemory.records['alpha'].firstAttemptAtMs = 901
        $operatorTieAck = Write-OperatorEscalationAck -EscalationId 'alpha' -AckToken 'token-alpha' -StatePath ${ps(operatorTiePath)} -NowMs 1100
        $operatorTieDisk = Get-MechanicalJsonStateFile -Path ${ps(operatorTiePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
        $operatorTieMerged = Merge-OrchestratorEscalationRouterWritebackState -State $operatorTieMemory -DiskState $operatorTieDisk -DirtyRecordKeys @('alpha') -SnapshotLoadedAtMs 1000

        Set-FixtureState -Path ${ps(operatorNewerPath)} -Record (New-FixtureRecord @{ updatedAtMs = 1100 })
        $operatorNewerMemory = Get-MechanicalJsonStateFile -Path ${ps(operatorNewerPath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
        $operatorNewerAck = Write-OperatorEscalationAck -EscalationId 'alpha' -AckToken 'token-alpha' -StatePath ${ps(operatorNewerPath)} -NowMs 1101
        $operatorNewerDisk = Get-MechanicalJsonStateFile -Path ${ps(operatorNewerPath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
        $operatorNewerMerged = Merge-OrchestratorEscalationRouterWritebackState -State $operatorNewerMemory -DiskState $operatorNewerDisk -DirtyRecordKeys @('alpha') -SnapshotLoadedAtMs 1000

        Set-FixtureState -Path ${ps(replayPath)} -Record (New-FixtureRecord)
        $replayMemory = Get-MechanicalJsonStateFile -Path ${ps(replayPath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
        $replayMemory.records['alpha'].firstAttemptAtMs = 900
        $replayMemory.records['alpha'].status = 'backoff_waiting'
        $replayDisk = Get-MechanicalJsonStateFile -Path ${ps(replayPath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
        Merge-EscalationRouterReplayState -State $replayMemory -DiskState $replayDisk -RecordKey 'alpha' -SnapshotLoadedAtMs 1000
        $replayAck = Write-OrchestratorEscalationAck -EscalationId 'alpha' -AckToken 'token-alpha' -StatePath ${ps(replayPath)} -NowMs 1100
        $replayFinalDisk = Get-MechanicalJsonStateFile -Path ${ps(replayPath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
        $replayFinal = Merge-OrchestratorEscalationRouterWritebackState -State $replayMemory -DiskState $replayFinalDisk -DirtyRecordKeys @('alpha') -SnapshotLoadedAtMs 1000

        Set-FixtureState -Path ${ps(safePath)} -Record (New-FixtureRecord)
        $beforeAck = Write-OrchestratorEscalationAck -EscalationId 'alpha' -AckToken 'token-alpha' -StatePath ${ps(safePath)} -NowMs 1000
        $beforeMemory = Get-MechanicalJsonStateFile -Path ${ps(safePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
        $beforeDisk = Get-MechanicalJsonStateFile -Path ${ps(safePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
        $beforeMerged = Merge-OrchestratorEscalationRouterWritebackState -State $beforeMemory -DiskState $beforeDisk -DirtyRecordKeys @('alpha') -SnapshotLoadedAtMs 1000

        Set-FixtureState -Path ${ps(safePath)} -Record (New-FixtureRecord @{ updatedAtMs = 1200 })
        $afterMemory = Get-MechanicalJsonStateFile -Path ${ps(safePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
        $afterDisk = Get-MechanicalJsonStateFile -Path ${ps(safePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
        $afterMerged = Merge-OrchestratorEscalationRouterWritebackState -State $afterMemory -DiskState $afterDisk -DirtyRecordKeys @('alpha') -SnapshotLoadedAtMs 1200
        Set-MechanicalJsonStateFile -Path ${ps(safePath)} -State $afterMerged -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
        $afterAck = Write-OrchestratorEscalationAck -EscalationId 'alpha' -AckToken 'token-alpha' -StatePath ${ps(safePath)} -NowMs 1300
        $afterFinal = Get-MechanicalJsonStateFile -Path ${ps(safePath)} -DefaultState $Script:OrchestratorEscalationDefaultState

        [pscustomobject]@{
          operatorWriterTieOk = [bool]$operatorTieAck.ok
          operatorWriterTieStatus = [string]$operatorTieMerged.records['alpha'].operatorStatus
          operatorWriterTieAtMs = [long]$operatorTieMerged.records['alpha'].operatorAckedAtMs
          operatorWriterTieUpdatedAtMs = [long]$operatorTieDisk.records['alpha'].updatedAtMs
          operatorWriterTieAttempts = [int]$operatorTieMerged.records['alpha'].attempts
          operatorWriterTieFirstAttemptAtMs = [long]$operatorTieMerged.records['alpha'].firstAttemptAtMs
          operatorWriterNewerOk = [bool]$operatorNewerAck.ok
          operatorWriterNewerStatus = [string]$operatorNewerMerged.records['alpha'].operatorStatus
          operatorWriterNewerAtMs = [long]$operatorNewerMerged.records['alpha'].operatorAckedAtMs
          operatorWriterNewerUpdatedAtMs = [long]$operatorNewerMerged.records['alpha'].updatedAtMs
          replayAckOk = [bool]$replayAck.ok
          replayTerminalState = [string]$replayFinal.records['alpha'].terminalState
          beforeAckOk = [bool]$beforeAck.ok
          beforeState = [string]$beforeMerged.records['alpha'].terminalState
          afterAckOk = [bool]$afterAck.ok
          afterState = [string]$afterFinal.records['alpha'].terminalState
        } | ConvertTo-Json -Compress
      `,
    ],
    cwd: repoRoot,
    inheritParentEnv: true,
  });

  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  matrix = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as WriterAuxMatrix;
}, 120_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('escalation-store operator ACK and replay writers', () => {
  it('preserves a same-millisecond operator ACK and bookkeeping', () => {
    expect(matrix).toMatchObject({
      operatorWriterTieOk: true,
      operatorWriterTieStatus: 'acked',
      operatorWriterTieAtMs: 1100,
      operatorWriterTieUpdatedAtMs: 1100,
      operatorWriterTieAttempts: 5,
      operatorWriterTieFirstAttemptAtMs: 901,
    });
  });
  it('preserves a strictly newer operator ACK', () => {
    expect(matrix).toMatchObject({
      operatorWriterNewerOk: true,
      operatorWriterNewerStatus: 'acked',
      operatorWriterNewerAtMs: 1101,
      operatorWriterNewerUpdatedAtMs: 1101,
    });
  });
  it('uses the same invariant after replay and final writeback', () => {
    expect(matrix).toMatchObject({ replayAckOk: true, replayTerminalState: 'acked' });
  });
  it('keeps ACKs written before snapshot and after writeback', () => {
    expect(matrix).toMatchObject({ beforeAckOk: true, beforeState: 'acked', afterAckOk: true, afterState: 'acked' });
  });
});
