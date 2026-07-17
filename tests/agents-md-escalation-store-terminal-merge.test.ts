import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcessSync } from '../scripts/kernel/subprocess.ts';

const repoRoot = join(import.meta.dirname, '..');

function ps(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function runPwsh(script: string) {
  return runProcessSync({
    command: 'pwsh',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    cwd: repoRoot,
    inheritParentEnv: true,
  });
}

function parseLastJson<T>(stdout: string): T {
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as T;
}

function expectPwshSuccess(result: ReturnType<typeof runPwsh>) {
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
}

describe('escalation-store terminal merge invariant', () => {
  let tempDir = '';

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('enforces terminal, release, deletion, LWW, and operator-ack conflicts', () => {
    const result = runPwsh(`
      . ./scripts/lib/Orchestrator-Escalation.ps1

      function New-TestRecord {
        param(
          [string]$TerminalState = 'open',
          [string]$Status = 'pending',
          [long]$UpdatedAtMs = 1000,
          [int]$Attempts = 1,
          [Nullable[long]]$ReleaseAtMs = $null,
          [string]$OperatorStatus = 'pending',
          [Nullable[long]]$OperatorAckedAtMs = $null
        )
        $record = @{
          schemaVersion = 2
          recordKey = 'alpha'
          escalationId = 'alpha'
          ackToken = 'token-alpha'
          route = 'llm-orchestrator'
          status = $Status
          terminalState = $TerminalState
          operatorStatus = $OperatorStatus
          attempts = $Attempts
          createdAtMs = 900
          updatedAtMs = $UpdatedAtMs
        }
        if ($null -ne $ReleaseAtMs) { $record.quarantineReleasedAtMs = [long]$ReleaseAtMs }
        if ($null -ne $OperatorAckedAtMs) { $record.operatorAckedAtMs = [long]$OperatorAckedAtMs }
        return $record
      }

      function Invoke-TestMerge {
        param(
          $MemoryRecord,
          $DiskRecord,
          [long]$SnapshotLoadedAtMs = 1000,
          [string[]]$DirtyRecordKeys = @('alpha')
        )
        $memoryState = @{ schemaVersion = 2; records = @{}; wakeWindows = @{}; audit = @{} }
        $diskState = @{ schemaVersion = 2; records = @{}; wakeWindows = @{}; audit = @{} }
        if ($null -ne $MemoryRecord) { $memoryState.records['alpha'] = $MemoryRecord }
        if ($null -ne $DiskRecord) { $diskState.records['alpha'] = $DiskRecord }
        $merged = Merge-OrchestratorEscalationRouterWritebackState -State $memoryState -DiskState $diskState \
          -DirtyRecordKeys $DirtyRecordKeys -SnapshotLoadedAtMs $SnapshotLoadedAtMs
        if (-not $merged.records.ContainsKey('alpha')) { return $null }
        return $merged.records['alpha']
      }

      $cases = @{}
      $cases.diskTerminalBeatsNewerOpen = Invoke-TestMerge \
        -MemoryRecord (New-TestRecord -UpdatedAtMs 1300 -Attempts 4) \
        -DiskRecord (New-TestRecord -TerminalState 'acked' -Status 'acked' -UpdatedAtMs 1100)
      $cases.diskTerminalWinsTie = Invoke-TestMerge \
        -MemoryRecord (New-TestRecord -TerminalState 'dead_lettered' -Status 'dead_lettered' -UpdatedAtMs 1100) \
        -DiskRecord (New-TestRecord -TerminalState 'acked' -Status 'acked' -UpdatedAtMs 1100)
      $cases.memoryTerminalWinsOnlyWhenStrictlyNewer = Invoke-TestMerge \
        -MemoryRecord (New-TestRecord -TerminalState 'dead_lettered' -Status 'dead_lettered' -UpdatedAtMs 1101) \
        -DiskRecord (New-TestRecord -TerminalState 'acked' -Status 'acked' -UpdatedAtMs 1100)
      $cases.freshReleaseWins = Invoke-TestMerge \
        -MemoryRecord (New-TestRecord -TerminalState 'quarantined' -Status 'quarantined' -UpdatedAtMs 1300) \
        -DiskRecord (New-TestRecord -UpdatedAtMs 1100 -ReleaseAtMs 1100) -SnapshotLoadedAtMs 1000
      $cases.sameMillisecondReleaseWins = Invoke-TestMerge \
        -MemoryRecord (New-TestRecord -TerminalState 'quarantined' -Status 'quarantined' -UpdatedAtMs 1300) \
        -DiskRecord (New-TestRecord -UpdatedAtMs 1000 -ReleaseAtMs 1000) -SnapshotLoadedAtMs 1000
      $cases.openWithoutReleaseMarkerLoses = Invoke-TestMerge \
        -MemoryRecord (New-TestRecord -TerminalState 'quarantined' -Status 'quarantined' -UpdatedAtMs 1000) \
        -DiskRecord (New-TestRecord -UpdatedAtMs 2000) -SnapshotLoadedAtMs 1000
      $cases.staleReleaseMarkerLoses = Invoke-TestMerge \
        -MemoryRecord (New-TestRecord -TerminalState 'quarantined' -Status 'quarantined' -UpdatedAtMs 1000) \
        -DiskRecord (New-TestRecord -UpdatedAtMs 2000 -ReleaseAtMs 999) -SnapshotLoadedAtMs 1000
      $cases.deleted = Invoke-TestMerge -MemoryRecord (New-TestRecord -UpdatedAtMs 1200) -DiskRecord $null
      $cases.nonterminalTieKeepsMemory = Invoke-TestMerge \
        -MemoryRecord (New-TestRecord -UpdatedAtMs 1100 -Attempts 4) \
        -DiskRecord (New-TestRecord -UpdatedAtMs 1100 -Attempts 2)
      $cases.newerDiskNonterminalWins = Invoke-TestMerge \
        -MemoryRecord (New-TestRecord -UpdatedAtMs 1100 -Attempts 4) \
        -DiskRecord (New-TestRecord -UpdatedAtMs 1101 -Attempts 2)
      $cases.tickDeadLetterPersists = Invoke-TestMerge \
        -MemoryRecord (New-TestRecord -TerminalState 'dead_lettered' -Status 'dead_lettered' -UpdatedAtMs 1100) \
        -DiskRecord (New-TestRecord -UpdatedAtMs 1000)
      $memoryAckTie = New-TestRecord -UpdatedAtMs 1200 -Attempts 5
      $memoryAckTie.firstAttemptAtMs = 901
      $cases.operatorAckTie = Invoke-TestMerge -MemoryRecord $memoryAckTie \
        -DiskRecord (New-TestRecord -UpdatedAtMs 1200 -Attempts 2 -OperatorStatus 'acked' -OperatorAckedAtMs 1200)
      $cases.nonDirtyMidTick = Invoke-TestMerge \
        -MemoryRecord (New-TestRecord -UpdatedAtMs 1300 -Attempts 9) \
        -DiskRecord (New-TestRecord -TerminalState 'acked' -Status 'acked' -UpdatedAtMs 1100) \
        -DirtyRecordKeys @()

      [pscustomobject]$cases | ConvertTo-Json -Depth 20 -Compress
    `);

    expectPwshSuccess(result);
    const cases = parseLastJson<Record<string, Record<string, unknown> | null>>(result.stdout);
    expect(cases.diskTerminalBeatsNewerOpen?.terminalState).toBe('acked');
    expect(cases.diskTerminalWinsTie?.terminalState).toBe('acked');
    expect(cases.memoryTerminalWinsOnlyWhenStrictlyNewer?.terminalState).toBe('dead_lettered');
    expect(cases.freshReleaseWins?.terminalState).toBe('open');
    expect(cases.sameMillisecondReleaseWins?.terminalState).toBe('open');
    expect(cases.openWithoutReleaseMarkerLoses?.terminalState).toBe('quarantined');
    expect(cases.staleReleaseMarkerLoses?.terminalState).toBe('quarantined');
    expect(cases.deleted).toBeNull();
    expect(cases.nonterminalTieKeepsMemory?.attempts).toBe(4);
    expect(cases.newerDiskNonterminalWins?.attempts).toBe(2);
    expect(cases.tickDeadLetterPersists?.terminalState).toBe('dead_lettered');
    expect(cases.operatorAckTie).toMatchObject({
      operatorStatus: 'acked',
      operatorAckedAtMs: 1200,
      attempts: 5,
      firstAttemptAtMs: 901,
    });
    expect(cases.nonDirtyMidTick?.terminalState).toBe('acked');
  });

  it('preserves real ACK writers before, during, and after a router tick', () => {
    tempDir = join(tmpdir(), `escalation-ack-mid-tick-${process.pid}-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const statePath = join(tempDir, 'escalation-state.json');

    const result = runPwsh(`
      . ./scripts/lib/Orchestrator-Escalation.ps1

      function New-StateRecord {
        param([string]$Key, [string]$Token, [long]$UpdatedAtMs)
        return @{
          schemaVersion = 2
          recordKey = $Key
          escalationId = $Key
          ackToken = $Token
          route = 'llm-orchestrator'
          status = 'pending'
          terminalState = 'open'
          operatorStatus = 'pending'
          attempts = 1
          createdAtMs = 900
          updatedAtMs = $UpdatedAtMs
        }
      }

      $seed = @{
        schemaVersion = 2
        records = @{ alpha = New-StateRecord -Key 'alpha' -Token 'token-alpha' -UpdatedAtMs 1000 }
        wakeWindows = @{}
        audit = @{}
      }
      Set-MechanicalJsonStateFile -Path ${ps(statePath)} -State $seed -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30

      # Snapshot is loaded, router dirties the record, then ACK writes out of band.
      $memory = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
      $memory.records['alpha'].status = 'backoff_waiting'
      $memory.records['alpha'].firstAttemptAtMs = 900
      $ackDuring = Write-OrchestratorEscalationAck -EscalationId 'alpha' -AckToken 'token-alpha' -StatePath ${ps(statePath)} -NowMs 1100
      $disk = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
      $merged = Merge-OrchestratorEscalationRouterWritebackState -State $memory -DiskState $disk \
        -DirtyRecordKeys @('alpha') -SnapshotLoadedAtMs 1000
      Set-MechanicalJsonStateFile -Path ${ps(statePath)} -State $merged -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
      $afterDuring = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState

      # ACK already present before the next snapshot remains terminal.
      $beforeSnapshot = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
      $beforeDisk = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
      $beforeMerged = Merge-OrchestratorEscalationRouterWritebackState -State $beforeSnapshot -DiskState $beforeDisk \
        -DirtyRecordKeys @('alpha') -SnapshotLoadedAtMs 1200

      # An ACK after a completed writeback remains on disk.
      $postState = @{
        schemaVersion = 2
        records = @{ gamma = New-StateRecord -Key 'gamma' -Token 'token-gamma' -UpdatedAtMs 1200 }
        wakeWindows = @{}
        audit = @{}
      }
      Set-MechanicalJsonStateFile -Path ${ps(statePath)} -State $postState -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
      $ackAfter = Write-OrchestratorEscalationAck -EscalationId 'gamma' -AckToken 'token-gamma' -StatePath ${ps(statePath)} -NowMs 1300
      $afterWriteback = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState

      # Operator ACK is an explicit writer and advances updatedAtMs.
      $operatorState = @{
        schemaVersion = 2
        records = @{ beta = New-StateRecord -Key 'beta' -Token 'token-beta' -UpdatedAtMs 1300 }
        wakeWindows = @{}
        audit = @{}
      }
      Set-MechanicalJsonStateFile -Path ${ps(statePath)} -State $operatorState -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
      $operatorAck = Write-OperatorEscalationAck -EscalationId 'beta' -AckToken 'token-beta' -StatePath ${ps(statePath)} -NowMs 1400
      $afterOperator = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState

      [pscustomobject]@{
        ackDuringOk = [bool]$ackDuring.ok
        duringTerminal = [string]$afterDuring.records['alpha'].terminalState
        beforeTerminal = [string]$beforeMerged.records['alpha'].terminalState
        ackAfterOk = [bool]$ackAfter.ok
        afterTerminal = [string]$afterWriteback.records['gamma'].terminalState
        operatorAckOk = [bool]$operatorAck.ok
        operatorStatus = [string]$afterOperator.records['beta'].operatorStatus
        operatorAckedAtMs = [long]$afterOperator.records['beta'].operatorAckedAtMs
        operatorUpdatedAtMs = [long]$afterOperator.records['beta'].updatedAtMs
      } | ConvertTo-Json -Compress
    `);

    expectPwshSuccess(result);
    expect(parseLastJson(result.stdout)).toEqual({
      ackDuringOk: true,
      duringTerminal: 'acked',
      beforeTerminal: 'acked',
      ackAfterOk: true,
      afterTerminal: 'acked',
      operatorAckOk: true,
      operatorStatus: 'acked',
      operatorAckedAtMs: 1400,
      operatorUpdatedAtMs: 1400,
    });
  });

  it('uses the same invariant for replay rereads and final dirty writeback', () => {
    tempDir = join(tmpdir(), `escalation-replay-merge-${process.pid}-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const statePath = join(tempDir, 'escalation-state.json');

    const result = runPwsh(`
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $tokens = $null
      $errors = $null
      $routerAst = [System.Management.Automation.Language.Parser]::ParseFile(
        (Resolve-Path './scripts/orchestrator-escalation-router.ps1'),
        [ref]$tokens,
        [ref]$errors
      )
      if ($errors.Count -gt 0) { throw ($errors | Out-String) }
      $mergeAst = $routerAst.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and \
          $node.Name -eq 'Merge-EscalationRouterReplayState'
      }, $true)
      if ($null -eq $mergeAst) { throw 'replay merge function not found' }
      Invoke-Expression $mergeAst.Extent.Text

      function New-ReplayRecord {
        param([string]$TerminalState = 'open', [string]$Status = 'pending', [long]$UpdatedAtMs = 1000)
        return @{
          schemaVersion = 2
          recordKey = 'alpha'
          escalationId = 'alpha'
          ackToken = 'token-alpha'
          route = 'llm-orchestrator'
          status = $Status
          terminalState = $TerminalState
          operatorStatus = 'pending'
          attempts = 1
          createdAtMs = 900
          updatedAtMs = $UpdatedAtMs
        }
      }

      # Replay reread sees a terminal disk transition.
      $replayMemory = @{ schemaVersion = 2; records = @{ alpha = New-ReplayRecord -UpdatedAtMs 1050 }; wakeWindows = @{}; audit = @{} }
      $replayDisk = @{ schemaVersion = 2; records = @{ alpha = New-ReplayRecord -TerminalState 'acked' -Status 'acked' -UpdatedAtMs 1060 }; wakeWindows = @{}; audit = @{} }
      Merge-EscalationRouterReplayState -State $replayMemory -DiskState $replayDisk -RecordKey 'alpha' -SnapshotLoadedAtMs 1000
      $replayTerminal = [string]$replayMemory.records['alpha'].terminalState

      # Replay reread also honors an operator delete.
      $deleteMemory = @{ schemaVersion = 2; records = @{ alpha = New-ReplayRecord -UpdatedAtMs 1050 }; wakeWindows = @{}; audit = @{} }
      $deleteDisk = @{ schemaVersion = 2; records = @{}; wakeWindows = @{}; audit = @{} }
      Merge-EscalationRouterReplayState -State $deleteMemory -DiskState $deleteDisk -RecordKey 'alpha' -SnapshotLoadedAtMs 1000
      $replayDeleted = -not $deleteMemory.records.ContainsKey('alpha')

      # The record was dirtied by firstAttempt backfill. ACK lands after replay
      # reread but before the final reread/writeback and must survive.
      $seed = @{ schemaVersion = 2; records = @{ alpha = New-ReplayRecord -UpdatedAtMs 1000 }; wakeWindows = @{}; audit = @{} }
      Set-MechanicalJsonStateFile -Path ${ps(statePath)} -State $seed -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
      $tickMemory = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
      $tickMemory.records['alpha'].firstAttemptAtMs = 900
      $tickMemory.records['alpha'].status = 'backoff_waiting'
      $replayReread = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
      Merge-EscalationRouterReplayState -State $tickMemory -DiskState $replayReread -RecordKey 'alpha' -SnapshotLoadedAtMs 1000
      $ack = Write-OrchestratorEscalationAck -EscalationId 'alpha' -AckToken 'token-alpha' -StatePath ${ps(statePath)} -NowMs 1100
      $finalDisk = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
      $final = Merge-OrchestratorEscalationRouterWritebackState -State $tickMemory -DiskState $finalDisk \
        -DirtyRecordKeys @('alpha') -SnapshotLoadedAtMs 1000

      [pscustomobject]@{
        replayTerminal = $replayTerminal
        replayDeleted = $replayDeleted
        ackOk = [bool]$ack.ok
        finalTerminal = [string]$final.records['alpha'].terminalState
      } | ConvertTo-Json -Compress
    `);

    expectPwshSuccess(result);
    expect(parseLastJson(result.stdout)).toEqual({
      replayTerminal: 'acked',
      replayDeleted: true,
      ackOk: true,
      finalTerminal: 'acked',
    });
  });
});
