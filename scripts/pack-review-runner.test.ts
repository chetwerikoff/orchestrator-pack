// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapGptReplyToReviewPayload } from './lib/pack-gpt-reviewer.ts';
import { runPackGptReviewCommand } from './pack-gpt-review.ts';
import {
  GithubReviewPostError,
  type GithubReviewSummary,
  type GithubReviewTransport,
} from './lib/github-review-reconciliation.ts';
import { formatPackGptSourceCommentEnvelope, type PackGptSourceIdentity } from './lib/pack-gpt-source-comment-contract.ts';
import {
  resolvePackGptSourceComment,
  type PackGptSourceCommentTransport,
  type PackGptSourceGithubComment,
} from './lib/pack-gpt-source-comment.ts';
import {
  observeGptPackReviewAttempt,
  observeNativePackReviewAttempt,
  recordClaudeNativeChildFrame,
  parseAuthoritativeTier,
  reconcileStalePackReviewRuns,
  maybeAdmitPackReviewBodyAmendment,
  resetPackReview,
  applyCliTargetProject,
  parseArgs,
  resolveGithubCommitIsStrictDescendant,
  startPackReview,
} from './pack-review-runner.ts';
import {
  createPackReviewRun,
  getPackReviewRun,
  listPackReviewRuns,
  resolvePackReviewRequiredRunOrder,
  resolvePackReviewRunStoreRoot,
  setPackReviewRunTerminal,
  updatePackReviewRun,
  type PackReviewRunRecord,
  type PackReviewGptRoundRecord,
} from './lib/pack-review-run-store.ts';
import {
  recordPackReviewPendingStatus,
  recordPackReviewStaleRequiredStatus,
  deliverPackReviewVerdict,
} from './lib/pack-review-delivery.ts';
import type { CarryoverReplayResult } from './pack-review-carryover.ts';
import { runProcess, runProcessSync } from './kernel/subprocess.ts';
import { getPackReviewerPreferencePath, writePackReviewerPreference } from './lib/pack-reviewer-preference.ts';
import { configuredProfileKey, profileDirs } from './chatgpt-browser-turn/storage-common.ts';
import { observationRecordPath } from './chatgpt-browser-turn/state-light-turn-observation.ts';
import { acquireReviewStartClaim, completeAfterRunInvoke } from './lib/review-start-claim-store.ts';
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
  settleLogicalPackReviewFindingsByStrictDescendant,
  stableJson,
} from './pack-review-state.ts';

const roots: string[] = [];
const originalEnv = { ...process.env };
const HEAD = 'a'.repeat(40);

describe('Issue #2635 public command incumbent 409 recovery actions', () => {
  it.each([
    'gpt_incumbent_owner_not_dead',
    'gpt_incumbent_claim_not_owned',
    'gpt_incumbent_identity_mismatch',
    'gpt_incumbent_ambiguous_run',
    'gpt_incumbent_authority_changed',
    'gpt_incumbent_concurrent_update',
    'gpt_preacquired_claim_not_owned',
    'gpt_original_invocation_recovery_required',
    'reply_recovery_required',
    'gpt_observation_unavailable',
  ])('preserves executable nextAction for %s', async (reason) => {
    const nextAction = reason.includes('claim_not_owned')
      ? 'npm run --silent pack-gpt-review -- --project orchestrator-pack --pr-number 2635'
      : 'node --experimental-strip-types scripts/pack-review-runner.ts reconcile --source-repo-root "/fixture/repo" --repo-slug chetwerikoff/orchestrator-pack --pr-number 2635 --immediate';
    const execution = await runPackGptReviewCommand({ prNumber: 2635 }, {
      env: {},
      stderr: { write: () => undefined },
      startReview: async () => ({
        ok: false, created: false, reused: true, reason, nextAction,
        reviewer: 'gpt', prNumber: 2635, headSha: HEAD, httpStatus: 409,
      }),
    });
    expect(execution.exitCode).toBe(1);
    expect(execution.result.runnerReason).toBe(reason);
    expect(execution.result.nextAction).toBe(nextAction);
    expect(nextAction.startsWith('npm run --silent pack-gpt-review')
      || nextAction.startsWith('node --experimental-strip-types scripts/pack-review-runner.ts reconcile')).toBe(true);
    expect(nextAction.startsWith('observe')).toBe(false);
  });
});

describe('Issue #2565 CLI help smoke regression', () => {
  it.each(['--help', '-h'] as const)(
    'accepts standalone %s and prints audited reset usage successfully', (flag) => {
      const output = runProcessSync({
        command: process.execPath,
        args: ['--experimental-strip-types', 'scripts/pack-review-runner.ts', flag],
        cwd: process.cwd(),
        inheritParentEnv: false,
      });
      expect(output).toMatchObject({ outcome: 'exit', ok: true, exitCode: 0 });
      for (const fragment of ['reset --project <id>', '--pr-number <n>',
        '--actor <actor>', '--reason <text>', '--nonce <value>']) {
        expect(output.stdout).toContain(fragment);
      }
      expect(output.stderr).not.toContain('unknown subcommand');
    },
  );
});

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

  it('allows replacement only for an attempted action with exact affirmative no-dispatch evidence', async () => {
    const cause = 'affirmative_pre_actionability_no_dispatch';
    const run = gptRun('2026-08-30T00:00:00.000Z');
    const slot = run.reviewRound!.sourceSlots[0]!;
    slot.lifecycle = 'terminal';
    slot.terminalClass = 'send_failed:affirmative_pre_actionability_no_dispatch';
    slot.terminalResult = {
      state: 'send_failed', cause, send_attempted: true, send_count: 0,
      invocation_id: slot.invocationId, configured_profile_key: 'profile-01',
    };
    const readObservation = vi.fn(() => ({
      schema: 'state-light-turn-observation/v1' as const, version: 1 as const,
      invocation_id: slot.invocationId, profile_key: 'profile-01',
      marker: `OPKTURNV1${'a'.repeat(32)}`,
      phase: 'not_sent' as const, transition_reason: cause,
      send_count: 0, send_witness: 'none' as const, conversation_url: null,
      transitioned_at: '2026-08-30T00:00:00.000Z',
    }));
    const listTargets = vi.fn(async () => {
      throw new Error('affirmative_pre_dispatch_never_needs_cdp_observation');
    });
    const observed = await observeGptPackReviewAttempt(run, Date.parse('2026-08-30T00:01:00.000Z'), {
      ...gptObservationDeps({ markerPresent: false, generating: false }),
      readObservation: readObservation as never, listTargets: listTargets as never,
    });
    expect(observed).toMatchObject({
      state: 'replacement_eligible', replacementEligible: true,
      replacementEligibleSlotIds: ['slot-01'],
    });
    expect(readObservation).toHaveBeenCalledWith('profile-01', 'invocation-01');
    expect(listTargets).not.toHaveBeenCalled();
  });

  it.each(['dispatching', 'unreadable', 'unbound', 'wrong_identity', 'not_sent'] as const)(
    'requires affirmative exact pre-dispatch evidence for legacy zero-count terminals: %s', async (mode) => {
      const run = gptRun('2026-08-30T00:00:00.000Z');
      const slot = run.reviewRound!.sourceSlots[0]!;
      slot.lifecycle = 'terminal';
      slot.terminalClass = 'driver_error:locator_timeout';
      slot.terminalResult = {
        state: 'driver_error', cause: 'locator_timeout', send_count: 0,
        ...(mode === 'not_sent' ? { send_attempted: true } : {}),
      };
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
        state: mode === 'not_sent' || mode === 'dispatching' ? 'generating' : 'observation_unavailable',
        replacementEligible: false,
      });
      // The historical attempted-zero not_sent/locator_timeout/fixture record
      // cannot acquire affirmative no-dispatch authority by its phase alone.
      expect(observed?.replacementEligibleSlotIds).toEqual([]);
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


describe('Issue #2474 Claude same-ordinal child rollover and original budget', () => {
  it('records both real child frames and observes the newest live group without resetting the clock', async () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'pack-review-2474-children-'));
    roots.push(root);
    const storeRoot = join(root, 'store');
    setupHarness(storeRoot);
    const started = '2026-10-10T00:00:00.000Z';
    const repairedAt = '2026-10-10T00:09:00.000Z';
    const run = createPackReviewRun({
      projectId: 'orchestrator-pack', storeRoot, prNumber: 2474,
      headSha: HEAD, trustedPackRoot: process.cwd(), sourceRepoRoot: process.cwd(),
      canonicalRepository: 'chetwerikoff/orchestrator-pack', resolvedReviewer: 'claude',
    });
    const runId = run.run.id;
    updatePackReviewRun(runId, {
      nativeAttempt: {
        schema: 'pack-review-native-attempt/v1', reviewer: 'claude',
        invocationOrdinal: 1, startedAtUtc: started,
        effectiveBudgetMs: 10 * 60_000, wrapperPid: process.pid,
      },
    }, { projectId: 'orchestrator-pack', storeRoot });
    const binding = { runId, projectId: 'orchestrator-pack', storeRoot, invocationOrdinal: 1 };
    const initial = {
      schema: 'pack-review-native-child/v1', runId,
      reviewer: 'claude', pid: 91_001, processGroupId: 91_001, startedAtUtc: started,
    };
    expect(recordClaudeNativeChildFrame(initial, { ...binding, invocationOrdinal: 2 })).toBe(false);
    expect(recordClaudeNativeChildFrame({ ...initial, reviewer: 'codex' }, binding)).toBe(false);
    expect(recordClaudeNativeChildFrame(initial, binding)).toBe(true);

    // Start a private detached synthetic group; no live Claude or external review.
    // Using the existing process primitive keeps the group observation factual.
    let resolvePid!: (pid: number) => void;
    const spawned = new Promise<number>((resolve) => { resolvePid = resolve; });
    const childExit = runProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      allowEmptyStdout: true,
      onSpawn: resolvePid,
    });
    const activePid = await spawned;
    try {
      expect(recordClaudeNativeChildFrame({
        ...initial, pid: activePid, processGroupId: activePid, startedAtUtc: repairedAt,
      }, binding)).toBe(true);
      const persisted = getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot })!;
      expect(persisted.nativeAttempt).toMatchObject({
        reviewer: 'claude', invocationOrdinal: 1,
        startedAtUtc: started, childStartedAtUtc: repairedAt,
        childPid: activePid, childProcessGroupId: activePid,
      });
      expect(observeNativePackReviewAttempt(persisted, Date.parse(started) + 9 * 60_000))
        .toMatchObject({
          reviewer: 'claude', state: 'running', elapsedMs: 9 * 60_000,
          nativeReplacementCeilingMs: 600_000, replacementEligible: false,
        });
      expect(observeNativePackReviewAttempt(persisted, Date.parse(started) + 10 * 60_000))
        .toMatchObject({
          reviewer: 'claude', state: 'running', elapsedMs: 600_000,
          replacementEligible: true,
        });
      process.kill(-activePid, 'SIGKILL');
      await childExit;
      expect(observeNativePackReviewAttempt(persisted, Date.parse(started) + 9 * 60_000 + 1))
        .toMatchObject({ state: 'stopped', replacementEligible: true, elapsedMs: 540_001 });
    } finally {
      try { process.kill(-activePid, 'SIGKILL'); } catch { /* already stopped */ }
      await childExit;
    }
  });

  it('keeps ordinal-2 conflict fallback independently armed and does not alter Codex clock behavior', async () => {
    if (process.platform === 'win32') return;
    const start = '2026-10-10T00:00:00.000Z';
    const arm2 = '2026-10-10T00:05:00.000Z';
    const repair2 = '2026-10-10T00:09:00.000Z';
    let resolvePid!: (pid: number) => void;
    const spawned = new Promise<number>((resolve) => { resolvePid = resolve; });
    const childExit = runProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      allowEmptyStdout: true,
      onSpawn: resolvePid,
    });
    const pid = await spawned;
    try {
      const base = {
        nativeAttempt: {
          schema: 'pack-review-native-attempt/v1', reviewer: 'claude',
          invocationOrdinal: 2, startedAtUtc: arm2,
          childStartedAtUtc: repair2, effectiveBudgetMs: 600_000,
          wrapperPid: pid, processGroupId: pid,
          childPid: pid, childProcessGroupId: pid,
        },
      } as PackReviewRunRecord;
      expect(observeNativePackReviewAttempt(base, Date.parse(arm2) + 9 * 60_000))
        .toMatchObject({ state: 'running', replacementEligible: false, elapsedMs: 540_000 });
      expect(observeNativePackReviewAttempt(base, Date.parse(arm2) + 10 * 60_000))
        .toMatchObject({ state: 'running', replacementEligible: true, elapsedMs: 600_000 });
      base.nativeAttempt = {
        ...base.nativeAttempt!, reviewer: 'codex', invocationOrdinal: 1,
        startedAtUtc: start, processGroupId: pid,
      };
      expect(observeNativePackReviewAttempt(base, Date.parse(start) + 10 * 60_000))
        .toMatchObject({ reviewer: 'codex', state: 'running', replacementEligible: false, elapsedMs: 60_000 });
    } finally {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already stopped */ }
      await childExit;
    }
  });

  it('keeps an accepted Claude T2 fixture to one logical review round on the same head', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pack-review-2474-round-'));
    roots.push(root);
    const storeRoot = join(root, 'store');
    setupHarness(storeRoot);
    const prNumber = 2474;
    const options = { storeRoot };
    const common = {
      projectId: 'orchestrator-pack', storeRoot, sourceRepoRoot: process.cwd(),
      prNumber, headSha: HEAD, claimMode: 'preacquired' as const,
      fixtureCurrentPrHeadSha: HEAD, fixturePostReviewHeadSha: HEAD,
      fixturePrState: 'OPEN' as const,
      fixturePrBody: 'Closes #2474', fixturePostReviewPrBody: 'Closes #2474',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack', fixtureIssueNumber: 2474,
      fixtureIssueTitle: "[T2] Accepted reviewer fixture", fixtureIssueBody: '```complexity-tier\ntier: T2\n```',
      fixtureReviewStdout: cleanPayload(), fixtureGithubReviewId: 247401,
      fixtureReviewerLayerOverrides: { Process: 'claude', User: 'claude' },
      fixtureEmulateWin32Selector: true,
      fixtureRequiredStatusWriter: async () => {},
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    };
    const one = await startPackReview(common);
    expect(one).toMatchObject({ ok: true, created: true });
    expect(readPackReviewAuthority(prNumber, options)?.cycle?.consumedRoundOrdinals).toEqual([1]);
    await startPackReview(common);
    expect(readPackReviewAuthority(prNumber, options)?.cycle?.consumedRoundOrdinals).toEqual([1]);
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
      fixtureIssueTitle: "[T3] Multi-round review fixture", fixtureIssueBody: '```complexity-tier\ntier: T3\nadvisory-prior: T3\n```',
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
      fixtureIssueTitle: "[T3] Carryover round fixture", fixtureIssueBody: '```complexity-tier\ntier: T3\nadvisory-prior: T3\n```',
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
      fixtureIssueTitle: "[T3] Same-head two rounds fixture", fixtureIssueBody: issueBody,
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
      fixtureIssueTitle: "[T3] Second round fixture", fixtureIssueBody: issueBody,
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
      fixtureIssueTitle: "[T3] Findings descendant fixture", fixtureIssueBody: issueBody,
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
      fixtureIssueTitle: "[T3] Native incumbent fixture", fixtureIssueBody: '```complexity-tier\ntier: T3\nadvisory-prior: T3\n```',
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
    // The persisted 30-minute native attempt has actually exceeded its ceiling;
    // a 20-minute active run would correctly be reused instead.
    const startedAt = new Date(Date.now() - 40 * 60_000);
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
      fixtureIssueTitle: "[T3] Reviewer retry fixture", fixtureIssueBody: '```complexity-tier\ntier: T3\nadvisory-prior: T3\n```',
      fixtureReviewStdout: cleanPayload(),
      fixtureReviewerLayerOverrides: { Process: 'codex', User: 'codex' },
      fixtureEmulateWin32Selector: true,
      fixtureRequiredStatusWriter: async () => {},
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    });

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, created: true, reused: false });
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
    const rejected = await startPackReview({ ...common, fixtureIssueTitle: "[T2] Rejected malformed block", fixtureIssueBody: malformedBody });
    expect(rejected).toMatchObject({ ok: false, created: false });
    expect(existsSync(paths.snapshotPath)).toBe(false);
    expect(existsSync(paths.metadataPath)).toBe(false);
    expect(resolveBoundIssueSnapshot(binding).status).toBe('missing');
    expect(rejected.reason).toContain('Issue #2408');
    expect(rejected.reason).toContain('tier: T1|T2|T3');

    const correctedBody = '```complexity-tier\ntier: T2\n```';
    const admitted = await startPackReview({ ...common, fixtureIssueTitle: "[T2] Corrected block", fixtureIssueBody: correctedBody });
    expect(admitted).toMatchObject({ ok: true, created: true });
    const snapshot = resolveBoundIssueSnapshot(binding);
    expect(snapshot.status).toBe('found');
    expect(readFileSync(paths.snapshotPath, 'utf8')).toBe(correctedBody);
    const metadataBytes = readFileSync(paths.metadataPath, 'utf8');

    const reused = await startPackReview({ ...common, fixtureIssueTitle: "[T2] Historical frozen block", fixtureIssueBody: malformedBody });
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
      fixtureIssueTitle: "Firefighter repair", fixtureIssueBody: '# Firefighter repair\n\nNo complexity tier is required.',
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
    const originalBody = '<!-- source-revision: r01 -->\n```complexity-tier\ntier: T2\n```\n';
    captureBoundIssueSnapshot({
      projectId: 'orchestrator-pack', prNumber, prHeadSha: reviewed,
      issueNumber: prNumber, issueBody: originalBody,
    });
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

    let publishedStatus: string | undefined;
    const reconciled = await reconcileStalePackReviewRuns({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: process.cwd(),
      repoSlug: 'chetwerikoff/orchestrator-pack',
      prNumber,
      immediate: true,
      fixtureCurrentPrHeadSha: current,
      fixtureReviewCompareStatus: 'ahead',
      fixturePrBody: `Closes #${prNumber}`, fixtureIssueNumber: prNumber,
      fixtureIssueTitle: '[T2] Final findings issue', fixtureIssueBody: originalBody,
      fixtureRequiredStatusReader: async () => publishedStatus,
      fixtureRequiredStatusWriter: async (request) => { publishedStatus = request.state; },
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

describe('Issue #2565 strict-descendant final-cap body binding', () => {
  const repository = 'chetwerikoff/orchestrator-pack';
  const originalBody = '<!-- source-revision: r01 -->\n```complexity-tier\ntier: T2\n```\nBinding r01\n';
  function fixture(reviewer: 'codex' | 'gpt' = 'codex', reviewedBody = originalBody) {
    const root = mkdtempSync(join(tmpdir(), 'pack-review-2565-'));
    roots.push(root);
    const storeRoot = join(root, 'store');
    setupHarness(storeRoot);
    const projectId = 'orchestrator-pack';
    const prNumber = 25651;
    const issueNumber = 2565;
    const reviewed = '4'.repeat(40);
    const current = '5'.repeat(40);
    const options = { projectId, storeRoot };
    captureBoundIssueSnapshot({
      projectId, prNumber, issueNumber, prHeadSha: reviewed, issueBody: reviewedBody,
    });
    let authority = initializePackReviewAuthority({
      prNumber, headSha: reviewed, tier: 'T2',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION, options,
    });
    const run = createPackReviewRun({
      ...options, prNumber, headSha: reviewed,
      trustedPackRoot: process.cwd(), sourceRepoRoot: process.cwd(),
      canonicalRepository: repository, resolvedReviewer: reviewer,
      accountingVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      reviewCycleId: authority.cycle!.cycleId, logicalRoundOrdinal: 1, logicalRoundCap: 1,
      automaticBudgetDisposition: 'consume',
    }).run;
    const findings = [{ severity: 'blocking', title: 'old findings',
      ...(reviewer === 'gpt' ? { sourceSlotId: 'source-01' } : {}) }];
    setPackReviewRunTerminal(run.id, 'changes_requested', {
      reviewVerdict: 'findings', findingCount: 1, findings,
      automaticBudgetDisposition: 'consume',
    }, options);
    if (reviewer === 'gpt') {
      updatePackReviewRun(run.id, { reviewRound: {
        schema: 'pack-review-gpt-round/v1', reviewer: 'gpt', tier: 'T2',
        accountingVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
        roundOrdinal: 1, cardinality: 3, issueNumber,
        boundIssueSnapshotDigest: computeBoundIssueSnapshotHash(reviewedBody),
        sourceSlots: [1, 2, 3].map((ordinal) => {
          const slotId = `source-${String(ordinal).padStart(2, '0')}`;
          const invocationId = `fixture-2565-${ordinal}`;
          return {
            slotId, ordinal, invocationId, lifecycle: 'terminal' as const,
            terminalClass: ordinal === 1 ? 'complete_findings' : 'complete_clean',
            attemptOrdinal: 1,
            payload: ordinal === 1
              ? { verdict: 'findings', findingCount: 1, findings }
              : { verdict: 'clean', findingCount: 0, findings: [] },
            terminalResult: {
              schema: 'turn-result/v1', state: 'ok', scope: 'none', send_count: 1,
              cause: 'github_source_comment_credentialed', invocation_id: invocationId,
              source_comment_authority: 'credentialed_github',
              source_comment_receipt: { repository, prNumber, headSha: reviewed, runId: run.id,
                slotId, invocationId, commentId: 8000000000 + ordinal,
                commentUrl: `https://github.com/${repository}/pull/${prNumber}#issuecomment-${8000000000 + ordinal}`,
                actorLogin: 'chetwerikoff', createdAt: '2026-10-14T01:00:00Z',
                updatedAt: '2026-10-14T01:00:00Z', bodySha256: 'a'.repeat(64) },
            },
          };
        }),
        settledSourceCount: 3,
      } }, options);
    }
    authority = commitPackReviewTerminal({
      prNumber, expectedTransitionSeq: authority.transitionSeq,
      terminal: { schemaVersion: 1, terminalContractVersion: 2,
        terminalSource: 'normal', runId: run.id, targetSha: reviewed,
        logicalRoundOrdinal: 1, reviewVerdict: 'findings', findingCount: 1,
        findingsDigest: 'fixture-final-findings', automaticBudgetDisposition: 'consume' },
      status: 'changes_requested', findingCount: 1, options,
    });
    let status = 'pending';
    const statusWrites: string[] = [];
    const request = (body: string) => ({
      ...options, repoSlug: repository, fixtureRepoSlug: repository,
      sourceRepoRoot: process.cwd(), prNumber,
      immediate: true, fixtureCurrentPrHeadSha: current,
      fixturePrState: 'OPEN', fixturePrBody: `Closes #${issueNumber}`,
      fixtureIssueNumber: issueNumber, fixtureIssueTitle: '[T2] Final findings Issue',
      fixtureIssueBody: body, fixtureReviewCompareStatus: 'ahead',
      fixtureRequiredStatusReader: async () => status,
      fixtureRequiredStatusWriter: async (value: { state: string }) => {
        status = value.state;
        statusWrites.push(value.state);
      },
    });
    return { ...options, repository, prNumber, issueNumber, reviewed, current, run, authority,
      request, statusWrites, getStatus: () => status, root };
  }

  it.each(['codex', 'gpt'] as const)(
    'final-cap unchanged Issue strict descendant, exact preflight %s snapshot', async (reviewer) => {
      const f = fixture(reviewer);
      const settled = await reconcileStalePackReviewRuns(f.request(originalBody));
      expect(settled.results).toContainEqual(expect.objectContaining({
        prNumber: f.prNumber, settled: true, reason: 'final_cap_descendant_settled',
      }));
      expect(readPackReviewAuthority(f.prNumber, { storeRoot: f.storeRoot })?.cycle)
        .toMatchObject({ state: 'closed', reviewStageComplete: true, consumedRoundOrdinals: [1] });
      expect(f.getStatus()).toBe('success');
    },
  );

  it.each(['codex', 'gpt'] as const)(
    'final-cap amended Issue strict descendant refuses unchanged source-revision for %s', async (reviewer) => {
      const f = fixture(reviewer);
      const result = await reconcileStalePackReviewRuns(f.request(originalBody + 'new authoritative requirement\n'));
      expect(result.results).toContainEqual(expect.objectContaining({
        settled: false, reason: 'final_cap_issue_body_amended',
        nextAction: expect.stringContaining('start one new review round on the current head; an Issue amendment resets the cap'),
      }));
      expect(f.statusWrites).not.toContain('success');
      expect(readPackReviewAuthority(f.prNumber, { storeRoot: f.storeRoot })?.cycle?.reviewStageComplete)
        .not.toBe(true);
    },
  );

  it('final-cap native snapshot binding rejects missing preflight metadata and wrong actual closing Issue', async () => {
    const f = fixture();
    const paths = boundIssueSnapshotArtifactPaths({
      projectId: 'orchestrator-pack', prNumber: f.prNumber,
      prHeadSha: f.reviewed, issueNumber: f.issueNumber,
    });
    rmSync(paths.metadataPath);
    const missing = await reconcileStalePackReviewRuns(f.request(originalBody));
    expect(missing.results).toContainEqual(expect.objectContaining({
      settled: false, reason: 'final_cap_review_binding_unverified',
    }));
    const wrong = await reconcileStalePackReviewRuns({
      ...f.request(originalBody), fixturePrBody: 'Closes #98765',
    });
    expect(wrong.results).toContainEqual(expect.objectContaining({
      settled: false, reason: 'final_cap_review_binding_unverified',
    }));
    expect(f.statusWrites).not.toContain('success');
  });

  it('normal PR-led start propagates the same amended final-cap refusal without a new review run', async () => {
    const f = fixture();
    const body = originalBody + 'new issue authority\n';
    const beforeCycle = readPackReviewAuthority(f.prNumber, { storeRoot: f.storeRoot })?.cycle?.cycleId;
    const outcome = await startPackReview({
      ...f.request(body), headSha: f.current, immediate: undefined,
      claimMode: 'preacquired', fixturePostReviewHeadSha: f.current,
      fixturePostReviewPrBody: `Closes #${f.issueNumber}`,
      fixtureReviewStdout: JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] }),
    });
    expect(outcome).toMatchObject({
      ok: false, created: false, reason: 'final_cap_issue_body_amended',
      nextAction: expect.stringContaining('start one new review round on the current head; an Issue amendment resets the cap'),
    });
    expect(readPackReviewAuthority(f.prNumber, { storeRoot: f.storeRoot })?.cycle)
      .toMatchObject({ cycleId: beforeCycle, consumedRoundOrdinals: [1] });
    expect(f.statusWrites).not.toContain('success');
  });

  it('final-cap native snapshot binding rejects post-terminal Issue rebinding and ambiguous originals on reconcile and start', async () => {
    const f = fixture('codex');
    const issueB = f.issueNumber + 1;
    const bodyB = originalBody + 'Second Issue body at unchanged r01\n';
    const closingB = 'Closes #' + issueB;
    // A normal at-cap PR-led start can capture B/H0 before refusing a
    // second terminal, but that later snapshot cannot prove the old A run.
    const sameHeadStart = await startPackReview({
      ...f.request(bodyB), headSha: f.reviewed, immediate: undefined,
      claimMode: 'preacquired', fixtureCurrentPrHeadSha: f.reviewed,
      fixturePrBody: closingB, fixtureIssueNumber: issueB,
      fixtureIssueTitle: '[T2] Second Issue',
      fixturePostReviewHeadSha: f.reviewed, fixturePostReviewPrBody: closingB,
      fixtureReviewStdout: cleanPayload(),
    });
    expect(sameHeadStart).toMatchObject({
      ok: true, created: false, reused: true, reason: 'terminal_run_exists',
    });
    expect(resolveBoundIssueSnapshot({
      projectId: f.projectId, prNumber: f.prNumber,
      prHeadSha: f.reviewed, issueNumber: issueB,
    }).status).toBe('found');
    const changedClosing = {
      ...f.request(bodyB), fixturePrBody: closingB, fixtureIssueNumber: issueB,
      fixtureIssueTitle: '[T2] Second Issue',
    };
    const reconciled = await reconcileStalePackReviewRuns(changedClosing);
    expect(reconciled.results).toContainEqual(expect.objectContaining({
      settled: false, reason: 'final_cap_review_binding_unverified',
    }));
    const started = await startPackReview({
      ...changedClosing, headSha: f.current, immediate: undefined,
      claimMode: 'preacquired', fixturePostReviewHeadSha: f.current,
      fixturePostReviewPrBody: closingB,
    });
    expect(started).toMatchObject({
      ok: false, created: false, reason: 'final_cap_review_binding_unverified',
    });
    expect(f.statusWrites).not.toContain('success');

    const ambiguous = fixture('codex');
    captureBoundIssueSnapshot({
      projectId: ambiguous.projectId, prNumber: ambiguous.prNumber,
      prHeadSha: ambiguous.reviewed, issueNumber: ambiguous.issueNumber + 1,
      issueBody: originalBody, capturedAt: new Date(Date.parse(ambiguous.run.createdAt) - 1000).toISOString(),
    });
    const refused = await reconcileStalePackReviewRuns(ambiguous.request(originalBody));
    expect(refused.results).toContainEqual(expect.objectContaining({
      settled: false, reason: 'final_cap_review_binding_unverified',
      detail: expect.stringContaining('ambiguous'),
    }));
    expect(ambiguous.statusWrites).not.toContain('success');
  });

  it('final-cap completed diverged-head start refuses amended body instead of publishing success', async () => {
    const f = fixture('codex');
    const completed = await reconcileStalePackReviewRuns(f.request(originalBody));
    expect(completed.results).toContainEqual(expect.objectContaining({ settled: true }));
    const priorSuccessCount = f.statusWrites.filter((s) => s === 'success').length;
    const diverged = '6'.repeat(40);
    const refused = await startPackReview({
      ...f.request(originalBody + 'Changed binding at unchanged r01\n'),
      headSha: diverged, fixtureCurrentPrHeadSha: diverged,
      fixtureReviewCompareStatus: 'diverged', immediate: undefined,
      claimMode: 'preacquired', fixturePostReviewHeadSha: diverged,
      fixturePostReviewPrBody: 'Closes #' + f.issueNumber,
    });
    expect(refused).toMatchObject({
      ok: false, created: false, reason: 'final_cap_issue_body_amended',
    });
    expect(f.statusWrites.filter((s) => s === 'success')).toHaveLength(priorSuccessCount);
    expect(readPackReviewAuthority(f.prNumber, { storeRoot: f.storeRoot })?.cycle)
      .toMatchObject({ state: 'closed', reviewStageComplete: true, consumedRoundOrdinals: [1] });
  });

  it.each(['codex', 'gpt'] as const)(
    'Issue #2659: admits one exact same-H1 B1 after a committed %s findings terminal and pending read-back', async (reviewer) => {
      const B0 = '<!-- source-revision: r01 -->\\n```complexity-tier\\ntier: T2\\n```\\n## Acceptance criteria\\n- old required behavior\\n\\n## Verification\\n- stable\\n'.replaceAll('\\n', '\n');
      const B1 = B0.replace('old required behavior', 'amended required behavior');
      const B2 = B0.replace('old required behavior', 'further required behavior');
      const f = fixture(reviewer, B0);
      const now = '2026-10-19T00:00:00.000Z';
      updatePackReviewRun(f.run.id, {
        journalOutcome: { state: 'persisted', recordedAtUtc: now, reason: 'verdict_persisted',
          idempotencyKey: `verdict:${f.run.id}:${f.reviewed}`, attempts: 1 },
        deliveryOutcomes: { githubComment: { state: 'succeeded', recordedAtUtc: now,
          reason: 'comment_published', idempotencyKey: `github-comment:${f.run.id}` } },
      }, f.options);
      const original = resolveBoundIssueSnapshot({
        projectId: f.projectId, prNumber: f.prNumber,
        prHeadSha: f.reviewed, issueNumber: f.issueNumber,
        snapshotDigest: computeBoundIssueSnapshotHash(B0),
      });
      expect(original.status).toBe('found');
      expect(readFileSync(original.snapshotPath!, 'utf8')).toBe(B0);
      let publicStatus = 'success';
      const writes: string[] = [];
      const request = (body: string) => ({
        ...f.request(body), fixtureCurrentPrHeadSha: f.reviewed,
        fixtureRequiredStatusReader: async () => publicStatus,
        fixtureRequiredStatusWriter: async (value: { state: string }) => {
          writes.push(value.state);
          publicStatus = value.state;
        },
      });
      const admission = await maybeAdmitPackReviewBodyAmendment(request(B1), {
        projectId: f.projectId, storeRoot: f.storeRoot, repoSlug: f.repository,
      });
      expect(admission).toMatchObject({
        amendmentAdmission: true, reason: 'body_amendment_admitted',
        headSha: f.reviewed, requiredStatusState: 'pending', settled: false,
      });
      expect(writes).toEqual(['pending']);
      expect(publicStatus).toBe('pending');
      const newAuthority = readPackReviewAuthority(f.prNumber, { storeRoot: f.storeRoot });
      expect(newAuthority?.cycle).toMatchObject({
        frozenCap: 1, state: 'open', consumedRoundOrdinals: [],
        amendmentOrigin: {
          originalCycleId: f.authority.cycle!.cycleId,
          originalTerminalRunId: f.run.id,
          reviewedBodyDigest: computeBoundIssueSnapshotHash(B0),
          amendedBodyDigest: computeBoundIssueSnapshotHash(B1),
        },
      });
      expect(newAuthority?.terminal).toBeUndefined();
      expect(readFileSync(original.snapshotPath!, 'utf8')).toBe(B0);
      expect(await maybeAdmitPackReviewBodyAmendment(request(B1), {
        projectId: f.projectId, storeRoot: f.storeRoot, repoSlug: f.repository,
      })).toBeNull();
      expect(await maybeAdmitPackReviewBodyAmendment(request(B2), {
        projectId: f.projectId, storeRoot: f.storeRoot, repoSlug: f.repository,
      })).toMatchObject({ amendmentAdmission: false, reason: 'amendment_prior_round_not_terminal' });
      expect(readPackReviewAuthority(f.prNumber, { storeRoot: f.storeRoot })?.cycle?.cycleId)
        .toBe(newAuthority?.cycle!.cycleId);
      expect(writes).toEqual(['pending']);
    },
  );

  it('Issue #2659: failed same-head pending write never admits an amended reviewer', async () => {
    const B0 = '<!-- source-revision: r01 -->\n```complexity-tier\ntier: T2\n```\n## Acceptance criteria\n- original\n';
    const B1 = B0.replace('- original', '- amended');
    const f = fixture('codex', B0);
    const before = readPackReviewAuthority(f.prNumber, { storeRoot: f.storeRoot });
    updatePackReviewRun(f.run.id, {
      journalOutcome: { state: 'persisted', recordedAtUtc: '2026-10-19T00:00:00.000Z',
        reason: 'verdict_persisted', idempotencyKey: `verdict:${f.run.id}:${f.reviewed}`,
        attempts: 1 },
      deliveryOutcomes: { githubComment: { state: 'succeeded',
        recordedAtUtc: '2026-10-19T00:00:00.000Z', reason: 'published',
        idempotencyKey: `github-comment:${f.run.id}` } },
    }, f.options);
    const refused = await maybeAdmitPackReviewBodyAmendment({
      ...f.request(B1), fixtureCurrentPrHeadSha: f.reviewed,
      fixtureRequiredStatusWriter: async () => { throw new Error('pending rejected'); },
      fixtureRequiredStatusReader: async () => 'success',
    }, { projectId: f.projectId, storeRoot: f.storeRoot, repoSlug: f.repository });
    expect(refused).toMatchObject({ amendmentAdmission: false, reason: 'amendment_admission_unverified' });
    expect(readPackReviewAuthority(f.prNumber, { storeRoot: f.storeRoot })?.cycle!.cycleId)
      .toBe(before?.cycle!.cycleId);
    expect(readPackReviewAuthority(f.prNumber, { storeRoot: f.storeRoot })?.terminal?.runId)
      .toBe(f.run.id);
  });

  it('does not claim to detect a comment-only amendment when Issue body is identical', async () => {
    const f = fixture();
    // Comment text never enters computeBoundIssueSnapshotHash; only a folded body would differ.
    const result = await reconcileStalePackReviewRuns(f.request(originalBody));
    expect(result.results).toContainEqual(expect.objectContaining({
      settled: true, reason: 'final_cap_descendant_settled',
    }));
  });
});

