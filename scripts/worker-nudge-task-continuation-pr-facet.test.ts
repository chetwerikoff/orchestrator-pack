import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TASK_CONTINUATION_GENERATION,
  TASK_CONTINUATION_ISSUE_NUMBER,
  TASK_CONTINUATION_PR_NUMBER,
  TASK_CONTINUATION_PROJECT_ID,
  TASK_CONTINUATION_SESSION_ID,
  buildIssueTupleKey,
  evaluateNudgeGate,
  normalizeIssueNumber,
  repoRoot,
} from './_test-worker-nudge-task-continuation.js';

describe('worker-nudge-task-continuation-pr-facet (#430)', () => {
  const projectId = TASK_CONTINUATION_PROJECT_ID;
  const issueNumber = TASK_CONTINUATION_ISSUE_NUMBER;
  const prNumber = TASK_CONTINUATION_PR_NUMBER;
  const sessionId = TASK_CONTINUATION_SESSION_ID;
  const generation = 'facetgen001';

  it('retains issue on post-PR capture fixture', () => {
    const capture = JSON.parse(
      readFileSync(
        path.join(
          repoRoot,
          'tests/external-output-references/captures/ao-status-session/issue-with-pr-facet.raw.json',
        ),
        'utf8',
      ),
    );
    expect(normalizeIssueNumber(capture.issue)).toBe(417);
    expect(Number(capture.prNumber)).toBe(427);
  });

  it('suppresses redelivery after prNumber appears on the same issue-keyed tuple', () => {
    const tuple = buildIssueTupleKey({
      intentClass: 'task-continuation',
      projectId,
      issueNumber,
      sessionId,
      targetId: sessionId,
      targetGeneration: generation,
    });
    const gate = evaluateNudgeGate({
      intentClass: 'task-continuation',
      projectId,
      issueNumber,
      prNumber,
      sessionId,
      targetId: sessionId,
      targetGeneration: generation,
      surface: 'orchestrator-turn',
      storePath: '/tmp/unused',
      claims: [{ tupleKey: tuple.tupleKey, phase: 'SENT', intentClass: 'task-continuation' }],
    });
    expect(gate.allow).toBe(false);
    expect(gate.reason).toBe('already_served');
    const resolvedTuple = gate.tuple as { issueKeyed?: boolean; tupleKey?: string };
    expect(resolvedTuple.issueKeyed).toBe(true);
    expect(resolvedTuple.tupleKey).not.toContain(`|${prNumber}|`);
  });
});
