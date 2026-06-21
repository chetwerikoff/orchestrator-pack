import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';
import {
  ATOMIC_WORKER_NUDGE_CLAIM_CAPABILITY,
  WORKER_NUDGE_GATE_VERSION,
  acquireClaim,
  buildAuditRecord,
  buildTupleKey,
  canonicalStoreId,
  canonicalizeStorePath,
  classifyIntent,
  deriveCycleKey,
  evaluateAdoptionGate,
  evaluateBoundary,
  evaluateNudgeGate,
  evaluatePreflight,
  finalizeClaim,
  findForbiddenAutonomousWorkerSendInvocations,
  remapLegacy332Record,
  resolveWorkerTargetFromPrClaim,
  syncPrOwnershipClaimRecord,
} from '../docs/worker-nudge-gate.mjs';

const helperPath = path.join(repoRoot, 'scripts/lib/Worker-NudgeClaim.ps1');
const invokePath = path.join(repoRoot, 'scripts/invoke-gated-worker-nudge.ps1');
const fixturesDir = path.join(repoRoot, 'tests/fixtures/worker-nudge-gate');
const headSha = 'ef6e1c7000000000000000000000000000000000';
const headSha2 = 'a25b5c1000000000000000000000000000000000';

function tempClaimDir() {
  return mkdtempSync(path.join(tmpdir(), 'worker-nudge-claim-'));
}

