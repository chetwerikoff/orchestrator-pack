// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapGptReplyToReviewPayload } from './lib/pack-gpt-reviewer.ts';
import {
  observeGptPackReviewAttempt,
  observeNativePackReviewAttempt,
  parseAuthoritativeTier,
  reconcileStalePackReviewRuns,
  resolveGithubCommitIsStrictDescendant,
  startPackReview,
} from './pack-review-runner.ts';
import {
  createPackReviewRun,
  getPackReviewRun,
  setPackReviewRunTerminal,
  updatePackReviewRun,
  type PackReviewRunRecord,
} from './lib/pack-review-run-store.ts';
import type { CarryoverReplayResult } from './pack-review-carryover.ts';
import { runProcess } from './kernel/subprocess.ts';
import {
  boundIssueSnapshotArtifactPaths,
  captureBoundIssueSnapshot,
  computeBoundIssueSnapshotHash,
  resolveBoundIssueSnapshot,
} from './lib/reverify-bound-issue-snapshot.ts';
import {
  PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
  commitPackReviewTerminal,
  initializePackReviewAuthority,
  observePackReviewHead,
  readPackReviewAuthority,
} from './pack-review-state.ts';

const roots: string[] = [];
const originalEnv = { ...process.env };
const HEAD = 'a'.repeat(40);

describe('Issue #1887 GitHub compare ancestry normalization', () => {
  it('fails closed when compare transport throws', async () => {
    const reviewed = '1'.repeat(40);
    const current = '2'.repeat(40);
    const result = await resolveGithubCommitIsStrictDescendant(
      process.cwd(),
      'chetwerikoff/orchestrator-pack',
      reviewed,
      current,
      async () => { throw new Error('compare unavailable'); },
    );
    expect(result).toBe(false);
  });

  it('rejects equality before querying compare', async () => {
    const head = '3'.repeat(40);
    const result = await resolveGithubCommitIsStrictDescendant(
      process.cwd(),
      'chetwerikoff/orchestrator-pack',
      head,
      head,
      async () => { throw new Error('must not be called'); },
    );
    expect(result).toBe(false);
  });
});

function setupHarness(storeRoot: string): void {
  process.env.OPK_VITEST_HARNESS = '1';
  process.env.PACK_REVIEWER = 'codex';
  process.env.XDG_CONFIG_HOME = join(storeRoot, 'test-config');
  const projects = join(process.env.XDG_CONFIG_HOME, 'orchestrator-pack', 'projects');
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, 'orchestrator-pack.json'), JSON.stringify({
    projectId: 'orchestrator-pack', repository: 'chetwerikoff/orchestrator-pack',
    primaryRoot: process.cwd(), defaultBranch: 'main',
    orcaWorkspacePattern: '^test-only$', orchestratorTitlePattern: '^test-only$',
    browserGpt: { projectUrl: 'https://example.invalid/test-only' },
  }));
  process.env.OPK_BASE_DIR = join(storeRoot, 'base');
  process.env.OPK_REVIEW_CLAIM_DIR = join(storeRoot, 'base', 'projects', 'orchestrator-pack', 'review-start-claims');
  process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR = join(storeRoot, 'bound-issue-snapshots');
}

function cleanPayload(): string {
  return JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] });
}

