import { describe, expect, it } from 'vitest';
import {
  createDirectPublicationObservationState,
  directPublicationReceipt,
  observeDirectPublicationPayload,
  parseCanonicalSourceRevision,
  parseReviewerSourceIdentity,
  reviewerSourceMetadata,
  settleDirectPublication,
  validateDirectPublicationInputs,
} from './terminal-witness.ts';

const target = {
  repositoryFullName: 'chetwerikoff/orchestrator-pack',
  issueNumber: 1196,
  sourceRevision: 'r18',
  invocationId: '550e8400-e29b-41d4-a716-446655440000',
} as const;

const successComment = [
  'Read revision: #1196 r18',
  'VERDICT: APPROVE',
  '',
  'id: F-001',
  'Finding: example',
].join('\n');

function observeSuccess() {
  const state = createDirectPublicationObservationState();
  observeDirectPublicationPayload(state, {
    type: 'tool_call',
    action: 'add_comment_to_issue',
    tool_call_id: 'call-01',
    assistant_message_id: 'assistant-01',
    parent_user_message_id: 'user-01',
    arguments: {
      repository: target.repositoryFullName,
      issue_number: target.issueNumber,
      comment: successComment,
    },
  });
  observeDirectPublicationPayload(state, {
    type: 'tool_result',
    action: 'add_comment_to_issue',
    tool_call_id: 'call-01',
    repository: target.repositoryFullName,
    issue_number: target.issueNumber,
    response: {
      status: 201,
      comment_id: '987',
      comment_url: 'https://github.com/chetwerikoff/orchestrator-pack/issues/1196#issuecomment-987',
    },
    success: true,
  });
  return state;
}

describe('direct-publication terminal matrix', () => {
  it('captures exact decoded comment bytes and emits the five-line receipt', () => {
    const settlement = settleDirectPublication(observeSuccess(), target);
    expect(settlement.state).toBe('success');
    expect(settlement.sourceBytes).toBe(successComment);

    const metadata = reviewerSourceMetadata(settlement, target);
    expect(metadata?.kind).toBe('service-observed-issue-comment/v1');
    expect(metadata?.byte_length).toBe(Buffer.byteLength(successComment));
    expect(metadata?.comment_id).toBe('987');
    expect(metadata?.finding_count).toBe(1);
    expect(directPublicationReceipt(settlement, target)).toBe([
      'VERDICT: APPROVE',
      'COMMENT_URL: https://github.com/chetwerikoff/orchestrator-pack/issues/1196#issuecomment-987',
      'REVISION: r18',
      `INVOCATION_ID: ${target.invocationId}`,
      'FINDING_COUNT: 1',
    ].join('\n'));
  });

  it.each([401, 403, 404, 410, 422])('accepts only definitive GitHub rejection %s as no-commit', (status) => {
    const state = createDirectPublicationObservationState();
    observeDirectPublicationPayload(state, {
      action: 'add_comment_to_issue',
      tool_call_id: `call-${status}`,
      arguments: {
        repository: target.repositoryFullName,
        issue_number: target.issueNumber,
        comment: successComment,
      },
    });
    observeDirectPublicationPayload(state, {
      action: 'add_comment_to_issue',
      tool_call_id: `call-${status}`,
      repository: target.repositoryFullName,
      issue_number: target.issueNumber,
      response_complete: true,
      response: { status },
    });
    const finalAssistant = `${successComment}\nFull fallback findings`;
    const settlement = settleDirectPublication(state, target, finalAssistant);
    expect(settlement.state).toBe('failed-write');
    expect(settlement.result?.noCommitClass).toBe('github-create-comment-definitive-rejection');
    expect(reviewerSourceMetadata(settlement, target)?.kind).toBe('failed-write-final-assistant/v1');
    expect(reviewerSourceMetadata(settlement, target)?.comment_url).toBeUndefined();
  });

  it('accepts adapter no-dispatch and rejects timeout or ambiguous results', () => {
    const noDispatch = createDirectPublicationObservationState();
    observeDirectPublicationPayload(noDispatch, {
      action: 'add_comment_to_issue',
      tool_call_id: 'call-adapter',
      arguments: {
        repository: target.repositoryFullName,
        issue_number: target.issueNumber,
        comment: successComment,
      },
    });
    observeDirectPublicationPayload(noDispatch, {
      action: 'add_comment_to_issue',
      tool_call_id: 'call-adapter',
      repository: target.repositoryFullName,
      issue_number: target.issueNumber,
      no_external_request: true,
    });
    expect(settleDirectPublication(noDispatch, target, successComment).state).toBe('failed-write');

    const timeout = observeSuccess();
    observeDirectPublicationPayload(timeout, {
      action: 'add_comment_to_issue',
      tool_call_id: 'call-01',
      repository: target.repositoryFullName,
      issue_number: target.issueNumber,
      error: 'timeout',
    });
    expect(settleDirectPublication(timeout, target).state).toBe('possible-delivery');

    const ambiguous = observeSuccess();
    observeDirectPublicationPayload(ambiguous, {
      action: 'add_comment_to_issue',
      tool_call_id: 'call-01',
      repository: target.repositoryFullName,
      issue_number: target.issueNumber,
      response_complete: true,
      response: { status: 503 },
    });
    expect(settleDirectPublication(ambiguous, target).state).toBe('possible-delivery');
  });
});

describe('direct-publication input and source bindings', () => {
  it('requires one caller-minted UUID echo and a complete policy identity', () => {
    expect(parseReviewerSourceIdentity('slot-01#capture=direct-publication/v1')?.policy)
      .toBe('direct-publication/v1');
    expect(parseReviewerSourceIdentity('slot-01#capture=service-observed-issue-comment/v1')).toBeNull();
    expect(validateDirectPublicationInputs({
      invocationId: target.invocationId,
      prompt: `INVOCATION_ID_TO_ECHO: ${target.invocationId}`,
      reviewerSource: 'slot-01#capture=direct-publication/v1',
      repositoryFullName: target.repositoryFullName,
      issueNumber: target.issueNumber,
      sourceRevision: target.sourceRevision,
    })).toBeNull();
    expect(validateDirectPublicationInputs({
      invocationId: target.invocationId,
      prompt: `INVOCATION_ID_TO_ECHO: ${target.invocationId}\nINVOCATION_ID_TO_ECHO: ${target.invocationId}`,
      reviewerSource: 'slot-01#capture=direct-publication/v1',
      repositoryFullName: target.repositoryFullName,
      issueNumber: target.issueNumber,
      sourceRevision: target.sourceRevision,
    })).toBe('invocation_id_prompt_mismatch');
  });

  it('requires exactly one leading issue/revision declaration', () => {
    expect(parseCanonicalSourceRevision(successComment, target)).toEqual({
      issueNumber: 1196,
      sourceRevision: 'r18',
      findingCount: 1,
    });
    expect(parseCanonicalSourceRevision(
      `${successComment}\nRead revision: #1196 r18`,
      target,
    )).toBeNull();
    expect(parseCanonicalSourceRevision(
      successComment.replace('#1196 r18', '#1195 r18'),
      target,
    )).toBeNull();
  });
});
