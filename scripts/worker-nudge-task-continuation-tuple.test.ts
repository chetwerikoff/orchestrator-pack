import { describe, expect, it } from 'vitest';
import {
  TASK_CONTINUATION_GENERATION,
  TASK_CONTINUATION_ISSUE_NUMBER,
  TASK_CONTINUATION_PROJECT_ID,
  TASK_CONTINUATION_SESSION_ID,
  buildIssueTupleKey,
  buildTupleKey,
  evaluateNudgeGate,
} from './_test-worker-nudge-task-continuation.js';

describe('worker-nudge-task-continuation-tuple (#430)', () => {
  const projectId = TASK_CONTINUATION_PROJECT_ID;
  const issueNumber = TASK_CONTINUATION_ISSUE_NUMBER;
  const sessionId = TASK_CONTINUATION_SESSION_ID;
  const generation = TASK_CONTINUATION_GENERATION;

  it('forms a complete issue-keyed tuple without prNumber as dedup anchor', () => {
    const tuple = buildIssueTupleKey({
      intentClass: 'task-continuation',
      projectId,
      issueNumber,
      sessionId,
      targetId: sessionId,
      targetGeneration: generation,
    });
    expect(tuple.ok).toBe(true);
    expect(tuple.issueKeyed).toBe(true);
    expect(tuple.intentClass).toBe('task-continuation');
    expect(tuple.cycleKey).toBe(`task-gen:${generation}`);
    expect(tuple.tupleKey).toBe(
      `${projectId}|${issueNumber}|task-gen:${generation}|task-continuation|${sessionId}:${generation}`,
    );
    expect(tuple.tupleKey).not.toMatch(/^\d+\|/);
    expect(String(tuple.tupleKey)).not.toContain('|427|');
  });

  it('routes buildTupleKey to the issue-keyed branch for task-continuation', () => {
    const tuple = buildTupleKey({
      intentClass: 'task-continuation',
      projectId,
      issueNumber,
      sessionId,
      targetId: sessionId,
      targetGeneration: generation,
      prNumber: 427,
    });
    expect(tuple.ok).toBe(true);
    expect(tuple.issueKeyed).toBe(true);
    expect(tuple.tupleKey).toContain(`|${issueNumber}|`);
    expect(tuple.tupleKey).not.toContain('|427|');
  });

  it('allows first issue-keyed send and suppresses duplicate tuple', () => {
    const tuple = buildIssueTupleKey({
      intentClass: 'task-continuation',
      projectId,
      issueNumber,
      sessionId,
      targetId: sessionId,
      targetGeneration: generation,
      message: 'commit, rebase, open PR, report when ready',
    });
    const first = evaluateNudgeGate({
      intentClass: 'task-continuation',
      projectId,
      issueNumber,
      sessionId,
      targetId: sessionId,
      targetGeneration: generation,
      surface: 'orchestrator-turn',
      storePath: '/tmp/unused',
      claims: [],
    });
    expect(first.allow).toBe(true);
    const second = evaluateNudgeGate({
      intentClass: 'task-continuation',
      projectId,
      issueNumber,
      sessionId,
      targetId: sessionId,
      targetGeneration: generation,
      surface: 'orchestrator-turn',
      storePath: '/tmp/unused',
      claims: [{ tupleKey: tuple.tupleKey, phase: 'SENT', intentClass: 'task-continuation' }],
    });
    expect(second.allow).toBe(false);
    expect(second.reason).toBe('already_served');
  });
});
