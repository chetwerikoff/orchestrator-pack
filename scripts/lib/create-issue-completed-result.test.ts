import { describe, expect, it } from 'vitest';
import {
  commitCompletedResult,
  constructPublicationEvent,
  harvestExistingTurn,
  recoverCompletedTurn,
  type CompletedTurn,
} from './create-issue-completed-result.ts';
import { buildTopology } from './create-issue-stage-topology.ts';

const topology = buildTopology({
  issueNumber: 1200,
  cycleId: 'cycle',
  sourceRevision: 'r15',
  stage: 'architectural',
  stageAttemptId: 'attempt',
  policyVersion: 'single-source/v1',
}, 'T2', 1, 'env:OPK_GPT_REVIEWER_CARDINALITY');

const turn: CompletedTurn = {
  turnIdentity: 'turn-1',
  stageAttemptId: 'attempt',
  slot: '01',
  rawOutput: 'exact\r\nraw\0 output',
  terminal: true,
};

describe('completed reviewer turn recovery', () => {
  it('harvests and reconstructs one deterministic event without send', () => {
    const previous = process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
    const root = `/tmp/opk-completed-${process.pid}-${Date.now()}`;
    process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = root;
    try {
      const first = harvestExistingTurn(1200, turn);
      const second = recoverCompletedTurn(1200, turn, topology);
      expect(first.sendCount).toBe(0);
      expect(second.sendCount).toBe(0);
      expect(second.event?.eventKey).toBe(constructPublicationEvent(topology, first.result!).eventKey);
      expect(second.event?.records[0]?.outputId).toBe(first.result?.outputId);
    } finally {
      if (previous === undefined) delete process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
      else process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = previous;
    }
  });

  it('refuses a completed result with a changed identity', () => {
    const previous = process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
    process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = `/tmp/opk-completed-${process.pid}-${Date.now()}-bad`;
    try {
      const result = commitCompletedResult(1200, turn);
      expect(() => constructPublicationEvent(topology, { ...result, stageAttemptId: 'other' })).toThrow(/identity/);
    } finally {
      if (previous === undefined) delete process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
      else process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = previous;
    }
  });
});
