import { describe, expect, it } from 'vitest';
import {
  createDirectPublicationObservationState,
  observeDirectPublicationPayload,
  settleDirectPublication,
} from './terminal-witness.ts';

const target = {
  repositoryFullName: 'chetwerikoff/orchestrator-pack',
  issueNumber: 1196,
  sourceRevision: 'r18',
  invocationId: '22222222-2222-4222-8222-222222222222',
} as const;

function comment(invocationId: string): string {
  return [
    'Read revision: #1196 r18',
    `INVOCATION_ID_TO_ECHO: ${invocationId}`,
    'VERDICT: APPROVE',
  ].join('\n');
}

function observePair(
  state: ReturnType<typeof createDirectPublicationObservationState>,
  toolCallId: string,
  parentUserMessageId: string,
  invocationId: string,
  commentId: string,
): void {
  observeDirectPublicationPayload(state, {
    action: 'add_comment_to_issue',
    tool_call_id: toolCallId,
    parent_user_message_id: parentUserMessageId,
    arguments: {
      repository: target.repositoryFullName,
      issue_number: target.issueNumber,
      comment: comment(invocationId),
    },
  });
  observeDirectPublicationPayload(state, {
    action: 'add_comment_to_issue',
    tool_call_id: toolCallId,
    parent_user_message_id: parentUserMessageId,
    repository: target.repositoryFullName,
    issue_number: target.issueNumber,
    response: {
      status: 201,
      comment_id: commentId,
      comment_url: `https://github.com/example/comment-${commentId}`,
    },
    success: true,
  });
}

describe('direct-publication production parent derivation', () => {
  it('derives the owned parent from the unique marker-owned invocation', () => {
    const state = createDirectPublicationObservationState();
    observePair(
      state,
      'call-foreign',
      'user-foreign',
      '11111111-1111-4111-8111-111111111111',
      '986',
    );
    observePair(
      state,
      'call-owned',
      'user-owned',
      target.invocationId,
      '987',
    );

    expect(settleDirectPublication(state, target)).toMatchObject({
      state: 'success',
      cause: 'direct_publication_success',
      invocation: {
        toolCallId: 'call-owned',
        parentUserMessageId: 'user-owned',
      },
      result: {
        toolCallId: 'call-owned',
        parentUserMessageId: 'user-owned',
        commentId: '987',
      },
    });
  });

  it('keeps an unpaired result on the derived owned parent ambiguous', () => {
    const state = createDirectPublicationObservationState();
    observePair(
      state,
      'call-owned',
      'user-owned',
      target.invocationId,
      '987',
    );
    observeDirectPublicationPayload(state, {
      action: 'add_comment_to_issue',
      tool_call_id: 'call-unpaired',
      parent_user_message_id: 'user-owned',
      repository: target.repositoryFullName,
      issue_number: target.issueNumber,
      response: {
        status: 201,
        comment_id: '988',
        comment_url: 'https://github.com/example/unpaired',
      },
      success: true,
    });

    expect(settleDirectPublication(state, target)).toMatchObject({
      state: 'possible-delivery',
      cause: 'direct_publication_result_ambiguous',
      invocation: { toolCallId: 'call-owned' },
    });
  });

  it('fails closed when the marker-owned invocation has no observable parent', () => {
    const state = createDirectPublicationObservationState();
    observeDirectPublicationPayload(state, {
      action: 'add_comment_to_issue',
      tool_call_id: 'call-owned',
      arguments: {
        repository: target.repositoryFullName,
        issue_number: target.issueNumber,
        comment: comment(target.invocationId),
      },
    });

    expect(settleDirectPublication(state, target)).toMatchObject({
      state: 'possible-delivery',
      cause: 'direct_publication_owned_parent_missing',
      invocation: { toolCallId: 'call-owned' },
    });
  });
});
