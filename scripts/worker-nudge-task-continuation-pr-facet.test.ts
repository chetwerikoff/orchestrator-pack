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

describe('worker-nudge-task-continuation-pr-facet (#430)', () => {
  const projectId = 'orchestrator-pack';
  const issueNumber = 417;
  const prNumber = 427;
  const sessionId = 'opk-430';
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
    expect(gate.tuple?.issueKeyed).toBe(true);
    expect(gate.tuple?.tupleKey).not.toContain(`|${prNumber}|`);
  });
});
