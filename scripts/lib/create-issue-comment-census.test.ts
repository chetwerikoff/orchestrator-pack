import { describe, expect, it } from 'vitest';
import {
  createCommentCensus,
  publishAfterCensus,
  readTargetedComment,
} from './create-issue-comment-census.ts';
import type { GhTransport } from './create-issue-stage-record-types.ts';

function comment(id: number, body: string) {
  return JSON.stringify({
    id,
    body,
    created_at: '2026-08-02T00:00:00Z',
    updated_at: '2026-08-02T00:00:00Z',
    user: { login: 'chetwerikoff' },
    author_association: 'OWNER',
  });
}

describe('bounded comment census and targeted confirmation', () => {
  it('uses one immutable census and one exact returned-ID read', () => {
    const calls: string[] = [];
    const transport: GhTransport = {
      runGh(argv) {
        calls.push(argv.join(' '));
        if (argv.includes('-f') && argv.some((item) => item === 'body=new body')) return { exitCode: 0, stdout: JSON.stringify({ id: 42 }), stderr: '' };
        if (argv.some((item) => item.includes('repos/chetwerikoff/orchestrator-pack'))) {
          const path = argv.find((item) => item.includes('repos/'));
          if (path?.endsWith('/issues/comments/42')) return { exitCode: 0, stdout: comment(42, 'new body'), stderr: '' };
          if (path?.includes('/issues/1200/comments')) return { exitCode: 0, stdout: '[]', stderr: '' };
        }
        if (argv.includes('--jq') && argv.includes('.owner.login')) return { exitCode: 0, stdout: 'chetwerikoff\n', stderr: '' };
        return { exitCode: 0, stdout: '[]', stderr: '' };
      },
    };
    const snapshot = createCommentCensus(transport, 'chetwerikoff/orchestrator-pack', 1200, { pageSize: 10, maxPages: 2 });
    expect(snapshot.complete).toBe(true);
    const result = publishAfterCensus(transport, 'chetwerikoff/orchestrator-pack', 1200, snapshot, 'new body');
    expect(result.state).toBe('published');
    expect(result.targetedRead?.exactBody).toBe(true);
    expect(calls.filter((call) => call.includes('/comments?')).length).toBe(1);
    expect(calls.filter((call) => call.includes('/issues/comments/42')).length).toBe(1);
  });

  it('keeps a mismatched targeted body pending', () => {
    const transport: GhTransport = {
      runGh(argv) {
        if (argv.some((item) => item.includes('/issues/comments/9'))) return { exitCode: 0, stdout: comment(9, 'different'), stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    expect(readTargetedComment(transport, 'chetwerikoff/orchestrator-pack', 9, 'expected').reason).toBe('body-mismatch');
  });
});