describe('Issue #2565 selected-target reset and immutable H1/B0 to H2/B1 review', () => {
  it('reset target project card; start after completed logical reset; completed reset required status deassertion; completed reset stale snapshot H1 to H2', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pack-review-2565-selected-'));
    roots.push(root);
    setupHarness(join(root, 'pack-harness'));
    const primaryRoot = join(root, 'actual-target');
    mkdirSync(primaryRoot, { recursive: true });
    expect(runProcessSync({
      command: 'git', args: ['init', '-q', primaryRoot], cwd: root, inheritParentEnv: false,
    }).ok).toBe(true);
    expect(runProcessSync({
      command: 'git', args: ['-C', primaryRoot, 'remote', 'add', 'origin',
        'https://github.com/chetwerikoff/AppliedIn.git'], cwd: root, inheritParentEnv: false,
    }).ok).toBe(true);
    const projectId = 'appliedin-2565';
    const repository = 'chetwerikoff/appliedin';
    const projectCard = join(process.env.XDG_CONFIG_HOME!, 'orchestrator-pack', 'projects',
      `${projectId}.json`);
    writeFileSync(projectCard, JSON.stringify({
      projectId, repository, primaryRoot, defaultBranch: 'main',
      orcaWorkspacePattern: '^test-only$', orchestratorTitlePattern: '^test-only$',
      browserGpt: { projectUrl: 'https://example.invalid/test-only' },
    }));
    process.env.OPK_PROJECT_ID = projectId;
    process.env.ORCHESTRATOR_PACK_STATE_ROOT = join(root, 'state');
    const storeRoot = resolvePackReviewRunStoreRoot({ projectId });
    const prNumber = 38;
    const issueNumber = 39;
    const H0 = '6'.repeat(40);
    const H1 = '7'.repeat(40);
    const H2 = '8'.repeat(40);
    const B0 = '<!-- source-revision: r04 -->\n```complexity-tier\ntier: T2\n```\nOld body\n';
    const B1 = '<!-- source-revision: r04 -->\n```complexity-tier\ntier: T2\n```\nFolded architect amendment\n';
    const opts = { projectId, storeRoot };
    for (const head of [H0, H1]) {
      captureBoundIssueSnapshot({
        projectId, prNumber, issueNumber, prHeadSha: head, issueBody: B0,
      });
    }
    let authority = initializePackReviewAuthority({
      prNumber, headSha: H0, tier: 'T2',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION, options: opts,
    });
    const run = createPackReviewRun({
      ...opts, prNumber, headSha: H0,
      trustedPackRoot: process.cwd(), sourceRepoRoot: primaryRoot,
      canonicalRepository: repository, resolvedReviewer: 'codex',
      accountingVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      reviewCycleId: authority.cycle!.cycleId,
      logicalRoundOrdinal: 1, logicalRoundCap: 1, automaticBudgetDisposition: 'consume',
    }).run;
    setPackReviewRunTerminal(run.id, 'changes_requested', {
      reviewVerdict: 'findings', findingCount: 1,
      findings: [{ severity: 'blocking', title: 'fixed by amended Issue' }],
      automaticBudgetDisposition: 'consume',
    }, opts);
    authority = commitPackReviewTerminal({
      prNumber, expectedTransitionSeq: authority.transitionSeq,
      terminal: { schemaVersion: 1, terminalContractVersion: 2,
        terminalSource: 'normal', runId: run.id, targetSha: H0,
        logicalRoundOrdinal: 1, reviewVerdict: 'findings', findingCount: 1,
        findingsDigest: 'immutable-final', automaticBudgetDisposition: 'consume' },
      status: 'changes_requested', findingCount: 1, options: opts,
    });
    authority = observePackReviewHead({
      prNumber, expectedTransitionSeq: authority.transitionSeq, headSha: H1, options: opts,
    });
    authority = settleLogicalPackReviewFindingsByStrictDescendant({
      prNumber, expectedTransitionSeq: authority.transitionSeq,
      reviewedHeadSha: H0, currentHeadSha: H1,
      reviewedHeadIsAncestor: true, options: opts,
    });
    const priorCycleId = authority.cycle!.cycleId;
    expect(authority.cycle).toMatchObject({
      state: 'closed', reviewStageComplete: true, consumedRoundOrdinals: [1],
    });
    expect(authority.cycle?.atCapHash).toBeUndefined();
    let status = 'success';
    const statusWrites: string[] = [];
    const writeStatus = async (value: { state: string }) => {
      status = value.state;
      statusWrites.push(value.state);
    };
    const cli = parseArgs([
      '--project', projectId, '--pr-number', String(prNumber),
      '--actor', 'owner', '--reason', 'body amended',
      '--nonce', 'operator-2565',
    ]);
    applyCliTargetProject(cli as { targetProjectId?: string; projectId?: string }, process.env);
    expect(cli).toMatchObject({ projectId, prNumber, actor: 'owner', nonce: 'operator-2565' });
    expect(() => applyCliTargetProject({
      targetProjectId: projectId, projectId: 'wrong-store',
    }, process.env)).toThrow(/conflicts|mismatch/);
    const request = {
      ...cli, fixturePrState: 'OPEN', fixtureRepoSlug: 'forged/wrong',
      fixtureCurrentPrHeadSha: H1, fixturePrBody: `Closes #${issueNumber}`,
      fixtureIssueNumber: issueNumber, fixtureIssueTitle: '[T2] Amended real Issue',
      fixtureIssueBody: B1, fixtureRequiredStatusWriter: writeStatus,
      fixtureRequiredStatusReader: async () => status,
    };
    await expect(resetPackReview({
      ...request, storeRoot: join(root, 'wrong-project-store'),
    })).rejects.toThrow(/selected project\/store mismatch/);
    expect(statusWrites).toEqual([]);
    await expect(resetPackReview({
      ...request, fixtureRequiredStatusReader: async () => 'success',
    })).rejects.toThrow(/pending status/);
    expect(readPackReviewAuthority(prNumber, opts)?.cycle?.cycleId).toBe(priorCycleId);
    expect(statusWrites).toEqual(['pending']);
    status = 'success';
    const reset = await resetPackReview(request);
    const resetCycleId = String(reset.cycleId);
    expect(reset).toMatchObject({
      ok: true, projectId, repository, headSha: H1,
      requiredStatusState: 'pending', previousCycleId: priorCycleId,
    });
    expect(status).toBe('pending');
    const audited = readPackReviewAuthority(prNumber, opts)!;
    expect(audited.cycle).toMatchObject({
      cycleId: resetCycleId, frozenTier: 'T2', frozenCap: 1,
      state: 'open', consumedRoundOrdinals: [],
      resetProvenance: { priorCycleId, actor: 'owner', reason: 'body amended',
        nonce: 'operator-2565' },
    });
    expect(audited.cycle?.resetProvenance?.priorAtCapHash).toBeUndefined();

    const commonStart = {
      projectId, prNumber, storeRoot,
      claimMode: 'preacquired' as const,
      fixturePrState: 'OPEN', fixtureRepoSlug: 'forged/wrong',
      fixturePrBody: `Closes #${issueNumber}`,
      fixtureIssueNumber: issueNumber, fixtureIssueTitle: '[T2] Current real Issue',
      fixtureIssueBody: B1, fixtureReviewStdout: cleanPayload(),
      fixtureGithubReviewId: 38, fixtureRequiredStatusWriter: writeStatus,
      fixtureRequiredStatusReader: async () => status,
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    };
    const stale = await startPackReview({
      ...commonStart, headSha: H1, fixtureCurrentPrHeadSha: H1,
      fixturePostReviewHeadSha: H1, fixturePostReviewPrBody: `Closes #${issueNumber}`,
    });
    expect(stale).toMatchObject({
      ok: false, created: false, reason: 'completed_reset_stale_exact_head_snapshot',
      nextAction: expect.stringContaining('advance this same PR to a fresh head'),
    });
    expect(readPackReviewAuthority(prNumber, opts)?.cycle?.cycleId).toBe(resetCycleId);
    expect(readPackReviewAuthority(prNumber, opts)?.cycle?.consumedRoundOrdinals).toEqual([]);
    expect(status).toBe('pending');
    expect(resolveBoundIssueSnapshot({
      projectId, prNumber, issueNumber, prHeadSha: H1,
    }).snapshotHash).toBe(computeBoundIssueSnapshotHash(B0));

    const fresh = await startPackReview({
      ...commonStart, headSha: H2, fixtureCurrentPrHeadSha: H2,
      fixturePostReviewHeadSha: H2, fixturePostReviewPrBody: `Closes #${issueNumber}`,
    });
    expect(fresh).toMatchObject({ ok: true, created: true });
    const following = readPackReviewAuthority(prNumber, opts);
    expect(following?.cycle?.cycleId).toBe(resetCycleId);
    expect(following?.cycle?.resetProvenance).toMatchObject({
      priorCycleId, actor: 'owner', reason: 'body amended', nonce: 'operator-2565',
    });
    expect(resolveBoundIssueSnapshot({
      projectId, prNumber, issueNumber, prHeadSha: H2,
    })).toMatchObject({ status: 'found', snapshotHash: computeBoundIssueSnapshotHash(B1) });
    expect(resolveBoundIssueSnapshot({
      projectId, prNumber, issueNumber, prHeadSha: H1,
    }).snapshotHash).toBe(computeBoundIssueSnapshotHash(B0));
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

  function fixture(settings: { scopeType?: string; scopePath?: string; allowedRoot?: string; denylist?: string[]; summary?: string; details?: string; dispositionSignature?: string; frozenBodyOverride?: string } = {}) {
    const scopePath = settings.scopePath ?? witnessSource.findings[0]!.path;
    const allowedRoot = settings.allowedRoot ?? scopePath;
    const liveBody = `<!-- source-revision: r12 -->\n\`\`\`allowed-roots\n${allowedRoot}\n\`\`\`\n\`\`\`denylist\n${(settings.denylist ?? ['vendor/**', 'packages/core/**']).join('\n')}\n\`\`\`\n`;
    const root = mkdtempSync(join(tmpdir(), 'pack-review-2428-'));
    roots.push(root);
    const storeRoot = join(root, 'store');
    setupHarness(storeRoot);
    const options = { projectId: 'orchestrator-pack', storeRoot };
    const frozenBody = settings.frozenBodyOverride ?? '<!-- source-revision: r12 -->\n```allowed-roots\nsrc/**\n```\n';
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
      { ...witnessSource.findings[0], type: settings.scopeType ?? 'scope', path: scopePath,
        summary: settings.summary ?? witnessSource.findings[0]!.summary, ...(settings.details ? { details: settings.details } : {}) }, witnessSource.findings[1],
    ] }));
    const [blocker, deferred] = mapped.findings;
    if (!blocker || !deferred) throw new Error('observed source payload lost its two findings');
    const sourceSignature = settings.dispositionSignature ?? blocker.fingerprint;
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
      fixtureRequiredStatusReader: async (_headSha: string) => statuses.at(-1)?.state,
    };
    return { input, options, authority, run, transports, read, statuses };
  }

  // Strict-descendant status recovery cases now carry a preflight snapshot of
  // the *same* live Issue body. The original fixture above remains amended
  // for the separate same-head Issue-only authority tests.
  function unchangedDescendantFixture() {
    const f = fixture({ frozenBodyOverride: revisedBody });
    Object.assign(f.input, {
      fixturePrBody: `Closes #${issueNumber}`, fixtureIssueNumber: issueNumber,
      fixturePrState: 'OPEN', fixtureIssueTitle: '[T3] Frozen Issue 228',
      fixtureIssueBody: revisedBody,
    });
    return f;
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

  it.each(['scoped reconcile', 'PR-led start'] as const)(
    'completed same-head Issue resolution projects unchanged B1 to descendant without a new review via %s',
    async (entrypoint) => {
      const f = fixture();
      let liveHead = reviewedHead;
      const statusesByHead = new Map<string, string>();
      f.input.fixtureRequiredStatusWriter = async (request) => {
        f.statuses.push(request);
        statusesByHead.set(liveHead, request.state);
      };
      f.input.fixtureRequiredStatusReader = async (head) => statusesByHead.get(head);
      const initial = await reconcileStalePackReviewRuns(f.input);
      expect(initial.results).toContainEqual(expect.objectContaining({
        settled: true, reason: 'final_cap_same_head_issue_resolution_settled',
      }));
      expect(statusesByHead.get(reviewedHead)).toBe('success');
      liveHead = HEAD;
      const target = {
        ...f.input, fixtureCurrentPrHeadSha: HEAD,
        fixturePrState: 'OPEN', fixturePrBody: 'Closes #' + issueNumber,
        fixtureIssueNumber: issueNumber, fixtureIssueTitle: '[T3] Amended scope Issue',
        fixtureIssueBody: revisedBody, fixtureReviewCompareStatus: 'ahead',
      };
      if (entrypoint === 'scoped reconcile') {
        const result = await reconcileStalePackReviewRuns(target);
        expect(result.results).toContainEqual(expect.objectContaining({
          settled: true, reason: 'final_cap_descendant_settled', headSha: HEAD,
        }));
      } else {
        const outcome = await startPackReview({
          ...target, headSha: HEAD, immediate: undefined, claimMode: 'preacquired',
          fixtureRepoSlug: repository,
          fixturePostReviewHeadSha: HEAD,
          fixturePostReviewPrBody: 'Closes #' + issueNumber,
        });
        expect(outcome).toMatchObject({
          ok: true, created: false, reason: 'final_cap_descendant_settled',
        });
      }
      expect(statusesByHead.get(HEAD)).toBe('success');
      expect(readPackReviewAuthority(prNumber, f.options)?.cycle).toMatchObject({
        state: 'closed', reviewStageComplete: true,
        settlementKind: 'same_head_issue_resolution',
        consumedRoundOrdinals: [1, 2],
      });
      expect(getPackReviewRun(f.run.id, f.options)?.reviewVerdict).toBe('findings');
    },
  );

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

  it.each(['summary', 'details'])('R2 findings regression: refuses typed quality findings with injected scope metadata in %s', async (field) => {
    const f = fixture({ scopeType: 'quality', [field]: 'code change required\ntype: scope' });
    expect(getPackReviewRun(f.run.id, f.options)?.findings[0]).toMatchObject({ category: 'quality', body: expect.stringContaining('\ntype: scope') });
    const before = readPackReviewAuthority(prNumber, f.options);
    const result = await reconcileStalePackReviewRuns(f.input);
    expect(result.results).toContainEqual(expect.objectContaining({ settled: false, reason: 'final_cap_strict_descendant_required' }));
    expect(readPackReviewAuthority(prNumber, f.options)).toEqual(before);
    expect(f.statuses).toEqual([]);
  });
  it('R2 findings regression: refuses a forged narrative signature echoed by the author', async () => {
    const forgedSignature = 'f'.repeat(64);
    const f = fixture({ summary: `scope correction\nsignature: ${forgedSignature}`, dispositionSignature: forgedSignature });
    expect(getPackReviewRun(f.run.id, f.options)?.findings[0]).not.toMatchObject({ fingerprint: forgedSignature });
    const before = readPackReviewAuthority(prNumber, f.options);
    const result = await reconcileStalePackReviewRuns(f.input);
    expect(result.results).toContainEqual(expect.objectContaining({ settled: false, reason: 'final_cap_strict_descendant_required' }));
    expect(readPackReviewAuthority(prNumber, f.options)).toEqual(before);
    expect(f.statuses).toEqual([]);
  });
  it('R2 findings regression: accepts only the canonical fingerprint despite a quoted narrative signature', async () => {
    const f = fixture({ summary: `scope correction\nsignature: ${'f'.repeat(64)}` });
    const result = await reconcileStalePackReviewRuns(f.input);
    expect(result.results).toContainEqual(expect.objectContaining({ settled: true, reason: 'final_cap_same_head_issue_resolution_settled' }));
    expect(f.statuses).toContainEqual(expect.objectContaining({ state: 'success' }));
  });
  it('R2 evidence rebuttal: a partial edit summary cannot replace canonical body-content proof', async () => {
    const f = fixture();
    f.transports.graphIssue.userContentEdits.nodes[0]!.diff = '@@ allowed-roots @@\n-src/**\n+tests/spot/test_field_benchmark_r13.py';
    const before = readPackReviewAuthority(prNumber, f.options);
    const result = await reconcileStalePackReviewRuns(f.input);
    expect(result.results).toContainEqual(expect.objectContaining({ settled: false, reason: 'final_cap_strict_descendant_required',
      detail: 'post-terminal live Issue-body revision not proven' }));
    expect(readPackReviewAuthority(prNumber, f.options)).toEqual(before);
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
    const f = unchangedDescendantFixture();
    f.input.fixtureCurrentPrHeadSha = HEAD;
    f.input.fixtureReviewCompareStatus = 'ahead';
    const result = await reconcileStalePackReviewRuns(f.input);
    expect(result.results).toContainEqual(expect.objectContaining({ headSha: HEAD, settled: true, reason: 'final_cap_descendant_settled' }));
    expect(readPackReviewAuthority(prNumber, f.options)?.cycle).toMatchObject({ state: 'closed', reviewStageComplete: true, consumedRoundOrdinals: [1, 2] });
    expect(readPackReviewAuthority(prNumber, f.options)?.cycle?.settlementKind).toBeUndefined();
    expect(f.read).not.toHaveBeenCalled();
  });

  it('observes but refuses an unrelated changed head without taking the same-head shortcut', async () => {
    const f = unchangedDescendantFixture();
    f.input.fixtureCurrentPrHeadSha = HEAD;
    f.input.fixtureReviewCompareStatus = 'diverged';
    const result = await reconcileStalePackReviewRuns(f.input);
    expect(result.results).toContainEqual(expect.objectContaining({ settled: false, reason: 'final_cap_strict_descendant_required' }));
    expect(readPackReviewAuthority(prNumber, f.options)?.currentHeadSha).toBe(HEAD);
    expect(readPackReviewAuthority(prNumber, f.options)?.cycle?.reviewStageComplete).not.toBe(true);
    expect(f.read).not.toHaveBeenCalled();
  });

  it('Issue #2451: head moving during final-cap success cannot produce a settled receipt', async () => {
    const f = fixture();
    let currentHead = reviewedHead;
    Object.assign(f.input, {
      fixtureReadCurrentPrHead: async () => currentHead,
      fixtureRequiredStatusWriter: async (request: { state: string; context: string }) => {
        f.statuses.push(request);
        currentHead = HEAD;
      },
    });
    const first = await reconcileStalePackReviewRuns(f.input);
    expect(first.results).toContainEqual(expect.objectContaining({
      settled: false, reason: 'status_not_published',
      detail: 'final_cap_head_or_authority_changed_during_status',
    }));
    expect(readPackReviewAuthority(prNumber, f.options)?.publication?.status).not.toBe('succeeded');
    expect(f.statuses).toHaveLength(1);
  });

  it('Issue #2451: strict descendant retries failed publication without a second settlement', async () => {
    const f = unchangedDescendantFixture();
    f.input.fixtureCurrentPrHeadSha = HEAD;
    f.input.fixtureReviewCompareStatus = 'ahead';
    f.input.fixtureRequiredStatusWriter = async () => { throw new Error('offline descendant status failure'); };
    const first = await reconcileStalePackReviewRuns(f.input);
    expect(first.results).toContainEqual(expect.objectContaining({
      settled: false, reason: 'status_not_published',
      detail: expect.stringContaining('offline descendant status failure'),
    }));
    const before = readPackReviewAuthority(prNumber, f.options);
    expect(before?.cycle).toMatchObject({ state: 'closed', reviewStageComplete: true, consumedRoundOrdinals: [1, 2] });
    f.input.fixtureRequiredStatusWriter = async (request) => { f.statuses.push(request); };
    const retried = await reconcileStalePackReviewRuns(f.input);
    expect(retried.results).toContainEqual(expect.objectContaining({
      settled: true, statusPublished: true, publicationHeadSha: HEAD,
      reason: 'final_cap_descendant_settled',
    }));
    expect(f.statuses).toContainEqual(expect.objectContaining({ state: 'success' }));
    expect(readPackReviewAuthority(prNumber, f.options)?.transitionSeq).toBe(before!.transitionSeq + 1);
    expect(readPackReviewAuthority(prNumber, f.options)?.cycle?.consumedRoundOrdinals).toEqual([1, 2]);
  });


  it('Issue #2451: a closed descendant with a missing GitHub status retries, then confirms without duplicate publication', async () => {
    const f = unchangedDescendantFixture();
    f.input.fixtureCurrentPrHeadSha = HEAD;
    f.input.fixtureReviewCompareStatus = 'ahead';
    const statusesByHead = new Map<string, string>();
    f.input.fixtureRequiredStatusReader = async (headSha: string) => statusesByHead.get(headSha);
    f.input.fixtureRequiredStatusWriter = async (request) => {
      f.statuses.push(request);
      statusesByHead.set(HEAD, request.state);
    };
    const first = await reconcileStalePackReviewRuns(f.input);
    expect(first.results).toContainEqual(expect.objectContaining({
      settled: true, statusPublished: true, publicationHeadSha: HEAD,
      reason: 'final_cap_descendant_settled',
    }));
    const closed = readPackReviewAuthority(prNumber, f.options);
    expect(closed?.publication).toMatchObject({ status: 'succeeded', headSha: HEAD });
    expect(f.statuses).toHaveLength(1);

    // A persisted success receipt does not prove the corresponding GitHub status
    // still exists. This is the production missing-status-after-settlement case.
    statusesByHead.delete(HEAD);
    const recovered = await reconcileStalePackReviewRuns(f.input);
    expect(recovered.results).toContainEqual(expect.objectContaining({
      settled: true, statusPublished: true, publicationHeadSha: HEAD,
      reason: 'final_cap_descendant_settled',
    }));
    expect(f.statuses).toHaveLength(2);
    expect(statusesByHead.get(HEAD)).toBe('success');
    expect(readPackReviewAuthority(prNumber, f.options)?.transitionSeq).toBe(closed?.transitionSeq);
    expect(readPackReviewAuthority(prNumber, f.options)?.cycle?.consumedRoundOrdinals).toEqual([1, 2]);

    const confirmedAgain = await reconcileStalePackReviewRuns(f.input);
    expect(confirmedAgain.results).toContainEqual(expect.objectContaining({
      settled: true, statusPublished: true, publicationHeadSha: HEAD,
    }));
    expect(f.statuses).toHaveLength(2);
    expect(readPackReviewAuthority(prNumber, f.options)?.transitionSeq).toBe(closed?.transitionSeq);
  });

  it('Issue #2451: a settled strict descendant projects a later live head without reopening the review cap', async () => {
    const f = unchangedDescendantFixture();
    let liveHead = HEAD;
    const statusByHead = new Map<string, string>();
    f.input.fixtureCurrentPrHeadSha = HEAD;
    f.input.fixtureReviewCompareStatus = 'ahead';
    f.input.fixtureReadCurrentPrHead = async () => liveHead;
    f.input.fixtureRequiredStatusReader = async (headSha: string) => statusByHead.get(headSha);
    f.input.fixtureRequiredStatusWriter = async (request) => {
      f.statuses.push(request);
      statusByHead.set(liveHead, request.state);
    };
    const first = await reconcileStalePackReviewRuns(f.input);
    expect(first.results).toContainEqual(expect.objectContaining({
      settled: true, statusPublished: true, publicationHeadSha: HEAD,
      reason: 'final_cap_descendant_settled',
    }));
    const beforeHeadAdvance = readPackReviewAuthority(prNumber, f.options);
    expect(f.statuses).toHaveLength(1);

    liveHead = 'd'.repeat(40);
    f.input.fixtureCurrentPrHeadSha = liveHead;
    const second = await reconcileStalePackReviewRuns(f.input);
    expect(second.results).toContainEqual(expect.objectContaining({
      settled: true, statusPublished: true, publicationHeadSha: liveHead,
      reason: 'final_cap_descendant_settled',
    }));
    const current = readPackReviewAuthority(prNumber, f.options);
    expect(current?.currentHeadSha).toBe(liveHead);
    expect(current?.cycle).toMatchObject({
      cycleId: beforeHeadAdvance?.cycle?.cycleId,
      state: 'closed', reviewStageComplete: true, consumedRoundOrdinals: [1, 2],
    });
    expect(statusByHead.get(liveHead)).toBe('success');
    expect(f.statuses).toHaveLength(2);

    const third = await reconcileStalePackReviewRuns(f.input);
    expect(third.results).toContainEqual(expect.objectContaining({
      settled: true, statusPublished: true, publicationHeadSha: liveHead,
    }));
    expect(f.statuses).toHaveLength(2);
    expect(readPackReviewAuthority(prNumber, f.options)?.transitionSeq).toBe(current?.transitionSeq);
  });

  it('Issue #2451: an acknowledged write without a GitHub success status stays unsettled and is retryable', async () => {
    const f = unchangedDescendantFixture();
    f.input.fixtureCurrentPrHeadSha = HEAD;
    f.input.fixtureReviewCompareStatus = 'ahead';
    let githubStatus: string | undefined;
    f.input.fixtureRequiredStatusReader = async () => githubStatus;
    f.input.fixtureRequiredStatusWriter = async (request) => { f.statuses.push(request); };
    const failed = await reconcileStalePackReviewRuns(f.input);
    expect(failed.results).toContainEqual(expect.objectContaining({
      settled: false, reason: 'status_not_published',
      detail: 'final_cap_success_status_unconfirmed_on_current_head',
    }));
    expect(f.statuses).toHaveLength(1);
    expect(readPackReviewAuthority(prNumber, f.options)?.publication?.status).not.toBe('succeeded');
    const beforeRetry = readPackReviewAuthority(prNumber, f.options);

    f.input.fixtureRequiredStatusWriter = async (request) => {
      f.statuses.push(request);
      githubStatus = request.state;
    };
    const retry = await reconcileStalePackReviewRuns(f.input);
    expect(retry.results).toContainEqual(expect.objectContaining({
      settled: true, statusPublished: true, publicationHeadSha: HEAD,
      reason: 'final_cap_descendant_settled',
    }));
    expect(f.statuses).toHaveLength(2);
    expect(readPackReviewAuthority(prNumber, f.options)?.transitionSeq).toBe(beforeRetry!.transitionSeq + 1);
    expect(readPackReviewAuthority(prNumber, f.options)?.cycle?.consumedRoundOrdinals).toEqual([1, 2]);
  });

  it('Issue #2451: changing the selected run verdict authority during awaited publication cannot claim success', async () => {
    const f = unchangedDescendantFixture();
    f.input.fixtureCurrentPrHeadSha = HEAD;
    f.input.fixtureReviewCompareStatus = 'ahead';
    let githubStatus: string | undefined;
    f.input.fixtureRequiredStatusReader = async () => githubStatus;
    f.input.fixtureRequiredStatusWriter = async (request) => {
      f.statuses.push(request);
      githubStatus = request.state;
      const path = join(f.options.storeRoot, 'runs', `${f.run.id}.json`);
      const latest = JSON.parse(readFileSync(path, 'utf8')) as PackReviewRunRecord;
      writeFileSync(path, JSON.stringify({ ...latest, reviewCycleId: 'other-cycle' }));
    };
    const result = await reconcileStalePackReviewRuns(f.input);
    expect(result.results).toContainEqual(expect.objectContaining({
      settled: false, reason: 'status_not_published',
      detail: 'final_cap_head_or_authority_changed_during_status',
    }));
    expect(readPackReviewAuthority(prNumber, f.options)?.publication?.status).not.toBe('succeeded');
    expect(f.statuses).toHaveLength(1);
  });

  it('retries status publication without a new logical round or duplicate settlement transition', async () => {
    const f = fixture();
    f.input.fixtureRequiredStatusWriter = async () => { throw new Error('offline status transport failed'); };
    const first = await reconcileStalePackReviewRuns(f.input);
    expect(first.results).toContainEqual(expect.objectContaining({
      settled: false, reason: 'status_not_published',
      detail: expect.stringContaining('offline status transport failed'),
    }));
    const before = readPackReviewAuthority(prNumber, f.options);
    f.input.fixtureRequiredStatusWriter = async (request) => { f.statuses.push(request); };
    const retried = await reconcileStalePackReviewRuns(f.input);
    expect(retried.results).toContainEqual(expect.objectContaining({ settled: true }));
    expect(readPackReviewAuthority(prNumber, f.options)?.transitionSeq).toBe(before!.transitionSeq + 1);
    expect(readPackReviewAuthority(prNumber, f.options)?.cycle?.consumedRoundOrdinals).toEqual([1, 2]);
  });
});

