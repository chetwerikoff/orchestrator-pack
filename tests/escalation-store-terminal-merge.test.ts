import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcessSync } from '../scripts/kernel/subprocess.ts';

const repoRoot = join(import.meta.dirname, '..');
const tempDirs: string[] = [];

type EscalationRecord = Record<string, unknown>;

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

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function record(overrides: EscalationRecord = {}): EscalationRecord {
  return {
    schemaVersion: 2,
    recordKey: 'alpha',
    escalationId: 'alpha',
    ackToken: 'token-alpha',
    route: 'llm-orchestrator',
    status: 'pending',
    terminalState: 'open',
    operatorStatus: 'pending',
    attempts: 1,
    createdAtMs: 900,
    updatedAtMs: 1000,
    ...overrides,
  };
}

function mergeRecord(
  memory: EscalationRecord,
  disk: EscalationRecord | null,
  options: { snapshotLoadedAtMs?: number; dirty?: boolean } = {},
): EscalationRecord | null {
  const snapshotLoadedAtMs = options.snapshotLoadedAtMs ?? 1000;
  const dirty = options.dirty ?? true;
  const diskSetup = disk
    ? `$disk.records['alpha'] = Decode-Record '${encode(disk)}'`
    : '';
  const dirtyKeys = dirty ? "@('alpha')" : '@()';
  const result = runPwsh(`
    . ./scripts/lib/Orchestrator-Escalation.ps1
    function Decode-Record([string]$Value) {
      $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
      return $json | ConvertFrom-Json -AsHashtable
    }
    $memory = @{ schemaVersion = 2; records = @{}; wakeWindows = @{}; audit = @{} }
    $disk = @{ schemaVersion = 2; records = @{}; wakeWindows = @{}; audit = @{} }
    $memory.records['alpha'] = Decode-Record '${encode(memory)}'
    ${diskSetup}
    $merged = Merge-OrchestratorEscalationRouterWritebackState -State $memory -DiskState $disk -DirtyRecordKeys ${dirtyKeys} -SnapshotLoadedAtMs ${snapshotLoadedAtMs}
    if ($merged.records.ContainsKey('alpha')) {
      $merged.records['alpha'] | ConvertTo-Json -Depth 20 -Compress
    }
    else {
      'null'
    }
  `);
  expectPwshSuccess(result);
  return parseLastJson<EscalationRecord | null>(result.stdout);
}

