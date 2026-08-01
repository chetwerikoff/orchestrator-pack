import { randomUUID } from 'node:crypto';
import { buildCanonicalLineage, hasBlockingLineageConflict } from './create-issue-stage-record-lineage.ts';
import {
  logicalFingerprint,
  serializeCommentBody,
} from './create-issue-stage-record-marker.ts';
import {
  clearPendingEvent,
  createIssueComment,
  defaultWorkdir,
  ensureProjectionLabels,
  fetchIssueComments,
  fetchIssueRevision,
  fetchRepositoryOwnerLogin,
  listPendingEvents,
  parseJournalEvents,
  persistCycleId,
  readPendingEvent,
  readPersistedCycleId,
  syncIssueProjectionLabels,
  writePendingEvent,
} from './create-issue-stage-record-gh.ts';
import {
  parseConsumableStageReceipt,
  validateReceiptMatchesCycle,
} from './create-issue-stage-record-receipt.ts';
import type {
  CommentCensusOptions,
  ConsumableStageReceipt,
  CycleEventLogical,
  GhTransport,
  LineageDiagnostic,
  PublicActor,
  StageEventLogical,
} from './create-issue-stage-record-types.ts';
import {
  CYCLE_SCHEMA,
  PROJECTION_IN_PROGRESS,
  STAGE_SCHEMA,
} from './create-issue-stage-record-types.ts';

export interface StartCycleInput {
  repo: string;
  issueNumber: number;
  sourceRevision: string;
  tier: string;
  publicActor: PublicActor;
  predecessorCycleId?: string;
  workdir?: string;
  census?: CommentCensusOptions;
}

export interface PublishStageInput {
  repo: string;
  issueNumber: number;
  receipt: unknown;
  waiverPath?: string;
  workdir?: string;
  census?: CommentCensusOptions;
  readJson?: (path: string) => unknown;
}

export interface OperationResult {
  ok: boolean;
  diagnostics: LineageDiagnostic[];
  cycleId?: string;
  eventKey?: string;
  projectionPendingRepair?: boolean;
}

function resolveWorkdir(issueNumber: number, workdir?: string): string {
  return workdir ?? defaultWorkdir(issueNumber);
}

function loadCensus(
  transport: GhTransport,
  repo: string,
  issueNumber: number,
  census?: CommentCensusOptions,
) {
  const ownerLogin = fetchRepositoryOwnerLogin(transport, repo);
  const fetched = fetchIssueComments(transport, repo, issueNumber, ownerLogin, census);
  const parsed = parseJournalEvents(fetched.comments);
  const lineage = buildCanonicalLineage(parsed.events);
  return {
    ownerLogin,
    fetched,
    parsed,
    lineage,
    diagnostics: [...fetched.diagnostics, ...parsed.diagnostics, ...lineage.diagnostics],
  };
}

function confirmCanonicalEvent(
  transport: GhTransport,
  repo: string,
  issueNumber: number,
  eventKey: string,
  fingerprint: string,
  census?: CommentCensusOptions,
): { confirmed: boolean; diagnostics: LineageDiagnostic[] } {
  const censusState = loadCensus(transport, repo, issueNumber, census);
  if (!censusState.fetched.commentsComplete) {
    return {
      confirmed: false,
      diagnostics: [...censusState.diagnostics, {
        code: 'comments-truncated',
        message: 'cannot confirm event without complete comment census',
        eventKey,
      }],
    };
  }
  const event = censusState.lineage.eventsByKey.get(eventKey);
  if (!event || event.fingerprint !== fingerprint) {
    return {
      confirmed: false,
      diagnostics: [...censusState.diagnostics, {
        code: 'malformed-marker',
        message: `canonical event ${eventKey} not confirmed`,
        eventKey,
      }],
    };
  }
  if (hasBlockingLineageConflict(censusState.lineage, eventKey)) {
    return {
      confirmed: false,
      diagnostics: censusState.diagnostics,
    };
  }
  return { confirmed: true, diagnostics: censusState.diagnostics };
}