function mergeCompositeReplay(targetHeadSha: string): CarryoverReplayResult {
  const sourceHeadSha = '6'.repeat(40);
  const mainSha = '7'.repeat(40);
  const mergeBaseSha = '8'.repeat(40);
  return {
    kind: 'merge_composite',
    sourceHeadSha,
    mainSha,
    targetHeadSha,
    mergeBaseSha,
    replayTreeSha: '9'.repeat(40),
    replayDigest: 'fixture-replay',
    bundle: {
      schema: 'merge-resolution-bundle/v2',
      helperVersion: 'pack-review-carryover/v2',
      sourceHeadSha,
      mainSha,
      targetHeadSha,
      mergeBaseSha,
      orderedParentShas: [sourceHeadSha, mainSha],
      gitVersion: 'fixture',
      replayConfigDigest: 'fixture-config',
      replayDigest: 'fixture-replay',
      conflictCount: 1,
      conflicts: [],
      framedBytesBase64: '',
      bundleDigest: 'fixture-bundle',
    },
  };
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

  it('authorizes all-zero-send same-round replacement after exact GitHub absence without CDP observation', async () => {
    const run = gptRun('2026-08-30T00:00:00.000Z');
    run.reviewRound!.sourceSlots = [1, 2, 3].map((ordinal) => ({
      slotId: `slot-0${ordinal}`,
      ordinal,
      lifecycle: 'terminal' as const,
      invocationId: `invocation-0${ordinal}`,
      attemptOrdinal: 2,
      terminalClass: 'explicit_refusal:zero_send_collision_exhausted',
      terminalResult: { state: 'profile_busy', cause: 'profile_busy', send_count: 0 },
    }));
    let observationReads = 0;
    let cdpReads = 0;
    const observed = await observeGptPackReviewAttempt(run, Date.parse('2026-08-30T00:20:00.000Z'), {
      resolveSourceComment: (async () => ({ kind: 'missing' as const, reason: 'fixture_source_comment_missing' })) as never,
      readObservation: (() => { observationReads += 1; throw new Error('state_light_should_not_run_for_authoritative_pre_send'); }) as never,
      listTargets: (async () => { cdpReads += 1; throw new Error('cdp_should_not_run_for_authoritative_pre_send'); }) as never,
    });
    expect(observed).toMatchObject({ state: 'replacement_eligible', replacementEligible: true, replacementEligibleSlotIds: ['slot-01', 'slot-02', 'slot-03'] });
    expect(observationReads).toBe(0);
    expect(cdpReads).toBe(0);
  });

  it.each(['dispatching', 'unreadable', 'unbound', 'wrong_identity', 'not_sent'] as const)(
    'requires affirmative exact pre-dispatch evidence for legacy zero-count terminals: %s', async (mode) => {
      const run = gptRun('2026-08-30T00:00:00.000Z');
      const slot = run.reviewRound!.sourceSlots[0]!;
      slot.lifecycle = 'terminal';
      slot.terminalClass = 'driver_error:locator_timeout';
      slot.terminalResult = { state: 'driver_error', cause: 'locator_timeout', send_count: 0 };
      if (mode === 'unbound') delete slot.launchProfileKey;
      const deps = gptObservationDeps({ markerPresent: true, generating: true });
      const readObservation = vi.fn(() => {
        if (mode === 'unreadable') throw new Error('fixture_observation_unavailable');
        return {
          schema: 'state-light-turn-observation/v1', version: 1, profile_key: 'profile-01',
          marker: `OPKTURNV1${'a'.repeat(32)}`, conversation_url: 'https://chatgpt.com/c/one',
          transitioned_at: '2026-08-30T00:00:00.000Z', transition_reason: 'fixture',
          phase: mode === 'not_sent' ? 'not_sent' : 'dispatching', send_count: 0, send_witness: 'none',
          invocation_id: mode === 'wrong_identity' ? 'foreign-invocation' : slot.invocationId,
        };
      });
      const observed = await observeGptPackReviewAttempt(run, Date.parse('2026-08-30T00:01:00.000Z'), {
        ...deps, readObservation: readObservation as never,
      });
      expect(observed).toMatchObject({
        state: mode === 'not_sent' ? 'replacement_eligible' : mode === 'dispatching' ? 'generating' : 'observation_unavailable',
        replacementEligible: mode === 'not_sent',
      });
      expect(observed?.replacementEligibleSlotIds).toEqual(mode === 'not_sent' ? ['slot-01'] : []);
      if (mode !== 'unbound') expect(readObservation).toHaveBeenCalledWith('profile-01', 'invocation-01');
    },
  );

  it('lets exact GitHub publication override authoritative zero-send replacement', async () => {
    const run = gptRun('2026-08-30T00:00:00.000Z');
    const slot = run.reviewRound!.sourceSlots[0]!;
    slot.lifecycle = 'terminal';
    slot.terminalClass = 'explicit_refusal:zero_send_collision_exhausted';
    slot.terminalResult = { state: 'profile_busy', cause: 'profile_busy', send_count: 0 };
    delete slot.launchProfileKey;
    delete slot.launchCdpUrl;
    let cdpReads = 0;
    const observed = await observeGptPackReviewAttempt(run, Date.parse('2026-08-30T00:20:00.000Z'), {
      resolveSourceComment: (async () => ({ kind: 'credentialed' as const, payload: {}, receipt: {} })) as never,
      listTargets: (async () => { cdpReads += 1; return []; }) as never,
    });
    expect(observed).toMatchObject({ state: 'reply_recovery_required', replacementEligible: false });
    expect(cdpReads).toBe(0);
  });

  it('skips non-conversation and locator-proven foreign failures while retaining foreign-owner diagnostics', async () => {
    const marker = `OPKTURNV1${'a'.repeat(32)}`;
    const foreignMarker = `OPKTURNV1${'b'.repeat(32)}`;
    const evaluated: string[] = [];
    const observed = await observeGptPackReviewAttempt(gptRun('2026-08-30T00:00:00.000Z'), Date.parse('2026-08-30T00:01:00.000Z'), {
      resolveSourceComment: (async () => ({ kind: 'missing' as const, reason: 'fixture_source_comment_missing' })) as never,
      readObservation: (() => ({
        schema: 'state-light-turn-observation/v1' as const, version: 1 as const, invocation_id: 'invocation-01',
        profile_key: 'profile-01', marker, phase: 'sent_unharvested' as const, send_witness: 'owned_marker' as const,
        send_count: 1, conversation_url: 'https://chatgpt.com/c/one', transitioned_at: '2026-08-30T00:00:00.000Z', transition_reason: 'fixture',
      })) as never,
      listTargets: (async () => [
        { id: 'root', type: 'page', url: 'https://chatgpt.com/', title: 'ChatGPT', webSocketDebuggerUrl: 'ws://root' },
        { id: 'settings', type: 'page', url: 'https://chatgpt.com/settings', title: 'Settings', webSocketDebuggerUrl: 'ws://settings' },
        { id: 'broken', type: 'page', url: 'https://chatgpt.com/c/broken', title: 'Broken foreign', webSocketDebuggerUrl: 'ws://broken' },
        { id: 'foreign', type: 'page', url: 'https://chatgpt.com/c/foreign', title: 'Foreign owner', webSocketDebuggerUrl: 'ws://foreign' },
        { id: 'owned', type: 'page', url: 'https://chatgpt.com/c/one', title: 'Owned', webSocketDebuggerUrl: 'ws://owned' },
      ]) as never,
      evaluate: (async (target: { normalized_url?: string }) => {
        evaluated.push(String(target.normalized_url));
        if (target.normalized_url?.endsWith('/c/broken')) throw new Error('foreign_read_failed');
        const isOwned = target.normalized_url?.endsWith('/c/one');
        return { status: 'ok', generation_in_progress: !isOwned, nodes_truncated: false, nodes: [
          { role: 'user', document_ordinal: 1, innerText: { head: `${isOwned ? marker : foreignMarker} prompt`, byte_length: 64 } },
        ] };
      }) as never,
    });
    expect(observed).toMatchObject({ state: 'replacement_eligible', replacementEligible: true });
    expect(evaluated).not.toContain('https://chatgpt.com');
    expect(observed?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ surfaceClass: 'listing', cause: 'surface_skipped' }),
      expect.objectContaining({ surfaceClass: 'non_chat', cause: 'surface_skipped' }),
      expect.objectContaining({ surfaceClass: 'ownership_unknown', title: 'Broken foreign', cause: 'ownership_ambiguous' }),
      expect.objectContaining({ surfaceClass: 'foreign_chat', title: 'Foreign owner', cause: 'foreign_owner' }),
      expect.objectContaining({ surfaceClass: 'owned_conversation', title: 'Owned', cause: 'owned_marker' }),
    ]));
    const foreignOwner = observed?.diagnostics?.find((item) => item.cause === 'foreign_owner')?.foreignOwner;
    expect(foreignOwner).toMatch(/^foreign_owner:[0-9a-f]{12}$/u);
    expect(foreignOwner).not.toContain(foreignMarker);
  });

  it('keeps a successful census without the exact owned marker observation-unavailable', async () => {
    const observed = await observeGptPackReviewAttempt(gptRun('2026-08-30T00:00:00.000Z'), Date.parse('2026-08-30T00:01:00.000Z'),
      gptObservationDeps({ markerPresent: false, generating: false }));
    expect(observed).toMatchObject({ state: 'observation_unavailable', replacementEligible: false });
    expect(observed?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ surfaceClass: 'foreign_chat', cause: 'foreign_conversation' }),
    ]));
  });

  it('fails closed with ownership_unknown when a legacy no-locator conversation cannot be inspected', async () => {
    const deps = gptObservationDeps({ markerPresent: false, generating: false });
    const observed = await observeGptPackReviewAttempt(gptRun('2026-08-30T00:00:00.000Z'), Date.parse('2026-08-30T00:01:00.000Z'), {
      ...deps,
      readObservation: (() => ({ ...deps.readObservation(), conversation_url: undefined })) as never,
      evaluate: (async () => { throw new Error('legacy_conversation_unreadable'); }) as never,
    });
    expect(observed).toMatchObject({ state: 'observation_unavailable', replacementEligible: false });
    expect(observed?.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ surfaceClass: 'ownership_unknown', cause: 'ownership_ambiguous' })]));
  });

  it('keeps duplicate exact markers ambiguous even when one conversation is the retained locator', async () => {
    const marker = `OPKTURNV1${'a'.repeat(32)}`;
    const observed = await observeGptPackReviewAttempt(gptRun('2026-08-30T00:00:00.000Z'), Date.parse('2026-08-30T00:01:00.000Z'), {
      resolveSourceComment: (async () => ({ kind: 'missing' as const, reason: 'fixture_source_comment_missing' })) as never,
      readObservation: (() => ({
        schema: 'state-light-turn-observation/v1' as const, version: 1 as const, invocation_id: 'invocation-01',
        profile_key: 'profile-01', marker, phase: 'sent_unharvested' as const, send_witness: 'owned_marker' as const,
        send_count: 1, conversation_url: 'https://chatgpt.com/c/one', transitioned_at: '2026-08-30T00:00:00.000Z', transition_reason: 'fixture',
      })) as never,
      listTargets: (async () => [
        { id: 'one', type: 'page', url: 'https://chatgpt.com/c/one', title: 'One', webSocketDebuggerUrl: 'ws://one' },
        { id: 'two', type: 'page', url: 'https://chatgpt.com/c/two', title: 'Two', webSocketDebuggerUrl: 'ws://two' },
      ]) as never,
      evaluate: (async () => ({ status: 'ok', generation_in_progress: false, nodes_truncated: false, nodes: [
        { role: 'user', document_ordinal: 1, innerText: { head: `${marker} prompt`, byte_length: 64 } },
      ] })) as never,
    });
    expect(observed).toMatchObject({ state: 'ownership_ambiguous', replacementEligible: false });
  });

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

  it('admits only GPT source slots whose own live turn crossed the replacement ceiling', async () => {
    const now = Date.parse('2026-08-30T00:15:10.000Z');
    const run = gptRun('2026-08-30T00:00:00.000Z');
    run.reviewRound!.sourceSlots = [
      {
        slotId: 'slot-01',
        ordinal: 1,
        lifecycle: 'invocation_started',
        invocationId: 'invocation-01',
        attemptOrdinal: 1,
        admissionStartedAtUtc: '2026-08-30T00:00:00.000Z',
        launchProfileKey: 'profile-01',
        launchCdpUrl: 'http://127.0.0.1:9222',
      },
      {
        slotId: 'slot-02',
        ordinal: 2,
        lifecycle: 'invocation_started',
        invocationId: 'invocation-02',
        attemptOrdinal: 1,
        admissionStartedAtUtc: '2026-08-30T00:00:30.000Z',
        launchProfileKey: 'profile-02',
        launchCdpUrl: 'http://127.0.0.1:9222',
      },
      {
        slotId: 'slot-03',
        ordinal: 3,
        lifecycle: 'terminal',
        invocationId: 'invocation-03',
        attemptOrdinal: 1,
        terminalClass: 'complete_clean',
      },
    ];
    const markers: Record<string, string> = {
      'invocation-01': 'OPKTURNV1' + '1'.repeat(32),
      'invocation-02': 'OPKTURNV1' + '2'.repeat(32),
    };
    const targets = [
      {
        id: 'target-1',
        type: 'page',
        url: 'https://chatgpt.com/c/one',
        title: 'one',
        webSocketDebuggerUrl: 'ws://127.0.0.1/target-1',
      },
      {
        id: 'target-2',
        type: 'page',
        url: 'https://chatgpt.com/c/two',
        title: 'two',
        webSocketDebuggerUrl: 'ws://127.0.0.1/target-2',
      },
    ];
    const observed = await observeGptPackReviewAttempt(run, now, {
      listTargets: (async () => targets) as never,
      evaluate: (async (target: { normalized_url?: string }) => {
        const invocationId = target.normalized_url?.endsWith('/one') ? 'invocation-01' : 'invocation-02';
        return {
          status: 'ok',
          generation_in_progress: true,
          nodes_truncated: false,
          nodes: [{
            role: 'user',
            document_ordinal: 1,
            innerText: { head: markers[invocationId] + ' prompt', byte_length: 64 },
          }],
        };
      }) as never,
      readObservation: ((_: string, invocationId: string) => ({
        schema: 'state-light-turn-observation/v1' as const,
        version: 1 as const,
        invocation_id: invocationId,
        profile_key: invocationId === 'invocation-01' ? 'profile-01' : 'profile-02',
        marker: markers[invocationId],
        phase: 'sent_unharvested' as const,
        send_witness: 'owned_marker' as const,
        send_count: 1,
        conversation_url: invocationId === 'invocation-01'
          ? 'https://chatgpt.com/c/one'
          : 'https://chatgpt.com/c/two',
        transitioned_at: invocationId === 'invocation-01'
          ? '2026-08-30T00:00:00.000Z'
          : '2026-08-30T00:00:30.000Z',
        transition_reason: 'fixture',
      })) as never,
      resolveSourceComment: (async () => ({
        kind: 'missing' as const,
        reason: 'fixture_source_comment_missing',
      })) as never,
    });

    expect(observed).toMatchObject({
      state: 'replacement_eligible',
      replacementEligible: true,
      slotId: 'slot-01',
      replacementEligibleSlotIds: ['slot-01'],
    });
  });

  it('continues never-sent GPT slots as initial-launch work after a stagger crash', async () => {
    const run = gptRun('2026-08-30T00:00:00.000Z');
    run.reviewRound!.sourceSlots = [
      {
        slotId: 'slot-01',
        ordinal: 1,
        lifecycle: 'terminal',
        invocationId: 'invocation-01',
        attemptOrdinal: 1,
        terminalClass: 'complete_clean',
      },
      {
        slotId: 'slot-02',
        ordinal: 2,
        lifecycle: 'terminal',
        terminalClass: 'pre_launch_interrupted',
      },
      {
        slotId: 'slot-03',
        ordinal: 3,
        lifecycle: 'planned',
      },
    ];

    const observed = await observeGptPackReviewAttempt(run);
    expect(observed).toMatchObject({
      state: 'continuation_eligible',
      replacementEligible: false,
      initialLaunchSlotIds: ['slot-02', 'slot-03'],
      replacementEligibleSlotIds: [],
    });
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

describe('Issue #1826 native initial pre-spawn binding', () => {
  it('keeps a bounded retry clock if the runner dies after initial arm but before onSpawn', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'pack-review-1826-initial-pre-spawn-'));
    roots.push(parent);
    const storeRoot = join(parent, 'store');
    setupHarness(storeRoot);
    const prNumber = 1830;
    const head = '6'.repeat(40);
    let armedRunId = '';

    const crashed = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: process.cwd(),
      prNumber,
      headSha: head,
      claimMode: 'preacquired',
      fixtureCurrentPrHeadSha: head,
      fixturePostReviewHeadSha: head,
      fixturePrState: 'OPEN',
      fixturePrBody: 'Closes #' + prNumber,
      fixturePostReviewPrBody: 'Closes #' + prNumber,
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureIssueNumber: prNumber,
      fixtureIssueBody: '```complexity-tier\ntier: T3\nadvisory-prior: T3\n```',
      fixtureReviewStdout: cleanPayload(),
      fixtureReviewerLayerOverrides: { Process: 'codex', User: 'codex' },
      fixtureEmulateWin32Selector: true,
      fixtureRequiredStatusWriter: async () => {},
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
      fixtureAfterNativeInitialArmed: async (run) => {
        armedRunId = run.id;
        throw new Error('fixture_crash_after_initial_arm');
      },
    });

    expect(crashed).toMatchObject({
      ok: false,
      created: true,
      reason: 'fixture_crash_after_initial_arm',
      runId: armedRunId,
    });
    expect(armedRunId).not.toBe('');

    const persisted = getPackReviewRun(armedRunId, { projectId: 'orchestrator-pack', storeRoot });
    expect(persisted?.nativeAttempt).toMatchObject({
      reviewer: 'codex',
      invocationOrdinal: 1,
      effectiveBudgetMs: expect.any(Number),
    });
    expect(persisted?.nativeAttempt?.wrapperPid).toBeUndefined();
    expect(persisted?.nativeAttempt?.processGroupId).toBeUndefined();

    const armedAtMs = Date.parse(persisted!.nativeAttempt!.startedAtUtc);
    const nativeCeilingMs = Math.min(persisted!.nativeAttempt!.effectiveBudgetMs, 15 * 60_000);
    expect(observeNativePackReviewAttempt(persisted!, armedAtMs + nativeCeilingMs - 1))
      .toMatchObject({
        state: 'observation_unavailable',
        replacementEligible: false,
        nativeReplacementCeilingMs: nativeCeilingMs,
      });
    expect(observeNativePackReviewAttempt(persisted!, armedAtMs + nativeCeilingMs))
      .toMatchObject({
        state: 'observation_unavailable',
        replacementEligible: true,
        nativeReplacementCeilingMs: nativeCeilingMs,
      });
  });
});