describe('Issue #2479 frozen reviewer and accepted-verdict provenance', () => {
  function harness(prNumber: number, head: string, storeRoot: string) {
    return {
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
      fixtureIssueTitle: "[T2] Delivery retry fixture", fixtureIssueBody: '```complexity-tier\ntier: T2\n```',
      fixtureReviewStdout: cleanPayload(),
      fixtureRequiredStatusWriter: async () => {},
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    };
  }

  function captureComment(bodies: string[]) {
    const reviews: Array<{
      id: number; state: string; userLogin: string; submittedAt: string;
      body: string; commitId: string; url: string;
    }> = [];
    return {
      resolveActorLogin: async () => 'fixture-pack-reviewer',
      listReviews: async () => reviews.map((review) => ({ ...review })),
      postReview: async (input: { body: string; commitId: string }) => {
        const review = {
          id: 247901 + reviews.length,
          state: 'COMMENTED',
          userLogin: 'fixture-pack-reviewer',
          submittedAt: new Date().toISOString(),
          body: input.body,
          commitId: input.commitId,
          url: `https://example.test/reviews/${247901 + reviews.length}`,
        };
        reviews.push(review);
        bodies.push(input.body);
        return { id: review.id, url: review.url };
      },
      dismissReview: async () => {},
    };
  }

  it('freezes saved Claude selection despite a preference and ambient change at the pre-spawn boundary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-2479-frozen-'));
    roots.push(root);
    const storeRoot = join(root, 'store');
    setupHarness(storeRoot);
    const config = getPackReviewerPreferencePath(process.env);
    writePackReviewerPreference('claude', config);
    process.env.PACK_REVIEWER = 'gpt';
    const logPath = join(root, 'invocations.jsonl');
    process.env.PACK_REVIEW_RUNNER_INVOCATION_LOG = logPath;
    const comments: string[] = [];
    const head = '4'.repeat(40);
    const result = await startPackReview({
      ...harness(247901, head, storeRoot),
      fixtureGithubReviewTransport: captureComment(comments),
      fixtureAfterNativeInitialArmed: async (run) => {
        expect(run).toMatchObject({
          resolvedReviewer: 'claude',
          resolvedReviewerSource: 'persistent-preference',
          executedReviewer: undefined,
        });
        writePackReviewerPreference('codex', config);
        process.env.PACK_REVIEWER = 'codex';
        process.env.PACK_REVIEW_BOUND_REVIEWER = 'gpt';
      },
    });
    expect(result).toMatchObject({
      ok: true, created: true, resolvedReviewer: 'claude',
      resolvedReviewerSource: 'persistent-preference',
      executedReviewer: 'claude', reviewerInvokedForThisRun: true,
    });
    const run = getPackReviewRun(String(result.runId), { projectId: 'orchestrator-pack', storeRoot });
    expect(run).toMatchObject({
      resolvedReviewer: 'claude', resolvedReviewerSource: 'persistent-preference',
      executedReviewer: 'claude', reviewerExecutionRunId: result.runId,
      reviewerInvokedForThisRun: true,
    });
    expect(JSON.parse(readFileSync(logPath, 'utf8').trim()).reviewer).toBe('claude');
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain('Selected reviewer: `claude`');
    expect(comments[0]).toContain('Selection source: `persistent-preference`');
    expect(comments[0]).toContain('Verdict reviewer: `claude`');
    expect(comments[0]).toContain(`Verdict execution run: \`${result.runId}\``);
  });

  it('keeps selected Claude separate from a credentialed source GPT clean carry-over without new invocation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-2479-carryover-'));
    roots.push(root);
    const storeRoot = join(root, 'store');
    setupHarness(storeRoot);
    const config = getPackReviewerPreferencePath(process.env);
    writePackReviewerPreference('claude', config);
    process.env.PACK_REVIEWER = 'gpt';
    const head0 = '5'.repeat(40);
    const head1 = '6'.repeat(40);
    const prNumber = 247902;
    const source = createPackReviewRun({
      projectId: 'orchestrator-pack', storeRoot, prNumber,
      headSha: head0, trustedPackRoot: process.cwd(),
      sourceRepoRoot: process.cwd(), canonicalRepository: 'chetwerikoff/orchestrator-pack',
      resolvedReviewer: 'gpt', resolvedReviewerSource: 'legacy-env',
    }).run;
    updatePackReviewRun(source.id, {
      status: 'up_to_date', latestRunStatus: 'up_to_date',
      reviewVerdict: 'clean', findingCount: 0, findings: [],
      executedReviewer: 'gpt', reviewerInvokedForThisRun: true, reviewerExecutionRunId: source.id,
      journalOutcome: {
        state: 'persisted', reason: 'verdict_persisted', recordedAtUtc: '2026-10-10T00:00:00.000Z',
        idempotencyKey: `verdict:${source.id}:${head0}`, attempts: 1,
      },
    }, { projectId: 'orchestrator-pack', storeRoot });
    const logPath = join(root, 'carryover-invocations.jsonl');
    process.env.PACK_REVIEW_RUNNER_INVOCATION_LOG = logPath;
    const comments: string[] = [];
    const result = await startPackReview({
      ...harness(prNumber, head1, storeRoot),
      fixtureGithubReviewTransport: captureComment(comments),
      fixtureCarryoverSourceCleanRunId: source.id,
      fixtureCarryoverReplay: {
        kind: 'conflict_free_carryover', sourceHeadSha: head0, targetHeadSha: head1,
        mainSha: '7'.repeat(40), mergeBaseSha: '8'.repeat(40),
        replayTreeSha: '9'.repeat(40), replayDigest: 'synthetic-replay',
      },
    });
    expect(result).toMatchObject({
      ok: true, created: true, resolvedReviewer: 'claude',
      resolvedReviewerSource: 'persistent-preference',
      executedReviewer: 'gpt', reviewerExecutionRunId: source.id,
      reviewerInvokedForThisRun: false,
    });
    expect(existsSync(logPath)).toBe(false);
    const run = getPackReviewRun(String(result.runId), { projectId: 'orchestrator-pack', storeRoot });
    expect(run).toMatchObject({
      resolvedReviewer: 'claude', resolvedReviewerSource: 'persistent-preference',
      executedReviewer: 'gpt', reviewerExecutionRunId: source.id,
      reviewerInvokedForThisRun: false,
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain('Selected reviewer: `claude`');
    expect(comments[0]).toContain(`Reviewer invocation: none for this run; carried-over clean verdict from \`${source.id}\` by \`gpt\`.`);
  });

  it('validates new optional provenance and keeps historical v1 records unretagged', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-2479-v1-'));
    roots.push(root);
    const storeRoot = join(root, 'store');
    setupHarness(storeRoot);
    const old = createPackReviewRun({
      projectId: 'orchestrator-pack', storeRoot, prNumber: 247903,
      headSha: '3'.repeat(40), trustedPackRoot: process.cwd(),
      sourceRepoRoot: process.cwd(), canonicalRepository: 'chetwerikoff/orchestrator-pack',
      resolvedReviewer: 'codex',
    }).run;
    const options = { projectId: 'orchestrator-pack', storeRoot };
    expect(getPackReviewRun(old.id, options)).toMatchObject({
      resolvedReviewer: 'codex', resolvedReviewerSource: undefined,
      executedReviewer: undefined, reviewerExecutionRunId: undefined,
      reviewerInvokedForThisRun: undefined,
    });
    expect(() => updatePackReviewRun(old.id, {
      resolvedReviewerSource: 'forged' as 'invocation-bound',
    }, options)).toThrow(/invalid resolvedReviewerSource/);
    expect(() => updatePackReviewRun(old.id, {
      executedReviewer: 'gpt', reviewerInvokedForThisRun: true,
      reviewerExecutionRunId: old.id,
    }, options)).toThrow(/fresh reviewer execution provenance mismatch/);
    expect(() => updatePackReviewRun(old.id, {
      reviewerInvokedForThisRun: 'false' as unknown as boolean,
    }, options)).toThrow(/invalid reviewerInvokedForThisRun/);
    expect(getPackReviewRun(old.id, options)?.resolvedReviewer).toBe('codex');
  });

  it('rejects journal-only scoped recovery before any status write for invalid saved preference or missing roots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-2479-resume-veto-'));
    roots.push(root);
    const storeRoot = join(root, 'store');
    setupHarness(storeRoot);
    const head = '2'.repeat(40);
    const prNumber = 247904;
    const config = getPackReviewerPreferencePath(process.env);
    const run = createPackReviewRun({
      projectId: 'orchestrator-pack', storeRoot, prNumber,
      headSha: head, trustedPackRoot: process.cwd(),
      sourceRepoRoot: process.cwd(), canonicalRepository: 'chetwerikoff/orchestrator-pack',
      resolvedReviewer: 'gpt', resolvedReviewerSource: 'legacy-env',
    }).run;
    updatePackReviewRun(run.id, {
      status: 'failed', latestRunStatus: 'failed',
      reviewVerdict: 'clean', findingCount: 0, findings: [],
      executedReviewer: 'gpt', reviewerExecutionRunId: run.id, reviewerInvokedForThisRun: true,
      journalOutcome: {
        state: 'persisted', reason: 'verdict_persisted', recordedAtUtc: '2026-10-10T00:00:00.000Z',
        idempotencyKey: `verdict:${run.id}:${head}`, attempts: 1,
      },
    }, { projectId: 'orchestrator-pack', storeRoot });
    const before = getPackReviewRun(run.id, { projectId: 'orchestrator-pack', storeRoot });
    const writeRequiredStatus = vi.fn(async () => {});
    const common = {
      repoSlug: 'chetwerikoff/orchestrator-pack',
      sourceRepoRoot: process.cwd(),
      projectId: 'orchestrator-pack', storeRoot, prNumber,
      fixtureRequiredStatusWriter: writeRequiredStatus,
      fixtureCurrentPrHeadSha: head,
    };
    writeFileSync(config, '{invalid-json');
    await expect(reconcileStalePackReviewRuns(common))
      .rejects.toThrow(/OPK_PACK_REVIEW_RESUME_REVIEWER_AUTHORITY_INVALID.*Repair/);
    await expect(startPackReview({
      ...harness(prNumber, head, storeRoot),
      reviewerOverride: 'claude',
      fixtureRequiredStatusWriter: writeRequiredStatus,
    })).rejects.toThrow(/OPK_PACK_REVIEW_RESUME_REVIEWER_AUTHORITY_INVALID.*Repair/);
    expect(writeRequiredStatus).not.toHaveBeenCalled();
    expect(getPackReviewRun(run.id, { projectId: 'orchestrator-pack', storeRoot })).toEqual(before);
    process.env.XDG_CONFIG_HOME = '';
    process.env.HOME = '';
    process.env.PACK_REVIEW_BOUND_REVIEWER = 'claude';
    await expect(reconcileStalePackReviewRuns(common))
      .rejects.toThrow(/OPK_PACK_REVIEW_RESUME_REVIEWER_AUTHORITY_INVALID.*CONFIG_ROOT_MISSING/);
    expect(writeRequiredStatus).not.toHaveBeenCalled();
    process.env.XDG_CONFIG_HOME = join(storeRoot, 'test-config');
    writePackReviewerPreference('claude', config);
    expect(getPackReviewRun(run.id, { projectId: 'orchestrator-pack', storeRoot }))
      .toMatchObject({ resolvedReviewer: 'gpt', executedReviewer: 'gpt' });
  });
});