export function publishJournalEvent(
  transport: GhTransport,
  repo: string,
  issueNumber: number,
  workdir: string,
  body: string,
  schema: string,
  eventKey: string,
  fingerprint: string,
  census?: CommentCensusOptions,
): OperationResult {
  const diagnostics: LineageDiagnostic[] = [];
  const censusState = loadCensus(transport, repo, issueNumber, census);
  diagnostics.push(...censusState.diagnostics);
  if (!censusState.fetched.commentsComplete) {
    writePendingEvent(workdir, {
      schema,
      eventKey,
      body,
      createdAt: new Date().toISOString(),
      delivery: 'delayed',
    });
    return { ok: false, diagnostics, eventKey };
  }
  const existing = censusState.lineage.eventsByKey.get(eventKey);
  if (existing) {
    if (existing.fingerprint === fingerprint) {
      clearPendingEvent(workdir, eventKey);
      return { ok: true, diagnostics, eventKey };
    }
    diagnostics.push({
      code: schema === CYCLE_SCHEMA ? 'conflicting-cycle-id' : 'conflicting-remote-event',
      message: `conflicting event ${eventKey}`,
      eventKey,
    });
    return { ok: false, diagnostics, eventKey };
  }

  writePendingEvent(workdir, {
    schema,
    eventKey,
    body,
    createdAt: new Date().toISOString(),
    delivery: 'immediate',
  });
  const created = createIssueComment(transport, repo, issueNumber, body);
  if (!created.ok) {
    diagnostics.push({
      code: 'comments-truncated',
      message: `comment create failed for ${eventKey}`,
      eventKey,
    });
    return { ok: false, diagnostics, eventKey, projectionPendingRepair: true };
  }
  const confirmed = confirmCanonicalEvent(transport, repo, issueNumber, eventKey, fingerprint, census);
  diagnostics.push(...confirmed.diagnostics);
  if (!confirmed.confirmed) {
    return { ok: false, diagnostics, eventKey, projectionPendingRepair: true };
  }
  clearPendingEvent(workdir, eventKey);
  return { ok: true, diagnostics, eventKey };
}

export function retryPendingEvents(
  transport: GhTransport,
  repo: string,
  issueNumber: number,
  workdir: string,
  census?: CommentCensusOptions,
): OperationResult[] {
  const pending = listPendingEvents(workdir);
  const results: OperationResult[] = [];
  for (const item of pending) {
    const logical = JSON.parse(item.body.match(/```json\s*([\s\S]*?)\s*```/i)?.[1] ?? 'null');
    const fingerprint = logicalFingerprint(logical);
    results.push(publishJournalEvent(
      transport,
      repo,
      issueNumber,
      workdir,
      item.body,
      item.schema,
      item.eventKey,
      fingerprint,
      census,
    ));
  }
  return results;
}

export function startReviewCycle(
  transport: GhTransport,
  input: StartCycleInput,
): OperationResult {
  const workdir = resolveWorkdir(input.issueNumber, input.workdir);
  const diagnostics: LineageDiagnostic[] = [];
  diagnostics.push(...ensureProjectionLabels(transport, input.repo));

  const persisted = readPersistedCycleId(workdir) ?? randomUUID();
  persistCycleId(workdir, persisted);

  const censusState = loadCensus(transport, input.repo, input.issueNumber, input.census);
  diagnostics.push(...censusState.diagnostics);
  if (!censusState.fetched.commentsComplete) {
    return { ok: false, diagnostics };
  }

  let predecessor = input.predecessorCycleId;
  if (!predecessor) {
    const existing = censusState.lineage.eventsByKey.get(persisted);
    if (existing?.logical.schema === CYCLE_SCHEMA) {
      predecessor = (existing.logical as CycleEventLogical)['predecessor-cycle-id'];
    } else if (censusState.lineage.head?.logical.schema === CYCLE_SCHEMA) {
      const headId = (censusState.lineage.head.logical as CycleEventLogical)['cycle-id'];
      predecessor = headId === persisted ? 'none' : headId;
    } else {
      predecessor = 'none';
    }
  }

  const logical: CycleEventLogical = {
    schema: CYCLE_SCHEMA,
    'event-key': persisted,
    'cycle-id': persisted,
    'predecessor-cycle-id': predecessor,
    'source-revision': input.sourceRevision,
    tier: input.tier,
    'public-actor': input.publicActor,
  };
  const body = serializeCommentBody(logical);
  const fingerprint = logicalFingerprint(logical);
  const published = publishJournalEvent(
    transport,
    input.repo,
    input.issueNumber,
    workdir,
    body,
    CYCLE_SCHEMA,
    persisted,
    fingerprint,
    input.census,
  );
  diagnostics.push(...published.diagnostics);
  if (!published.ok) {
    return { ok: false, diagnostics, cycleId: persisted, eventKey: persisted };
  }

  const issue = fetchIssueRevision(transport, input.repo, input.issueNumber);
  const head = loadCensus(transport, input.repo, input.issueNumber, input.census).lineage.head;
  const headCycleId = head?.logical.schema === CYCLE_SCHEMA
    ? (head.logical as CycleEventLogical)['cycle-id']
    : persisted;
  if (headCycleId !== persisted) {
    diagnostics.push({
      code: 'orphan-cycle',
      message: 'cycle head drift after publication',
      eventKey: persisted,
    });
    return { ok: false, diagnostics, cycleId: persisted, eventKey: persisted };
  }
  if (!issue.body.includes(input.sourceRevision)) {
    diagnostics.push({
      code: 'conflicting-remote-event',
      message: 'issue revision drift detected before projection',
    });
    return { ok: false, diagnostics, cycleId: persisted, eventKey: persisted, projectionPendingRepair: true };
  }

  const projection = syncIssueProjectionLabels(
    transport,
    input.repo,
    input.issueNumber,
    PROJECTION_IN_PROGRESS,
    issue.labels,
  );
  diagnostics.push(...projection.diagnostics);
  return {
    ok: projection.ok,
    diagnostics,
    cycleId: persisted,
    eventKey: persisted,
    projectionPendingRepair: projection.pendingRepair,
  };
}

