import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProcessSync } from '../scripts/kernel/subprocess.ts';

const repoRoot = join(import.meta.dirname, '..');

function ps(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

type OperatorTieResult = {
  ackOk: boolean;
  status: string;
  ackedAtMs: number;
  updatedAtMs: number;
  attempts: number;
  firstAttemptAtMs: number;
};

let root = '';
let resultValue!: OperatorTieResult;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'escalation-operator-tie-'));
  const statePath = join(root, 'state.json');
  const result = runProcessSync({
    command: 'pwsh',
    args: [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `
        . ./scripts/lib/Orchestrator-Escalation.ps1
        $seed = @{
          schemaVersion = 2
          records = @{ alpha = @{
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
          } }
          wakeWindows = @{}
          audit = @{}
        }
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
          status = [string]$merged.records['alpha'].operatorStatus
          ackedAtMs = [long]$merged.records['alpha'].operatorAckedAtMs
          updatedAtMs = [long]$disk.records['alpha'].updatedAtMs
          attempts = [int]$merged.records['alpha'].attempts
          firstAttemptAtMs = [long]$merged.records['alpha'].firstAttemptAtMs
        } | ConvertTo-Json -Compress
      `,
    ],
    cwd: repoRoot,
    inheritParentEnv: true,
  });

  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  resultValue = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as OperatorTieResult;
}, 120_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('operator ACK same-millisecond writeback', () => {
  it('preserves the ACK marker and in-memory bookkeeping', () => {
    expect(resultValue).toEqual({
      ackOk: true,
      status: 'acked',
      ackedAtMs: 1100,
      updatedAtMs: 1100,
      attempts: 5,
      firstAttemptAtMs: 901,
    });
  });
});