describe('Issue #2496 r03 native reviewer no-regression controls', () => {
  function fixture(prNumber: number, reviewer: 'codex' | 'claude' = 'codex') {
    const root = mkdtempSync(join(tmpdir(), 'opk-2496-native-'));
    roots.push(root);
    const storeRoot = join(root, 'store');
    setupHarness(storeRoot);
    const writes: string[] = [];
    const input = {
      projectId: 'orchestrator-pack', storeRoot, sourceRepoRoot: process.cwd(),
      prNumber, headSha: HEAD, claimMode: 'preacquired' as const,
      fixtureCurrentPrHeadSha: HEAD, fixturePostReviewHeadSha: HEAD,
      fixturePrState: 'OPEN' as const,
      fixturePrBody: `Closes #${prNumber}`, fixturePostReviewPrBody: `Closes #${prNumber}`,
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureIssueNumber: prNumber,
      fixtureIssueTitle: "[T2] Verdict state fixture", fixtureIssueBody: '```complexity-tier\ntier: T2\n```',
      reviewerOverride: reviewer,
      fixtureReviewStdout: cleanPayload(),
      fixtureGithubReviewId: 249601,
      fixtureRequiredStatusWriter: async (request: { state: string }) => { writes.push(request.state); },
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    };
    return { input, writes, storeRoot };
  }

  it.each(['codex', 'claude'] as const)(
    'native %s fresh publication never invokes GPT-only status observation or forced repost',
    async (reviewer) => {
      const f = fixture(24962, reviewer);
      const statusReader = vi.fn(async () => { throw new Error('native status reader must not be used'); });
      const result = await startPackReview({
        ...f.input, fixtureRequiredStatusReader: statusReader,
      });
      expect(result).toMatchObject({
        ok: true, created: true, reason: 'completed', status: 'up_to_date',
        httpStatus: 201, resolvedReviewer: reviewer,
      });
      expect(result).not.toHaveProperty('publicationVerified');
      expect(result).not.toHaveProperty('publicationReason');
      expect(statusReader).not.toHaveBeenCalled();
      expect(f.writes).toEqual(['pending', 'success']);
      expect(readPackReviewAuthority(f.input.prNumber, { storeRoot: f.storeRoot })?.publication)
        .toMatchObject({ status: 'succeeded', headSha: HEAD });
    },
  );

  it('native notification-only failure preserves incumbent successful publication', async () => {
    const f = fixture(24961);
    const result = await startPackReview({
      ...f.input, fixtureWorkerNotifier: async () => { throw new Error('native notifier down'); },
      fixtureRequiredStatusReader: async () => { throw new Error('native must not read status'); },
    });
    expect(result).toMatchObject({ ok: true, reason: 'completed', httpStatus: 201 });
    expect(result).not.toHaveProperty('publicationVerified');
    expect(f.writes).toEqual(['pending', 'success']);
  });

  it('native failed required-status POST retains existing no-retry delivery behavior', async () => {
    const f = fixture(24963);
    let failed = false;
    const reader = vi.fn(async () => { throw new Error('native status reader must not be used'); });
    const result = await startPackReview({
      ...f.input, fixtureRequiredStatusReader: reader,
      fixtureRequiredStatusWriter: async (request) => {
        f.writes.push(request.state);
        if (request.state === 'success' && !failed) {
          failed = true;
          throw new Error('native status authorization denied');
        }
      },
    });
    expect(result).toMatchObject({
      ok: true, created: true, reason: 'completed_with_delivery_failures', httpStatus: 201,
    });
    expect(result).not.toHaveProperty('publicationVerified');
    expect(f.writes).toEqual(['pending', 'success']);
    expect(reader).not.toHaveBeenCalled();
    expect(getPackReviewRun(String(result.runId), { projectId: 'orchestrator-pack', storeRoot: f.storeRoot })
      ?.deliveryOutcomes.requiredStatus?.state).toBe('failed');
  });

  it('native accepted status is not changed by later observed external status drift', async () => {
    const f = fixture(24964);
    let externalStatus: string | undefined;
    const reader = vi.fn(async () => externalStatus);
    const result = await startPackReview({
      ...f.input, fixtureRequiredStatusReader: reader,
      fixtureRequiredStatusWriter: async (request) => {
        f.writes.push(request.state);
        externalStatus = request.state === 'success' ? 'error' : request.state;
      },
    });
    expect(result).toMatchObject({ ok: true, reason: 'completed', httpStatus: 201 });
    expect(result).not.toHaveProperty('publicationVerified');
    expect(reader).not.toHaveBeenCalled();
    expect(f.writes).toEqual(['pending', 'success']);
    expect(externalStatus).toBe('error');
  });

  it.each(['codex', 'claude'] as const)(
    'native %s journaled resume does not read or republish status beyond the incumbent channels',
    async (reviewer) => {
      const f = fixture(24966, reviewer);
      const seed = createPackReviewRun({
        projectId: 'orchestrator-pack', storeRoot: f.storeRoot,
        prNumber: f.input.prNumber, headSha: HEAD,
        trustedPackRoot: process.cwd(), sourceRepoRoot: process.cwd(),
        canonicalRepository: 'chetwerikoff/orchestrator-pack',
        resolvedReviewer: reviewer,
      }).run;
      const now = '2026-10-11T00:00:00.000Z';
      updatePackReviewRun(seed.id, {
        status: 'reviewing', latestRunStatus: 'reviewing',
        reviewVerdict: 'clean', findingCount: 0, findings: [],
        journalOutcome: {
          state: 'persisted', reason: 'verdict_persisted',
          recordedAtUtc: now, idempotencyKey: `verdict:${seed.id}:${HEAD}`, attempts: 1,
        },
        githubReviewId: 249602, githubReviewUrl: 'fixture://review/249602',
        githubReviewEvent: 'COMMENT',
        deliveryOutcomes: {
          githubComment: {
            state: 'succeeded', reason: 'comment_posted',
            recordedAtUtc: now, idempotencyKey: `github-comment:${seed.id}:${HEAD}`,
          },
        },
      }, { projectId: 'orchestrator-pack', storeRoot: f.storeRoot });
      const reader = vi.fn(async () => { throw new Error('native resume must not read status'); });
      const resumed = await startPackReview({ ...f.input, fixtureRequiredStatusReader: reader });
      expect(resumed).toMatchObject({
        ok: true, created: false, reused: true, recovered: true,
        reason: 'resumed_journaled_delivery', deliveryReason: 'completed',
        httpStatus: 200,
      });
      expect(resumed).not.toHaveProperty('publicationVerified');
      expect(reader).not.toHaveBeenCalled();
      expect(f.writes).toEqual(['success']);
      expect(readPackReviewAuthority(f.input.prNumber, { storeRoot: f.storeRoot })?.publication)
        .toMatchObject({ status: 'succeeded', headSha: HEAD });
    },
  );
});


describe('Issue #2537 linked Issue title and body tier authority', () => {
  const fenced = (tier: string) => `\`\`\`complexity-tier\ntier: ${tier}\n\`\`\``;

  it('takes the higher valid linked-Issue tier in both disagreement directions', () => {
    expect(parseAuthoritativeTier(fenced('T2'), '[T3] Actual linked Issue')).toBe('T3');
    expect(parseAuthoritativeTier(fenced('T3'), '[T2] Actual linked Issue')).toBe('T3');
    expect(parseAuthoritativeTier(fenced('T1'), '2537 — [T2] Actual Issue')).toBe('T2');
    expect(parseAuthoritativeTier(fenced('T2'), '2537 – [T3] Actual Issue')).toBe('T3');
    expect(parseAuthoritativeTier(fenced('T1'), '[T1] Actual Issue')).toBe('T1');
  });

  it('honors valid missing tiers without inventing a title or interpreting prose', () => {
    expect(parseAuthoritativeTier('No fenced tier.', '[T1] Bare title')).toBe('T1');
    expect(parseAuthoritativeTier(fenced('T1'), 'Markerless linked Issue')).toBe('T1');
    expect(parseAuthoritativeTier('Ordinary body', 'Markerless linked Issue')).toBe('T2');
    expect(parseAuthoritativeTier('Ordinary body [T3] tier T3', 'A title with later [T3]'))
      .toBe('T2');
    expect(parseAuthoritativeTier('No tier here', '2537 — [T2] Normal Issue')).toBe('T2');
    expect(parseAuthoritativeTier('No tier here', '[T3] A real Issue')).toBe('T3');
    expect(parseAuthoritativeTier('No tier here', '[Task] Normal labeled Issue')).toBe('T2');
    expect(parseAuthoritativeTier('No tier here')).toBe('T2');
    expect(parseAuthoritativeTier('<!-- ARCH tier T3 -->', 'Markerless linked Issue')).toBe('T2');
    expect(parseAuthoritativeTier('no authority', 'Title with incidental [T3]')).toBe('T2');
    expect(parseAuthoritativeTier('no authority', '[T1] Simple')).toBe('T1');
  });

  it('does not allow skip-line to erase an explicitly higher fenced tier', () => {
    const body = ['```complexity-tier', 'tier: T3', 'skip-line: true', '```'].join('\n');
    expect(parseAuthoritativeTier(body, '[T1] Real Issue')).toBe('T3');
  });

  it('rejects malformed leading title markers and malformed fenced tiers', () => {
    expect(() => parseAuthoritativeTier(fenced('T2'), '[T4] Unsupported'))
      .toThrow('title tier marker is malformed');
    expect(() => parseAuthoritativeTier(fenced('T1'), '[T3 Not Closed'))
      .toThrow('title tier marker is malformed');
    expect(() => parseAuthoritativeTier(fenced('T4'), '[T3] Looks valid'))
      .toThrow('authoritative Issue tier is invalid');
    expect(() => parseAuthoritativeTier('```complexity-tier\ntier: T2', '[T3] Valid title'))
      .toThrow('authoritative Issue tier is invalid');
    for (const opener of ['```complexity-tier draft', '```complexity-tier extra']) {
      expect(() => parseAuthoritativeTier([opener, 'tier: T3', '```'].join('\n'), '[T2] Lower title'))
        .toThrow('authoritative Issue tier is invalid');
    }
  });

  it('fails fresh linked-Issue admission on an unrecognized tier opening rather than freezing T2', async () => {
    for (const [index, suffix] of ['draft', 'extra'].entries()) {
      const root = mkdtempSync(join(tmpdir(), 'pack-review-2537-malformed-'));
      roots.push(root);
      const storeRoot = join(root, 'store');
      setupHarness(storeRoot);
      const prNumber = 253750 + index;
      const rejected = await startPackReview({
        projectId: 'orchestrator-pack', storeRoot, sourceRepoRoot: process.cwd(),
        prNumber, headSha: HEAD,
        fixtureCurrentPrHeadSha: HEAD, fixturePrState: 'OPEN',
        fixturePrBody: `Closes #${prNumber}`,
        fixtureRepoSlug: 'chetwerikoff/orchestrator-pack', fixtureIssueNumber: prNumber,
        fixtureIssueTitle: '[T2] Real lower linked title',
        fixtureIssueBody: ['```complexity-tier ' + suffix, 'tier: T3', '```'].join('\n'),
        fixtureReviewStdout: cleanPayload(), fixtureGithubReviewId: 2537501 + index,
      });
      expect(rejected).toMatchObject({ ok: false, created: false });
      expect(String(rejected.reason)).toContain('tier');
      expect(readPackReviewAuthority(prNumber, { storeRoot })?.cycle?.consumedRoundOrdinals ?? [])
        .toEqual([]);
    }
  });

  it('uses independently authored higher title to freeze cap 2 and publishes pending after clean ordinal one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pack-review-2537-title-cap-'));
    roots.push(root);
    const storeRoot = join(root, 'store');
    setupHarness(storeRoot);
    const statuses: string[] = [];
    const prNumber = 25371;
    const result = await startPackReview({
      projectId: 'orchestrator-pack', storeRoot, sourceRepoRoot: process.cwd(),
      prNumber, headSha: HEAD,
      fixtureCurrentPrHeadSha: HEAD, fixturePostReviewHeadSha: HEAD,
      fixturePrState: 'OPEN', fixturePrBody: 'Closes #25371',
      fixturePostReviewPrBody: 'Closes #25371',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureIssueNumber: 25371,
      fixtureIssueTitle: '25371 — [T3] independently authored title',
      fixtureIssueBody: fenced('T2'),
      fixtureReviewStdout: cleanPayload(),
      fixtureGithubReviewId: 2537101,
      fixtureRequiredStatusWriter: async (request) => { statuses.push(request.state); },
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    });
    expect(result).toMatchObject({ ok: true, created: true });
    const authority = readPackReviewAuthority(prNumber, { storeRoot });
    expect(authority?.cycle).toMatchObject({
      frozenTier: 'T3', frozenCap: 2, state: 'open',
      consumedRoundOrdinals: [1],
    });
    expect(authority?.cycle?.reviewStageComplete).not.toBe(true);
    expect(statuses.at(-1)).toBe('pending');
  });
});


describe('Issue #2537 promoted T2-at-cap second-round required CI gate', () => {
  it('denies round two until the existing required-CI resolver certifies the exact descendant head/base', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pack-review-2537-ci-'));
    roots.push(root);
    const storeRoot = join(root, 'store');
    setupHarness(storeRoot);
    const prNumber = 25372;
    const reviewed = '1'.repeat(40);
    const descendant = '2'.repeat(40);
    const base = {
      projectId: 'orchestrator-pack', storeRoot, sourceRepoRoot: process.cwd(),
      prNumber, claimMode: 'preacquired' as const,
      fixturePrState: 'OPEN' as const, fixturePrBody: `Closes #${prNumber}`,
      fixturePostReviewPrBody: `Closes #${prNumber}`,
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureIssueNumber: prNumber,
      fixtureReviewerLayerOverrides: { Process: 'codex', User: 'codex' },
      fixtureEmulateWin32Selector: true,
      fixtureRequiredStatusWriter: async () => {},
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    };
    const first = await startPackReview({
      ...base, headSha: reviewed,
      fixtureCurrentPrHeadSha: reviewed, fixturePostReviewHeadSha: reviewed,
      fixtureIssueTitle: '[T2] Original linked Issue',
      fixtureIssueBody: '```complexity-tier\ntier: T2\n```',
      fixtureReviewStdout: JSON.stringify({ verdict: 'findings', findingCount: 1,
        findings: [{ severity: 'blocking', title: 'fix before round two' }] }),
      fixtureGithubReviewId: 2537201,
    });
    expect(first).toMatchObject({ ok: true, created: true });
    const historicCycle = readPackReviewAuthority(prNumber, { storeRoot })!.cycle!;
    expect(historicCycle).toMatchObject({
      frozenTier: 'T2', frozenCap: 1, state: 'at_cap_open_findings',
      consumedRoundOrdinals: [1],
    });
    const issueAmendment = {
      ...base, surface: 'pr2-scheduler', headSha: descendant,
      fixtureCurrentPrHeadSha: descendant, fixturePostReviewHeadSha: descendant,
      fixtureReviewCompareStatus: 'ahead',
      fixtureIssueTitle: '[T3] Promoted linked Issue',
      fixtureIssueBody: '```complexity-tier\ntier: T3\n```',
      fixtureReviewStdout: cleanPayload(), fixtureGithubReviewId: 2537202,
      fixtureRequiredCiPolicy: { contexts: ['CI'] },
      fixtureRequiredCiChecks: [] as Array<{name: string; state: string}>,
    };
    const absent = await startPackReview(issueAmendment);
    expect(absent).toMatchObject({
      ok: false, created: false, reason: 'required_ci_not_green_for_current_head',
    });
    const amended = readPackReviewAuthority(prNumber, { storeRoot })!.cycle!;
    expect(amended).toMatchObject({
      cycleId: historicCycle.cycleId, frozenTier: 'T3', frozenCap: 2,
      state: 'open', consumedRoundOrdinals: [1],
    });
    const checks = [{ name: 'CI', state: 'SUCCESS' }];
    for (const negative of [
      { fixtureRequiredCiChecks: [{ name: 'CI', state: 'PENDING' }] },
      { fixtureRequiredCiChecks: [{ name: 'CI', state: 'FAILURE' }] },
      { fixtureRequiredCiChecks: checks, fixtureRequiredCiPostProjectionHead: reviewed },
      { fixtureRequiredCiChecks: checks, fixtureRequiredCiPostProjectionBase: 'other-base' },
      { fixtureRequiredCiChecks: checks, fixtureRequiredCiHeadAfterGate: reviewed },
    ]) {
      const result = await startPackReview({ ...issueAmendment, ...negative });
      expect(result).toMatchObject({
        ok: false, created: false, reason: 'required_ci_not_green_for_current_head',
      });
      expect(readPackReviewAuthority(prNumber, { storeRoot })!.cycle!.consumedRoundOrdinals)
        .toEqual([1]);
    }
    const admitted = await startPackReview({
      ...issueAmendment, fixtureRequiredCiChecks: checks,
    });
    expect(admitted).toMatchObject({ ok: true, created: true });
    expect(readPackReviewAuthority(prNumber, { storeRoot })!.cycle).toMatchObject({
      cycleId: historicCycle.cycleId, frozenTier: 'T3', frozenCap: 2,
      consumedRoundOrdinals: [1, 2], reviewStageComplete: true,
    });
  });
});


describe('Issue #2537 historical first-round status readback', () => {
  it('repairs old same-head cap-one success to pending without starting another reviewer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pack-review-2537-old-success-'));
    roots.push(root);
    const storeRoot = join(root, 'store');
    setupHarness(storeRoot);
    const prNumber = 25373;
    const statuses: string[] = [];
    let currentStatus: string | undefined;
    const common = {
      projectId: 'orchestrator-pack', storeRoot, sourceRepoRoot: process.cwd(),
      prNumber, headSha: HEAD, claimMode: 'preacquired' as const,
      fixtureCurrentPrHeadSha: HEAD, fixturePostReviewHeadSha: HEAD,
      fixturePrState: 'OPEN' as const,
      fixturePrBody: `Closes #${prNumber}`, fixturePostReviewPrBody: `Closes #${prNumber}`,
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack', fixtureIssueNumber: prNumber,
      fixtureReviewerLayerOverrides: { Process: 'codex', User: 'codex' },
      fixtureEmulateWin32Selector: true,
      fixtureRequiredStatusReader: async () => currentStatus,
      fixtureRequiredStatusWriter: async (request: { state: string }) => {
        currentStatus = request.state; statuses.push(request.state);
      },
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    };
    const first = await startPackReview({
      ...common,
      fixtureIssueTitle: '[T2] Original Issue title',
      fixtureIssueBody: '```complexity-tier\ntier: T2\n```',
      fixtureReviewStdout: JSON.stringify({
        verdict: 'findings', findingCount: 1,
        findings: [{ severity: 'warning', title: 'non-blocking note' }],
      }),
      fixtureGithubReviewId: 2537301,
    });
    expect(first).toMatchObject({ ok: true, created: true });
    expect(currentStatus).toBe('success');
    const original = readPackReviewAuthority(prNumber, { storeRoot })!;
    expect(original.cycle).toMatchObject({ frozenTier: 'T2', frozenCap: 1,
      state: 'at_cap_open_findings', consumedRoundOrdinals: [1] });
    const runId = original.terminal!.runId;
    const old = getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot })!;
    expect(old.logicalRoundCap).toBe(1);
    expect(old.logicalRoundOrdinal).toBe(1);
    const reentered = await startPackReview({
      ...common,
      fixtureIssueTitle: '[T3] Amended linked Issue',
      fixtureIssueBody: '```complexity-tier\ntier: T3\n```',
      fixtureReviewStdout: cleanPayload(), fixtureGithubReviewId: 2537302,
    });
    expect(reentered).toMatchObject({
      ok: false, created: false, reason: 'prior_round_findings_unresolved',
    });
    const current = readPackReviewAuthority(prNumber, { storeRoot })!;
    expect(current.cycle).toMatchObject({
      cycleId: original.cycle!.cycleId, frozenTier: 'T3', frozenCap: 2,
      state: 'open_findings', consumedRoundOrdinals: [1],
    });
    expect(currentStatus).toBe('pending');
    expect(statuses).toContain('success');
    expect(statuses.at(-1)).toBe('pending');
    const historical = getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot })!;
    expect(historical.logicalRoundCap).toBe(1);
    expect(historical.logicalRoundOrdinal).toBe(1);
    expect(historical.reviewRound?.tier).toBeUndefined();
  });
});


describe('Issue #2537 in-flight first-round escalation', () => {
  it('raises persisted T2 cap one before clean terminal while preserving the native run and publishing pending', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pack-review-2537-inflight-'));
    roots.push(root);
    const storeRoot = join(root, 'store');
    setupHarness(storeRoot);
    const prNumber = 25374;
    const statuses: string[] = [];
    const messages: string[] = [];
    let currentStatus: string | undefined;
    const reader = vi.fn(async (head: string) => {
      expect(head).toBe(HEAD);
      return currentStatus;
    });
    let armedRunId = '';
    const input = {
      projectId: 'orchestrator-pack', storeRoot, sourceRepoRoot: process.cwd(),
      prNumber, headSha: HEAD, claimMode: 'preacquired' as const,
      fixtureCurrentPrHeadSha: HEAD, fixturePostReviewHeadSha: HEAD,
      fixturePrState: 'OPEN' as const,
      fixturePrBody: `Closes #${prNumber}`,
      fixturePostReviewPrBody: `Closes #${prNumber}`,
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack', fixtureIssueNumber: prNumber,
      fixtureIssueTitle: '[T2] Original linked Issue',
      fixtureIssueBody: '```complexity-tier\ntier: T2\n```',
      fixtureReviewStdout: cleanPayload(), fixtureGithubReviewId: 2537401,
      fixtureReviewerLayerOverrides: { Process: 'codex', User: 'codex' },
      fixtureEmulateWin32Selector: true,
      fixtureRequiredStatusReader: reader,
      fixtureRequiredStatusWriter: async (request: {state: string}) => {
        statuses.push(request.state); currentStatus = request.state;
      },
      fixtureWorkerNotifier: async (request: {message: string}) => {
        messages.push(request.message);
        return { state: 'delivered' as const, reason: 'fixture' };
      },
      fixtureAfterNativeInitialArmed: async (run: PackReviewRunRecord) => {
        armedRunId = run.id;
        expect(run.logicalRoundOrdinal).toBe(1);
        expect(run.logicalRoundCap).toBe(1);
        input.fixtureIssueTitle = '[T3] Real Issue amended during round one';
        input.fixtureIssueBody = '```complexity-tier\ntier: T3\n```';
      },
    };
    const first = await startPackReview(input);
    expect(first).toMatchObject({
      ok: true, created: true, runId: armedRunId,
      publicationVerified: true, requiredStatusState: 'pending',
    });
    const authority = readPackReviewAuthority(prNumber, { storeRoot });
    expect(authority?.cycle).toMatchObject({
      frozenTier: 'T3', frozenCap: 2, state: 'open',
      consumedRoundOrdinals: [1],
    });
    expect(authority?.cycle?.reviewStageComplete).not.toBe(true);
    expect(statuses.at(-1)).toBe('pending');
    expect(messages).toEqual([expect.stringContaining('Pack-review status: pending')]);
    expect(messages[0]).not.toContain('Pack-review status: success');
    expect(reader).toHaveBeenCalledWith(HEAD);
    expect(getPackReviewRun(armedRunId, { projectId: 'orchestrator-pack', storeRoot }))
      .toMatchObject({ logicalRoundOrdinal: 1, logicalRoundCap: 1,
        accountingVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION });
  });
});

describe('Issue #2537 scoped final-cap promotion and status integrity', () => {
  async function seed(prNumber: number) {
    const root = mkdtempSync(join(tmpdir(), 'pack-review-2537-finalcap-'));
    roots.push(root);
    const storeRoot = join(root, 'store');
    setupHarness(storeRoot);
    const statuses: string[] = [];
    let published: string | undefined;
    const writer = async (request: {state: string}) => {
      published = request.state;
      statuses.push(request.state);
    };
    const first = await startPackReview({
      projectId: 'orchestrator-pack', storeRoot, sourceRepoRoot: process.cwd(),
      prNumber, headSha: HEAD, claimMode: 'preacquired',
      fixtureCurrentPrHeadSha: HEAD, fixturePostReviewHeadSha: HEAD,
      fixturePrState: 'OPEN', fixturePrBody: `Closes #${prNumber}`,
      fixturePostReviewPrBody: `Closes #${prNumber}`,
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack', fixtureIssueNumber: prNumber,
      fixtureIssueTitle: '[T2] Original linked Issue',
      fixtureIssueBody: '```complexity-tier\ntier: T2\n```',
      fixtureReviewerLayerOverrides: { Process: 'codex', User: 'codex' },
      fixtureEmulateWin32Selector: true,
      fixtureReviewStdout: JSON.stringify({ verdict: 'findings', findingCount: 1,
        findings: [{ severity: 'warning', title: 'historical nonblocking finding' }] }),
      fixtureGithubReviewId: prNumber,
      fixtureRequiredStatusWriter: writer,
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    });
    expect(first).toMatchObject({ ok: true, created: true });
    const authority = readPackReviewAuthority(prNumber, { storeRoot })!;
    expect(authority.cycle).toMatchObject({
      frozenTier: 'T2', frozenCap: 1, state: 'at_cap_open_findings',
      consumedRoundOrdinals: [1],
    });
    expect(published).toBe('success');
    return { storeRoot, authority, statuses, writer, getPublished: () => published };
  }

  function promotedInput(prNumber: number, seedState: Awaited<ReturnType<typeof seed>>) {
    return {
      projectId: 'orchestrator-pack', storeRoot: seedState.storeRoot,
      sourceRepoRoot: process.cwd(), repoSlug: 'chetwerikoff/orchestrator-pack',
      prNumber, immediate: true,
      fixtureCurrentPrHeadSha: HEAD, fixturePrState: 'OPEN',
      fixturePrMerged: false, fixturePrBody: `Closes #${prNumber}`,
      fixtureIssueNumber: prNumber, fixtureIssueTitle: '[T3] Raised linked Issue',
      fixtureIssueBody: '```complexity-tier\ntier: T3\n```',
      fixtureRequiredStatusWriter: seedState.writer,
      fixtureRequiredStatusReader: async (head: string) => {
        expect(head).toBe(HEAD);
        return seedState.getPublished();
      },
    };
  }

  it.each([
    { label: 'merged PR', override: { fixturePrState: 'CLOSED', fixturePrMerged: true } },
    { label: 're-linked Issue', override: { fixturePrBody: 'Closes #999999' } },
    { label: 'changed PR head', override: { fixtureCurrentPrHeadSha: 'b'.repeat(40) } },
  ])('does not promote a historical cap-one cycle for a $label', async ({ override }) => {
    const prNumber = 253760 + (override.fixturePrBody ? 1 : override.fixtureCurrentPrHeadSha ? 2 : 0);
    const seeded = await seed(prNumber);
    const result = await reconcileStalePackReviewRuns({ ...promotedInput(prNumber, seeded), ...override });
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'final_cap_promotion_pr_binding_unverified', settled: false }),
    ]));
    const after = readPackReviewAuthority(prNumber, { storeRoot: seeded.storeRoot })!;
    expect(after.cycle).toMatchObject({
      cycleId: seeded.authority.cycle!.cycleId, frozenTier: 'T2',
      frozenCap: 1, state: 'at_cap_open_findings', consumedRoundOrdinals: [1],
    });
    expect(seeded.getPublished()).toBe('success');
    expect(seeded.statuses).toEqual(['pending', 'success']);
  });

  it('repairs historical same-head success after a verified final-cap raise and independently reads pending', async () => {
    const prNumber = 253764;
    const seeded = await seed(prNumber);
    const runId = seeded.authority.terminal!.runId;
    const result = await reconcileStalePackReviewRuns(promotedInput(prNumber, seeded));
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'prior_round_findings_unresolved_after_promotion' }),
      expect.objectContaining({ runId, reason: 'promoted_current_head_pending_verified' }),
    ]));
    const current = readPackReviewAuthority(prNumber, { storeRoot: seeded.storeRoot })!;
    expect(current.cycle).toMatchObject({
      cycleId: seeded.authority.cycle!.cycleId, frozenTier: 'T3',
      frozenCap: 2, state: 'open_findings', consumedRoundOrdinals: [1],
    });
    expect(current.cycle?.reviewStageComplete).not.toBe(true);
    expect(seeded.statuses).toEqual(['pending', 'success', 'pending']);
    expect(seeded.getPublished()).toBe('pending');
    expect(getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot: seeded.storeRoot }))
      .toMatchObject({ logicalRoundCap: 1, logicalRoundOrdinal: 1 });
  });
});

