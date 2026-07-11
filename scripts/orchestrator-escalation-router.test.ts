import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..');

function ps(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function runPwsh(script: string, env: Record<string, string> = {}) {
  return spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('orchestrator escalation router', () => {
  let tempDir = '';

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('worker degraded-ci handoff records llm-orchestrator escalation and router delivers it', () => {
    tempDir = join(tmpdir(), `worker-degraded-ci-${process.pid}-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    const state = join(tempDir, 'escalation-state.json');
    const inbox = join(tempDir, 'operator-inbox');
    const health = join(tempDir, 'health');
    const pendingFixture = join(
      repoRoot,
      'scripts/fixtures/side-process-launch-contract/pending-llm-orchestrator-escalation.json',
    );

    const emit = runPwsh(
      `
      . ./scripts/lib/Invoke-WorkerDegradedCiHandoff.ps1
      $result = Invoke-WorkerDegradedCiHandoff -PrNumber 48 -PrHeadSha 'handoff48' -WorkerSessionId 'op-worker-48' -Reason 'required checks missing' -PrUrl 'https://github.com/chetwerikoff/orchestrator-pack/pull/48' -OrchestratorSessionId 'orch-test' -DryRun
      $state = Get-Content -LiteralPath ${ps(state)} -Raw | ConvertFrom-Json
      $record = $state.records.PSObject.Properties.Value | Select-Object -First 1
      [pscustomobject]@{
        ok = [bool]$result.ok
        status = [string]$result.status
        escalationClassId = [string]$record.escalationClassId
        route = [string]$record.route
        attempts = [int]$record.attempts
      } | ConvertTo-Json -Compress
    `,
      {
        AO_ORCHESTRATOR_ESCALATION_STATE: state,
        AO_ORCHESTRATOR_ESCALATION_OPERATOR_INBOX: inbox,
        AO_ORCHESTRATOR_ESCALATION_HEALTH_SPOOL: health,
      },
    );
    expect(emit.status, `${emit.stdout}\n${emit.stderr}`).toBe(0);
    const emitted = JSON.parse(emit.stdout.trim().split('\n').at(-1) ?? '{}') as {
      ok: boolean;
      status: string;
      escalationClassId: string;
      route: string;
      attempts: number;
    };
    expect(emitted.ok).toBe(true);
    expect(emitted.status).toBe('delivered');
    expect(emitted.escalationClassId).toBe('escalation-worker-degraded-ci-handoff');
    expect(emitted.route).toBe('llm-orchestrator');
    expect(emitted.attempts).toBe(1);

    writeFileSync(state, readFileSync(pendingFixture, 'utf8'));
    const prepareFixture = runPwsh(
      `
      $doc = Get-Content -LiteralPath ${ps(state)} -Raw | ConvertFrom-Json
      $record = $doc.records.PSObject.Properties.Value | Select-Object -First 1
      $record.escalationClassId = 'escalation-worker-degraded-ci-handoff'
      $record.correlationKey = 'corr:worker-degraded-ci:48:handoff48'
      $record.lastPayload = @{
        prNumber = 48
        prHeadSha = 'handoff48'
        workerSessionId = 'op-worker-48'
        reason = 'required checks missing'
      }
      $record.lastMessage = 'worker degraded-ci handoff fixture'
      $record.status = 'pending'
      $record.attempts = 0
      $doc.wakeWindows = @{}
      $doc | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath ${ps(state)}
    `,
    );
    expect(prepareFixture.status, `${prepareFixture.stdout}\n${prepareFixture.stderr}`).toBe(0);

    const router = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        'scripts/orchestrator-escalation-router.ps1',
        '-OrchestratorSessionId',
        'orch-test',
        '-Once',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          AO_ESCALATION_FORCE_SEND_FAILURE: '1',
          AO_ORCHESTRATOR_ESCALATION_STATE: state,
          AO_ORCHESTRATOR_ESCALATION_OPERATOR_INBOX: inbox,
          AO_ORCHESTRATOR_ESCALATION_HEALTH_SPOOL: health,
        },
      },
    );
    expect(router.status, `${router.stdout}\n${router.stderr}`).toBe(0);
    expect(router.stdout).toMatch(/tick complete redelivered=/);

    const helperSource = readFileSync(
      join(repoRoot, 'scripts/lib/Invoke-WorkerDegradedCiHandoff.ps1'),
      'utf8',
    );
    expect(helperSource).not.toMatch(/\bao send\b/);

    const after = JSON.parse(readFileSync(state, 'utf8')) as {
      records: Record<
        string,
        {
          escalationClassId?: string;
          correlationKey?: string;
          route?: string;
          status?: string;
          attempts?: number;
          acknowledgedAtMs?: number | null;
        }
      >;
    };
    const canonicalRecord = Object.values(after.records).find(
      (record) =>
        record.escalationClassId === 'escalation-worker-degraded-ci-handoff' &&
        record.correlationKey === 'corr:worker-degraded-ci:48:handoff48' &&
        record.route === 'llm-orchestrator' &&
        (record.attempts ?? 0) > 0,
    );
    expect(canonicalRecord).toBeDefined();
    expect(canonicalRecord?.status).toBe('fail_closed');
    expect(canonicalRecord?.acknowledgedAtMs ?? null).toBeNull();
  });
});
