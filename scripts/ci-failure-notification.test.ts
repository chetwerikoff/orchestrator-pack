import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  appendAudit,
  assertTerminalAction,
  buildAdoptionArtifact,
  bindReactionEvent,
  claimEpisodePreflight,
  compactRecords,
  computeReconcileHealth,
  decideCiFailureNotification,
  deriveEpisodeFromCiSource,
  episodeKeyDigest,
  evaluateEpisodeTerminal,
  evaluateHelperErrorEscalation,
  evaluatePreflightRevalidation,
  evaluateSnapshotCoherence,
  evaluateTargetApplySnapshot,
  expirePendingEpisode,
  interpretLegacyAuditLine,
  isEvaluationEligible,
  markObservableSendFailure,
  migrateLegacyEpisodeRecord,
  planReconcileTick,
  recordPendingEpisode,
  resolveConfig,
  resolveSubmittedDelivery,
  reserveSubmitIntent,
  scanFixtureSafety,
  terminalizeEpisode,
  buildCiSourceFromRequiredChecks,
  listIntentTokensFromStore,
  planCiFailureReactionRecords,
  preSendCiRedRecheck,
  validateInitGate,
  validateWorkerStateInput,
} from '../docs/ci-failure-notification.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'scripts/fixtures/ci-failure-notification');
const wrapperPath = path.join(repoRoot, 'scripts/ci-failure-notification.ps1');

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8')) as T;
}

