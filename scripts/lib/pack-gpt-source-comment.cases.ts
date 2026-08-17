import { describe, expect, it } from 'vitest';
import {
  formatPackGptSourceCommentEnvelope,
  formatPackGptSourceMarker,
  parsePackGptSourceCommentEnvelope,
  type PackGptSourceIdentity,
} from './pack-gpt-source-comment-contract.ts';
import {
  resolvePackGptSourceComment,
  type PackGptSourceCommentTransport,
  type PackGptSourceGithubComment,
} from './pack-gpt-source-comment.ts';

const identity: PackGptSourceIdentity = {
  repository: 'chetwerikoff/orchestrator-pack',
  prNumber: 1436,
  headSha: 'a'.repeat(40),
  runId: 'prr-source-test',
  slotId: 'source-01',
  invocationId: '11111111-1111-4111-8111-111111111111',
};

function comment(overrides: Partial<PackGptSourceGithubComment> = {}): PackGptSourceGithubComment {
  return {
    id: 1001,
    body: formatPackGptSourceCommentEnvelope(identity, 'NO_FINDINGS'),
    url: 'https://github.com/chetwerikoff/orchestrator-pack/pull/1436#issuecomment-1001',
    issueUrl: 'https://api.github.com/repos/chetwerikoff/orchestrator-pack/issues/1436',
    actorLogin: 'browser-gpt-bot',
    createdAt: '2026-08-17T00:00:00Z',
    updatedAt: '2026-08-17T00:00:00Z',
    ...overrides,
  };
}

function transport(options: {
  actorLogin?: string;
  comments?: PackGptSourceGithubComment[];
  reread?: PackGptSourceGithubComment;
  actorError?: Error;
  censusError?: Error;
  rereadError?: Error;
} = {}): PackGptSourceCommentTransport {
  const rows = options.comments ?? [comment()];
  return {
    resolveActorLogin: async () => {
      if (options.actorError) throw options.actorError;
      return options.actorLogin ?? 'browser-gpt-bot';
    },
    listComments: async () => {
      if (options.censusError) throw options.censusError;
      return rows;
    },
    getComment: async (id) => {
      if (options.rereadError) throw options.rereadError;
      return options.reread ?? rows.find((row) => row.id === id) ?? comment({ id });
    },
  };
}

describe('pack GPT source comment contract (Issue #1435)', () => {
  it('round-trips the exact versioned identity and payload envelope', () => {
    const body = formatPackGptSourceCommentEnvelope(identity, 'NO_FINDINGS');
    expect(body.split('\n')[0]).toBe(formatPackGptSourceMarker(identity));
    expect(parsePackGptSourceCommentEnvelope(body)).toEqual({ identity, payloadText: 'NO_FINDINGS' });
    expect(body).not.toContain('adapter-prompt');
    expect(body).not.toContain('/tmp/');
  });

  it('credentials exactly one unedited current-actor comment and records a receipt', async () => {
    const result = await resolvePackGptSourceComment({ identity, transport: transport() });
    expect(result.kind).toBe('credentialed');
    if (result.kind !== 'credentialed') return;
    expect(result.payload).toEqual({ verdict: 'clean', findingCount: 0, findings: [] });
    expect(result.receipt.commentId).toBe(1001);
    expect(result.receipt.actorLogin).toBe('browser-gpt-bot');
    expect(result.receipt.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('filters a foreign-principal marker copy before uniqueness', async () => {
    const foreign = comment({ id: 1002, actorLogin: 'foreign-user' });
    const result = await resolvePackGptSourceComment({
      identity,
      transport: transport({ comments: [foreign, comment()] }),
    });
    expect(result.kind).toBe('credentialed');
  });

  it('fails closed on an edited current-actor source comment', async () => {
    const edited = comment({ updatedAt: '2026-08-17T00:01:00Z' });
    const result = await resolvePackGptSourceComment({ identity, transport: transport({ comments: [edited] }) });
    expect(result).toEqual({ kind: 'conflict', reason: 'source_comment_edited' });
  });

  it('fails closed on duplicate exact-identity comments by the current actor', async () => {
    const result = await resolvePackGptSourceComment({
      identity,
      transport: transport({ comments: [comment({ id: 1001 }), comment({ id: 1002 })] }),
    });
    expect(result).toEqual({ kind: 'ambiguous', reason: 'source_comment_duplicate_exact_identity' });
  });

  it('fails closed when the selected comment changes between census and reread', async () => {
    const selected = comment();
    const result = await resolvePackGptSourceComment({
      identity,
      transport: transport({
        comments: [selected],
        reread: { ...selected, body: `${selected.body}\nchanged` },
      }),
    });
    expect(result).toEqual({ kind: 'conflict', reason: 'source_comment_changed_between_census_and_reread' });
  });

  it('fails closed when an exact-identity comment carries malformed reviewer payload', async () => {
    const malformed = comment({ body: formatPackGptSourceCommentEnvelope(identity, 'LGTM') });
    const result = await resolvePackGptSourceComment({
      identity,
      transport: transport({ comments: [malformed] }),
    });
    expect(result).toEqual({ kind: 'conflict', reason: 'source_comment_payload_malformed' });
  });

  it('distinguishes unresolved principal and census provenance from ordinary absence', async () => {
    await expect(resolvePackGptSourceComment({
      identity,
      transport: transport({ actorError: new Error('auth failed') }),
    })).resolves.toEqual({ kind: 'provenance_unresolved', reason: 'source_comment_actor_resolution_failed' });

    await expect(resolvePackGptSourceComment({
      identity,
      transport: transport({ censusError: new Error('census failed') }),
    })).resolves.toEqual({ kind: 'provenance_unresolved', reason: 'source_comment_census_failed' });
  });

  it('rejects comments that bind the exact marker to the wrong PR target', async () => {
    const wrongTarget = comment({
      issueUrl: 'https://api.github.com/repos/chetwerikoff/orchestrator-pack/issues/9999',
    });
    const result = await resolvePackGptSourceComment({
      identity,
      transport: transport({ comments: [wrongTarget] }),
    });
    expect(result).toEqual({ kind: 'conflict', reason: 'source_comment_wrong_target' });
  });
});
