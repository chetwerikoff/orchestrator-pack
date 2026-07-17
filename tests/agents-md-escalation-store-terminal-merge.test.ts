import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..');

function ps(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function runPwsh(script: string) {
  return spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env },
  });
}

describe('escalation-store terminal merge invariant', () => {
  let tempDir = '';

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('preserves an out-of-band ACK written between snapshot load and dirty-key writeback', () => {
    tempDir = join(tmpdir(), `escalation-ack-mid-tick-${process.pid}-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const statePath = join(tempDir, 'escalation-state.json');

    const result = runPwsh(`
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $seed = @{
        schemaVersion = 2
        records = @{
          alpha = @{
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
        }
        wakeWindows = @{}
        audit = @{}
      }
      Set-MechanicalJsonStateFile -Path ${ps(statePath)} -State $seed -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30

      $memory = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
      $memory.records['alpha'].status = 'backoff_waiting'
      $memory.records['alpha'].terminalState = 'open'

      $ack = Write-OrchestratorEscalationAck -EscalationId 'alpha' -AckToken 'token-alpha' -StatePath ${ps(statePath)} -NowMs 1100
      $disk = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
      $mergeArgs = @{
        State = $memory
        DiskState = $disk
        DirtyRecordKeys = @('alpha')
      }
      if ((Get-Command Merge-OrchestratorEscalationRouterWritebackState).Parameters.ContainsKey('SnapshotLoadedAtMs')) {
        $mergeArgs.SnapshotLoadedAtMs = 1000
      }
      $merged = Merge-OrchestratorEscalationRouterWritebackState @mergeArgs
      Set-MechanicalJsonStateFile -Path ${ps(statePath)} -State $merged -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
      $after = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState

      [pscustomobject]@{
        ackOk = [bool]$ack.ok
        terminalState = [string]$after.records['alpha'].terminalState
        status = [string]$after.records['alpha'].status
      } | ConvertTo-Json -Compress
    `);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as {
      ackOk: boolean;
      terminalState: string;
      status: string;
    };
    expect(output.ackOk).toBe(true);
    expect(output.terminalState).toBe('acked');
    expect(output.status).toBe('acked');
  });
});
