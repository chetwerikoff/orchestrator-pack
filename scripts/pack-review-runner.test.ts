// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  observeGptPackReviewAttempt,
  observeNativePackReviewAttempt,
  parseAuthoritativeTier,
  startPackReview,
} from './pack-review-runner.ts';
import {
  createPackReviewRun,
  updatePackReviewRun,
  type PackReviewRunRecord,
} from './lib/pack-review-run-store.ts';
import { runProcess } from './kernel/subprocess.ts';
import {
  PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
  commitPackReviewTriage,
  commitSmokeOrderingTransition,
  initializePackReviewAuthority,
  observePackReviewHead,
  readPackReviewAuthority,
} from './pack-review-state.ts';

const roots: string[] = [];
const originalEnv = { ...process.env };
const HEAD = 'a'.repeat(40);

function setupHarness(storeRoot: string): void {
  process.env.OPK_VITEST_HARNESS = '1';
  process.env.PACK_REVIEWER = 'codex';
  process.env.OPK_BASE_DIR = join(storeRoot, 'base');
  process.env.OPK_REVIEW_CLAIM_DIR = join(storeRoot, 'base', 'projects', 'orchestrator-pack', 'review-start-claims');
  process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR = join(storeRoot, 'bound-issue-snapshots');
}

function cleanPayload(): string {
  return JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] });
}

