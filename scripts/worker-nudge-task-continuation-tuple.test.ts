import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './_test-pwsh-helpers.js';
import {
  buildIssueTupleKey,
  buildTupleKey,
  evaluateBoundary,
  evaluateNudgeGate,
  findForbiddenAutonomousWorkerSendInvocations,
  normalizeIssueNumber,
  resolveIssueOwnerSessionForNudge,
  resolveWorkerTargetFromIssueClaim,
  syncIssueOwnershipClaimRecord,
} from '../docs/worker-nudge-gate.mjs';

describe('worker-nudge-task-continuation-tuple (#430)', () => {
  const projectId = 'orchestrator-pack';
  const issueNumber = 417;
  const sessionId = 'opk-430';
  const generation = 'a1b2c3d4e5f6';

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
