import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  reconcilePackReviewNoReview,
  type NoReviewReconciliationDependencies,
  type NoReviewReconciliationInput,
} from './pack-review-no-review-reconcile.ts';
import type {
  PackReviewGptRoundRecord,
  PackReviewRunRecord,
  PackReviewSourceSlotRecord,
} from './lib/pack-review-run-store.ts';
import type {
  PackGptSourceCommentTransport,
  PackGptSourceGithubComment,
} from './lib/pack-gpt-source-comment.ts';
import type { GithubReviewTransport } from './lib/github-review-reconciliation.ts';
import { formatPackGptSourceCommentEnvelope } from './lib/pack-gpt-source-comment-contract.ts';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const REPOSITORY = 'chetwerikoff/orchestrator-pack';
const PR = 1787;
const OWNER = 'chetwerikoff';
const INPUT: NoReviewReconciliationInput = {
  sourceRepoRoot: '/fixture/repo',
  repoSlug: REPOSITORY,
  prNumber: PR,
  headSha: HEAD,
  storeRoot: '/fixture/store',
};
const NOW = new Date('2026-08-28T12:00:00.000Z');

function emptySourceTransport(comments: PackGptSourceGithubComment[] = []): PackGptSourceCommentTransport {
  return {
    resolveActorLogin: async () => OWNER,
    listComments: async () => comments,
    getComment: async (id) => {
      const found = comments.find((comment) => String(comment.id) === String(id));
      if (!found) throw new Error('comment_missing');
      return found;
    },
  };
}

function emptyGithubTransport(): GithubReviewTransport {
  return {
    resolveActorLogin: async () => OWNER,
    listReviews: async () => [],
    postReview: async () => { throw new Error('write_forbidden'); },
    dismissReview: async () => { throw new Error('write_forbidden'); },
  };
}

function slot(
  ordinal: number,
  fields: Partial<PackReviewSourceSlotRecord> = {},
): PackReviewSourceSlotRecord {
  return {
    slotId: `source-0${ordinal}`,
    ordinal,
    lifecycle: 'planned',
    ...fields,
  };
}

function round(slots: PackReviewSourceSlotRecord[]): PackReviewGptRoundRecord {
  return {
    schema: 'pack-review-gpt-round/v1',
    reviewer: 'gpt',
    tier: 'T3',
    roundOrdinal: 1,
    cardinality: 3,
    issueNumber: 1787,
    boundIssueSnapshotDigest: 'fixture',
    sourceSlots: slots,
  };
}

function run(reviewRound: PackReviewGptRoundRecord): PackReviewRunRecord {
  return {
    schemaVersion: 1,
    id: 'prr-fixture',
    runId: 'prr-fixture',
    projectId: 'orchestrator-pack',
    key: `pr-${PR}-${HEAD}`,
    prNumber: PR,
    targetSha: HEAD,
    headSha: HEAD,
    status: 'reviewing',
    latestRunStatus: 'reviewing',
    linkedSessionId: '',
    startReason: 'fixture',
    surface: 'test',
    trustedPackRoot: '/fixture/pack',
    sourceRepoRoot: '/fixture/repo',
    canonicalRepository: REPOSITORY,
    automaticBudgetDisposition: 'consume',
    runnerPid: process.pid,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    heartbeatAtUtc: NOW.toISOString(),
    sameKeyOrder: 1,
    findings: [],
    deliveryOutcomes: {},
    reviewRound,
  } as PackReviewRunRecord;
}

function deps(overrides: Partial<NoReviewReconciliationDependencies> = {}): Partial<NoReviewReconciliationDependencies> {
  return {
    now: () => NOW,
    readCurrentHead: async () => HEAD,
    listRuns: () => [],
    resolveRunRepository: async (record) => ({
      ok: true as const,
      slug: record.canonicalRepository ?? REPOSITORY,
    }),
    sourceCommentTransport: () => emptySourceTransport(),
    githubReviewTransport: () => emptyGithubTransport(),
    probe: vi.fn(async () => { throw new Error('probe_should_not_run'); }),
    ...overrides,
  };
}