afterEach(() => {
  process.env = { ...originalEnv };
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Issue #1826 reviewer-native replacement observation', () => {
  function gptRun(admissionStartedAtUtc: string): PackReviewRunRecord {
    return {
      schemaVersion: 1,
      id: 'prr-gpt-observation',
      runId: 'prr-gpt-observation',
      projectId: 'orchestrator-pack',
      key: `pr-1826-${HEAD}`,
      prNumber: 1826,
      targetSha: HEAD,
      headSha: HEAD,
      status: 'failed',
      latestRunStatus: 'failed',
      linkedSessionId: 'worker',
      startReason: 'automatic',
      surface: 'test',
      trustedPackRoot: process.cwd(),
      sourceRepoRoot: process.cwd(),
      automaticBudgetDisposition: 'consume',
      canonicalRepository: 'chetwerikoff/orchestrator-pack',
      accountingVersion: 'issue-1826-logical-rounds-1-1-2',
      reviewCycleId: 'cycle-1826',
      logicalRoundOrdinal: 1,
      logicalRoundCap: 2,
      resolvedReviewer: 'gpt',
      reviewRound: {
        schema: 'pack-review-gpt-round/v1',
        reviewer: 'gpt',
        tier: 'T3',
        accountingVersion: 'issue-1826-logical-rounds-1-1-2',
        roundOrdinal: 1,
        cardinality: 3,
        issueNumber: 1826,
        boundIssueSnapshotDigest: 'd'.repeat(64),
        sourceSlots: [
          {
            slotId: 'slot-01',
            ordinal: 1,
            lifecycle: 'invocation_started',
            invocationId: 'invocation-01',
            attemptOrdinal: 1,
            admissionStartedAtUtc,
            launchProfileKey: 'profile-01',
            launchCdpUrl: 'http://127.0.0.1:9222',
          },
          { slotId: 'slot-02', ordinal: 2, lifecycle: 'planned' },
          { slotId: 'slot-03', ordinal: 3, lifecycle: 'planned' },
        ],
      },
      runnerPid: process.pid,
      createdAt: admissionStartedAtUtc,
      updatedAt: admissionStartedAtUtc,
      heartbeatAtUtc: admissionStartedAtUtc,
      findings: [],
      deliveryOutcomes: {},
    };
  }

  function gptObservationDeps(input: {
    markerPresent: boolean;
    generating: boolean | 'unknown';
    replyPresent?: boolean;
    nodesTruncated?: boolean;
  }) {
    const marker = `OPKTURNV1${'a'.repeat(32)}`;
    const listTargets = async () => [{
      id: 'target-1',
      type: 'page',
      url: 'https://chatgpt.com/c/one',
      title: 'one',
      webSocketDebuggerUrl: 'ws://127.0.0.1/target-1',
    }];
    const evaluate = async () => ({
      status: 'ok',
      page_url: 'https://chatgpt.com/c/one',
      ready_state: 'complete',
      title: 'one',
      generation_in_progress: input.generating,
      nodes_truncated: input.nodesTruncated === true,
      nodes: [
        ...(input.markerPresent ? [{
          role: 'user',
          document_ordinal: 1,
          innerText: { head: `${marker} prompt`, byte_length: 64 },
        }] : []),
        ...(input.replyPresent ? [{
          role: 'assistant',
          document_ordinal: 2,
          innerText: { head: 'done', byte_length: 4 },
        }] : []),
      ],
    });
    const readObservation = () => ({
      schema: 'state-light-turn-observation/v1' as const,
      version: 1 as const,
      invocation_id: 'invocation-01',
      profile_key: 'profile-01',
      marker,
      phase: 'sent_unharvested' as const,
      send_witness: 'owned_marker' as const,
      send_count: 1,
      conversation_url: 'https://chatgpt.com/c/one',
      transitioned_at: '2026-08-30T00:00:00.000Z',
      transition_reason: 'fixture',
    });
    const resolveSourceComment = async () => ({
      kind: 'missing' as const,
      reason: 'fixture_source_comment_missing',
    });
    return {
      listTargets: listTargets as never,
      evaluate: evaluate as never,
      readObservation: readObservation as never,
      resolveSourceComment: resolveSourceComment as never,
    };
  }

  it('does not replace a Browser GPT turn that is still generating before 15 minutes', async () => {
    const start = Date.parse('2026-08-30T00:00:00.000Z');
    const observed = await observeGptPackReviewAttempt(
      gptRun(new Date(start).toISOString()),
      start + 14 * 60_000,
      gptObservationDeps({ markerPresent: true, generating: true }),
    );
    expect(observed).toMatchObject({ state: 'generating', replacementEligible: false });
  });

  it('permits Browser GPT replacement after 15 minutes of confirmed generation and GitHub absence', async () => {
    const start = Date.parse('2026-08-30T00:00:00.000Z');
    const observed = await observeGptPackReviewAttempt(
      gptRun(new Date(start).toISOString()),
      start + 15 * 60_000,
      gptObservationDeps({ markerPresent: true, generating: true }),
    );
    expect(observed).toMatchObject({ state: 'replacement_eligible', replacementEligible: true });
  });

  it('checks exact GitHub publication before consulting direct CDP replacement evidence', async () => {
    const start = Date.parse('2026-08-30T00:00:00.000Z');
    let cdpReads = 0;
    const observed = await observeGptPackReviewAttempt(
      gptRun(new Date(start).toISOString()),
      start + 20 * 60_000,
      {
        ...gptObservationDeps({ markerPresent: true, generating: true }),
        listTargets: (async () => {
          cdpReads += 1;
          return [];
        }) as never,
        resolveSourceComment: (async () => ({
          kind: 'credentialed',
          payload: {},
          receipt: {},
        })) as never,
      },
    );
    expect(observed).toMatchObject({ state: 'reply_recovery_required', replacementEligible: false });
    expect(cdpReads).toBe(0);
  });

  it('does not authorize replacement from a truncated all-tab message census', async () => {
    const start = Date.parse('2026-08-30T00:00:00.000Z');
    const observed = await observeGptPackReviewAttempt(
      gptRun(new Date(start).toISOString()),
      start + 20 * 60_000,
      gptObservationDeps({ markerPresent: false, generating: false, nodesTruncated: true }),
    );
    expect(observed).toMatchObject({ state: 'observation_unavailable', replacementEligible: false });
  });
  it('requires recovery of an attributable finished reply instead of replacement', async () => {
    const start = Date.parse('2026-08-30T00:00:00.000Z');
    const observed = await observeGptPackReviewAttempt(
      gptRun(new Date(start).toISOString()),
      start + 60_000,
      gptObservationDeps({ markerPresent: true, generating: false, replyPresent: true }),
    );
    expect(observed).toMatchObject({ state: 'reply_recovery_required', replacementEligible: false });
  });

  it('uses the live fallback Claude child after same-run active-binding rollover until its own ceiling', async () => {
    if (process.platform === 'win32') return;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const firstStartedAt = '2026-08-30T00:00:00.000Z';
    const fallbackStartedAt = '2026-08-30T00:05:00.000Z';
    let resolveFirstPid!: (pid: number) => void;
    const firstPidReady = new Promise<number>((resolve) => { resolveFirstPid = resolve; });
    const firstResult = runProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      allowEmptyStdout: true,
      onSpawn: resolveFirstPid,
    });
    const firstPid = await firstPidReady;

    const run = gptRun(firstStartedAt);
    run.reviewRound = undefined;
    run.resolvedReviewer = 'claude';
    run.nativeAttempt = {
      schema: 'pack-review-native-attempt/v1',
      reviewer: 'claude',
      invocationOrdinal: 1,
      startedAtUtc: firstStartedAt,
      effectiveBudgetMs: 30 * 60_000,
      wrapperPid: firstPid,
      processGroupId: firstPid,
      childPid: firstPid,
      childProcessGroupId: firstPid,
      childStartedAtUtc: firstStartedAt,
    };

    process.kill(-firstPid, 'SIGKILL');
    await firstResult;

    let resolveFallbackPid!: (pid: number) => void;
    const fallbackPidReady = new Promise<number>((resolve) => { resolveFallbackPid = resolve; });
    const fallbackResult = runProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      allowEmptyStdout: true,
      onSpawn: resolveFallbackPid,
    });
    const fallbackPid = await fallbackPidReady;
    try {
      run.nativeAttempt = {
        schema: 'pack-review-native-attempt/v1',
        reviewer: 'claude',
        invocationOrdinal: 2,
        startedAtUtc: fallbackStartedAt,
        effectiveBudgetMs: 30 * 60_000,
        wrapperPid: fallbackPid,
        processGroupId: fallbackPid,
        childPid: fallbackPid,
        childProcessGroupId: fallbackPid,
        childStartedAtUtc: fallbackStartedAt,
      };

      expect(observeNativePackReviewAttempt(run, Date.parse(fallbackStartedAt) + 14 * 60_000))
        .toMatchObject({
          reviewer: 'claude',
          state: 'running',
          replacementEligible: false,
          nativeReplacementCeilingMs: 15 * 60_000,
        });
      expect(observeNativePackReviewAttempt(run, Date.parse(fallbackStartedAt) + 15 * 60_000))
        .toMatchObject({
          reviewer: 'claude',
          state: 'running',
          replacementEligible: true,
          nativeReplacementCeilingMs: 15 * 60_000,
        });
    } finally {
      try { process.kill(-fallbackPid, 'SIGKILL'); } catch { /* already gone */ }
      await fallbackResult;
    }
  });
  it('keeps factual native unavailability but releases replacement at the persisted ceiling', () => {
    const run = gptRun('2026-08-30T00:00:00.000Z');
    run.reviewRound = undefined;
    run.resolvedReviewer = 'claude';
    run.nativeAttempt = {
      schema: 'pack-review-native-attempt/v1',
      reviewer: 'claude',
      invocationOrdinal: 2,
      startedAtUtc: '2026-08-30T00:00:00.000Z',
      effectiveBudgetMs: 30 * 60_000,
      wrapperPid: process.pid,
    };
    expect(observeNativePackReviewAttempt(run, Date.parse('2026-08-30T00:14:00.000Z')))
      .toMatchObject({ state: 'observation_unavailable', replacementEligible: false });
    expect(observeNativePackReviewAttempt(run, Date.parse('2026-08-30T00:15:00.000Z')))
      .toMatchObject({ state: 'observation_unavailable', replacementEligible: true });
  });
});

