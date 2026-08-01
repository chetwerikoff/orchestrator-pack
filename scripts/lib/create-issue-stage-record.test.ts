import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCanonicalLineage } from './create-issue-stage-record-lineage.ts';
import {
  logicalEventsEqual,
  logicalFingerprint,
  parseLogicalFromCommentBody,
  serializeCommentBody,
} from './create-issue-stage-record-marker.ts';
import {
  fetchIssueComments,
  parseJournalEvents,
} from './create-issue-stage-record-gh.ts';
import { parseConsumableStageReceipt } from './create-issue-stage-record-receipt.ts';
import {
  createMockGhState,
  createMockTransport,
  installCommentPages,
  makeTempDir,
} from './create-issue-stage-record-test-helpers.ts';
import type { CycleEventLogical, StageEventLogical, TrustedComment } from './create-issue-stage-record-types.ts';
import { CYCLE_SCHEMA, STAGE_SCHEMA } from './create-issue-stage-record-types.ts';

describe('create-issue-stage-record marker and lineage', () => {
  it('parses markers for all schemas and compares logical fingerprints without delivery metadata', () => {
    const cycle: CycleEventLogical = {
      schema: CYCLE_SCHEMA,
      'event-key': 'cycle-1',
      'cycle-id': 'cycle-1',
      'predecessor-cycle-id': 'none',
      'source-revision': 'r01',
      tier: 'T3',
      'public-actor': 'cursor-flow-manager',
    };
    const delayedBody = serializeCommentBody(cycle, { delivery: 'delayed', deliveryFailureClass: 'transport' });
    const immediateBody = serializeCommentBody(cycle, { delivery: 'immediate' });
    const delayed = parseLogicalFromCommentBody(delayedBody);
    const immediate = parseLogicalFromCommentBody(immediateBody);
    expect(delayed).not.toBeNull();
    expect(immediate).not.toBeNull();
    expect(logicalEventsEqual(delayed!, immediate!)).toBe(true);
    expect(logicalFingerprint(delayed!)).toBe(logicalFingerprint(immediate!));
  });

  it('resolves one canonical root, orphan, fork, and conflicting cycle ids', () => {
    const root = makeCycleComment(1, 'cycle-a', 'none', '2020-01-01T00:00:00Z');
    const conflictingRoot = makeCycleComment(2, 'cycle-a', 'none', '2020-01-02T00:00:00Z', {
      'source-revision': 'r02',
    });
    const child = makeCycleComment(3, 'cycle-b', 'cycle-a', '2020-01-03T00:00:00Z');
    const orphan = makeCycleComment(4, 'cycle-c', 'missing', '2020-01-04T00:00:00Z');
    const fork = makeCycleComment(5, 'cycle-d', 'cycle-a', '2020-01-05T00:00:00Z');
    const { events } = parseJournalEvents([root, conflictingRoot, child, orphan, fork]);
    const lineage = buildCanonicalLineage(events);
    expect(lineage.canonicalRoot?.eventKey).toBe('cycle-a');
    expect(lineage.head?.eventKey).toBe('cycle-b');
    expect(lineage.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      'conflicting-cycle-id',
      'orphan-cycle',
      'non-current-cycle-fork',
    ]));
  });
});

describe('create-issue-stage-record trusted comment admission and pagination', () => {
  const repo = 'chetwerikoff/orchestrator-pack';

  it('excludes foreign and edited comments from the eligible census', () => {
    const state = createMockGhState();
    state.comments = [
      trusted(1, 'ok', state.ownerLogin, '2020-01-01T00:00:00Z'),
      trusted(2, 'foreign', 'someone-else', '2020-01-02T00:00:00Z'),
      trusted(3, 'edited', state.ownerLogin, '2020-01-03T00:00:00Z', '2020-01-03T01:00:00Z'),
    ];
    const transport = createMockTransport(state);
    const result = fetchIssueComments(transport, repo, 1152, state.ownerLogin, { pageSize: 10, maxPages: 1 });
    expect(result.comments).toHaveLength(1);
    expect(result.commentsComplete).toBe(true);
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(['foreign-comment', 'edited-comment']));
  });

  it('fails closed when pagination is truncated before exhaustion is proven', () => {
    const state = createMockGhState();
    state.comments = [
      trusted(1, 'ok', state.ownerLogin, '2020-01-01T00:00:00Z'),
      trusted(2, 'more', state.ownerLogin, '2020-01-02T00:00:00Z'),
    ];
    const transport = createMockTransport(state);
    const result = fetchIssueComments(transport, repo, 1152, state.ownerLogin, { pageSize: 1, maxPages: 1, sentinelProbe: false });
    expect(result.commentsComplete).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain('comments-truncated');
  });

  it('proves exhaustion with a full final page and empty sentinel page', () => {
    const state = createMockGhState();
    installCommentPages(state, repo, 1152, [
      [trusted(1, 'a', state.ownerLogin, '2020-01-01T00:00:00Z')],
      [trusted(2, 'b', state.ownerLogin, '2020-01-02T00:00:00Z')],
    ], 1);
    const transport = createMockTransport(state);
    const result = fetchIssueComments(transport, repo, 1152, state.ownerLogin, { pageSize: 1, maxPages: 2 });
    expect(result.commentsComplete).toBe(true);
    expect(result.comments).toHaveLength(2);
  });
});

describe('create-issue-stage-record receipt binding', () => {
  it('requires pre-launch cycle binding witness and rejects rebinding or revision mismatch', () => {
    const valid = parseConsumableStageReceipt({
      tier: 'T3',
      stage: 'competitive',
      cycleId: 'cycle-1',
      stageAttemptId: 'attempt-1',
      policyVersion: 'triple-source/v1',
      sourceRevision: 'r01',
      outcome: 'complete',
      reviewerCardinality: 3,
      completedSourceCount: 3,
      producerEvidence: 'not-applicable',
      tierTransition: 'none',
      cycleBinding: { cycleId: 'cycle-1', sourceRevision: 'r01', boundBeforeLaunch: true },
    });
    expect(valid.errors).toEqual([]);
    const missing = parseConsumableStageReceipt({ ...valid.receipt, cycleBinding: undefined });
    expect(missing.errors.join('\n')).toMatch(/cycleBinding/);
    const rebound = parseConsumableStageReceipt({
      ...valid.receipt,
      cycleBinding: { cycleId: 'cycle-2', sourceRevision: 'r01', boundBeforeLaunch: true },
    });
    expect(rebound.errors.join('\n')).toMatch(/mismatch/);
  });
});

function trusted(
  id: number,
  body: string,
  userLogin: string,
  createdAt: string,
  updatedAt = createdAt,
): TrustedComment {
  return { id, body, createdAt, updatedAt, userLogin, authorAssociation: 'OWNER' };
}

function makeCycleComment(
  id: number,
  cycleId: string,
  predecessor: string,
  createdAt: string,
  overrides: Partial<CycleEventLogical> = {},
): TrustedComment {
  const logical: CycleEventLogical = {
    schema: CYCLE_SCHEMA,
    'event-key': cycleId,
    'cycle-id': cycleId,
    'predecessor-cycle-id': predecessor,
    'source-revision': 'r01',
    tier: 'T3',
    'public-actor': 'cursor-flow-manager',
    ...overrides,
  };
  return trusted(id, serializeCommentBody(logical), 'owner', createdAt);
}

afterEach(() => {
  // no shared temp dirs in unit tests here
});