describe('Issue #1826 native fallback pre-spawn binding', () => {
  it('keeps a bounded retry clock if the runner dies after fallback rollover but before onSpawn', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'pack-review-1826-fallback-pre-spawn-'));
    roots.push(parent);
    const storeRoot = join(parent, 'store');
    setupHarness(storeRoot);
    const prNumber = 1829;
    const head = '5'.repeat(40);
    let armedRunId = '';

    const crashed = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: process.cwd(),
      prNumber,
      headSha: head,
      claimMode: 'preacquired',
      fixtureCurrentPrHeadSha: head,
      fixturePostReviewHeadSha: head,
      fixturePrState: 'OPEN',
      fixturePrBody: 'Closes #' + prNumber,
      fixturePostReviewPrBody: 'Closes #' + prNumber,
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureIssueNumber: prNumber,
      fixtureIssueBody: '```complexity-tier\ntier: T3\nadvisory-prior: T3\n```',
      fixtureCarryoverReplay: mergeCompositeReplay(head),
      fixtureCarryoverSourceCleanRunId: 'fixture-source-clean',
      fixtureFocusedResolutionBundleDigest: 'wrong-bundle',
      fixtureReviewStdout: cleanPayload(),
      fixtureFallbackReviewStdout: cleanPayload(),
      fixtureReviewerLayerOverrides: { Process: 'claude', User: 'claude' },
      fixtureEmulateWin32Selector: true,
      fixtureRequiredStatusWriter: async () => {},
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
      fixtureAfterNativeFallbackArmed: async (run) => {
        armedRunId = run.id;
        throw new Error('fixture_crash_after_fallback_arm');
      },
    });
    expect(crashed).toMatchObject({
      ok: false,
      created: true,
      reason: 'fixture_crash_after_fallback_arm',
      runId: armedRunId,
    });

    expect(armedRunId).not.toBe('');
    const persisted = getPackReviewRun(armedRunId, { projectId: 'orchestrator-pack', storeRoot });
    expect(persisted?.nativeAttempt).toMatchObject({
      reviewer: 'claude',
      invocationOrdinal: 2,
      effectiveBudgetMs: expect.any(Number),
    });
    expect(persisted?.nativeAttempt?.wrapperPid).toBeUndefined();
    expect(persisted?.nativeAttempt?.processGroupId).toBeUndefined();
    expect(persisted?.nativeAttempt?.childProcessGroupId).toBeUndefined();

    const armedAtMs = Date.parse(persisted!.nativeAttempt!.startedAtUtc);
    const nativeCeilingMs = Math.min(persisted!.nativeAttempt!.effectiveBudgetMs, 15 * 60_000);
    expect(nativeCeilingMs).toBeGreaterThan(0);
    expect(observeNativePackReviewAttempt(persisted!, armedAtMs + nativeCeilingMs - 1))
      .toMatchObject({
        state: 'observation_unavailable',
        replacementEligible: false,
        nativeReplacementCeilingMs: nativeCeilingMs,
      });
    expect(observeNativePackReviewAttempt(persisted!, armedAtMs + nativeCeilingMs))
      .toMatchObject({
        state: 'observation_unavailable',
        replacementEligible: true,
        nativeReplacementCeilingMs: nativeCeilingMs,
      });
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
    initializePackReviewAuthority({
      prNumber,
      headSha: head1,
      tier: 'T3',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
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
    expect(finalAuthority?.smokeOrdering).toBeUndefined();
  });
  it('blocks same-head T3 round 2 findings but admits round 2 after a strict descendant', async () => {
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
    initializePackReviewAuthority({
      prNumber,
      headSha: head,
      tier: 'T3',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
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

    const descendant = '6'.repeat(40);
    const descendantRound2 = await startPackReview({
      ...common,
      headSha: descendant,
      fixtureCurrentPrHeadSha: descendant,
      fixturePostReviewHeadSha: descendant,
      fixtureReviewCompareStatus: 'ahead',
      fixtureReviewStdout: cleanPayload(),
      fixtureGithubReviewId: 182903,
    });
    expect(descendantRound2).toMatchObject({ ok: true, created: true });
    expect(readPackReviewAuthority(prNumber, options)?.cycle).toMatchObject({
      state: 'closed',
      consumedRoundOrdinals: [1, 2],
      reviewStageComplete: true,
    });
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

describe('Issue #2412 first bound snapshot tier admission', () => {
  it('captures nothing for bare T2, admits its correction, and preserves the valid snapshot', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'pack-review-2412-tier-admission-'));
    roots.push(parent);
    const storeRoot = join(parent, 'store');
    setupHarness(storeRoot);
    process.env.PACK_REVIEW_BOUND_REVIEWER = 'codex';
    const head = '68beb271cd2332928f0e74dafb6e9ea837d513a4';
    const binding = {
      projectId: 'orchestrator-pack',
      prNumber: 2411,
      prHeadSha: head,
      issueNumber: 2408,
      storeDirOverride: process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR,
    };
    const paths = boundIssueSnapshotArtifactPaths(binding);
    const common = {
      projectId: binding.projectId,
      storeRoot,
      sourceRepoRoot: process.cwd(),
      prNumber: binding.prNumber,
      headSha: head,
      fixtureCurrentPrHeadSha: head,
      fixturePostReviewHeadSha: head,
      fixturePrState: 'OPEN' as const,
      fixturePrBody: 'Closes #2408',
      fixturePostReviewPrBody: 'Closes #2408',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureIssueNumber: binding.issueNumber,
      fixtureReviewStdout: cleanPayload(),
      fixtureGithubReviewId: 241201,
      fixtureRequiredStatusWriter: async () => {},
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    };
    const malformedBody = '```complexity-tier\nT2\n```';
    const rejected = await startPackReview({ ...common, fixtureIssueBody: malformedBody });
    expect(rejected).toMatchObject({ ok: false, created: false });
    expect(existsSync(paths.snapshotPath)).toBe(false);
    expect(existsSync(paths.metadataPath)).toBe(false);
    expect(resolveBoundIssueSnapshot(binding).status).toBe('missing');
    expect(rejected.reason).toContain('Issue #2408');
    expect(rejected.reason).toContain('tier: T1|T2|T3');

    const correctedBody = '```complexity-tier\ntier: T2\n```';
    const admitted = await startPackReview({ ...common, fixtureIssueBody: correctedBody });
    expect(admitted).toMatchObject({ ok: true, created: true });
    const snapshot = resolveBoundIssueSnapshot(binding);
    expect(snapshot.status).toBe('found');
    expect(readFileSync(paths.snapshotPath, 'utf8')).toBe(correctedBody);
    const metadataBytes = readFileSync(paths.metadataPath, 'utf8');

    const reused = await startPackReview({ ...common, fixtureIssueBody: malformedBody });
    expect(reused).toMatchObject({ ok: true, created: false, reused: true });
    expect(readFileSync(paths.snapshotPath, 'utf8')).toBe(correctedBody);
    expect(readFileSync(paths.metadataPath, 'utf8')).toBe(metadataBytes);
    expect(resolveBoundIssueSnapshot(binding).snapshotHash).toBe(snapshot.snapshotHash);
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


describe('Issue #1887 immediate final-cap descendant reconciliation', () => {
  it('observes a live strict descendant and settles without prior smoke or review-start observation', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'pack-review-1887-immediate-settlement-'));
    roots.push(parent);
    const storeRoot = join(parent, 'store');
    setupHarness(storeRoot);

    const prNumber = 18972;
    const reviewed = 'b'.repeat(40);
    const current = 'c'.repeat(40);
    const authorityOptions = { storeRoot };
    let authority = initializePackReviewAuthority({
      prNumber,
      headSha: reviewed,
      tier: 'T2',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      options: authorityOptions,
    });

    const run = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber,
      headSha: reviewed,
      trustedPackRoot: process.cwd(),
      sourceRepoRoot: process.cwd(),
      canonicalRepository: 'chetwerikoff/orchestrator-pack',
      accountingVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      reviewCycleId: authority.cycle!.cycleId,
      logicalRoundOrdinal: 1,
      logicalRoundCap: 1,
      resolvedReviewer: 'codex',
      automaticBudgetDisposition: 'consume',
    }).run;
    setPackReviewRunTerminal(run.id, 'changes_requested', {
      reviewVerdict: 'findings',
      findingCount: 1,
      findings: [{ severity: 'blocking', title: 'fixture finding' }],
      automaticBudgetDisposition: 'consume',
    }, { projectId: 'orchestrator-pack', storeRoot });

    authority = commitPackReviewTerminal({
      prNumber,
      expectedTransitionSeq: authority.transitionSeq,
      terminal: {
        schemaVersion: 1,
        terminalContractVersion: 2,
        terminalSource: 'normal',
        runId: run.id,
        targetSha: reviewed,
        reviewVerdict: 'findings',
        findingCount: 1,
        findingsDigest: 'issue-1887-immediate-fixture',
        automaticBudgetDisposition: 'consume',
        logicalRoundOrdinal: 1,
      },
      status: 'changes_requested',
      findingCount: 1,
      options: authorityOptions,
    });
    expect(authority.cycle).toMatchObject({
      state: 'at_cap_open_findings',
      consumedRoundOrdinals: [1],
    });
    expect(authority.currentHeadSha).toBe(reviewed);

    const reconciled = await reconcileStalePackReviewRuns({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: process.cwd(),
      repoSlug: 'chetwerikoff/orchestrator-pack',
      prNumber,
      immediate: true,
      fixtureCurrentPrHeadSha: current,
      fixtureReviewCompareStatus: 'ahead',
      fixtureRequiredStatusWriter: async () => {},
    });

    expect(reconciled.results).toContainEqual(expect.objectContaining({
      prNumber,
      headSha: current,
      finalCapSettlement: true,
      settled: true,
      reason: 'final_cap_descendant_settled',
    }));
    const settled = readPackReviewAuthority(prNumber, authorityOptions);
    expect(settled?.currentHeadSha).toBe(current);
    expect(settled?.cycle).toMatchObject({
      state: 'closed',
      consumedRoundOrdinals: [1],
      reviewStageComplete: true,
    });
  });
});

