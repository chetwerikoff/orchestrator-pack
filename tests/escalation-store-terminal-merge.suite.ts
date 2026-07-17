import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProcessSync } from '../scripts/kernel/subprocess.ts';

const repoRoot = join(import.meta.dirname, '..');

function ps(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

describe('escalation-store conflict-aware writeback (#889)', () => {
  it('preserves terminal writers, explicit releases, deletions, ACK markers, and deterministic non-terminal precedence', () => {
    const root = mkdtempSync(join(tmpdir(), 'escalation-terminal-merge-'));
    const ackPath = join(root, 'ack.json');
    const releasePath = join(root, 'release.json');
    const deletePath = join(root, 'delete.json');
    const operatorTiePath = join(root, 'operator-tie.json');
    const operatorNewerPath = join(root, 'operator-newer.json');
    const replayPath = join(root, 'replay.json');
    const safePath = join(root, 'safe.json');

    try {
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

            function Merge-FixtureRecord {
              param(
                [Parameter(Mandatory = $true)][hashtable]$Memory,
                $Disk = $null,
                [long]$SnapshotLoadedAtMs = 1000,
                [bool]$Dirty = $true
              )
              $state = @{ schemaVersion = 2; records = @{ alpha = $Memory }; wakeWindows = @{}; audit = @{} }
              $diskState = @{ schemaVersion = 2; records = @{}; wakeWindows = @{}; audit = @{} }
              if ($null -ne $Disk) { $diskState.records['alpha'] = $Disk }
              $dirtyKeys = if ($Dirty) { @('alpha') } else { @() }
              $merged = Merge-OrchestratorEscalationRouterWritebackState -State $state -DiskState $diskState -DirtyRecordKeys $dirtyKeys -SnapshotLoadedAtMs $SnapshotLoadedAtMs
              if ($merged.records.ContainsKey('alpha')) { return $merged.records['alpha'] }
              return $null
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

            $terminalDisk = Merge-FixtureRecord `
              -Memory (New-FixtureRecord @{ updatedAtMs = 1300; attempts = 4 }) `
              -Disk (New-FixtureRecord @{ terminalState = 'acked'; status = 'acked'; updatedAtMs = 1100 })
            $terminalTie = Merge-FixtureRecord `
              -Memory (New-FixtureRecord @{ terminalState = 'dead_lettered'; status = 'dead_lettered'; updatedAtMs = 1100 }) `
              -Disk (New-FixtureRecord @{ terminalState = 'acked'; status = 'acked'; updatedAtMs = 1100 })
            $diskTerminalNewer = Merge-FixtureRecord `
              -Memory (New-FixtureRecord @{ terminalState = 'dead_lettered'; status = 'dead_lettered'; updatedAtMs = 1100 }) `
              -Disk (New-FixtureRecord @{ terminalState = 'acked'; status = 'acked'; updatedAtMs = 1101 })
            $memoryTerminalNewer = Merge-FixtureRecord `
              -Memory (New-FixtureRecord @{ terminalState = 'dead_lettered'; status = 'dead_lettered'; updatedAtMs = 1101 }) `
              -Disk (New-FixtureRecord @{ terminalState = 'acked'; status = 'acked'; updatedAtMs = 1100 })
            $releaseNewer = Merge-FixtureRecord `
              -Memory (New-FixtureRecord @{ terminalState = 'quarantined'; status = 'quarantined'; updatedAtMs = 1300 }) `
              -Disk (New-FixtureRecord @{ terminalState = 'open'; status = 'pending'; updatedAtMs = 1100; quarantineReleasedAtMs = 1100 })
            $releaseTie = Merge-FixtureRecord `
              -Memory (New-FixtureRecord @{ terminalState = 'quarantined'; status = 'quarantined'; updatedAtMs = 1300 }) `
              -Disk (New-FixtureRecord @{ terminalState = 'open'; status = 'pending'; updatedAtMs = 1000; quarantineReleasedAtMs = 1000 })
            $genericOpen = Merge-FixtureRecord `
              -Memory (New-FixtureRecord @{ terminalState = 'quarantined'; status = 'quarantined'; updatedAtMs = 1000 }) `
              -Disk (New-FixtureRecord @{ terminalState = 'open'; status = 'pending'; updatedAtMs = 2000 })
            $staleRelease = Merge-FixtureRecord `
              -Memory (New-FixtureRecord @{ terminalState = 'quarantined'; status = 'quarantined'; updatedAtMs = 1000 }) `
              -Disk (New-FixtureRecord @{ terminalState = 'open'; status = 'pending'; updatedAtMs = 2000; quarantineReleasedAtMs = 999 })
            $deleted = Merge-FixtureRecord -Memory (New-FixtureRecord @{ updatedAtMs = 1200 })
            $nonTerminalTie = Merge-FixtureRecord `
              -Memory (New-FixtureRecord @{ updatedAtMs = 1100; attempts = 4; firstAttemptAtMs = 901 }) `
              -Disk (New-FixtureRecord @{ updatedAtMs = 1100; attempts = 2 })
            $nonTerminalDiskNewer = Merge-FixtureRecord `
              -Memory (New-FixtureRecord @{ updatedAtMs = 1100; attempts = 4 }) `
              -Disk (New-FixtureRecord @{ updatedAtMs = 1101; attempts = 2 })
            $operatorTie = Merge-FixtureRecord `
              -Memory (New-FixtureRecord @{ updatedAtMs = 1200; attempts = 5; firstAttemptAtMs = 901 }) `
              -Disk (New-FixtureRecord @{ updatedAtMs = 1200; attempts = 2; operatorStatus = 'acked'; operatorAckedAtMs = 1200 })
            $tickTerminal = Merge-FixtureRecord `
              -Memory (New-FixtureRecord @{ terminalState = 'dead_lettered'; status = 'dead_lettered'; updatedAtMs = 1100 }) `
              -Disk (New-FixtureRecord @{ updatedAtMs = 1000 })
            $nonDirtyTerminal = Merge-FixtureRecord `
              -Memory (New-FixtureRecord @{ updatedAtMs = 1300; attempts = 9 }) `
              -Disk (New-FixtureRecord @{ terminalState = 'acked'; status = 'acked'; updatedAtMs = 1100 }) `
              -Dirty $false

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
              terminalDisk = [string]$terminalDisk.terminalState
              terminalTie = [string]$terminalTie.terminalState
              diskTerminalNewer = [string]$diskTerminalNewer.terminalState
              memoryTerminalNewer = [string]$memoryTerminalNewer.terminalState
              releaseNewer = [string]$releaseNewer.terminalState
              releaseTie = [string]$releaseTie.terminalState
              genericOpen = [string]$genericOpen.terminalState
              staleRelease = [string]$staleRelease.terminalState
              deleted = ($null -eq $deleted)
              nonTerminalTieAttempts = [int]$nonTerminalTie.attempts
              nonTerminalTieFirstAttemptAtMs = [long]$nonTerminalTie.firstAttemptAtMs
              nonTerminalDiskNewerAttempts = [int]$nonTerminalDiskNewer.attempts
              operatorTieStatus = [string]$operatorTie.operatorStatus
              operatorTieAtMs = [long]$operatorTie.operatorAckedAtMs
              operatorTieAttempts = [int]$operatorTie.attempts
              operatorTieFirstAttemptAtMs = [long]$operatorTie.firstAttemptAtMs
              tickTerminal = [string]$tickTerminal.terminalState
              nonDirtyTerminal = [string]$nonDirtyTerminal.terminalState
              ackMidTickOk = [bool]$ackMidTick.ok
              ackMidTickState = [string]$ackMerged.records['alpha'].terminalState
              releaseWriterState = [string]$releaseMerged.records['alpha'].terminalState
              deleteWriterMissing = -not $deleteMerged.records.ContainsKey('alpha')
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
      const parsed = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}');
      expect(parsed).toEqual({
        terminalDisk: 'acked',
        terminalTie: 'acked',
        diskTerminalNewer: 'acked',
        memoryTerminalNewer: 'dead_lettered',
        releaseNewer: 'open',
        releaseTie: 'open',
        genericOpen: 'quarantined',
        staleRelease: 'quarantined',
        deleted: true,
        nonTerminalTieAttempts: 4,
        nonTerminalTieFirstAttemptAtMs: 901,
        nonTerminalDiskNewerAttempts: 2,
        operatorTieStatus: 'acked',
        operatorTieAtMs: 1200,
        operatorTieAttempts: 5,
        operatorTieFirstAttemptAtMs: 901,
        tickTerminal: 'dead_lettered',
        nonDirtyTerminal: 'acked',
        ackMidTickOk: true,
        ackMidTickState: 'acked',
        releaseWriterState: 'open',
        deleteWriterMissing: true,
        operatorWriterTieOk: true,
        operatorWriterTieStatus: 'acked',
        operatorWriterTieAtMs: 1100,
        operatorWriterTieUpdatedAtMs: 1100,
        operatorWriterTieAttempts: 5,
        operatorWriterTieFirstAttemptAtMs: 901,
        operatorWriterNewerOk: true,
        operatorWriterNewerStatus: 'acked',
        operatorWriterNewerAtMs: 1101,
        operatorWriterNewerUpdatedAtMs: 1101,
        replayAckOk: true,
        replayTerminalState: 'acked',
        beforeAckOk: true,
        beforeState: 'acked',
        afterAckOk: true,
        afterState: 'acked',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