export function publishSettledStageRecord(
  transport: GhTransport,
  input: PublishStageInput,
): OperationResult {
  const workdir = resolveWorkdir(input.issueNumber, input.workdir);
  const diagnostics: LineageDiagnostic[] = [];
  const parsedReceipt = parseConsumableStageReceipt(input.receipt);
  diagnostics.push(...parsedReceipt.errors.map((message) => ({
    code: 'malformed-marker' as const,
    message,
  })));
  if (!parsedReceipt.receipt) {
    return { ok: false, diagnostics };
  }
  const receipt = parsedReceipt.receipt;
  const censusState = loadCensus(transport, input.repo, input.issueNumber, input.census);
  diagnostics.push(...censusState.diagnostics);
  if (!censusState.fetched.commentsComplete) {
    return { ok: false, diagnostics };
  }
  const head = censusState.lineage.head;
  if (!head || head.logical.schema !== CYCLE_SCHEMA) {
    diagnostics.push({ code: 'orphan-cycle', message: 'no canonical cycle head' });
    return { ok: false, diagnostics };
  }
  const headCycle = head.logical as CycleEventLogical;
  diagnostics.push(...validateReceiptMatchesCycle(receipt, headCycle['cycle-id'], headCycle['source-revision']).map((message) => ({
    code: 'conflicting-remote-event' as const,
    message,
  })));
  if (diagnostics.some((item) => item.code === 'conflicting-remote-event')) {
    return { ok: false, diagnostics, cycleId: headCycle['cycle-id'] };
  }

  const eventKey = `${receipt.cycleId}:${receipt.stage}:${receipt.stageAttemptId}`;
  const logical: StageEventLogical = {
    schema: STAGE_SCHEMA,
    'event-key': eventKey,
    'cycle-id': receipt.cycleId,
    stage: receipt.stage,
    tier: receipt.tier,
    'source-revision': receipt.sourceRevision,
    'stage-attempt-id': receipt.stageAttemptId,
    'policy-version': receipt.policyVersion,
    'settled-outcome': receipt.outcome,
    'source-count': receipt.completedSourceCount,
    'required-source-count': receipt.reviewerCardinality,
    'producer-evidence': receipt.producerEvidence,
    'tier-transition': receipt.tierTransition,
  };
  const body = serializeCommentBody(logical);
  const fingerprint = logicalFingerprint(logical);
  const published = publishJournalEvent(
    transport,
    input.repo,
    input.issueNumber,
    workdir,
    body,
    STAGE_SCHEMA,
    eventKey,
    fingerprint,
    input.census,
  );
  diagnostics.push(...published.diagnostics);
  return {
    ok: published.ok,
    diagnostics,
    cycleId: receipt.cycleId,
    eventKey,
    projectionPendingRepair: published.projectionPendingRepair,
  };
}

export function detectAcceptedRevisionDrift(
  transport: GhTransport,
  repo: string,
  issueNumber: number,
  acceptedRevision: string,
  census?: CommentCensusOptions,
): boolean {
  const issue = fetchIssueRevision(transport, repo, issueNumber);
  if (!issue.labels.includes('spec-review:accepted')) return false;
  return !issue.body.includes(acceptedRevision);
}

export {
  parseConsumableStageReceipt,
  validateReceiptMatchesCycle,
  type ConsumableStageReceipt,
};
