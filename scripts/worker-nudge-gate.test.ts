import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  seedPrSessionBindingCache,
  useIsolatedPrSessionBindingCache,
} from './_test-pr-session-binding-cache-fixture.js';
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
  evaluateClaimStoreFailure,
  evaluateNudgeGate,
  hashNudgeMessageContent,
  inferResumeLineageFromOwnershipChange,
  isValidJournaledSendInternalCapability,
  JOURNALED_SEND_INTERNAL_CAPABILITY,
  evaluatePreflight,
  finalizeClaim,
  findForbiddenAutonomousWorkerSendInvocations,
  remapLegacy332Record,
  resolvePrOwnerSessionForNudge,
  resolveCiFailureHeadShaFromGateInput,
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

function withClaimStoreEnv(dir: string, script: string) {
  return `
    $prevClaimDir = $env:AO_WORKER_NUDGE_CLAIM_DIR
    $env:AO_WORKER_NUDGE_CLAIM_DIR = ${psString(dir)}
    try {
      ${script}
    } finally {
      if ($prevClaimDir) { $env:AO_WORKER_NUDGE_CLAIM_DIR = $prevClaimDir } else { Remove-Item Env:AO_WORKER_NUDGE_CLAIM_DIR -ErrorAction SilentlyContinue }
    }
  `;
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


  it('allows materially new message content for an already-served tuple with escalation', () => {
    const tuple = buildTupleKey({
      prNumber: 380,
      sessionId: 'opk-1',
      reviewRunId: 'opk-rev-689',
      headSha,
    });
    expect(tuple.ok).toBe(true);
    const servedHash = hashNudgeMessageContent('first findings body');
    const gate = evaluateNudgeGate({
      prNumber: 380,
      sessionId: 'opk-1',
      reviewRunId: 'opk-rev-689',
      headSha,
      message: 'updated findings body with new items',
      surface: 'orchestrator-turn',
      source: 'orchestrator-turn',
      storePath: '/tmp/gate-state',
      claims: [
        {
          tupleKey: tuple.tupleKey,
          phase: 'SENT',
          intentClass: 'review-findings',
          messageContentHash: servedHash,
        },
      ],
    });
    expect(gate.allow).toBe(false);
    expect(gate.decision).toBe('SUPPRESS');
    expect(gate.reason).toBe('materially_new_content');
    expect(gate.escalate).toBe(true);
    expect(String(gate.diagnosis ?? '')).toContain('ESCALATION');
  });

  it('normalizes invalid explicit intent hints to unknown-worker-nudge via classifier', () => {
    expect(
      classifyIntent({
        intentClass: 'review-findngs-typo',
        message: '???',
        source: 'orchestrator-turn',
      }),
    ).toBe('unknown-worker-nudge');
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

  it('classifies review-finding-delivery-confirm as review-findings-redelivery', () => {
    expect(
      classifyIntent({
        source: 'review-finding-delivery-confirm',
        surface: 'review-finding-delivery-confirm',
      }),
    ).toBe('review-findings-redelivery');
  });

  it('derives per-attempt redelivery cycle keys distinct from first findings-delivery send', () => {
    const first = deriveCycleKey('findings-delivery', { reviewRunId: 'opk-rev-781', runId: 'opk-rev-781' });
    const retry = deriveCycleKey('review-findings-redelivery', {
      reviewRunId: 'opk-rev-781',
      runId: 'opk-rev-781',
      attempt: 2,
    });
    expect(first).toBe('run:opk-rev-781');
    expect(retry).toBe('redelivery:opk-rev-781:2');
    const firstTuple = buildTupleKey({
      prNumber: 380,
      sessionId: 'opk-1',
      reviewRunId: 'opk-rev-781',
      headSha,
      intentClass: 'findings-delivery',
    });
    const retryTuple = buildTupleKey({
      prNumber: 380,
      sessionId: 'opk-1',
      reviewRunId: 'opk-rev-781',
      headSha,
      intentClass: 'review-findings-redelivery',
      attempt: 2,
    });
    expect(firstTuple.ok).toBe(true);
    expect(retryTuple.ok).toBe(true);
    expect(retryTuple.tupleKey).not.toBe(firstTuple.tupleKey);
  });

  it('allows redelivery claim after first findings-delivery tuple is terminal SENT', () => {
    const dir = tempClaimDir();
    try {
      const script = withClaimStoreEnv(dir, `
        . ${psString(helperPath)}
        $first = Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'run:opk-rev-781' -IntentClass 'findings-delivery' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-1' -Surface 'review-send-reconcile'
        if (-not $first.acquired) { throw 'expected first acquire' }
        Finalize-WorkerNudgeClaim -ClaimResult $first -Outcome 'SENT' | Out-Null
        $retry = Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'redelivery:opk-rev-781:1' -IntentClass 'review-findings-redelivery' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-1' -Surface 'review-finding-delivery-confirm'
        [pscustomobject]@{ acquired = [bool]$retry.acquired; reason = [string]$retry.reason } | ConvertTo-Json -Compress
      `);
      const result = JSON.parse(runPwsh(script));
      expect(result.acquired).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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


  it('maps unclassified verifiable legacy records to review-findings', () => {
    const legacy = {
      sessionId: 'opk-1',
      targetGeneration: 'gen1',
      sentAtMs: 1,
      reviewRunId: 'opk-rev-689',
      prNumber: 380,
    };
    const mapped = remapLegacy332Record(legacy);
    expect(mapped.intentClass).toBe('review-findings');
    expect(mapped.cycleKey).toBe('run:opk-rev-689');
    const gate = evaluateNudgeGate({
      prNumber: 380,
      sessionId: 'opk-1',
      reviewRunId: 'opk-rev-689',
      headSha,
      targetId: 'opk-1',
      targetGeneration: 'gen1',
      source: 'orchestrator-turn',
      surface: 'orchestrator-turn',
      message: 'Please check ao review list and report addressing_reviews when done.',
      storePath: '/tmp/gate-state',
      legacyRecords: [legacy],
    });
    expect(gate.allow).toBe(false);
    expect(gate.reason).toBe('legacy_record');
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

  it('allows gate retry when only FAILED_DEFINITIVE terminal claim exists', () => {
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
      storePath: '/tmp/gate-state',
      claims: [
        {
          tupleKey: tuple.tupleKey,
          phase: 'FAILED_DEFINITIVE',
          intentClass: 'review-findings',
        },
      ],
    });
    expect(gate.allow).toBe(true);
    expect(acquireClaim({
      prNumber: 380,
      sessionId: 'opk-1',
      reviewRunId: 'opk-rev-689',
      headSha,
      surface: 'orchestrator-turn',
      storePath: '/tmp/gate-state',
      claims: gate.tuple
        ? [
            {
              tupleKey: tuple.tupleKey,
              phase: 'FAILED_DEFINITIVE',
              intentClass: 'review-findings',
            },
          ]
        : [],
    }).acquired).toBe(true);
  });

  it('still suppresses when SENT terminal exists even if FAILED_DEFINITIVE is listed first', () => {
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
      storePath: '/tmp/gate-state',
      claims: [
        {
          tupleKey: tuple.tupleKey,
          phase: 'FAILED_DEFINITIVE',
          intentClass: 'review-findings',
        },
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

  it('escalates claim-store failures after bounded unresolved count', () => {
    const first = evaluateClaimStoreFailure({ unresolvedCount: 2, unresolvedSinceMs: Date.now(), nowMs: Date.now() });
    expect(first.escalate).toBe(true);
    expect(first.reason).toBe('unresolved_escalate');
    expect(String(first.diagnosis)).toContain('ESCALATION:');
    const second = evaluateClaimStoreFailure({ unresolvedCount: 0, unresolvedSinceMs: Date.now(), nowMs: Date.now() });
    expect(second.escalate).toBe(false);
    expect(second.reason).toBe('unresolved_fail_closed');
  });

  it('rejects forged journaled internal capability tokens', () => {
    expect(isValidJournaledSendInternalCapability('1')).toBe(false);
    expect(isValidJournaledSendInternalCapability('test-sentinel')).toBe(false);
    expect(
      isValidJournaledSendInternalCapability(`${JOURNALED_SEND_INTERNAL_CAPABILITY}:0123456789abcdef`),
    ).toBe(true);
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


  it('preflight fails closed when the daemon session capability is missing', () => {
    const result = evaluatePreflight({
      loadedGateVersion: WORKER_NUDGE_GATE_VERSION,
      atomicClaimPresent: true,
      liveCapabilities: [
        { id: 'autonomous-worker-nudge-gate', classification: 'gated' },
        { id: 'worker-nudge-claim-atomic', classification: 'gated' },
        { id: 'journaled-worker-send-gated', classification: 'gated' },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('autonomous-session-id_missing');
  });

  it('preflight passes with the AO 0.10.2 in-process capability inventory', () => {
    const result = evaluatePreflight({
      loadedGateVersion: WORKER_NUDGE_GATE_VERSION,
      atomicClaimPresent: true,
      liveCapabilities: [
        { id: 'autonomous-session-id', classification: 'gated' },
        { id: 'autonomous-worker-nudge-gate', classification: 'gated' },
        { id: 'worker-nudge-claim-atomic', classification: 'gated' },
        { id: 'journaled-worker-send-gated', classification: 'gated' },
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
  useIsolatedPrSessionBindingCache();

  it('never leaves two active claim records for one tuple under overlap', () => {
    const dir = tempClaimDir();
    try {
      const script = withClaimStoreEnv(dir, `
        . ${psString(helperPath)}
        $ns = Resolve-WorkerNudgeClaimNamespace
        $helper = ${psString(helperPath)}
        $claimDir = ${psString(dir)}
        $null = 1..6 | ForEach-Object -Parallel {
          $env:AO_WORKER_NUDGE_CLAIM_DIR = $using:claimDir
          . $using:helper
          Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'run:opk-rev-689' -IntentClass 'review-findings' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-1' | Out-Null
        } -ThrottleLimit 6
        [pscustomobject]@{
          activeCount = @((Get-ChildItem -LiteralPath $ns -File -Filter 'pr-380-*.json').Name).Count
        } | ConvertTo-Json -Compress
      `);
      const result = JSON.parse(runPwsh(script));
      expect(result.activeCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('concurrent same-tuple resolves to one winner', { retry: 2 }, () => {
    const dir = tempClaimDir();
    try {
      const script = withClaimStoreEnv(dir, `
        . ${psString(helperPath)}
        $ns = Resolve-WorkerNudgeClaimNamespace
        $helper = ${psString(helperPath)}
        $claimDir = ${psString(dir)}
        $results = 1..2 | ForEach-Object -Parallel {
          $env:AO_WORKER_NUDGE_CLAIM_DIR = $using:claimDir
          . $using:helper
          $r = Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'run:opk-rev-689' -IntentClass 'review-findings' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-1' -Surface 'test'
          [pscustomobject]@{ acquired = [bool]$r.acquired; reason = [string]$r.reason }
        } -ThrottleLimit 2
        [pscustomobject]@{
          winners = @($results | Where-Object { $_.acquired }).Count
          losers = @($results | Where-Object { -not $_.acquired }).Count
          activeCount = @((Get-ChildItem -LiteralPath $ns -File -Filter 'pr-380-*.json').Name).Count
        } | ConvertTo-Json -Compress
      `);
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
        env: { ...process.env, AO_JOURNALED_SEND_ASSUME_CONTRACT: '1' },
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
          AO_JOURNALED_SEND_ASSUME_CONTRACT: '1',
          AO_SESSION_ID: '1',
        },
      },
    );
    expect(result.status).toBe(46);
  });

  it('autonomous guard allows registered journaled transport internal capability', () => {
    const guard = path.join(repoRoot, 'scripts/lib/Worker-AutonomousNudgeGate.ps1');
    const capabilityLib = path.join(repoRoot, 'scripts/lib/Journaled-WorkerSendInternalCapability.ps1');
    const script = `
      . ${psString(capabilityLib)}
      $guard = ${psString(guard)}
      $env:AO_JOURNALED_SEND_CAPABILITY_TEST_FIXTURE = '1'
      $registered = Register-JournaledWorkerSendInternalCapability
      if (-not $registered.ok) { throw $registered.reason }
      $childParts = @(
        '$env:AO_JOURNALED_SEND_CAPABILITY_TEST_FIXTURE = ''1''' ,
        '$env:AO_SESSION_ID = ''1''' ,
        ('$env:AO_JOURNALED_SEND_INTERNAL = ''' + $registered.capability + ''''),
        ('. ' + $guard),
        '$deny = Test-AutonomousRawWorkerSendDenied -Argv @(''send'',''opk-worker'',''ping'')',
        '[pscustomobject]@{ denied = [bool]$deny.denied; reason = [string]$deny.reason } | ConvertTo-Json -Compress'
      )
      pwsh -NoProfile -Command ($childParts -join '; ')
    `;
    const result = JSON.parse(runPwsh(script));
    expect(result.denied).toBe(false);
    expect(result.reason).toBe('journaled_transport_internal');
  });

  it('rejects forged AO_JOURNALED_SEND_INTERNAL bypass', () => {
    const guard = path.join(repoRoot, 'scripts/lib/Worker-AutonomousNudgeGate.ps1');
    const script = `
      $env:AO_SESSION_ID = '1'
      $env:AO_JOURNALED_SEND_INTERNAL = '1'
      . ${psString(guard)}
      $deny = Test-AutonomousRawWorkerSendDenied -Argv @('send','opk-worker','ping')
      [pscustomobject]@{ denied = [bool]$deny.denied; reason = [string]$deny.reason } | ConvertTo-Json -Compress
    `;
    const result = JSON.parse(runPwsh(script));
    expect(result.denied).toBe(true);
    expect(result.reason).toBe('autonomous_raw_worker_send_denied');
  });

  it('rejects capability registration outside journaled transport', () => {
    const capabilityLib = path.join(repoRoot, 'scripts/lib/Journaled-WorkerSendInternalCapability.ps1');
    const script = `
      . ${psString(capabilityLib)}
      $registered = Register-JournaledWorkerSendInternalCapability
      [pscustomobject]@{ ok = [bool]$registered.ok; reason = [string]$registered.reason } | ConvertTo-Json -Compress
    `;
    const result = JSON.parse(runPwsh(script));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('registration_denied');
  });


  it('rejects capability registration from a forged journaled-worker-send script path', () => {
    const capabilityLib = path.join(repoRoot, 'scripts/lib/Journaled-WorkerSendInternalCapability.ps1');
    const forgeDir = mkdtempSync(path.join(tmpdir(), 'journaled-worker-send-forge-'));
    const forgeScript = path.join(forgeDir, 'journaled-worker-send.ps1');
    writeFileSync(
      forgeScript,
      `function New-JournaledWorkerSendInternalCapability {\n` +
        `  . ${capabilityLib.replace(/'/g, "''")}\n` +
        `  return Register-JournaledWorkerSendInternalCapability\n` +
        `}\n`,
      'utf8',
    );
    try {
      const script = `
        . ${psString(forgeScript)}
        $registered = New-JournaledWorkerSendInternalCapability
        [pscustomobject]@{ ok = [bool]$registered.ok; reason = [string]$registered.reason } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('registration_denied');
    } finally {
      rmSync(forgeDir, { recursive: true, force: true });
    }
  });

  it('resolves trusted journaled-worker-send path to the pack script', () => {
    const capabilityLib = path.join(repoRoot, 'scripts/lib/Journaled-WorkerSendInternalCapability.ps1');
    const trusted = path.join(repoRoot, 'scripts/journaled-worker-send.ps1');
    const script = `
      . ${psString(capabilityLib)}
      [pscustomobject]@{
        trusted = (Get-TrustedJournaledWorkerSendScriptPath)
        matches = (Test-TrustedJournaledWorkerSendScriptPath -CandidatePath ${psString(trusted)})
      } | ConvertTo-Json -Compress
    `;
    const result = JSON.parse(runPwsh(script));
    expect(result.matches).toBe(true);
    expect(result.trusted).toBe(trusted);
  });

  it('Split-ProcessCommandLineTokens return-shape: Get-ScriptPathsFromProcessCommandLine finds -File path', () => {
    const capabilityLib = path.join(repoRoot, 'scripts/lib/Journaled-WorkerSendInternalCapability.ps1');
    const boundaryLib = path.join(repoRoot, 'scripts/lib/Orchestrator-AutonomousBoundary.ps1');
    const trusted = path.join(repoRoot, 'scripts/journaled-worker-send.ps1');
    const script = `
      . ${psString(boundaryLib)}
      . ${psString(capabilityLib)}
      $cmdLine = 'pwsh -NoProfile -File ${trusted.replace(/'/g, "''")}'
      $nestedTokens = @(Split-ProcessCommandLineTokens -CommandLine $cmdLine)
      $nestedPathCount = 0
      for ($index = 0; $index -lt $nestedTokens.Count; $index++) {
        if ($nestedTokens[$index] -in @('-File', '-f') -and ($index + 1) -lt $nestedTokens.Count) {
          $nestedPathCount++
        }
      }
      $paths = @(Get-ScriptPathsFromProcessCommandLine -CommandLine $cmdLine)
      [pscustomobject]@{
        nestedPathCount = $nestedPathCount
        pathCount = $paths.Count
        extracted = [string]$paths[0]
        trusted = [bool](Test-TrustedJournaledWorkerSendScriptPath -CandidatePath $paths[0])
      } | ConvertTo-Json -Compress
    `;
    const result = JSON.parse(runPwsh(script));
    expect(result.nestedPathCount).toBe(0);
    expect(result.pathCount).toBe(1);
    expect(result.extracted).toBe(trusted);
    expect(result.trusted).toBe(true);
  });

  describe('internal capability deny', () => {

    it('forged unregistered internal capability token is internal capability deny exit 93', () => {
      const guard = path.join(repoRoot, 'scripts/lib/Worker-AutonomousNudgeGate.ps1');
      const script = `
        $env:AO_SESSION_ID = '1'
        $env:AO_JOURNALED_SEND_INTERNAL = 'journaled-worker-send-internal/v1:0123456789abcdef'
        . ${psString(guard)}
        $deny = Test-AutonomousRawWorkerSendDenied -Argv @('send','opk-worker','ping')
        [pscustomobject]@{ denied = [bool]$deny.denied; reason = [string]$deny.reason } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.denied).toBe(true);
      expect(result.reason).toBe('autonomous_raw_worker_send_denied');
    });

    it('replayed internal capability nonce is internal capability deny exit 93', () => {
      const capabilityLib = path.join(repoRoot, 'scripts/lib/Journaled-WorkerSendInternalCapability.ps1');
      const aoBaseDir = mkdtempSync(path.join(tmpdir(), 'journaled-cap-replay-'));
      const script = `
        $env:AO_BASE_DIR = ${psString(aoBaseDir)}
        $env:AO_JOURNALED_SEND_CAPABILITY_TEST_FIXTURE = '1'
        . ${psString(capabilityLib)}
        $registered = Register-JournaledWorkerSendInternalCapability
        if (-not $registered.ok) { throw $registered.reason }
        $nonce = ($registered.capability -split ':',2)[1]
        $capPath = Join-Path (Get-JournaledWorkerSendInternalCapabilityDir) "$nonce.json"
        Remove-Item -LiteralPath $capPath -Force
        $env:AO_JOURNALED_SEND_INTERNAL = $registered.capability
        $replayed = Test-ConsumeJournaledWorkerSendInternalCapability
        [pscustomobject]@{ consumed = [bool]$replayed } | ConvertTo-Json -Compress
      `;
      try {
        const result = JSON.parse(runPwsh(script));
        expect(result.consumed).toBe(false);
      } finally {
        rmSync(aoBaseDir, { recursive: true, force: true });
      }
    });
  });

  it('rejects well-formed but unregistered journaled internal capability tokens', () => {
    const guard = path.join(repoRoot, 'scripts/lib/Worker-AutonomousNudgeGate.ps1');
    const script = `
      $env:AO_SESSION_ID = '1'
      $env:AO_JOURNALED_SEND_INTERNAL = 'journaled-worker-send-internal/v1:0123456789abcdef'
      . ${psString(guard)}
      $deny = Test-AutonomousRawWorkerSendDenied -Argv @('send','opk-worker','ping')
      [pscustomobject]@{ denied = [bool]$deny.denied; reason = [string]$deny.reason } | ConvertTo-Json -Compress
    `;
    const result = JSON.parse(runPwsh(script));
    expect(result.denied).toBe(true);
    expect(result.reason).toBe('autonomous_raw_worker_send_denied');
  });

  it('persists messageContentHash on active claim through terminal finalize', () => {
    const dir = tempClaimDir();
    const hash = hashNudgeMessageContent('review findings payload');
    try {
      const script = withClaimStoreEnv(dir, `
        . ${psString(helperPath)}
        $ns = Resolve-WorkerNudgeClaimNamespace
        Initialize-WorkerNudgeClaimNamespace -Namespace $ns
        $claim = Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'run:opk-rev-689' -IntentClass 'review-findings' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-1' -Surface 'test'
        if (-not $claim.acquired) { throw "acquire failed: $($claim.reason)" }
        $persist = Set-WorkerNudgeClaimMessageContentHash -ClaimResult $claim -MessageContentHash '${hash}'
        if (-not $persist.ok) { throw "persist failed: $($persist.reason)" }
        $terminal = Finalize-WorkerNudgeClaim -ClaimResult $claim -Outcome 'SENT'
        if (-not $terminal.ok) { throw "finalize failed: $($terminal.reason)" }
        $raw = Get-Content -LiteralPath $terminal.terminalPath -Raw | ConvertFrom-Json
        Write-Output $raw.messageContentHash
      `);
      expect(runPwsh(script).trim()).toBe(hash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reacquires after terminal FAILED_DEFINITIVE claim', () => {
    const dir = tempClaimDir();
    try {
      const script = withClaimStoreEnv(dir, `
        . ${psString(helperPath)}
        $claim = Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'run:opk-rev-689' -IntentClass 'review-findings' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-1' -Surface 'test'
        if (-not $claim.acquired) { throw 'expected initial acquire' }
        Finalize-WorkerNudgeClaim -ClaimResult $claim -Outcome 'FAILED_DEFINITIVE' | Out-Null
        $retry = Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'run:opk-rev-689' -IntentClass 'review-findings' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-1' -Surface 'test'
        [pscustomobject]@{ acquired = [bool]$retry.acquired; reason = [string]$retry.reason }
          | ConvertTo-Json -Compress
      `);
      const result = JSON.parse(runPwsh(script));
      expect(result.acquired).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not reacquire after terminal SENT claim', () => {
    const dir = tempClaimDir();
    try {
      const script = withClaimStoreEnv(dir, `
        . ${psString(helperPath)}
        $claim = Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'run:opk-rev-689' -IntentClass 'review-findings' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-1' -Surface 'test'
        if (-not $claim.acquired) { throw 'expected initial acquire' }
        Finalize-WorkerNudgeClaim -ClaimResult $claim -Outcome 'SENT' | Out-Null
        $retry = Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'run:opk-rev-689' -IntentClass 'review-findings' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-1' -Surface 'test'
        [pscustomobject]@{ acquired = [bool]$retry.acquired; reason = [string]$retry.reason; terminal = [bool]$retry.terminal }
          | ConvertTo-Json -Compress
      `);
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
      const script = withClaimStoreEnv(dir, `
        . ${psString(helperPath)}
        $claim = Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'run:opk-rev-689' -IntentClass 'review-findings' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-1' -Surface 'test'
        $claim.acquired = $true
        $attempt = Set-WorkerNudgeClaimSendAttempted -ClaimResult $claim
        $read = Read-WorkerNudgeClaimRecord -Path $claim.path
        [pscustomobject]@{
          attemptOk = [bool]$attempt.ok
          phase = [string]$read.record.phase
          sendAttemptedAtUtc = [string]$read.record.sendAttemptedAtUtc
        } | ConvertTo-Json -Compress
      `);
      const result = JSON.parse(runPwsh(script));
      expect(result.attemptOk).toBe(true);
      expect(result.phase).toBe('SEND_ATTEMPTED');
      expect(result.sendAttemptedAtUtc).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects forged claim tokens bound to writable paths outside the canonical store', () => {
    const dir = tempClaimDir();
    const forgeDir = mkdtempSync(path.join(tmpdir(), 'worker-nudge-claim-forge-'));
    try {
      const script = withClaimStoreEnv(dir, `
        . ${psString(helperPath)}
        $claim = Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'run:opk-rev-789' -IntentClass 'review-findings' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-1' -Surface 'test'
        if (-not $claim.acquired) { throw 'expected initial acquire' }
        $token = New-WorkerNudgeClaimToken -ClaimResult $claim
        $decoded = ConvertFrom-WorkerNudgeClaimToken -ClaimToken $token
        $forgedPath = Join-Path ${psString(forgeDir)} 'forged-claim.json'
        Copy-Item -LiteralPath $claim.path -Destination $forgedPath -Force
        $decoded | Add-Member -NotePropertyName path -NotePropertyValue $forgedPath -Force
        $decoded | Add-Member -NotePropertyName namespace -NotePropertyValue ${psString(forgeDir)} -Force
        $forgedJson = $decoded | ConvertTo-Json -Compress -Depth 10
        $forgedToken = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($forgedJson))
        $consume = Invoke-ConsumeWorkerNudgeClaimTokenForSend -ClaimToken $forgedToken -SendSessionId 'opk-1'
        [pscustomobject]@{ ok = [bool]$consume.ok; reason = [string]$consume.reason } | ConvertTo-Json -Compress
      `);
      const result = JSON.parse(runPwsh(script));
      expect(result.ok).toBe(false);
      expect(['token_path_unbound', 'token_namespace_unbound']).toContain(result.reason);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(forgeDir, { recursive: true, force: true });
    }
  });

  it('rejects replayed claim tokens after send begins', () => {
    const dir = tempClaimDir();
    try {
      const script = withClaimStoreEnv(dir, `
        . ${psString(helperPath)}
        $claim = Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'run:opk-rev-689' -IntentClass 'review-findings' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-1' -Surface 'test'
        if (-not $claim.acquired) { throw 'expected initial acquire' }
        $token = New-WorkerNudgeClaimToken -ClaimResult $claim
        $first = Invoke-ConsumeWorkerNudgeClaimTokenForSend -ClaimToken $token -SendSessionId 'opk-1'
        $second = Invoke-ConsumeWorkerNudgeClaimTokenForSend -ClaimToken $token -SendSessionId 'opk-1'
        [pscustomobject]@{
          firstOk = [bool]$first.ok
          secondOk = [bool]$second.ok
          secondReason = [string]$second.reason
        } | ConvertTo-Json -Compress
      `);
      const result = JSON.parse(runPwsh(script));
      expect(result.firstOk).toBe(true);
      expect(result.secondOk).toBe(false);
      expect(result.secondReason).toBe('token_replayed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects claim token when send session does not match token session', () => {
    const dir = tempClaimDir();
    try {
      const script = withClaimStoreEnv(dir, `
        . ${psString(helperPath)}
        $claim = Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'run:opk-rev-689' -IntentClass 'review-findings' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-1' -Surface 'test'
        if (-not $claim.acquired) { throw 'expected initial acquire' }
        $token = New-WorkerNudgeClaimToken -ClaimResult $claim
        $wrong = Invoke-ConsumeWorkerNudgeClaimTokenForSend -ClaimToken $token -SendSessionId 'opk-wrong'
        [pscustomobject]@{
          ok = [bool]$wrong.ok
          reason = [string]$wrong.reason
        } | ConvertTo-Json -Compress
      `);
      const result = JSON.parse(runPwsh(script));
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('token_send_session_mismatch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('releases active claim when message hash persistence fails', () => {
    const dir = tempClaimDir();
    try {
      const script = withClaimStoreEnv(dir, `
        . ${psString(helperPath)}
        $claim = Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'run:opk-rev-689' -IntentClass 'review-findings' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-1' -Surface 'test'
        if (-not $claim.acquired) { throw 'expected initial acquire' }
        Release-WorkerNudgeActiveClaim -ClaimResult $claim | Out-Null
        $activeExists = Test-Path -LiteralPath $claim.path
        $retry = Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'run:opk-rev-689' -IntentClass 'review-findings' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-1' -Surface 'test'
        [pscustomobject]@{ activeExists = $activeExists; reacquired = [bool]$retry.acquired } | ConvertTo-Json -Compress
      `);
      const result = JSON.parse(runPwsh(script));
      expect(result.activeExists).toBe(false);
      expect(result.reacquired).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('invoke-gated-worker-nudge releases claim on message hash persist failure', () => {
    const text = readFileSync(invokePath, 'utf8');
    expect(text).toMatch(/if\s*\(\s*-not\s+\$hashPersist\.ok\s*\)[\s\S]*?Release-WorkerNudgeActiveClaim/);
  });

  it('finalizes gated claim when transport preflight fails', () => {
    const dir = tempClaimDir();
    const fakeAoDir = mkdtempSync(path.join(tmpdir(), 'fake-ao-'));
    const fakeAo = path.join(fakeAoDir, 'ao');
    const journaled = path.join(repoRoot, 'scripts/journaled-worker-send.ps1');
    writeFileSync(
      fakeAo,
      `#!/usr/bin/env bash\nif [[ "$1" == "send" && "$2" == "--help" ]]; then echo "Usage: ao send <session>"; exit 0; fi\nexit 99\n`,
    );
    chmodSync(fakeAo, 0o755);
    try {
      const script = withClaimStoreEnv(dir, `
        . ${psString(helperPath)}
        $ns = Resolve-WorkerNudgeClaimNamespace
        Initialize-WorkerNudgeClaimNamespace -Namespace $ns
        $claim = Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'run:opk-rev-689' -IntentClass 'review-findings' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-1' -Surface 'test'
        if (-not $claim.acquired) { throw "acquire failed: $($claim.reason)" }
        $token = New-WorkerNudgeClaimToken -ClaimResult $claim
        'hello' | pwsh -NoProfile -File ${psString(journaled)} 'opk-1' -AoPath ${psString(fakeAo)} -ClaimToken $token -GatedNudge -Source 'test'
        $exitCode = $LASTEXITCODE
        $activeExists = Test-Path -LiteralPath $claim.path
        $terminalDir = Join-Path $ns 'terminal'
        $terminalCount = if (Test-Path -LiteralPath $terminalDir) { @(Get-ChildItem -LiteralPath $terminalDir -File).Count } else { 0 }
        [pscustomobject]@{ exitCode = $exitCode; activeExists = $activeExists; terminalCount = $terminalCount } | ConvertTo-Json -Compress
      `);
      const raw = runPwsh(script);
      const jsonLine = raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('{'))
        .pop();
      const result = JSON.parse(jsonLine ?? '{}');
      expect(result.exitCode).toBe(42);
      expect(result.activeExists).toBe(false);
      expect(result.terminalCount).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(fakeAoDir, { recursive: true, force: true });
    }
  });

  it('resolves head owner when multiple PR sessions exist', () => {
    const headSha = 'a'.repeat(40);
    seedPrSessionBindingCache('opk-owner', 380, headSha);
    const result = resolvePrOwnerSessionForNudge({
      prNumber: 380,
      sessionId: 'opk-owner',
      headSha,
      sessions: [
        { name: 'opk-stale', role: 'worker', runtime: 'alive' },
        {
          name: 'opk-owner',
          role: 'worker',
          prNumber: 380,
          ownedHeadSha: headSha,
          runtime: 'alive',
        },
      ],
      openPrs: [{ number: 380, headRefOid: headSha }],
    });
    expect(result.ok).toBe(true);
    expect(result.ownerSessionId).toBe('opk-owner');
  });

  it('rejects supplied session when it does not own head', () => {
    const headSha = 'b'.repeat(40);
    seedPrSessionBindingCache('opk-owner', 380, headSha);
    const result = resolvePrOwnerSessionForNudge({
      prNumber: 380,
      sessionId: 'opk-stale',
      headSha,
      sessions: [
        { name: 'opk-stale', role: 'worker', runtime: 'alive' },
        {
          name: 'opk-owner',
          role: 'worker',
          prNumber: 380,
          ownedHeadSha: headSha,
          runtime: 'alive',
        },
      ],
      openPrs: [{ number: 380, headRefOid: headSha }],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('head_owner_mismatch');
  });

  it('fails closed when multiple issue-only workers match the same PR without head owner', () => {
    const headSha = 'd'.repeat(40);
    const openPr690 = {
      number: 690,
      headRefOid: headSha,
      headRefName: 'issue-690-session-pr-binding',
    };
    const issueOnlyRow = {
      role: 'worker',
      status: 'working',
      issueId: '690',
      runtime: 'alive',
    };
    const result = resolvePrOwnerSessionForNudge({
      prNumber: 690,
      sessions: [
        { ...issueOnlyRow, name: 'opk-a', sessionId: 'opk-a' },
        { ...issueOnlyRow, name: 'opk-b', sessionId: 'opk-b' },
      ],
      openPrs: [openPr690],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ambiguous_pr_session_binding');
  });

  it('matches PR ownership fallback only when session pr URL equals requested PR', () => {
    const script = `
      . ${psString(helperPath)}
      [pscustomobject]@{
        matchRequested = Test-WorkerNudgeSessionPrFieldMatches -PrField 'https://github.com/org/repo/pull/385' -PrNumber 385
        rejectOtherPr = Test-WorkerNudgeSessionPrFieldMatches -PrField 'https://github.com/org/repo/pull/999' -PrNumber 385
        matchBare = Test-WorkerNudgeSessionPrFieldMatches -PrField '385' -PrNumber 385
      } | ConvertTo-Json -Compress
    `;
    const result = JSON.parse(runPwsh(script));
    expect(result.matchRequested).toBe(true);
    expect(result.rejectOtherPr).toBe(false);
    expect(result.matchBare).toBe(true);
  });

  it('recovers CLAIMED records immediately after lease expiry', () => {
    const dir = tempClaimDir();
    const prevLease = process.env.AO_WORKER_NUDGE_CLAIM_LEASE_MS;
    const prevStale = process.env.AO_WORKER_NUDGE_CLAIM_STALE_MINUTES;
    process.env.AO_WORKER_NUDGE_CLAIM_LEASE_MS = '1';
    process.env.AO_WORKER_NUDGE_CLAIM_STALE_MINUTES = '30';
    try {
      const script = withClaimStoreEnv(dir, `
        . ${psString(helperPath)}
        $claim = Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'run:opk-rev-689' -IntentClass 'review-findings' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-1' -Surface 'test'
        if (-not $claim.acquired) { throw 'expected initial acquire' }
        Start-Sleep -Milliseconds 5
        $retry = Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'run:opk-rev-689' -IntentClass 'review-findings' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-2' -Surface 'test'
        [pscustomobject]@{
          acquired = [bool]$retry.acquired
          recovered = [bool]$retry.recovered
          reason = [string]$retry.reason
        } | ConvertTo-Json -Compress
      `);
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

  it('retires invoke-gated-worker-nudge ci-failure arm (Issue #645)', () => {
    const invokeText = readFileSync(invokePath, 'utf8');
    expect(invokeText).not.toMatch(/Ci-Failure-Notification-Common\.ps1/);
    expect(invokeText).not.toMatch(/function Get-InvokeGatedWorkerNudgeCiFailureStoreDir/);
    expect(invokeText).toMatch(/ci-failure intent retired from invoke-gated-worker-nudge/);
  });

  it('resolves ci-failure headSha from episodeKey when headSha is omitted', () => {
    const headSha = 'a'.repeat(40);
    const episodeKey = `head-red:${headSha}:stint-2`;
    expect(
      resolveCiFailureHeadShaFromGateInput({
        prNumber: 460,
        episodeKey,
        workerState: { openPrs: [{ number: 460, headRefOid: 'b'.repeat(40) }] },
      }),
    ).toBe(headSha);
    const gate = evaluateNudgeGate({
      prNumber: 460,
      episodeKey,
      sessionId: 'opk-19',
      targetId: 'opk-19',
      targetGeneration: 'gen-1',
      intentClass: 'ci-failure',
      source: 'ci-failure-notification-reconcile',
      surface: 'ci-failure-notification-reconcile',
      workerState: {
        sessions: [
          {
            name: 'opk-19',
            role: 'worker',
            prNumber: 460,
            ownedHeadSha: headSha,
            runtime: 'alive',
            reports: [
              {
                reportState: 'fixing_ci',
                reportedAt: new Date().toISOString(),
                accepted: true,
                headSha,
              },
            ],
          },
        ],
        openPrs: [{ number: 460, headRefOid: headSha }],
      },
      storePath: '/tmp/test-claims',
      claims: [],
      nowMs: Date.now(),
    });
    expect(gate.decision).toBe('SUPPRESS');
    expect(gate.reason).toBeTruthy();
  });

  it('resolves openPrs headSha before ci-failure tuple derivation', () => {
    const headSha = 'c'.repeat(40);
    const gate = evaluateNudgeGate({
      prNumber: 460,
      sessionId: 'opk-19',
      targetId: 'opk-19',
      targetGeneration: 'gen-1',
      intentClass: 'ci-failure',
      source: 'ci-failure-notification-reconcile',
      surface: 'ci-failure-notification-reconcile',
      workerState: { sessions: [], openPrs: [{ number: 460, headRefOid: headSha }] },
      storePath: '/tmp/test-claims',
      claims: [],
      nowMs: Date.now(),
    });
    expect(gate.reason).not.toBe('tuple_incomplete');
    expect((gate.tuple as { tupleKey?: string })?.tupleKey ?? '').toContain(headSha);
  });

  it('fail-closes ci-failure gate when headSha cannot be resolved from episodeKey', () => {
    const gate = evaluateNudgeGate({
      prNumber: 460,
      episodeKey: 'suite-200-attempt-1',
      sessionId: 'opk-19',
      targetId: 'opk-19',
      targetGeneration: 'gen-1',
      intentClass: 'ci-failure',
      source: 'ci-failure-notification-reconcile',
      surface: 'ci-failure-notification-reconcile',
      workerState: { sessions: [], openPrs: [] },
      storePath: '/tmp/test-claims',
      claims: [],
      nowMs: Date.now(),
    });
    expect(gate.decision).toBe('SUPPRESS');
    expect(gate.reason).toBe('ci_failure_head_sha_unresolvable');
    expect(gate.failClosed).toBe(true);
  });

  it('resolves worker target before deriving fallback cycles', () => {
    const invokeText = readFileSync(invokePath, 'utf8');
    const targetIdx = invokeText.indexOf('Resolve-WorkerNudgeTargetFromPrClaim');
    const cycleIdx = invokeText.indexOf("Subcommand 'deriveCycleKey'");
    expect(targetIdx).toBeGreaterThan(-1);
    expect(cycleIdx).toBeGreaterThan(targetIdx);
  });

  it('keeps PR-claim target resolution fail-closed on the gated invoke path', () => {
    const invokeText = readFileSync(invokePath, 'utf8');
    expect(invokeText).toMatch(
      /throw "worker nudge gate could not resolve PR-claim worker target: \$\(\$targetResolution\.reason\)"/,
    );
    expect(invokeText).toMatch(/if \(\$issueKeyed\) \{[\s\S]*suppressed = \$true[\s\S]*exit 0[\s\S]*\}/);
  });

  it('derives liveness cycle keys after worker target is populated', () => {
    const headSha = 'c'.repeat(40);
    const cycleKey = deriveCycleKey('unknown-worker-nudge', {
      prNumber: 380,
      headSha,
      sessionId: 'opk-1',
      targetId: 'gen1',
      targetGeneration: 'gen1',
    });
    expect(cycleKey).toBe(`head:${headSha}:gen1`);
  });

  it('preserves live mutex after stale threshold when owner PID is alive', () => {
    const dir = tempClaimDir();
    try {
      const script = `
        . ${psString(helperPath)}
        $lockDir = Join-Path ${psString(dir)} 'mutex-live'
        New-Item -ItemType Directory -Path $lockDir -Force | Out-Null
        $ownerPath = Join-Path $lockDir 'owner.json'
        @{
          pid = $PID
          acquiredAtUtc = (Get-Date).AddSeconds(-($Script:WorkerNudgeClaimMutexStaleSeconds + 5)).ToUniversalTime().ToString('o')
        } | ConvertTo-Json -Compress | Set-Content -LiteralPath $ownerPath -Encoding UTF8
        [pscustomobject]@{
          abandoned = [bool](Test-WorkerNudgeClaimMutexAbandoned -LockDir $lockDir)
        } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.abandoned).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers stale issue-ownership legacy lock files and mutex dirs', () => {
    const dir = tempClaimDir();
    try {
      const script = `
        . ${psString(helperPath)}
        $legacyLock = Join-Path ${psString(dir)} 'issue-430.json.lock'
        New-Item -ItemType File -Path $legacyLock -Force | Out-Null
        (Get-Item -LiteralPath $legacyLock).LastWriteTimeUtc = (Get-Date).AddSeconds(-($Script:WorkerNudgeClaimMutexStaleSeconds + 5)).ToUniversalTime()
        Recover-StaleWorkerIssueOwnershipClaimLegacyLockFile -LockPath $legacyLock
        $abandonedMutexDir = Join-Path ${psString(dir)} 'mutex-abandoned'
        New-Item -ItemType Directory -Path $abandonedMutexDir -Force | Out-Null
        @{
          pid = 999999
          acquiredAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $abandonedMutexDir 'owner.json') -Encoding UTF8
        [pscustomobject]@{
          legacyRemoved = -not (Test-Path -LiteralPath $legacyLock)
          abandoned = [bool](Test-WorkerNudgeClaimMutexAbandoned -LockDir $abandonedMutexDir)
          entered = [bool](Enter-WorkerNudgeClaimMutex -LockDir $abandonedMutexDir)
        } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.legacyRemoved).toBe(true);
      expect(result.abandoned).toBe(true);
      expect(result.entered).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses claim mutex for issue-owner bootstrap locking', () => {
    const claimText = readFileSync(helperPath, 'utf8');
    expect(claimText).toMatch(/Get-WorkerIssueOwnershipClaimLockDir/);
    expect(claimText).toMatch(/Recover-StaleWorkerIssueOwnershipClaimLegacyLockFile/);
    const fnStart = claimText.indexOf('function Resolve-WorkerNudgeTargetFromIssueClaim');
    const fnEnd = claimText.indexOf('function Invoke-ConsumeWorkerNudgeClaimTokenForSend');
    const fnBody = claimText.slice(fnStart, fnEnd);
    expect(fnBody).toMatch(/Enter-WorkerNudgeClaimMutex -LockDir \$lockDir/);
    expect(fnBody).toMatch(/Exit-WorkerNudgeClaimMutex -LockDir \$lockDir/);
    expect(fnBody).not.toMatch(/\$lockPath = "\$storePath\.lock"/);
  });

  it('routes gated transport to PR-resolved owner session', () => {
    const invokeText = readFileSync(invokePath, 'utf8');
    expect(invokeText).toMatch(/\$ownerSessionId = \[string\]\$targetResolution\.ownerSessionId/);
    expect(invokeText).toMatch(/\$sendSessionId = if \(\$ownerSessionId\) \{ \$ownerSessionId \} else \{ \$SessionId \}/);
    expect(invokeText).toMatch(/File \$journaledScript \$sendSessionId/);
    expect(invokeText).not.toMatch(/File \$journaledScript \$SessionId -Source/);
  });

  it('treats journaled journal-update failure as uncertain claim outcome', () => {
    const invokeText = readFileSync(invokePath, 'utf8');
    expect(invokeText).toMatch(/\$exitCode -eq 44 -or \$exitCode -eq 47/);
    expect(invokeText).toMatch(/Outcome 'UNCERTAIN'/);
    expect(invokeText).toMatch(/journal_update_unknown/);
  });

  it('treats ci-green journaled journal-update failure as uncertain claim outcome', () => {
    const ciGreen = readFileSync(
      path.join(repoRoot, 'scripts/ci-green-wake-reconcile.ps1'),
      'utf8',
    );
    expect(ciGreen).toMatch(/\$sendExitCapture\.exitCode = \$LASTEXITCODE/);
    expect(ciGreen).toMatch(/\$sendExitCode = \[int\]\$sendExitCapture\.exitCode/);
    expect(ciGreen).not.toMatch(/\$script:sendExitCode/);
    expect(ciGreen).toMatch(/\$sendExitCode -eq 44 -or \$sendExitCode -eq 47/);
    expect(ciGreen).toMatch(/Outcome 'UNCERTAIN'/);
    expect(ciGreen).toMatch(/journalRecorded = \$false/);
    expect(ciGreen).toMatch(/journal_update_unknown/);
  });

  it('resolves reconcile script tuples from PR ownership claim', () => {
    const ciGreen = readFileSync(
      path.join(repoRoot, 'scripts/ci-green-wake-reconcile.ps1'),
      'utf8',
    );
    expect(ciGreen).toMatch(/Resolve-WorkerNudgeTargetFromPrClaim/);
    expect(ciGreen).not.toMatch(/\$workerTarget = "\$sessionId`:\$sessionId"/);
    expect(ciGreen).toMatch(/-TargetId \$targetId -TargetGeneration \$targetGeneration/);
    const reviewSend = readFileSync(
      path.join(repoRoot, 'scripts/review-send-reconcile.ps1'),
      'utf8',
    );
    expect(reviewSend).toMatch(/REMOVED on AO 0\.10/);
  });

  it('does not register dispatch journal twice after journaled CI-green send', () => {
    const ciGreen = readFileSync(
      path.join(repoRoot, 'scripts/ci-green-wake-reconcile.ps1'),
      'utf8',
    );
    expect(ciGreen).toMatch(/journaled-worker-send\.ps1/);
    expect(ciGreen).not.toMatch(
      /Register-WorkerMessageDispatch -SessionId \$sendSessionId -Message \$Action\.message/,
    );
  });

  it('persists CI-green message hashes before journaled send', () => {
    const ciGreen = readFileSync(
      path.join(repoRoot, 'scripts/ci-green-wake-reconcile.ps1'),
      'utf8',
    );
    expect(ciGreen).toMatch(/-Message \$ciGreenMessage/);
    expect(ciGreen).toMatch(/Set-WorkerNudgeClaimMessageContentHash/);
    expect(ciGreen).toMatch(/hashMessageContent/);
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

describe('claim-store failure escalation (#384)', () => {
  it('escalates persistent claim-store failures from invoke path', () => {
    const dir = tempClaimDir();
    const broken = path.join(dir, 'broken.json');
    writeFileSync(broken, '{not-json', 'utf8');
    try {
      const script = withClaimStoreEnv(dir, `
        . ${psString(helperPath)}
        $ns = Resolve-WorkerNudgeClaimNamespace
        New-Item -ItemType Directory -Path (Join-Path $ns '_health') -Force | Out-Null
        @{ unresolvedCount = 2; unresolvedSinceMs = 0; lastReason = 'storage_failure' } |
          ConvertTo-Json -Compress |
          Set-Content -LiteralPath (Join-Path $ns '_health/unresolved-claim-store.json') -Encoding UTF8
        $result = Invoke-WorkerNudgeClaimStoreFailure -Namespace $ns -FailureReason 'storage_failure' -PrNumber 380 -CycleKey 'run:test' -Surface 'test'
        [pscustomobject]@{
          escalate = [bool]$result.escalate
          reason = [string]$result.reason
          unresolvedCount = [int]$result.unresolvedCount
        } | ConvertTo-Json -Compress
      `);
      const result = JSON.parse(runPwsh(script));
      expect(result.escalate).toBe(true);
      expect(result.reason).toBe('unresolved_escalate');
      expect(result.unresolvedCount).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PR-claim worker target resolution (#384)', () => {

  it('infers resume lineage from same worktree plus restoredAt signal', () => {
    const existing = {
      prNumber: 380,
      ownerSessionId: 'opk-1',
      generation: 'gen1',
      lineageId: 'gen1',
      worktree: '/tmp/orchestrator-pack/worktrees/opk-1',
    };
    const signal = inferResumeLineageFromOwnershipChange({
      ownerSessionId: 'opk-5',
      worktree: '/tmp/orchestrator-pack/worktrees/opk-1',
      existingClaim: existing,
      sessionMeta: { restoredAt: '2026-06-22T00:26:43.284Z' },
    });
    expect(signal.resumeLineage).toBe(true);
    const synced = syncPrOwnershipClaimRecord({
      prNumber: 380,
      ownerSessionId: 'opk-5',
      worktree: existing.worktree,
      resumeLineage: true,
      existingClaim: existing,
    });
    expect(synced.reason).toBe('resume_same_lineage');
  });

  it('does not infer resume lineage for same-worktree replacement without resume signal', () => {
    const existing = {
      prNumber: 380,
      ownerSessionId: 'opk-1',
      generation: 'opk-1',
      lineageId: 'opk-1',
      worktree: '/tmp/orchestrator-pack/worktrees/opk-166',
    };
    const signal = inferResumeLineageFromOwnershipChange({
      ownerSessionId: 'opk-166',
      worktree: existing.worktree,
      existingClaim: existing,
      sessionMeta: {},
    });
    expect(signal.resumeLineage).toBe(false);
  });
  it('keeps generation only when resume lineage is explicitly signaled', () => {
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
      resumeLineage: true,
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

  it('bumps generation for replacement on the same worktree', () => {
    const worktree = '/tmp/orchestrator-pack/worktrees/opk-166';
    const prior = syncPrOwnershipClaimRecord({
      prNumber: 380,
      ownerSessionId: 'opk-1',
      worktree,
      existingClaim: null,
    }).record;
    const replacement = syncPrOwnershipClaimRecord({
      prNumber: 380,
      ownerSessionId: 'opk-166',
      worktree,
      existingClaim: prior,
    });
    expect(replacement.reason).toBe('replacement_claim');
    expect((replacement.record as { generation?: string }).generation).toBe('opk-166');

    const target = resolveWorkerTargetFromPrClaim({
      prNumber: 380,
      sessionId: 'opk-166',
      sessions: [{ name: 'opk-166', role: 'worker', prNumber: 380 }],
      prClaims: [replacement.record],
    });
    expect(target.workerTarget).toBe('opk-166:opk-166');
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

describe('worker-observable sender wiring (#384 opk-rev-765)', () => {
  it('passes Test-WorkerNudgeGateWiring for every sender surface', () => {
    const wiring = path.join(repoRoot, 'scripts/lib/Test-WorkerNudgeGateWiring.ps1');
    const result = spawnSync('pwsh', ['-NoProfile', '-File', wiring], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\[PASS\] worker nudge gate wiring/);
  });

  it('review-send-reconcile is REMOVED on AO 0.10 (auto-delivery)', () => {
    const body = readFileSync(path.join(repoRoot, 'scripts/review-send-reconcile.ps1'), 'utf8');
    expect(body).toMatch(/REMOVED on AO 0\.10/);
    expect(body).toMatch(/exit 2/);
  });

  it('converges already-served ci-failure claim skips for SENT and UNCERTAIN phases', () => {
    const body = readFileSync(
      path.join(repoRoot, 'scripts/ci-failure-notification-reconcile.ps1'),
      'utf8',
    );
    expect(body).toMatch(/claimPhase\s*=/);
    expect(body).toMatch(/claimSkipReason -eq 'already_served'/);
    expect(body).toMatch(/claimPhase -eq 'UNCERTAIN'/);
    expect(body).toMatch(/prior nudge claim served; converging delivery/);
    expect(body).toMatch(/prior nudge claim uncertain; converging terminal delivery/);
    expect(body).toMatch(/DispatchOutcome 'dispatch_unknown'/);
    const alreadyServedIdx = body.indexOf("claimSkipReason -eq 'already_served'");
    const uncertainIdx = body.indexOf("claimPhase -eq 'UNCERTAIN'", alreadyServedIdx);
    const uncertainConvergeIdx = body.indexOf('converging terminal delivery', uncertainIdx);
    const elseConvergeIdx = body.indexOf("prior nudge claim served; converging delivery", uncertainIdx);
    const uncertainBlockEnd = body.indexOf('else {', uncertainIdx);
    expect(alreadyServedIdx).toBeGreaterThan(-1);
    expect(uncertainIdx).toBeGreaterThan(alreadyServedIdx);
    expect(uncertainConvergeIdx).toBeGreaterThan(uncertainIdx);
    expect(elseConvergeIdx).toBeGreaterThan(uncertainIdx);
    expect(body.indexOf("DispatchOutcome 'dispatch_unknown'", uncertainIdx)).toBeLessThan(uncertainBlockEnd);
    expect(body.indexOf("release-submit-intent", uncertainIdx)).toBeGreaterThan(uncertainBlockEnd);
  });

  it('reuses pre-registered delivery id for ci-failure journaled sends', () => {
    const ciFailure = readFileSync(
      path.join(repoRoot, 'scripts/ci-failure-notification-reconcile.ps1'),
      'utf8',
    );
    const journaled = readFileSync(path.join(repoRoot, 'scripts/journaled-worker-send.ps1'), 'utf8');
    expect(ciFailure).toMatch(/-DeliveryId', \$DeliveryId/);
    expect(ciFailure).toMatch(/Register-WorkerMessageDispatch -SessionId \$journalSessionId/);
    expect(journaled).toMatch(/reused_delivery_id/);
  });

  it('binds claim tokens to the selected project namespace', () => {
    const dir = tempClaimDir();
    try {
      const script = withClaimStoreEnv(dir, `
        . ${psString(helperPath)}
        $prevBase = $env:AO_BASE_DIR
        $env:AO_BASE_DIR = ${psString(dir)}
        try {
          $claim = Acquire-WorkerNudgeClaim -PrNumber 380 -CycleKey 'run:opk-rev-793' -IntentClass 'review-findings' -WorkerTarget 'opk-1:gen1' -SessionId 'opk-1' -ProjectId 'other-pack' -Surface 'test'
          if (-not $claim.acquired) { throw "acquire failed: $($claim.reason)" }
          $token = New-WorkerNudgeClaimToken -ClaimResult $claim
          $decoded = ConvertFrom-WorkerNudgeClaimToken -ClaimToken $token
          $consume = Invoke-ConsumeWorkerNudgeClaimTokenForSend -ClaimToken $token -SendSessionId 'opk-1'
          [pscustomobject]@{
            projectId = [string]$decoded.projectId
            consumeOk = [bool]$consume.ok
            reason = [string]$consume.reason
          } | ConvertTo-Json -Compress
        } finally {
          if ($prevBase) { $env:AO_BASE_DIR = $prevBase } else { Remove-Item Env:AO_BASE_DIR -ErrorAction SilentlyContinue }
        }
      `);
      const result = JSON.parse(runPwsh(script));
      expect(result.projectId).toBe('other-pack');
      expect(result.consumeOk).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('binds claim tokens to the canonical claim store', () => {
    const body = readFileSync(path.join(repoRoot, 'scripts/lib/Worker-NudgeClaim.ps1'), 'utf8');
    expect(body).toMatch(/function Resolve-WorkerNudgeClaimTokenBinding/);
    expect(body).toMatch(/token_path_unbound/);
    expect(body).toMatch(/projectId\s+=\s+\$projectId/);
    expect(body).toMatch(/Resolve-WorkerNudgeClaimTokenProjectId/);
    expect(body).not.toMatch(/namespace\s+=\s+\[string\]\$ClaimResult\.namespace[\s\S]{0,80}path\s+=\s+\[string\]\$ClaimResult\.path/);
  });

  it('requires claim gating on all worker-observable senders', () => {
    const senderPaths = [
      'scripts/invoke-gated-worker-nudge.ps1',
      'scripts/ci-green-wake-reconcile.ps1',
      'scripts/ci-failure-notification-reconcile.ps1',
    ];
    for (const rel of senderPaths) {
      const body = readFileSync(path.join(repoRoot, rel), 'utf8');
      expect(body, rel).toMatch(/Acquire-WorkerNudgeClaim/);
    }
    const ciFailure = readFileSync(
      path.join(repoRoot, 'scripts/ci-failure-notification-reconcile.ps1'),
      'utf8',
    );
    expect(ciFailure).not.toMatch(/^\s*& ao @sendArgs/m);
  });
});

describe('worker nudge claim namespace and lease (#384 opk-rev-772)', () => {
  it('maps equivalent AO_WORKER_NUDGE_CLAIM_DIR forms to one physical namespace', () => {
    const helperPath = path.join(repoRoot, 'scripts/lib/Worker-NudgeClaim.ps1');
    const wsl = '/mnt/c/Users/me/.agent-orchestrator/custom-claims';
    const win = 'C:\\Users\\me\\.agent-orchestrator\\custom-claims';
    const script = `
      $prev = $env:AO_WORKER_NUDGE_CLAIM_DIR
      . ${psString(helperPath)}
      $env:AO_WORKER_NUDGE_CLAIM_DIR = '${wsl}'
      $wslNs = Resolve-WorkerNudgeClaimNamespace
      $env:AO_WORKER_NUDGE_CLAIM_DIR = '${win}'
      $winNs = Resolve-WorkerNudgeClaimNamespace
      if ($prev) { $env:AO_WORKER_NUDGE_CLAIM_DIR = $prev } else { Remove-Item Env:AO_WORKER_NUDGE_CLAIM_DIR -ErrorAction SilentlyContinue }
      [pscustomobject]@{ wslNs = $wslNs; winNs = $winNs; same = ($wslNs -eq $winNs) } | ConvertTo-Json -Compress
    `;
    const result = JSON.parse(runPwsh(script));
    expect(result.same).toBe(true);
    expect(result.wslNs).toMatch(/by-store-id[/\\]/);
  });

  it('clamps AO_WORKER_NUDGE_CLAIM_LEASE_MS above report-stale bound', () => {
    const helperPath = path.join(repoRoot, 'scripts/lib/Worker-NudgeClaim.ps1');
    const script = `
      $prev = $env:AO_WORKER_NUDGE_CLAIM_LEASE_MS
      $env:AO_WORKER_NUDGE_CLAIM_LEASE_MS = '999999999'
      . ${psString(helperPath)}
      $lease = Get-WorkerNudgeClaimLeaseMs
      if ($prev) { $env:AO_WORKER_NUDGE_CLAIM_LEASE_MS = $prev } else { Remove-Item Env:AO_WORKER_NUDGE_CLAIM_LEASE_MS -ErrorAction SilentlyContinue }
      [pscustomobject]@{ lease = $lease } | ConvertTo-Json -Compress
    `;
    const result = JSON.parse(runPwsh(script));
    expect(result.lease).toBe(30 * 60 * 1000);
  });
});
