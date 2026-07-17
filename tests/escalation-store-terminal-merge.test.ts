import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

function expectPwshSuccess(result: ReturnType<typeof runPwsh>) {
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
}

function parseLastJson<T>(stdout: string): T {
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as T;
}

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

type WriterMatrix = {
  ackMidTickOk: boolean;
  ackMidTickState: string;
  releaseState: string;
  deleted: boolean;
  operatorTieOk: boolean;
  operatorTieStatus: string;
  operatorTieAtMs: number;
  operatorTieUpdatedAtMs: number;
  operatorTieAttempts: number;
  operatorTieFirstAttemptAtMs: number;
  operatorNewerOk: boolean;
  operatorNewerStatus: string;
  operatorNewerAtMs: number;
  operatorNewerUpdatedAtMs: number;
  replayAckOk: boolean;
  replayTerminalState: string;
  beforeAckOk: boolean;
  beforeState: string;
  afterAckOk: boolean;
  afterState: string;
};

function runPureMatrix(): PureMatrix {
  const result = runPwsh(`
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
  `);
  expectPwshSuccess(result);
  return parseLastJson<PureMatrix>(result.stdout);
}

function runWriterMatrix(root: string): WriterMatrix {
  const ackPath = join(root, 'ack.json');
  const releasePath = join(root, 'release.json');
  const deletePath = join(root, 'delete.json');
  const operatorTiePath = join(root, 'operator-tie.json');
  const operatorNewerPath = join(root, 'operator-newer.json');
  const replayPath = join(root, 'replay.json');
  const safePath = join(root, 'safe.json');

  const result = runPwsh(`
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

    $quarantined = New-FixtureRecord @{ terminalState = 'quarantined'; status = 'quarantined'; updatedAtMs = 1000 }
    Set-FixtureState -Path ${ps(releasePath)} -Record $quarantined
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

    $tokens = $null
    $errors = $null
    $routerAst = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path './scripts/orchestrator-escalation-router.ps1'), [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) { throw ($errors | Out-String) }
    $mergeAst = $routerAst.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Merge-EscalationRouterReplayState' }, $true)
    if ($null -eq $mergeAst) { throw 'replay merge function not found' }
    Invoke-Expression $mergeAst.Extent.Text

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
      ackMidTickOk = [bool]$ackMidTick.ok
      ackMidTickState = [string]$ackMerged.records['alpha'].terminalState
      releaseState = [string]$releaseMerged.records['alpha'].terminalState
      deleted = -not $deleteMerged.records.ContainsKey('alpha')
      operatorTieOk = [bool]$operatorTieAck.ok
      operatorTieStatus = [string]$operatorTieMerged.records['alpha'].operatorStatus
      operatorTieAtMs = [long]$operatorTieMerged.records['alpha'].operatorAckedAtMs
      operatorTieUpdatedAtMs = [long]$operatorTieDisk.records['alpha'].updatedAtMs
      operatorTieAttempts = [int]$operatorTieMerged.records['alpha'].attempts
      operatorTieFirstAttemptAtMs = [long]$operatorTieMerged.records['alpha'].firstAttemptAtMs
      operatorNewerOk = [bool]$operatorNewerAck.ok
      operatorNewerStatus = [string]$operatorNewerMerged.records['alpha'].operatorStatus
      operatorNewerAtMs = [long]$operatorNewerMerged.records['alpha'].operatorAckedAtMs
      operatorNewerUpdatedAtMs = [long]$operatorNewerMerged.records['alpha'].updatedAtMs
      replayAckOk = [bool]$replayAck.ok
      replayTerminalState = [string]$replayFinal.records['alpha'].terminalState
      beforeAckOk = [bool]$beforeAck.ok
      beforeState = [string]$beforeMerged.records['alpha'].terminalState
      afterAckOk = [bool]$afterAck.ok
      afterState = [string]$afterFinal.records['alpha'].terminalState
    } | ConvertTo-Json -Compress
  `);
  expectPwshSuccess(result);
  return parseLastJson<WriterMatrix>(result.stdout);
}

