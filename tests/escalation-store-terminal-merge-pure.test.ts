import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runProcessSync } from '../scripts/kernel/subprocess.ts';

const repoRoot = join(import.meta.dirname, '..');

type PureMatrix = {
  terminalDisk: string;
  terminalTie: string;
  diskTerminalNewer: string;
  memoryTerminalNewer: string;
  releaseNewer: string;
  releaseTie: string;
  genericOpen: string;
  staleRelease: string;
  deleted: boolean;
  nonTerminalTieAttempts: number;
  nonTerminalTieFirstAttemptAtMs: number;
  nonTerminalDiskNewerAttempts: number;
  operatorTieStatus: string;
  operatorTieAtMs: number;
  operatorTieAttempts: number;
  operatorTieFirstAttemptAtMs: number;
  tickTerminal: string;
  nonDirtyTerminal: string;
};

let matrix!: PureMatrix;

beforeAll(() => {
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

        $terminalDisk = Merge-FixtureRecord -Memory (New-FixtureRecord @{ updatedAtMs = 1300; attempts = 4 }) -Disk (New-FixtureRecord @{ terminalState = 'acked'; status = 'acked'; updatedAtMs = 1100 })
        $terminalTie = Merge-FixtureRecord -Memory (New-FixtureRecord @{ terminalState = 'dead_lettered'; status = 'dead_lettered'; updatedAtMs = 1100 }) -Disk (New-FixtureRecord @{ terminalState = 'acked'; status = 'acked'; updatedAtMs = 1100 })
        $diskTerminalNewer = Merge-FixtureRecord -Memory (New-FixtureRecord @{ terminalState = 'dead_lettered'; status = 'dead_lettered'; updatedAtMs = 1100 }) -Disk (New-FixtureRecord @{ terminalState = 'acked'; status = 'acked'; updatedAtMs = 1101 })
        $memoryTerminalNewer = Merge-FixtureRecord -Memory (New-FixtureRecord @{ terminalState = 'dead_lettered'; status = 'dead_lettered'; updatedAtMs = 1101 }) -Disk (New-FixtureRecord @{ terminalState = 'acked'; status = 'acked'; updatedAtMs = 1100 })
        $releaseNewer = Merge-FixtureRecord -Memory (New-FixtureRecord @{ terminalState = 'quarantined'; status = 'quarantined'; updatedAtMs = 1300 }) -Disk (New-FixtureRecord @{ terminalState = 'open'; status = 'pending'; updatedAtMs = 1100; quarantineReleasedAtMs = 1100 })
        $releaseTie = Merge-FixtureRecord -Memory (New-FixtureRecord @{ terminalState = 'quarantined'; status = 'quarantined'; updatedAtMs = 1300 }) -Disk (New-FixtureRecord @{ terminalState = 'open'; status = 'pending'; updatedAtMs = 1000; quarantineReleasedAtMs = 1000 })
        $genericOpen = Merge-FixtureRecord -Memory (New-FixtureRecord @{ terminalState = 'quarantined'; status = 'quarantined'; updatedAtMs = 1000 }) -Disk (New-FixtureRecord @{ terminalState = 'open'; status = 'pending'; updatedAtMs = 2000 })
        $staleRelease = Merge-FixtureRecord -Memory (New-FixtureRecord @{ terminalState = 'quarantined'; status = 'quarantined'; updatedAtMs = 1000 }) -Disk (New-FixtureRecord @{ terminalState = 'open'; status = 'pending'; updatedAtMs = 2000; quarantineReleasedAtMs = 999 })
        $deleted = Merge-FixtureRecord -Memory (New-FixtureRecord @{ updatedAtMs = 1200 })
        $nonTerminalTie = Merge-FixtureRecord -Memory (New-FixtureRecord @{ updatedAtMs = 1100; attempts = 4; firstAttemptAtMs = 901 }) -Disk (New-FixtureRecord @{ updatedAtMs = 1100; attempts = 2 })
        $nonTerminalDiskNewer = Merge-FixtureRecord -Memory (New-FixtureRecord @{ updatedAtMs = 1100; attempts = 4 }) -Disk (New-FixtureRecord @{ updatedAtMs = 1101; attempts = 2 })
        $operatorTie = Merge-FixtureRecord -Memory (New-FixtureRecord @{ updatedAtMs = 1200; attempts = 5; firstAttemptAtMs = 901 }) -Disk (New-FixtureRecord @{ updatedAtMs = 1200; attempts = 2; operatorStatus = 'acked'; operatorAckedAtMs = 1200 })
        $tickTerminal = Merge-FixtureRecord -Memory (New-FixtureRecord @{ terminalState = 'dead_lettered'; status = 'dead_lettered'; updatedAtMs = 1100 }) -Disk (New-FixtureRecord @{ updatedAtMs = 1000 })
        $nonDirtyTerminal = Merge-FixtureRecord -Memory (New-FixtureRecord @{ updatedAtMs = 1300; attempts = 9 }) -Disk (New-FixtureRecord @{ terminalState = 'acked'; status = 'acked'; updatedAtMs = 1100 }) -Dirty $false

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
        } | ConvertTo-Json -Compress
      `,
    ],
    cwd: repoRoot,
    inheritParentEnv: true,
  });

  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  matrix = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as PureMatrix;
}, 120_000);

describe('escalation-store pure merge precedence', () => {
  it('keeps terminal disk over non-terminal memory', () => expect(matrix.terminalDisk).toBe('acked'));
  it('keeps disk on different-terminal ties', () => expect(matrix.terminalTie).toBe('acked'));
  it('keeps a strictly newer disk terminal state', () => expect(matrix.diskTerminalNewer).toBe('acked'));
  it('allows a strictly newer memory terminal state', () => expect(matrix.memoryTerminalNewer).toBe('dead_lettered'));
  it('honors a fresh quarantine release', () => expect(matrix.releaseNewer).toBe('open'));
  it('honors a same-millisecond quarantine release', () => expect(matrix.releaseTie).toBe('open'));
  it('does not mistake a generic open write for release', () => expect(matrix.genericOpen).toBe('quarantined'));
  it('does not honor a stale release marker', () => expect(matrix.staleRelease).toBe('quarantined'));
  it('does not resurrect a deleted record', () => expect(matrix.deleted).toBe(true));
  it('keeps memory bookkeeping on a non-terminal tie', () => expect(matrix).toMatchObject({ nonTerminalTieAttempts: 4, nonTerminalTieFirstAttemptAtMs: 901 }));
  it('keeps a strictly newer non-terminal disk record', () => expect(matrix.nonTerminalDiskNewerAttempts).toBe(2));
  it('overlays an operator ACK marker on a tie', () => expect(matrix).toMatchObject({ operatorTieStatus: 'acked', operatorTieAtMs: 1200, operatorTieAttempts: 5, operatorTieFirstAttemptAtMs: 901 }));
  it('preserves a tick-owned terminal state', () => expect(matrix.tickTerminal).toBe('dead_lettered'));
  it('preserves a non-dirty terminal disk record', () => expect(matrix.nonDirtyTerminal).toBe('acked'));
});
