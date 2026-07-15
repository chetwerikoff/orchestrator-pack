import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { psString, repoRoot } from './_test-pwsh-helpers.js';

const recoveryPs1 = path.join(repoRoot, 'scripts/lib/Worker-Recovery.ps1');
const claimHelper = path.join(repoRoot, 'scripts/lib/Worker-NudgeClaim.ps1');
const journaledSend = path.join(repoRoot, 'scripts/journaled-worker-send.ps1');

function lastJson(stdout: string): Record<string, unknown> {
  const line = stdout.split(/\r?\n/).map((value) => value.trim()).findLast((value) => value.startsWith('{'));
  return JSON.parse(line ?? '{}') as Record<string, unknown>;
}

function runRecovery(policy: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-821-recovery-'));
  try {
    const script = `
      . ${psString(recoveryPs1)}
      $env:AO_SESSION_ID = 'issue-821-recovery-session'
      $env:AO_BASE_DIR = ${psString(root)}
      $env:AO_PROJECT_ID = 'orchestrator-pack'
      Remove-Item Env:AO_SPAWN_WORKTREE_GRANT_ID -ErrorAction SilentlyContinue
      $result = Invoke-WorkerRecoverySpawn -SpawnAction 'spawn-new' -IssueNumber 821 -ProjectId 'orchestrator-pack' -PackRoot ${psString(repoRoot)} -SpawnPolicy ${policy} -FixtureMode
      $grantId = [string]$env:AO_SPAWN_WORKTREE_GRANT_ID
      Clear-AutonomousClaimPrResumeActiveMutex
      Clear-AutonomousSpawnWorktreeActiveGrant
      [pscustomobject]@{
        active = [bool](Test-OrchestratorAutonomousSurfaceActiveForSpawnGate)
        started = [bool]$result.started
        grantDenied = [bool]$result.grantDenied
        reason = [string]$result.reason
        auditLine = [string]$result.auditLine
        grantId = $grantId
      } | ConvertTo-Json -Compress
    `;
    return spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, AO_BASE_DIR: root, OPK_VITEST_HARNESS: '1' },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeAoStub(root: string): string {
  const target = path.join(root, 'ao-stub.sh');
  writeFileSync(target, `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$*" >> "${'${AO_SEND_PROBE_FILE}'}"\nexit 0\n`, 'utf8');
  chmodSync(target, 0o755);
  return target;
}

function runNudge(gated: boolean) {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-821-nudge-'));
  const claimDir = path.join(root, 'claims');
  const journal = path.join(root, 'dispatch-journal.json');
  const probe = path.join(root, 'send.argv');
  const stub = writeAoStub(root);
  const gatedArg = gated ? '-GatedNudge' : '';
  try {
    const script = `
      . ${psString(claimHelper)}
      $env:AO_SESSION_ID = 'issue-821-worker-session'
      $env:AO_BASE_DIR = ${psString(root)}
      $env:AO_WORKER_NUDGE_CLAIM_DIR = ${psString(claimDir)}
      $env:AO_JOURNALED_SEND_ASSUME_CONTRACT = '1'
      $env:AO_SEND_PROBE_FILE = ${psString(probe)}
      $claim = Acquire-WorkerNudgeClaim -PrNumber 821 -CycleKey 'run:issue-821-${gated ? 'admit' : 'deny'}' -IntentClass 'review-findings' -WorkerTarget 'opk-821:gen1' -SessionId 'opk-821' -Surface 'test'
      if (-not $claim.acquired) { throw "acquire failed: $($claim.reason)" }
      $token = New-WorkerNudgeClaimToken -ClaimResult $claim
      $before = Get-Content -LiteralPath $claim.path -Raw
      'issue 821 payload' | & pwsh -NoProfile -ExecutionPolicy Bypass -File ${psString(journaledSend)} 'opk-821' -Source 'test' -AoPath ${psString(stub)} -JournalPath ${psString(journal)} -ClaimToken $token ${gatedArg}
      $sendExit = $LASTEXITCODE
      $after = Get-Content -LiteralPath $claim.path -Raw
      [pscustomobject]@{
        exitCode = $sendExit
        claimUnchanged = ($before -ceq $after)
        journalExists = Test-Path -LiteralPath ${psString(journal)}
        probeExists = Test-Path -LiteralPath ${psString(probe)}
      } | ConvertTo-Json -Compress
    `;
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, AO_BASE_DIR: root, OPK_VITEST_HARNESS: '1' },
    });
    return { result, root, journal, probe };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

describe('issue 821 AO_SESSION_ID gate migration', () => {
  it('admits permitted recovery spawn, seats one grant, and emits one allow audit line', () => {
    const result = runRecovery("@{ version='autonomous-spawn-policy/v1'; allowSpawnNew=$true; allowClaimPrResume=$true }");
    expect(result.status).toBe(0);
    const parsed = lastJson(result.stdout);
    expect(parsed.active).toBe(true);
    expect(parsed.started).toBe(true);
    expect(parsed.grantDenied).toBe(false);
    expect(String(parsed.grantId)).toMatch(/\S/);
    const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).filter((line) => line.includes('autonomous spawn policy allow: action=spawn-new'));
    expect(lines).toHaveLength(1);
  });

  it('denies disabled recovery spawn without a partial grant and emits one deny audit line', () => {
    const result = runRecovery("@{ version='autonomous-spawn-policy/v1'; allowSpawnNew=$false; allowClaimPrResume=$true }");
    expect(result.status).toBe(0);
    const parsed = lastJson(result.stdout);
    expect(parsed.active).toBe(true);
    expect(parsed.started).toBe(false);
    expect(parsed.grantDenied).toBe(true);
    expect(parsed.reason).toBe('spawn_policy_allowSpawnNew_false');
    expect(parsed.grantId).toBeFalsy();
    const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).filter((line) => line.includes('autonomous spawn policy deny: action=spawn-new reason=spawn_policy_allowSpawnNew_false'));
    expect(lines).toHaveLength(1);
  });

  it('admits a claimed journaled nudge through AO 0.10.2 send argv', () => {
    const state = runNudge(true);
    try {
      expect(state.result.status).toBe(0);
      const parsed = lastJson(state.result.stdout);
      expect(parsed.exitCode).toBe(0);
      expect(parsed.journalExists).toBe(true);
      expect(parsed.probeExists).toBe(true);
      expect(readFileSync(state.probe, 'utf8')).toContain('send --message issue 821 payload --session opk-821');
      expect(`${state.result.stdout}\n${state.result.stderr}`).not.toMatch(/autonomous surface requires gated claim token/);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('denies an ungated journaled nudge without consuming claim state or creating dispatch state', () => {
    const state = runNudge(false);
    try {
      expect(state.result.status).toBe(0);
      const parsed = lastJson(state.result.stdout);
      expect(parsed.exitCode).toBe(46);
      expect(parsed.claimUnchanged).toBe(true);
      expect(parsed.journalExists).toBe(false);
      expect(parsed.probeExists).toBe(false);
      const lines = `${state.result.stdout}\n${state.result.stderr}`.split(/\r?\n/).filter((line) => line.includes('worker nudge rejected: autonomous surface requires gated claim token'));
      expect(lines).toHaveLength(1);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });
});