describe('worker nudge gate (#384)', () => {
  it('exports stable gate capability markers', () => {
    expect(WORKER_NUDGE_GATE_VERSION).toBe('worker-nudge-gate/v1');
    expect(ATOMIC_WORKER_NUDGE_CLAIM_CAPABILITY).toBe('worker-nudge-claim-atomic/v1');
  });

  it('classifies incident surfaces into review-findings', () => {
    for (const surface of ['waiting_worker_review_response', 'merge.ready', 'review-trigger']) {
      const intent = classifyIntent({
        surface,
        message: 'Please check ao review list and report addressing_reviews when done.',
      });
      expect(intent).toBe('review-findings');
    }
  });

  it('maps unknown phrasing to unknown-worker-nudge', () => {
    expect(classifyIntent({ message: '???', source: 'orchestrator-turn' })).toBe(
      'unknown-worker-nudge',
    );
  });

  it('derives same cycle keys for review-findings from two callers', () => {
    const input = { prNumber: 380, reviewRunId: 'opk-rev-689', runId: 'opk-rev-689' };
    const a = deriveCycleKey('review-findings', input);
    const b = deriveCycleKey(classifyIntent({ source: 'review-send', ...input }), input);
    expect(a).toBe('run:opk-rev-689');
    expect(b).toBe(a);
  });

  it('canonicalizes WSL and Windows store path strings to one id', () => {
    const wsl = '/mnt/c/Users/me/.agent-orchestrator/projects/orchestrator-pack/state.json';
    const win = 'C:\\Users\\me\\.agent-orchestrator\\projects\\orchestrator-pack\\state.json';
    expect(canonicalizeStorePath(wsl)).toBe(canonicalizeStorePath(win));
    expect(canonicalStoreId(wsl)).toBe(canonicalStoreId(win));
  });

  it('script-recorded tuple suppresses LLM-turn nudge for same tuple', () => {
    const tuple = buildTupleKey({
      prNumber: 380,
      sessionId: 'opk-1',
      reviewRunId: 'opk-rev-689',
      headSha,
    });
    expect(tuple.ok).toBe(true);
    const gate = evaluateNudgeGate({
      prNumber: 380,
      sessionId: 'opk-1',
      reviewRunId: 'opk-rev-689',
      headSha,
      surface: 'orchestrator-turn',
      source: 'orchestrator-turn',
      storePath: '/tmp/gate-state',
      claims: [
        {
          tupleKey: tuple.tupleKey,
          phase: 'SENT',
          intentClass: 'review-findings',
        },
      ],
    });
    expect(gate.allow).toBe(false);
    expect(gate.reason).toBe('already_served');
  });

  it('does not suppress distinct intent-class in same cycle', () => {
    const findings = buildTupleKey({
      prNumber: 380,
      sessionId: 'opk-1',
      reviewRunId: 'opk-rev-689',
      headSha,
    });
    const handoff = buildTupleKey({
      prNumber: 380,
      sessionId: 'opk-1',
      transitionId: `${380}:${headSha2}:1`,
      headSha: headSha2,
      source: 'pack-send',
    });
    const gate = evaluateNudgeGate({
      prNumber: 380,
      sessionId: 'opk-1',
      transitionId: `${380}:${headSha2}:1`,
      headSha: headSha2,
      source: 'pack-send',
      surface: 'orchestrator-turn',
      storePath: '/tmp/gate-state',
      claims: [{ tupleKey: findings.tupleKey, phase: 'SENT', intentClass: 'review-findings' }],
    });
    expect(gate.allow).toBe(true);
    expect(handoff.intentClass).toBe('ci-green-handoff');
  });

  it('reverse symmetry: LLM-recorded tuple suppresses script path', () => {
    const tuple = buildTupleKey({
      prNumber: 42,
      sessionId: 'opk-worker',
      transitionId: '42:abc:1',
      source: 'pack-send',
    });
    const gate = evaluateNudgeGate({
      prNumber: 42,
      sessionId: 'opk-worker',
      transitionId: '42:abc:1',
      source: 'pack-send',
      surface: 'ci-green-wake-reconcile',
      storePath: '/tmp/gate-state',
      claims: [{ tupleKey: tuple.tupleKey, phase: 'SENT', intentClass: 'ci-green-handoff' }],
    });
    expect(gate.allow).toBe(false);
  });

  it('verifiable legacy #332 record suppresses equivalent nudge; unverifiable does not', () => {
    const verifiable = remapLegacy332Record({
      transitionId: '42:abc:1',
      sessionId: 'opk-1',
      targetGeneration: 'gen1',
      sentAtMs: 1,
    });
    expect(verifiable.suppresses).toBe(true);
    const unverifiable = remapLegacy332Record({ transitionId: '42:abc:1', sentAtMs: 1 });
    expect(unverifiable.suppresses).toBe(false);
  });

  it('FAILED_DEFINITIVE finalize is retryable; UNCERTAIN is not', () => {
    expect(finalizeClaim({ phase: 'FAILED_DEFINITIVE' }).retryable).toBe(true);
    expect(finalizeClaim({ phase: 'UNCERTAIN' }).retryable).toBe(false);
    expect(finalizeClaim({ phase: 'UNCERTAIN' }).escalate).toBe(true);
  });

  it('fail-closed when state is unreadable', () => {
    const gate = evaluateNudgeGate({
      prNumber: 1,
      sessionId: 'opk-1',
      reviewRunId: 'run-1',
      headSha,
      stateUnreadable: true,
      unresolvedCount: 2,
      nowMs: Date.now(),
      storePath: '/tmp/gate',
    });
    expect(gate.allow).toBe(false);
    expect(gate.failClosed).toBe(true);
  });

  it('structured audit requires binding fields', () => {
    const complete = buildAuditRecord({
      prNumber: 1,
      logicalWorkerId: 'opk-1',
      sessionGeneration: 'gen1',
      rawSessionId: 'opk-1',
      targetResolutionSource: 'session',
      surface: 'orchestrator-turn',
      cycleKey: 'run:abc',
      intentClass: 'review-findings',
      storeId: 'abc',
      decision: 'SUPPRESS',
      reason: 'already_served',
      claimPhase: 'SENT',
      sendTarget: 'opk-1',
    });
    expect(complete.auditIncomplete).toBeUndefined();
    const incomplete = buildAuditRecord({ prNumber: 1 });
    expect(incomplete.auditIncomplete).toBe(true);
  });

  it('denies raw worker send at autonomous boundary', () => {
    const verdict = evaluateBoundary({
      commandLine: 'ao send opk-worker hello',
      autonomousSurface: true,
      journaledTransportInternal: false,
    });
    expect(verdict.allowed).toBe(false);
    expect(findForbiddenAutonomousWorkerSendInvocations(['ao send opk-worker ping'])).toHaveLength(1);
  });

  it('preflight passes with gated inventory', () => {
    const result = evaluatePreflight({
      loadedGateVersion: WORKER_NUDGE_GATE_VERSION,
      atomicClaimPresent: true,
      liveCapabilities: [
        { id: 'invoke-gated-worker-nudge', classification: 'gated' },
        { id: 'ao-worker-send-raw', classification: 'unavailable' },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('adoption gate degrades when gated command missing', () => {
    const gate = evaluateAdoptionGate({ gatedCommandPresent: false, rawWorkerSendDenied: true });
    expect(gate.ok).toBe(false);
    expect(gate.degraded).toBe(true);
  });
});

describe('Worker-NudgeClaim single-flight contract', () => {
  it('never leaves two active claim records for one tuple under overlap', () => {
    const dir = tempClaimDir();
    try {
      const script = `
        $helper = ${psString(helperPath)}
        $ns = ${psString(dir)}
        $null = 1..6 | ForEach-Object -Parallel {
          . $using:helper
          Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'run:opk-rev-689' -IntentClass 'review-findings' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-1' -Namespace $using:ns | Out-Null
        } -ThrottleLimit 6
        [pscustomobject]@{
          activeCount = @((Get-ChildItem -LiteralPath $ns -File -Filter 'pr-380-*.json').Name).Count
        } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.activeCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('concurrent same-tuple resolves to one winner', () => {
    const dir = tempClaimDir();
    try {
      const script = `
        $helper = ${psString(helperPath)}
        $ns = ${psString(dir)}
        $results = 1..2 | ForEach-Object -Parallel {
          . $using:helper
          $r = Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'run:opk-rev-689' -IntentClass 'review-findings' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-1' -Namespace $using:ns -Surface 'test'
          [pscustomobject]@{ acquired = [bool]$r.acquired; reason = [string]$r.reason }
        } -ThrottleLimit 2
        [pscustomobject]@{
          winners = @($results | Where-Object { $_.acquired }).Count
          losers = @($results | Where-Object { -not $_.acquired }).Count
          activeCount = @((Get-ChildItem -LiteralPath $ns -File -Filter 'pr-380-*.json').Name).Count
        } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.winners).toBe(1);
      expect(result.losers).toBe(1);
      expect(result.activeCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects journaled send without claim token', () => {
    const journaled = path.join(repoRoot, 'scripts/journaled-worker-send.ps1');
    const result = spawnSync(
      'pwsh',
      ['-NoProfile', '-File', journaled, 'opk-test', '-Source', 'test', '-GatedNudge'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        input: 'hello worker',
        env: { ...process.env, AO_JOURNALED_SEND_ASSUME_FILE: '1' },
      },
    );
    expect(result.status).toBe(46);
  });

  it('rejects ungated journaled send on autonomous surface', () => {
    const journaled = path.join(repoRoot, 'scripts/journaled-worker-send.ps1');
    const result = spawnSync(
      'pwsh',
      ['-NoProfile', '-File', journaled, 'opk-test', '-Source', 'test'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        input: 'hello worker',
        env: {
          ...process.env,
          AO_JOURNALED_SEND_ASSUME_FILE: '1',
          AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '1',
        },
      },
    );
    expect(result.status).toBe(46);
  });

  it('ao shim denies raw worker send on autonomous surface', () => {
    const aoShim = path.join(repoRoot, 'scripts/ao');
    const result = spawnSync('bash', [aoShim, 'send', 'opk-worker', 'ping'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '1' },
    });
    expect(result.status).toBe(93);
    expect(result.stderr).toMatch(/autonomous worker nudges paused/i);
  });

  it('autonomous guard allows journaled transport internal sentinel', () => {
    const guard = path.join(repoRoot, 'scripts/lib/Worker-AutonomousNudgeGate.ps1');
    const script = `
      $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
      $env:AO_JOURNALED_SEND_INTERNAL = 'test-sentinel'
      . ${psString(guard)}
      $deny = Test-AutonomousRawWorkerSendDenied -Argv @('send','opk-worker','ping')
      [pscustomobject]@{ denied = [bool]$deny.denied; reason = [string]$deny.reason } | ConvertTo-Json -Compress
    `;
    const result = JSON.parse(runPwsh(script));
    expect(result.denied).toBe(false);
    expect(result.reason).toBe('journaled_transport_internal');
  });

  it('does not reacquire after terminal SENT claim', () => {
    const dir = tempClaimDir();
    try {
      const script = `
        . ${psString(helperPath)}
        $ns = ${psString(dir)}
        $claim = Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'run:opk-rev-689' -IntentClass 'review-findings' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-1' -Namespace $ns -Surface 'test'
        if (-not $claim.acquired) { throw 'expected initial acquire' }
        Finalize-WorkerNudgeClaim -ClaimResult $claim -Outcome 'SENT' | Out-Null
        $retry = Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'run:opk-rev-689' -IntentClass 'review-findings' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-1' -Namespace $ns -Surface 'test'
        [pscustomobject]@{ acquired = [bool]$retry.acquired; reason = [string]$retry.reason; terminal = [bool]$retry.terminal }
          | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.acquired).toBe(false);
      expect(result.reason).toBe('already_served');
      expect(result.terminal).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists SEND_ATTEMPTED on gated claim before transport', () => {
    const dir = tempClaimDir();
    try {
      const script = `
        . ${psString(helperPath)}
        $ns = ${psString(dir)}
        $claim = Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'run:opk-rev-689' -IntentClass 'review-findings' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-1' -Namespace $ns -Surface 'test'
        $claim.acquired = $true
        $attempt = Set-WorkerNudgeClaimSendAttempted -ClaimResult $claim
        $read = Read-WorkerNudgeClaimRecord -Path $claim.path
        [pscustomobject]@{
          attemptOk = [bool]$attempt.ok
          phase = [string]$read.record.phase
          sendAttemptedAtUtc = [string]$read.record.sendAttemptedAtUtc
        } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.attemptOk).toBe(true);
      expect(result.phase).toBe('SEND_ATTEMPTED');
      expect(result.sendAttemptedAtUtc).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects replayed claim tokens after send begins', () => {
    const dir = tempClaimDir();
    try {
      const script = `
        . ${psString(helperPath)}
        $ns = ${psString(dir)}
        $claim = Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'run:opk-rev-689' -IntentClass 'review-findings' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-1' -Namespace $ns -Surface 'test'
        if (-not $claim.acquired) { throw 'expected initial acquire' }
        $token = New-WorkerNudgeClaimToken -ClaimResult $claim
        $first = Invoke-ConsumeWorkerNudgeClaimTokenForSend -ClaimToken $token
        $second = Invoke-ConsumeWorkerNudgeClaimTokenForSend -ClaimToken $token
        [pscustomobject]@{
          firstOk = [bool]$first.ok
          secondOk = [bool]$second.ok
          secondReason = [string]$second.reason
        } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.firstOk).toBe(true);
      expect(result.secondOk).toBe(false);
      expect(result.secondReason).toBe('token_replayed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers CLAIMED records immediately after lease expiry', () => {
    const dir = tempClaimDir();
    const prevLease = process.env.AO_WORKER_NUDGE_CLAIM_LEASE_MS;
    const prevStale = process.env.AO_WORKER_NUDGE_CLAIM_STALE_MINUTES;
    process.env.AO_WORKER_NUDGE_CLAIM_LEASE_MS = '1';
    process.env.AO_WORKER_NUDGE_CLAIM_STALE_MINUTES = '30';
    try {
      const script = `
        . ${psString(helperPath)}
        $ns = ${psString(dir)}
        $claim = Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'run:opk-rev-689' -IntentClass 'review-findings' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-1' -Namespace $ns -Surface 'test'
        if (-not $claim.acquired) { throw 'expected initial acquire' }
        Start-Sleep -Milliseconds 5
        $retry = Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'run:opk-rev-689' -IntentClass 'review-findings' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-2' -Namespace $ns -Surface 'test'
        [pscustomobject]@{
          acquired = [bool]$retry.acquired
          recovered = [bool]$retry.recovered
          reason = [string]$retry.reason
        } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.acquired).toBe(true);
      expect(result.recovered).toBe(true);
    } finally {
      if (prevLease === undefined) {
        delete process.env.AO_WORKER_NUDGE_CLAIM_LEASE_MS;
      } else {
        process.env.AO_WORKER_NUDGE_CLAIM_LEASE_MS = prevLease;
      }
      if (prevStale === undefined) {
        delete process.env.AO_WORKER_NUDGE_CLAIM_STALE_MINUTES;
      } else {
        process.env.AO_WORKER_NUDGE_CLAIM_STALE_MINUTES = prevStale;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


  it('uses PS 5.1-compatible claim overwrite without File.Move(source, dest, overwrite)', () => {
    const claimText = readFileSync(helperPath, 'utf8');
    expect(claimText).not.toMatch(/File\]::Move\(\$tmp, \$Path, \$/);
    expect(claimText).toMatch(/AllowOverwrite[\s\S]*Remove-Item -LiteralPath \$Path -Force/);
  });

  it('routes gated transport to PR-resolved owner session', () => {
    const invokeText = readFileSync(invokePath, 'utf8');
    expect(invokeText).toMatch(/\$ownerSessionId = \[string\]\$targetResolution\.ownerSessionId/);
    expect(invokeText).toMatch(/\$sendSessionId = if \(\$ownerSessionId\) \{ \$ownerSessionId \} else \{ \$SessionId \}/);
    expect(invokeText).toMatch(/File \$journaledScript \$sendSessionId/);
    expect(invokeText).not.toMatch(/File \$journaledScript \$SessionId -Source/);
  });


  it('resolves reconcile script tuples from PR ownership claim', () => {
    const ciGreen = readFileSync(
      path.join(repoRoot, 'scripts/ci-green-wake-reconcile.ps1'),
      'utf8',
    );
    const reviewSend = readFileSync(
      path.join(repoRoot, 'scripts/review-send-reconcile.ps1'),
      'utf8',
    );
    for (const script of [ciGreen, reviewSend]) {
      expect(script).toMatch(/Resolve-WorkerNudgeTargetFromPrClaim/);
      expect(script).not.toMatch(/\$workerTarget = "\$sessionId`:\$sessionId"/);
      expect(script).toMatch(/-TargetId \$targetId -TargetGeneration \$targetGeneration/);
    }
  });

  it('passes GatedNudge marker from ci-green wake journaled send', () => {
    const ciGreen = readFileSync(
      path.join(repoRoot, 'scripts/ci-green-wake-reconcile.ps1'),
      'utf8',
    );
    expect(ciGreen).toMatch(/-ClaimToken \$claimToken -GatedNudge -NoWait/);
  });

describe('opk-rev-689 incident fixture', () => {
  it('loads capture-backed fixture and collapses duplicate review-findings nudges', () => {
    const fixturePath = path.join(fixturesDir, 'opk-rev-689.json');
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const tuple = buildTupleKey(fixture.tuple);
    expect(tuple.ok).toBe(true);
    const allowed = evaluateNudgeGate({
      ...fixture.tuple,
      surface: 'orchestrator-turn',
      storePath: fixture.storePath,
      claims: fixture.priorClaims,
    });
    expect(allowed.allow).toBe(false);
    expect(acquireClaim({ ...fixture.tuple, surface: 'orchestrator-turn', storePath: fixture.storePath, claims: fixture.priorClaims }).acquired).toBe(false);
  });
});

describe('PR-claim worker target resolution (#384)', () => {
  it('keeps generation for resume under same PR-claim lineage with a new session id', () => {
    const worktree = '/tmp/orchestrator-pack/worktrees/opk-1';
    const existing = syncPrOwnershipClaimRecord({
      prNumber: 380,
      ownerSessionId: 'opk-1',
      worktree,
      existingClaim: {
        prNumber: 380,
        ownerSessionId: 'opk-1',
        generation: 'gen1',
        lineageId: 'gen1',
        worktree,
      },
    }).record;
    const resumed = syncPrOwnershipClaimRecord({
      prNumber: 380,
      ownerSessionId: 'opk-5',
      worktree,
      existingClaim: existing,
    });
    expect(resumed.reason).toBe('resume_same_lineage');
    expect((resumed.record as { generation?: string }).generation).toBe('gen1');

    const target = resolveWorkerTargetFromPrClaim({
      prNumber: 380,
      sessionId: 'opk-5',
      sessions: [{ name: 'opk-5', role: 'worker', prNumber: 380 }],
      prClaims: [resumed.record],
    });
    expect(target.ok).toBe(true);
    expect(target.workerTarget).toBe('gen1:gen1');
    expect(target.targetResolutionSource).toBe('pr-claim-record');
  });

  it('bumps generation for replacement claim-pr ownership', () => {
    const prior = syncPrOwnershipClaimRecord({
      prNumber: 380,
      ownerSessionId: 'opk-1',
      worktree: '/tmp/orchestrator-pack/worktrees/opk-1',
      existingClaim: null,
    }).record;
    const replacement = syncPrOwnershipClaimRecord({
      prNumber: 380,
      ownerSessionId: 'opk-2',
      worktree: '/tmp/orchestrator-pack/worktrees/opk-2',
      existingClaim: prior,
    });
    expect(replacement.reason).toBe('replacement_claim');
    expect((replacement.record as { generation?: string }).generation).toBe('opk-2');

    const target = resolveWorkerTargetFromPrClaim({
      prNumber: 380,
      sessionId: 'opk-2',
      sessions: [{ name: 'opk-2', role: 'worker', prNumber: 380 }],
      prClaims: [replacement.record],
    });
    expect(target.workerTarget).toBe('opk-2:opk-2');
  });

  it('does not suppress replacement generation after prior tuple was served', () => {
    const prior = syncPrOwnershipClaimRecord({
      prNumber: 380,
      ownerSessionId: 'opk-1',
      worktree: '/tmp/orchestrator-pack/worktrees/opk-1',
      existingClaim: null,
    }).record;
    const replacement = syncPrOwnershipClaimRecord({
      prNumber: 380,
      ownerSessionId: 'opk-2',
      worktree: '/tmp/orchestrator-pack/worktrees/opk-2',
      existingClaim: prior,
    }).record;
    const priorTarget = resolveWorkerTargetFromPrClaim({
      prNumber: 380,
      sessionId: 'opk-1',
      sessions: [{ name: 'opk-1', role: 'worker', prNumber: 380 }],
      prClaims: [prior],
    });
    const replacementTarget = resolveWorkerTargetFromPrClaim({
      prNumber: 380,
      sessionId: 'opk-2',
      sessions: [{ name: 'opk-2', role: 'worker', prNumber: 380 }],
      prClaims: [replacement],
    });
    const gate = evaluateNudgeGate({
      prNumber: 380,
      headSha,
      sessionId: 'opk-2',
      intentClass: 'review-findings',
      reviewRunId: 'opk-rev-689',
      targetId: replacementTarget.targetId,
      targetGeneration: replacementTarget.targetGeneration,
      surface: 'orchestrator-turn',
      storePath: '/tmp/unused',
      claims: [
        {
          tupleKey: `380|run:opk-rev-689|review-findings|${priorTarget.workerTarget}`,
          phase: 'SENT',
          intentClass: 'review-findings',
        },
      ],
    });
    expect(gate.allow).toBe(true);
  });
});