function newStatePath(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `${label}-`));
  tempDirs.push(dir);
  return join(dir, 'escalation-state.json');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('escalation-store conflict-aware writeback', () => {
  it('keeps a terminal disk record over a newer non-terminal memory copy', () => {
    const merged = mergeRecord(
      record({ updatedAtMs: 1300, attempts: 4 }),
      record({ terminalState: 'acked', status: 'acked', updatedAtMs: 1100 }),
    );
    expect(merged?.terminalState).toBe('acked');
  });

  it('keeps disk on a different-terminal timestamp tie', () => {
    const merged = mergeRecord(
      record({ terminalState: 'dead_lettered', status: 'dead_lettered', updatedAtMs: 1100 }),
      record({ terminalState: 'acked', status: 'acked', updatedAtMs: 1100 }),
    );
    expect(merged?.terminalState).toBe('acked');
  });

  it('lets a different memory terminal state win only when strictly newer', () => {
    const merged = mergeRecord(
      record({ terminalState: 'dead_lettered', status: 'dead_lettered', updatedAtMs: 1101 }),
      record({ terminalState: 'acked', status: 'acked', updatedAtMs: 1100 }),
    );
    expect(merged?.terminalState).toBe('dead_lettered');
  });

  it('honors a quarantine release newer than the snapshot', () => {
    const merged = mergeRecord(
      record({ terminalState: 'quarantined', status: 'quarantined', updatedAtMs: 1300 }),
      record({ terminalState: 'open', status: 'pending', updatedAtMs: 1100, quarantineReleasedAtMs: 1100 }),
    );
    expect(merged?.terminalState).toBe('open');
  });

  it('honors a quarantine release in the same millisecond as snapshot load', () => {
    const merged = mergeRecord(
      record({ terminalState: 'quarantined', status: 'quarantined', updatedAtMs: 1300 }),
      record({ terminalState: 'open', status: 'pending', updatedAtMs: 1000, quarantineReleasedAtMs: 1000 }),
    );
    expect(merged?.terminalState).toBe('open');
  });

  it('does not mistake a generic newer open write for quarantine release', () => {
    const merged = mergeRecord(
      record({ terminalState: 'quarantined', status: 'quarantined', updatedAtMs: 1000 }),
      record({ terminalState: 'open', status: 'pending', updatedAtMs: 2000 }),
    );
    expect(merged?.terminalState).toBe('quarantined');
  });

  it('does not honor a release marker older than snapshot load', () => {
    const merged = mergeRecord(
      record({ terminalState: 'quarantined', status: 'quarantined', updatedAtMs: 1000 }),
      record({ terminalState: 'open', status: 'pending', updatedAtMs: 2000, quarantineReleasedAtMs: 999 }),
    );
    expect(merged?.terminalState).toBe('quarantined');
  });

  it('does not resurrect a record deleted from disk', () => {
    expect(mergeRecord(record({ updatedAtMs: 1200 }), null)).toBeNull();
  });

  it('keeps uncontested memory bookkeeping on a non-terminal tie', () => {
    const merged = mergeRecord(
      record({ updatedAtMs: 1100, attempts: 4, firstAttemptAtMs: 901 }),
      record({ updatedAtMs: 1100, attempts: 2 }),
    );
    expect(merged).toMatchObject({ attempts: 4, firstAttemptAtMs: 901 });
  });

  it('lets a strictly newer non-terminal disk record win', () => {
    const merged = mergeRecord(
      record({ updatedAtMs: 1100, attempts: 4 }),
      record({ updatedAtMs: 1101, attempts: 2 }),
    );
    expect(merged?.attempts).toBe(2);
  });

  it('overlays a same-millisecond operator ACK marker without losing memory bookkeeping', () => {
    const merged = mergeRecord(
      record({ updatedAtMs: 1200, attempts: 5, firstAttemptAtMs: 901 }),
      record({ updatedAtMs: 1200, attempts: 2, operatorStatus: 'acked', operatorAckedAtMs: 1200 }),
    );
    expect(merged).toMatchObject({
      operatorStatus: 'acked',
      operatorAckedAtMs: 1200,
      attempts: 5,
      firstAttemptAtMs: 901,
    });
  });

  it('preserves a terminal record written by the tick itself', () => {
    const merged = mergeRecord(
      record({ terminalState: 'dead_lettered', status: 'dead_lettered', updatedAtMs: 1100 }),
      record({ updatedAtMs: 1000 }),
    );
    expect(merged?.terminalState).toBe('dead_lettered');
  });

  it('preserves a non-dirty out-of-band terminal write', () => {
    const merged = mergeRecord(
      record({ updatedAtMs: 1300, attempts: 9 }),
      record({ terminalState: 'acked', status: 'acked', updatedAtMs: 1100 }),
      { dirty: false },
    );
    expect(merged?.terminalState).toBe('acked');
  });

  it('preserves an actual ACK written between snapshot load and dirty writeback', () => {
    const statePath = newStatePath('escalation-ack-mid-tick');
    const result = runPwsh(`
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $seed = @{ schemaVersion = 2; records = @{ alpha = (${ps(JSON.stringify(record()))} | ConvertFrom-Json -AsHashtable) }; wakeWindows = @{}; audit = @{} }
      Set-MechanicalJsonStateFile -Path ${ps(statePath)} -State $seed -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
      $memory = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
      $memory.records['alpha'].status = 'backoff_waiting'
      $memory.records['alpha'].firstAttemptAtMs = 900
      $ack = Write-OrchestratorEscalationAck -EscalationId 'alpha' -AckToken 'token-alpha' -StatePath ${ps(statePath)} -NowMs 1100
      $disk = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
      $merged = Merge-OrchestratorEscalationRouterWritebackState -State $memory -DiskState $disk -DirtyRecordKeys @('alpha') -SnapshotLoadedAtMs 1000
      Set-MechanicalJsonStateFile -Path ${ps(statePath)} -State $merged -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
      $after = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState
      [pscustomobject]@{ ackOk = [bool]$ack.ok; terminalState = [string]$after.records['alpha'].terminalState } | ConvertTo-Json -Compress
    `);
    expectPwshSuccess(result);
    expect(parseLastJson(result.stdout)).toEqual({ ackOk: true, terminalState: 'acked' });
  });

  it('preserves actual quarantine release and delete writers mid-tick', () => {
    const releasePath = newStatePath('escalation-release-mid-tick');
    const deletePath = newStatePath('escalation-delete-mid-tick');
    const quarantined = record({ terminalState: 'quarantined', status: 'quarantined', updatedAtMs: 1000 });
    const result = runPwsh(`
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $quarantined = ${ps(JSON.stringify(quarantined))} | ConvertFrom-Json -AsHashtable
      $seed = @{ schemaVersion = 2; records = @{ alpha = $quarantined }; wakeWindows = @{}; audit = @{} }
      Set-MechanicalJsonStateFile -Path ${ps(releasePath)} -State $seed -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
      $releaseMemory = Get-MechanicalJsonStateFile -Path ${ps(releasePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
      $releaseMemory.records['alpha'].updatedAtMs = 1300
      $null = Write-OrchestratorEscalationQuarantineAction -EscalationId 'alpha' -Action release -StatePath ${ps(releasePath)} -NowMs 1100
      $releaseDisk = Get-MechanicalJsonStateFile -Path ${ps(releasePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
      $releaseMerged = Merge-OrchestratorEscalationRouterWritebackState -State $releaseMemory -DiskState $releaseDisk -DirtyRecordKeys @('alpha') -SnapshotLoadedAtMs 1100

      Set-MechanicalJsonStateFile -Path ${ps(deletePath)} -State $seed -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
      $deleteMemory = Get-MechanicalJsonStateFile -Path ${ps(deletePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
      $null = Write-OrchestratorEscalationQuarantineAction -EscalationId 'alpha' -Action delete -StatePath ${ps(deletePath)} -NowMs 1100
      $deleteDisk = Get-MechanicalJsonStateFile -Path ${ps(deletePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
      $deleteMerged = Merge-OrchestratorEscalationRouterWritebackState -State $deleteMemory -DiskState $deleteDisk -DirtyRecordKeys @('alpha') -SnapshotLoadedAtMs 1000

      [pscustomobject]@{
        releaseState = [string]$releaseMerged.records['alpha'].terminalState
        deleted = -not $deleteMerged.records.ContainsKey('alpha')
      } | ConvertTo-Json -Compress
    `);
    expectPwshSuccess(result);
    expect(parseLastJson(result.stdout)).toEqual({ releaseState: 'open', deleted: true });
  });

  it('preserves an actual same-millisecond operator ACK and advances updatedAtMs', () => {
    const statePath = newStatePath('escalation-operator-ack-mid-tick');
    const result = runPwsh(`
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $seed = @{ schemaVersion = 2; records = @{ alpha = (${ps(JSON.stringify(record()))} | ConvertFrom-Json -AsHashtable) }; wakeWindows = @{}; audit = @{} }
      Set-MechanicalJsonStateFile -Path ${ps(statePath)} -State $seed -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
      $memory = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
      $memory.records['alpha'].updatedAtMs = 1100
      $memory.records['alpha'].attempts = 5
      $memory.records['alpha'].firstAttemptAtMs = 901
      $ack = Write-OperatorEscalationAck -EscalationId 'alpha' -AckToken 'token-alpha' -StatePath ${ps(statePath)} -NowMs 1100
      $disk = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
      $merged = Merge-OrchestratorEscalationRouterWritebackState -State $memory -DiskState $disk -DirtyRecordKeys @('alpha') -SnapshotLoadedAtMs 1000
      [pscustomobject]@{
        ackOk = [bool]$ack.ok
        operatorStatus = [string]$merged.records['alpha'].operatorStatus
        operatorAckedAtMs = [long]$merged.records['alpha'].operatorAckedAtMs
        updatedAtMs = [long]$disk.records['alpha'].updatedAtMs
        attempts = [int]$merged.records['alpha'].attempts
        firstAttemptAtMs = [long]$merged.records['alpha'].firstAttemptAtMs
      } | ConvertTo-Json -Compress
    `);
    expectPwshSuccess(result);
    expect(parseLastJson(result.stdout)).toEqual({
      ackOk: true,
      operatorStatus: 'acked',
      operatorAckedAtMs: 1100,
      updatedAtMs: 1100,
      attempts: 5,
      firstAttemptAtMs: 901,
    });
  });

  it('uses the same invariant after replay reread and at final writeback', () => {
    const statePath = newStatePath('escalation-replay-residual-window');
    const result = runPwsh(`
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $tokens = $null
      $errors = $null
      $routerAst = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path './scripts/orchestrator-escalation-router.ps1'), [ref]$tokens, [ref]$errors)
      if ($errors.Count -gt 0) { throw ($errors | Out-String) }
      $mergeAst = $routerAst.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Merge-EscalationRouterReplayState' }, $true)
      if ($null -eq $mergeAst) { throw 'replay merge function not found' }
      Invoke-Expression $mergeAst.Extent.Text

      $seedRecord = ${ps(JSON.stringify(record()))} | ConvertFrom-Json -AsHashtable
      $seed = @{ schemaVersion = 2; records = @{ alpha = $seedRecord }; wakeWindows = @{}; audit = @{} }
      Set-MechanicalJsonStateFile -Path ${ps(statePath)} -State $seed -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
      $memory = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
      $memory.records['alpha'].firstAttemptAtMs = 900
      $memory.records['alpha'].status = 'backoff_waiting'
      $replayDisk = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
      Merge-EscalationRouterReplayState -State $memory -DiskState $replayDisk -RecordKey 'alpha' -SnapshotLoadedAtMs 1000
      $ack = Write-OrchestratorEscalationAck -EscalationId 'alpha' -AckToken 'token-alpha' -StatePath ${ps(statePath)} -NowMs 1100
      $finalDisk = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
      $final = Merge-OrchestratorEscalationRouterWritebackState -State $memory -DiskState $finalDisk -DirtyRecordKeys @('alpha') -SnapshotLoadedAtMs 1000
      [pscustomobject]@{ ackOk = [bool]$ack.ok; terminalState = [string]$final.records['alpha'].terminalState } | ConvertTo-Json -Compress
    `);
    expectPwshSuccess(result);
    expect(parseLastJson(result.stdout)).toEqual({ ackOk: true, terminalState: 'acked' });
  });

  it('keeps ACKs written before snapshot load and after writeback', () => {
    const statePath = newStatePath('escalation-safe-windows');
    const result = runPwsh(`
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $seed = @{ schemaVersion = 2; records = @{ alpha = (${ps(JSON.stringify(record()))} | ConvertFrom-Json -AsHashtable) }; wakeWindows = @{}; audit = @{} }
      Set-MechanicalJsonStateFile -Path ${ps(statePath)} -State $seed -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
      $beforeAck = Write-OrchestratorEscalationAck -EscalationId 'alpha' -AckToken 'token-alpha' -StatePath ${ps(statePath)} -NowMs 1000
      $beforeMemory = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
      $beforeDisk = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
      $beforeMerged = Merge-OrchestratorEscalationRouterWritebackState -State $beforeMemory -DiskState $beforeDisk -DirtyRecordKeys @('alpha') -SnapshotLoadedAtMs 1000

      $open = @{ schemaVersion = 2; records = @{ alpha = (${ps(JSON.stringify(record({ updatedAtMs: 1200 })))} | ConvertFrom-Json -AsHashtable) }; wakeWindows = @{}; audit = @{} }
      Set-MechanicalJsonStateFile -Path ${ps(statePath)} -State $open -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
      $afterMemory = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
      $afterDisk = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
      $afterMerged = Merge-OrchestratorEscalationRouterWritebackState -State $afterMemory -DiskState $afterDisk -DirtyRecordKeys @('alpha') -SnapshotLoadedAtMs 1200
      Set-MechanicalJsonStateFile -Path ${ps(statePath)} -State $afterMerged -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
      $afterAck = Write-OrchestratorEscalationAck -EscalationId 'alpha' -AckToken 'token-alpha' -StatePath ${ps(statePath)} -NowMs 1300
      $final = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState

      [pscustomobject]@{
        beforeAckOk = [bool]$beforeAck.ok
        beforeState = [string]$beforeMerged.records['alpha'].terminalState
        afterAckOk = [bool]$afterAck.ok
        afterState = [string]$final.records['alpha'].terminalState
      } | ConvertTo-Json -Compress
    `);
    expectPwshSuccess(result);
    expect(parseLastJson(result.stdout)).toEqual({
      beforeAckOk: true,
      beforeState: 'acked',
      afterAckOk: true,
      afterState: 'acked',
    });
  });
});
