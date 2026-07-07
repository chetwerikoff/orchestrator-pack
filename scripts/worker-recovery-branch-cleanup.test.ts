import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSpawnWorktreeGrantRecord } from '../docs/spawn-worktree-grant.mjs';
import {
  DEFAULT_BRANCH_OBSERVATION_TTL_SECONDS,
  evaluateBranchDeletionRevalidation,
  evaluateBranchPreexistsClassification,
  evaluateIssueTaskEligibility,
  evaluateDisposableWorkerBranch,
  evaluateOpenPrTriState,
  evaluateWorkerRecoveryBranchGitAllow,
  normalizeWorkerBranchRef,
  parseBranchDeleteForceArgv,
  parseRecoveryBranchDeleteArgv,
  parseUpdateRefBranchDeleteArgv,
} from '../docs/worker-recovery-branch-cleanup.mjs';
import { gitFixtureEnv, resolveTrustedSystemGit, withTempGitRepo } from './_test-git-fixture.js';
import { psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';
import { headOidSpawnWorktreeRepo, setupSpawnWorktreeRepo } from './_test-spawn-worktree-fixture.js';

const tempRoots: string[] = [];
const git = resolveTrustedSystemGit();

function tempNs() {
  const dir = mkdtempSync(path.join(tmpdir(), 'worker-recovery-branch-'));
  tempRoots.push(dir);
  return dir;
}

function gitIn(dir: string, args: string[]) {
  execFileSync(git, ['-C', dir, ...args], { stdio: 'ignore', env: gitFixtureEnv() });
}

function buildConsumedGrant(issueNumber: number, repo: string, baseRef: string, sessionId: string, worktreePath: string) {
  const built = buildSpawnWorktreeGrantRecord({
    argv: ['spawn', '--issue', String(issueNumber)],
    grantId: `grant-${sessionId}`,
    holder: { pid: 1 },
    sourceRepositoryRoot: repo,
    sourceGitWorktreeRoot: repo,
    expectedHeadRef: baseRef,
  });
  expect(built.ok).toBe(true);
  const grant = {
    ...(built.grant as Record<string, unknown>),
    consumed: true,
    consumedCanonicalPath: worktreePath,
    consumedAtUtc: new Date().toISOString(),
  };
  return grant;
}

function grantPs(grant: Record<string, unknown>, sessionId: string, worktreePath: string, grantStartOid: string) {
  const branch = String(grant.expectedBranch ?? `feat/issue-592`);
  return `$grant = @{
  grantId = ${psString(String(grant.grantId ?? 'grant-test'))}
  consumed = $true
  consumedCanonicalPath = ${psString(worktreePath)}
  authorizedWorktreeNames = @(${psString(sessionId)})
  expectedBranch = ${psString(branch)}
  expectedCommitOid = ${psString(grantStartOid)}
  authorizedWorkerBranches = @(${psString(branch)}, 'feat/592', ${psString(sessionId)})
}`;
}

function freshObservation(overrides: Record<string, unknown> = {}) {
  return {
    observedAtUtc: new Date().toISOString(),
    ttlSeconds: DEFAULT_BRANCH_OBSERVATION_TTL_SECONDS,
    fetchFailed: false,
    rateLimited: false,
    openPrByHeadRefName: {},
    ...overrides,
  };
}

function disposableInput(overrides: Record<string, unknown> = {}) {
  const grantStartOid = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  return {
    branchExists: true,
    branch: 'feat/issue-592',
    branchHeadOid: grantStartOid,
    sessionId: 'opk-592',
    canonicalPath: '/tmp/projects/orchestrator-pack/worktrees/opk-592',
    grant: {
      consumed: true,
      consumedCanonicalPath: '/tmp/projects/orchestrator-pack/worktrees/opk-592',
      authorizedWorktreeNames: ['opk-592'],
      expectedBranch: 'feat/issue-592',
      expectedCommitOid: grantStartOid,
      authorizedWorkerBranches: ['feat/issue-592', 'feat/592', 'opk-592'],
    },
    worktreeRecords: [],
    localAheadCount: 0,
    remoteAheadCount: 0,
    diverged: false,
    reflogEntries: [],
    danglingReachableCount: 0,
    ...freshObservation(),
    ...overrides,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('worker recovery branch cleanup classification (#592)', () => {
  it('normalizes refs/heads branch refs for Linux pwsh identity', () => {
    expect(normalizeWorkerBranchRef('refs/heads/feat/issue-592')).toEqual({
      ok: true,
      branch: 'feat/issue-592',
    });
    expect(normalizeWorkerBranchRef('Feat/Issue-592').ok).toBe(true);
  });

  it('parses git branch -D argv', () => {
    const parsed = parseBranchDeleteForceArgv(['branch', '-D', 'feat/issue-592']);
    expect(parsed).toEqual({ ok: true, branch: 'feat/issue-592', force: true });
  });

  it('parses git update-ref -d refs/heads without expected OID argv', () => {
    const parsed = parseUpdateRefBranchDeleteArgv(['update-ref', '-d', 'refs/heads/feat/issue-592']);
    expect(parsed).toEqual({
      ok: true,
      branch: 'feat/issue-592',
      expectedOid: '',
      force: true,
      mechanism: 'update_ref_branch_delete',
    });
    expect(parseRecoveryBranchDeleteArgv(['update-ref', '-d', 'refs/heads/feat/issue-592']).mechanism).toBe(
      'update_ref_branch_delete',
    );
  });

  it('parses git update-ref -d refs/heads with expected OID argv', () => {
    const oid = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const parsed = parseUpdateRefBranchDeleteArgv(['update-ref', '-d', 'refs/heads/feat/issue-592', oid]);
    expect(parsed).toEqual({
      ok: true,
      branch: 'feat/issue-592',
      expectedOid: oid,
      force: true,
      mechanism: 'update_ref_expected_oid',
    });
    expect(parseRecoveryBranchDeleteArgv(['update-ref', '-d', 'refs/heads/feat/issue-592', oid]).mechanism).toBe(
      'update_ref_expected_oid',
    );
  });

  it('deletes disposable orphan branch when grant lineage and remote/pr state are clean', () => {
    const result = evaluateDisposableWorkerBranch(disposableInput());
    expect(result.disposable).toBe(true);
    expect(result.action).toBe('delete');
    expect(result.reason).toBe('disposable_orphan_branch');
  });

  it('preserves branch when consumed grant is absent', () => {
    const result = evaluateDisposableWorkerBranch(disposableInput({ grant: null }));
    expect(result.disposable).toBe(false);
    expect(result.escalation).toBe('blocked_grant_absent');
  });

  it('preserves branch on head mismatch, divergence, and local-only commits', () => {
    expect(evaluateDisposableWorkerBranch(disposableInput({ branchHeadOid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })).escalation).toBe(
      'blocked_head_mismatch',
    );
    expect(evaluateDisposableWorkerBranch(disposableInput({ diverged: true })).escalation).toBe('blocked_diverged');
    expect(evaluateDisposableWorkerBranch(disposableInput({ localAheadCount: 1 })).escalation).toBe(
      'blocked_local_only_commits',
    );
    expect(evaluateDisposableWorkerBranch(disposableInput({ remoteAheadCount: 1 })).escalation).toBe(
      'blocked_remote_only_commits',
    );
  });

  it('preserves on open PR present, PR unknown, and rate-limit PR unknown', () => {
    expect(
      evaluateDisposableWorkerBranch(
        disposableInput({
          openPrByHeadRefName: { 'feat/issue-592': { number: 1 } },
        }),
      ).escalation,
    ).toBe('blocked_open_pr_present');
    expect(evaluateDisposableWorkerBranch(disposableInput({ fetchFailed: true, prFetchFailed: true })).escalation).toBe('blocked_pr_unknown');
    expect(evaluateDisposableWorkerBranch(disposableInput({ fetchFailed: true, rateLimited: true, prFetchFailed: true, prRateLimited: true })).escalation).toBe(
      'blocked_rate_limit_pr_unknown',
    );
  });

  it('preserves on remote unknown and rate-limit remote unknown', () => {
    expect(
      evaluateDisposableWorkerBranch(
        disposableInput({ remoteFetchFailed: true, fetchFailed: false, prFetchFailed: false }),
      ).escalation,
    ).toBe('blocked_remote_unknown');
    expect(
      evaluateDisposableWorkerBranch(
        disposableInput({ remoteFetchFailed: true, remoteRateLimited: true, fetchFailed: false, prFetchFailed: false }),
      ).escalation,
    ).toBe('blocked_rate_limit_remote_unknown');
  });

  it('preserves reflog surviving work after reset-to-grant-start', () => {
    const grantStartOid = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const result = evaluateDisposableWorkerBranch(
      disposableInput({
        branchHeadOid: grantStartOid,
        reflogEntries: [{ newOid: 'cccccccccccccccccccccccccccccccccccccccc', oldOid: grantStartOid }],
      }),
    );
    expect(result.escalation).toBe('blocked_reflog_surviving_work');
  });

  it('classifies branch_preexists before spawn', () => {
    const disposable = evaluateBranchPreexistsClassification(disposableInput());
    expect(disposable.preexists).toBe(true);
    expect(disposable.action).toBe('delete');

    const preserved = evaluateBranchPreexistsClassification(disposableInput({ grant: null }));
    expect(preserved.reason).toBe('branch_preexists_preserved');
    expect(preserved.escalation).toBe('blocked_grant_absent');
  });

  it('maps issue view state to task eligibility flags', () => {
    expect(evaluateIssueTaskEligibility({ issueNumber: 0 })).toMatchObject({
      ok: true,
      taskClosed: false,
      taskCancelled: false,
      taskSuperseded: false,
      taskStateUnknown: false,
    });
    expect(evaluateIssueTaskEligibility({ issueNumber: 592, state: 'CLOSED', stateReason: 'COMPLETED' })).toMatchObject({
      ok: true,
      taskClosed: true,
      taskCancelled: false,
      taskSuperseded: false,
    });
    expect(evaluateIssueTaskEligibility({ issueNumber: 592, state: 'CLOSED', stateReason: 'NOT_PLANNED' })).toMatchObject({
      taskCancelled: true,
    });
    expect(evaluateIssueTaskEligibility({ issueNumber: 592, state: 'CLOSED', stateReason: 'DUPLICATE' })).toMatchObject({
      taskSuperseded: true,
    });
    expect(evaluateIssueTaskEligibility({ issueNumber: 592, fetchFailed: true }).reason).toBe(
      'blocked_task_state_unknown',
    );
  });

  it('final deletion revalidation blocks when open PR appears after initial observation', () => {
    const input = disposableInput();
    const initial = evaluateBranchDeletionRevalidation({
      ...input,
      expectedDeleteOid: input.branchHeadOid,
    });
    expect(initial.ok).toBe(true);
    const blocked = evaluateBranchDeletionRevalidation({
      ...input,
      openPrByHeadRefName: { 'feat/issue-592': 598 },
      observedAtUtc: new Date().toISOString(),
      expectedDeleteOid: input.branchHeadOid,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe('blocked_open_pr_present');
  });

  it('revalidation blocks OID race and worktree occupancy', () => {
    const base = disposableInput();
    const grantStartOid = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(
      evaluateBranchDeletionRevalidation({
        ...base,
        expectedDeleteOid: grantStartOid,
        branchHeadOid: 'dddddddddddddddddddddddddddddddddddddddd',
      }).reason,
    ).toBe('blocked_oid_race');
    expect(
      evaluateBranchDeletionRevalidation({
        ...base,
        worktreeRecords: [{ branch: 'refs/heads/feat/issue-592', worktree: '/tmp/other' }],
      }).reason,
    ).toBe('blocked_worktree_occupied');
  });

  it('recovery update-ref branch delete is allowed under claim-bound parent', () => {
    const oid = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const allowed = evaluateWorkerRecoveryBranchGitAllow({
      argv: ['update-ref', '-d', 'refs/heads/feat/issue-592', oid],
      recoveryParent: true,
      boundBranch: 'feat/issue-592',
      boundSessionId: 'opk-592',
      claimSessionId: 'opk-592',
    });
    expect(allowed.allowed).toBe(true);
  });

  it('recovery update-ref branch delete without OID is allowed under claim-bound parent', () => {
    const allowed = evaluateWorkerRecoveryBranchGitAllow({
      argv: ['update-ref', '-d', 'refs/heads/feat/issue-592'],
      recoveryParent: true,
      boundBranch: 'feat/issue-592',
      boundSessionId: 'opk-592',
      claimSessionId: 'opk-592',
    });
    expect(allowed.allowed).toBe(true);
  });

  it('recovery branch delete is allowed only under claim-bound parent', () => {
    const allowed = evaluateWorkerRecoveryBranchGitAllow({
      argv: ['branch', '-D', 'feat/issue-592'],
      recoveryParent: true,
      boundBranch: 'feat/issue-592',
      boundSessionId: 'opk-592',
      claimSessionId: 'opk-592',
    });
    expect(allowed.allowed).toBe(true);
    const denied = evaluateWorkerRecoveryBranchGitAllow({
      argv: ['branch', '-D', 'feat/issue-999'],
      recoveryParent: true,
      boundBranch: 'feat/issue-592',
      boundSessionId: 'opk-592',
      claimSessionId: 'opk-592',
    });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('branch_not_in_claim_set');
  });
});

describe('worker recovery branch cleanup integration (#592)', () => {
  it('FixtureMode recovery does not require live gh issue view', () => {
    setupSpawnWorktreeRepo(({ repo, baseRef }) => {
      const issueNumber = 592;
      const sessionId = 'opk-592';
      const branch = `feat/issue-${issueNumber}`;
      const worktreePath = path.join(repo, 'worktrees', sessionId);
      const grantStartOid = headOidSpawnWorktreeRepo(repo);
      gitIn(repo, ['branch', branch, baseRef]);
      const grant = buildConsumedGrant(issueNumber, repo, baseRef, sessionId, worktreePath);
      const ns = tempNs();
      const fakeGhDir = mkdtempSync(path.join(tmpdir(), 'worker-recovery-fake-gh-'));
      writeFileSync(path.join(fakeGhDir, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const script = `
        $ErrorActionPreference = 'Stop'
        . '${path.join(repoRoot, 'scripts/lib/Worker-Recovery.ps1').replace(/'/g, "''")}'
        $env:AO_WORKER_RECOVERY_DIR = ${psString(ns)}
        $env:AO_SPAWN_WORKTREE_STATE_ROOT = ${psString(path.join(ns, 'spawn-grants'))}
        $env:PATH = ${psString(fakeGhDir)} + ':' + $env:PATH
        ${grantPs(grant, sessionId, worktreePath, grantStartOid)}
        $result = Invoke-WorkerRecovery -Trigger 'operator_request' -SessionId ${psString(sessionId)} -CanonicalPath ${psString(worktreePath)} -PackRoot ${psString(repo)} -RepoRoot ${psString(repo)} -Session @{ runtime='exited'; status='terminated'; worktree=${psString(worktreePath)}; issue='${issueNumber}' } -WorktreeRecord @{ sessionId=${psString(sessionId)}; projectId='orchestrator-pack' } -WorktreePresent:$false -DryRun -SpawnAction 'spawn-new' -IssueNumber ${issueNumber} -FixtureMode -SpawnPolicy @{ allowSpawnNew=$true; allowClaimPrResume=$true } -FixtureGrantRecord $grant -FixtureBranchObservation @{ observedAtUtc=(Get-Date).ToUniversalTime().ToString('o'); openPrByHeadRefName=@{}; fetchFailed=$false; rateLimited=$false } -FixtureBranchState @{ ok=$true; exists=$true; branch=${psString(branch)}; branchHeadOid=${psString(grantStartOid)}; localAheadCount=0; remoteAheadCount=0; diverged=$false; reflogEntries=@(); danglingReachableCount=0 } -FixtureWorktreeRecords @()
        [pscustomobject]@{ spawn = [string]$result.spawn; branchReason = [string]$result.branch.reason; ok = [bool]$result.ok } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.spawn).toBe('spawn_started');
      expect(result.branchReason).toBe('branch_deleted');
      expect(result.ok).toBe(true);
      rmSync(fakeGhDir, { recursive: true, force: true });
    });
  });

  it('deletes orphan branch under recovery claim and routes respawn in dry-run', () => {
    setupSpawnWorktreeRepo(({ repo, baseRef }) => {
      const issueNumber = 592;
      const sessionId = 'opk-592';
      const branch = `feat/issue-${issueNumber}`;
      const worktreePath = path.join(repo, 'worktrees', sessionId);
      const grantStartOid = headOidSpawnWorktreeRepo(repo);
      gitIn(repo, ['branch', branch, baseRef]);
      const grant = buildConsumedGrant(issueNumber, repo, baseRef, sessionId, worktreePath);
      const ns = tempNs();
      const script = `
        $ErrorActionPreference = 'Stop'
        . '${path.join(repoRoot, 'scripts/lib/Worker-Recovery.ps1').replace(/'/g, "''")}'
        $env:AO_WORKER_RECOVERY_DIR = ${psString(ns)}
        $env:AO_SPAWN_WORKTREE_STATE_ROOT = ${psString(path.join(ns, 'spawn-grants'))}
        ${grantPs(grant, sessionId, worktreePath, grantStartOid)}
        $result = Invoke-WorkerRecovery -Trigger 'operator_request' -SessionId ${psString(sessionId)} -CanonicalPath ${psString(worktreePath)} -PackRoot ${psString(repo)} -RepoRoot ${psString(repo)} -Session @{ runtime='exited'; status='terminated'; worktree=${psString(worktreePath)}; issue='${issueNumber}' } -WorktreeRecord @{ sessionId=${psString(sessionId)}; projectId='orchestrator-pack' } -WorktreePresent:$false -DryRun -SpawnAction 'spawn-new' -IssueNumber ${issueNumber} -FixtureMode -SpawnPolicy @{ allowSpawnNew=$true; allowClaimPrResume=$true } -FixtureGrantRecord $grant -FixtureBranchObservation @{ observedAtUtc=(Get-Date).ToUniversalTime().ToString('o'); openPrByHeadRefName=@{}; fetchFailed=$false; rateLimited=$false } -FixtureBranchState @{ ok=$true; exists=$true; branch=${psString(branch)}; branchHeadOid=${psString(grantStartOid)}; localAheadCount=0; remoteAheadCount=0; diverged=$false; reflogEntries=@(); danglingReachableCount=0 } -FixtureWorktreeRecords @()
        [pscustomobject]@{ spawn = [string]$result.spawn; branchReason = [string]$result.branch.reason; outcome = [string]$result.outcome; ok = [bool]$result.ok; branchEsc = [string]$result.branch.escalation; branchSkipped = [bool]$result.branch.skipped } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.spawn).toBe('spawn_started');
      expect(result.branchReason).toBe('branch_deleted');
      expect(result.ok).toBe(true);
    });
  });

  it('preserves diverged branch with durable escalation and blocks respawn', () => {
    setupSpawnWorktreeRepo(({ repo, baseRef }) => {
      const issueNumber = 592;
      const sessionId = 'opk-592-preserve';
      const branch = `feat/issue-${issueNumber}`;
      const worktreePath = path.join(repo, 'worktrees', sessionId);
      const grantStartOid = headOidSpawnWorktreeRepo(repo);
      const grant = buildConsumedGrant(issueNumber, repo, baseRef, sessionId, worktreePath);
      const ns = tempNs();
      const script = `
        $ErrorActionPreference = 'Stop'
        . '${path.join(repoRoot, 'scripts/lib/Worker-Recovery.ps1').replace(/'/g, "''")}'
        $env:AO_WORKER_RECOVERY_DIR = ${psString(ns)}
        ${grantPs(grant, sessionId, worktreePath, grantStartOid)}
        $result = Invoke-WorkerRecovery -Trigger 'operator_request' -SessionId ${psString(sessionId)} -CanonicalPath ${psString(worktreePath)} -PackRoot ${psString(repo)} -RepoRoot ${psString(repo)} -Session @{ runtime='exited'; status='terminated'; worktree=${psString(worktreePath)} } -WorktreeRecord @{ sessionId=${psString(sessionId)}; projectId='orchestrator-pack' } -WorktreePresent:$false -DryRun -SpawnAction 'spawn-new' -IssueNumber ${issueNumber} -FixtureMode -SpawnPolicy @{ allowSpawnNew=$true; allowClaimPrResume=$true } -FixtureGrantRecord $grant -FixtureBranchObservation @{ observedAtUtc=(Get-Date).ToUniversalTime().ToString('o'); openPrByHeadRefName=@{}; fetchFailed=$false; rateLimited=$false } -FixtureBranchState @{ ok=$true; exists=$true; branch=${psString(branch)}; branchHeadOid=${psString(grantStartOid)}; localAheadCount=1; remoteAheadCount=0; diverged=$false; reflogEntries=@(); danglingReachableCount=0 } -FixtureWorktreeRecords @()
        [pscustomobject]@{ ok = [bool]$result.ok; outcome = [string]$result.outcome; escalation = [string]$result.branch.escalation; spawn = [string]$result.spawn } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.ok).toBe(false);
      expect(result.outcome).toBe('escalated');
      expect(result.escalation).toBe('blocked_local_only_commits');
      expect(result.spawn).toBe('not_attempted');
    });
  });

  it('crash-resume observes branch_deleted audit without duplicate deletion', () => {
    const ns = tempNs();
    const sessionId = 'opk-592-resume';
    const branch = 'feat/issue-592';
    const script = `
      . '${path.join(repoRoot, 'scripts/lib/Worker-RecoveryBranchCleanup.ps1').replace(/'/g, "''")}'
      $env:AO_WORKER_RECOVERY_DIR = ${psString(ns)}
      Initialize-WorkerRecoveryNamespace -Namespace ${psString(ns)}
      $audit = @{
        schemaVersion='worker-recovery-branch-cleanup/v1'; kind='branch_deleted'; attemptId='attempt-1'; sessionId=${psString(sessionId)}; branch=${psString(branch)}; deletedHeadOid='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; recordedAtUtc='2026-07-04T00:00:00.0000000Z'
      }
      Write-WorkerRecoveryAudit -Namespace ${psString(ns)} -Record $audit
      $resume = Get-WorkerRecoveryBranchDeletedAudit -Namespace ${psString(ns)} -SessionId ${psString(sessionId)} -Branch ${psString(branch)} -AttemptId 'attempt-1'
      [pscustomobject]@{ found = ($null -ne $resume); kind = [string]$resume.record.kind } | ConvertTo-Json -Compress
    `;
    const result = JSON.parse(runPwsh(script));
    expect(result.found).toBe(true);
    expect(result.kind).toBe('branch_deleted');
  });

  it('deletes local branch in git fixture when disposable', () => {
    withTempGitRepo((repo) => {
      const branch = 'feat/issue-592';
      const baseOid = execFileSync(git, ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      gitIn(repo, ['branch', branch]);
      expect(execFileSync(git, ['-C', repo, 'show-ref', branch], { encoding: 'utf8' }).trim()).toContain(branch);
      const ns = tempNs();
      const worktreePath = path.join(repo, 'worktrees', 'opk-592');
      const grant = buildConsumedGrant(592, repo, 'refs/heads/main', 'opk-592', worktreePath);
      const script = `
        $ErrorActionPreference = 'Stop'
        . '${path.join(repoRoot, 'scripts/lib/Worker-RecoveryBranchCleanup.ps1').replace(/'/g, "''")}'
        $env:AO_WORKER_RECOVERY_DIR = ${psString(ns)}
        ${grantPs(grant, 'opk-592', worktreePath, baseOid)}
        $result = Invoke-WorkerRecoveryBranchCleanup -SessionId 'opk-592' -CanonicalPath ${psString(worktreePath)} -RepoRoot ${psString(repo)} -Namespace ${psString(ns)} -AttemptId 'attempt-live' -FixtureMode -GrantRecord $grant -FixtureObservation @{ observedAtUtc=(Get-Date).ToUniversalTime().ToString('o'); openPrByHeadRefName=@{}; fetchFailed=$false; rateLimited=$false } -FixtureBranchState @{ ok=$true; exists=$true; branch=${psString(branch)}; branchHeadOid=${psString(baseOid)}; localAheadCount=0; remoteAheadCount=0; diverged=$false; reflogEntries=@(); danglingReachableCount=0 } -FixtureWorktreeRecords @() -IssueNumber 592
        [pscustomobject]@{ deleted = [bool]$result.deleted; reason = [string]$result.reason; escalation = [string]$result.escalation } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.deleted).toBe(true);
      expect(result.reason).toBe('branch_deleted');
      let branchStillExists = true;
      try {
        execFileSync(git, ['-C', repo, 'show-ref', branch], { stdio: 'pipe' });
      } catch {
        branchStillExists = false;
      }
      expect(branchStillExists).toBe(false);
    });
  });

  it('blocks deletion when branch OID advances after initial classification', () => {
    withTempGitRepo((repo) => {
      const branch = 'feat/issue-592';
      const baseOid = execFileSync(git, ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      gitIn(repo, ['branch', branch]);
      gitIn(repo, ['checkout', branch]);
      writeFileSync(path.join(repo, 'advance.txt'), 'advance\n', 'utf8');
      gitIn(repo, ['add', 'advance.txt']);
      gitIn(repo, ['commit', '-m', 'advance']);
      gitIn(repo, ['checkout', 'main']);
      const ns = tempNs();
      const worktreePath = path.join(repo, 'worktrees', 'opk-592');
      const grant = buildConsumedGrant(592, repo, 'refs/heads/main', 'opk-592', worktreePath);
      const script = `
        $ErrorActionPreference = 'Stop'
        . '${path.join(repoRoot, 'scripts/lib/Worker-RecoveryBranchCleanup.ps1').replace(/'/g, "''")}'
        $env:AO_WORKER_RECOVERY_DIR = ${psString(ns)}
        ${grantPs(grant, 'opk-592', worktreePath, baseOid)}
        $result = Invoke-WorkerRecoveryBranchCleanup -SessionId 'opk-592' -CanonicalPath ${psString(worktreePath)} -RepoRoot ${psString(repo)} -Namespace ${psString(ns)} -AttemptId 'attempt-oid-race' -FixtureMode -GrantRecord $grant -FixtureObservation @{ observedAtUtc=(Get-Date).ToUniversalTime().ToString('o'); openPrByHeadRefName=@{}; fetchFailed=$false; rateLimited=$false } -FixtureBranchState @{ ok=$true; exists=$true; branch=${psString(branch)}; branchHeadOid=${psString(baseOid)}; localAheadCount=0; remoteAheadCount=0; diverged=$false; reflogEntries=@(); danglingReachableCount=0 } -FixtureWorktreeRecords @() -IssueNumber 592
        [pscustomobject]@{ deleted = [bool]$result.deleted; reason = [string]$result.reason; escalation = [string]$result.escalation } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.deleted).toBe(false);
      expect(result.escalation).toBe('blocked_oid_race');
      expect(execFileSync(git, ['-C', repo, 'show-ref', branch], { encoding: 'utf8' }).trim()).toContain(branch);
    });
  });

  it('preserves branch when linked task is closed', () => {
    withTempGitRepo((repo) => {
      const branch = 'feat/issue-592';
      const baseOid = execFileSync(git, ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      gitIn(repo, ['branch', branch]);
      const ns = tempNs();
      const worktreePath = path.join(repo, 'worktrees', 'opk-592');
      const grant = buildConsumedGrant(592, repo, 'refs/heads/main', 'opk-592', worktreePath);
      const script = `
        $ErrorActionPreference = 'Stop'
        . '${path.join(repoRoot, 'scripts/lib/Worker-RecoveryBranchCleanup.ps1').replace(/'/g, "''")}'
        $env:AO_WORKER_RECOVERY_DIR = ${psString(ns)}
        ${grantPs(grant, 'opk-592', worktreePath, baseOid)}
        $result = Invoke-WorkerRecoveryBranchCleanup -SessionId 'opk-592' -CanonicalPath ${psString(worktreePath)} -RepoRoot ${psString(repo)} -Namespace ${psString(ns)} -AttemptId 'attempt-task-closed' -FixtureMode -GrantRecord $grant -FixtureObservation @{ observedAtUtc=(Get-Date).ToUniversalTime().ToString('o'); openPrByHeadRefName=@{}; fetchFailed=$false; rateLimited=$false } -FixtureBranchState @{ ok=$true; exists=$true; branch=${psString(branch)}; branchHeadOid=${psString(baseOid)}; localAheadCount=0; remoteAheadCount=0; diverged=$false; reflogEntries=@(); danglingReachableCount=0 } -FixtureWorktreeRecords @() -IssueNumber 592 -TaskClosed
        [pscustomobject]@{ deleted = [bool]$result.deleted; escalation = [string]$result.escalation; reason = [string]$result.reason } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.deleted).toBe(false);
      expect(result.escalation).toBe('blocked_task_ineligible');
      expect(execFileSync(git, ['-C', repo, 'show-ref', branch], { encoding: 'utf8' }).trim()).toContain(branch);
    });
  });

  it('blocks deletion when open PR appears after initial observation in fixture cleanup', () => {
    setupSpawnWorktreeRepo(({ repo, baseRef }) => {
      const branch = 'feat/issue-592';
      const baseOid = headOidSpawnWorktreeRepo(repo);
      gitIn(repo, ['branch', branch, baseRef]);
      const worktreePath = path.join(repo, 'worktrees', 'opk-592');
      const grant = buildConsumedGrant(592, repo, 'refs/heads/main', 'opk-592', worktreePath);
      const ns = tempNs();
      const now = new Date().toISOString();
      const script = `
        $ErrorActionPreference = 'Stop'
        . '${path.join(repoRoot, 'scripts/lib/Worker-RecoveryBranchCleanup.ps1').replace(/'/g, "''")}'
        $env:AO_WORKER_RECOVERY_DIR = ${psString(ns)}
        ${grantPs(grant, 'opk-592', worktreePath, baseOid)}
        $result = Invoke-WorkerRecoveryBranchCleanup -SessionId 'opk-592' -CanonicalPath ${psString(worktreePath)} -RepoRoot ${psString(repo)} -Namespace ${psString(ns)} -AttemptId 'attempt-pr-race' -FixtureMode -GrantRecord $grant -FixtureObservation @{ observedAtUtc='${now}'; openPrByHeadRefName=@{}; fetchFailed=$false; rateLimited=$false } -FixtureFinalObservation @{ observedAtUtc='${now}'; openPrByHeadRefName=@{ '${branch}' = 598 }; fetchFailed=$false; rateLimited=$false } -FixtureBranchState @{ ok=$true; exists=$true; branch=${psString(branch)}; branchHeadOid=${psString(baseOid)}; localAheadCount=0; remoteAheadCount=0; diverged=$false; reflogEntries=@(); danglingReachableCount=0 } -FixtureWorktreeRecords @() -IssueNumber 592
        [pscustomobject]@{ deleted = [bool]$result.deleted; escalation = [string]$result.escalation } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.deleted).toBe(false);
      expect(result.escalation).toBe('blocked_open_pr_present');
    });
  });

  it('blocks deletion when task becomes ineligible after initial observation in fixture cleanup', () => {
    setupSpawnWorktreeRepo(({ repo, baseRef }) => {
      const branch = 'feat/issue-592';
      const baseOid = headOidSpawnWorktreeRepo(repo);
      gitIn(repo, ['branch', branch, baseRef]);
      const worktreePath = path.join(repo, 'worktrees', 'opk-592');
      const grant = buildConsumedGrant(592, repo, 'refs/heads/main', 'opk-592', worktreePath);
      const ns = tempNs();
      const now = new Date().toISOString();
      const script = `
        $ErrorActionPreference = 'Stop'
        . '${path.join(repoRoot, 'scripts/lib/Worker-RecoveryBranchCleanup.ps1').replace(/'/g, "''")}'
        $env:AO_WORKER_RECOVERY_DIR = ${psString(ns)}
        ${grantPs(grant, 'opk-592', worktreePath, baseOid)}
        $result = Invoke-WorkerRecoveryBranchCleanup -SessionId 'opk-592' -CanonicalPath ${psString(worktreePath)} -RepoRoot ${psString(repo)} -Namespace ${psString(ns)} -AttemptId 'attempt-task-race' -FixtureMode -GrantRecord $grant -FixtureObservation @{ observedAtUtc='${now}'; openPrByHeadRefName=@{}; fetchFailed=$false; rateLimited=$false } -FixtureFinalTaskEligibility @{ taskClosed=$true; taskCancelled=$false; taskSuperseded=$false; taskStateUnknown=$false; reason='task_closed' } -FixtureBranchState @{ ok=$true; exists=$true; branch=${psString(branch)}; branchHeadOid=${psString(baseOid)}; localAheadCount=0; remoteAheadCount=0; diverged=$false; reflogEntries=@(); danglingReachableCount=0 } -FixtureWorktreeRecords @() -IssueNumber 592
        [pscustomobject]@{ deleted = [bool]$result.deleted; escalation = [string]$result.escalation } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.deleted).toBe(false);
      expect(result.escalation).toBe('blocked_task_ineligible');
    });
  });

  it('blocks deletion when branch is checked out in a new worktree after initial snapshot', () => {
    withTempGitRepo((repo) => {
      const branch = 'feat/issue-592';
      const baseOid = execFileSync(git, ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      gitIn(repo, ['branch', branch]);
      const otherWorktree = path.join(repo, 'worktrees', 'opk-other');
      execFileSync('mkdir', ['-p', path.dirname(otherWorktree)]);
      gitIn(repo, ['worktree', 'add', otherWorktree, branch]);
      const ns = tempNs();
      const worktreePath = path.join(repo, 'worktrees', 'opk-592');
      const grant = buildConsumedGrant(592, repo, 'refs/heads/main', 'opk-592', worktreePath);
      const script = `
        $ErrorActionPreference = 'Stop'
        . '${path.join(repoRoot, 'scripts/lib/Worker-RecoveryBranchCleanup.ps1').replace(/'/g, "''")}'
        $env:AO_WORKER_RECOVERY_DIR = ${psString(ns)}
        ${grantPs(grant, 'opk-592', worktreePath, baseOid)}
        $result = Invoke-WorkerRecoveryBranchCleanup -SessionId 'opk-592' -CanonicalPath ${psString(worktreePath)} -RepoRoot ${psString(repo)} -Namespace ${psString(ns)} -AttemptId 'attempt-worktree-race' -FixtureMode -GrantRecord $grant -FixtureObservation @{ observedAtUtc=(Get-Date).ToUniversalTime().ToString('o'); openPrByHeadRefName=@{}; fetchFailed=$false; rateLimited=$false } -FixtureBranchState @{ ok=$true; exists=$true; branch=${psString(branch)}; branchHeadOid=${psString(baseOid)}; localAheadCount=0; remoteAheadCount=0; diverged=$false; reflogEntries=@(); danglingReachableCount=0 } -FixtureWorktreeRecords @() -IssueNumber 592
        [pscustomobject]@{ deleted = [bool]$result.deleted; escalation = [string]$result.escalation; reason = [string]$result.reason } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.deleted).toBe(false);
      expect(result.escalation).toBe('blocked_worktree_occupied');
      expect(execFileSync(git, ['-C', repo, 'show-ref', branch], { encoding: 'utf8' }).trim()).toContain(branch);
    });
  });

  it('boundary wiring denies raw branch -D outside recovery parent', () => {
    const boundaryText = readFileSync(
      path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousBoundary.ps1'),
      'utf8',
    );
    expect(boundaryText).toMatch(/Test-GitArgvIsBranchDeleteForce/);
    expect(boundaryText).toMatch(/Test-GitArgvIsUpdateRefBranchDeleteForce/);
    expect(boundaryText).toMatch(/recovery_branch_delete_allow/);
    const gateText = readFileSync(
      path.join(repoRoot, 'scripts/lib/Autonomous-WorkerRecoveryGate.ps1'),
      'utf8',
    );
    expect(gateText).toMatch(/Test-AutonomousWorkerRecoveryBranchGitAllow/);
  });
});
