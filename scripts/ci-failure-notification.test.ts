import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  markSendIssued,
  markSendDelivered,
  releaseSubmitIntent,
  scanFixtureSafety,
  terminalizeEpisode,
  buildCiSourceFromRequiredChecks,
  buildRedFailureFingerprint,
  buildRedFailingRunMap,
  resolveRedPeriodAggregateId,
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

  it('does not suppress on notify-only ci-failed reaction events', () => {
    const notifyEvent = {
      ...fixture<any>('reaction-action-succeeded.json'),
      data: { action: 'notify', reactionKey: 'ci-failed' },
    };
    const result = decision({ reactionEvents: [notifyEvent], intentTokens: [] });
    expect(result.terminal_action).not.toBe('SUPPRESS');
    expect(result.reason).not.toBe('reaction_ci_failed_sent_to_active_target');
  });

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


  it('pre-send CI recheck rejects superseded notification target', () => {
    const recheck = preSendCiRedRecheck(episode, {
      openPrs: [{ number: episode.prNumber, headRefOid: episode.headSha }],
      sessions: workerState({ targetId: 'session-new', targetGeneration: 'generation-new' }).sessions,
      ciChecksByPr: [{ prNumber: episode.prNumber, checks: [{ name: 'Run pack contract tests', state: 'FAILURE' }] }],
      requiredCheckNamesByPr: [{ prNumber: episode.prNumber, requiredCheckNames: ['Run pack contract tests'] }],
      requiredCheckLookupFailedByPr: [],
    });
    expect(recheck.ok).toBe(false);
    expect(recheck.reason).toBe('abandoned-superseded');
  });

  it('mark-send-delivered subcommand is registered on helper CLI map', () => {
    const dir = tempStore();
    try {
      recordPendingEpisode({ storeDir: dir, episode, nowMs: 1_000_000 });
      claimEpisodePreflight({ storeDir: dir, episode, claimOwner: 'test' });
      reserveSubmitIntent({ storeDir: dir, episode });
      const result = spawnSync(
        'node',
        [path.join(repoRoot, 'docs/ci-failure-notification.mjs'), 'mark-send-delivered'],
        {
          cwd: repoRoot,
          input: JSON.stringify({ storeDir: dir, episode }),
          encoding: 'utf8',
        },
      );
      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout.trim());
      expect(payload.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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


  it('preflight revalidation suppresses exact-key intent token from another sender', () => {
    const dir = tempStore();
    try {
      recordPendingEpisode({ storeDir: dir, episode, nowMs: 1_000_000 });
      claimEpisodePreflight({ storeDir: dir, episode, claimOwner: 'test' });
      const result = evaluatePreflightRevalidation({
        storeDir: dir,
        episode,
        workerState: workerState(),
        intentTokens: [{ episode, digest: episodeKeyDigest(episode), owner: 'reaction', status: 'claimed' }],
      });
      expect(result.action).toBe('suppressed');
      expect((result.decision as { legacy_reason?: string }).legacy_reason).toBe('orchestrator_intent_token_present');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('release submit intent returns claimed state for ao send retry', () => {
    const dir = tempStore();
    try {
      recordPendingEpisode({ storeDir: dir, episode, nowMs: 1_000_000 });
      claimEpisodePreflight({ storeDir: dir, episode, claimOwner: 'test' });
      reserveSubmitIntent({ storeDir: dir, episode });
      markSendIssued({ storeDir: dir, episode });
      const released = releaseSubmitIntent({ storeDir: dir, episode });
      expect(released.ok).toBe(true);
      expect((released.record as { state?: string }).state).toBe('claimed');
      expect((released.record as { sendIssuedAtMs?: number | null }).sendIssuedAtMs).toBeNull();
      const reentry = reserveSubmitIntent({ storeDir: dir, episode });
      expect(reentry.reentry).not.toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });


  it('keeps the same red period when CI re-fails between polls without observed green', () => {
    const dir = tempStore();
    try {
      const headSha = episode.headSha;
      const base = {
        storeDir: dir,
        repo: episode.repo,
        openPrs: [{ number: episode.prNumber, headRefOid: headSha }],
        sessions: workerState().sessions,
        requiredCheckNamesByPr: [{ prNumber: episode.prNumber, requiredCheckNames: ['Run pack contract tests'] }],
        requiredCheckLookupFailedByPr: [],
      };
      const firstChecks = [{ name: 'Run pack contract tests', state: 'FAIL', startedAt: '2026-06-18T10:00:00Z', link: 'https://example/run/1' }];
      const firstPlan = planCiFailureReactionRecords({ ...base, ciChecksByPr: [{ prNumber: episode.prNumber, checks: firstChecks }] });
      expect(firstPlan.records).toHaveLength(1);
      recordPendingEpisode({ storeDir: dir, episode: firstPlan.records![0].episode, nowMs: 1_000_000 });
      terminalizeEpisode({
        storeDir: dir,
        episode: firstPlan.records![0].episode,
        terminalReason: 'sent',
        terminalAction: 'SEND',
      });
      const secondChecks = [{ name: 'Run pack contract tests', state: 'FAIL', startedAt: '2026-06-18T10:05:00Z', link: 'https://example/run/2' }];
      const secondPlan = planCiFailureReactionRecords({ ...base, ciChecksByPr: [{ prNumber: episode.prNumber, checks: secondChecks }] });
      expect(secondPlan.records).toHaveLength(1);
      expect(secondPlan.records![0].episode.redPeriod).toBe(firstPlan.records![0].episode.redPeriod);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records green transitions while planning non-red PR heads', () => {
    const dir = tempStore();
    try {
      const headSha = episode.headSha;
      const ctx = { storeDir: dir, repo: episode.repo, prNumber: episode.prNumber, headSha };
      const firstRed = resolveRedPeriodAggregateId({ ...ctx, aggregateStatus: 'red' });
      resolveRedPeriodAggregateId({ ...ctx, aggregateStatus: 'green' });
      const plan = planCiFailureReactionRecords({
        storeDir: dir,
        repo: episode.repo,
        openPrs: [{ number: episode.prNumber, headRefOid: headSha }],
        sessions: workerState().sessions,
        ciChecksByPr: [{ prNumber: episode.prNumber, checks: [{ name: 'Run pack contract tests', state: 'SUCCESS' }] }],
        requiredCheckNamesByPr: [{ prNumber: episode.prNumber, requiredCheckNames: ['Run pack contract tests'] }],
        requiredCheckLookupFailedByPr: [],
      });
      expect(plan.records).toHaveLength(0);
      const secondRed = resolveRedPeriodAggregateId({ ...ctx, aggregateStatus: 'red' });
      expect(secondRed).not.toBe(firstRed);
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



  it('keeps the same red stint when a failing check reruns without leaving red', () => {
    const dir = tempStore();
    try {
      const ctx = { storeDir: dir, repo: episode.repo, prNumber: episode.prNumber, headSha: episode.headSha };
      const runs1 = buildRedFailingRunMap(
        [{ name: 'CI', conclusion: 'failure', startedAt: '2026-06-18T10:00:00Z', link: 'https://example/run/1' }],
        { requiredCheckNames: ['CI'] },
      );
      const first = resolveRedPeriodAggregateId({ ...ctx, aggregateStatus: 'red', redFailingRuns: runs1 });
      const runs2 = buildRedFailingRunMap(
        [{ name: 'CI', conclusion: 'failure', startedAt: '2026-06-18T10:05:00Z', link: 'https://example/run/2' }],
        { requiredCheckNames: ['CI'] },
      );
      const second = resolveRedPeriodAggregateId({ ...ctx, aggregateStatus: 'red', redFailingRuns: runs2 });
      expect(second).toBe(first);
      resolveRedPeriodAggregateId({ ...ctx, aggregateStatus: 'green' });
      const afterGreen = resolveRedPeriodAggregateId({ ...ctx, aggregateStatus: 'red', redFailingRuns: runs2 });
      expect(afterGreen).not.toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps check churn out of red-period identity', () => {
    const dir = tempStore();
    try {
      const ctx = { storeDir: dir, repo: episode.repo, prNumber: episode.prNumber, headSha: episode.headSha };
      const runs1 = buildRedFailingRunMap(
        [{ name: 'CI', conclusion: 'failure', workflow: 'wf1', link: 'l1', startedAt: '1' }],
        { requiredCheckNames: ['CI'] },
      );
      const first = resolveRedPeriodAggregateId({ ...ctx, aggregateStatus: 'red', redFailingRuns: runs1 });
      const runs2 = buildRedFailingRunMap(
        [
          { name: 'CI', conclusion: 'failure', workflow: 'wf1', link: 'l1', startedAt: '1' },
          { name: 'Lint', conclusion: 'failure', workflow: 'wf2', link: 'l2', startedAt: '2' },
        ],
        { requiredCheckNames: ['CI', 'Lint'] },
      );
      const second = resolveRedPeriodAggregateId({ ...ctx, aggregateStatus: 'red', redFailingRuns: runs2 });
      expect(second).toBe(first);
      resolveRedPeriodAggregateId({ ...ctx, aggregateStatus: 'green' });
      const afterGreen = resolveRedPeriodAggregateId({ ...ctx, aggregateStatus: 'red', redFailingRuns: runs1 });
      expect(afterGreen).not.toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks send delivered for post-intent recovery without false resend skip', () => {
    const dir = tempStore();
    try {
      recordPendingEpisode({ storeDir: dir, episode, nowMs: 1_000_000 });
      claimEpisodePreflight({ storeDir: dir, episode, claimOwner: 'test' });
      reserveSubmitIntent({ storeDir: dir, episode });
      const beforeSend = reserveSubmitIntent({ storeDir: dir, episode });
      expect(beforeSend.reentry).toBe(true);
      expect((beforeSend.record as { sendDeliveredAtMs?: number }).sendDeliveredAtMs).toBeUndefined();
      markSendDelivered({ storeDir: dir, episode });
      const afterSend = reserveSubmitIntent({ storeDir: dir, episode });
      expect((afterSend.record as { sendDeliveredAtMs?: number }).sendDeliveredAtMs).toBeTruthy();
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

  it('reclaims orphaned preflight claim files when episode record is still pending', () => {
    const dir = tempStore();
    try {
      recordPendingEpisode({ storeDir: dir, episode, nowMs: 1_000_000 });
      const digest = episodeKeyDigest(episode);
      const claimPath = path.join(dir, 'claims', `${digest}.json`);
      mkdirSync(path.dirname(claimPath), { recursive: true });
      writeFileSync(claimPath, `${JSON.stringify({
        schema: 'ci-failure-notification.claim.v1',
        digest,
        claimOwner: 'stale-tick',
        claimedAtMs: 1,
        claimedAtUtc: '2026-06-01T00:00:00.000Z',
      })}
`);
      const result = claimEpisodePreflight({ storeDir: dir, episode, claimOwner: 'new-tick', nowMs: 1_000_000 + 200_000 });
      expect(result.claimed).toBe(true);
      expect(result.orphanReclaimed).toBe(true);
      expect((result.record as { state?: string }).state).toBe('claimed');
      expect((result.record as { claimOwner?: string }).claimOwner).toBe('new-tick');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not reclaim an active preflight claim while episode record is still pending', () => {
    const dir = tempStore();
    try {
      recordPendingEpisode({ storeDir: dir, episode, nowMs: 1_000_000 });
      const digest = episodeKeyDigest(episode);
      const claimPath = path.join(dir, 'claims', `${digest}.json`);
      mkdirSync(path.dirname(claimPath), { recursive: true });
      const nowMs = 1_000_000;
      writeFileSync(claimPath, `${JSON.stringify({
        schema: 'ci-failure-notification.claim.v1',
        digest,
        claimOwner: 'active-tick',
        claimedAtMs: nowMs,
        claimedAtUtc: new Date(nowMs).toISOString(),
      })}
`);
      const result = claimEpisodePreflight({ storeDir: dir, episode, claimOwner: 'new-tick', nowMs: nowMs + 1_000 });
      expect(result.claimed).toBe(false);
      expect(result.reason).toBe('claim_held_by_other');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records sendIssued on reentry without treating it as delivery evidence', () => {
    const dir = tempStore();
    try {
      recordPendingEpisode({ storeDir: dir, episode, nowMs: 1_000_000 });
      claimEpisodePreflight({ storeDir: dir, episode, claimOwner: 'test' });
      reserveSubmitIntent({ storeDir: dir, episode });
      markSendIssued({ storeDir: dir, episode });
      const reentry = reserveSubmitIntent({ storeDir: dir, episode });
      expect(reentry.reentry).toBe(true);
      expect((reentry.record as { sendIssuedAtMs?: number }).sendIssuedAtMs).toBeTruthy();
      expect((reentry.record as { sendDeliveredAtMs?: number }).sendDeliveredAtMs).toBeUndefined();
      expect((reentry.record as { state?: string }).state).toBe('submit-intent-reserved');
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

  it('blocks evaluation when freshness SLA exceeded', () => {
    const dir = tempStore();
    try {
      const config = resolveConfig({ reconcileIntervalMs: 60_000, maxEligibleEvaluationAgeMs: 5_000, pendingExpiryMs: 600_000 });
      const recorded = recordPendingEpisode({ storeDir: dir, episode, nowMs: 1_000_000, config, enqueueTickId: 'tick-old' });
      const tooLate = isEvaluationEligible(recorded.record, 1_000_000 + 6_000, { config });
      expect(tooLate.eligible).toBe(false);
      expect(tooLate.reason).toBe('freshness_sla_exceeded');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('plan reconcile tick expires freshness-SLA exceeded pending before evaluate', () => {
    const dir = tempStore();
    try {
      const config = resolveConfig({ reconcileIntervalMs: 60_000, maxEligibleEvaluationAgeMs: 5_000, pendingExpiryMs: 600_000 });
      recordPendingEpisode({ storeDir: dir, episode, nowMs: 1_000_000, config, enqueueTickId: 'tick-old' });
      const plan = planReconcileTick({ storeDir: dir, nowMs: 1_000_000 + 6_000, enqueueTickId: 'tick-new', config });
      const expireAction = plan.actions!.find((a: any) => a.type === 'expire' && a.freshnessSla);
      expect(expireAction).toBeTruthy();
      expect(plan.actions!.some((a: any) => a.type === 'evaluate')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('terminalizeEpisode persists terminal audit records', () => {
    const dir = tempStore();
    try {
      recordPendingEpisode({ storeDir: dir, episode, nowMs: 1_000_000 });
      claimEpisodePreflight({ storeDir: dir, episode, claimOwner: 'test' });
      const suppressed = evaluatePreflightRevalidation({
        storeDir: dir,
        episode,
        workerState: workerState({ status: 'fixing_ci' }),
      });
      expect(suppressed.action).toBe('suppressed');
      const auditFiles = readdirSync(path.join(dir, 'audit')).filter((name) => name.endsWith('.json'));
      expect(auditFiles.length).toBeGreaterThan(0);
      const audit = JSON.parse(readFileSync(path.join(dir, 'audit', auditFiles[0]!), 'utf8'));
      expect(audit.reason).toBe('suppressed-live-worker');
      expect(audit.terminal_action).toBe('SUPPRESS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolveSubmittedDelivery persists sent terminal audit records', () => {
    const dir = tempStore();
    try {
      recordPendingEpisode({ storeDir: dir, episode, nowMs: 1_000_000 });
      claimEpisodePreflight({ storeDir: dir, episode, claimOwner: 'test' });
      reserveSubmitIntent({ storeDir: dir, episode });
      markSendDelivered({ storeDir: dir, episode });
      const resolved = resolveSubmittedDelivery({ storeDir: dir, episode, acknowledged: true });
      expect(resolved.terminalReason).toBe('sent');
      const auditFiles = readdirSync(path.join(dir, 'audit')).filter((name) => name.endsWith('.json'));
      expect(auditFiles.some((name) => {
        const audit = JSON.parse(readFileSync(path.join(dir, 'audit', name), 'utf8'));
        return audit.reason === 'sent' && audit.terminal_action === 'SEND';
      })).toBe(true);
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


  it('planReconcileTick skips corrupt episode records', () => {
    const dir = tempStore();
    try {
      mkdirSync(path.join(dir, 'episodes'), { recursive: true });
      writeFileSync(path.join(dir, 'episodes', 'corrupt.episode.json'), '{not json');
      recordPendingEpisode({ storeDir: dir, episode, nowMs: Date.now() - 120_000, enqueueTickId: 'enqueue' });
      const plan = planReconcileTick({ storeDir: dir, nowMs: Date.now(), enqueueTickId: 'tick-corrupt' });
      expect(plan.actions!.some((a: any) => a.type === 'evaluate')).toBe(true);
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