describe('Issue #2420 stale reconciliation linked-owner notification', () => {
  function fixture(linkedSessionId: string | undefined = 'synthetic-owner-2420') {
    const root = mkdtempSync(join(tmpdir(), 'pack-review-2420-'));
    roots.push(root);
    const storeRoot = join(root, 'store');
    setupHarness(storeRoot);
    const options = { projectId: 'orchestrator-pack', storeRoot };
    const create = () => createPackReviewRun({
      ...options, prNumber: 2420, headSha: HEAD, linkedSessionId,
      trustedPackRoot: process.cwd(), sourceRepoRoot: process.cwd(),
      canonicalRepository: 'chetwerikoff/orchestrator-pack', resolvedReviewer: 'codex',
    }).run;
    const run = create();
    updatePackReviewRun(run.id, {
      status: 'running', runnerPid: 99999999,
    }, { ...options, now: new Date('2026-01-01T00:00:00.000Z') });
    const notifications: Array<{ message: string; idempotencyKey: string; reviewRunId?: string }> = [];
    const statuses: string[] = [];
    const input = {
      ...options, prNumber: 2420, sourceRepoRoot: process.cwd(),
      repoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureRequiredStatusWriter: async (request: { state: string }) => { statuses.push(request.state); },
      fixtureWorkerNotifier: async (request: typeof notifications[number]) => {
        notifications.push(request);
        return { state: 'delivered' as const, reason: 'intercepted' };
      },
    };
    return { options, run, create, input, notifications, statuses };
  }

  it('terminalizes the authoritative stale run and wakes its exact linked owner', async () => {
    const f = fixture();
    await reconcileStalePackReviewRuns(f.input);
    expect(getPackReviewRun(f.run.id, f.options)).toMatchObject({
      status: 'failed', failureReason: 'runner_disappeared_stale',
      linkedSessionId: 'synthetic-owner-2420',
      deliveryOutcomes: { workerNotification: { state: 'delivered', reason: 'intercepted' } },
    });
    expect(f.statuses).toEqual(['error']);
    expect(f.notifications).toHaveLength(1);
    expect(f.notifications[0]).toMatchObject({
      reviewRunId: f.run.id, idempotencyKey: `worker-notification:${f.run.id}:${HEAD}`,
    });
    expect(f.notifications[0].message).toContain('runner_disappeared_stale');
    expect(f.notifications[0].message).toContain('GitHub-first');
    expect(f.notifications[0].message).toContain('docs/orchestration-runbook.md');
  });

  it('preserves persisted notification evidence on repeated reconciliation', async () => {
    const f = fixture();
    await reconcileStalePackReviewRuns(f.input);
    const before = getPackReviewRun(f.run.id, f.options)?.deliveryOutcomes;
    await reconcileStalePackReviewRuns(f.input);
    expect(f.notifications).toHaveLength(1);
    expect(getPackReviewRun(f.run.id, f.options)?.deliveryOutcomes).toEqual(before);
    expect(f.statuses).toEqual(['error']);
  });

  it('does not wake a superseded stale owner or overwrite newer authority', async () => {
    const f = fixture();
    const newer = f.create();
    await reconcileStalePackReviewRuns(f.input);
    expect(f.notifications).toEqual([]);
    expect(f.statuses).toEqual(['pending']);
    expect(getPackReviewRun(newer.id, f.options)?.status).toBe('queued');
  });

  it('does not invent an owner for an unlinked stale run', async () => {
    const f = fixture('');
    await reconcileStalePackReviewRuns(f.input);
    expect(f.notifications).toEqual([]);
    expect(f.statuses).toEqual(['error']);
  });

  it('does not notify when newer authority appears during the status write', async () => {
    const f = fixture();
    let newer: PackReviewRunRecord | undefined;
    await reconcileStalePackReviewRuns({
      ...f.input, fixturePauseAfterStaleStatusWrite: () => { newer = f.create(); },
    });
    expect(f.notifications).toEqual([]);
    expect(f.statuses).toEqual(['error', 'pending']);
    expect(getPackReviewRun(newer!.id, f.options)?.status).toBe('queued');
  });

  it('preserves notification failure without retrying or pretending it was delivered', async () => {
    const f = fixture();
    let attempts = 0;
    const input = { ...f.input, fixtureWorkerNotifier: async () => {
      attempts += 1;
      throw new Error('intercepted notification failure');
    } };
    await reconcileStalePackReviewRuns(input);
    const before = getPackReviewRun(f.run.id, f.options)?.deliveryOutcomes;
    await reconcileStalePackReviewRuns(input);
    expect(attempts).toBe(1);
    expect(before?.workerNotification).toMatchObject({
      state: 'failed', reason: 'intercepted notification failure',
    });
    expect(getPackReviewRun(f.run.id, f.options)?.deliveryOutcomes).toEqual(before);
  });

  it('recovers a missing notification after stale status was already journaled', async () => {
    const f = fixture('');
    await reconcileStalePackReviewRuns(f.input);
    const before = getPackReviewRun(f.run.id, f.options)?.deliveryOutcomes.requiredStatus;
    updatePackReviewRun(f.run.id, { linkedSessionId: 'synthetic-owner-2420' }, f.options);
    await reconcileStalePackReviewRuns(f.input);
    expect(f.notifications).toHaveLength(1);
    expect(f.statuses).toEqual(['error']);
    expect(getPackReviewRun(f.run.id, f.options)?.deliveryOutcomes.requiredStatus).toEqual(before);
  });
});

