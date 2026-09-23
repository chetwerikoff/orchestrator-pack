import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeFinalAcceptanceGuards, FINAL_ACCEPTANCE_CONTRACT_VERSION } from './create-issue-final-acceptance-contract.ts';
import { runFinalAcceptance, validatePublishBodyBinding } from './create-issue-final-acceptance.ts';
import { resolvePublishedAuthorState } from './resolve-published-author-state.ts';
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
  persistCycleId,
  readPendingEvent,
  readPersistedCycleId,
  syncIssueProjectionLabels,
  writePendingEvent,
} from './create-issue-stage-record-gh.ts';
import {
  detectAcceptedRevisionDrift,
  publishLogicalJournalEvent,
  publishJournalEvent,
  publishSettledStageRecord,
  retryPendingEvents,
  startReviewCycle,
} from './create-issue-stage-record-core.ts';
import { parseStageFinalizeArgs } from './create-issue-stage-record-cli.ts';
import { bindPublishedCommentToSlot, STAGE_EVIDENCE_SCHEMA } from './create-issue-stage-record-artifacts.ts';
import { parseConsumableStageReceipt } from './create-issue-stage-record-receipt.ts';
import { runStageFinalizeCli } from './create-issue-stage-record-cli.ts';
import {
  createMockGhState,
  createMockTransport,
  cleanupTempDirs,
  installCommentPages,
  makeTempDir,
  sampleStageReceipt,
} from './create-issue-stage-record-test-helpers.ts';
import type { CycleEventLogical, GhTransport, PublicActor, StageEventLogical, TrustedComment } from './create-issue-stage-record-types.ts';
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
    vi.useFakeTimers({ now: new Date('2026-08-03T00:00:00.000Z') });
    try {
      const failed = startReviewCycle(transport, {
        repo,
        issueNumber: 1152,
        sourceRevision: 'r01',
        tier: 'T2',
        publicActor: 'cursor-flow-manager',
        workdir,
      });
      expect(failed.ok).toBe(false);
      const pending = readPendingEvent(workdir, failed.eventKey!);
      expect(pending).toMatchObject({
        delivery: 'delayed',
        deliveryFailureClass: 'comment-create',
      });
      expect(pending?.body).toEqual(expect.any(String));

      state.failCreate = false;
      const retried = retryPendingEvents(transport, repo, 1152, workdir, { pageSize: 10 });

      expect(retried).toHaveLength(1);
      expect(retried[0]?.ok).toBe(true);
      expect(state.commentCreateAttempts).toEqual([
        { body: pending?.body, succeeded: false },
        { body: pending?.body, succeeded: true },
      ]);
      expect(state.comments).toHaveLength(1);
      expect(state.comments[0]?.body).toBe(pending?.body);
      expect(state.issue.labels).toContain('spec-review:in-progress');
      expect(readPendingEvent(workdir, failed.eventKey!)).toBeNull();
    } finally {
      vi.useRealTimers();
      rmSync(workdir, { recursive: true, force: true });
    }
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
  cleanupTempDirs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function issue1976PoisonBody(overrides: Record<string, unknown> = {}): string {
  const cycleId = '2bfd8bce-fa3d-47b7-aa02-e85b13432a4c';
  const payload = {
    schema: CYCLE_SCHEMA,
    'event-key': cycleId,
    'cycle-id': cycleId,
    'predecessor-cycle-id': 'none',
    'source-revision': 'r01',
    tier: 'T2',
    'public-actor': 'flow-manager',
    ...overrides,
  };
  return [
    `<!-- opk-create-issue-journal:${CYCLE_SCHEMA}:${cycleId} -->`,
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');
}

function issue1976PoisonComment(body = issue1976PoisonBody()): TrustedComment {
  return {
    id: 5757262517,
    body,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    userLogin: 'chetwerikoff',
    authorAssociation: 'OWNER',
  };
}

function t2StageReceipt(cycleId: string, stageAttemptId = 'attempt-1978') {
  return {
    tier: 'T2',
    stage: 'architectural-review',
    cycleId,
    stageAttemptId,
    policyVersion: 'triple-source/v1',
    sourceRevision: 'r01',
    outcome: 'complete',
    reviewerCardinality: 3,
    completedSourceCount: 3,
    producerEvidence: 'not-applicable',
    tierTransition: 'none',
    cycleBinding: { cycleId, sourceRevision: 'r01', boundBeforeLaunch: true },
  };
}

describe('Issue #1978 invalid public-actor recovery', () => {
  it('rejects flow-manager at the CLI and core boundaries before any GitHub call', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitCode = runStageFinalizeCli([
      'node',
      'scripts/create-issue-stage-finalize.ts',
      'start-cycle',
      '--repo', repo,
      '--issue-number', String(issueNumber),
      '--source-revision', 'r01',
      '--stage', 'architectural-review',
      '--tier', 'T2',
      '--public-actor', 'flow-manager',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr.mock.calls.flat().join('')).toContain('flow-manager');

    let ghCalls = 0;
    const result = startReviewCycle({
      runGh() {
        ghCalls += 1;
        return { exitCode: 1, stdout: '', stderr: 'must not be called' };
      },
    }, {
      repo,
      issueNumber,
      sourceRevision: 'r01',
      tier: 'T2',
      publicActor: 'flow-manager' as unknown as PublicActor,
      workdir: makeCliTempDir(),
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.message).join('\n')).toContain('flow-manager');
    expect(ghCalls).toBe(0);
  });

  it('supersedes the exact #1976 poison without resending it and keeps later publications bounded', () => {
    vi.useFakeTimers({ now: new Date('2026-09-21T00:00:00.000Z') });
    const poison = issue1976PoisonComment();
    const poisonBytes = poison.body;
    const state = createMockGhState({
      comments: [poison],
      issue: { title: 't', body: '<!-- source-revision: r01 -->\nrevision r01', labels: ['spec-review:in-progress'] },
      nextCommentId: 5757262518,
    });
    const transport = createMockTransport(state);
    const workdir = makeCliTempDir();
    writePendingEvent(workdir, {
      schema: CYCLE_SCHEMA,
      eventKey: '2bfd8bce-fa3d-47b7-aa02-e85b13432a4c',
      body: poison.body,
      createdAt: poison.createdAt,
      delivery: 'delayed',
      deliveryFailureClass: 'comment-create',
      firstFailureAt: poison.createdAt,
    });
    persistCycleId(workdir, '2bfd8bce-fa3d-47b7-aa02-e85b13432a4c');

    const retry = retryPendingEvents(transport, repo, issueNumber, workdir, { pageSize: 100 });
    expect(retry).toHaveLength(1);
    expect(retry[0]?.ok).toBe(false);
    expect(retry[0]?.recovery).toMatchObject({
      kind: 'invalid-public-actor-successor',
      poisonCommentId: 5757262517,
      poisonedCycleId: '2bfd8bce-fa3d-47b7-aa02-e85b13432a4c',
      predecessorCycleId: 'none',
      sourceRevision: 'r01',
      tier: 'T2',
      invalidPublicActor: 'flow-manager',
    });
    expect(state.commentCreateAttempts).toEqual([]);
    expect(state.comments[0]?.body).toBe(poisonBytes);

    const successor = startReviewCycle(transport, {
      repo,
      issueNumber,
      sourceRevision: 'r01',
      tier: 'T2',
      publicActor: 'cursor-flow-manager',
      workdir,
      census: { pageSize: 100 },
    });
    expect(successor.ok, successor.diagnostics.map((item) => item.message).join('\n')).toBe(true);
    expect(successor.cycleId).toBeTruthy();
    expect(successor.cycleId).not.toBe('2bfd8bce-fa3d-47b7-aa02-e85b13432a4c');
    expect(state.comments).toHaveLength(2);
    expect(state.comments[0]?.body).toBe(poisonBytes);
    expect(parseLogicalFromCommentBody(state.comments[0]!.body)).toBeNull();
    const successorLogical = parseLogicalFromCommentBody(state.comments[1]!.body);
    expect(successorLogical).toMatchObject({
      schema: CYCLE_SCHEMA,
      'cycle-id': successor.cycleId,
      'predecessor-cycle-id': 'none',
      'source-revision': 'r01',
      tier: 'T2',
      'public-actor': 'cursor-flow-manager',
    });
    expect(readPendingEvent(workdir, '2bfd8bce-fa3d-47b7-aa02-e85b13432a4c')).toBeNull();
    expect(readPersistedCycleId(workdir)).toBe(successor.cycleId);

    const stage = publishSettledStageRecord(transport, {
      repo,
      issueNumber,
      receipt: t2StageReceipt(successor.cycleId!),
      workdir,
      census: { pageSize: 100 },
    });
    expect(stage.ok, stage.diagnostics.map((item) => item.message).join('\n')).toBe(true);
    expect(state.comments).toHaveLength(3);
    expect(state.comments[0]?.body).toBe(poisonBytes);

    const unrelatedMalformed: TrustedComment = {
      id: 5757262520,
      body: '<!-- opk-create-issue-journal:create-issue-review-cycle/v1:unrelated -->\n```json\n{"schema":"create-issue-review-cycle/v1","event-key":"different"}\n```',
      createdAt: '2026-09-21T00:01:00.000Z',
      updatedAt: '2026-09-21T00:01:00.000Z',
      userLogin: 'chetwerikoff',
      authorAssociation: 'OWNER',
    };
    state.comments.push(unrelatedMalformed);
    const attemptsBefore = state.commentCreateAttempts.length;
    const blocked = publishSettledStageRecord(transport, {
      repo,
      issueNumber,
      receipt: t2StageReceipt(successor.cycleId!, 'attempt-1978-second'),
      workdir,
      census: { pageSize: 100 },
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.diagnostics.map((item) => item.code)).toContain('malformed-marker');
    expect(state.commentCreateAttempts).toHaveLength(attemptsBefore);
    expect(state.comments[0]?.body).toBe(poisonBytes);
  });

  it('keeps the malformed poison blocking when the local recovery identity is absent', () => {
    const poison = issue1976PoisonComment();
    const state = createMockGhState({
      comments: [poison],
      issue: { title: 't', body: '<!-- source-revision: r01 -->\nrevision r01', labels: [] },
      nextCommentId: 5757262518,
    });
    const result = startReviewCycle(createMockTransport(state), {
      repo,
      issueNumber,
      sourceRevision: 'r01',
      tier: 'T2',
      publicActor: 'cursor-flow-manager',
      workdir: makeCliTempDir(),
      census: { pageSize: 100 },
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain('malformed-marker');
    expect(state.commentCreateAttempts).toEqual([]);
  });

  it.each([
    ['edited', { updatedAt: '2026-09-20T00:00:01.000Z' }],
    ['non-owner', { userLogin: 'someone-else' }],
  ] as const)('keeps %s #1976 poison evidence fail-closed', (_label, overrides) => {
    const poison = { ...issue1976PoisonComment(), ...overrides };
    const state = createMockGhState({
      comments: [poison],
      issue: { title: 't', body: '<!-- source-revision: r01 -->\nrevision r01', labels: [] },
    });
    const workdir = makeCliTempDir();
    persistCycleId(workdir, '2bfd8bce-fa3d-47b7-aa02-e85b13432a4c');

    const result = startReviewCycle(createMockTransport(state), {
      repo,
      issueNumber,
      sourceRevision: 'r01',
      tier: 'T2',
      publicActor: 'cursor-flow-manager',
      workdir,
      census: { pageSize: 100 },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      _label === 'edited' ? 'edited-comment' : 'foreign-comment',
    ]));
    expect(state.commentCreateAttempts).toEqual([]);
    expect(readPersistedCycleId(workdir)).toBe('2bfd8bce-fa3d-47b7-aa02-e85b13432a4c');
  });

  it.each([
    ['source revision', 'r02', 'T2'],
    ['tier', 'r01', 'T3'],
  ] as const)('refuses poison recovery with a mismatched %s before mutation', (_label, sourceRevision, tier) => {
    const poison = issue1976PoisonComment();
    const state = createMockGhState({
      comments: [poison],
      issue: { title: 't', body: '<!-- source-revision: r01 -->\nrevision r01', labels: [] },
    });
    const workdir = makeCliTempDir();
    persistCycleId(workdir, '2bfd8bce-fa3d-47b7-aa02-e85b13432a4c');

    const result = startReviewCycle(createMockTransport(state), {
      repo,
      issueNumber,
      sourceRevision,
      tier,
      publicActor: 'cursor-flow-manager',
      workdir,
      census: { pageSize: 100 },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.message).join('\n')).toContain('poison recovery binding mismatch');
    expect(state.commentCreateAttempts).toEqual([]);
    expect(readPersistedCycleId(workdir)).toBe('2bfd8bce-fa3d-47b7-aa02-e85b13432a4c');
  });

  it('preserves the persisted poison identity through a failed successor publication and lets retry-pending confirm it', () => {
    const poison = issue1976PoisonComment();
    const state = createMockGhState({
      comments: [poison],
      issue: { title: 't', body: '<!-- source-revision: r01 -->\nrevision r01', labels: ['spec-review:in-progress'] },
      nextCommentId: 5757262518,
      failCreate: true,
    });
    const transport = createMockTransport(state);
    const workdir = makeCliTempDir();
    writePendingEvent(workdir, {
      schema: CYCLE_SCHEMA,
      eventKey: '2bfd8bce-fa3d-47b7-aa02-e85b13432a4c',
      body: poison.body,
      createdAt: poison.createdAt,
      delivery: 'delayed',
      deliveryFailureClass: 'comment-create',
      firstFailureAt: poison.createdAt,
    });
    persistCycleId(workdir, '2bfd8bce-fa3d-47b7-aa02-e85b13432a4c');

    const failed = startReviewCycle(transport, {
      repo,
      issueNumber,
      sourceRevision: 'r01',
      tier: 'T2',
      publicActor: 'cursor-flow-manager',
      workdir,
      census: { pageSize: 100 },
    });
    expect(failed.ok).toBe(false);
    expect(readPersistedCycleId(workdir)).toBe('2bfd8bce-fa3d-47b7-aa02-e85b13432a4c');

    state.failCreate = false;
    const retried = retryPendingEvents(transport, repo, issueNumber, workdir, { pageSize: 100 });
    expect(retried.some((result) => result.ok)).toBe(true);
    expect(state.comments).toHaveLength(2);
    expect(readPersistedCycleId(workdir)).not.toBe('2bfd8bce-fa3d-47b7-aa02-e85b13432a4c');
    expect(readPendingEvent(workdir, '2bfd8bce-fa3d-47b7-aa02-e85b13432a4c')).toBeNull();
  });

  it.each(['opencode-flow-manager', 'cursor-flow-manager'] as const)(
    'continues to publish a valid %s cycle',
    (publicActor) => {
      const state = createMockGhState({
        issue: { title: 't', body: '<!-- source-revision: r01 -->\nrevision r01', labels: [] },
      });
      const result = startReviewCycle(createMockTransport(state), {
        repo,
        issueNumber,
        sourceRevision: 'r01',
        tier: 'T2',
        publicActor,
        workdir: makeCliTempDir(),
      });
      expect(result.ok, result.diagnostics.map((item) => item.message).join('\n')).toBe(true);
      expect(state.comments).toHaveLength(1);
    },
  );
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


describe('Issue #2009 bind-published-comment', () => {
  const invocationId = 'invocation-slot-01';
  const commentId = 4242;
  const commentUrl = `https://github.com/${repo}/issues/${issueNumber}#issuecomment-${commentId}`;
  const matchingBody = [
    `Read revision: #${issueNumber} r01`,
    `INVOCATION_ID_TO_ECHO: ${invocationId}`,
    'review-economics-contract: v1',
    'NO_FINDINGS',
    'SIMPLIFICATION_CLEAN',
    'FINDING_COUNT: 0',
    '',
  ].join('\n');

  function invocation(slot: string, id: string): Record<string, unknown> {
    return {
      schema: 'reviewer-invocation-envelope/v1',
      reviewEpisodeId: 'episode-2009',
      stageAttemptId: 'attempt-001',
      policyVersion: 'triple-source/v1',
      reviewerCardinality: 3,
      cardinalityConfigIdentity: 'config',
      stage: 'competitive',
      sourceRevision: 'r01',
      invocationId: id,
      reviewerSlot: slot,
      reviewerOrdinal: Number(slot),
      attemptOrdinal: 1,
      retryAttempt: false,
      terminal: true,
      terminalClassification: 'incident',
      sendCount: 0,
      retryClass: 'retry-forbidden',
      revisionCheck: 'matched',
      capacityOutcome: 'admitted',
      capacityWaitMs: 0,
    };
  }

  function headerFor(id: string): string {
    return [
      `Read revision: #${issueNumber} r01`,
      `INVOCATION_ID_TO_ECHO: ${id}`,
      'review-economics-contract: v1',
      'NO_FINDINGS',
      'SIMPLIFICATION_CLEAN',
      'FINDING_COUNT: 0',
      '',
    ].join('\n');
  }

  function writeEvidence(dir: string, extra: Record<string, unknown>[] = [], rows?: Record<string, unknown>[]) {
    const evidencePath = join(dir, 'attempt-001.json');
    writeFileSync(evidencePath, JSON.stringify({
      schema: STAGE_EVIDENCE_SCHEMA,
      tier: 'T3',
      stage: 'competitive',
      stageAttemptId: 'attempt-001',
      stageSequence: 1,
      reviewEpisodeId: 'episode-2009',
      policyVersion: 'triple-source/v1',
      reviewerCardinality: 3,
      cardinalityConfigIdentity: 'config',
      sourceRevision: 'r01',
      outcome: 'incident',
      invocations: rows ?? [invocation('01', invocationId), invocation('02', 'invocation-slot-02'), ...extra],
    }, null, 2) + '\n');
    return evidencePath;
  }

  function commentTransport(body = matchingBody, calls: string[][] = []) {
    return {
      calls,
      transport: {
        runGh(argv: string[]) {
          calls.push(argv);
          if (argv[2] === 'user') return { exitCode: 0, stdout: 'chetwerikoff\n', stderr: '' };
          const path = argv[2] ?? '';
          const match = /\/issues\/comments\/(\d+)$/.exec(path);
          if (argv[0] === 'gh' && argv[1] === 'api' && match && !argv.includes('-X') && !argv.includes('-f')) {
            if (Number(match[1]) !== commentId) return { exitCode: 1, stdout: '', stderr: 'missing' };
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                id: commentId,
                body,
                created_at: '2026-09-22T00:00:00.000Z',
                updated_at: '2026-09-22T00:00:00.000Z',
                html_url: commentUrl,
                issue_url: `https://api.github.com/repos/${repo}/issues/${issueNumber}`,
                user: { login: 'chetwerikoff' },
                author_association: 'OWNER',
              }),
              stderr: '',
            };
          }
          return { exitCode: 1, stdout: '', stderr: `unexpected ${argv.join(' ')}` };
        },
      },
    };
  }

  it('parses the bind-published-comment command', () => {
    const opts = parseStageFinalizeArgs([
      'node', 'scripts/create-issue-stage-finalize.ts', 'bind-published-comment',
      '--repo', repo,
      '--issue-number', String(issueNumber),
      '--review-dir', '/tmp/review',
      '--stage-evidence', '/tmp/review/attempt-001.json',
      '--reviewer-slot', '01',
      '--invocation-id', invocationId,
      '--comment-url', commentUrl,
      '--json',
    ]);
    expect(opts.command).toBe('bind-published-comment');
    expect(opts.reviewerSlot).toBe('01');
    expect(opts.invocationId).toBe(invocationId);
    expect(opts.commentUrl).toBe(commentUrl);
    expect(opts.stageEvidencePaths).toEqual(['/tmp/review/attempt-001.json']);
  });

  it('binds a matching published comment into the named slot with sendCount 1 and does not send', () => {
    const dir = makeCliTempDir();
    const evidencePath = writeEvidence(dir);
    const { transport, calls } = commentTransport();
    const slotTwoBefore = JSON.parse(readFileSync(evidencePath, 'utf8')).invocations[1];

    const result = bindPublishedCommentToSlot({
      reviewDir: dir,
      stageEvidencePath: evidencePath,
      repositoryFullName: repo,
      issueNumber,
      reviewerSlot: '01',
      invocationId,
      commentUrl,
      artifactSourceTransport: transport,
    });
    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(result.sendCount).toBe(1);
    expect(calls.every((argv) => argv[1] === 'api' && !argv.includes('-X') && !argv.includes('-f'))).toBe(true);

    const stored = JSON.parse(readFileSync(evidencePath, 'utf8')) as { invocations: Array<Record<string, unknown>> };
    expect(stored.invocations[0]).toMatchObject({
      reviewerSlot: '01',
      invocationId,
      sendCount: 1,
      terminalClassification: 'incident',
      retryClass: 'retry-forbidden',
      artifactAuthority: {
        kind: 'authoritative-github-artifact',
        commentId,
        commentUrl,
      },
    });
    expect(stored.invocations.filter((row) => row.reviewerSlot === '01')).toHaveLength(1);
    expect(stored.invocations[1]).toEqual(slotTwoBefore);
    expect(stored.invocations).toHaveLength(2);
  });

  it('refuses a comment whose first two non-empty lines are not the revision line and invocation echo', () => {
    const dir = makeCliTempDir();
    const evidencePath = writeEvidence(dir);
    const { transport } = commentTransport([
      'review-economics-contract: v1',
      `Read revision: #${issueNumber} r01`,
      `INVOCATION_ID_TO_ECHO: ${invocationId}`,
      '',
    ].join('\n'));
    const before = readFileSync(evidencePath, 'utf8');
    const result = bindPublishedCommentToSlot({
      reviewDir: dir,
      stageEvidencePath: evidencePath,
      repositoryFullName: repo,
      issueNumber,
      reviewerSlot: '01',
      invocationId,
      commentUrl,
      artifactSourceTransport: transport,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('first two non-empty lines');
    expect(readFileSync(evidencePath, 'utf8')).toBe(before);
  });

  it('creates one invocation row when the named slot has none and leaves the other slot untouched', () => {
    const dir = makeCliTempDir();
    const createdId = 'invocation-slot-03';
    const evidencePath = writeEvidence(dir, [], [invocation('02', 'invocation-slot-02')]);
    const slotTwoBefore = JSON.parse(readFileSync(evidencePath, 'utf8')).invocations[0];
    const { transport, calls } = commentTransport(headerFor(createdId));
    const result = bindPublishedCommentToSlot({
      reviewDir: dir,
      stageEvidencePath: evidencePath,
      repositoryFullName: repo,
      issueNumber,
      reviewerSlot: '03',
      invocationId: createdId,
      commentUrl,
      artifactSourceTransport: transport,
    });
    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(result.sendCount).toBe(1);
    expect(calls.every((argv) => argv[1] === 'api' && !argv.includes('-X') && !argv.includes('-f'))).toBe(true);

    const stored = JSON.parse(readFileSync(evidencePath, 'utf8')) as { invocations: Array<Record<string, unknown>> };
    const created = stored.invocations.filter((row) => row.reviewerSlot === '03');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      schema: 'reviewer-invocation-envelope/v1',
      reviewEpisodeId: 'episode-2009',
      stageAttemptId: 'attempt-001',
      policyVersion: 'triple-source/v1',
      reviewerCardinality: 3,
      cardinalityConfigIdentity: 'config',
      stage: 'competitive',
      sourceRevision: 'r01',
      reviewerSlot: '03',
      reviewerOrdinal: 3,
      invocationId: createdId,
      attemptOrdinal: 1,
      retryAttempt: false,
      sendCount: 1,
      retryClass: 'retry-forbidden',
      artifactAuthority: {
        kind: 'authoritative-github-artifact',
        commentId,
        commentUrl,
        publisherLogin: 'chetwerikoff',
      },
    });
    expect(stored.invocations.find((row) => row.reviewerSlot === '02')).toEqual(slotTwoBefore);
    expect(stored.invocations).toHaveLength(2);
  });

  it('creates the only row when invocations is empty', () => {
    const dir = makeCliTempDir();
    const evidencePath = writeEvidence(dir, [], []);
    const { transport, calls } = commentTransport();
    const result = bindPublishedCommentToSlot({
      reviewDir: dir,
      stageEvidencePath: evidencePath,
      repositoryFullName: repo,
      issueNumber,
      reviewerSlot: '01',
      invocationId,
      commentUrl,
      artifactSourceTransport: transport,
    });
    expect(result.ok, result.errors.join('\n')).toBe(true);
    const stored = JSON.parse(readFileSync(evidencePath, 'utf8')) as { invocations: Array<Record<string, unknown>> };
    expect(stored.invocations).toHaveLength(1);
    expect(stored.invocations[0]).toMatchObject({
      reviewerSlot: '01',
      invocationId,
      sendCount: 1,
    });
    expect(calls.some((argv) => argv.includes('-X') || argv.includes('-f'))).toBe(false);
  });

  it('fails closed when the existing final row has a different invocation id and writes nothing', () => {
    const dir = makeCliTempDir();
    const evidencePath = writeEvidence(dir);
    const before = readFileSync(evidencePath, 'utf8');
    const otherId = 'invocation-other';
    const { transport } = commentTransport(headerFor(otherId));
    const result = bindPublishedCommentToSlot({
      reviewDir: dir,
      stageEvidencePath: evidencePath,
      repositoryFullName: repo,
      issueNumber,
      reviewerSlot: '01',
      invocationId: otherId,
      commentUrl,
      artifactSourceTransport: transport,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('named slot final invocationId does not match --invocation-id');
    expect(readFileSync(evidencePath, 'utf8')).toBe(before);
  });

  it('does not reclassify an existing eligible-zero-send row when the invocation id matches', () => {
    const dir = makeCliTempDir();
    const row = invocation('01', invocationId);
    row.retryClass = 'eligible-zero-send';
    row.sendCount = 0;
    const evidencePath = writeEvidence(dir, [], [row, invocation('02', 'invocation-slot-02')]);
    const beforeOther = JSON.parse(readFileSync(evidencePath, 'utf8')).invocations[1];
    const { transport } = commentTransport();
    const result = bindPublishedCommentToSlot({
      reviewDir: dir,
      stageEvidencePath: evidencePath,
      repositoryFullName: repo,
      issueNumber,
      reviewerSlot: '01',
      invocationId,
      commentUrl,
      artifactSourceTransport: transport,
    });
    expect(result.ok, result.errors.join('\n')).toBe(true);
    const stored = JSON.parse(readFileSync(evidencePath, 'utf8')) as { invocations: Array<Record<string, unknown>> };
    expect(stored.invocations.filter((item) => item.reviewerSlot === '01')).toHaveLength(1);
    expect(stored.invocations[0]).toMatchObject({
      invocationId,
      sendCount: 1,
      retryClass: 'eligible-zero-send',
      terminalClassification: 'incident',
    });
    expect(stored.invocations[1]).toEqual(beforeOther);
  });

  it('derives reviewEpisodeId from tier-intake when the lifecycle seed omits it', () => {
    const dir = makeCliTempDir();
    const taskIdentity = `issue:${issueNumber}`;
    writeFileSync(join(dir, 'tier-intake.json'), JSON.stringify({
      schema: 'tier-intake/v1',
      producer: 'flow-manager',
      taskIdentity,
      kind: 'fresh',
      priorTier: 'T3',
      firstRevision: 'r01',
    }, null, 2) + '\n');
    const evidencePath = join(dir, 'attempt-001.json');
    writeFileSync(evidencePath, JSON.stringify({
      schema: STAGE_EVIDENCE_SCHEMA,
      producer: 'create-issue-stage-finalize/start-cycle',
      taskIdentity,
      tier: 'T3',
      stage: 'competitive',
      stageAttemptId: 'attempt-001',
      stageSequence: 1,
      cycleId: 'cycle-2017',
      cycleBinding: { cycleId: 'cycle-2017', sourceRevision: 'r01', boundBeforeLaunch: true },
      policyVersion: 'triple-source/v1',
      reviewerCardinality: 3,
      cardinalityConfigIdentity: 'config',
      sourceRevision: 'r01',
      invocations: [],
    }, null, 2) + '\n');
    const { transport } = commentTransport();
    const result = bindPublishedCommentToSlot({
      reviewDir: dir,
      stageEvidencePath: evidencePath,
      repositoryFullName: repo,
      issueNumber,
      reviewerSlot: '01',
      invocationId,
      commentUrl,
      artifactSourceTransport: transport,
    });
    expect(result.ok, result.errors.join('\n')).toBe(true);
    const stored = JSON.parse(readFileSync(evidencePath, 'utf8')) as { invocations: Array<Record<string, unknown>> };
    expect(stored.invocations).toHaveLength(1);
    expect(stored.invocations[0]).toMatchObject({
      reviewEpisodeId: `${taskIdentity}@r01`,
      reviewerSlot: '01',
      invocationId,
      sendCount: 1,
      retryClass: 'retry-forbidden',
    });
  });
});

describe('Issue #2039 produce-author-dispositions CLI', () => {
  const producerIssue = 2039;
  const producerRepo = 'chetwerikoff/orchestrator-pack';

  function producerTransport(body: string) {
    return {
      runGh(argv: string[]) {
        const target = argv[2] ?? '';
        if (target === 'repos/' + producerRepo + '/issues/' + producerIssue && argv.includes('--jq')) {
          return { exitCode: 0, stdout: JSON.stringify({ title: 'Issue 2039 fixture', body, labels: [] }), stderr: '' };
        }
        return { exitCode: 1, stdout: '', stderr: 'unexpected ' + argv.join(' ') };
      },
    };
  }

  it('parses and runs the pre-stage T1 producer without creating lifecycle stage effects', () => {
    const opts = parseStageFinalizeArgs([
      'node', 'scripts/create-issue-stage-finalize.ts', 'produce-author-dispositions',
      '--repo', producerRepo,
      '--issue-number', String(producerIssue),
      '--review-dir', '/tmp/review',
      '--source-revision', 'r02',
      '--json',
    ]);
    expect(opts.command).toBe('produce-author-dispositions');
    expect(opts.sourceRevision).toBe('r02');
    expect(opts.reviewDir).toBe('/tmp/review');

    const stateRoot = makeCliTempDir();
    const previous = process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
    process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = stateRoot;
    const reviewDir = join(stateRoot, '.review', String(producerIssue));
    mkdirSync(reviewDir, { recursive: true });
    writeFileSync(join(reviewDir, 'tier-intake.json'), JSON.stringify({
      schema: 'tier-intake/v1',
      producer: 'fixture',
      taskIdentity: 'issue:' + producerIssue,
      kind: 'fresh',
      priorTier: 'T1',
      firstRevision: 'r01',
    }, null, 2) + '\n');
    writeFileSync(join(reviewDir, 'round-02-author-reply.md'), [
      'create-issue-author-dispositions/v1',
      JSON.stringify({
        schema: 'create-issue-author-dispositions/v1',
        sourceRevision: 'r02',
        predecessorStage: null,
        findings: [],
        m4: { inventory: [] },
      }),
      '',
    ].join('\n'));
    const body = '<!-- source-revision: r02 -->\n# Issue 2039 fixture\n';
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => logs.push(String(line)));
    try {
      const code = runStageFinalizeCli([
        'node', 'scripts/create-issue-stage-finalize.ts', 'produce-author-dispositions',
        '--repo', producerRepo,
        '--issue-number', String(producerIssue),
        '--review-dir', reviewDir,
        '--source-revision', 'r02',
        '--json',
      ], producerTransport(body));
      expect(code).toBe(0);
      expect(JSON.parse(logs.at(-1) ?? '{}')).toMatchObject({
        ok: true,
        retryable: false,
        reviewEpisodeId: 'issue:' + producerIssue + '@r01',
        sourceRevision: 'r02',
      });
      expect(JSON.parse(readFileSync(join(reviewDir, 'author-dispositions.json'), 'utf8'))).toMatchObject({
        producer: 'governed-author-output/v1',
        sourceRevision: 'r02',
        predecessorStage: null,
        draft: body,
      });
      expect(JSON.parse(readFileSync(join(reviewDir, 'issue-r02-body.json'), 'utf8'))).toMatchObject({
        schema: 'create-issue-live-snapshot/v1',
        issueNumber: producerIssue,
        sourceRevision: 'r02',
        body,
      });
      expect(existsSync(join(reviewDir, 'attempt-001.json'))).toBe(false);
      expect(existsSync(join(reviewDir, 'finding-disposition-ledger.json'))).toBe(false);
    } finally {
      spy.mockRestore();
      if (previous === undefined) delete process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
      else process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = previous;
    }
  });

  it('returns the bounded requested-next-revision retry classification without writing the handoff', () => {
    const stateRoot = makeCliTempDir();
    const previous = process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
    process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = stateRoot;
    const reviewDir = join(stateRoot, '.review', String(producerIssue));
    mkdirSync(reviewDir, { recursive: true });
    writeFileSync(join(reviewDir, 'tier-intake.json'), JSON.stringify({
      schema: 'tier-intake/v1',
      producer: 'fixture',
      taskIdentity: 'issue:' + producerIssue,
      kind: 'fresh',
      priorTier: 'T1',
      firstRevision: 'r01',
    }, null, 2) + '\n');
    writeFileSync(join(reviewDir, 'round-02-author-reply.txt'), [
      'create-issue-author-dispositions/v1',
      JSON.stringify({
        schema: 'create-issue-author-dispositions/v1',
        sourceRevision: 'r02',
        predecessorStage: null,
        findings: [],
        m4: { inventory: [] },
      }),
    ].join('\n'));
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => logs.push(String(line)));
    try {
      const code = runStageFinalizeCli([
        'node', 'scripts/create-issue-stage-finalize.ts', 'produce-author-dispositions',
        '--repo', producerRepo,
        '--issue-number', String(producerIssue),
        '--review-dir', reviewDir,
        '--source-revision', 'r02',
        '--json',
      ], producerTransport('<!-- source-revision: r01 -->\n# prior\n'));
      expect(code).toBe(1);
      expect(JSON.parse(logs.at(-1) ?? '{}')).toMatchObject({
        ok: false,
        retryable: true,
        cause: 'requested-revision-not-yet-visible',
      });
      expect(existsSync(join(reviewDir, 'issue-r02-body.json'))).toBe(false);
      expect(existsSync(join(reviewDir, 'author-dispositions.json'))).toBe(false);
    } finally {
      spy.mockRestore();
      if (previous === undefined) delete process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
      else process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = previous;
    }
  });
});

describe('create-issue-final-acceptance contract parity', () => {
  it('exports the shared contract version', () => {
    expect(FINAL_ACCEPTANCE_CONTRACT_VERSION).toBe('create-issue-final-acceptance-contract/v1');
  });

  it('resolves operator-pinned published author state from the trusted Issue census', () => {
    const body = [
      'm3-protected: id=published-author-state | revision=r01 | contest=none | outcome=non-activate',
      'author-state: published-author-state',
      'revision: r01',
      '',
    ].join('\n');
    const sha256 = createHash('sha256').update(body).digest('hex');
    const resolved = resolvePublishedAuthorState({
      adjudication: {
        issueNumber: 1192,
        sourceRevision: 'r01',
        verdictUrl: 'https://github.com/chetwerikoff/orchestrator-pack/issues/1192#issuecomment-42',
        verdictSha256: sha256,
        verdictByteLength: Buffer.byteLength(body),
      },
      repo: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1192,
      comments: [trusted(42, body, 'chetwerikoff', '2026-08-26T00:00:00Z')],
    });

    expect(resolved.errors).toEqual([]);
    expect(resolved.state).toEqual({ text: body, sha256, byteLength: Buffer.byteLength(body) });
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

  it('rejects an external receipt chain before final acceptance guards run', () => {
    const state = createMockGhState({ issue: { title: 't', body: '<!-- source-revision: r01 -->\nissue body', labels: [] } });
    const transport = createMockTransport(state);
    const workdir = makeTempDir();
    const started = startReviewCycle(transport, {
      repo,
      issueNumber,
      sourceRevision: 'r01',
      tier: 'T1',
      publicActor: 'cursor-flow-manager',
      workdir,
    });
    const external = join(workdir, 'external');
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, 'tier-intake.json'), JSON.stringify({
      schema: 'tier-intake/v1',
      producer: 'flow-manager',
      taskIdentity: String(issueNumber),
      kind: 'fresh',
      priorTier: 'T1',
      firstRevision: 'r01',
    }));
    const receiptPath = join(external, 'stage-completeness-receipt-1.json');
    writeFileSync(receiptPath, '{}');

    const result = runFinalAcceptance(transport, {
      repo,
      issueNumber,
      publicActor: 'cursor-flow-manager',
      workdir,
      issueBody: state.issue.body,
      issueRevision: 'r01',
      cycleId: started.cycleId!,
      tier: 'T1',
      reviewDir: external,
      stageReceiptPaths: [receiptPath],
      capturePaths: [],
    });

    expect(result.ok).toBe(false);
    expect(result.guardErrors.join('\n')).toContain('legacy_receipt_location_blocked');
  });

  it('refuses journal publication when exact body validation fails at the write boundary', () => {
    const state = createMockGhState({ issue: { title: 't', body: 'issue revision r01 body', labels: [] } });
    const reviewedBody = state.issue.body;
    const logical: CycleEventLogical = {
      schema: CYCLE_SCHEMA,
      'event-key': 'cycle-publication-race',
      'cycle-id': 'cycle-publication-race',
      'predecessor-cycle-id': 'none',
      'source-revision': 'r01',
      tier: 'T1',
      'public-actor': 'cursor-flow-manager',
    };

    const result = publishLogicalJournalEvent(
      createMockTransport(state),
      repo,
      issueNumber,
      makeTempDir(),
      logical,
      undefined,
      () => {
        state.issue.body += ' ';
        return { ok: validatePublishBodyBinding(reviewedBody, state.issue.body).length === 0, diagnostics: [] };
      },
    );

    expect(result.ok).toBe(false);
    expect(state.comments).toHaveLength(0);
  });

  it('runs the three acceptance guards while cycle witness mismatch is audit-only', () => {
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
    expect(result.errors.some((error) => error.startsWith('cycle-binding:'))).toBe(false);
  });
});

describe('Issue #1171 exact terminal body binding', () => {
  it('rejects exact body drift introduced between the initial read and publication', () => {
    let issueBody = 'issue revision r01 body';
    const reviewedBody = issueBody;
    issueBody += ' ';

    const errors = validatePublishBodyBinding(reviewedBody, issueBody);

    expect(errors.join('\n')).toContain('terminal source body byteLength mismatch');
  });

  it('rejects a one-byte terminal candidate drift instead of using semantic equivalence', () => {
    const result = executeFinalAcceptanceGuards({
      issueBody: 'reviewed body\n',
      currentIssueBody: 'reviewed body',
      issueRevision: 'r01',
      cycleId: 'cycle-1',
      reviewDir: '/tmp/review',
      stageReceiptPaths: [],
      capturePaths: [],
    });
    expect(result.errors.join('\n')).toContain('terminal source body byteLength mismatch');
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


describe('poisoned canonical deterministic attempt stays terminal (Issue #1999)', () => {
  const fixturePath = join(
    fileURLToPath(new URL('../..', import.meta.url)),
    'tests/external-output-references/create-issue-1977-poisoned-canonical-attempt.json',
  );
  const issueNumber = 91999;

  function writeCanonicalAttempt(stateRoot: string): { reviewDir: string; evidencePath: string; bytes: string } {
    const reviewDir = join(stateRoot, '.review', String(issueNumber));
    mkdirSync(reviewDir, { recursive: true });
    const evidencePath = join(reviewDir, 'attempt-001.json');
    const bytes = readFileSync(fixturePath, 'utf8');
    writeFileSync(evidencePath, bytes);
    return { reviewDir, evidencePath, bytes };
  }

  it('start-cycle and read-only reconcile-stage return nextAction null and keep the canonical stageAttemptId', () => {
    const stateRoot = makeCliTempDir();
    const previous = process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
    process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = stateRoot;
    const prepared = writeCanonicalAttempt(stateRoot);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });
    try {
      const startCode = runStageFinalizeCli([
        'node', 'scripts/create-issue-stage-finalize.ts', 'start-cycle',
        '--repo', 'chetwerikoff/orchestrator-pack',
        '--issue-number', String(issueNumber),
        '--source-revision', 'r04',
        '--stage', 'competitive',
        '--tier', 'T2',
        '--public-actor', 'cursor-flow-manager',
        '--json',
      ]);
      expect(startCode).toBe(1);
      const started = JSON.parse(logs.at(-1) ?? '') as {
        nextAction: unknown;
        stageAttemptId: string;
        reason: { class: string; code: string };
      };
      expect(started.nextAction).toBeNull();
      expect(started.stageAttemptId).toBe('1977-poisoned-canonical-attempt');
      expect(started.reason).toMatchObject({ class: 'deterministic-input', code: 'input_invalid' });

      const reviewDir = makeCliTempDir();
      const evidencePath = join(reviewDir, 'attempt-001.json');
      writeFileSync(evidencePath, prepared.bytes);
      const reconcileCode = runStageFinalizeCli([
        'node', 'scripts/create-issue-stage-finalize.ts', 'reconcile-stage',
        '--repo', 'chetwerikoff/orchestrator-pack',
        '--issue-number', String(issueNumber),
        '--review-dir', reviewDir,
        '--stage-evidence', evidencePath,
        '--json',
      ]);
      expect(reconcileCode).toBe(1);
      const reconciled = JSON.parse(logs.at(-1) ?? '') as {
        nextAction: unknown;
        stageAttemptId: string;
      };
      expect(reconciled.nextAction).toBeNull();
      expect(reconciled.stageAttemptId).toBe('1977-poisoned-canonical-attempt');
      expect(readFileSync(evidencePath, 'utf8')).toBe(prepared.bytes);
      expect(readFileSync(prepared.evidencePath, 'utf8')).toBe(prepared.bytes);
    } finally {
      spy.mockRestore();
      if (previous === undefined) delete process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
      else process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = previous;
    }
  });

  it('does not call GitHub or replace the canonical attempt from startReviewCycle', () => {
    const stateRoot = makeCliTempDir();
    const prepared = writeCanonicalAttempt(stateRoot);
    let ghCalls = 0;
    const result = startReviewCycle({
      runGh() {
        ghCalls += 1;
        return { exitCode: 1, stdout: '', stderr: 'must not be called' };
      },
    }, {
      repo: 'chetwerikoff/orchestrator-pack',
      issueNumber,
      sourceRevision: 'r04',
      stage: 'competitive',
      tier: 'T2',
      publicActor: 'cursor-flow-manager',
      stateRootOverride: stateRoot,
      workdir: makeCliTempDir(),
    });
    expect(result.ok).toBe(false);
    expect(result.stageAttemptId).toBe('1977-poisoned-canonical-attempt');
    expect(ghCalls).toBe(0);
    expect(readFileSync(prepared.evidencePath, 'utf8')).toBe(prepared.bytes);
  });
});

describe('Issue #2032 reconcile-stage next action for noncanonical publications', () => {
  const repo = 'chetwerikoff/orchestrator-pack';
  const issueNumber = 2024;
  const revision = 'r01';
  const stageAttemptId = 'architectural-review-attempt';
  const slot01Invocation = '85ab4287-059b-42cd-a182-a905d58d8f0c';
  const slot02Invocation = '1068e8ee-878f-402d-8f0a-e2be130263cc';
  const slot03Invocation = '1a3acb31-b9f8-4f8d-8350-22ca4c3e5372';

  function findingsBody(invocationId: string, verdict: 'FINDINGS' | 'findings'): string {
    return [
      `Read revision: #${issueNumber} ${revision}`,
      'review-economics-contract: v1',
      `VERDICT: ${verdict}`,
      'simplification-cut-candidate: yes',
      'FINDING_COUNT: 1',
      `INVOCATION_ID_TO_ECHO: ${invocationId}`,
      'id: finding-one',
      '',
    ].join('\n');
  }

  function ghComment(id: number, body: string, login = 'chetwerikoff'): Record<string, unknown> {
    const createdAt = '2026-09-21T00:00:00Z';
    return {
      id,
      html_url: `https://github.com/${repo}/issues/${issueNumber}#issuecomment-${id}`,
      issue_url: `https://api.github.com/repos/${repo}/issues/${issueNumber}`,
      body,
      created_at: createdAt,
      updated_at: createdAt,
      author_association: 'OWNER',
      user: { login },
    };
  }

  function censusTransport(
    comments: Record<string, unknown>[],
    mode: 'complete' | 'census-down' | 'identity-down' = 'complete',
  ): GhTransport {
    return {
      runGh(argv: string[]) {
        const target = argv[2] ?? '';
        if (target === 'user') {
          if (mode === 'identity-down') return { exitCode: 1, stdout: '', stderr: 'principal unavailable' };
          return { exitCode: 0, stdout: 'chetwerikoff\n', stderr: '' };
        }
        if (target === `repos/${repo}/issues/${issueNumber}` && argv.includes('--jq')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              title: 'Issue 2032 fixture',
              body: `<!-- source-revision: ${revision} -->\n`,
              labels: [],
            }),
            stderr: '',
          };
        }
        if (target.startsWith(`repos/${repo}/issues/${issueNumber}/comments?`)) {
          if (mode === 'census-down') return { exitCode: 1, stdout: '', stderr: 'census unavailable' };
          const page = Number(new URLSearchParams(target.split('?')[1] ?? '').get('page') ?? '1');
          return { exitCode: 0, stdout: JSON.stringify(page === 1 ? comments : []), stderr: '' };
        }
        if (target.includes('/issues/comments/')) {
          const id = Number(target.split('/').at(-1));
          const comment = comments.find((item) => Number(item.id) === id);
          if (!comment) return { exitCode: 1, stdout: '', stderr: `missing comment ${id}` };
          return { exitCode: 0, stdout: JSON.stringify(comment), stderr: '' };
        }
        return { exitCode: 1, stdout: '', stderr: `unexpected gh call: ${argv.join(' ')}` };
      },
    };
  }

  function evidenceFor(slots: Array<{ slot: string; invocationId: string }>): Record<string, unknown> {
    return {
      schema: STAGE_EVIDENCE_SCHEMA,
      tier: 'T2',
      stage: 'architectural-review',
      stageAttemptId,
      stageSequence: 1,
      sourceRevision: revision,
      reviewerCardinality: slots.length,
      invocations: slots.map((slot, index) => ({
        schema: 'reviewer-invocation-envelope/v1',
        stage: 'architectural-review',
        stageAttemptId,
        sourceRevision: revision,
        invocationId: slot.invocationId,
        reviewerSlot: slot.slot,
        reviewerOrdinal: index + 1,
        attemptOrdinal: 1,
        retryAttempt: false,
        terminal: true,
        terminalClassification: 'incident',
        sendCount: 1,
        retryClass: 'retry-forbidden',
      })),
    };
  }

  function reconcile(
    slots: Array<{ slot: string; invocationId: string }>,
    comments: Record<string, unknown>[],
    mode: 'complete' | 'census-down' | 'identity-down' = 'complete',
  ) {
    const reviewDir = makeCliTempDir();
    const evidencePath = join(reviewDir, 'attempt-001.json');
    writeFileSync(evidencePath, JSON.stringify(evidenceFor(slots)));
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });
    try {
      const code = runStageFinalizeCli([
        'node', 'scripts/create-issue-stage-finalize.ts', 'reconcile-stage',
        '--repo', repo,
        '--issue-number', String(issueNumber),
        '--review-dir', reviewDir,
        '--stage-evidence', evidencePath,
        '--json',
      ], censusTransport(comments, mode));
      return {
        code,
        output: JSON.parse(logs.at(-1) ?? '{}') as {
          ok: boolean;
          cause?: string;
          temporary?: string;
          blocker?: string;
          errors?: string[];
          nextAction: { kind?: string; argv?: string[] } | null;
        },
      };
    } finally {
      spy.mockRestore();
    }
  }

  const oneSlot = [{ slot: '01', invocationId: slot01Invocation }];

  it('keeps a complete census with no bound publication on the read-only reconcile continuation', () => {
    const result = reconcile(oneSlot, []);
    expect(result.code).toBe(1);
    expect(result.output.ok).toBe(false);
    expect(result.output.nextAction?.kind).toBe('reconcile-stage-read-only');
    expect(result.output.nextAction?.argv).toContain('reconcile-stage');
    expect(result.output.nextAction?.argv).toContain(stageAttemptId);
    expect(result.output.errors?.join('\n')).toContain('zero_principal_owned_match');
  });

  it('keeps a temporary census failure on the read-only reconcile continuation', () => {
    const result = reconcile(oneSlot, [], 'census-down');
    expect(result.code).toBe(1);
    expect(result.output.temporary).toBe('source-unavailable');
    expect(result.output.nextAction?.kind).toBe('reconcile-stage-read-only');
  });

  it('keeps an unresolved principal on the read-only reconcile continuation', () => {
    const result = reconcile(oneSlot, [], 'identity-down');
    expect(result.code).toBe(1);
    expect(result.output.temporary).toBe('identity-unresolved');
    expect(result.output.nextAction?.kind).toBe('reconcile-stage-read-only');
  });

  it.each([
    [5772579436, slot01Invocation],
    [5772564705, slot03Invocation],
  ])('returns nextAction null for permanently noncanonical publication %s', (commentId, invocationId) => {
    const result = reconcile([{ slot: '01', invocationId }], [
      ghComment(commentId, findingsBody(invocationId, 'findings')),
    ]);
    const errors = result.output.errors?.join('\n') ?? '';
    expect(result.code).toBe(1);
    expect(result.output.nextAction).toBeNull();
    expect(result.output.cause).toBe('reconciliation_failed');
    expect(errors).toContain('permanently_noncanonical_publication');
    expect(errors).not.toContain('zero_principal_owned_match');
    expect(errors).not.toContain('authoritative GitHub artifact absent');
    expect(result.output.blocker).not.toContain('reconcile-stage');
  });

  it('returns nextAction null for lowercase VERDICT even without a raw finding id', () => {
    const body = findingsBody(slot01Invocation, 'findings')
      .split(/\r?\n/)
      .filter((line) => !/^id:\s*/i.test(line.trim()))
      .join('\n');
    const result = reconcile(oneSlot, [ghComment(5772579436, body)]);
    const errors = result.output.errors?.join('\n') ?? '';
    expect(body).not.toMatch(/^id:\s*/im);
    expect(result.code).toBe(1);
    expect(result.output.nextAction).toBeNull();
    expect(result.output.cause).toBe('reconciliation_failed');
    expect(errors).toContain('permanently_noncanonical_publication');
    expect(errors).not.toContain('zero_principal_owned_match');
  });

  it('does not return the same reconcile argv for the Issue #2024 mixed slot shape', () => {
    const slots = [
      { slot: '01', invocationId: slot01Invocation },
      { slot: '02', invocationId: slot02Invocation },
      { slot: '03', invocationId: slot03Invocation },
    ];
    const result = reconcile(slots, [
      ghComment(5772579436, findingsBody(slot01Invocation, 'findings')),
      ghComment(5772585168, findingsBody(slot02Invocation, 'FINDINGS')),
      ghComment(5772564705, findingsBody(slot03Invocation, 'findings')),
    ]);
    const errors = result.output.errors?.join('\n') ?? '';
    expect(result.code).toBe(1);
    expect(result.output.nextAction).toBeNull();
    expect(errors).toContain(`invocationId=${slot01Invocation}`);
    expect(errors).not.toContain(`invocationId=${slot02Invocation}`);
    expect(errors).not.toContain('zero_principal_owned_match');
  });
});