describe('Issue #2573 complete-slot persisted JSON reconciliation', () => {
  const repository = 'chetwerikoff/orchestrator-pack';
  const prNumber = 257301;
  const issueBody = '# Synthetic pathless-source review';
  const rawPathlessFinding = JSON.stringify({
    findings: [{
      type: 'quality',
      code: 'GPT-2573-PATHLESS',
      severity: 'blocking',
      path: null,
      summary: 'A source finding without a file path',
      source: 'gpt-browser',
    }],
  });

  async function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'pack-review-2573-persisted-json-'));
    roots.push(root);
    const storeRoot = join(root, 'store');
    setupHarness(storeRoot);
    process.env.PACK_REVIEWER = 'gpt';

    const mapped = mapGptReplyToReviewPayload(rawPathlessFinding);
    expect(mapped).toMatchObject({ verdict: 'findings', findingCount: 1 });
    expect(Object.prototype.hasOwnProperty.call(mapped.findings[0], 'filePath')).toBe(true);
    expect(mapped.findings[0]!.filePath).toBeUndefined();

    const options = { projectId: 'orchestrator-pack', storeRoot };
    const authority = initializePackReviewAuthority({
      prNumber, headSha: HEAD, tier: 'T1',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION, options: { storeRoot },
    });
    const round: PackReviewGptRoundRecord = {
      schema: 'pack-review-gpt-round/v1',
      reviewer: 'gpt',
      tier: 'T1',
      roundOrdinal: 1,
      cardinality: 3,
      issueNumber: prNumber,
      boundIssueSnapshotDigest: computeBoundIssueSnapshotHash(issueBody),
      sourceSlots: [1, 2, 3].map((ordinal) => ({
        slotId: 'source-' + String(ordinal).padStart(2, '0'),
        ordinal,
        lifecycle: 'planned' as const,
      })),
    };
    const run = createPackReviewRun({
      ...options, prNumber, headSha: HEAD,
      trustedPackRoot: process.cwd(), sourceRepoRoot: process.cwd(),
      canonicalRepository: repository,
      reviewCycleId: authority.cycle!.cycleId,
      logicalRoundOrdinal: 1, logicalRoundCap: 1,
      resolvedReviewer: 'gpt', automaticBudgetDisposition: 'consume',
      reviewRound: round,
    }).run;

    const comments: PackGptSourceGithubComment[] = [];
    const transport: PackGptSourceCommentTransport = {
      resolveActorLogin: async () => 'synthetic-gpt-reviewer',
      listComments: async () => [...comments],
      getComment: async (id) => {
        const comment = comments.find((item) => item.id === id);
        if (!comment) throw new Error('missing original synthetic source comment');
        return comment;
      },
    };
    const sourceSlots = await Promise.all(round.sourceSlots.map(async (slot, index) => {
      const invocationId = '25732573-2573-4257-8257-' + String(index + 1).padStart(12, '0');
      const identity: PackGptSourceIdentity = {
        repository, prNumber, headSha: HEAD, runId: run.id,
        slotId: slot.slotId, invocationId,
      };
      const commentId = 25730100 + index;
      comments.push({
        id: commentId,
        body: formatPackGptSourceCommentEnvelope(
          identity, index === 0 ? rawPathlessFinding : 'NO_FINDINGS',
        ),
        url: 'https://github.com/' + repository + '/pull/' + prNumber + '#issuecomment-' + commentId,
        issueUrl: 'https://api.github.com/repos/' + repository + '/issues/' + prNumber,
        actorLogin: 'synthetic-gpt-reviewer',
        createdAt: '2026-10-14T00:00:00Z',
        updatedAt: '2026-10-14T00:00:00Z',
      });
      const witnessed = await resolvePackGptSourceComment({ identity, transport });
      if (witnessed.kind !== 'credentialed') throw new Error('synthetic source was not credentialed');
      return {
        ...slot, lifecycle: 'terminal' as const, invocationId,
        attemptOrdinal: 1, admissionStartedAtUtc: '2026-10-14T00:00:00Z',
        terminalClass: index === 0 ? 'complete_findings' : 'complete_clean',
        terminalResult: {
          schema: 'turn-result/v1', state: 'ok', scope: 'none',
          cause: 'github_source_comment_credentialed',
          invocation_id: invocationId, send_count: 1,
          source_comment_authority: 'credentialed_github',
          source_comment_receipt: witnessed.receipt,
        },
        payload: witnessed.payload,
      };
    }));
    updatePackReviewRun(run.id, {
      status: 'reviewing', latestRunStatus: 'reviewing',
      runnerPid: 2147483647,
      reviewRound: { ...round, sourceSlots },
    }, options);

    const restored = getPackReviewRun(run.id, options)!;
    const storedPayload = restored.reviewRound!.sourceSlots[0]!.payload as {
      verdict: string; findings: Array<{ filePath?: string; body: string }>;
    };
    expect(storedPayload.verdict).toBe('findings');
    expect(storedPayload.findings[0]!.body).toContain('path: (none)');
    expect(Object.prototype.hasOwnProperty.call(storedPayload.findings[0], 'filePath')).toBe(false);
    const originalBody = comments[0]!.body;
    const originalReceipt = (restored.reviewRound!.sourceSlots[0]!.terminalResult as {
      source_comment_receipt: Record<string, unknown>;
    }).source_comment_receipt;

    const reviews: Array<{
      id: number; state: string; userLogin: string; submittedAt: string;
      body: string; commitId: string; url: string;
    }> = [];
    let currentStatus: string | undefined;
    const statuses: string[] = [];
    const reconcile = () => reconcileStalePackReviewRuns({
      ...options, sourceRepoRoot: process.cwd(), repoSlug: repository,
      prNumber, immediate: true, fixtureCurrentPrHeadSha: HEAD,
      fixtureGptSourceCommentTransport: transport,
      fixtureGithubReviewTransport: {
        resolveActorLogin: async () => 'synthetic-final-reviewer',
        listReviews: async () => [...reviews],
        postReview: async ({ body, commitId }) => {
          const id = 25730190 + reviews.length;
          const url = 'https://github.com/' + repository + '/pull/' + prNumber + '#pullrequestreview-' + id;
          reviews.push({
            id, state: 'COMMENTED', userLogin: 'synthetic-final-reviewer',
            submittedAt: new Date().toISOString(), body, commitId, url,
          });
          return { id, url };
        },
        dismissReview: async () => {},
      },
      fixtureRequiredStatusReader: async () => currentStatus,
      fixtureRequiredStatusWriter: async (request) => {
        currentStatus = request.state;
        statuses.push(request.state);
      },
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
      fixtureIssueTitle: '[T1] Synthetic pathless source',
      fixtureIssueBody: issueBody, fixtureIssueNumber: prNumber,
      fixtureChangedPaths: ['scripts/pack-review-runner.ts'],
      fixtureBoundIssueSnapshotBytes: issueBody,
      resolveRepositorySlug: async () => repository,
    });
    return { runId: run.id, storeRoot, options, comments, originalBody, originalReceipt, reviews, statuses, reconcile };
  }

  it('complete slot persisted JSON accepts a reloaded pathless finding and settles scoped reconcile', async () => {
    const f = await fixture();
    const result = await f.reconcile();
    expect(result.results).toContainEqual(expect.objectContaining({
      runId: f.runId, recovered: true, statusReconciled: true,
      reason: 'gpt_source_comments_recovered_and_delivered',
      deliveryReason: 'completed',
    }));
    const settled = getPackReviewRun(f.runId, f.options);
    expect(settled).toMatchObject({
      reviewVerdict: 'findings', findingCount: 1,
      journalOutcome: { state: 'persisted' },
      deliveryOutcomes: {
        githubComment: { state: 'succeeded' },
        requiredStatus: { state: 'succeeded' },
      },
    });
    expect(settled?.reviewRound?.settledSourceCount).toBe(3);
    expect(f.reviews).toHaveLength(1);
    expect(f.statuses).toContain('failure');
  });

  it.each(['GitHub body', 'stored receipt', 're-parsed verdict', 'finding content'] as const)(
    'complete slot genuine mismatch refuses %s without settling', async (kind) => {
      const f = await fixture();
      const file = join(f.storeRoot, 'runs', f.runId + '.json');
      const persisted = JSON.parse(readFileSync(file, 'utf8')) as PackReviewRunRecord;
      const slot = persisted.reviewRound!.sourceSlots[0]!;
      if (kind === 'GitHub body') {
        f.comments[0]!.body += '\n';
      } else if (kind === 'stored receipt') {
        (slot.terminalResult as { source_comment_receipt: { bodySha256: string } })
          .source_comment_receipt.bodySha256 = '0'.repeat(64);
      } else if (kind === 're-parsed verdict') {
        slot.terminalClass = 'complete_clean';
        slot.payload = { verdict: 'clean', findingCount: 0, findings: [] };
      } else {
        (slot.payload as { findings: Array<{ body: string }> }).findings[0]!.body =
          'Altered stored finding text, with the original comment and receipt intact';
      }
      if (kind !== 'GitHub body') writeFileSync(file, JSON.stringify(persisted));

      if (kind === 're-parsed verdict' || kind === 'finding content') {
        expect(f.comments[0]!.body).toBe(f.originalBody);
        const unchangedReceipt = (getPackReviewRun(f.runId, f.options)!
          .reviewRound!.sourceSlots[0]!.terminalResult as {
            source_comment_receipt: Record<string, unknown>;
          }).source_comment_receipt;
        expect(unchangedReceipt).toEqual(f.originalReceipt);
      }

      const result = await f.reconcile();
      expect(result.results).toContainEqual(expect.objectContaining({
        runId: f.runId, terminalized: false,
        reason: expect.stringContaining('gpt_complete_source_uncredentialable:source-01:stored_publication_mismatch'),
      }));
      expect(getPackReviewRun(f.runId, f.options)?.reviewVerdict).toBeUndefined();
      expect(f.reviews).toEqual([]);
      expect(f.statuses).not.toContain('success');
    },
  );
});


describe('Issue #2576 owned worktree lifecycle with real disposable Git', () => {
  const projectId = 'orchestrator-pack';
  const repository = 'chetwerikoff/orchestrator-pack';

  function git(repo: string, ...args: string[]): string {
    const result = runProcessSync({
      command: 'git', args, cwd: repo, inheritParentEnv: true, allowEmptyStdout: true,
    });
    if (!result.ok) throw new Error('disposable Git command failed: ' + args.join(' ') + ': ' + result.stderr);
    return result.stdout.trim();
  }

  function realGitFixture() {
    const root = mkdtempSync(join(tmpdir(), 'pack-review-2576-git-'));
    roots.push(root);
    const repo = join(root, 'source');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-q', '--allow-empty', '-m', 'test source');
    const head = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', head);
    const storeRoot = join(root, 'store');
    setupHarness(storeRoot);
    return { root, repo, head, storeRoot };
  }

  function registered(repo: string, path: string): boolean {
    return git(repo, 'worktree', 'list', '--porcelain').split(/\r?\n/)
      .some((line) => line === 'worktree ' + path);
  }

  function input(f: ReturnType<typeof realGitFixture>, prNumber: number) {
    return {
      projectId,
      storeRoot: f.storeRoot,
      sourceRepoRoot: f.repo,
      prNumber,
      headSha: f.head,
      claimMode: 'preacquired' as const,
      fixtureCurrentPrHeadSha: f.head,
      fixturePostReviewHeadSha: f.head,
      fixturePrState: 'OPEN',
      fixturePrBody: 'Closes #' + prNumber,
      fixturePostReviewPrBody: 'Closes #' + prNumber,
      fixtureRepoSlug: repository,
      fixtureIssueNumber: prNumber,
      fixtureIssueTitle: '[T2] Disposable local Git lifecycle',
      fixtureIssueBody: '```complexity-tier\ntier: T2\n```',
      fixtureReviewStdout: cleanPayload(),
      fixtureUseRealReviewWorktree: true,
      fixtureGithubReviewId: prNumber,
      fixtureRequiredStatusWriter: async () => {},
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    };
  }

  function seedCheckout(
    f: ReturnType<typeof realGitFixture>,
    prNumber: number,
    ownerPid = 99999999,
  ) {
    const created = createPackReviewRun({
      projectId, storeRoot: f.storeRoot, prNumber, headSha: f.head,
      trustedPackRoot: process.cwd(), sourceRepoRoot: f.repo,
      canonicalRepository: repository,
    });
    const runId = created.run.id;
    const target = join(f.storeRoot, 'worktrees', runId);
    mkdirSync(join(f.storeRoot, 'worktrees'), { recursive: true });
    git(f.repo, 'worktree', 'add', '--detach', target, f.head);
    setPackReviewRunTerminal(runId, 'changes_requested', {
      reviewTargetRoot: target,
      runnerPid: ownerPid,
      heartbeatAtUtc: '2000-01-01T00:00:00.000Z',
    }, { projectId, storeRoot: f.storeRoot });
    return { runId, target };
  }

  it.each([
    { label: 'clean', stdout: cleanPayload(), code: 0, timeout: false },
    { label: 'changes_requested', stdout: JSON.stringify({
      verdict: 'findings', findingCount: 1,
      findings: [{ title: 'Local Git fixture finding', severity: 'blocking', body: 'one finding' }],
    }), code: 0, timeout: false },
    { label: 'reviewer failure', stdout: '', code: 1, timeout: false },
    { label: 'reviewer timeout', stdout: '', code: 124, timeout: true },
  ])('unregisters the real owned checkout after $label', async ({ stdout, code, timeout }) => {
    const f = realGitFixture();
    const prNumber = 257600 + (timeout ? 3 : code !== 0 ? 2 : stdout === cleanPayload() ? 0 : 1);
    let checkout = '';
    await startPackReview({
      ...input(f, prNumber),
      fixtureReviewStdout: stdout,
      fixtureReviewExitCode: code,
      fixtureReviewTimedOut: timeout,
      onRunStarted: ({ runId }) => {
        checkout = join(f.storeRoot, 'worktrees', runId);
        expect(existsSync(checkout)).toBe(true);
        expect(registered(f.repo, checkout)).toBe(true);
      },
    });
    expect(checkout).not.toBe('');
    expect(existsSync(checkout)).toBe(false);
    expect(registered(f.repo, checkout)).toBe(false);
  });

  it('owns an actual registration before a post-add exception and cleans it in outer finally', async () => {
    const f = realGitFixture();
    let checkout = '';
    await startPackReview({
      ...input(f, 257605),
      fixtureAfterReviewWorktreeAdd: (path) => {
        checkout = path;
        expect(existsSync(path)).toBe(true);
        expect(registered(f.repo, path)).toBe(true);
        throw new Error('fixture failed after real git worktree add');
      },
    }).catch(() => undefined);
    expect(checkout).not.toBe('');
    expect(existsSync(checkout)).toBe(false);
    expect(registered(f.repo, checkout)).toBe(false);
  });

  it('keeps a failed targeted Git removal visible until an eligible later ordinary start', async () => {
    const f = realGitFixture();
    let runId = '';
    await expect(startPackReview({
      ...input(f, 257606),
      fixtureReviewWorktreeRemoveFailure: true,
      onRunStarted: ({ runId: id }) => { runId = id; },
    })).rejects.toThrow('Git worktree removal failed');
    const checkout = join(f.storeRoot, 'worktrees', runId);
    expect(existsSync(checkout)).toBe(true);
    expect(registered(f.repo, checkout)).toBe(true);
    // Simulate the original runner having exited and the existing heartbeat grace having elapsed.
    updatePackReviewRun(runId, {
      runnerPid: 99999999, heartbeatAtUtc: '2000-01-01T00:00:00.000Z',
    }, { projectId, storeRoot: f.storeRoot });
    await startPackReview(input(f, 257607));
    expect(existsSync(checkout)).toBe(false);
    expect(registered(f.repo, checkout)).toBe(false);
  });

  it('reclaims a real missing-directory registration and protects unrelated Git worktrees across starts', async () => {
    const f = realGitFixture();
    const stale = seedCheckout(f, 257608);
    const unrelated = join(f.root, 'unrelated-checkout');
    git(f.repo, 'worktree', 'add', '--detach', unrelated, f.head);
    rmSync(stale.target, { recursive: true, force: true });
    expect(registered(f.repo, stale.target)).toBe(true);
    expect(existsSync(stale.target)).toBe(false);
    await startPackReview(input(f, 257609));
    await startPackReview(input(f, 257610));
    expect(registered(f.repo, stale.target)).toBe(false);
    expect(existsSync(stale.target)).toBe(false);
    expect(registered(f.repo, unrelated)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  it('reclaims a hard-killed, grace-expired active PR A checkout on an ordinary PR B start', async () => {
    const f = realGitFixture();
    const original = createPackReviewRun({
      projectId, storeRoot: f.storeRoot, prNumber: 257630, headSha: f.head,
      trustedPackRoot: process.cwd(), sourceRepoRoot: f.repo, canonicalRepository: repository,
    }).run;
    const target = join(f.storeRoot, 'worktrees', original.id);
    mkdirSync(join(f.storeRoot, 'worktrees'), { recursive: true });
    git(f.repo, 'worktree', 'add', '--detach', target, f.head);
    updatePackReviewRun(original.id, {
      status: 'reviewing', latestRunStatus: 'reviewing', reviewTargetRoot: target,
      runnerPid: 99999999,
    }, { projectId, storeRoot: f.storeRoot, now: new Date('2000-01-01T00:00:00.000Z') });
    const before = getPackReviewRun(original.id, { projectId, storeRoot: f.storeRoot });
    expect(before?.status).toBe('reviewing');
    expect(registered(f.repo, target)).toBe(true);

    await startPackReview(input(f, 257631));
    expect(existsSync(target)).toBe(false);
    expect(registered(f.repo, target)).toBe(false);
    // The cleanup sweep never terminalizes, reclaims or edits another PR's run record.
    expect(getPackReviewRun(original.id, { projectId, storeRoot: f.storeRoot })).toEqual(before);
  });

  it('does not delete an outside-store persisted path, a symlink, or a cross-record live alias', async () => {
    const f = realGitFixture();
    const outside = join(f.root, 'private-unrelated');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'do not remove');
    const malicious = createPackReviewRun({
      projectId, storeRoot: f.storeRoot, prNumber: 257611, headSha: f.head,
      trustedPackRoot: process.cwd(), sourceRepoRoot: f.repo, canonicalRepository: repository,
    }).run;
    setPackReviewRunTerminal(malicious.id, 'failed', {
      runnerPid: 99999999, heartbeatAtUtc: '2000-01-01T00:00:00.000Z',
      reviewTargetRoot: outside,
    }, { projectId, storeRoot: f.storeRoot });

    const symlinkOwner = createPackReviewRun({
      projectId, storeRoot: f.storeRoot, prNumber: 257612, headSha: f.head,
      trustedPackRoot: process.cwd(), sourceRepoRoot: f.repo, canonicalRepository: repository,
    }).run;
    const symlinkPath = join(f.storeRoot, 'worktrees', symlinkOwner.id);
    mkdirSync(join(f.storeRoot, 'worktrees'), { recursive: true });
    symlinkSync(outside, symlinkPath, 'dir');
    setPackReviewRunTerminal(symlinkOwner.id, 'failed', {
      runnerPid: 99999999, heartbeatAtUtc: '2000-01-01T00:00:00.000Z',
      reviewTargetRoot: symlinkPath,
    }, { projectId, storeRoot: f.storeRoot });

    const formerlyOwned = seedCheckout(f, 257613);
    const live = createPackReviewRun({
      projectId, storeRoot: f.storeRoot, prNumber: 257614, headSha: f.head,
      trustedPackRoot: process.cwd(), sourceRepoRoot: f.repo, canonicalRepository: repository,
    }).run;
    updatePackReviewRun(live.id, {
      reviewTargetRoot: formerlyOwned.target, runnerPid: process.pid,
    }, { projectId, storeRoot: f.storeRoot });

    await startPackReview(input(f, 257615));
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('do not remove');
    expect(existsSync(symlinkPath)).toBe(true);
    expect(existsSync(formerlyOwned.target)).toBe(true);
    expect(registered(f.repo, formerlyOwned.target)).toBe(true);
    setPackReviewRunTerminal(live.id, 'failed', {
      runnerPid: 99999999, heartbeatAtUtc: '2000-01-01T00:00:00.000Z',
    }, { projectId, storeRoot: f.storeRoot });
    await startPackReview(input(f, 257616));
    expect(existsSync(formerlyOwned.target)).toBe(false);
    expect(registered(f.repo, formerlyOwned.target)).toBe(false);
    expect(existsSync(symlinkPath)).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });

  it('preserves an abandoned owner while a live run references its checkout through a symlink alias', async () => {
    const f = realGitFixture();
    const old = seedCheckout(f, 257621);
    const alias = join(f.root, 'alias-to-live-review');
    symlinkSync(old.target, alias, 'dir');
    const live = createPackReviewRun({
      projectId, storeRoot: f.storeRoot, prNumber: 257622, headSha: f.head,
      trustedPackRoot: process.cwd(), sourceRepoRoot: f.repo, canonicalRepository: repository,
    }).run;
    updatePackReviewRun(live.id, {
      reviewTargetRoot: alias, runnerPid: process.pid,
    }, { projectId, storeRoot: f.storeRoot });
    await startPackReview(input(f, 257623));
    expect(existsSync(old.target)).toBe(true);
    expect(registered(f.repo, old.target)).toBe(true);

    setPackReviewRunTerminal(live.id, 'failed', {
      runnerPid: 99999999, heartbeatAtUtc: '2000-01-01T00:00:00.000Z',
    }, { projectId, storeRoot: f.storeRoot });
    await startPackReview(input(f, 257624));
    // Stale status alone does not clear the still-resolving aliased reference.
    expect(existsSync(old.target)).toBe(true);
    expect(registered(f.repo, old.target)).toBe(true);

    // Reclamation becomes safe only after the alias no longer references the checkout.
    rmSync(alias);
    await startPackReview(input(f, 257625));
    expect(existsSync(old.target)).toBe(false);
    expect(registered(f.repo, old.target)).toBe(false);
  });

  it('preserves a registered checkout whose on-disk Git identity was replaced', async () => {
    const f = realGitFixture();
    const owned = seedCheckout(f, 257619);
    const foreign = join(f.root, 'foreign-source');
    mkdirSync(foreign);
    git(foreign, 'init', '-q', '-b', 'main');
    // Keep the selected repository's original registration; substitute only its
    // working directory Gitfile with a foreign repository binding.
    writeFileSync(join(owned.target, '.git'), 'gitdir: ' + join(foreign, '.git') + '\n');
    expect(registered(f.repo, owned.target)).toBe(true);

    await startPackReview(input(f, 257620));
    expect(existsSync(owned.target)).toBe(true);
    expect(registered(f.repo, owned.target)).toBe(true);
  });

  it('refuses a same-repository sibling Gitdir substituted into a registered checkout', async () => {
    const f = realGitFixture();
    const owned = seedCheckout(f, 257632);
    const sibling = join(f.root, 'sibling-worktree');
    git(f.repo, 'worktree', 'add', '--detach', sibling, f.head);
    const originalGitDir = git(owned.target, 'rev-parse', '--absolute-git-dir');
    const siblingGitDir = git(sibling, 'rev-parse', '--absolute-git-dir');
    expect(originalGitDir).not.toBe(siblingGitDir);
    writeFileSync(join(owned.target, '.git'), readFileSync(join(sibling, '.git'), 'utf8'));
    // These were the old, insufficient identity checks: both still succeed.
    expect(resolve(owned.target, git(owned.target, 'rev-parse', '--git-common-dir')))
      .toBe(resolve(f.repo, git(f.repo, 'rev-parse', '--git-common-dir')));
    expect(git(owned.target, 'rev-parse', '--show-toplevel')).toBe(owned.target);
    expect(git(owned.target, 'rev-parse', '--absolute-git-dir')).toBe(siblingGitDir);

    const diagnostics: string[] = [];
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      diagnostics.push(String(chunk));
      return true;
    });
    try {
      await startPackReview(input(f, 257633));
    } finally {
      write.mockRestore();
    }
    expect(diagnostics.join('')).toContain('registered checkout Git identity differs from selected source repository');
    expect(existsSync(owned.target)).toBe(true);
    expect(registered(f.repo, owned.target)).toBe(true);
    expect(existsSync(sibling)).toBe(true);
    expect(registered(f.repo, sibling)).toBe(true);
  });

  it('repairs a missing-directory GPT same-round registration without losing saved source slots', async () => {
    const f = realGitFixture();
    const prNumber = 257640;
    process.env.PACK_REVIEWER = 'gpt';
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;

    const sourceClean = (invocationId: string) => JSON.stringify({
      schema: 'turn-result/v1', state: 'ok', scope: 'invocation',
      cause: 'completed_page_only', invocation_id: invocationId, send_count: 1,
    }) + '\n' + cleanPayload();
    const busy = JSON.stringify({
      schema: 'turn-result/v1', state: 'profile_busy', scope: 'profile',
      cause: 'profile_busy', invocation_id: 'inv-busy-2576', send_count: 0,
    });
    const first = await startPackReview({
      ...input(f, prNumber),
      fixtureReviewBySourceSlot: {
        'source-01': [{ stdout: sourceClean('inv-2576-source-01') }],
        'source-02': [{ stdout: busy, exitCode: 13 }, { stdout: busy, exitCode: 13 }],
        'source-03': [{ stdout: sourceClean('inv-2576-source-03') }],
      },
    });
    expect(first, JSON.stringify(first)).toMatchObject({
      ok: true, status: 'reviewing',
      coverage: { kind: 'partial', completedSourceCount: 2, cardinality: 3 },
    });
    const runId = String(first.runId);
    const target = join(f.storeRoot, 'worktrees', runId);
    const before = getPackReviewRun(runId, { projectId, storeRoot: f.storeRoot })!;
    const completed = before.reviewRound!.sourceSlots
      .filter((slot) => slot.slotId !== 'source-02')
      .map((slot) => ({ slotId: slot.slotId, invocationId: slot.invocationId, payload: slot.payload }));
    expect(existsSync(target)).toBe(true);
    expect(registered(f.repo, target)).toBe(true);

    // Reproduce the legacy rmSync-only crash footprint while retaining Git registration.
    rmSync(target, { recursive: true, force: true });
    expect(existsSync(target)).toBe(false);
    expect(registered(f.repo, target)).toBe(true);
    updatePackReviewRun(runId, { runnerPid: 99999999 }, {
      projectId, storeRoot: f.storeRoot, now: new Date('2000-01-01T00:00:00.000Z'),
    });
    let readded = false;
    const second = await startPackReview({
      ...input(f, prNumber),
      claimMode: 'acquire',
      fixtureGptAttemptObserver: async () => ({
        state: 'replacement_eligible' as const, replacementEligible: true, slotId: 'source-02',
      }),
      fixtureReviewBySourceSlot: {
        'source-02': [{ stdout: sourceClean('inv-2576-replacement-02') }],
      },
      fixtureAfterReviewWorktreeAdd: (path) => {
        expect(path).toBe(target);
        expect(existsSync(path)).toBe(true);
        expect(registered(f.repo, path)).toBe(true);
        readded = true;
      },
    });
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect(second.runId).toBe(runId);
    expect(readded).toBe(true);
    const after = getPackReviewRun(runId, { projectId, storeRoot: f.storeRoot })!;
    expect(after.reviewRound!.sourceSlots
      .filter((slot) => slot.slotId !== 'source-02')
      .map((slot) => ({ slotId: slot.slotId, invocationId: slot.invocationId, payload: slot.payload })))
      .toEqual(completed);
    expect(existsSync(target)).toBe(false);
    expect(registered(f.repo, target)).toBe(false);
  });

  it('preserves a terminal-status owner paused before finally and removes only after it exits', async () => {
    const f = realGitFixture();
    let releaseCleanup!: () => void;
    let announcePause!: (path: string) => void;
    const pause = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const reached = new Promise<string>((resolve) => { announcePause = resolve; });
    const first = startPackReview({
      ...input(f, 257617),
      fixtureReviewStdout: JSON.stringify({
        verdict: 'findings', findingCount: 1,
        findings: [{ title: 'terminal-but-live', severity: 'blocking', body: 'fixture' }],
      }),
      fixtureBeforeReviewWorktreeCleanup: async (run, target) => {
        expect(getPackReviewRun(run.id, { projectId, storeRoot: f.storeRoot })?.status)
          .toBe('changes_requested');
        announcePause(target);
        await pause;
      },
    });
    const target = await reached;
    try {
      expect(registered(f.repo, target)).toBe(true);
      await startPackReview(input(f, 257618));
      expect(existsSync(target)).toBe(true);
      expect(registered(f.repo, target)).toBe(true);
    } finally {
      releaseCleanup();
      await first;
    }
    expect(existsSync(target)).toBe(false);
    expect(registered(f.repo, target)).toBe(false);
  });
});

