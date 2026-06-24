import { describe, expect, it } from 'vitest';
import {
  TASK_CONTINUATION_ISSUE_NUMBER,
  TASK_CONTINUATION_PROJECT_ID,
  TASK_CONTINUATION_SESSION_ID,
  resolveIssueOwnerSessionForNudge,
  resolveWorkerTargetFromIssueClaim,
  syncIssueOwnershipClaimRecord,
} from './_test-worker-nudge-task-continuation.js';

describe('worker-nudge-issue-owner-bootstrap (#430)', () => {
  const projectId = TASK_CONTINUATION_PROJECT_ID;
  const issueNumber = TASK_CONTINUATION_ISSUE_NUMBER;
  const sessionId = TASK_CONTINUATION_SESSION_ID;

  it('binds exactly one live issue owner', () => {
    const owner = resolveIssueOwnerSessionForNudge({
      issueNumber,
      sessionId,
      projectId,
      sessions: [{ name: sessionId, role: 'worker', issue: '417', project: projectId, status: 'working' }],
    });
    expect(owner.ok).toBe(true);
    expect(owner.ownerSessionId).toBe(sessionId);

    const synced = syncIssueOwnershipClaimRecord({
      projectId,
      issueNumber,
      ownerSessionId: sessionId,
      existingClaim: null,
    });
    expect(synced.ok).toBe(true);
    expect(synced.reason).toBe('initialized');
    expect((synced.record as { generation?: string }).generation).toBeTruthy();

    const target = resolveWorkerTargetFromIssueClaim({
      issueNumber,
      sessionId,
      projectId,
      issueClaims: [synced.record],
    });
    expect(target.ok).toBe(true);
    expect(target.workerTarget).toContain(sessionId);
  });

  it('suppresses when zero live issue owners', () => {
    const owner = resolveIssueOwnerSessionForNudge({
      issueNumber,
      sessionId,
      projectId,
      sessions: [{ name: sessionId, role: 'worker', issue: '417', project: projectId, status: 'killed' }],
    });
    expect(owner.ok).toBe(false);
    expect(owner.reason).toBe('no_issue_owner');
  });

  it('suppresses ambiguous issue owners', () => {
    const owner = resolveIssueOwnerSessionForNudge({
      issueNumber,
      sessionId,
      projectId,
      sessions: [
        { name: 'opk-a', role: 'worker', issue: '417', project: projectId, status: 'working' },
        { name: 'opk-b', role: 'worker', issue: '417', project: projectId, status: 'working' },
      ],
    });
    expect(owner.ok).toBe(false);
    expect(owner.reason).toBe('ambiguous_issue_owner');
  });

  it('suppresses session id mismatch', () => {
    const owner = resolveIssueOwnerSessionForNudge({
      issueNumber,
      sessionId: 'opk-wrong',
      projectId,
      sessions: [{ name: sessionId, role: 'worker', issue: '417', project: projectId, status: 'working' }],
    });
    expect(owner.ok).toBe(false);
    expect(owner.reason).toBe('session_not_issue_owner');
  });

  it('concurrent bootstrap resolves to one owner binding', () => {
    const first = syncIssueOwnershipClaimRecord({
      projectId: 'orchestrator-pack',
      issueNumber: 418,
      ownerSessionId: 'opk-1',
      existingClaim: null,
      nowMs: 1,
    });
    const racing = syncIssueOwnershipClaimRecord({
      projectId: 'orchestrator-pack',
      issueNumber: 418,
      ownerSessionId: 'opk-2',
      existingClaim: first.record,
    });
    expect(racing.ok).toBe(false);
    expect(racing.reason).toBe('issue_owner_mismatch');
  });
});