const episode = {
  repo: 'chetwerikoff/orchestrator-pack',
  prNumber: 283,
  headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  redPeriod: 'suite-100-attempt-1',
  targetId: 'session-active-redacted',
  targetGeneration: 'generation-active-redacted',
};
const nextRedSameSha = { ...episode, redPeriod: 'suite-101-attempt-1' };
const supersededTarget = { ...episode, targetId: 'session-old-redacted', targetGeneration: 'generation-old-redacted' };
const newHead = { ...episode, headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', redPeriod: 'suite-200-attempt-1' };

function workerState(overrides: { status?: string; prNumber?: number; headSha?: string; targetId?: string; targetGeneration?: string; runtime?: string } = {}) {
  const golden = fixture<any>('worker-state-golden.json');
  const prNumber = overrides.prNumber ?? episode.prNumber;
  const headSha = overrides.headSha ?? episode.headSha;
  const targetId = overrides.targetId ?? episode.targetId;
  const targetGeneration = overrides.targetGeneration ?? episode.targetGeneration;
  const status = overrides.status ?? 'working';
  return {
    sessions: [
      {
        ...golden.sessions[0],
        name: targetId,
        role: 'worker',
        status,
        prNumber,
        ownedHeadSha: headSha,
        targetGeneration,
        sessionGeneration: targetGeneration,
        ...(overrides.runtime !== undefined ? { runtime: overrides.runtime } : {}),
        reports: [{ reportState: status, reportedAt: '2026-06-18T12:00:00.000Z' }],
      },
    ],
    openPrs: [{ number: prNumber, headRefOid: headSha }],
  };
}

function decision(input: any) {
  return decideCiFailureNotification({
    episode,
    workerState: workerState({ status: 'working' }),
    ...input,
  });
}

function runWrapper(mode: string, input: unknown) {
  const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapperPath, '-Mode', mode], {
    cwd: repoRoot,
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`wrapper failed ${result.status}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

function tempStore() {
  return mkdtempSync(path.join(tmpdir(), 'ci-failure-notification-'));
}

describe('CI failure notification predicate (Issue #283 regressions)', () => {
  it('suppresses duplicate when ci-failed reaction already sent to active target', () => {
    const event = fixture<any>('reaction-action-succeeded.json');
    const result = decision({ reactionEvents: [event] });
    expect(result.terminal_action).toBe('SUPPRESS');
    expect(result.reason).toBe('reaction_ci_failed_sent_to_active_target');
  });


  it('suppresses when another owner intent token is present without excludeOwnDigest', () => {
    const otherOwnerToken = {
      episode,
      digest: episodeKeyDigest(episode),
      owner: 'other-sender',
      status: 'claimed',
    };
    const result = decision({ reactionEvents: [], intentTokens: [otherOwnerToken] });
    expect(result.terminal_action).toBe('SUPPRESS');
    expect(result.reason).toBe('orchestrator_intent_token_present');
  });

  it('pre-send CI recheck rejects when required CI is no longer red', () => {
    const recheck = preSendCiRedRecheck(episode, {
      openPrs: [{ number: episode.prNumber, headRefOid: episode.headSha }],
      ciChecksByPr: [{ prNumber: episode.prNumber, checks: [{ name: 'Run pack contract tests', state: 'SUCCESS' }] }],
      requiredCheckNamesByPr: [{ prNumber: episode.prNumber, requiredCheckNames: ['Run pack contract tests'] }],
      requiredCheckLookupFailedByPr: [],
    });
    expect(recheck.ok).toBe(false);
    expect(recheck.reason).toMatch(/^ci_not_red:/);
  });

  it('lists intent tokens from store directory', () => {
    const dir = tempStore();
    try {
      mkdirSync(path.join(dir, 'tokens'), { recursive: true });
      const token = { episode, digest: episodeKeyDigest(episode), owner: 'orchestrator', status: 'claimed' };
      const tokenPath = path.join(dir, 'tokens', `${episodeKeyDigest(episode)}.json`);
      writeFileSync(tokenPath, JSON.stringify(token));
      const tokens = listIntentTokensFromStore(dir);
      expect(tokens).toHaveLength(1);
      expect((tokens[0] as { owner?: string }).owner).toBe('orchestrator');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends when reaction absent, worker idle, no token', () => {
    const result = decision({ reactionEvents: [], intentTokens: [] });
    expect(result.terminal_action).toBe('SEND');
    expect(result.reason).toBe('no_suppressor');
  });

  it('does not let earlier red period suppress later red period on same SHA', () => {
    const priorEvent = fixture<any>('reaction-action-succeeded.json');
    const result = decideCiFailureNotification({
      episode: nextRedSameSha,
      workerState: workerState(),
      reactionEvents: [priorEvent],
      intentTokens: [{ episode, status: 'claimed' }],
    });
    expect(result.terminal_action).toBe('SEND');
  });

  it('does not suppress on superseded session reaction or token', () => {
    const event = { ...fixture<any>('reaction-action-succeeded.json'), episode: supersededTarget };
    const result = decision({ reactionEvents: [event], intentTokens: [{ episode: supersededTarget, status: 'claimed' }] });
    expect(result.terminal_action).toBe('SEND');
  });

  it('safe-suppresses on CI source disagreement', () => {
    const result = decision({ ciSourceEquivalence: { disagreement: true } });
    expect(result.terminal_action).toBe('SUPPRESS');
  });
});

describe('CI failure live worker suppressor (Issue #342)', () => {
  it('suppresses fixing_ci from live PR owner without episode key in report', () => {
    const result = decision({
      workerState: workerState({ status: 'fixing_ci' }),
      workerReports: [{ state: 'fixing_ci' }],
    });
    expect(result.terminal_action).toBe('SUPPRESS');
    expect(result.reason).toBe('suppressed-live-worker');
    expect(result.audit!.phase).toBe('terminal');
  });

  it('sends for idle live owner (row 3)', () => {
    expect(decision({ workerState: workerState({ status: 'working' }) }).terminal_action).toBe('SEND');
  });

  it('sends for working and pr_created (rows 4-5)', () => {
    expect(decision({ workerState: workerState({ status: 'working' }) }).terminal_action).toBe('SEND');
    expect(decision({ workerState: workerState({ status: 'pr_created' }) }).terminal_action).toBe('SEND');
  });

  it('sends when worker moved to ready_for_review on still-red CI (row 6)', () => {
    expect(decision({ workerState: workerState({ status: 'ready_for_review' }) }).terminal_action).toBe('SEND');
  });

  it('abandons when cleanup zombie fails liveness (row 7)', () => {
    const result = decision({ workerState: workerState({ status: 'cleanup' }) });
    expect(result.terminal_action).toBe('SUPPRESS');
    expect(result.reason).toBe('abandoned-no-live-owner');
  });

  it('abandons when no session owns PR (row 8)', () => {
    const ws = workerState();
    ws.sessions = [];
    const result = decision({ workerState: ws });
    expect(result.terminal_action).toBe('SUPPRESS');
    expect(result.reason).toBe('abandoned-no-live-owner');
  });

  it('hard-fails on missing workerState (row 11)', () => {
    const result = decideCiFailureNotification({ episode });
    expect(result.hard_failure).toBe(true);
    expect(result.audit!.phase).toBe('diagnostic');
    expect(result.terminal_action).toBeUndefined();
  });

  it('hard-fails on incompatible workerState shape', () => {
    const result = decideCiFailureNotification({ episode, workerState: { sessions: [] } });
    expect(result.hard_failure).toBe(true);
    expect(result.diagnostic!.error_kind).toBe('incompatible_worker_state_shape');
  });

  it('self-dedup: first idle episode is SEND not suppressed-dedup against own record', () => {
    const digest = episodeKeyDigest(episode);
    const result = decision({ excludeOwnDigest: digest, reactionEvents: [], intentTokens: [] });
    expect(result.terminal_action).toBe('SEND');
  });

  it('abandoned-superseded when PR head advances (row 13)', () => {
    const ws = workerState();
    ws.openPrs = [{ number: episode.prNumber, headRefOid: 'cccccccccccccccccccccccccccccccccccccccc' }];
    const result = decision({ workerState: ws });
    expect(result.terminal_action).toBe('SUPPRESS');
    expect(result.reason).toBe('abandoned-superseded');
  });

  it('snapshot skew yields hard failure retry', () => {
    const result = evaluateEpisodeTerminal({
      episode,
      workerState: workerState(),
      headShaFirst: episode.headSha,
      headShaSecond: 'dddddddddddddddddddddddddddddddddddddddd',
    });
    expect(result.hard_failure).toBe(true);
  });
});

describe('episode lifecycle outbox (Issue #342)', () => {
  it('records pending episode with phase=record audit', () => {
    const dir = tempStore();
    try {
      const recorded = recordPendingEpisode({ storeDir: dir, episode, nowMs: 1_000_000 });
      expect(recorded.recorded).toBe(true);
      expect(recorded.audit!.phase).toBe('record');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks evaluation in enqueue tick (row 10)', () => {
    const dir = tempStore();
    try {
      const recorded = recordPendingEpisode({ storeDir: dir, episode, nowMs: 1_000_000, enqueueTickId: 'tick-a' });
      const eligibility = isEvaluationEligible(recorded.record, 1_000_000 + 1000, { enqueueTickId: 'tick-a' });
      expect(eligibility.eligible).toBe(false);
      expect(eligibility.reason).toBe('enqueue_tick_boundary');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preflight revalidation suppresses when worker enters fixing_ci before intent (row 15)', () => {
    const dir = tempStore();
    try {
      recordPendingEpisode({ storeDir: dir, episode, nowMs: 1_000_000 });
      claimEpisodePreflight({ storeDir: dir, episode, claimOwner: 'test' });
      const result = evaluatePreflightRevalidation({
        storeDir: dir,
        episode,
        workerState: workerState({ status: 'fixing_ci' }),
      });
      expect(result.action).toBe('suppressed');
      expect(result.terminal!.audit!.reason).toBe('suppressed-live-worker');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('post-intent recovery resolves delivery never reclassifies to suppression (row 16)', () => {
    const dir = tempStore();
    try {
      recordPendingEpisode({ storeDir: dir, episode, nowMs: 1_000_000 });
      claimEpisodePreflight({ storeDir: dir, episode, claimOwner: 'test' });
      reserveSubmitIntent({ storeDir: dir, episode });
      const resolved = resolveSubmittedDelivery({ storeDir: dir, episode, acknowledged: true });
      expect(resolved.terminalReason).toBe('sent');
      const retry = evaluatePreflightRevalidation({
        storeDir: dir,
        episode,
        workerState: workerState({ status: 'fixing_ci' }),
      });
      expect(retry.action).toBe('not_claimed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('abandoned-expired correlates to report-stale without duplicate nudge (row 12)', () => {
    const dir = tempStore();
    try {
      recordPendingEpisode({ storeDir: dir, episode, nowMs: 0, config: { pendingExpiryMs: 1000 } });
      const expired = expirePendingEpisode({ storeDir: dir, episode, nowMs: 5000 });
      expect(expired.audit!.reason).toBe('abandoned-expired');
      expect(expired.audit!.diagnostic!.backstop_handoff).toBe('report-stale');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('atomic claim: concurrent claims yield one winner', () => {
    const dir = tempStore();
    try {
      recordPendingEpisode({ storeDir: dir, episode, nowMs: 1_000_000 });
      const a = claimEpisodePreflight({ storeDir: dir, episode, claimOwner: 'a' });
      const b = claimEpisodePreflight({ storeDir: dir, episode, claimOwner: 'b' });
      expect(a.claimed).toBe(true);
      expect(b.claimed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('freshness SLA config is bounded', () => {
    const config = resolveConfig({ reconcileIntervalMs: 60_000 });
    expect(config.maxEligibleEvaluationAgeMs).toBeLessThanOrEqual(3 * config.reconcileIntervalMs!);
    expect(config.maxEligibleEvaluationAgeMs).toBeLessThan(30 * 60 * 1000);
  });

  it('reconcile health surfaces degraded pending age', () => {
    const health = computeReconcileHealth({
      pendingRecords: [{ state: 'pending', recordedAtMs: Date.now() - 500_000, terminalReason: null }],
      config: resolveConfig({ maxEligibleEvaluationAgeMs: 1000 }),
    });
    expect(health.degraded).toBe(true);
    expect(health.pendingCount).toBe(1);
  });
});

describe('fixtures, wrapper, and legacy compatibility', () => {
  it('golden worker-state fixture passes redaction check', () => {
    const golden = fixture('worker-state-golden.json');
    expect(scanFixtureSafety(golden)).toEqual({ ok: true, findings: [] });
    expect(validateWorkerStateInput(golden).ok).toBe(true);
  });

  it('legacy audit without phase stays authoritative-terminal', () => {
    const legacy = interpretLegacyAuditLine({ terminal_action: 'SUPPRESS', reason: 'suppressed-dedup' });
    expect(legacy.authoritative).toBe(true);
    expect(legacy.legacy).toBe(true);
  });

  it('migrates in-flight legacy episode without duplicate ping', () => {
    const migrated = migrateLegacyEpisodeRecord({ episode, status: 'claimed', claimedAtUtc: '2026-06-01T00:00:00Z' });
    expect(migrated.state).toBe('claimed');
    expect(migrated.legacy).toBe(true);
  });

  it('init gate requires worker state wiring and durable submit ack', () => {
    expect(validateInitGate({ workerStateInputConfigured: false, durableSubmitAckConfigured: true }).reactionEnabled).toBe(false);
    expect(validateInitGate({ workerStateInputConfigured: true, durableSubmitAckConfigured: true, reactionRecordConfigured: true }).reactionEnabled).toBe(true);
    expect(validateInitGate({ workerStateInputConfigured: true, durableSubmitAckConfigured: true, reactionRecordConfigured: false }).reactionEnabled).toBe(false);
  });

  it('wrapper decide path returns live-worker suppression', () => {
    const result = runWrapper('decide', {
      episode,
      workerState: workerState({ status: 'fixing_ci' }),
    });
    expect(result.terminal_action).toBe('SUPPRESS');
    expect(result.reason).toBe('suppressed-live-worker');
  });

  it('wrapper record mode enqueues pending episode', () => {
    const dir = tempStore();
    try {
      const result = runWrapper('record', { storeDir: dir, episode, nowMs: Date.now() });
      expect(result.recorded).toBe(true);
      expect(result.audit!.phase).toBe('record');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects terminal values outside SEND | SUPPRESS', () => {
    expect(() => assertTerminalAction('NO-MATCH')).toThrow(/invalid terminal_action/);
  });

  it('writes audit records and adoption artifact', () => {
    const dir = tempStore();
    try {
      const result = decision({ reactionEvents: [fixture('reaction-action-succeeded.json')] });
      const written = appendAudit({ storeDir: dir, audit: result.audit }) as any;
      expect(written.ok).toBe(true);
      const artifact = buildAdoptionArtifact({
        ruleText: 'CI FAILURE DISCIPLINE',
        repoIdentity: 'chetwerikoff/orchestrator-pack',
        gitSha: 'dddddddddddddddddddddddddddddddddddddddd',
        wrapperPath,
        helperContent: readFileSync(path.join(repoRoot, 'docs/ci-failure-notification.mjs'), 'utf8'),
        dryRunVerdict: result,
      }) as any;
      expect(artifact.dryRunVerdict).toBe('SUPPRESS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('intent token claim remains atomic across concurrent wrapper calls', () => {
    const dir = tempStore();
    try {
      const script = `
        $wrapper = '${wrapperPath.replaceAll("'", "''")}'
        $payload = @{ storeDir='${dir.replaceAll("'", "''")}'; episode = @{
          repo='${episode.repo}'; prNumber=${episode.prNumber}; headSha='${episode.headSha}'; redPeriod='${episode.redPeriod}'; targetId='${episode.targetId}'; targetGeneration='${episode.targetGeneration}'
        }} | ConvertTo-Json -Compress
        $jobs = 1..2 | ForEach-Object { Start-Job -ArgumentList $wrapper,$payload -ScriptBlock { param($wrapper,$payload) $payload | pwsh -NoProfile -ExecutionPolicy Bypass -File $wrapper -Mode claim } }
        $rows = $jobs | Receive-Job -Wait -AutoRemoveJob | ForEach-Object { $_ | ConvertFrom-Json }
        $rows | ConvertTo-Json -Compress -Depth 10
      `;
      const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { cwd: repoRoot, encoding: 'utf8' });
      const rows = JSON.parse(result.stdout.trim());
      expect(rows.filter((r: any) => r.claimed)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('delivery-failed terminalizes on retry exhaustion', () => {
    const dir = tempStore();
    try {
      recordPendingEpisode({ storeDir: dir, episode, nowMs: 1_000_000 });
      claimEpisodePreflight({ storeDir: dir, episode, claimOwner: 'test' });
      reserveSubmitIntent({ storeDir: dir, episode });
      const failed = resolveSubmittedDelivery({ storeDir: dir, episode, retryExhausted: true });
      expect(failed.terminalReason).toBe('delivery-failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });


  it('plan reconcile tick expires stale pending before evaluate', () => {
    const dir = tempStore();
    try {
      const shortConfig = { pendingExpiryMs: 1000, reconcileIntervalMs: 1000 };
      recordPendingEpisode({ storeDir: dir, episode, nowMs: 1, config: shortConfig });
      const plan = planReconcileTick({ storeDir: dir, nowMs: 2000, enqueueTickId: 'tick-expire', config: shortConfig });
      expect(plan.actions!.some((a: any) => a.type === 'evaluate')).toBe(false);
      expect(plan.actions!.some((a: any) => a.type === 'expire')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('plan reconcile tick schedules recover_in_flight for claimed episodes', () => {
    const dir = tempStore();
    try {
      recordPendingEpisode({ storeDir: dir, episode, nowMs: 1_000_000 });
      claimEpisodePreflight({ storeDir: dir, episode, claimOwner: 'stale-tick' });
      const plan = planReconcileTick({ storeDir: dir, nowMs: Date.now(), enqueueTickId: 'tick-recover' });
      expect(plan.actions!.some((a: any) => a.type === 'recover_in_flight' && a.state === 'claimed')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('wrapper lifecycle mode returns hard_failure on helper timeout', () => {
    const dir = tempStore();
    try {
      recordPendingEpisode({ storeDir: dir, episode, nowMs: 1_000_000 });
      claimEpisodePreflight({ storeDir: dir, episode, claimOwner: 'timeout-test' });
      const result = spawnSync(
        'pwsh',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapperPath, '-Mode', 'preflight-revalidate', '-TimeoutSeconds', '0'],
        {
          cwd: repoRoot,
          input: JSON.stringify({ storeDir: dir, episode, workerState: workerState() }),
          encoding: 'utf8',
        },
      );
      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout.trim());
      expect(payload.hard_failure).toBe(true);
      expect(payload.action).toBe('hard_failure');
      expect(payload.terminal_action).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('plan reconcile tick includes evaluate and expire actions', () => {
    const dir = tempStore();
    try {
      recordPendingEpisode({ storeDir: dir, episode, nowMs: Date.now() - 120_000, enqueueTickId: 'enqueue' });
      const plan = planReconcileTick({ storeDir: dir, nowMs: Date.now(), enqueueTickId: 'tick-2' });
      expect(plan.actions!.some((a: any) => a.type === 'evaluate')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