describe('Issue #2428 production scoped same-head Issue resolution', () => {
  const repository = 'chetwerikoff/orchestrator-pack';
  const prNumber = 245;
  const issueNumber = 228;
  const reviewedHead = '491c0d17a3532d9c53d4993e05bfcdeda6ec6591';
  const signature = 'c1218bc3453f2182a38b07ff4c4bbe8a24da86a2777fcaa9cb6d88ec9d37cc9e';
  const code = '228:r13-test-outside-allowed-roots';
  const revisedBody = '<!-- source-revision: r12 -->\n```allowed-roots\ntests/spot/test_field_benchmark_r13.py\n```\n```denylist\nvendor/**\npackages/core/**\n```\n';
  const editedAt = '2026-10-08T20:50:00Z';
  const terminalAt = '2026-10-08T20:40:00Z';
  const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  // Captured raw source payload, PR245 comment6068701751, updated_at2026-10-08T20:44:03Z.
  // Map through the same production source parser/emit seam rather than inventing a runtime finding.
  const witnessSource = { findings: [
    { type: 'scope', code, severity: 'blocking', path: 'tests/spot/test_field_benchmark_r13.py',
      summary: 'FIX_NOW: PR #245 modifies this r13 golden-test file although it is absent from the explicitly bound allowed-roots fence in both the review request and Issue #228. The r12 A8 amendment does specifically authorize switching its evaluator-entering cases to evaluate_field_adjustment_v1, but it did not amend the fenced path scope. This is a concrete scope mismatch, not an objection to that small test correction; merging as-is either violates the declared file boundary or requires bypassing its enforcement. Have the operator reconcile the r12 exception with the authoritative allowed-roots/runner declaration (add this one exact test path) and re-run the ordinary scope check; alternatively remove the out-of-scope edit and resolve A8 within an expressly authorized boundary. No new machinery is needed.', source: 'gpt-browser' },
    { type: 'quality', code: 'field:ambiguous-complete-window-undercount', severity: 'non-blocking', path: 'src/leopoker/spot/field.py',
      summary: 'DEFER: _quality_summary_v2 sets per-month and aggregate complete_response_windows to eligible-parent count minus ambiguous_response_parents. Trigger: 120 already-admitted parents, one legal complete direct SB-call/BB-raise or SB-first-aggression prefix. It reports 119 complete windows and zero incomplete_eligible_windows even though all 120 #180 direct windows passed response_window_outcome; ambiguity is the unobserved later continuation, not a missing/invalid direct window. This makes operator source-completeness diagnostics misleading, but the count-qualified ambiguous cell already refuses before frequencies or EV, so it need not block merge. Cheap correction: retain structural complete-window count N and report the ambiguous-parent count separately, as /1 does for structurally valid unsupported prefixes; no new state or gate.', source: 'gpt-browser' },
  ] };

  function fixture(settings: { scopeType?: string; scopePath?: string; allowedRoot?: string; denylist?: string[] } = {}) {
    const scopePath = settings.scopePath ?? witnessSource.findings[0]!.path;
    const allowedRoot = settings.allowedRoot ?? scopePath;
    const liveBody = `<!-- source-revision: r12 -->\n\`\`\`allowed-roots\n${allowedRoot}\n\`\`\`\n\`\`\`denylist\n${(settings.denylist ?? ['vendor/**', 'packages/core/**']).join('\n')}\n\`\`\`\n`;
    const root = mkdtempSync(join(tmpdir(), 'pack-review-2428-'));
    roots.push(root);
    const storeRoot = join(root, 'store');
    setupHarness(storeRoot);
    const options = { projectId: 'orchestrator-pack', storeRoot };
    const frozenBody = '<!-- source-revision: r12 -->\n```allowed-roots\nsrc/**\n```\n';
    captureBoundIssueSnapshot({ ...options, prNumber, prHeadSha: reviewedHead, issueNumber, issueBody: frozenBody });
    let authority = initializePackReviewAuthority({
      prNumber, headSha: reviewedHead, tier: 'T3', capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION, options,
    });
    authority = commitPackReviewTerminal({
      prNumber, expectedTransitionSeq: authority.transitionSeq, status: 'clean', findingCount: 0, options,
      terminal: { schemaVersion: 1, terminalContractVersion: 2, terminalSource: 'normal', runId: 'fixture-r1',
        targetSha: reviewedHead, reviewVerdict: 'clean', findingCount: 0, findingsDigest: fingerprint([]),
        automaticBudgetDisposition: 'consume', logicalRoundOrdinal: 1 },
    });
    const mapped = mapGptReplyToReviewPayload(JSON.stringify({ findings: [
      { ...witnessSource.findings[0], type: settings.scopeType ?? 'scope', path: scopePath }, witnessSource.findings[1],
    ] }));
    const [blocker, deferred] = mapped.findings;
    if (!blocker || !deferred) throw new Error('observed source payload lost its two findings');
    const sourceSignature = blocker.fingerprint;
    const run = createPackReviewRun({ ...options, prNumber, headSha: reviewedHead, trustedPackRoot: process.cwd(),
      sourceRepoRoot: process.cwd(), canonicalRepository: repository, resolvedReviewer: 'gpt',
      accountingVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION, reviewCycleId: authority.cycle!.cycleId,
      logicalRoundOrdinal: 2, logicalRoundCap: 2, now: new Date(terminalAt),
    }).run;
    const findings = [{ ...blocker, sourceSlotId: 'source-01' }, { ...deferred, sourceSlotId: 'source-01' }];
    updatePackReviewRun(run.id, { reviewRound: {
      schema: 'pack-review-gpt-round/v1', reviewer: 'gpt', tier: 'T3', accountingVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      roundOrdinal: 2, cardinality: 3, issueNumber, boundIssueSnapshotDigest: computeBoundIssueSnapshotHash(frozenBody),
      sourceSlots: [1, 2, 3].map((ordinal) => {
        const slotId = `source-${String(ordinal).padStart(2, '0')}`;
        const invocationId = `fixture-2428-${ordinal}`;
        return { slotId, ordinal, lifecycle: 'terminal' as const, invocationId, attemptOrdinal: 1,
          terminalClass: ordinal === 1 ? 'complete_findings' : 'complete_clean',
          payload: ordinal === 1 ? { verdict: 'findings', findingCount: 2, findings: [blocker, deferred] } : { verdict: 'clean', findingCount: 0, findings: [] },
          terminalResult: { schema: 'turn-result/v1', state: 'ok', cause: 'github_source_comment_credentialed', scope: 'none', send_count: 1, invocation_id: invocationId, source_comment_authority: 'credentialed_github',
            source_comment_receipt: { repository, prNumber, headSha: reviewedHead, runId: run.id, slotId, invocationId,
              commentId: 6068301800 + ordinal, commentUrl: `https://github.com/${repository}/pull/${prNumber}#issuecomment-${6068301800 + ordinal}`,
              actorLogin: 'chetwerikoff', createdAt: terminalAt, updatedAt: terminalAt, bodySha256: 'a'.repeat(64) } } };
      }),
    } }, options);
    setPackReviewRunTerminal(run.id, 'changes_requested', { reviewVerdict: 'findings', findingCount: 2, findings }, { ...options, now: new Date(terminalAt) });
    authority = commitPackReviewTerminal({
      prNumber, expectedTransitionSeq: authority.transitionSeq, status: 'changes_requested', findingCount: 2, options,
      terminal: { schemaVersion: 1, terminalContractVersion: 2, terminalSource: 'normal', runId: run.id,
        targetSha: reviewedHead, reviewVerdict: 'findings', findingCount: 2, findingsDigest: fingerprint(findings),
        automaticBudgetDisposition: 'consume', logicalRoundOrdinal: 2 },
    });
    // Captured witness R2 ordinary bullet shape; earlier R1 FIXED text must not authorize R2.
    const comment = { id: 6068301792, issue_url: `https://api.github.com/repos/${repository}/issues/${prNumber}`,
      html_url: `https://github.com/${repository}/pull/${prNumber}#issuecomment-6068301792`,
      user: { login: 'chetwerikoff' }, author_association: 'OWNER', created_at: '2026-10-08T20:19:17Z', updated_at: '2026-10-08T20:51:48Z',
      body: `R1 FIXED in code.\n\n## R2 dispositions — run \`${run.id}\`, head \`${reviewedHead}\`\n\n- **FIXED — blocking scope finding \`${code}\`** (source signature \`${sourceSignature}\`). The live r12 Issue now includes only \`${allowedRoot}\` in \`allowed-roots\`, under the operator amendment note.${allowedRoot === scopePath ? '' : ` This root covers \`${scopePath}\`.`} No code or behavior change was made for this disposition.\n- **DEFER — non-blocking \`field:ambiguous-complete-window-undercount\`**.`,
    };
    const issue = { node_id: 'fixture-issue-node', number: issueNumber, html_url: `https://github.com/${repository}/issues/${issueNumber}`,
      repository_url: `https://api.github.com/repos/${repository}`, body: liveBody };
    const graphIssue = { id: issue.node_id, number: issueNumber, url: issue.html_url, body: liveBody, lastEditedAt: editedAt,
      userContentEdits: { totalCount: 2, nodes: [{ editedAt, deletedAt: null, diff: liveBody }] } };
    const statuses: Array<{ state: string; context: string }> = [];
    const transports = { issue, graphIssue, comment, pr: { number: prNumber, url: `https://api.github.com/repos/${repository}/pulls/${prNumber}`,
      head: { sha: reviewedHead }, base: { ref: 'main' }, state: 'open', body: `Closes #${issueNumber}` } };
    const read = vi.fn(async (request: Parameters<typeof runProcess>[0]) => {
      const args = request.args ?? [];
      const endpoint = args.find((arg) => String(arg).startsWith('repos/')) ?? (args.includes('user') ? 'user' : undefined);
      const response = args.includes('graphql') ? { data: { repository: { nameWithOwner: repository, issue: transports.graphIssue } } }
        : endpoint === `repos/${repository}/pulls/${prNumber}` ? transports.pr
        : endpoint === `repos/${repository}/issues/${issueNumber}` ? transports.issue
        : endpoint?.endsWith('/comments') ? [[transports.comment]]
        : endpoint?.includes('/issues/comments/') ? transports.comment
        : endpoint === 'user' ? { login: 'chetwerikoff' } : undefined;
      if (!response) throw new Error(`unexpected offline transport: ${args.join(' ')}`);
      return { ok: true, outcome: 'exit' as const, exitCode: 0, stdout: endpoint === 'user' ? 'chetwerikoff' : JSON.stringify(response), stderr: '',
        timedOut: false, cancelled: false, signal: null, durationMs: 1 };
    });
    const input = { ...options, sourceRepoRoot: process.cwd(), repoSlug: repository, prNumber, immediate: true,
      fixtureCurrentPrHeadSha: reviewedHead, fixtureReviewCompareStatus: 'identical',
      fixtureSameHeadIssueResolutionRunner: read as typeof runProcess,
      fixtureRequiredCiPolicy: { contexts: ['CI', 'orchestrator-pack/pack-review'] },
      fixtureRequiredCiChecks: [{ name: 'CI', state: 'SUCCESS' }, { name: 'orchestrator-pack/pack-review', state: 'FAILURE' }],
      fixtureRequiredStatusWriter: async (request: { state: string; context: string }) => { statuses.push(request); },
    };
    return { input, options, authority, run, transports, read, statuses };
  }

  it('settles the observed final R2 same-head Issue-only scope correction and publishes status', async () => {
    const f = fixture();
    const before = getPackReviewRun(f.run.id, f.options);
    expect(before?.findings[0]).toMatchObject({ category: 'scope', fingerprint: signature, body: expect.stringContaining('type: scope\n') });
    const result = await reconcileStalePackReviewRuns(f.input);
    expect(result.results).toContainEqual(expect.objectContaining({ settled: true, reason: 'final_cap_same_head_issue_resolution_settled' }));
    expect(readPackReviewAuthority(prNumber, f.options)).toMatchObject({
      terminal: f.authority.terminal, currentHeadSha: reviewedHead,
      cycle: { state: 'closed', reviewStageComplete: true, consumedRoundOrdinals: [1, 2],
        settlementKind: 'same_head_issue_resolution', cycleId: f.authority.cycle!.cycleId },
    });
    expect(f.statuses).toContainEqual(expect.objectContaining({ state: 'success', context: 'orchestrator-pack/pack-review' }));
    expect(getPackReviewRun(f.run.id, f.options)?.reviewRound).toEqual(before?.reviewRound);
    const settled = readPackReviewAuthority(prNumber, f.options);
    await reconcileStalePackReviewRuns(f.input);
    expect(readPackReviewAuthority(prNumber, f.options)?.transitionSeq).toBe(settled?.transitionSeq);
  });

  it('R1 findings regression: accepts the observed raw type scope source through mapping and production reconcile', async () => {
    const f = fixture();
    expect(getPackReviewRun(f.run.id, f.options)?.findings[0]).toMatchObject({ category: 'scope', fingerprint: signature });
    const result = await reconcileStalePackReviewRuns(f.input);
    expect(result.results).toContainEqual(expect.objectContaining({ settled: true, reason: 'final_cap_same_head_issue_resolution_settled' }));
  });
  it.each(['tests/spot/**', 'tests/spot/'])('R1 findings regression: accepts an effective wildcard/prefix root %s', async (allowedRoot) => {
    const f = fixture({ scopeType: 'scope-violation', allowedRoot });
    const result = await reconcileStalePackReviewRuns(f.input);
    expect(result.results).toContainEqual(expect.objectContaining({ settled: true }));
    expect(f.statuses).toContainEqual(expect.objectContaining({ state: 'success' }));
  });
  it.each([
    ['config/prod.json', ['config/**']],
    ['tests/spot/test_field_benchmark_r13.py', ['tests/spot/**']],
    ['packages/core/file.ts', ['config/**']],
    ['vendor/file.ts', ['config/**']],
    ['credentials/file.json', ['config/**']],
    ['secrets/file.json', ['config/**']],
  ] as Array<[string, string[]]>)('R1 findings regression: denylist overrides literal allowed-root %s', async (scopePath, denylist) => {
    const f = fixture({ scopeType: 'scope-violation', scopePath, denylist });
    const before = readPackReviewAuthority(prNumber, f.options);
    const result = await reconcileStalePackReviewRuns(f.input);
    expect(result.results).toContainEqual(expect.objectContaining({ settled: false, reason: 'final_cap_strict_descendant_required' }));
    expect(readPackReviewAuthority(prNumber, f.options)).toEqual(before);
    expect(f.statuses).toEqual([]);
  });
  it('refuses a genuine quality/code finding even with scope-like author prose', async () => {
    const f = fixture({ scopeType: 'quality' });
    const result = await reconcileStalePackReviewRuns(f.input);
    expect(result.results).toContainEqual(expect.objectContaining({ settled: false, reason: 'final_cap_strict_descendant_required' }));
    expect(f.statuses).toEqual([]);
  });

  const unsafeCases: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ['wrong live PR number', (f) => { f.transports.pr.number = 246; }],
    ['wrong live PR repository', (f) => { f.transports.pr.url = 'https://api.github.com/repos/other/project/pulls/245'; }],
    ['wrong linked Issue', (f) => { f.transports.pr.body = 'Closes #229'; }],
    ['wrong live PR head', (f) => { f.transports.pr.head.sha = HEAD; }],
    ['wrong selected base', (f) => { f.transports.pr.base.ref = 'other-base'; }],
    ['CI projection moved head', (f) => { Object.assign(f.input, { fixtureRequiredCiPostProjectionHead: HEAD }); }],
    ['CI gate moved base', (f) => { Object.assign(f.input, { fixtureRequiredCiBaseAfterGate: 'other-base' }); }],
    ['code-required disposition', (f) => { f.transports.comment.body = f.transports.comment.body.replace('No code or behavior change was made for this disposition.', 'Fixed in code commit 4158987; regression test passed.'); }],
    ['bare FIXED', (f) => { f.transports.comment.body = `FIXED ${code} ${signature}`; }],
    ['missing disposition', (f) => { f.transports.comment.body = 'No author disposition yet.'; }],
    ['wrong run', (f) => { f.transports.comment.body = f.transports.comment.body.replace(f.run.id, 'prr-other'); }],
    ['wrong reviewed head', (f) => { f.transports.comment.body = f.transports.comment.body.replace(reviewedHead, HEAD); }],
    ['wrong round', (f) => { f.transports.comment.body = f.transports.comment.body.replace('## R2', '## R1'); }],
    ['wrong exact finding id', (f) => { f.transports.comment.body = f.transports.comment.body.replace(code, 'another-finding'); }],
    ['signature prefix only', (f) => { f.transports.comment.body = f.transports.comment.body.replace(signature, 'c1218bc'); }],
    ['non-blocking DEFER cannot erase blocker', (f) => { f.transports.comment.body = f.transports.comment.body.replace('FIXED — blocking scope finding', 'DEFER — blocking scope finding'); }],
    ['untrusted publisher', (f) => { f.transports.comment.user.login = 'other-principal'; }],
    ['conflicting publisher metadata', (f) => { f.transports.comment.author_association = 'NONE'; }],
    ['wrong disposition PR', (f) => { f.transports.comment.issue_url = `https://api.github.com/repos/${repository}/issues/246`; }],
    ['wrong Issue identity', (f) => { f.transports.graphIssue.number = 229; }],
    ['wrong Issue node', (f) => { f.transports.graphIssue.id = 'other-node'; }],
    ['wrong Issue repository', (f) => { f.transports.issue.repository_url = 'https://api.github.com/repos/other/project'; }],
    ['non-green required CI', (f) => { f.input.fixtureRequiredCiChecks[0]!.state = 'FAILURE'; }],
    ['missing required CI', (f) => { f.input.fixtureRequiredCiChecks = []; }],
    ['missing body-edit history', (f) => { f.transports.graphIssue.userContentEdits.nodes = []; }],
    ['deleted body-edit history', (f) => { Object.assign(f.transports.graphIssue.userContentEdits.nodes[0]!, { deletedAt: editedAt }); }],
    ['stale edit time', (f) => { f.transports.graphIssue.lastEditedAt = terminalAt; }],
    ['pre-terminal revision', (f) => { f.transports.graphIssue.lastEditedAt = terminalAt; f.transports.graphIssue.userContentEdits.nodes[0]!.editedAt = terminalAt; }],
    ['body history content mismatch', (f) => { f.transports.graphIssue.userContentEdits.nodes[0]!.diff = 'different revision'; }],
    ['current body drift', (f) => { f.transports.issue.body += '\nnew revision'; }],
    ['creation-only history', (f) => { f.transports.graphIssue.userContentEdits.totalCount = 1; }],
    ['wrong disposition revision', (f) => { f.transports.comment.body = f.transports.comment.body.replace('The live r12 Issue', 'The live r11 Issue'); }],
    ['no corrected root in Issue', (f) => { f.transports.issue.body = f.transports.graphIssue.body = f.transports.graphIssue.userContentEdits.nodes[0]!.diff = revisedBody.replace('tests/spot/test_field_benchmark_r13.py', 'other.py'); }],
  ];
  it.each(unsafeCases)('refuses %s through production scoped reconcile', async (_name, mutate) => {
    const f = fixture();
    mutate(f);
    const before = readPackReviewAuthority(prNumber, f.options);
    const result = await reconcileStalePackReviewRuns(f.input);
    expect(result.results).toContainEqual(expect.objectContaining({ settled: false, reason: 'final_cap_strict_descendant_required', nextAction: expect.any(String) }));
    expect(readPackReviewAuthority(prNumber, f.options)).toEqual(before);
    expect(f.statuses.some((request) => request.state === 'success')).toBe(false);
  });

  it.each(['cycle', 'round-cap', 'source-coverage', 'source-identity', 'repository'])('refuses %s mismatch in disposable persisted evidence', async (kind) => {
    const f = fixture();
    const path = join(f.options.storeRoot, 'runs', `${f.run.id}.json`);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as PackReviewRunRecord;
    if (kind === 'cycle') raw.reviewCycleId = 'other-cycle';
    if (kind === 'round-cap') raw.logicalRoundCap = 3;
    if (kind === 'repository') raw.canonicalRepository = 'other/project';
    if (kind === 'source-identity') {
      const receipt = (raw.reviewRound!.sourceSlots[2]!.terminalResult as { source_comment_receipt: { runId: string } }).source_comment_receipt;
      receipt.runId = 'other-run';
    }
    if (kind === 'source-coverage') {
      raw.reviewRound!.settledSourceCount = 2;
      Object.assign(raw.reviewRound!.sourceSlots[2]!, { terminalClass: 'profile_busy:profile_lease_contended',
        terminalResult: { schema: 'turn-result/v1', state: 'profile_busy', cause: 'profile_lease_contended', send_count: 0, scope: 'profile', invocation_id: 'fixture-2428-3' } });
      delete raw.reviewRound!.sourceSlots[2]!.payload;
    }
    // Deliberately malformed/adversarial fixture evidence; never a live runtime record.
    writeFileSync(path, JSON.stringify(raw));
    const before = readPackReviewAuthority(prNumber, f.options);
    const result = await reconcileStalePackReviewRuns(f.input);
    expect(result.results).toContainEqual(expect.objectContaining({ settled: false, reason: 'final_cap_strict_descendant_required' }));
    expect(readPackReviewAuthority(prNumber, f.options)).toEqual(before);
    expect(f.statuses.some((request) => request.state === 'success')).toBe(false);
  });

  it('keeps changed-head settlement on the observed strict-descendant route', async () => {
    const f = fixture();
    f.input.fixtureCurrentPrHeadSha = HEAD;
    f.input.fixtureReviewCompareStatus = 'ahead';
    const result = await reconcileStalePackReviewRuns(f.input);
    expect(result.results).toContainEqual(expect.objectContaining({ headSha: HEAD, settled: true, reason: 'final_cap_descendant_settled' }));
    expect(readPackReviewAuthority(prNumber, f.options)?.cycle).toMatchObject({ state: 'closed', reviewStageComplete: true, consumedRoundOrdinals: [1, 2] });
    expect(readPackReviewAuthority(prNumber, f.options)?.cycle?.settlementKind).toBeUndefined();
    expect(f.read).not.toHaveBeenCalled();
  });

  it('observes but refuses an unrelated changed head without taking the same-head shortcut', async () => {
    const f = fixture();
    f.input.fixtureCurrentPrHeadSha = HEAD;
    f.input.fixtureReviewCompareStatus = 'diverged';
    const result = await reconcileStalePackReviewRuns(f.input);
    expect(result.results).toContainEqual(expect.objectContaining({ settled: false, reason: 'final_cap_strict_descendant_required' }));
    expect(readPackReviewAuthority(prNumber, f.options)?.currentHeadSha).toBe(HEAD);
    expect(readPackReviewAuthority(prNumber, f.options)?.cycle?.reviewStageComplete).not.toBe(true);
    expect(f.read).not.toHaveBeenCalled();
  });

  it('retries status publication without a new logical round or duplicate settlement transition', async () => {
    const f = fixture();
    f.input.fixtureRequiredStatusWriter = async () => { throw new Error('offline status transport failed'); };
    const first = await reconcileStalePackReviewRuns(f.input);
    expect(first.results).toContainEqual(expect.objectContaining({ settled: false, detail: 'offline status transport failed' }));
    const before = readPackReviewAuthority(prNumber, f.options);
    f.input.fixtureRequiredStatusWriter = async (request) => { f.statuses.push(request); };
    const retried = await reconcileStalePackReviewRuns(f.input);
    expect(retried.results).toContainEqual(expect.objectContaining({ settled: true }));
    expect(readPackReviewAuthority(prNumber, f.options)?.transitionSeq).toBe(before!.transitionSeq + 1);
    expect(readPackReviewAuthority(prNumber, f.options)?.cycle?.consumedRoundOrdinals).toEqual([1, 2]);
  });
});
