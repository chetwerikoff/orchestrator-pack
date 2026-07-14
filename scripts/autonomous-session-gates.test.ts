import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';

const spawnGate = path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousSpawnGate.ps1');
const reviewGate = path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousReviewStartGate.ps1');
const workerGate = path.join(repoRoot, 'scripts/lib/Worker-AutonomousNudgeGate.ps1');
const boundary = path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousBoundary.ps1');

function evaluateSessionCell(sessionId: string | null) {
  const literal = sessionId === null ? '$null' : psString(sessionId);
  const output = runPwsh(`
    $prior = $env:AO_SESSION_ID
    try {
      if (${literal} -eq $null) { Remove-Item Env:AO_SESSION_ID -ErrorAction SilentlyContinue }
      else { $env:AO_SESSION_ID = ${literal} }
      . ${psString(spawnGate)}
      . ${psString(reviewGate)}
      . ${psString(workerGate)}
      . ${psString(boundary)}
      $review = Test-AutonomousRawReviewRunDenied -Argv @('review','run')
      $worker = Test-AutonomousRawWorkerSendDenied -Argv @('send','worker-1')
      $git = Test-AutonomousGitDenied -Argv @('branch','-m','blocked')
      [pscustomobject]@{
        spawn = [bool](Test-OrchestratorAutonomousSurfaceActiveForSpawnGate)
        review = [bool](Test-OrchestratorAutonomousSurfaceActive)
        boundary = [bool](Test-OrchestratorAutonomousSurfaceActiveForBoundary)
        reviewDenied = [bool]$review.denied
        reviewReason = [string]$review.reason
        workerDenied = [bool]$worker.denied
        workerReason = [string]$worker.reason
        gitDenied = [bool]$git.denied
        gitReason = [string]$git.reason
      } | ConvertTo-Json -Compress
    }
    finally {
      if ($prior) { $env:AO_SESSION_ID = $prior } else { Remove-Item Env:AO_SESSION_ID -ErrorAction SilentlyContinue }
    }
  `);
  return JSON.parse(output.trim());
}

describe('AO 0.10.2 in-process autonomous gate activation (#821)', () => {
  it.each([
    ['orchestrator', 'orchestrator-session'],
    ['worker', 'worker-session'],
  ])('%s session activates all shared predicates', (_role, sessionId) => {
    const result = evaluateSessionCell(sessionId);
    expect(result.spawn).toBe(true);
    expect(result.review).toBe(true);
    expect(result.boundary).toBe(true);
    expect(result.reviewDenied).toBe(true);
    expect(result.reviewReason).toBe('autonomous_raw_review_run_denied');
    expect(result.workerDenied).toBe(true);
    expect(result.workerReason).toBe('autonomous_raw_worker_send_denied');
    expect(result.gitDenied).toBe(true);
    expect(result.gitReason).toBe('autonomous_mutating_git_denied');
  });

  it.each([
    ['review', null],
    ['operator manual shell', null],
    ['CI', null],
  ])('%s without a session id remains outside the in-process gate', (_role, sessionId) => {
    const result = evaluateSessionCell(sessionId);
    expect(result.spawn).toBe(false);
    expect(result.review).toBe(false);
    expect(result.boundary).toBe(false);
    expect(result.reviewDenied).toBe(false);
    expect(result.reviewReason).toBe('manual_surface');
    expect(result.workerDenied).toBe(false);
    expect(result.workerReason).toBe('manual_surface');
    expect(result.gitDenied).toBe(false);
    expect(result.gitReason).toBe('manual_surface');
  });

  it('uses presence rather than a magic value', () => {
    const result = evaluateSessionCell('worker-any-nonempty-value');
    expect(result.spawn).toBe(true);
    expect(result.review).toBe(true);
    expect(result.boundary).toBe(true);
  });

  it('retains the claimed review bypass without changing its reason', () => {
    const output = runPwsh(`
      . ${psString(reviewGate)}
      $env:AO_SESSION_ID = 'orchestrator-session'
      $env:AO_CLAIMED_REVIEW_RUN_BYPASS = '1'
      (Test-AutonomousRawReviewRunDenied -Argv @('review','run')) | ConvertTo-Json -Compress
    `);
    const result = JSON.parse(output.trim());
    expect(result.denied).toBe(false);
    expect(result.reason).toBe('claimed_bypass');
  });

  it('accepts direct command invocation as ungated after boundary wrappers retire', () => {
    for (const retired of [
      'scripts/ao',
      'scripts/git',
      'scripts/ao-autonomous-guard.ps1',
      'scripts/git-autonomous-guard.ps1',
    ]) {
      expect(existsSync(path.join(repoRoot, retired))).toBe(false);
    }
  });
});
