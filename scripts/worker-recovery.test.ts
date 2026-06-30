import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';
import {
  WORKER_RECOVERY_VERSION,
  canonicalizeRecoveryPath,
  classifyWorkerSessionLiveness,
  deriveRecoveryClaimKey,
  evaluateArtifactPreservation,
  evaluateBoundedRetry,
  evaluateCleanupEligibility,
  evaluateOwnershipEvidence,
  evaluatePostClaimRevalidation,
  evaluateRecoverySpawnRoute,
  evaluateSpawnFreshness,
  evaluateTriggerAdmission,
  evaluateWorkerRecoveryGitAllow,
  parseWorktreeListPorcelain,
  parseWorktreeRemoveForceArgv,
} from '../docs/worker-recovery.mjs';

const tempRoots: string[] = [];

function tempNs() {
  const dir = mkdtempSync(path.join(tmpdir(), 'worker-recovery-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('worker recovery liveness discrimination', () => {
  const aoBase = '/home/test/.agent-orchestrator';
  const worktree = `${aoBase}/projects/orchestrator-pack/worktrees/opk-dead`;

  it('worker recovery liveness discrimination: dangling gitdir with ownership cleans up only', () => {
    const result = evaluateCleanupEligibility({
      projectId: 'orchestrator-pack',
      canonicalPath: worktree,
      sessionId: 'opk-dead',
      session: null,
      worktreeRecord: { sessionId: 'opk-dead', projectId: 'orchestrator-pack' },
      aoBaseDir: aoBase,
      danglingGitdir: true,
      worktreePresent: false,
      dirtyState: {},
    });
    expect(result.eligible).toBe(true);
    expect(result.outcome).toBe('removed_dangling_gitdir');
  });

  it('worker recovery liveness discrimination: missing ownership skips destructive action', () => {
    const result = evaluateCleanupEligibility({
      projectId: 'orchestrator-pack',
      canonicalPath: '/tmp/foreign/wt',
      sessionId: '',
      session: null,
      worktreeRecord: null,
      aoBaseDir: aoBase,
      danglingGitdir: true,
      worktreePresent: false,
    });
    expect(result.eligible).toBe(false);
    expect(result.outcome).toBe('skipped_ambiguous');
  });

  it('worker recovery liveness discrimination: terminated runtime with ownership is eligible', () => {
    const result = evaluateCleanupEligibility({
      projectId: 'orchestrator-pack',
      canonicalPath: worktree,
      sessionId: 'opk-dead',
      session: { runtime: 'exited', worktree, status: 'terminated' },
      worktreeRecord: { sessionId: 'opk-dead' },
      aoBaseDir: aoBase,
      worktreePresent: true,
      dirtyState: {},
    });
    expect(result.eligible).toBe(true);
    expect(result.outcome).toBe('removed_terminated_session');
  });

  it('worker recovery liveness discrimination: live session blocks force remove', () => {
    const result = evaluateCleanupEligibility({
      projectId: 'orchestrator-pack',
      canonicalPath: worktree,
      sessionId: 'opk-live',
      session: { runtime: 'alive', worktree, status: 'working' },
      worktreeRecord: { sessionId: 'opk-live' },
      aoBaseDir: aoBase,
      worktreePresent: true,
    });
    expect(result.eligible).toBe(false);
    expect(result.outcome).toBe('skipped_live');
  });

  it('worker recovery liveness discrimination: present non-live runtime fails closed', () => {
    expect(classifyWorkerSessionLiveness({ runtime: 'unknown' }).verdict).toBe('ambiguous');
    const result = evaluateCleanupEligibility({
      projectId: 'orchestrator-pack',
      canonicalPath: worktree,
      sessionId: 'opk-ambig',
      session: { runtime: 'unknown', worktree },
      worktreeRecord: { sessionId: 'opk-ambig' },
      aoBaseDir: aoBase,
      worktreePresent: true,
    });
    expect(result.eligible).toBe(false);
    expect(result.outcome).toBe('skipped_ambiguous');
  });
});

describe('worker recovery claim lifecycle', () => {
  it('worker recovery claim lifecycle: concurrent recovery is single-winner', () => {
    const ns = tempNs();
    const claimKey = 'worker-opk-522';
    const canonical = '/tmp/orchestrator-pack/worktrees/opk-522';
    const script = `
      . '${path.join(repoRoot, 'scripts/lib/Worker-RecoveryClaim.ps1').replace(/'/g, "''")}'
      $env:AO_WORKER_RECOVERY_DIR = ${psString(ns)}
      $first = Acquire-WorkerRecoveryClaim -ClaimKey ${psString(claimKey)} -Surface 'test' -CanonicalPath ${psString(canonical)} -BoundCandidates @(${psString(canonical)})
      $second = Acquire-WorkerRecoveryClaim -ClaimKey ${psString(claimKey)} -Surface 'test' -CanonicalPath ${psString(canonical)} -BoundCandidates @(${psString(canonical)})
      [pscustomobject]@{ firstAcquired = [bool]$first.acquired; secondAcquired = [bool]$second.acquired; secondReason = [string]$second.reason } | ConvertTo-Json -Compress
    `;
    const result = JSON.parse(runPwsh(script));
    expect(result.firstAcquired).toBe(true);
    expect(result.secondAcquired).toBe(false);
    expect(result.secondReason).toBe('claim_exists');
  });

  it('worker recovery claim lifecycle: re-run after partial failure observes shared audit namespace', () => {
    const ns = tempNs();
    const script = `
      . '${path.join(repoRoot, 'scripts/lib/Worker-RecoveryClaim.ps1').replace(/'/g, "''")}'
      $env:AO_WORKER_RECOVERY_DIR = ${psString(ns)}
      Initialize-WorkerRecoveryNamespace -Namespace ${psString(ns)}
      Write-WorkerRecoveryAudit -Namespace ${psString(ns)} -Record @{ schemaVersion='worker-recovery/v1'; finalState='partial_failure'; attemptId='a1' }
      $audit = @(Get-ChildItem -LiteralPath (Get-WorkerRecoveryAuditDir -Namespace ${psString(ns)}) -Filter '*.json')
      [pscustomobject]@{ auditCount = $audit.Count } | ConvertTo-Json -Compress
    `;
    const result = JSON.parse(runPwsh(script));
    expect(result.auditCount).toBe(1);
  });

  it('worker recovery claim lifecycle: claim phase update overwrites active claim under Stop', () => {
    const ns = tempNs();
    const claimKey = 'worker-opk-phase';
    const canonical = '/tmp/orchestrator-pack/worktrees/opk-phase';
    const script = `
      $ErrorActionPreference = 'Stop'
      . '${path.join(repoRoot, 'scripts/lib/Worker-RecoveryClaim.ps1').replace(/'/g, "''")}'
      $env:AO_WORKER_RECOVERY_DIR = ${psString(ns)}
      $claim = Acquire-WorkerRecoveryClaim -ClaimKey ${psString(claimKey)} -Surface 'test' -CanonicalPath ${psString(canonical)} -BoundCandidates @(${psString(canonical)})
      if (-not $claim.acquired) { throw 'expected claim acquisition' }
      $updated = Update-WorkerRecoveryClaimPhase -Path $claim.path -Record $claim.record -Phase 'cleanup_pending'
      $read = Read-WorkerRecoveryClaimRecord -Path $claim.path
      [pscustomobject]@{ phase = [string]$updated.phase; persistedPhase = [string]$read.record.phase } | ConvertTo-Json -Compress
    `;
    const result = JSON.parse(runPwsh(script));
    expect(result.phase).toBe('cleanup_pending');
    expect(result.persistedPhase).toBe('cleanup_pending');
  });

  it('worker recovery claim lifecycle: uses PS 5.1-compatible claim overwrite without File.Move(source, dest, overwrite)', () => {
    const claimText = readFileSync(
      path.join(repoRoot, 'scripts/lib/Worker-RecoveryClaim.ps1'),
      'utf8',
    );
    expect(claimText).not.toMatch(/File\]::Move\(\$tmp, \$Path, \$/);
    expect(claimText).toMatch(/AllowOverwrite[\s\S]*Move-Item -LiteralPath \$tmp -Destination \$Path -Force/);
  });

  it('worker recovery claim lifecycle: mutex acquisition is exclusive mkdir without -Force', () => {
    const claimText = readFileSync(
      path.join(repoRoot, 'scripts/lib/Worker-RecoveryClaim.ps1'),
      'utf8',
    );
    const mutexBody = claimText.match(/function Enter-WorkerRecoveryMutex \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(mutexBody).toMatch(/New-Item -ItemType Directory -Path \$LockDir -ErrorAction Stop/);
    expect(mutexBody).not.toMatch(/-Force/);
  });

  it('worker recovery claim lifecycle: recovers stale active claim before claim_exists', () => {
    const ns = tempNs();
    const claimKey = 'worker-opk-stale';
    const canonical = '/tmp/orchestrator-pack/worktrees/opk-stale';
    const script = `
      . '${path.join(repoRoot, 'scripts/lib/Worker-RecoveryClaim.ps1').replace(/'/g, "''")}'
      $env:AO_WORKER_RECOVERY_DIR = ${psString(ns)}
      Initialize-WorkerRecoveryNamespace -Namespace ${psString(ns)}
      $path = Get-WorkerRecoveryClaimPath -Namespace ${psString(ns)} -ClaimKey ${psString(claimKey)}
      $stale = @{
        schemaVersion='worker-recovery/v1'; claimKey=${psString(claimKey)}; surface='dead'; holder=@{ pid=999999999; host='stale'; processGuid='dead' }
        acquiredAtUtc='2000-01-01T00:00:00.0000000Z'; canonicalPath=${psString(canonical)}; sessionId='opk-stale'; boundCandidates=@(${psString(canonical)})
        intent='recovery'; phase='claimed'; attemptId='stale1'
      }
      Write-WorkerRecoveryAtomic -Path $path -Record $stale
      $next = Acquire-WorkerRecoveryClaim -ClaimKey ${psString(claimKey)} -Surface 'test' -CanonicalPath ${psString(canonical)} -SessionId 'opk-stale' -BoundCandidates @(${psString(canonical)})
      [pscustomobject]@{ acquired = [bool]$next.acquired; reason = [string]$next.reason } | ConvertTo-Json -Compress
    `;
    const result = JSON.parse(runPwsh(script));
    expect(result.acquired).toBe(true);
    expect(result.reason).toBe('claim_acquired');
  });
});

describe('worker recovery post-claim revalidation', () => {
  it('worker recovery post-claim revalidation: blocks when liveness changes to live', () => {
    const worktree = '/tmp/orchestrator-pack/worktrees/opk-522';
    const result = evaluatePostClaimRevalidation({
      selection: {
        canonicalPath: worktree,
        sessionId: 'opk-522',
        session: { runtime: 'exited', worktree },
      },
      current: {
        canonicalPath: worktree,
        sessionId: 'opk-522',
        session: { runtime: 'alive', worktree },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('became_live');
  });

  it('worker recovery post-claim revalidation: Invoke-WorkerRecovery reads fresh AO snapshot', () => {
    const recoveryText = readFileSync(
      path.join(repoRoot, 'scripts/lib/Worker-Recovery.ps1'),
      'utf8',
    );
    expect(recoveryText).toMatch(/Get-WorkerRecoveryPostClaimSnapshot/);
    expect(recoveryText).toMatch(/selectionSnapshot/);
    expect(recoveryText).not.toMatch(/current\s*=\s*@\{[\s\S]*session\s*=\s*\$Session[\s\S]*\}[\s\S]*selection\s*=\s*@\{[\s\S]*session\s*=\s*\$Session/);
  });
});

describe('worker recovery cleanup failure', () => {
  it('worker recovery cleanup failure: non-zero git remove yields partial_failure and ok=false', () => {
    const packRoot = repoRoot;
    const ns = tempNs();
    const sessionId = `opk-cleanup-fail-${Date.now()}`;
    const bogusPath = path.join(packRoot, 'worktrees', 'opk-nonexistent-cleanup-fail');
    const script = `
      . '${path.join(repoRoot, 'scripts/lib/Worker-Recovery.ps1').replace(/'/g, "''")}'
      $env:AO_WORKER_RECOVERY_DIR = ${psString(ns)}
      $result = Invoke-WorkerRecovery -Trigger 'operator_request' -SessionId ${psString(sessionId)} -CanonicalPath ${psString(bogusPath.replace(/\\/g, '/'))} -PackRoot ${psString(packRoot)} -RepoRoot ${psString(packRoot)} -Session @{ runtime='exited'; status='terminated'; worktree=${psString(bogusPath.replace(/\\/g, '/'))} } -WorktreePresent -SkipSpawn -FixtureMode
      [pscustomobject]@{ ok = [bool]$result.ok; outcome = [string]$result.outcome; cleanup = [bool]$result.cleanup } | ConvertTo-Json -Compress
    `;
    const result = JSON.parse(runPwsh(script));
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('partial_failure');
    expect(result.cleanup).toBe(false);
  });
});

describe('worker recovery artifact preservation', () => {
  it('worker recovery artifact preservation: dirty tree blocks blind removal', () => {
    const blocked = evaluateArtifactPreservation({
      dirtyState: { trackedModifications: true, untrackedFiles: false },
    });
    expect(blocked.blocked).toBe(true);
    const eligibility = evaluateCleanupEligibility({
      projectId: 'orchestrator-pack',
      canonicalPath: '/tmp/orchestrator-pack/worktrees/opk-dirty',
      sessionId: 'opk-dirty',
      session: { runtime: 'exited', worktree: '/tmp/orchestrator-pack/worktrees/opk-dirty' },
      aoBaseDir: '/home/test/.agent-orchestrator',
      worktreePresent: true,
      dirtyState: { trackedModifications: true },
    });
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.outcome).toBe('blocked_dirty_worktree');
  });

  it('worker recovery artifact preservation: relevant ignored artifacts block blind removal', () => {
    const blocked = evaluateArtifactPreservation({
      dirtyState: { trackedModifications: false, untrackedFiles: false, relevantIgnored: true },
    });
    expect(blocked.blocked).toBe(true);
    const recoveryText = readFileSync(
      path.join(repoRoot, 'scripts/lib/Worker-Recovery.ps1'),
      'utf8',
    );
    expect(recoveryText).toMatch(/git status --ignored --porcelain/);
    expect(recoveryText).toMatch(/\^!!/);
  });
});

describe('worker recovery spawn freshness', () => {
  it('worker recovery spawn freshness: local terminated owner allowed when REST unavailable', () => {
    const result = evaluateSpawnFreshness({
      localSession: { runtime: 'exited', status: 'terminated' },
      recoveryClaimSessionId: 'opk-dead',
      restUnavailable: true,
    });
    expect(result.allowed).toBe(true);
  });

  it('worker recovery spawn freshness: REST closed conflicts with local live mapping', () => {
    const result = evaluateSpawnFreshness({
      localSession: { runtime: 'alive', status: 'working' },
      restClosedMerged: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.escalate).toBe(true);
  });
});

describe('worker recovery bounded retries', () => {
  it('worker recovery bounded retries: exhausts budget then escalates', () => {
    const retry = evaluateBoundedRetry({ attempt: 3, budget: 3, nowMs: 10_000, lastAttemptMs: 0 });
    expect(retry.shouldRetry).toBe(false);
    expect(retry.escalate).toBe(true);
  });

  it('worker recovery bounded retries: Invoke-WorkerRecovery applies evaluateRetry before cleanup', () => {
    const recoveryText = readFileSync(
      path.join(repoRoot, 'scripts/lib/Worker-Recovery.ps1'),
      'utf8',
    );
    expect(recoveryText).toMatch(/Get-WorkerRecoveryRetryAttemptState/);
    expect(recoveryText).toMatch(/evaluateRetry/);
  });
});

describe('worker recovery trigger admission', () => {
  it('worker recovery trigger admission: plain stuck is not enough', () => {
    expect(evaluateTriggerAdmission({ trigger: 'stuck' }).admitted).toBe(false);
    expect(evaluateTriggerAdmission({ trigger: 'operator_request' }).admitted).toBe(true);
    expect(evaluateTriggerAdmission({ trigger: 'reconcile_dead_worker', probedDeadEvidence: true }).admitted).toBe(true);
  });
});

describe('worker recovery git allow binding', () => {
  it('sanctioned worker recovery parent: candidate path must match claim set', () => {
    const target = '/tmp/orchestrator-pack/worktrees/opk-522';
    const allowed = evaluateWorkerRecoveryGitAllow({
      argv: ['worktree', 'remove', '--force', target],
      recoveryParent: true,
      boundCandidates: [target],
    });
    expect(allowed.allowed).toBe(true);
    const denied = evaluateWorkerRecoveryGitAllow({
      argv: ['worktree', 'remove', '--force', '/tmp/other'],
      recoveryParent: true,
      boundCandidates: [target],
    });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('target_not_in_claim_set');
  });
});

describe('worker recovery repository identity / pack-root spawn path (#522 AC#12)', () => {
  it('worker recovery spawn routes from pack root without repository_root_mismatch', () => {
    const packRoot = repoRoot;
    const worktreePath = path.join(packRoot, 'worktrees', 'opk-522');
    const script = `
      . '${path.join(repoRoot, 'scripts/lib/Worker-Recovery.ps1').replace(/'/g, "''")}'
      $result = Invoke-WorkerRecovery -Trigger 'operator_request' -SessionId 'opk-522' -CanonicalPath ${psString('__WT__')} -PackRoot ${psString(packRoot)} -RepoRoot ${psString(packRoot)} -Session @{ runtime='exited'; status='terminated'; worktree=${psString('__WT__')} } -WorktreePresent -DryRun -SpawnAction 'spawn-new' -IssueNumber 522 -FixtureMode -SpawnPolicy @{ allowSpawnNew=$true; allowClaimPrResume=$true }
      [pscustomobject]@{ packRootMatch = ($result.packRoot -eq $result.repoRoot); outcome = $result.outcome; spawn = [string]$result.spawn } | ConvertTo-Json -Compress
    `.replace(/__WT__/g, worktreePath.replace(/\\/g, '/'));
    const result = JSON.parse(runPwsh(script));
    expect(result.packRootMatch).toBe(true);
    expect(result.spawn).toBe('spawn_started');
  });

  it('worker recovery spawn invokes ao through Invoke-WorkerRecoverySpawn', () => {
    const recoveryText = readFileSync(
      path.join(repoRoot, 'scripts/lib/Worker-Recovery.ps1'),
      'utf8',
    );
    expect(recoveryText).toMatch(/function Invoke-WorkerRecoverySpawn/);
    expect(recoveryText).toMatch(/Test-AutonomousSpawnDenied/);
    expect(recoveryText).toMatch(/& ao @argv/);
    expect(recoveryText).toMatch(/grantDenied\s*=\s*\[bool\]\$spawnGate\.denied/);
  });
});

describe('worker recovery positive outcome (#522)', () => {
  it('policy-allowed recovery of terminated worker removes only proved-dead worktree in dry-run', () => {
    expect(WORKER_RECOVERY_VERSION).toBe('worker-recovery/v1');
    const route = evaluateRecoverySpawnRoute({
      policyLoadOk: true,
      policy: { allowSpawnNew: true, allowClaimPrResume: true },
      spawnAction: 'spawn-new',
    });
    expect(route.allowed).toBe(true);
    const parsed = parseWorktreeRemoveForceArgv(['worktree', 'remove', '--force', '/tmp/wt']);
    expect(parsed.ok).toBe(true);
    expect(deriveRecoveryClaimKey('opk-1', '')).toBe('worker-opk-1');
  });
});

describe('worker recovery path canonicalization', () => {
  it('worker recovery path canonicalization: resolves symlink variants', () => {
    const base = tempNs();
    const realDir = path.join(base, 'real wt');
    const linkDir = path.join(base, 'link wt');
    mkdirSync(realDir, { recursive: true });
    try {
      spawnSync('ln', ['-s', realDir, linkDir]);
    } catch {
      // symlink may be unavailable; still test resolve path
    }
    const realCanon = canonicalizeRecoveryPath(realDir);
    const linkCanon = existsSync(linkDir) ? canonicalizeRecoveryPath(linkDir) : realCanon;
    expect(realCanon.ok).toBe(true);
    if (linkCanon.ok && existsSync(linkDir)) {
      expect(linkCanon.canonical).toBe(realCanon.canonical);
    }
  });
});

describe('worker recovery shared entrypoint namespace (#522 AC#19)', () => {
  it('two entrypoints share machine-local namespace outside denylisted dirs', () => {
    const ns = tempNs();
    expect(ns.includes('.ao/')).toBe(false);
    expect(ns.includes('node_modules')).toBe(false);
    const script = `
      . '${path.join(repoRoot, 'scripts/lib/Worker-RecoveryClaim.ps1').replace(/'/g, "''")}'
      $env:AO_WORKER_RECOVERY_DIR = ${psString(ns)}
      $ns1 = Resolve-WorkerRecoveryNamespace -ProjectId 'orchestrator-pack'
      $ns2 = Resolve-WorkerRecoveryNamespace -ProjectId 'orchestrator-pack'
      $deny = @('.ao','node_modules','vendor','packages/core')
      $outside = -not ($deny | Where-Object { $ns1 -match [regex]::Escape($_) })
      [pscustomobject]@{ same = ($ns1 -eq $ns2); outsideDenylist = [bool]$outside } | ConvertTo-Json -Compress
    `;
    const result = JSON.parse(runPwsh(script));
    expect(result.same).toBe(true);
    expect(result.outsideDenylist).toBe(true);
  });
});

describe('worker recovery worktree list parsing', () => {
  it('parses porcelain worktree list records', () => {
    const records = parseWorktreeListPorcelain('worktree /tmp/wt\nHEAD abc\nbranch refs/heads/main\n\n');
    expect(records).toHaveLength(1);
    expect(records[0]?.worktree).toBe('/tmp/wt');
  });
});
