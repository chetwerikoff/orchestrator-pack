import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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

describe('escalation-store strict-newer acceptance edges', () => {
  it('keeps a strictly newer disk ACK over a stale terminal tick decision', () => {
    const result = runPwsh(`
      . ./scripts/lib/Orchestrator-Escalation.ps1
      $memory = @{ schemaVersion = 2; records = @{ alpha = @{ recordKey = 'alpha'; status = 'dead_lettered'; terminalState = 'dead_lettered'; updatedAtMs = 1100 } }; wakeWindows = @{}; audit = @{} }
      $disk = @{ schemaVersion = 2; records = @{ alpha = @{ recordKey = 'alpha'; status = 'acked'; terminalState = 'acked'; updatedAtMs = 1101 } }; wakeWindows = @{}; audit = @{} }
      $merged = Merge-OrchestratorEscalationRouterWritebackState -State $memory -DiskState $disk -DirtyRecordKeys @('alpha') -SnapshotLoadedAtMs 1000
      [pscustomobject]@{ terminalState = [string]$merged.records['alpha'].terminalState; updatedAtMs = [long]$merged.records['alpha'].updatedAtMs } | ConvertTo-Json -Compress
    `);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(parseLastJson(result.stdout)).toEqual({ terminalState: 'acked', updatedAtMs: 1101 });
  });

  it('keeps a strictly newer operator ACK and its updatedAtMs bump', () => {
    const dir = mkdtempSync(join(tmpdir(), 'escalation-operator-ack-newer-'));
    const statePath = join(dir, 'escalation-state.json');
    try {
      const result = runPwsh(`
        . ./scripts/lib/Orchestrator-Escalation.ps1
        $seed = @{ schemaVersion = 2; records = @{ alpha = @{ schemaVersion = 2; recordKey = 'alpha'; escalationId = 'alpha'; ackToken = 'token-alpha'; route = 'llm-orchestrator'; status = 'pending'; terminalState = 'open'; operatorStatus = 'pending'; attempts = 1; createdAtMs = 900; updatedAtMs = 1100 } }; wakeWindows = @{}; audit = @{} }
        Set-MechanicalJsonStateFile -Path ${ps(statePath)} -State $seed -DefaultState $Script:OrchestratorEscalationDefaultState -JsonDepth 30
        $memory = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
        $ack = Write-OperatorEscalationAck -EscalationId 'alpha' -AckToken 'token-alpha' -StatePath ${ps(statePath)} -NowMs 1101
        $disk = Get-MechanicalJsonStateFile -Path ${ps(statePath)} -DefaultState $Script:OrchestratorEscalationDefaultState -ActionTracking
        $merged = Merge-OrchestratorEscalationRouterWritebackState -State $memory -DiskState $disk -DirtyRecordKeys @('alpha') -SnapshotLoadedAtMs 1000
        [pscustomobject]@{
          ackOk = [bool]$ack.ok
          operatorStatus = [string]$merged.records['alpha'].operatorStatus
          operatorAckedAtMs = [long]$merged.records['alpha'].operatorAckedAtMs
          updatedAtMs = [long]$merged.records['alpha'].updatedAtMs
        } | ConvertTo-Json -Compress
      `);
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(parseLastJson(result.stdout)).toEqual({
        ackOk: true,
        operatorStatus: 'acked',
        operatorAckedAtMs: 1101,
        updatedAtMs: 1101,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