let pure: PureMatrix;
let writers: WriterMatrix;
let tempRoot = '';

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'escalation-terminal-merge-'));
  pure = runPureMatrix();
  writers = runWriterMatrix(tempRoot);
}, 120_000);

afterAll(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

describe('escalation-store conflict-aware writeback', () => {
  it('keeps a terminal disk record over a newer non-terminal memory copy', () => {
    expect(pure.terminalDisk).toBe('acked');
  });

  it('keeps disk on a different-terminal timestamp tie', () => {
    expect(pure.terminalTie).toBe('acked');
  });

  it('keeps a strictly newer disk ACK over a stale terminal tick decision', () => {
    expect(pure.diskTerminalNewer).toBe('acked');
  });

  it('lets a different memory terminal state win only when strictly newer', () => {
    expect(pure.memoryTerminalNewer).toBe('dead_lettered');
  });

  it('honors a quarantine release newer than the snapshot', () => {
    expect(pure.releaseNewer).toBe('open');
  });

  it('honors a quarantine release in the same millisecond as snapshot load', () => {
    expect(pure.releaseTie).toBe('open');
  });

  it('does not mistake a generic newer open write for quarantine release', () => {
    expect(pure.genericOpen).toBe('quarantined');
  });

  it('does not honor a release marker older than snapshot load', () => {
    expect(pure.staleRelease).toBe('quarantined');
  });

  it('does not resurrect a record deleted from disk', () => {
    expect(pure.deleted).toBe(true);
  });

  it('keeps uncontested memory bookkeeping on a non-terminal tie', () => {
    expect(pure).toMatchObject({ nonTerminalTieAttempts: 4, nonTerminalTieFirstAttemptAtMs: 901 });
  });

  it('lets a strictly newer non-terminal disk record win', () => {
    expect(pure.nonTerminalDiskNewerAttempts).toBe(2);
  });

  it('overlays a same-millisecond operator ACK marker without losing memory bookkeeping', () => {
    expect(pure).toMatchObject({
      operatorTieStatus: 'acked',
      operatorTieAtMs: 1200,
      operatorTieAttempts: 5,
      operatorTieFirstAttemptAtMs: 901,
    });
  });

  it('preserves a terminal record written by the tick itself', () => {
    expect(pure.tickTerminal).toBe('dead_lettered');
  });

  it('preserves a non-dirty out-of-band terminal write', () => {
    expect(pure.nonDirtyTerminal).toBe('acked');
  });

  it('preserves an actual ACK written between snapshot load and dirty writeback', () => {
    expect(writers).toMatchObject({ ackMidTickOk: true, ackMidTickState: 'acked' });
  });

  it('preserves actual quarantine release and delete writers mid-tick', () => {
    expect(writers).toMatchObject({ releaseState: 'open', deleted: true });
  });

  it('preserves an actual same-millisecond operator ACK and advances updatedAtMs', () => {
    expect(writers).toMatchObject({
      operatorTieOk: true,
      operatorTieStatus: 'acked',
      operatorTieAtMs: 1100,
      operatorTieUpdatedAtMs: 1100,
      operatorTieAttempts: 5,
      operatorTieFirstAttemptAtMs: 901,
    });
  });

  it('preserves a strictly newer operator ACK and its updatedAtMs bump', () => {
    expect(writers).toMatchObject({
      operatorNewerOk: true,
      operatorNewerStatus: 'acked',
      operatorNewerAtMs: 1101,
      operatorNewerUpdatedAtMs: 1101,
    });
  });

  it('uses the same invariant after replay reread and at final writeback', () => {
    expect(writers).toMatchObject({ replayAckOk: true, replayTerminalState: 'acked' });
  });

  it('keeps ACKs written before snapshot load and after writeback', () => {
    expect(writers).toMatchObject({
      beforeAckOk: true,
      beforeState: 'acked',
      afterAckOk: true,
      afterState: 'acked',
    });
  });
});