describe('Issue #2607 supplemental reviewer provenance and required-status isolation', () => {
  function setup() {
    const storeRoot = mkdtempSync(join(tmpdir(), 'opk-review-2607-'));
    roots.push(storeRoot);
    return { projectId: 'orchestrator-pack', storeRoot };
  }

  it('requires explicit admission and disjoint reviewer reuse without changing run schema', () => {
    const store = setup();
    const base = {
      ...store, prNumber: 2607, headSha: HEAD, trustedPackRoot: process.cwd(),
      sourceRepoRoot: process.cwd(), canonicalRepository: 'chetwerikoff/orchestrator-pack',
      surface: 'pack-gpt-review', startReason: 'manual-browser-gpt',
      resolvedReviewerSource: 'invocation-bound' as const,
      reviewCycleId: 'existing-2607-cycle',
      automaticBudgetDisposition: 'non_consuming_explicit' as const,
    };
    expect(() => createPackReviewRun({ ...base, resolvedReviewer: 'codex' })).toThrow(/non_consuming_explicit/);
    const admissible = { ...base, allowExplicitSupplementalStart: true };
    const original = createPackReviewRun({ ...admissible, resolvedReviewer: 'codex' });
    expect(original.created).toBe(true);
    const date = new Date().toISOString();
    setPackReviewRunTerminal(original.run.id, 'commented', {
      reviewVerdict: 'clean', findingCount: 0, findings: [],
      journalOutcome: {
        state: 'persisted', reason: 'fixture-accepted',
        idempotencyKey: `verdict:${original.run.id}:${HEAD}`,
        recordedAtUtc: date, attempts: 1,
      },
    }, store);
    const sameReviewer = createPackReviewRun({ ...admissible, resolvedReviewer: 'codex' });
    expect(sameReviewer).toMatchObject({ created: false, reused: true, reason: 'terminal_run_exists' });
    expect(sameReviewer.run.id).toBe(original.run.id);
    const differentReviewer = createPackReviewRun({ ...admissible, resolvedReviewer: 'claude' });
    expect(differentReviewer.created).toBe(true);
    expect(differentReviewer.run.sameKeyOrder).toBeGreaterThan(original.run.sameKeyOrder ?? 0);
    setPackReviewRunTerminal(differentReviewer.run.id, 'commented', {
      reviewVerdict: 'clean', findingCount: 0, findings: [],
      journalOutcome: {
        state: 'persisted', reason: 'fixture-accepted',
        idempotencyKey: `verdict:${differentReviewer.run.id}:${HEAD}`,
        recordedAtUtc: date, attempts: 1,
      },
    }, store);
    const required = createPackReviewRun({
      ...base, automaticBudgetDisposition: 'consume',
      allowExplicitSupplementalStart: undefined,
      resolvedReviewer: 'claude',
      logicalRoundOrdinal: 1, logicalRoundCap: 2,
    });
    expect(required.created).toBe(true);
    const ordered = resolvePackReviewRequiredRunOrder(
      [original.run, differentReviewer.run, required.run], required.run,
    );
    expect(ordered.kind).toBe('none');
    expect(getPackReviewRun(original.run.id, store)?.automaticBudgetDisposition).toBe('non_consuming_explicit');
    expect(getPackReviewRun(required.run.id, store)?.automaticBudgetDisposition).toBe('consume');
  });

  it('never publishes pending/stale required statuses from a supplemental run', async () => {
    const store = setup();
    const supplemental = createPackReviewRun({
      ...store, prNumber: 2607, headSha: HEAD,
      trustedPackRoot: process.cwd(), sourceRepoRoot: process.cwd(),
      canonicalRepository: 'chetwerikoff/orchestrator-pack',
      surface: 'pack-gpt-review', startReason: 'manual-browser-gpt',
      resolvedReviewer: 'codex', resolvedReviewerSource: 'invocation-bound',
      reviewCycleId: 'cycle-2607',
      automaticBudgetDisposition: 'non_consuming_explicit',
      allowExplicitSupplementalStart: true,
      linkedSessionId: 'fixture-worker',
    }).run;
    const writeRequiredStatus = vi.fn(async () => undefined);
    const notifyWorker = vi.fn(async () => ({ state: 'delivered' as const, reason: 'unexpected' }));
    const pending = await recordPackReviewPendingStatus({
      ...store, run: supplemental, writeRequiredStatus,
    });
    const stale = await recordPackReviewStaleRequiredStatus({
      ...store, run: supplemental, writeRequiredStatus, notifyWorker,
    });
    expect(pending.reason).toBe('supplemental_no_required_status');
    expect(stale.reason).toBe('supplemental_no_required_status');
    expect(writeRequiredStatus).not.toHaveBeenCalled();
    expect(notifyWorker).not.toHaveBeenCalled();
    expect(getPackReviewRun(supplemental.id, store)?.deliveryOutcomes.requiredStatus).toBeUndefined();
  });

  it('advisory verdict delivery journals the original run and never updates required status or worker', async () => {
    const store = setup();
    const run = createPackReviewRun({
      ...store, prNumber: 2607, headSha: HEAD,
      trustedPackRoot: process.cwd(), sourceRepoRoot: process.cwd(),
      canonicalRepository: 'chetwerikoff/orchestrator-pack',
      surface: 'pack-gpt-review', startReason: 'manual-browser-gpt',
      resolvedReviewer: 'claude', resolvedReviewerSource: 'invocation-bound',
      reviewCycleId: 'cycle-2607',
      automaticBudgetDisposition: 'non_consuming_explicit',
      allowExplicitSupplementalStart: true,
      linkedSessionId: 'fixture-worker',
    }).run;
    const writeRequiredStatus = vi.fn(async () => undefined);
    const notifyWorker = vi.fn(async () => ({ state: 'delivered' as const, reason: 'unexpected' }));
    const postGithubComment = vi.fn(async () => ({
      id: 2607, url: 'https://github.com/example/repo/pull/42#issuecomment-2607',
      event: 'COMMENT' as const,
    }));
    await deliverPackReviewVerdict({
      ...store, run, payload: { verdict: 'clean', findingCount: 0, findings: [] },
      writeRequiredStatus, notifyWorker, postGithubComment,
    });
    const persisted = getPackReviewRun(run.id, store);
    expect(persisted?.journalOutcome?.state).toBe('persisted');
    expect(persisted?.reviewVerdict).toBe('clean');
    expect(postGithubComment).toHaveBeenCalledTimes(1);
    expect(writeRequiredStatus).not.toHaveBeenCalled();
    expect(notifyWorker).not.toHaveBeenCalled();
    expect(persisted?.deliveryOutcomes.requiredStatus).toBeUndefined();
    expect(persisted?.deliveryOutcomes.workerNotification).toBeUndefined();
  });
});

describe('Issue #2607 first-round findings: exact-head CLI and COMMENT resume', () => {
  const repository = 'chetwerikoff/orchestrator-pack';
  const issueBody = [
    String.fromCharCode(96).repeat(3) + 'complexity-tier',
    'tier: T1',
    String.fromCharCode(96).repeat(3),
  ].join('\n');


  function fixtureRoot2607(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  function commandStart2607(storeRoot: string, overrides: Record<string, unknown> = {}) {
    return (input: Parameters<typeof startPackReview>[0]) => startPackReview({
      ...input,
      projectId: 'orchestrator-pack', storeRoot, sourceRepoRoot: process.cwd(),
      fixtureCurrentPrHeadSha: HEAD,
      fixtureRequiredCiPolicy: {
        contexts: ['verify orchestrator-pack structure', 'pr scope guard', 'orchestrator-pack/pack-review'],
        checks: [],
      },
      fixtureRequiredCiChecks: [
        { name: 'verify orchestrator-pack structure', state: 'SUCCESS' },
        { name: 'pr scope guard', state: 'SUCCESS' },
        { name: 'orchestrator-pack/pack-review', state: 'PENDING' },
      ],
      fixtureRequiredCiHeadAfterGate: HEAD,
      fixturePrState: 'OPEN',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixturePostReviewHeadSha: HEAD,
      fixtureReviewStdout: cleanPayload(),
      ...overrides,
    });
  }

  async function completedRequiredStage(prNumber: number) {
    const storeRoot = fixtureRoot2607('opk-2607-reviewed-delivery-');
    setupHarness(storeRoot);
    process.env.PACK_REVIEWER = 'codex';
    const statusWrites: string[] = [];
    let notifications = 0;
    const fixture = {
      fixtureCurrentPrHeadSha: HEAD,
      fixturePostReviewHeadSha: HEAD,
      fixturePrState: 'OPEN' as const,
      fixturePrBody: 'Closes #' + prNumber,
      fixturePostReviewPrBody: 'Closes #' + prNumber,
      fixtureRepoSlug: repository,
      fixtureIssueNumber: prNumber,
      fixtureIssueTitle: '[T1] Existing required review',
      fixtureIssueBody: issueBody,
      fixtureReviewStdout: cleanPayload(),
      fixtureRequiredStatusWriter: async (request: { state: string }) => {
        statusWrites.push(request.state);
      },
      fixtureWorkerNotifier: async () => {
        notifications += 1;
        return { state: 'delivered' as const, reason: 'fixture' };
      },
    };
    const required = await startPackReview({
      projectId: 'orchestrator-pack', storeRoot, sourceRepoRoot: process.cwd(),
      prNumber, headSha: HEAD, ...fixture,
    });
    expect(required, JSON.stringify(required)).toMatchObject({ ok: true, created: true });
    expect(readPackReviewAuthority(prNumber, { storeRoot })?.cycle?.reviewStageComplete).toBe(true);
    const statusCount = statusWrites.length;
    const notificationCount = notifications;
    return {
      storeRoot, fixture, statusWrites, statusCount, notificationCount,
      getNotificationCount: () => notifications,
    };
  }

  function reviewTransport(prNumber: number, mode: 'success' | 'missing' | 'confirmed' | 'ambiguous') {
    const reviews: GithubReviewSummary[] = [];
    let posts = 0;
    let visible = mode === 'success';
    let permitPost = mode === 'success';
    const transport: GithubReviewTransport = {
      resolveActorLogin: async () => 'fixture-2607-reviewer',
      listReviews: async () => visible ? [...reviews] : [],
      postReview: async ({ body, commitId }) => {
        posts += 1;
        if (mode === 'missing' && !permitPost) {
          throw new GithubReviewPostError('definitely_rejected', 'synthetic definite COMMENT rejection');
        }
        const id = prNumber * 100 + posts;
        const review: GithubReviewSummary = {
          id, body, commitId, state: 'COMMENTED',
          submittedAt: new Date().toISOString(),
          userLogin: 'fixture-2607-reviewer',
          url: 'https://github.com/' + repository + '/pull/' + prNumber + '#pullrequestreview-' + id,
        };
        if (mode === 'confirmed' || mode === 'ambiguous') {
          if (mode === 'confirmed') reviews.push(review);
          throw new Error('synthetic ambiguous COMMENT acknowledgement');
        }
        reviews.push(review);
        if (mode === 'missing') visible = true;
        return { id, url: review.url };
      },
      dismissReview: async () => undefined,
    };
    return {
      transport, posts: () => posts,
      expose: () => { visible = true; },
      permitPost: () => { permitPost = true; },
    };
  }

  function originalSourceTransport(prNumber: number) {
    const comments: PackGptSourceGithubComment[] = [];
    let invocations = 0;
    const transport: PackGptSourceCommentTransport = {
      resolveActorLogin: async () => 'fixture-2607-gpt-source',
      listComments: async () => [...comments],
      getComment: async (id) => {
        const found = comments.find((item) => item.id === id);
        if (!found) throw new Error('original GPT source comment unavailable');
        return found;
      },
    };
    return {
      transport, sent: () => invocations,
      publishOriginal: async ({ identity }: { identity: PackGptSourceIdentity }) => {
        invocations += 1;
        const id = prNumber * 1000 + invocations;
        const timestamp = new Date().toISOString();
        comments.push({
          id, body: formatPackGptSourceCommentEnvelope(identity, 'NO_FINDINGS'),
          actorLogin: 'fixture-2607-gpt-source',
          createdAt: timestamp, updatedAt: timestamp,
          url: 'https://github.com/' + repository + '/pull/' + prNumber + '#issuecomment-' + id,
          issueUrl: 'https://api.github.com/repos/' + repository + '/issues/' + prNumber,
        });
      },
    };
  }

  it('passes real final required Codex runner output to explicit CLI with verified head', async () => {
    const storeRoot = fixtureRoot2607('opk-2607-native-final-cli-');
    setupHarness(storeRoot);
    const prNumber = 260711;
    const execution = await runPackGptReviewCommand({ prNumber, reviewer: 'codex' }, {
      env: process.env,
      stderr: { write: () => undefined },
      startReview: commandStart2607(storeRoot, {
        fixturePrBody: 'Closes #' + prNumber,
        fixturePostReviewPrBody: 'Closes #' + prNumber,
        fixtureIssueNumber: prNumber,
        fixtureIssueTitle: '[T1] Native required review',
        fixtureIssueBody: issueBody,
        fixtureReviewStdout: cleanPayload(),
      }),
    });
    expect(execution, JSON.stringify(execution.result)).toMatchObject({
      exitCode: 0,
      result: {
        ok: true, created: true, reason: 'completed',
        prNumber, headSha: HEAD, targetSha: HEAD,
        resolvedReviewer: 'codex', executedReviewer: 'codex',
        reviewerInvokedForThisRun: true,
      },
    });
    expect(execution.result.reviewerExecutionRunId).toBe(execution.result.runId);
    expect(execution.result.outcome).not.toBe('supplemental_review_delivered');
    expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })).toHaveLength(1);
  });

  it.each(['success', 'confirmed'] as const)(
    'delivers credentialed supplemental GPT %s through real runner and CLI without required-status writes',
    async (mode) => {
      const prNumber = mode === 'success' ? 260712 : 260713;
      const f = await completedRequiredStage(prNumber);
      const source = originalSourceTransport(prNumber);
      const review = reviewTransport(prNumber, mode);
      const startReview = commandStart2607(f.storeRoot, {
        ...f.fixture,
        fixtureReviewStdout: cleanPayload(),
        fixtureGptSourceCommentTransport: source.transport,
        fixtureBeforeGptSourceCommentCensus: source.publishOriginal,
        fixtureGithubReviewTransport: review.transport,
      });
      const first = await runPackGptReviewCommand({ prNumber, reviewer: 'gpt' }, {
        env: process.env, stderr: { write: () => undefined }, startReview,
      });
      if (mode === 'confirmed') {
        expect(first.exitCode).toBe(1);
        const journaled = getPackReviewRun(String(first.result.runId), {
          projectId: 'orchestrator-pack', storeRoot: f.storeRoot,
        });
        expect(journaled).toMatchObject({
          automaticBudgetDisposition: 'non_consuming_explicit',
          journalOutcome: { state: 'persisted' },
          executedReviewer: 'gpt',
          reviewerExecutionRunId: first.result.runId,
        });
        review.expose();
      }
      const final = mode === 'confirmed'
        ? await runPackGptReviewCommand({ prNumber, reviewer: 'gpt' }, {
            env: process.env, stderr: { write: () => undefined }, startReview,
          })
        : first;
      expect(final, JSON.stringify(final.result)).toMatchObject({
        exitCode: 0,
        result: {
          ok: true, reason: 'supplemental_review_delivered',
          outcome: 'supplemental_review_delivered', reviewVerdict: 'clean',
          headSha: HEAD, targetSha: HEAD, prNumber,
          resolvedReviewer: 'gpt', executedReviewer: 'gpt',
          reviewerInvokedForThisRun: true,
          githubReviewId: expect.any(Number),
          githubReviewUrl: expect.stringContaining('pullrequestreview-'),
        },
      });
      expect(final.result.reviewerExecutionRunId).toBe(final.result.runId);
      if (mode === 'confirmed') {
        expect(final.result.runId).toBe(first.result.runId);
        expect(final.result.recovered).toBe(true);
      }
      expect(final.result).not.toHaveProperty('publicationVerified');
      expect(review.posts()).toBe(1);
      expect(source.sent()).toBeGreaterThan(0);
      expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot: f.storeRoot })).toHaveLength(2);
      const advisory = getPackReviewRun(String(final.result.runId), {
        projectId: 'orchestrator-pack', storeRoot: f.storeRoot,
      });
      expect(advisory).toMatchObject({
        automaticBudgetDisposition: 'non_consuming_explicit',
        reviewVerdict: 'clean', journalOutcome: { state: 'persisted' },
        deliveryOutcomes: { githubComment: { state: 'succeeded' } },
      });
      expect(advisory?.deliveryOutcomes.requiredStatus).toBeUndefined();
      expect(f.statusWrites).toHaveLength(f.statusCount);
      expect(f.getNotificationCount()).toBe(f.notificationCount);
      expect(readPackReviewAuthority(prNumber, { storeRoot: f.storeRoot })?.cycle?.reviewStageComplete).toBe(true);
    },
  );

  it.each(['missing', 'confirmed', 'ambiguous'] as const)(
    'resumes only the original native supplemental COMMENT for %s delivery evidence',
    async (mode) => {
      const prNumber = mode === 'missing' ? 260714 : mode === 'confirmed' ? 260715 : 260716;
      const f = await completedRequiredStage(prNumber);
      const review = reviewTransport(prNumber, mode);
      let nativeInvocations = 0;
      const startReview = commandStart2607(f.storeRoot, {
        ...f.fixture,
        fixtureGithubReviewTransport: review.transport,
        fixtureAfterNativeInitialArmed: async () => { nativeInvocations += 1; },
      });
      const first = await runPackGptReviewCommand({ prNumber, reviewer: 'codex' }, {
        env: process.env, stderr: { write: () => undefined }, startReview,
      });
      expect(first.exitCode).toBe(1);
      const originalRunId = String(first.result.runId);
      const incomplete = getPackReviewRun(originalRunId, {
        projectId: 'orchestrator-pack', storeRoot: f.storeRoot,
      });
      expect(incomplete).toMatchObject({
        automaticBudgetDisposition: 'non_consuming_explicit',
        journalOutcome: { state: 'persisted' }, reviewVerdict: 'clean',
        resolvedReviewer: 'codex', executedReviewer: 'codex',
        reviewerExecutionRunId: originalRunId,
      });
      if (mode === 'confirmed') review.expose();
      if (mode === 'missing') review.permitPost();
      const second = await runPackGptReviewCommand({ prNumber, reviewer: 'codex' }, {
        env: process.env, stderr: { write: () => undefined }, startReview,
      });
      if (mode === 'ambiguous') {
        expect(second.exitCode).toBe(1);
        expect(second.result.runnerReason).not.toBe('supplemental_review_delivered');
        expect(review.posts()).toBe(1);
      } else {
        expect(second, JSON.stringify(second.result)).toMatchObject({
          exitCode: 0,
          result: {
            ok: true, recovered: true, reused: true, created: false,
            outcome: 'supplemental_review_delivered',
            reason: 'supplemental_review_delivered', reviewVerdict: 'clean',
            targetSha: HEAD, headSha: HEAD,
            resolvedReviewer: 'codex', executedReviewer: 'codex',
            githubReviewId: expect.any(Number),
          },
        });
        expect(review.posts()).toBe(mode === 'missing' ? 2 : 1);
      }
      expect(String(second.result.runId)).toBe(originalRunId);
      expect(nativeInvocations).toBe(1);
      expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot: f.storeRoot })).toHaveLength(2);
      const after = getPackReviewRun(originalRunId, {
        projectId: 'orchestrator-pack', storeRoot: f.storeRoot,
      });
      expect(after?.deliveryOutcomes.requiredStatus).toBeUndefined();
      expect(f.statusWrites).toHaveLength(f.statusCount);
      expect(f.getNotificationCount()).toBe(f.notificationCount);
    },
  );
  it('executes explicit Codex on T3 conflict-free H2 without a synthetic carry-over terminal', async () => {
    const prNumber = 260717;
    const h1 = '1'.repeat(40);
    const h2 = '2'.repeat(40);
    const storeRoot = fixtureRoot2607('opk-2607-exact-h2-carryover-');
    setupHarness(storeRoot);
    let observedStatus: string | undefined;
    const base = {
      projectId: 'orchestrator-pack', storeRoot, sourceRepoRoot: process.cwd(),
      prNumber, fixturePrState: 'OPEN' as const,
      fixturePrBody: 'Closes #' + prNumber,
      fixturePostReviewPrBody: 'Closes #' + prNumber,
      fixtureRepoSlug: repository, fixtureIssueNumber: prNumber,
      fixtureIssueTitle: '[T3] Explicit H2 reviewer',
      fixtureIssueBody: ['```complexity-tier', 'tier: T3', '```'].join('\n'),
      fixtureReviewStdout: cleanPayload(),
      fixtureRequiredStatusWriter: async (request: { state: string }) => { observedStatus = request.state; },
      fixtureRequiredStatusReader: async () => observedStatus,
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    };
    const first = await startPackReview({
      ...base, headSha: h1, fixtureCurrentPrHeadSha: h1, fixturePostReviewHeadSha: h1,
    });
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true, created: true });
    expect(readPackReviewAuthority(prNumber, { storeRoot })?.cycle?.consumedRoundOrdinals).toEqual([1]);
    const log = join(storeRoot, 'actual-h2-invocations.jsonl');
    process.env.PACK_REVIEW_RUNNER_INVOCATION_LOG = log;
    const beforeInvocation = vi.fn(async () => {
      const authority = readPackReviewAuthority(prNumber, { storeRoot });
      expect(authority?.terminal?.targetSha).not.toBe(h2);
      expect(authority?.cycle?.consumedRoundOrdinals).toEqual([1]);
    });
    const second = await startPackReview({
      ...base, headSha: h2, fixtureCurrentPrHeadSha: h2, fixturePostReviewHeadSha: h2,
      reviewerOverride: 'codex', surface: 'pack-gpt-review',
      fixtureRequiredCiPolicy: { contexts: ['pr scope guard'], checks: [] },
      fixtureRequiredCiChecks: [{ name: 'pr scope guard', state: 'SUCCESS' }],
      fixtureRequiredCiHeadAfterGate: h2,
      fixtureCarryoverReplay: {
        kind: 'conflict_free_carryover', sourceHeadSha: h1, targetHeadSha: h2,
        mainSha: '3'.repeat(40), mergeBaseSha: '4'.repeat(40),
        replayTreeSha: '5'.repeat(40), replayDigest: 'two-parent-clean-merge',
      },
      fixtureCarryoverSourceCleanRunId: String(first.runId),
      fixtureAfterNativeInitialArmed: beforeInvocation,
    });
    expect(second, JSON.stringify(second)).toMatchObject({
      ok: true, created: true, headSha: h2, targetSha: h2,
      resolvedReviewer: 'codex', executedReviewer: 'codex',
      reviewerInvokedForThisRun: true,
    });
    expect(second.reviewerExecutionRunId).toBe(second.runId);
    expect(beforeInvocation).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(log, 'utf8').trim()).reviewer).toBe('codex');
    expect(readPackReviewAuthority(prNumber, { storeRoot })?.cycle?.consumedRoundOrdinals).toEqual([1, 2]);
  });

  it('accepts a real required native journal and COMMENT/status resume through explicit CLI', async () => {
    const prNumber = 260718;
    const storeRoot = fixtureRoot2607('opk-2607-native-required-resume-');
    setupHarness(storeRoot);
    const review = reviewTransport(prNumber, 'success');
    let observedStatus: string | undefined;
    let nativeInvocations = 0;
    const startReview = commandStart2607(storeRoot, {
      fixturePrBody: 'Closes #' + prNumber,
      fixturePostReviewPrBody: 'Closes #' + prNumber,
      fixtureIssueNumber: prNumber, fixtureIssueTitle: '[T3] Required journal resume',
      fixtureIssueBody: ['```complexity-tier', 'tier: T3', '```'].join('\n'),
      fixtureGithubReviewTransport: review.transport,
      fixtureAfterNativeInitialArmed: async () => { nativeInvocations += 1; },
      fixtureRequiredStatusWriter: async (request: { state: string }) => { observedStatus = request.state; },
      fixtureRequiredStatusReader: async () => observedStatus,
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    });
    const seeded = createPackReviewRun({
      projectId: 'orchestrator-pack', storeRoot, prNumber, headSha: HEAD,
      trustedPackRoot: process.cwd(), sourceRepoRoot: process.cwd(),
      canonicalRepository: repository, resolvedReviewer: 'codex',
    }).run;
    const recordedAtUtc = new Date().toISOString();
    updatePackReviewRun(seeded.id, {
      status: 'reviewing', latestRunStatus: 'reviewing',
      resolvedReviewer: 'codex', executedReviewer: 'codex',
      reviewerInvokedForThisRun: true, reviewerExecutionRunId: seeded.id,
      reviewVerdict: 'clean', findingCount: 0, findings: [],
      journalOutcome: {
        state: 'persisted', reason: 'verdict_persisted', recordedAtUtc,
        idempotencyKey: `verdict:${seeded.id}:${HEAD}`, attempts: 1,
      },
      deliveryOutcomes: {
        githubComment: {
          state: 'failed', recordedAtUtc, reason: 'initial COMMENT transport failed',
          idempotencyKey: `github-comment:${seeded.id}:${HEAD}`,
        },
      },
    }, { projectId: 'orchestrator-pack', storeRoot });
    const resumed = await runPackGptReviewCommand({ prNumber, reviewer: 'codex' }, {
      env: process.env, stderr: { write: () => undefined }, startReview,
    });
    expect(resumed, JSON.stringify(resumed.result)).toMatchObject({
      exitCode: 0,
      result: {
        ok: true, created: false, reused: true, recovered: true,
        reason: 'resumed_journaled_delivery', deliveryReason: 'completed',
        headSha: HEAD, targetSha: HEAD, runId: seeded.id,
        resolvedReviewer: 'codex', executedReviewer: 'codex',
        reviewerInvokedForThisRun: true,
        deliveryOutcomes: {
          githubComment: { state: 'succeeded' },
          requiredStatus: { state: 'succeeded' },
        },
      },
    });
    expect(resumed.result.reviewerExecutionRunId).toBe(seeded.id);
    expect(resumed.result).not.toHaveProperty('publicationVerified');
    expect(nativeInvocations).toBe(0);
    expect(review.posts()).toBe(1);
  });

  it('recovers a crash before required GPT aggregate from original credentialed comments through explicit CLI', async () => {
    const prNumber = 260719;
    const storeRoot = fixtureRoot2607('opk-2607-required-gpt-crash-');
    setupHarness(storeRoot);
    const source = originalSourceTransport(prNumber);
    const review = reviewTransport(prNumber, 'success');
    let observedStatus: string | undefined;
    const fixture = {
      fixturePrBody: 'Closes #' + prNumber,
      fixturePostReviewPrBody: 'Closes #' + prNumber,
      fixtureIssueNumber: prNumber, fixtureIssueTitle: '[T1] Required GPT crash',
      fixtureIssueBody: issueBody,
      fixtureGptSourceCommentTransport: source.transport,
      fixtureBeforeGptSourceCommentCensus: source.publishOriginal,
      fixtureGithubReviewTransport: review.transport,
      fixtureRequiredStatusWriter: async (request: { state: string }) => { observedStatus = request.state; },
      fixtureRequiredStatusReader: async () => observedStatus,
    };
    const first = await runPackGptReviewCommand({ prNumber, reviewer: 'gpt' }, {
      env: process.env, stderr: { write: () => undefined },
      startReview: commandStart2607(storeRoot, {
        ...fixture, fixtureCrashAfterGptSourceCredentialedCount: 3,
      }),
    });
    expect(first.exitCode).toBe(1);
    expect(source.sent()).toBe(3);
    const originalId = String(first.result.runId);
    expect(getPackReviewRun(originalId, { projectId: 'orchestrator-pack', storeRoot })).toMatchObject({
      reviewerExecutionRunId: undefined, executedReviewer: undefined,
      reviewVerdict: undefined,
    });
    const resumed = await runPackGptReviewCommand({ prNumber, reviewer: 'gpt' }, {
      env: process.env, stderr: { write: () => undefined },
      startReview: commandStart2607(storeRoot, fixture),
    });
    expect(resumed, JSON.stringify(resumed.result)).toMatchObject({
      exitCode: 0,
      result: {
        ok: true, created: false, reused: true, recovered: true,
        reason: 'resumed_journaled_delivery', runId: originalId,
        headSha: HEAD, targetSha: HEAD,
        publicationVerified: true, publicationHeadSha: HEAD,
        resolvedReviewer: 'gpt', executedReviewer: 'gpt',
        reviewerInvokedForThisRun: true,
        githubReviewId: expect.any(Number),
      },
    });
    expect(resumed.result.reviewerExecutionRunId).toBe(originalId);
    expect(source.sent()).toBe(3);
    expect(review.posts()).toBe(1);
    expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })).toHaveLength(1);
    expect(getPackReviewRun(originalId, { projectId: 'orchestrator-pack', storeRoot }))
      .toMatchObject({
        reviewVerdict: 'clean', reviewerExecutionRunId: originalId,
        reviewerInvokedForThisRun: true, journalOutcome: { state: 'persisted' },
        deliveryOutcomes: {
          githubComment: { state: 'succeeded' },
          requiredStatus: { state: 'succeeded' },
        },
      });
  });

  it('refuses contradictory invocation provenance during required GPT credentialed recovery', async () => {
    const prNumber = 260720;
    const storeRoot = fixtureRoot2607('opk-2607-required-gpt-origin-conflict-');
    setupHarness(storeRoot);
    const source = originalSourceTransport(prNumber);
    const review = reviewTransport(prNumber, 'success');
    const fixture = {
      fixturePrBody: 'Closes #' + prNumber,
      fixturePostReviewPrBody: 'Closes #' + prNumber,
      fixtureIssueNumber: prNumber, fixtureIssueTitle: '[T1] Credentialed original',
      fixtureIssueBody: issueBody,
      fixtureGptSourceCommentTransport: source.transport,
      fixtureBeforeGptSourceCommentCensus: source.publishOriginal,
      fixtureGithubReviewTransport: review.transport,
      fixtureRequiredStatusWriter: async () => undefined,
      fixtureRequiredStatusReader: async () => 'success',
    };
    const first = await runPackGptReviewCommand({ prNumber, reviewer: 'gpt' }, {
      env: process.env, stderr: { write: () => undefined },
      startReview: commandStart2607(storeRoot, {
        ...fixture, fixtureCrashAfterGptSourceCredentialedCount: 3,
      }),
    });
    expect(first.exitCode).toBe(1);
    const id = String(first.result.runId);
    updatePackReviewRun(id, {
      executedReviewer: 'codex', reviewerInvokedForThisRun: false, reviewerExecutionRunId: 'foreign-run-id',
    }, { projectId: 'orchestrator-pack', storeRoot });
    const second = await runPackGptReviewCommand({ prNumber, reviewer: 'gpt' }, {
      env: process.env, stderr: { write: () => undefined },
      startReview: commandStart2607(storeRoot, fixture),
    });
    expect(second.exitCode).toBe(1);
    const original = getPackReviewRun(id, { projectId: 'orchestrator-pack', storeRoot });
    expect(original?.reviewerInvokedForThisRun).toBe(false);
    expect(original?.executedReviewer).toBe('codex');
    expect(original?.reviewerExecutionRunId).toBe('foreign-run-id');
    expect(original?.journalOutcome?.state).not.toBe('persisted');
    expect(review.posts()).toBe(0);
  });
});