describe('pack-review no-review reconciliation', () => {
  it('does not create a missing run-store root while proving the no-local-run path inconclusive', async () => {
    const storeRoot = join(tmpdir(), `opk-no-review-missing-${process.pid}-${Date.now()}`);
    expect(existsSync(storeRoot)).toBe(false);
    const result = await reconcilePackReviewNoReview({
      ...INPUT,
      storeRoot,
    }, {
      now: () => NOW,
      readCurrentHead: async () => HEAD,
      resolveRunRepository: async (record) => ({
        ok: true as const,
        slug: record.canonicalRepository ?? REPOSITORY,
      }),
      sourceCommentTransport: () => emptySourceTransport(),
      githubReviewTransport: () => emptyGithubTransport(),
      probe: vi.fn(async () => { throw new Error('probe_should_not_run'); }),
    });

    expect(result.disposition).toBe('unavailable/inconclusive');
    expect(result.reason).toBe('run_store_census_not_exhaustive');
    expect(existsSync(storeRoot)).toBe(false);
  });

  it('fails closed when the inspected root has no matching local run', async () => {
    const result = await reconcilePackReviewNoReview(INPUT, deps());

    expect(result).toMatchObject({
      schema: 'pack-review-no-review-reconciliation/v1',
      repository: REPOSITORY,
      prNumber: PR,
      headSha: HEAD,
      disposition: 'unavailable/inconclusive',
      workflowAuthority: 'none',
      reason: 'run_store_census_not_exhaustive',
    });
    expect(result.operationalFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'run-selection',
        state: 'no-matching-local-run-in-inspected-root',
      }),
    ]));
  });

  it('short-circuits to review-present for any completed matching-run source', async () => {
    const probe = vi.fn(async () => { throw new Error('probe_should_not_run'); });
    const sourceFactory = vi.fn(() => { throw new Error('source_census_should_not_run'); });
    const completed = run(round([
      slot(1, {
        lifecycle: 'terminal',
        terminalClass: 'complete_clean',
        invocationId: '11111111-1111-4111-8111-111111111111',
        terminalResult: { state: 'ok', send_count: 1 },
        payload: { verdict: 'clean', findingCount: 0, findings: [] },
      }),
      slot(2),
      slot(3),
    ]));

    const result = await reconcilePackReviewNoReview(INPUT, deps({
      listRuns: () => [completed],
      sourceCommentTransport: sourceFactory,
      probe,
    }));

    expect(result.disposition).toBe('review-present');
    expect(result.reason).toBe('matching_run_has_completed_source');
    expect(sourceFactory).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it('checks every same-head matching run before selecting the latest zero-completed run', async () => {
    const older = run(round([
      slot(1, {
        lifecycle: 'terminal',
        terminalClass: 'complete_clean',
        invocationId: 'aaaaaaaa-1111-4111-8111-111111111111',
        terminalResult: { state: 'ok', send_count: 1 },
        payload: { verdict: 'clean', findingCount: 0, findings: [] },
      }),
      slot(2),
      slot(3),
    ]));
    older.id = 'prr-older-completed';
    older.runId = older.id;
    older.sameKeyOrder = 1;

    const newer = run(round([1, 2, 3].map((ordinal) => slot(ordinal, {
      lifecycle: 'terminal',
      invocationId: `bbbbbbbb-${String(ordinal).padStart(4, '0')}-4111-8111-111111111111`,
      terminalClass: 'explicit_refusal:zero_send_collision_exhausted',
      terminalResult: { state: 'profile_busy', cause: 'profile_busy', send_count: 0 },
    }))));
    newer.id = 'prr-newer-empty';
    newer.runId = newer.id;
    newer.sameKeyOrder = 2;

    const result = await reconcilePackReviewNoReview(INPUT, deps({
      listRuns: () => [older, newer],
    }));

    expect(result.disposition).toBe('review-present');
    expect(result.reason).toBe('matching_run_has_completed_source');
    expect(result.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'coverage', runId: older.id, completedSourceCount: 1 }),
    ]));
  });

  it('can prove no completed review for a matching run when every slot has immutable zero-send evidence', async () => {
    const started = run(round([1, 2, 3].map((ordinal) => slot(ordinal, {
      lifecycle: 'terminal',
      invocationId: `${ordinal}${ordinal}${ordinal}${ordinal}${ordinal}${ordinal}${ordinal}${ordinal}-1111-4111-8111-111111111111`,
      terminalClass: 'explicit_refusal:zero_send_collision_exhausted',
      terminalResult: { state: 'profile_busy', cause: 'profile_busy', send_count: 0 },
    }))));

    const result = await reconcilePackReviewNoReview(INPUT, deps({
      listRuns: () => [started],
    }));

    expect(result.disposition).toBe('no-completed-review');
    expect(result.reason).toBe('matching_run_all_incomplete_slots_closed_negative');
    expect(result.evidence.filter((entry) => entry.kind === 'slot-closure')).toHaveLength(3);
    expect(result.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'github-review-census', census: 'final', state: 'absent' }),
    ]));
  });

  it('does not treat a bare planned slot as authoritative proof that no send occurred', async () => {
    const started = run(round([
      slot(1, {
        lifecycle: 'terminal',
        invocationId: '11111111-1111-4111-8111-111111111111',
        terminalClass: 'explicit_refusal:zero_send_collision_exhausted',
        terminalResult: { state: 'profile_busy', cause: 'profile_busy', send_count: 0 },
      }),
      slot(2),
      slot(3),
    ]));

    const result = await reconcilePackReviewNoReview(INPUT, deps({
      listRuns: () => [started],
    }));

    expect(result.disposition).toBe('unavailable/inconclusive');
    expect(result.reason).toBe('possible_delivery_invocation_unbound');
  });

  it('treats an exact-head marker-first source comment as review-present with no local run', async () => {
    const identity = {
      repository: REPOSITORY,
      prNumber: PR,
      headSha: HEAD,
      runId: 'prr-discovered',
      slotId: 'source-02',
      invocationId: '22222222-2222-4222-8222-222222222222',
    };
    const body = formatPackGptSourceCommentEnvelope(identity, 'NO_FINDINGS');
    const comment: PackGptSourceGithubComment = {
      id: 77,
      body,
      url: `https://github.com/${REPOSITORY}/issues/${PR}#issuecomment-77`,
      issueUrl: `https://api.github.com/repos/${REPOSITORY}/issues/${PR}`,
      actorLogin: OWNER,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    const githubFactory = vi.fn(() => { throw new Error('github_census_should_not_run'); });

    const result = await reconcilePackReviewNoReview(INPUT, deps({
      sourceCommentTransport: () => emptySourceTransport([comment]),
      githubReviewTransport: githubFactory,
    }));

    expect(result.disposition).toBe('review-present');
    expect(result.reason).toBe('exact_head_source_comment_present');
    expect(githubFactory).not.toHaveBeenCalled();
  });

  it('treats multiple distinct exact-head source identities as review-present rather than duplicate ambiguity', async () => {
    const comments: PackGptSourceGithubComment[] = [1, 2].map((ordinal) => {
      const identity = {
        repository: REPOSITORY,
        prNumber: PR,
        headSha: HEAD,
        runId: `prr-discovered-${ordinal}`,
        slotId: `source-0${ordinal}`,
        invocationId: `${ordinal}${ordinal}${ordinal}${ordinal}${ordinal}${ordinal}${ordinal}${ordinal}-1111-4111-8111-111111111111`,
      };
      const body = formatPackGptSourceCommentEnvelope(identity, 'NO_FINDINGS');
      return {
        id: 80 + ordinal,
        body,
        url: `https://github.com/${REPOSITORY}/issues/${PR}#issuecomment-${80 + ordinal}`,
        issueUrl: `https://api.github.com/repos/${REPOSITORY}/issues/${PR}`,
        actorLogin: OWNER,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      };
    });

    const result = await reconcilePackReviewNoReview(INPUT, deps({
      sourceCommentTransport: () => emptySourceTransport(comments),
    }));

    expect(result.disposition).toBe('review-present');
    expect(result.reason).toBe('exact_head_source_comment_present');
  });

  it('re-censuses source comments after slot closure before emitting a negative receipt', async () => {
    const started = run(round([1, 2, 3].map((ordinal) => slot(ordinal, {
      lifecycle: 'terminal',
      invocationId: `cccccccc-${String(ordinal).padStart(4, '0')}-4111-8111-111111111111`,
      terminalClass: 'explicit_refusal:zero_send_collision_exhausted',
      terminalResult: { state: 'profile_busy', cause: 'profile_busy', send_count: 0 },
    }))));
    const identity = {
      repository: REPOSITORY,
      prNumber: PR,
      headSha: HEAD,
      runId: started.id,
      slotId: 'source-01',
      invocationId: started.reviewRound!.sourceSlots[0]!.invocationId!,
    };
    const body = formatPackGptSourceCommentEnvelope(identity, 'NO_FINDINGS');
    const comment: PackGptSourceGithubComment = {
      id: 901,
      body,
      url: `https://github.com/${REPOSITORY}/issues/${PR}#issuecomment-901`,
      issueUrl: `https://api.github.com/repos/${REPOSITORY}/issues/${PR}`,
      actorLogin: OWNER,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    let listCalls = 0;
    const sourceTransport: PackGptSourceCommentTransport = {
      resolveActorLogin: async () => OWNER,
      listComments: async () => (++listCalls >= 4 ? [comment] : []),
      getComment: async () => comment,
    };

    const result = await reconcilePackReviewNoReview(INPUT, deps({
      listRuns: () => [started],
      sourceCommentTransport: () => sourceTransport,
    }));

    expect(result.disposition).toBe('review-present');
    expect(result.reason).toBe('matching_run_source_comment_present');
    expect(listCalls).toBeGreaterThanOrEqual(4);
    expect(result.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'source-comment', census: 'final', state: 'credentialed' }),
    ]));
  });

  it('re-censuses direct GitHub reviews after slot closure before emitting a negative receipt', async () => {
    const started = run(round([1, 2, 3].map((ordinal) => slot(ordinal, {
      lifecycle: 'terminal',
      invocationId: `dddddddd-${String(ordinal).padStart(4, '0')}-4111-8111-111111111111`,
      terminalClass: 'explicit_refusal:zero_send_collision_exhausted',
      terminalResult: { state: 'profile_busy', cause: 'profile_busy', send_count: 0 },
    }))));
    let reviewCalls = 0;
    const lateReview = {
      id: 902,
      body: `<!-- opk-pack-review:v1 head=${HEAD} verdict=clean blocking=false -->`,
      commitId: HEAD,
      url: `https://github.com/${REPOSITORY}/pull/${PR}#pullrequestreview-902`,
      state: 'COMMENTED' as const,
      userLogin: OWNER,
      submittedAt: NOW.toISOString(),
    };
    const githubTransport: GithubReviewTransport = {
      resolveActorLogin: async () => OWNER,
      listReviews: async () => (++reviewCalls >= 2 ? [lateReview] : []),
      postReview: async () => { throw new Error('write_forbidden'); },
      dismissReview: async () => { throw new Error('write_forbidden'); },
    };

    const result = await reconcilePackReviewNoReview(INPUT, deps({
      listRuns: () => [started],
      githubReviewTransport: () => githubTransport,
    }));

    expect(result.disposition).toBe('review-present');
    expect(result.reason).toBe('canonical_exact_head_github_review_present');
    expect(reviewCalls).toBe(2);
    expect(result.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'github-review-census', census: 'final', state: 'present' }),
    ]));
  });

  it('fails closed when live PR head no longer equals the receipt binding', async () => {
    const listRuns = vi.fn(() => []);
    const result = await reconcilePackReviewNoReview(INPUT, deps({
      readCurrentHead: async () => OTHER_HEAD,
      listRuns,
    }));

    expect(result.disposition).toBe('unavailable/inconclusive');
    expect(result.reason).toBe('receipt_head_is_stale');
    expect(listRuns).not.toHaveBeenCalled();
  });

  it('accepts an exact owned-turn assistant export even before a retained primary exists', async () => {
    const invocationId = '55555555-5555-4555-8555-555555555555';
    const marker = 'OPKTURNV1-owned-unharvested';
    const assistantText = 'NO_FINDINGS';
    const assistantBytes = Buffer.from(assistantText, 'utf8');
    const assistantSha = createHash('sha256').update(assistantBytes).digest('hex');
    const possible = run(round([
      slot(1, {
        lifecycle: 'terminal',
        invocationId,
        terminalClass: 'possible_delivery',
        terminalResult: {
          state: 'driver_error',
          cause: 'browser_lost',
          send_count: 1,
          configured_profile_key: 'profile-fixture',
        },
        launchProfileKey: 'profile-fixture',
        launchCdpUrl: 'http://127.0.0.1:9222',
      }),
      slot(2),
      slot(3),
    ]));
    const probe = vi.fn(async (args: any) => {
      if (args.operation === 'inspect') {
        return {
          status: 'ok',
          target_id: 'target-2',
          snapshot: {
            generation_in_progress: false,
            nodes_truncated: false,
            nodes: [
              {
                role: 'user',
                ordinal: 0,
                document_ordinal: 0,
                message_id: 'user-2',
                message_id_unique: true,
                attributes: {},
                innerText: {
                  byte_length: Buffer.byteLength(marker),
                  code_point_length: marker.length,
                  sha256: createHash('sha256').update(marker).digest('hex'),
                  head: marker,
                  tail: marker,
                },
                textContent: {
                  byte_length: Buffer.byteLength(marker),
                  code_point_length: marker.length,
                  sha256: createHash('sha256').update(marker).digest('hex'),
                  head: marker,
                  tail: marker,
                },
              },
              {
                role: 'assistant',
                ordinal: 0,
                document_ordinal: 1,
                message_id: 'assistant-2',
                message_id_unique: true,
                attributes: {},
                innerText: {
                  byte_length: assistantBytes.byteLength,
                  code_point_length: assistantText.length,
                  sha256: assistantSha,
                  head: assistantText,
                  tail: assistantText,
                },
                textContent: {
                  byte_length: assistantBytes.byteLength,
                  code_point_length: assistantText.length,
                  sha256: assistantSha,
                  head: assistantText,
                  tail: assistantText,
                },
              },
            ],
          },
        };
      }
      if (args.operation === 'export') {
        writeFileSync(args.output, assistantBytes);
        return { status: 'ok' };
      }
      throw new Error('unexpected_probe_operation');
    });

    const result = await reconcilePackReviewNoReview(INPUT, deps({
      listRuns: () => [possible],
      readObservation: () => ({
        schema: 'state-light-turn-observation/v1',
        version: 1,
        invocation_id: invocationId,
        profile_key: 'profile-fixture',
        marker,
        phase: 'sent_unharvested',
        send_count: 1,
        send_witness: 'numeric_send_count',
        conversation_url: 'https://chatgpt.com/c/fixture-unharvested',
        primary: null,
        transitioned_at: NOW.toISOString(),
        transition_reason: 'fixture',
      } as any),
      probe,
    }));

    expect(result.disposition).toBe('review-present');
    expect(result.reason).toBe('owned_turn_assistant_result_present');
    expect(result.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ primaryBound: false, assistantSha256: assistantSha }),
    ]));
  });

  it('turns an exact owned-turn assistant byte witness into review-present', async () => {
    const invocationId = '33333333-3333-4333-8333-333333333333';
    const marker = 'OPKTURNV1-owned-marker';
    const assistantText = 'NO_FINDINGS';
    const assistantBytes = Buffer.from(assistantText, 'utf8');
    const assistantSha = createHash('sha256').update(assistantBytes).digest('hex');
    const possible = run(round([
      slot(1, {
        lifecycle: 'terminal',
        invocationId,
        terminalClass: 'harvest_failed',
        terminalResult: {
          state: 'ok',
          cause: 'completed_page_only',
          send_count: 1,
          configured_profile_key: 'profile-fixture',
        },
        launchProfileKey: 'profile-fixture',
        launchCdpUrl: 'http://127.0.0.1:9222',
      }),
      slot(2),
      slot(3),
    ]));
    const probe = vi.fn(async (args: any) => {
      if (args.operation === 'inspect') {
        return {
          schema: 'browser-gpt-page-probe/v1',
          operation: 'inspect',
          status: 'ok',
          diagnostic_only: true,
          workflow_authority: 'none',
          target_id: 'target-1',
          snapshot: {
            page_url: 'https://chatgpt.com/c/fixture',
            ready_state: 'complete',
            title: 'fixture',
            generation_in_progress: false,
            observed_user_nodes: 1,
            observed_assistant_nodes: 1,
            observed_message_nodes: 2,
            nodes_truncated: false,
            last_assistant_text_length: assistantText.length,
            last_assistant_text_byte_length: assistantBytes.byteLength,
            last_assistant_text_head: assistantText,
            last_assistant_sha256: assistantSha,
            nodes: [
              {
                role: 'user',
                ordinal: 0,
                document_ordinal: 0,
                message_id: 'user-1',
                message_id_unique: true,
                attributes: {},
                innerText: {
                  byte_length: Buffer.byteLength(marker),
                  code_point_length: marker.length,
                  sha256: createHash('sha256').update(marker).digest('hex'),
                  head: marker,
                  tail: marker,
                },
                textContent: {
                  byte_length: Buffer.byteLength(marker),
                  code_point_length: marker.length,
                  sha256: createHash('sha256').update(marker).digest('hex'),
                  head: marker,
                  tail: marker,
                },
              },
              {
                role: 'assistant',
                ordinal: 0,
                document_ordinal: 1,
                message_id: 'assistant-1',
                message_id_unique: true,
                attributes: {},
                innerText: {
                  byte_length: assistantBytes.byteLength,
                  code_point_length: assistantText.length,
                  sha256: assistantSha,
                  head: assistantText,
                  tail: assistantText,
                },
                textContent: {
                  byte_length: assistantBytes.byteLength,
                  code_point_length: assistantText.length,
                  sha256: assistantSha,
                  head: assistantText,
                  tail: assistantText,
                },
              },
            ],
          },
        };
      }
      if (args.operation === 'export') {
        writeFileSync(args.output, assistantBytes);
        return {
          schema: 'browser-gpt-page-probe/v1',
          operation: 'export',
          status: 'ok',
          diagnostic_only: true,
          workflow_authority: 'none',
          byte_length: assistantBytes.byteLength,
          sha256: assistantSha,
        };
      }
      throw new Error('unexpected_probe_operation');
    });

    const result = await reconcilePackReviewNoReview(INPUT, deps({
      listRuns: () => [possible],
      readObservation: () => ({
        schema: 'state-light-turn-observation/v1',
        version: 1,
        invocation_id: invocationId,
        profile_key: 'profile-fixture',
        marker,
        phase: 'harvested',
        send_count: 1,
        send_witness: 'numeric_send_count',
        conversation_url: 'https://chatgpt.com/c/fixture',
        primary: {
          target: '/fixture/store/logs/gpt-evidence/prr-fixture/source-01/terminal-reply.txt',
          byte_length: assistantBytes.byteLength,
          sha256: assistantSha,
        },
        transitioned_at: NOW.toISOString(),
        transition_reason: 'fixture',
      } as any),
      probe,
    }));

    expect(result.disposition).toBe('contradiction');
    expect(result.reason).toBe('owned_turn_harvested_contradicts_zero_completed_run');
    expect(probe).not.toHaveBeenCalled();
  });
});