describe('Issue #1826 logical-round smoke independence', () => {
  it('admits T3 round 2 on the same head without requiring a second worker smoke', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'pack-review-1826-round2-smoke-'));
    roots.push(parent);
    const storeRoot = join(parent, 'store');
    setupHarness(storeRoot);
    const head1 = '1'.repeat(40);
    const head2 = head1;
    const prNumber = 1826;
    const issueBody = [
      '```complexity-tier\ntier: T3\nadvisory-prior: T3\n```',
      '```smoke-test-plan\nscenarios:\n  - action: exact head smoke | expected: PASS\n```',
    ].join('\n\n');
    const options = { storeRoot };
    const initial = initializePackReviewAuthority({
      prNumber,
      headSha: head1,
      tier: 'T3',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      options,
    });
    const smokeStarted = commitSmokeOrderingTransition({
      prNumber,
      expectedTransitionSeq: initial.transitionSeq,
      actor: 'worker-owned',
      headSha: head1,
      status: 'started',
      options,
    });
    commitSmokeOrderingTransition({
      prNumber,
      expectedTransitionSeq: smokeStarted.transitionSeq,
      actor: 'worker-owned',
      headSha: head1,
      status: 'passed',
      options,
    });

    const round1 = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: process.cwd(),
      prNumber,
      headSha: head1,
      claimMode: 'preacquired',
      fixtureCurrentPrHeadSha: head1,
      fixturePostReviewHeadSha: head1,
      fixturePrState: 'OPEN',
      fixturePrBody: 'Closes #1826',
      fixturePostReviewPrBody: 'Closes #1826',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureIssueNumber: 1826,
      fixtureIssueBody: issueBody,
      fixtureReviewStdout: cleanPayload(),
      fixtureGithubReviewId: 182601,
      fixtureReviewerLayerOverrides: { Process: 'codex', User: 'codex' },
      fixtureEmulateWin32Selector: true,
      fixtureRequiredStatusWriter: async () => {},
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    });
    expect(round1).toMatchObject({ ok: true, created: true });
    expect(readPackReviewAuthority(prNumber, options)?.cycle?.consumedRoundOrdinals).toEqual([1]);

    const round2 = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: process.cwd(),
      prNumber,
      headSha: head2,
      claimMode: 'preacquired',
      fixtureCurrentPrHeadSha: head2,
      fixturePostReviewHeadSha: head2,
      fixturePrState: 'OPEN',
      fixturePrBody: 'Closes #1826',
      fixturePostReviewPrBody: 'Closes #1826',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureIssueNumber: 1826,
      fixtureIssueBody: issueBody,
      fixtureReviewStdout: cleanPayload(),
      fixtureGithubReviewId: 182602,
      fixtureReviewerLayerOverrides: { Process: 'codex', User: 'codex' },
      fixtureEmulateWin32Selector: true,
      fixtureRequiredStatusWriter: async () => {},
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    });

    expect(round2).toMatchObject({ ok: true, created: true });
    const finalAuthority = readPackReviewAuthority(prNumber, options);
    expect(finalAuthority?.cycle?.consumedRoundOrdinals).toEqual([1, 2]);
    expect(finalAuthority?.cycle?.reviewStageComplete).toBe(true);
    expect(finalAuthority?.smokeOrdering?.workerOwned?.headSha).toBe(head1);
  });
  it('blocks T3 round 2 until round-1 findings are resolved or explicitly rejected', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'pack-review-1826-round1-findings-gate-'));
    roots.push(parent);
    const storeRoot = join(parent, 'store');
    setupHarness(storeRoot);
    const head = '5'.repeat(40);
    const prNumber = 1829;
    const issueBody = [
      '```complexity-tier\ntier: T3\nadvisory-prior: T3\n```',
      '```smoke-test-plan\nscenarios:\n  - action: exact head smoke | expected: PASS\n```',
    ].join('\n\n');
    const options = { storeRoot };
    const initial = initializePackReviewAuthority({
      prNumber,
      headSha: head,
      tier: 'T3',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      options,
    });
    const smokeStarted = commitSmokeOrderingTransition({
      prNumber,
      expectedTransitionSeq: initial.transitionSeq,
      actor: 'worker-owned',
      headSha: head,
      status: 'started',
      options,
    });
    commitSmokeOrderingTransition({
      prNumber,
      expectedTransitionSeq: smokeStarted.transitionSeq,
      actor: 'worker-owned',
      headSha: head,
      status: 'passed',
      options,
    });

    const common = {
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: process.cwd(),
      prNumber,
      headSha: head,
      claimMode: 'preacquired' as const,
      fixtureCurrentPrHeadSha: head,
      fixturePostReviewHeadSha: head,
      fixturePrState: 'OPEN' as const,
      fixturePrBody: `Closes #${prNumber}`,
      fixturePostReviewPrBody: `Closes #${prNumber}`,
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureIssueNumber: prNumber,
      fixtureIssueBody: issueBody,
      fixtureReviewerLayerOverrides: { Process: 'codex', User: 'codex' },
      fixtureEmulateWin32Selector: true,
      fixtureRequiredStatusWriter: async () => {},
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    };
    const round1 = await startPackReview({
      ...common,
      fixtureReviewStdout: JSON.stringify({
        verdict: 'findings',
        findingCount: 1,
        findings: [{ severity: 'blocking', title: 'round one finding' }],
      }),
      fixtureGithubReviewId: 182901,
    });
    expect(round1).toMatchObject({ ok: true, created: true });
    expect(readPackReviewAuthority(prNumber, options)?.cycle).toMatchObject({
      state: 'open_findings',
      consumedRoundOrdinals: [1],
    });

    const round2 = await startPackReview({
      ...common,
      fixtureReviewStdout: cleanPayload(),
      fixtureGithubReviewId: 182902,
    });
    expect(round2).toMatchObject({
      ok: false,
      created: false,
      reason: 'prior_round_findings_unresolved',
      httpStatus: 409,
    });
    expect(readPackReviewAuthority(prNumber, options)?.cycle?.consumedRoundOrdinals).toEqual([1]);

    let authority = readPackReviewAuthority(prNumber, options)!;
    authority = observePackReviewHead({
      prNumber,
      expectedTransitionSeq: authority.transitionSeq,
      headSha: head,
      options,
    });
    authority = commitPackReviewTriage({
      prNumber,
      expectedTransitionSeq: authority.transitionSeq,
      triage: {
        verdict: 'DEFER',
        source: 'architect',
        findingSnapshotDigest: 'f'.repeat(64),
        actor: 'architect-fixture',
        committedAtUtc: new Date().toISOString(),
      },
      options,
    });
    expect(authority.cycle).toMatchObject({ state: 'open', consumedRoundOrdinals: [1] });
    expect(authority.cycle?.reviewStageComplete).not.toBe(true);

    const adjudicatedRound2 = await startPackReview({
      ...common,
      fixtureReviewStdout: cleanPayload(),
      fixtureGithubReviewId: 182903,
    });
    expect(adjudicatedRound2).toMatchObject({ ok: true, created: true });
    expect(readPackReviewAuthority(prNumber, options)?.cycle?.consumedRoundOrdinals).toEqual([1, 2]);
  });
  it('does not create a native same-round replacement when the prior run lacks a native binding', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'pack-review-1826-native-unbound-'));
    roots.push(parent);
    const storeRoot = join(parent, 'store');
    setupHarness(storeRoot);
    const prNumber = 1827;
    const head = '3'.repeat(40);
    const options = { storeRoot };
    const authority = initializePackReviewAuthority({
      prNumber,
      headSha: head,
      tier: 'T3',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      options,
    });
    const prior = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber,
      headSha: head,
      trustedPackRoot: process.cwd(),
      sourceRepoRoot: process.cwd(),
      canonicalRepository: 'chetwerikoff/orchestrator-pack',
      accountingVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      reviewCycleId: authority.cycle!.cycleId,
      logicalRoundOrdinal: 1,
      logicalRoundCap: 2,
      resolvedReviewer: 'codex',
    });

    const result = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: process.cwd(),
      prNumber,
      headSha: head,
      claimMode: 'preacquired',
      fixtureCurrentPrHeadSha: head,
      fixturePostReviewHeadSha: head,
      fixturePrState: 'OPEN',
      fixturePrBody: `Closes #${prNumber}`,
      fixturePostReviewPrBody: `Closes #${prNumber}`,
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureIssueNumber: prNumber,
      fixtureIssueBody: '```complexity-tier\ntier: T3\nadvisory-prior: T3\n```',
      fixtureReviewStdout: cleanPayload(),
      fixtureReviewerLayerOverrides: { Process: 'codex', User: 'codex' },
      fixtureEmulateWin32Selector: true,
      fixtureRequiredStatusWriter: async () => {},
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    });

    expect(result).toMatchObject({
      ok: false,
      reused: true,
      reason: 'native_observation_unavailable',
      runId: prior.run.id,
      replacementEligible: false,
    });
  });

  it('bypasses the exact active native run only after its persisted replacement ceiling', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'pack-review-1826-native-ceiling-'));
    roots.push(parent);
    const storeRoot = join(parent, 'store');
    setupHarness(storeRoot);
    process.env.PACK_REVIEW_RUN_STALE_MINUTES = '60';
    const prNumber = 1828;
    const head = '4'.repeat(40);
    const options = { storeRoot };
    const authority = initializePackReviewAuthority({
      prNumber,
      headSha: head,
      tier: 'T3',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      options,
    });
    const startedAt = new Date(Date.now() - 20 * 60_000);
    const prior = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber,
      headSha: head,
      trustedPackRoot: process.cwd(),
      sourceRepoRoot: process.cwd(),
      canonicalRepository: 'chetwerikoff/orchestrator-pack',
      accountingVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      reviewCycleId: authority.cycle!.cycleId,
      logicalRoundOrdinal: 1,
      logicalRoundCap: 2,
      resolvedReviewer: 'codex',
      now: startedAt,
    });
    updatePackReviewRun(prior.run.id, {
      nativeAttempt: {
        schema: 'pack-review-native-attempt/v1',
        reviewer: 'codex',
        invocationOrdinal: 1,
        startedAtUtc: startedAt.toISOString(),
        effectiveBudgetMs: 30 * 60_000,
        wrapperPid: process.pid,
      },
    }, { projectId: 'orchestrator-pack', storeRoot, now: startedAt });

    const result = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: process.cwd(),
      prNumber,
      headSha: head,
      claimMode: 'preacquired',
      fixtureCurrentPrHeadSha: head,
      fixturePostReviewHeadSha: head,
      fixturePrState: 'OPEN',
      fixturePrBody: `Closes #${prNumber}`,
      fixturePostReviewPrBody: `Closes #${prNumber}`,
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureIssueNumber: prNumber,
      fixtureIssueBody: '```complexity-tier\ntier: T3\nadvisory-prior: T3\n```',
      fixtureReviewStdout: cleanPayload(),
      fixtureReviewerLayerOverrides: { Process: 'codex', User: 'codex' },
      fixtureEmulateWin32Selector: true,
      fixtureRequiredStatusWriter: async () => {},
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    });

    expect(result).toMatchObject({ ok: true, created: true, reused: false });
    expect(result.runId).not.toBe(prior.run.id);
  });
});
describe('Issue #1647 authoritative tier resolution', () => {
  it('uses the canonical default for a legal Issue without a complexity-tier fence', () => {
    expect(parseAuthoritativeTier('# Firefighter repair\n\nNo tier is required.')).toBe('T2');
  });

  it('uses the canonical default for an explicit no-tier Issue', () => {
    expect(parseAuthoritativeTier('```complexity-tier\nskip-line: true\n```')).toBe('T2');
  });

  it('continues to reject an invalid complexity-tier fence', () => {
    expect(() => parseAuthoritativeTier('```complexity-tier\ntier: T4\n```'))
      .toThrow('authoritative Issue tier is invalid');
  });

  it('rejects an unterminated complexity-tier fence instead of defaulting', () => {
    expect(() => parseAuthoritativeTier('```complexity-tier\ntier: T3'))
      .toThrow('authoritative Issue tier is invalid');
  });

  it('allows pack-review to produce a verdict for a firefighter Issue without a tier fence', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'pack-review-1647-tierless-'));
    roots.push(parent);
    const storeRoot = join(parent, 'store');
    setupHarness(storeRoot);

    const result = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: process.cwd(),
      prNumber: 1647,
      headSha: HEAD,
      fixtureCurrentPrHeadSha: HEAD,
      fixturePrState: 'OPEN',
      fixturePrBody: 'Closes #1647',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixturePostReviewHeadSha: HEAD,
      fixturePostReviewPrBody: 'Closes #1647',
      fixtureIssueBody: '# Firefighter repair\n\nNo complexity tier is required.',
      fixtureReviewStdout: cleanPayload(),
      fixtureGithubReviewId: 1647,
      fixtureRequiredStatusWriter: async () => {},
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    });

    expect(result).toMatchObject({ ok: true, created: true, reused: false });
  });
});