describe('Issue #2629 zero-dispatch rate-limit terminal recovery', () => {
  const projectId = 'leopoker';
  const prNumber = 345;
  const repository = 'chetwerikoff/orchestrator-pack';
  const issueBody = [
    String.fromCharCode(96).repeat(3) + 'complexity-tier',
    'tier: T2',
    String.fromCharCode(96).repeat(3),
  ].join('\n');
  const exactCommand = 'OPK_PROJECT_ID=leopoker npm run --silent pack-gpt-review -- --project leopoker --pr-number 345';

  function fixture(input: {
    mutate?: (slot: PackReviewGptRoundRecord['sourceSlots'][number]) =>
      PackReviewGptRoundRecord['sourceSlots'][number];
    commentMode?: 'missing' | 'duplicate' | 'unavailable-actor' | 'unavailable-census';
    historicalClaim?: boolean;
    logicalRoundCap?: number;
    reviewCycleId?: string;
  } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'opk-2629-rate-limit-'));
    roots.push(root);
    const storeRoot = join(root, 'store');
    setupHarness(storeRoot);
    const projects = join(process.env.XDG_CONFIG_HOME!, 'orchestrator-pack', 'projects');
    writeFileSync(join(projects, 'leopoker.json'), JSON.stringify({
      projectId, repository, primaryRoot: process.cwd(), defaultBranch: 'main',
      orcaWorkspacePattern: '^test-only$', orchestratorTitlePattern: '^test-only$',
      browserGpt: { projectUrl: 'https://chatgpt.com/g/fixture/project' },
    }));
    process.env.OPK_PROJECT_ID = projectId;
    process.env.PACK_REVIEWER = 'gpt';
    process.env.PACK_GPT_BROWSER_PROFILE = join(root, 'chrome-profile');
    process.env.PACK_GPT_BROWSER_CDP = 'http://127.0.0.1:9222';
    process.env.CHATGPT_BROWSER_TURN_STATE_DIR = join(root, 'browser-state');
    const profileKey = configuredProfileKey(
      process.env.PACK_GPT_BROWSER_PROFILE,
      process.env.PACK_GPT_BROWSER_CDP,
    );
    const options = { projectId, storeRoot };
    const authority = initializePackReviewAuthority({
      prNumber, headSha: HEAD, tier: 'T2',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION, options: { storeRoot },
    });
    const round: PackReviewGptRoundRecord = {
      schema: 'pack-review-gpt-round/v1', reviewer: 'gpt', tier: 'T2',
      accountingVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      roundOrdinal: 1, cardinality: 3, issueNumber: prNumber,
      boundIssueSnapshotDigest: computeBoundIssueSnapshotHash(issueBody),
      sourceSlots: [1, 2, 3].map((ordinal) => {
        const invocationId = '00002629-0000-4000-8000-00000000000' + ordinal;
        const cause = ordinal === 1 ? 'account_conversations_http_429' : 'account_cooldown_active';
        const slot: PackReviewGptRoundRecord['sourceSlots'][number] = {
          slotId: 'source-' + String(ordinal).padStart(2, '0'),
          ordinal, lifecycle: 'terminal', invocationId, attemptOrdinal: 1,
          admissionStartedAtUtc: '2026-01-01T00:00:00.000Z',
          launchProfileKey: profileKey,
          launchCdpUrl: process.env.PACK_GPT_BROWSER_CDP,
          terminalClass: 'rate_limit:' + cause,
          terminalResult: {
            schema: 'turn-result/v1', state: 'rate_limit', cause,
            scope: 'invocation', invocation_id: invocationId,
            send_count: 0, send_attempted: false,
          },
        };
        return ordinal === 1 && input.mutate ? input.mutate(slot) : slot;
      }),
    };
    const original = createPackReviewRun({
      ...options, prNumber, headSha: HEAD,
      trustedPackRoot: process.cwd(), sourceRepoRoot: process.cwd(),
      canonicalRepository: repository,
      accountingVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      reviewCycleId: input.reviewCycleId ?? authority.cycle!.cycleId,
      logicalRoundOrdinal: 1, logicalRoundCap: input.logicalRoundCap ?? 1,
      automaticBudgetDisposition: 'consume',
      resolvedReviewer: 'gpt', reviewRound: round,
    }).run;
    let historicalClaimPath: string | undefined;
    if (input.historicalClaim) {
      const claim = acquireReviewStartClaim({
        projectId, prNumber, headSha: HEAD,
        surface: 'fixture-2629-historical-claim', startReason: 'fixture-first-attempt',
        reviewRuns: listPackReviewRuns(options),
      });
      expect(claim.acquired, JSON.stringify(claim)).toBe(true);
      const completed = completeAfterRunInvoke(claim, listPackReviewRuns(options));
      expect(completed).toMatchObject({ ok: true, outcome: 'run_started' });
      historicalClaimPath = String(completed.terminalPath);
      expect(existsSync(historicalClaimPath)).toBe(true);
    }
    updatePackReviewRun(original.id, {
      status: 'failed', latestRunStatus: 'failed',
      failureReason: 'gpt_source_non_complete:after_grace_zero_usable:0/3',
      completedAtUtc: new Date().toISOString(),
      runnerPid: 2147483647,
    }, options);
    const originalSlots = getPackReviewRun(original.id, options)!.reviewRound!.sourceSlots;
    const comments: PackGptSourceGithubComment[] = [];
    const actor = 'fixture-2629-source';
    const commentTransport: PackGptSourceCommentTransport = {
      resolveActorLogin: async () => {
        if (input.commentMode === 'unavailable-actor') throw new Error('synthetic actor lookup failure');
        return actor;
      },
      listComments: async () => {
        if (input.commentMode === 'unavailable-census') throw new Error('synthetic paginated census failure');
        return [...comments];
      },
      getComment: async (id) => {
        const found = comments.find((item) => item.id === id);
        if (!found) throw new Error('original comment unreadable');
        return found;
      },
    };
    const publish = ({ identity }: { identity: PackGptSourceIdentity }) => {
      const index = comments.length + 1;
      const timestamp = new Date().toISOString();
      const id = 2629000 + index;
      comments.push({
        id, body: formatPackGptSourceCommentEnvelope(identity, 'NO_FINDINGS'),
        actorLogin: actor, createdAt: timestamp, updatedAt: timestamp,
        url: 'https://github.com/' + repository + '/pull/' + prNumber + '#issuecomment-' + id,
        issueUrl: 'https://api.github.com/repos/' + repository + '/issues/' + prNumber,
      });
    };
    if (input.commentMode === 'duplicate') {
      const first = originalSlots[0]!;
      const identity: PackGptSourceIdentity = {
        repository, prNumber, headSha: HEAD, runId: original.id,
        slotId: first.slotId, invocationId: first.invocationId!,
      };
      publish({ identity });
      publish({ identity });
    }
    const reviews: GithubReviewSummary[] = [];
    const reviewTransport: GithubReviewTransport = {
      resolveActorLogin: async () => 'fixture-2629-final',
      listReviews: async () => [...reviews],
      postReview: async ({ body, commitId }) => {
        const id = 2629990 + reviews.length;
        const url = 'https://github.com/' + repository + '/pull/' + prNumber + '#pullrequestreview-' + id;
        reviews.push({
          id, body, commitId, state: 'COMMENTED',
          submittedAt: new Date().toISOString(),
          userLogin: 'fixture-2629-final', url,
        });
        return { id, url };
      },
      dismissReview: async () => undefined,
    };
    let requiredStatus: string | undefined;
    const statusWrites: string[] = [];
    const writeRequiredStatus = async (request: { state: string }) => {
      requiredStatus = request.state;
      statusWrites.push(request.state);
    };
    const common = {
      ...options, prNumber, repoSlug: repository, sourceRepoRoot: process.cwd(), headSha: HEAD,
      fixtureCurrentPrHeadSha: HEAD, fixturePostReviewHeadSha: HEAD,
      fixtureRepoSlug: repository, fixturePrState: 'OPEN' as const,
      fixturePrBody: 'Closes #' + prNumber,
      fixturePostReviewPrBody: 'Closes #' + prNumber,
      fixtureIssueNumber: prNumber,
      fixtureIssueTitle: '[T2] Synthetic LeoPoker GPT rate limit',
      fixtureIssueBody: issueBody,
      fixtureGptSourceCommentTransport: commentTransport,
      fixtureRequiredStatusWriter: writeRequiredStatus,
      fixtureRequiredStatusReader: async () => requiredStatus,
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    };
    const reconcile = (overrides: Record<string, unknown> = {}) => reconcileStalePackReviewRuns({
      ...common, ...overrides,
    });
    const freshStarts: string[] = [];
    const start = (overrides: Record<string, unknown> = {}) =>
      runPackGptReviewCommand({ projectId, prNumber }, {
        env: process.env, stderr: { write: () => undefined },
        startReview: (request) => startPackReview({
          ...request,
          ...common,
          fixtureRequiredCiPolicy: {
            contexts: ['verify orchestrator-pack structure', 'pr scope guard', 'orchestrator-pack/pack-review'],
            checks: [],
          },
          fixtureRequiredCiChecks: [
            { name: 'verify orchestrator-pack structure', state: 'SUCCESS' },
            { name: 'pr scope guard', state: 'SUCCESS' },
            { name: 'orchestrator-pack/pack-review', state: 'PENDING' },
          ],
          fixtureRequiredCiHeadAfterGate: HEAD,
          fixtureReviewStdout: cleanPayload(),
          fixtureBeforeGptSourceCommentCensus: publish,
          fixtureGithubReviewTransport: reviewTransport,
          fixtureAfterGptInvocationBound: ({ slotId }) => { freshStarts.push(slotId); },
          ...overrides,
        }),
      });
    const cooldownPath = join(profileDirs(profileKey).locks, 'state-light-account-cooldown.v1.json');
    const setCooldown = (value?: unknown) => {
      if (value !== undefined) writeFileSync(cooldownPath, JSON.stringify({ cooldown_until_ms: value }));
    };
    return {
      options, original, originalSlots, profileKey, comments, publish, commentTransport,
      reconcile, start, setCooldown, statusWrites, reviews, freshStarts,
      cooldownPath, historicalClaimPath,
    };
  }

  it.each(['future', 'expired', 'malformed', 'unavailable', 'invalid', 'unreadable', 'unresolvable'] as const)(
    'returns a verified fresh-run command after rate-limit recovery with %s cooldown',
    async (mode) => {
      const f = fixture();
      const future = Date.now() + 240_000;
      if (mode === 'future') f.setCooldown(future);
      if (mode === 'expired') f.setCooldown(Date.now() - 10_000);
      if (mode === 'malformed') f.setCooldown('not-a-number');
      if (mode === 'invalid') f.setCooldown(Date.now() + 600_000);
      if (mode === 'unreadable') mkdirSync(f.cooldownPath);
      if (mode === 'unresolvable') delete process.env.PACK_GPT_BROWSER_PROFILE;
      const result = await f.reconcile();
      const row = result.results.find((item) => item.runId === f.original.id && typeof item.nextAction === 'string');
      expect(row).toMatchObject({ terminalized: false, statusReconciled: true });
      expect(String(row!.nextAction)).toContain(exactCommand);
      expect(String(row!.nextAction)).not.toContain('scripts/pack-review-runner.ts reconcile');
      if (mode === 'future') {
        expect(String(row!.nextAction)).toContain(new Date(future).toISOString());
        expect(String(row!.nextAction)).toContain('after the shared account cooldown');
      } else {
        expect(String(row!.nextAction)).toContain('start the fresh review run now:');
      }
      expect(getPackReviewRun(f.original.id, f.options)).toMatchObject({
        status: 'failed', failureReason: 'gpt_source_non_complete:after_grace_zero_usable:0/3',
        deliveryOutcomes: { requiredStatus: { state: 'succeeded' } },
      });
      expect(readPackReviewAuthority(prNumber, { storeRoot: f.options.storeRoot })
        ?.cycle?.consumedRoundOrdinals).toEqual([]);
    },
  );

  it('enters one original-SHA PR-led fresh run, preserves historic failed source IDs and terminal claim', async () => {
    const f = fixture({ historicalClaim: true });
    f.setCooldown(Date.now() - 5_000);
    const historicalClaimPath = f.historicalClaimPath!;
    expect(existsSync(historicalClaimPath)).toBe(true);
    const originalClaimBytes = readFileSync(historicalClaimPath, 'utf8');
    const reconciled = await f.reconcile();
    expect(String(reconciled.results.find((row) => row.runId === f.original.id && typeof row.nextAction === 'string')?.nextAction))
      .toContain(exactCommand);

    const next = await f.start();
    expect(next.result, JSON.stringify(next.result)).toMatchObject({
      created: true, reused: false, prNumber, headSha: HEAD, publicationVerified: true,
    });
    const newId = String(next.result.runId);
    expect(newId).not.toBe(f.original.id);
    expect(f.freshStarts).toEqual(['source-01', 'source-02', 'source-03']);
    const old = getPackReviewRun(f.original.id, f.options)!;
    expect(old).toMatchObject({
      id: f.original.id, status: 'failed',
      failureReason: 'gpt_source_non_complete:after_grace_zero_usable:0/3',
    });
    expect(old.reviewVerdict).toBeUndefined();
    expect(old.journalOutcome).toBeUndefined();
    expect(old.reviewRound!.sourceSlots).toEqual(f.originalSlots);
    expect(listPackReviewRuns(f.options)).toHaveLength(2);
    expect(getPackReviewRun(newId, f.options)?.reviewRound?.sourceSlots.map((slot) => slot.invocationId))
      .not.toEqual(f.originalSlots.map((slot) => slot.invocationId));
    expect(existsSync(historicalClaimPath)).toBe(true);
    expect(readFileSync(historicalClaimPath, 'utf8')).toBe(originalClaimBytes);
    expect(f.reviews).toHaveLength(1);
    expect(readPackReviewAuthority(prNumber, { storeRoot: f.options.storeRoot })
      ?.cycle?.consumedRoundOrdinals).toEqual([1]);

    const repeated = await f.start();
    expect(repeated.result.created).not.toBe(true);
    expect(listPackReviewRuns(f.options)).toHaveLength(2);
    expect(f.reviews).toHaveLength(1);
  });

  it.each([
    ['positive send count within rate_limit terminal', (slot: PackReviewGptRoundRecord['sourceSlots'][number]) => ({
      ...slot, terminalClass: 'possible_delivery',
      terminalResult: {
        ...(slot.terminalResult as Record<string, unknown>),
        send_count: 1, send_attempted: true,
      },
    })],
    ['send attempted despite count zero', (slot: PackReviewGptRoundRecord['sourceSlots'][number]) => ({
      ...slot, terminalResult: { ...(slot.terminalResult as Record<string, unknown>), send_attempted: true },
    })],
    ['persisted dispatch phase', (slot: PackReviewGptRoundRecord['sourceSlots'][number]) => ({
      ...slot, terminalResult: {
        ...(slot.terminalResult as Record<string, unknown>),
        diagnostics: { persisted_observation: { phase: 'dispatching', send_count: 0 } },
      },
    })],
    ['unknown original send count', (slot: PackReviewGptRoundRecord['sourceSlots'][number]) => ({
      ...slot, terminalClass: 'possible_delivery/missing_result',
      terminalResult: { kind: 'missing_terminal_result', noResend: true },
    })],
    ['missing original terminal evidence', (slot: PackReviewGptRoundRecord['sourceSlots'][number]) => ({
      ...slot, lifecycle: 'invocation_started' as const,
      terminalClass: undefined, terminalResult: undefined,
    })],
    ['rotated original invocation identity', (slot: PackReviewGptRoundRecord['sourceSlots'][number]) => ({
      ...slot,
      invocationId: '00002629-0000-4000-8000-000000000099',
      attemptOrdinal: 2,
      attemptHistory: [{
        invocationId: slot.invocationId!, attemptOrdinal: 1, terminalClass: slot.terminalClass!,
      }],
      terminalResult: {
        ...(slot.terminalResult as Record<string, unknown>),
        invocation_id: '00002629-0000-4000-8000-000000000099',
      },
    })],
    ['second attempt', (slot: PackReviewGptRoundRecord['sourceSlots'][number]) => ({
      ...slot, attemptOrdinal: 2,
    })],
    ['attempt history', (slot: PackReviewGptRoundRecord['sourceSlots'][number]) => ({
      ...slot, attemptHistory: [{
        invocationId: 'previous-2629', attemptOrdinal: 1, terminalClass: 'rate_limit:account_cooldown_active',
      }],
    })],
    ['possible delivery', (slot: PackReviewGptRoundRecord['sourceSlots'][number]) => ({
      ...slot, terminalClass: 'possible_delivery',
      terminalResult: { ...(slot.terminalResult as Record<string, unknown>), send_attempted: true },
    })],
    ['contradictory source reconciliation', (slot: PackReviewGptRoundRecord['sourceSlots'][number]) => ({
      ...slot, terminalResult: { ...(slot.terminalResult as Record<string, unknown>), source_comment_reconciliation: 'conflict' },
    })],
  ] as const)('never starts an unsafe new run when original has %s', async (_name, mutate) => {
    const f = fixture({ mutate });
    const reconciled = await f.reconcile();
    const nextAction = String(reconciled.results.find(
      (row) => row.runId === f.original.id && typeof row.nextAction === 'string',
    )?.nextAction);
    expect(nextAction).not.toContain(exactCommand);
    expect(nextAction).toContain('observe the original GPT turn');
    const next = await f.start();
    expect(next.result.created).not.toBe(true);
    expect(listPackReviewRuns(f.options)).toHaveLength(1);
    expect(f.freshStarts).toEqual([]);
    expect(f.statusWrites).not.toContain('success');
    expect(getPackReviewRun(f.original.id, f.options)?.reviewRound?.sourceSlots)
      .toEqual(f.originalSlots);
  });

  it.each(['duplicate', 'unavailable-actor', 'unavailable-census'] as const)(
    'preserves the original failed run on %s original comment census', async (commentMode) => {
      const f = fixture({ commentMode });
      const reconcile = await f.reconcile();
      expect(String(reconcile.results.find((item) => item.runId === f.original.id && typeof item.nextAction === 'string')?.nextAction))
        .not.toContain(exactCommand);
      const next = await f.start();
      expect(next.result.created).not.toBe(true);
      expect(f.freshStarts).toEqual([]);
      expect(listPackReviewRuns(f.options)).toHaveLength(1);
    },
  );

  it('does not claim fresh-run authority for a changed head, unowned claim, or mismatched frozen cap', async () => {
    const moved = fixture();
    const movedHead = 'b'.repeat(40);
    const changed = await moved.reconcile({ fixtureCurrentPrHeadSha: movedHead });
    expect(String(changed.results.find((item) => item.runId === moved.original.id && typeof item.nextAction === 'string')?.nextAction))
      .not.toContain(exactCommand);
    expect(listPackReviewRuns(moved.options)).toHaveLength(1);

    const claim = fixture();
    const noClaim = await startPackReview({
      ...claim.options, sourceRepoRoot: process.cwd(), prNumber, headSha: HEAD,
      claimMode: 'preacquired', fixtureRepoSlug: repository,
      fixtureCurrentPrHeadSha: HEAD, fixturePrState: 'OPEN',
      fixturePrBody: 'Closes #' + prNumber, fixtureIssueNumber: prNumber,
      fixtureIssueTitle: '[T2] Synthetic LeoPoker GPT rate limit',
      fixtureIssueBody: issueBody,
      fixtureGptSourceCommentTransport: {
        resolveActorLogin: async () => 'fixture-2629-source',
        listComments: async () => [],
        getComment: async () => { throw new Error('absent'); },
      },
      fixtureRequiredStatusWriter: async () => {},
    });
    expect(noClaim).toMatchObject({ ok: false, created: false });
    expect(listPackReviewRuns(claim.options)).toHaveLength(1);

    const cap = fixture({ logicalRoundCap: 2 });
    expect(getPackReviewRun(cap.original.id, cap.options)?.logicalRoundCap).toBe(2);
    const denied = await cap.start();
    expect(denied.result.created).not.toBe(true);
    expect(listPackReviewRuns(cap.options)).toHaveLength(1);
  });


  it.each(['planned', 'prelaunch'] as const)(
    'accepts a pristine %s slot alongside original zero-send rate-limit slots', async (mode) => {
      const f = fixture({ mutate: (slot) => mode === 'planned'
        ? { slotId: slot.slotId, ordinal: slot.ordinal, lifecycle: 'planned' as const }
        : {
            slotId: slot.slotId, ordinal: slot.ordinal, lifecycle: 'terminal' as const,
            terminalClass: 'pre_launch_interrupted',
            terminalResult: { kind: 'stale_pre_launch_interruption', noResend: true },
          } });
      const result = await f.reconcile();
      expect(result.results).toEqual(expect.arrayContaining([
        expect.objectContaining({ runId: f.original.id, statusReconciled: true, nextAction: expect.stringContaining(exactCommand) }),
      ]));
    },
  );

  it('accepts original numeric zero-send observation but rejects a later contradictory observation', async () => {
    const f = fixture();
    const invocationId = f.originalSlots[0]!.invocationId!;
    mkdirSync(join(profileDirs(f.profileKey).root, 'observations'), { recursive: true });
    const path = observationRecordPath(f.profileKey, invocationId);
    const originalObservation = {
      schema: 'state-light-turn-observation/v1', version: 1,
      invocation_id: invocationId, profile_key: f.profileKey,
      marker: 'OPKTURNV1-2629-original', phase: 'not_sent',
      send_count: 0, send_witness: 'numeric_send_count',
      conversation_url: null, transitioned_at: new Date().toISOString(),
      transition_reason: 'account_cooldown_active',
    };
    writeFileSync(path, JSON.stringify(originalObservation));
    const confirmed = await f.reconcile();
    expect(confirmed.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: f.original.id, nextAction: expect.stringContaining(exactCommand) }),
    ]));
    writeFileSync(path, JSON.stringify({
      ...originalObservation, phase: 'dispatching', transition_reason: 'send_delivery_unproven',
    }));
    const contradicted = await f.reconcile();
    const action = contradicted.results.find(
      (item) => item.runId === f.original.id && typeof item.nextAction === 'string',
    )?.nextAction;
    expect(String(action)).not.toContain(exactCommand);
    const denied = await f.start();
    expect(denied.result.created).not.toBe(true);
    expect(listPackReviewRuns(f.options)).toHaveLength(1);
  });


  it('rejects a source comment under the last original invocation even if the deciding sources were rate-limited', async () => {
    const f = fixture();
    const last = f.originalSlots[2]!;
    f.publish({ identity: {
      repository, prNumber, headSha: HEAD, runId: f.original.id,
      slotId: last.slotId, invocationId: last.invocationId!,
    } });
    const posted = f.comments[0]!;
    expect(posted.body).toContain(`slot=${last.slotId} invocation=${last.invocationId}`);
    // A comment contradicting the persisted zero-send rate_limit terminal
    // cannot become a safe 1/3 source merely by reconciliation hydration.
    // Repeating reconcile must not launder that original 0/3 into a retry.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reconciled = await f.reconcile();
      expect(reconciled.results.filter((row) => row.runId === f.original.id)
        .every((row) => !String(row.nextAction ?? '').includes(exactCommand))).toBe(true);
      expect(f.comments).toEqual([posted]);
      expect(f.freshStarts).toEqual([]);
    }
    const next = await f.start();
    expect(next.result.created).not.toBe(true);
    expect(f.freshStarts).toEqual([]);
    expect(f.comments).toEqual([posted]);
    expect(listPackReviewRuns(f.options)).toHaveLength(1);
  });

  it('does not override a concurrently active claim for this exact PR/head', async () => {
    const f = fixture();
    const active = acquireReviewStartClaim({
      projectId, prNumber, headSha: HEAD,
      surface: 'fixture-2629-active-claim', startReason: 'fixture-competing-start',
      reviewRuns: listPackReviewRuns(f.options),
    });
    expect(active.acquired, JSON.stringify(active)).toBe(true);
    const next = await f.start();
    expect(next.result.created).not.toBe(true);
    expect(f.freshStarts).toEqual([]);
    expect(listPackReviewRuns(f.options)).toHaveLength(1);
  });

  it('refuses exceptional same-head admission with a mismatched reviewer', async () => {
    const f = fixture();
    updatePackReviewRun(f.original.id, { resolvedReviewer: 'codex' }, f.options);
    const next = await f.start();
    expect(next.result.created).not.toBe(true);
    expect(f.freshStarts).toEqual([]);
    expect(listPackReviewRuns(f.options)).toHaveLength(1);
  });

  it('refuses exceptional same-head admission with a mismatched cycle', async () => {
    const f = fixture({ reviewCycleId: 'different-cycle-2629' });
    expect(getPackReviewRun(f.original.id, f.options)?.reviewCycleId).toBe('different-cycle-2629');
    const next = await f.start();
    expect(next.result.created).not.toBe(true);
    expect(f.freshStarts).toEqual([]);
    expect(listPackReviewRuns(f.options)).toHaveLength(1);
  });

  it('refuses another review after a schema-valid completed verdict and settled authority', async () => {
    const f = fixture();
    const first = await f.start();
    expect(first.result.created).toBe(true);
    const completed = getPackReviewRun(String(first.result.runId), f.options)!;
    expect(completed).toMatchObject({ reviewVerdict: 'clean', findingCount: 0, findings: [] });
    const authority = readPackReviewAuthority(prNumber, { storeRoot: f.options.storeRoot });
    expect(authority?.terminal?.runId).toBe(completed.id);
    expect(authority?.cycle?.reviewStageComplete).toBe(true);

    const repeated = await f.start();
    expect(repeated.result.created).not.toBe(true);
    expect(listPackReviewRuns(f.options)).toHaveLength(2);
    expect(f.reviews).toHaveLength(1);
    expect(f.freshStarts).toEqual(['source-01', 'source-02', 'source-03']);
  });

  it('never replays the historical HEAD as the current PR-led target after a head change', async () => {
    const f = fixture();
    const advancedHead = 'b'.repeat(40);
    await f.start({
      fixtureCurrentPrHeadSha: advancedHead,
      fixturePostReviewHeadSha: advancedHead,
      fixtureRequiredCiHeadAfterGate: advancedHead,
    });
    expect(getPackReviewRun(f.original.id, f.options)?.targetSha).toBe(HEAD);
    for (const record of listPackReviewRuns(f.options)) {
      if (record.id !== f.original.id) expect(record.targetSha).toBe(advancedHead);
    }
  });

  it.each([
    ['safe repeated 429', false],
    ['unsafe older attempted send', true],
  ] as const)('admits R1 -> R2 -> R3 only with %s history', async (_case, unsafeOlder) => {
    const f = fixture({ historicalClaim: true });
    const claimBytes = readFileSync(f.historicalClaimPath!, 'utf8');
    const zeroSendAttempts: Record<string, Array<{ stdout: string; exitCode: number }>> = {};
    const r2 = await f.start({
      fixtureReviewBySourceSlot: zeroSendAttempts,
      fixtureBeforeGptSourceCommentCensus: async () => undefined,
      fixtureAfterGptInvocationBound: ({ slotId, invocationId }: { slotId: string; invocationId: string }) => {
        f.freshStarts.push(slotId);
        zeroSendAttempts[slotId] = [{
          stdout: JSON.stringify({
            schema: 'turn-result/v1', state: 'rate_limit', cause: 'account_cooldown_active',
            scope: 'invocation', invocation_id: invocationId, send_count: 0, send_attempted: false,
          }),
          exitCode: 13,
        }];
      },
    });
    // The initial R2 run has no usable sources but has not passed the shared
    // grace threshold. It must not terminalize or authorize another run yet.
    expect(r2.result, JSON.stringify(r2.result)).toMatchObject({
      created: true, headSha: HEAD, runnerReason: 'gpt_sources_waiting_for_grace:0/3',
    });
    const r2Id = String(r2.result.runId);
    expect(r2Id).not.toBe(f.original.id);
    expect(getPackReviewRun(r2Id, f.options)?.status).toBe('preparing');
    // Simulate the same runner becoming dead and its real grace interval
    // elapsing; only the existing reconciler may then terminalize safe 0/3.
    const deadR2 = updatePackReviewRun(r2Id, { runnerPid: 2147483647 }, f.options);
    // Anchor grace to this R2's persisted heartbeat rather than the ambient
    // wall clock. Reconcile only R2: processing historic R1 first can restore
    // R2's pending status, refresh its heartbeat and undo the stale predicate.
    const afterGraceAt = new Date(Date.parse(deadR2.heartbeatAtUtc) + 60 * 60_000);
    vi.useFakeTimers({ toFake: ['Date'], now: afterGraceAt });
    try {
      const afterGrace = await f.reconcile({ runId: r2Id });
      expect(afterGrace.results.find((row) => row.runId === r2Id && row.terminalized)).toMatchObject({
        terminalized: true, statusReconciled: true,
      });
    } finally {
      vi.useRealTimers();
    }
    expect(getPackReviewRun(r2Id, f.options)).toMatchObject({
      status: 'failed', failureReason: expect.stringContaining('gpt_source_non_complete:'),
    });
    expect(getPackReviewRun(r2Id, f.options)?.reviewRound?.sourceSlots.every(
      (slot) => slot.terminalClass?.startsWith('rate_limit:')
        && (slot.terminalResult as Record<string, unknown>)?.send_count === 0,
    )).toBe(true);
    expect(f.comments).toHaveLength(0);
    const reconciled = await f.reconcile();
    expect(String(reconciled.results.find((row) => row.runId === r2Id && typeof row.nextAction === 'string')?.nextAction))
      .toContain(exactCommand);

    if (unsafeOlder) {
      const path = join(f.options.storeRoot, 'runs', f.original.id + '.json');
      const older = JSON.parse(readFileSync(path, 'utf8')) as PackReviewRunRecord;
      (older.reviewRound!.sourceSlots[0]!.terminalResult as Record<string, unknown>).send_attempted = true;
      writeFileSync(path, JSON.stringify(older));
    }
    const oldSlots = getPackReviewRun(f.original.id, f.options)!.reviewRound!.sourceSlots;
    const r2Slots = getPackReviewRun(r2Id, f.options)!.reviewRound!.sourceSlots;
    const r3 = await f.start();
    if (unsafeOlder) {
      expect(r3.result).toMatchObject({ created: false, runnerReason: 'gpt_rate_limit_history_unsafe' });
      expect(f.reviews).toHaveLength(0);
      expect(listPackReviewRuns(f.options)).toHaveLength(2);
      expect(f.freshStarts).toHaveLength(3);
    } else {
      expect(r3.result, JSON.stringify(r3.result)).toMatchObject({
        created: true, reused: false, headSha: HEAD, publicationVerified: true,
      });
      expect(String(r3.result.runId)).not.toBe(r2Id);
      expect(String(r3.result.runId)).not.toBe(f.original.id);
      expect(listPackReviewRuns(f.options)).toHaveLength(3);
      expect(f.reviews).toHaveLength(1);
      expect(f.freshStarts).toHaveLength(6);
      expect(readPackReviewAuthority(prNumber, { storeRoot: f.options.storeRoot })
        ?.cycle?.consumedRoundOrdinals).toEqual([1]);
    }
    expect(getPackReviewRun(f.original.id, f.options)).toMatchObject({
      status: 'failed', reviewRound: { sourceSlots: oldSlots },
    });
    expect(getPackReviewRun(r2Id, f.options)).toMatchObject({
      status: 'failed', reviewRound: { sourceSlots: r2Slots },
    });
    expect(readFileSync(f.historicalClaimPath!, 'utf8')).toBe(claimBytes);
  });

  it.each([
    ['first zero-send attempt', 1, 'none', true],
    ['persisted source-01 with an optional undefined mapped field', 1, 'optional_undefined_finding', true],
    ['two consecutive zero-send attempts', 2, 'none', true],
    ['three consecutive zero-send attempts', 3, 'none', true],
    ['historical attempted send', 2, 'historical_send_attempted', false],
    ['historical positive send count', 2, 'historical_send_count', false],
    ['historical possible delivery witness', 2, 'historical_owned_marker', false],
    ['historical dispatching phase', 2, 'historical_dispatching', false],
    ['historical changed profile key', 2, 'historical_rotated_profile', false],
    ['historical credentialed comment', 2, 'historical_posted_comment', false],
    ['historical non-rate-limit terminal', 2, 'historical_other_class', false],
    ['missing historical observation', 2, 'historical_observation_absent', false],
    ['current attempted send', 2, 'current_send_attempted', false],
    ['current possible delivery', 2, 'current_possible_delivery', false],
    ['missing current pre-send observation', 2, 'current_observation_absent', false],
  ] as const)('retries only missing sources from newer 1/3 after %s', async (_case, attemptCount, violation, shouldRetry) => {
    const f = fixture();
    const oldSlots = getPackReviewRun(f.original.id, f.options)!.reviewRound!.sourceSlots;
    const replacement = createPackReviewRun({
      ...f.options, prNumber, headSha: HEAD,
      trustedPackRoot: process.cwd(), sourceRepoRoot: process.cwd(),
      canonicalRepository: repository,
      accountingVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      reviewCycleId: f.original.reviewCycleId, logicalRoundOrdinal: 1, logicalRoundCap: 1,
      automaticBudgetDisposition: 'consume', resolvedReviewer: 'gpt',
      // A new run freezes its own planned slots, never the older 0/3
      // invocation identities. Source evidence is populated below.
      reviewRound: {
        ...f.original.reviewRound!,
        sourceSlots: oldSlots.map(({ slotId, ordinal }) => ({
          slotId, ordinal, lifecycle: 'planned' as const,
        })),
      },
      allowSameRoundReplacement: true,
    });
    expect(replacement.created).toBe(true);
    const newer = replacement.run;
    expect(newer.id).not.toBe(f.original.id);

    const sourceOneId = '00002644-0000-4000-8000-000000000001';
    const identity: PackGptSourceIdentity = {
      repository, prNumber, headSha: HEAD, runId: newer.id,
      slotId: 'source-01', invocationId: sourceOneId,
    };
    f.publish({ identity });
    if (violation === 'optional_undefined_finding') {
      // A finding without a path maps to { filePath: undefined }; JSON store
      // persistence omits that property, while re-credentialing maps it again.
      f.comments[f.comments.length - 1]!.body = formatPackGptSourceCommentEnvelope(
        identity,
        JSON.stringify({ findings: [{
          type: 'quality', code: 'quality:2653-optional-path', severity: 'blocking',
          summary: 'source-01 finding with no optional path', path: null, source: 'gpt-browser',
        }] }),
      );
    }
    const posted = await resolvePackGptSourceComment({
      identity, transport: f.commentTransport,
    });
    if (posted.kind !== 'credentialed') throw new Error('fixture source-01 was not credentialed');
    if (violation === 'optional_undefined_finding') {
      expect(posted.payload).toMatchObject({ verdict: 'findings', findingCount: 1 });
      expect(posted.payload.findings[0]).toHaveProperty('filePath', undefined);
    }

    const writeObservation = (
      invocationId: string,
      phase: 'prepared' | 'not_sent',
      overrides: Record<string, unknown> = {},
      profileKey = f.profileKey,
    ) => {
      const path = observationRecordPath(profileKey, invocationId);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({
        schema: 'state-light-turn-observation/v1', version: 1,
        invocation_id: invocationId, profile_key: profileKey,
        marker: 'fixture-marker-' + invocationId, phase,
        send_count: 0, send_witness: 'none', conversation_url: null,
        transitioned_at: '2026-01-01T00:00:00.000Z', transition_reason: 'admitted_before_send',
        ...overrides,
      }));
    };

    const newerSlots = newer.reviewRound!.sourceSlots.map((slot, index) => {
      const invocationId = '00002644-0000-4000-8000-00000000000' + (index + 1);
      const admitted = {
        ...slot, lifecycle: 'terminal' as const, invocationId, attemptOrdinal: 1,
        admissionStartedAtUtc: '2026-01-01T00:00:00.000Z',
        launchProfileKey: f.profileKey,
        launchCdpUrl: process.env.PACK_GPT_BROWSER_CDP,
      };
      if (index === 0) return {
        ...admitted,
        terminalClass: violation === 'optional_undefined_finding' ? 'complete_findings' : 'complete_clean',
        terminalResult: {
          schema: 'turn-result/v1', state: 'ok', scope: 'none',
          cause: 'github_source_comment_credentialed', invocation_id: invocationId,
          send_count: 1, source_comment_authority: 'credentialed_github',
          source_comment_receipt: posted.receipt,
        },
        payload: posted.payload,
      };
      const unsafe = index === 1;
      const attemptHistory = Array.from({ length: attemptCount - 1 }, (_, previousIndex) => {
        const previousId = '00002648-0000-4000-8000-0000000000' + (index + 1) + (previousIndex + 1);
        const firstUnsafe = unsafe && previousIndex === 0;
        if (!(firstUnsafe && violation === 'historical_observation_absent')) {
          writeObservation(previousId, 'prepared', {
            ...(firstUnsafe && violation === 'historical_send_attempted' ? { send_attempted: true } : {}),
            ...(firstUnsafe && violation === 'historical_send_count' ? { send_count: 1 } : {}),
            ...(firstUnsafe && violation === 'historical_owned_marker' ? { send_witness: 'owned_marker' } : {}),
            ...(firstUnsafe && violation === 'historical_dispatching' ? { phase: 'dispatching' } : {}),
          });
        }
        return {
          invocationId: previousId, attemptOrdinal: previousIndex + 1,
          terminalClass: firstUnsafe && violation === 'historical_other_class'
            ? 'driver_error:connect_over_cdp_failed'
            : 'rate_limit:account_cooldown_active',
        };
      });
      const currentProfile = unsafe && violation === 'historical_rotated_profile'
        ? f.profileKey + '-rotated' : f.profileKey;
      if (!(unsafe && violation === 'current_observation_absent')) {
        writeObservation(invocationId, 'not_sent', {}, currentProfile);
      }
      return {
        ...admitted,
        attemptOrdinal: attemptCount,
        launchProfileKey: currentProfile,
        ...(attemptHistory.length > 0 ? { attemptHistory } : {}),
        terminalClass: 'rate_limit:account_cooldown_active',
        terminalResult: {
          schema: 'turn-result/v1', state: 'rate_limit', cause: 'account_cooldown_active',
          scope: 'invocation', invocation_id: invocationId,
          send_count: 0, send_attempted: unsafe && violation === 'current_send_attempted',
          ...(unsafe && violation === 'current_possible_delivery'
            ? { diagnostics: { persisted_observation: { phase: 'dispatching', send_count: 0 } } } : {}),
        },
      };
    });
    if (violation === 'historical_posted_comment') {
      const sourceTwo = newerSlots[1] as PackReviewGptRoundRecord['sourceSlots'][number];
      const prior = sourceTwo.attemptHistory?.[0];
      if (!prior) throw new Error('fixture source-02 history missing');
      f.publish({ identity: {
        repository, prNumber, headSha: HEAD, runId: newer.id, slotId: 'source-02',
        invocationId: prior.invocationId,
      } });
    }
    updatePackReviewRun(newer.id, {
      status: 'failed', latestRunStatus: 'failed',
      failureReason: 'runner_disappeared_stale',
      completedAtUtc: new Date().toISOString(),
      runnerPid: 2147483647,
      heartbeatAtUtc: '2026-01-01T00:00:00.000Z',
      reviewRound: { ...newer.reviewRound!, sourceSlots: newerSlots },
    }, f.options);
    const savedPartial = getPackReviewRun(newer.id, f.options)!.reviewRound!.sourceSlots[0]!;
    if (violation === 'optional_undefined_finding') {
      // The run store JSON round trip keeps every completed slot, not undefined keys.
      expect(savedPartial.terminalClass).toBe('complete_findings');
      expect(savedPartial.payload?.findings[0]).not.toHaveProperty('filePath');
      expect(stableJson(posted.payload)).toBe(stableJson(savedPartial.payload));
    }
    const postedSourceOne = f.comments[0]!;
    const commentsBefore = [...f.comments];
    expect(listPackReviewRuns(f.options)).toHaveLength(2);
    expect(getPackReviewRun(f.original.id, f.options)).toMatchObject({
      status: 'failed', failureReason: 'gpt_source_non_complete:after_grace_zero_usable:0/3',
    });

    const reconciled = await f.reconcile({ immediate: true });
    const retry = reconciled.results.find((row) =>
      row.runId === newer.id && typeof row.nextAction === 'string'
      && row.nextAction.includes(exactCommand));
    if (shouldRetry) {
      expect(retry).toMatchObject({
        terminalized: false, statusReconciled: false,
        nextAction: 'retry only the missing sources in the original run now: ' + exactCommand,
      });
    } else {
      expect(retry).toBeUndefined();
    }
    // Reconciliation only provides the executable same-run action. It must
    // not resend source-01 or rewrite either original source census.
    expect(f.freshStarts).toEqual([]);
    expect(f.comments).toEqual(commentsBefore);
    expect(getPackReviewRun(newer.id, f.options)?.reviewRound?.sourceSlots[0])
      .toEqual(savedPartial);
    expect(getPackReviewRun(f.original.id, f.options)?.reviewRound?.sourceSlots)
      .toEqual(oldSlots);

    const result = await f.start();
    if (!shouldRetry) {
      expect(result.result).toMatchObject({
        created: false, runnerReason: 'gpt_rate_limit_partial_sources_unverified',
      });
      expect(f.freshStarts).toEqual([]);
      expect(f.comments).toEqual(commentsBefore);
      expect(f.reviews).toHaveLength(0);
      expect(getPackReviewRun(newer.id, f.options)?.reviewRound?.sourceSlots[0])
        .toEqual(savedPartial);
      expect(listPackReviewRuns(f.options)).toHaveLength(2);
      return;
    }
    expect(result.result, JSON.stringify(result.result)).toMatchObject({
      created: true, reused: false, runId: newer.id,
      headSha: HEAD, publicationVerified: true,
    });
    expect(f.freshStarts).toEqual(['source-02', 'source-03']);
    expect(f.comments).toHaveLength(3);
    expect(f.comments[0]).toEqual(postedSourceOne);
    expect(f.comments.filter((comment) => comment.body.includes(sourceOneId))).toHaveLength(1);
    expect(getPackReviewRun(newer.id, f.options)?.reviewRound?.sourceSlots[0])
      .toEqual(savedPartial);
    expect(f.reviews).toHaveLength(1);
    expect(readPackReviewAuthority(prNumber, { storeRoot: f.options.storeRoot })
      ?.cycle?.consumedRoundOrdinals).toEqual([1]);
    expect(listPackReviewRuns(f.options)).toHaveLength(2);
    expect(getPackReviewRun(f.original.id, f.options)?.reviewRound?.sourceSlots)
      .toEqual(oldSlots);
    expect(getPackReviewRun(f.original.id, f.options)?.reviewVerdict).toBeUndefined();
  });

  it('keeps the existing recovery path on unrelated non-rate-limit terminal failures', async () => {
    const f = fixture({ mutate: (slot) => ({
      ...slot,
      terminalClass: 'driver_error:connect_over_cdp_failed',
      terminalResult: {
        ...(slot.terminalResult as Record<string, unknown>), state: 'driver_error', cause: 'connect_over_cdp_failed',
      },
    }) });
    const result = await f.reconcile();
    const action = result.results.find((item) => item.runId === f.original.id && typeof item.nextAction === 'string')?.nextAction;
    expect(action).toBe(
      `node --experimental-strip-types scripts/pack-review-runner.ts reconcile --source-repo-root ${JSON.stringify(process.cwd())} --repo-slug ${repository} --pr-number ${prNumber}`,
    );
    const incumbent = await f.start();
    expect(incumbent.result).toMatchObject({
      created: false, reused: true, runnerReason: 'gpt_incumbent_owner_not_dead',
      runId: f.original.id,
    });
    expect(String(incumbent.result.nextAction)).toContain('observe the original runner PID and stale grace');
    expect(f.freshStarts).toEqual([]);
    expect(listPackReviewRuns(f.options)).toHaveLength(1);
  });
});
