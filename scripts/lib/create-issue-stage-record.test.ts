import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeFinalAcceptanceGuards, FINAL_ACCEPTANCE_CONTRACT_VERSION } from './create-issue-final-acceptance-contract.ts';
import { buildCanonicalLineage } from './create-issue-stage-record-lineage.ts';
import {
  logicalEventsEqual,
  logicalFingerprint,
  parseLogicalFromCommentBody,
  serializeCommentBody,
} from './create-issue-stage-record-marker.ts';
import {
  fetchIssueComments,
  withGhDeadline,
  parseJournalEvents,
  syncIssueProjectionLabels,
  readPendingEvent,
} from './create-issue-stage-record-gh.ts';
import {
  detectAcceptedRevisionDrift,
  publishJournalEvent,
  publishSettledStageRecord,
  retryPendingEvents,
  startReviewCycle,
} from './create-issue-stage-record-core.ts';
import { parseConsumableStageReceipt } from './create-issue-stage-record-receipt.ts';
import {
  createMockGhState,
  createMockTransport,
  installCommentPages,
  makeTempDir,
  sampleStageReceipt,
} from './create-issue-stage-record-test-helpers.ts';
import type { CycleEventLogical, StageEventLogical, TrustedComment } from './create-issue-stage-record-types.ts';
import { CYCLE_SCHEMA, FINAL_SCHEMA, STAGE_SCHEMA } from './create-issue-stage-record-types.ts';

describe('create-issue-stage-record marker and lineage', () => {
  it('propagates one publication deadline and stops before a post-deadline call', () => {
    const calls: Array<{ argv: string[]; timeoutMs?: number }> = [];
    const transport = {
      runGh(argv: string[], timeoutMs?: number) {
        calls.push({ argv, timeoutMs });
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
    };
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(1_600).mockReturnValue(2_100);

    const bounded = withGhDeadline(transport, 2_000);
    expect(bounded.runGh(['gh', 'api', 'first']).exitCode).toBe(0);
    expect(bounded.runGh(['gh', 'api', 'second']).exitCode).toBe(0);
    expect(bounded.runGh(['gh', 'api', 'third'])).toMatchObject({
      exitCode: 124,
      stderr: 'publication_deadline_exhausted',
    });
    expect(calls.map((call) => call.timeoutMs)).toEqual([1_000, 400]);
    now.mockRestore();
  });
  it('returns blocked when the shared publication deadline expires during confirmation', () => {
    const calls: Array<{ argv: string[]; timeoutMs?: number }> = [];
    const transport = {
      runGh(argv: string[], timeoutMs?: number) {
        calls.push({ argv, timeoutMs });
        if (argv.includes('--jq')) return { exitCode: 0, stdout: 'owner', stderr: '' };
        if (argv[2]?.includes('/comments?')) return { exitCode: 0, stdout: '[]', stderr: '' };
        return { exitCode: 0, stdout: '{"id": 1}', stderr: '' };
      },
    };
    const workdir = makeTempDir();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(1_000).mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000).mockReturnValue(12_000);

    try {
      const result = publishJournalEvent(
        transport,
        'owner/repo',
        1197,
        workdir,
        'event body',
        'stage-event/v1',
        'event-1',
        'fingerprint',
      );
      expect(result.ok).toBe(false);
      expect(result.terminal).toMatchObject({
        outcome: 'blocked',
        cause: 'publication-timeout',
        remedy: expect.any(String),
        owner: 'exception publisher',
        deadline: 'GH_TIMEOUT_MS = 10_000 ms',
      });
      expect(calls).toHaveLength(3);
    } finally {
      now.mockRestore();
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it('returns a blocked terminal diagnostic when start-cycle census times out', () => {
    const transport = {
      runGh(argv: string[]) {
        if (argv[2]?.includes('/labels/')) return { exitCode: 0, stdout: '', stderr: '' };
        return { exitCode: 1, stdout: '', stderr: 'ETIMEDOUT', timedOut: true };
      },
    };
    const workdir = makeTempDir();
    try {
      const result = startReviewCycle(transport, {
        repo: 'owner/repo',
        issueNumber: 1197,
        sourceRevision: 'r01',
        tier: 'T2',
        publicActor: 'cursor-flow-manager',
        workdir,
      });
      expect(result.ok).toBe(false);
      expect(result.diagnostics.some((item) => item.message.includes('terminal outcome: blocked'))).toBe(true);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it('returns a blocked terminal diagnostic for a non-timeout census failure', () => {
    const transport = {
      runGh() {
        return { exitCode: 1, stdout: '', stderr: 'authentication failed' };
      },
    };
    const workdir = makeTempDir();
    try {
      const result = publishSettledStageRecord(transport, {
        repo: 'owner/repo',
        issueNumber: 1197,
        receipt: sampleStageReceipt('cycle-1'),
        workdir,
      });
      expect(result.ok).toBe(false);
      const messages = result.diagnostics.map((item) => item.message).join('\n');
      expect(messages).toContain('terminal outcome: blocked');
      expect(messages).not.toContain('publication-timeout');
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it('preserves a publication census transport failure as blocked instead of relabeling it as timeout', () => {
    const transport = {
      runGh() {
        return { exitCode: 1, stdout: '', stderr: 'authentication failed' };
      },
    };
    const workdir = makeTempDir();
    try {
      const result = publishJournalEvent(
        transport,
        'owner/repo',
        1197,
        workdir,
        'event body',
        'stage-event/v1',
        'event-transport-failure',
        'fingerprint',
      );
      expect(result.ok).toBe(false);
      const messages = result.diagnostics.map((item) => item.message).join('\n');
      expect(messages).toContain('terminal outcome: blocked');
      expect(messages).not.toContain('publication-timeout');
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it('returns structured blocked metadata when comments time out after owner lookup', () => {
    const transport = {
      runGh(argv: string[]) {
        if (argv.includes('--jq')) return { exitCode: 0, stdout: 'owner', stderr: '' };
        return { exitCode: 1, stdout: '', stderr: 'ETIMEDOUT', timedOut: true };
      },
    };
    const workdir = makeTempDir();
    try {
      const result = publishSettledStageRecord(transport, {
        repo: 'owner/repo',
        issueNumber: 1197,
        receipt: sampleStageReceipt('cycle-1'),
        workdir,
      });
      expect(result.ok).toBe(false);
      expect(result.terminal).toMatchObject({
        outcome: 'blocked',
        cause: 'publication-timeout',
        remedy: expect.any(String),
        owner: expect.any(String),
        deadline: 'GH_TIMEOUT_MS = 10_000 ms',
      });
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it('keeps a non-timeout comment transport failure blocked with structured metadata', () => {
    const transport = {
      runGh(argv: string[]) {
        if (argv.includes('--jq')) return { exitCode: 0, stdout: 'owner', stderr: '' };
        return { exitCode: 1, stdout: '', stderr: 'temporary API failure' };
      },
    };
    const workdir = makeTempDir();
    try {
      const result = publishSettledStageRecord(transport, {
        repo: 'owner/repo',
        issueNumber: 1197,
        receipt: sampleStageReceipt('cycle-1'),
        workdir,
      });
      expect(result.ok).toBe(false);
      expect(result.terminal).toMatchObject({
        outcome: 'blocked',
        cause: 'transport-failure',
        remedy: expect.any(String),
        owner: expect.any(String),
        deadline: 'GH_TIMEOUT_MS = 10_000 ms',
      });
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it('returns refused only when the comment transport marks an explicit terminal refusal', () => {
    const transport = {
      runGh(argv: string[]) {
        if (argv.includes('--jq')) return { exitCode: 0, stdout: 'owner', stderr: '' };
        return { exitCode: 1, stdout: '', stderr: 'policy refusal', terminalRefusal: true };
      },
    };
    const workdir = makeTempDir();
    try {
      const result = publishSettledStageRecord(transport, {
        repo: 'owner/repo',
        issueNumber: 1197,
        receipt: sampleStageReceipt('cycle-1'),
        workdir,
      });
      expect(result.ok).toBe(false);
      expect(result.terminal).toMatchObject({
        outcome: 'refused',
        cause: 'terminal-refusal',
        remedy: expect.any(String),
        owner: expect.any(String),
        deadline: 'GH_TIMEOUT_MS = 10_000 ms',
      });
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

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
    const finalBody = serializeCommentBody({
      schema: FINAL_SCHEMA,
      'event-key': 'cycle-1:final-acceptance:r01',
      'cycle-id': 'cycle-1',
      tier: 'T3',
      'source-revision': 'r01',
      outcome: 'accepted',
      'contract-version': 'create-issue-final-acceptance-contract/v1',
      'public-actor': 'cursor-flow-manager',
    });
    expect(parseLogicalFromCommentBody(finalBody)?.schema).toBe(FINAL_SCHEMA);
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

  it('closes admission for self-referential, cyclic, and duplicate predecessors', () => {
    const self = makeCycleComment(1, 'cycle-self', 'cycle-self', '2020-01-01T00:00:00Z');
    const selfLineage = buildCanonicalLineage(parseJournalEvents([self]).events);
    expect(selfLineage.diagnostics.map((item) => item.code)).toContain('cyclic-cycle-lineage');

    const a = makeCycleComment(2, 'cycle-a', 'cycle-b', '2020-01-01T00:00:00Z');
    const b = makeCycleComment(3, 'cycle-b', 'cycle-a', '2020-01-02T00:00:00Z');
    const duplicate = makeCycleComment(4, 'cycle-b', 'cycle-a', '2020-01-03T00:00:00Z');
    const { events } = parseJournalEvents([a, b, duplicate]);
    const lineage = buildCanonicalLineage(events);
    expect(lineage.canonicalRoot).toBeNull();
    expect(lineage.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(['cyclic-cycle-lineage', 'duplicate-remote-event']));
  });

  it('rejects a marked payload that omits required schema fields', () => {
    const malformed = '<!-- opk-create-issue-journal:create-issue-stage-record/v1:bad -->\n```json\n{"schema":"create-issue-stage-record/v1","event-key":"bad"}\n```';
    expect(parseJournalEvents([trusted(1, malformed, 'owner', '2020-01-01T00:00:00Z')]).events).toEqual([]);
  });

  it('fails closed when a comment omits a trust field', () => {
    const state = createMockGhState();
    state.comments = [trusted(1, 'ok', state.ownerLogin, '2020-01-01T00:00:00Z')];
    state.comments[0] = { ...state.comments[0]!, authorAssociation: undefined as unknown as string };
    const result = fetchIssueComments(createMockTransport(state), 'chetwerikoff/orchestrator-pack', 1152, state.ownerLogin, { pageSize: 10 });
    expect(result.commentsComplete).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain('trust-field-incomplete');
  });
});

describe('create-issue-stage-record trusted comment admission and pagination', () => {
  const repo = 'chetwerikoff/orchestrator-pack';

  it('constructs the comment census as a GET with query pagination and no body fields', () => {
    const comment = trusted(1, 'read me', 'chetwerikoff', '2020-01-01T00:00:00Z');
    const requests: string[][] = [];
    const expectedPath = `repos/${repo}/issues/1152/comments?per_page=100&page=1`;
    const transport = {
      runGh(argv: string[]) {
        requests.push(argv);
        if (argv.length === 3 && argv[0] === 'gh' && argv[1] === 'api' && argv[2] === expectedPath) {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{
              id: comment.id,
              body: comment.body,
              created_at: comment.createdAt,
              updated_at: comment.updatedAt,
              user: { login: comment.userLogin },
              author_association: comment.authorAssociation,
            }]),
            stderr: '',
          };
        }
        return { exitCode: 422, stdout: '', stderr: 'body was not supplied' };
      },
    };

    const result = fetchIssueComments(transport, repo, 1152, 'chetwerikoff');

    expect(result.comments).toEqual([comment]);
    expect(result.commentsComplete).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(requests).toEqual([['gh', 'api', expectedPath]]);
    expect(requests[0]).not.toContain('-f');
  });

  it('constructs label synchronization as repeated array fields', () => {
    const requests: string[][] = [];
    const issuePath = `repos/${repo}/issues/1152`;
    const expectedPatch = [
      'gh', 'api', issuePath, '-X', 'PATCH',
      '-f', 'labels[]=bug',
      '-f', 'labels[]=spec-review:in-progress',
    ];
    const transport = {
      runGh(argv: string[]) {
        requests.push(argv);
        if (argv.includes('--jq')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ title: 't', body: 'revision r01', labels: ['bug', 'spec-review:accepted'] }),
            stderr: '',
          };
        }
        if (JSON.stringify(argv) === JSON.stringify(expectedPatch)) {
          return { exitCode: 0, stdout: '{}', stderr: '' };
        }
        return { exitCode: 422, stdout: '', stderr: 'labels was not an array' };
      },
    };

    const result = syncIssueProjectionLabels(transport, repo, 1152, 'spec-review:in-progress', ['bug', 'spec-review:accepted']);

    expect(result.ok).toBe(true);
    expect(result.pendingRepair).toBe(false);
    expect(requests).toEqual([
      ['gh', 'api', issuePath, '--jq', '{title, body, labels: [.labels[].name]}'],
      expectedPatch,
    ]);
    expect(requests[1]).not.toContain('labels=[\"bug\",\"spec-review:in-progress\"]');
  });

  it('uses a label-specific diagnostic when label state cannot be read', () => {
    const result = syncIssueProjectionLabels({
      runGh: () => ({ exitCode: 1, stdout: '', stderr: 'read failed' }),
    }, repo, 1152, 'spec-review:in-progress', []);

    expect(result.pendingRepair).toBe(true);
    expect(result.diagnostics.map((item) => item.code)).toContain('label-sync-failed');
    expect(result.diagnostics.map((item) => item.code)).not.toContain('comments-truncated');
  });

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

  it('does not admit a full page when the injected sentinel still has data', () => {
    const state = createMockGhState();
    state.comments = [
      trusted(1, 'a', state.ownerLogin, '2020-01-01T00:00:00Z'),
      trusted(2, 'b', state.ownerLogin, '2020-01-02T00:00:00Z'),
    ];
    const result = fetchIssueComments(createMockTransport(state), repo, 1152, state.ownerLogin, { pageSize: 1, maxPages: 1 });
    expect(result.commentsComplete).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain('comments-truncated');
  });

  it('keeps public journal bodies free of URLs, capture text, and producer strings', () => {
    const cycle: CycleEventLogical = {
      schema: CYCLE_SCHEMA, 'event-key': 'cycle-privacy', 'cycle-id': 'cycle-privacy',
      'predecessor-cycle-id': 'none', 'source-revision': 'r01', tier: 'T1', 'public-actor': 'cursor-flow-manager',
    };
    const body = serializeCommentBody(cycle);
    expect(body).not.toMatch(/https?:\/\//i);
    expect(body).not.toMatch(/capture|producer|secret/i);
  });

  it('keeps a delayed pending cycle delivery and retries it through the cycle finalizer', () => {
    const state = createMockGhState({ issue: { title: 't', body: 'revision r01', labels: [] }, failCreate: true });
    const transport = createMockTransport(state);
    const workdir = makeTempDir();
    const failed = startReviewCycle(transport, {
      repo,
      issueNumber: 1152,
      sourceRevision: 'r01',
      tier: 'T2',
      publicActor: 'cursor-flow-manager',
      workdir,
    });
    expect(failed.ok).toBe(false);
    expect(readPendingEvent(workdir, failed.eventKey!)).toMatchObject({ delivery: 'delayed', deliveryFailureClass: 'comment-create' });
    state.failCreate = false;
    const retried = retryPendingEvents(transport, repo, 1152, workdir, { pageSize: 10 });
    expect(retried).toHaveLength(1);
    expect(retried[0]?.ok).toBe(true);
    expect(state.issue.labels).toContain('spec-review:in-progress');
    expect(readPendingEvent(workdir, failed.eventKey!)).toBeNull();
  });

  it('retains the published event but leaves projection repair pending when label sync fails', () => {
    const state = createMockGhState({
      issue: { title: 't', body: 'revision r01', labels: ['bug'] },
      failLabelSync: true,
    });
    const transport = createMockTransport(state);
    const workdir = makeTempDir();
    const result = startReviewCycle(transport, {
      repo,
      issueNumber: 1152,
      sourceRevision: 'r01',
      tier: 'T2',
      publicActor: 'cursor-flow-manager',
      workdir,
    });
    expect(result.ok).toBe(false);
    expect(result.projectionPendingRepair).toBe(true);
    expect(state.comments).toHaveLength(1);
    expect(state.issue.labels).not.toContain('spec-review:in-progress');
    expect(state.issue.labels).toContain('bug');
    expect(result.diagnostics.map((item) => item.code)).toContain('label-sync-failed');
    expect(result.diagnostics.map((item) => item.code)).not.toContain('comments-truncated');
  });

  it('does not mutate projection labels when comment create is ambiguous before confirmation', () => {
    const state = createMockGhState({
      issue: { title: 't', body: 'revision r01', labels: ['bug'] },
      ambiguousCreate: true,
    });
    const transport = createMockTransport(state);
    const workdir = makeTempDir();
    const result = startReviewCycle(transport, {
      repo,
      issueNumber: 1152,
      sourceRevision: 'r01',
      tier: 'T2',
      publicActor: 'cursor-flow-manager',
      workdir,
    });
    expect(result.ok).toBe(false);
    expect(result.projectionPendingRepair).toBe(true);
    expect(state.comments).toHaveLength(0);
    expect(state.issue.labels).not.toContain('spec-review:in-progress');
  });

  it('starts a successor cycle by removing accepted and applying in-progress while preserving unrelated labels', () => {
    const state = createMockGhState({
      issue: { title: 't', body: 'revision r02', labels: ['bug', 'spec-review:accepted'] },
    });
    const transport = createMockTransport(state);
    const workdir = makeTempDir();
    const result = startReviewCycle(transport, {
      repo,
      issueNumber: 1152,
      sourceRevision: 'r02',
      tier: 'T2',
      publicActor: 'cursor-flow-manager',
      workdir,
    });
    expect(result.ok).toBe(true);
    expect(state.issue.labels).toContain('spec-review:in-progress');
    expect(state.issue.labels).not.toContain('spec-review:accepted');
    expect(state.issue.labels).toContain('bug');
  });

  it('detects post-acceptance revision drift and does not claim eventual delivery without pending evidence', () => {
    const state = createMockGhState({
      issue: { title: 't', body: 'revision r02', labels: ['spec-review:accepted'] },
    });
    const transport = createMockTransport(state);
    expect(detectAcceptedRevisionDrift(transport, repo, 1152, 'r01')).toBe(true);
    const retried = retryPendingEvents(transport, repo, 1152, makeTempDir(), { pageSize: 10 });
    expect(retried).toEqual([]);
  });
});

const issueNumber = 1152;
const repo = 'chetwerikoff/orchestrator-pack';
const cliTempDirs: string[] = [];

afterEach(() => {
  for (const dir of cliTempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('create-issue-stage-finalize integration', () => {
  it('starts a cycle, retries equal logical events, and rejects conflicting roots', () => {
    const state = createMockGhState({ issue: { title: 't', body: 'revision r01', labels: ['bug'] } });
    const transport = createMockTransport(state);
    const workdir = makeCliTempDir();

    const first = startReviewCycle(transport, {
      repo,
      issueNumber,
      sourceRevision: 'r01',
      tier: 'T3',
      publicActor: 'cursor-flow-manager',
      workdir,
    });
    expect(first.ok).toBe(true);
    expect(state.comments).toHaveLength(1);
    expect(state.issue.labels).toContain('spec-review:in-progress');

    const retry = startReviewCycle(transport, {
      repo,
      issueNumber,
      sourceRevision: 'r01',
      tier: 'T3',
      publicActor: 'cursor-flow-manager',
      workdir,
    });
    expect(retry.ok).toBe(true);
    expect(state.comments).toHaveLength(1);

    const conflicting = startReviewCycle(transport, {
      repo,
      issueNumber,
      sourceRevision: 'r02',
      tier: 'T3',
      publicActor: 'cursor-flow-manager',
      predecessorCycleId: 'none',
      workdir: makeCliTempDir(),
    });
    expect(conflicting.ok).toBe(false);
  });

  it('publishes a bound stage record and refuses github failure as non-authoritative local progression', () => {
    const state = createMockGhState({ issue: { title: 't', body: 'revision r01', labels: [] } });
    const transport = createMockTransport(state);
    const workdir = makeCliTempDir();
    const started = startReviewCycle(transport, {
      repo,
      issueNumber,
      sourceRevision: 'r01',
      tier: 'T3',
      publicActor: 'cursor-flow-manager',
      workdir,
    });
    const cycleId = started.cycleId!;
    const receipt = sampleStageReceipt(cycleId);
    const published = publishSettledStageRecord(transport, {
      repo,
      issueNumber,
      receipt,
      workdir,
    });
    expect(published.ok).toBe(true);
    expect(state.comments).toHaveLength(2);

    state.failCreate = true;
    const blocked = publishSettledStageRecord(transport, {
      repo,
      issueNumber,
      receipt: {
        ...receipt,
        stageAttemptId: 'attempt-2',
        stage: 'architectural-review',
      },
      workdir,
    });
    expect(blocked.ok).toBe(false);
    expect(state.comments).toHaveLength(2);
  });

  it('refuses stage publication when cycle binding is missing or cross-cycle', () => {
    const state = createMockGhState({ issue: { title: 't', body: 'revision r01', labels: [] } });
    const transport = createMockTransport(state);
    const workdir = makeCliTempDir();
    const started = startReviewCycle(transport, {
      repo,
      issueNumber,
      sourceRevision: 'r01',
      tier: 'T3',
      publicActor: 'cursor-flow-manager',
      workdir,
    });
    const missing = publishSettledStageRecord(transport, {
      repo,
      issueNumber,
      receipt: { ...sampleStageReceipt(started.cycleId!), cycleBinding: undefined },
      workdir,
    });
    expect(missing.ok).toBe(false);
    const cross = publishSettledStageRecord(transport, {
      repo,
      issueNumber,
      receipt: {
        ...sampleStageReceipt(started.cycleId!),
        cycleId: 'other-cycle',
      },
      workdir,
    });
    expect(cross.ok).toBe(false);
  });
});

describe('create-issue-final-acceptance contract parity', () => {
  it('exports the shared contract version', () => {
    expect(FINAL_ACCEPTANCE_CONTRACT_VERSION).toBe('create-issue-final-acceptance-contract/v1');
  });

  it('requires direct guard execution inputs instead of a PASS receipt shortcut', () => {
    const result = executeFinalAcceptanceGuards({
      issueBody: 'body without revision marker',
      issueRevision: 'r01',
      cycleId: 'cycle-1',
      reviewDir: '/tmp/review',
      stageReceiptPaths: [],
      capturePaths: [],
      externalPassReceiptPath: '/tmp/fake-pass.json',
    });
    expect(result.ok).toBe(false);
    expect(result.contractVersion).toBe('create-issue-final-acceptance-contract/v1');
    expect(result.errors[0]).toMatch(/external PASS receipt/);
  });

  it('runs the three acceptance guards and cycle witness validation directly', () => {
    const result = executeFinalAcceptanceGuards({
      issueBody: '```complexity-tier\ntier: T1\nadvisory-prior: T1\n```\nr01',
      issueRevision: 'r01',
      cycleId: 'cycle-1',
      reviewDir: '/tmp/review',
      stageReceiptPaths: ['receipt.json'],
      capturePaths: [],
      readJson: () => ({
        tier: 'T1', stage: 'architectural', cycleId: 'cycle-2', stageAttemptId: 'attempt-1',
        policyVersion: 'single-source/v1', sourceRevision: 'r01', outcome: 'complete',
        reviewerCardinality: 1, completedSourceCount: 1, producerEvidence: 'not-applicable', tierTransition: 'none',
        cycleBinding: { cycleId: 'cycle-2', sourceRevision: 'r01', boundBeforeLaunch: true },
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.startsWith('tier-gate:'))).toBe(true);
    expect(result.errors.some((error) => error.startsWith('stage-completeness:'))).toBe(true);
    expect(result.errors.some((error) => error.startsWith('finding-ledger:'))).toBe(true);
    expect(result.errors.some((error) => error.startsWith('cycle-binding:'))).toBe(true);
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

function makeCliTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'opk-1152-cli-'));
  cliTempDirs.push(dir);
  return dir;
}
