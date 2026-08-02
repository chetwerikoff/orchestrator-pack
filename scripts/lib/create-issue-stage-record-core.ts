import { randomUUID } from 'node:crypto';
import { hasBlockingLineageConflict } from './create-issue-stage-record-lineage.ts';
import {
  logicalFingerprint,
  serializeCommentBody,
} from './create-issue-stage-record-marker.ts';
import {
  clearPendingEvent,
  createIssueComment,
  defaultWorkdir,
  GH_TIMEOUT_MS,
  GhTransportError,
  ensureProjectionLabels,
  fetchIssueRevision,
  listPendingEvents,
  loadIssueJournalCensus,
  parseJournalEvents,
  persistCycleId,
  readPendingEvent,
  readPersistedCycleId,
  syncIssueProjectionLabels,
  withGhDeadline,
  writePendingEvent,
} from './create-issue-stage-record-gh.ts';
import {
  parseConsumableStageReceipt,
  readEvidenceWaiverProducerEvidence,
  validateReceiptMatchesCycle,
} from './create-issue-stage-record-receipt.ts';
import type {
  CommentCensusOptions,
  ConsumableStageReceipt,
  CycleEventLogical,
  GhFailure,
  GhTransport,
  JournalLogical,
  OperationTerminal,
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
  terminal?: OperationTerminal;
}

function resolveWorkdir(issueNumber: number, workdir?: string): string {
  return workdir ?? defaultWorkdir(issueNumber);
}

function pendingFailure(
  workdir: string,
  event: { schema: string; eventKey: string; body: string },
  failureClass: string,
): void {
  const previous = readPendingEvent(workdir, event.eventKey);
  writePendingEvent(workdir, {
    ...event,
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    delivery: 'delayed',
    deliveryFailureClass: failureClass,
    firstFailureAt: previous?.firstFailureAt ?? new Date().toISOString(),
  });
}

function failureFromError(error: unknown): GhFailure {
  if (error instanceof GhTransportError) {
    return { kind: error.failureKind, message: error.message };
  }
  return {
    kind: 'transport',
    message: error instanceof Error ? error.message : String(error),
  };
}

function terminalForCensusFailure(
  failure: GhFailure | undefined,
  remedy: string,
  owner: string,
): OperationTerminal {
  const kind = failure?.kind ?? 'transport';
  return {
    outcome: kind === 'terminal-refusal' ? 'refused' : 'blocked',
    cause: !failure
      ? 'census-incomplete'
      : kind === 'timeout'
        ? 'publication-timeout'
        : kind === 'terminal-refusal'
          ? 'terminal-refusal'
          : 'transport-failure',
    remedy,
    owner,
    deadline: 'GH_TIMEOUT_MS = 10_000 ms',
  };
}

function pendingFailureClass(failure: GhFailure | undefined): string {
  if (failure?.kind === 'timeout') return 'publication-timeout';
  if (failure?.kind === 'terminal-refusal') return 'terminal-refusal';
  return failure ? 'census-transport' : 'census-incomplete';
}

function censusFailureResult(
  diagnostics: LineageDiagnostic[],
  error: unknown,
  context: string,
  options: {
    eventKey?: string;
    workdir?: string;
    event?: { schema: string; eventKey: string; body: string };
    projectionPendingRepair?: boolean;
    failure?: GhFailure;
    owner?: string;
    remedy?: string;
  } = {},
): OperationResult {
  const failure = options.failure ?? (error === undefined ? undefined : failureFromError(error));
  if (options.workdir && options.event) {
    pendingFailure(options.workdir, options.event, pendingFailureClass(failure));
  }
  const terminal = terminalForCensusFailure(
    failure,
    options.remedy ?? 'Record the named census failure and repair the existing GitHub transport or observation surface before retrying.',
    options.owner ?? 'flow-manager',
  );
  const message = failure?.message ?? 'comment census did not complete';
  return {
    ok: false,
    diagnostics: [...diagnostics, {
      code: 'comments-truncated',
      message: `${context}; terminal outcome: ${terminal.outcome}: ${message}`,
      ...(options.eventKey ? { eventKey: options.eventKey } : {}),
    }],
    ...(options.eventKey ? { eventKey: options.eventKey } : {}),
    ...(options.projectionPendingRepair ? { projectionPendingRepair: true } : {}),
    terminal,
  };
}



export function appendPublishedLogicalJournalEvent(
  diagnostics: LineageDiagnostic[],
  transport: GhTransport,
  repo: string,
  issueNumber: number,
  workdir: string,
  logical: JournalLogical,
  census?: CommentCensusOptions,
  beforeCreate?: () => { ok: boolean; diagnostics?: LineageDiagnostic[] },
): OperationResult {
  const published = publishLogicalJournalEvent(transport, repo, issueNumber, workdir, logical, census, beforeCreate);
  diagnostics.push(...published.diagnostics);
  return published;
}

export function publishLogicalJournalEvent(
  transport: GhTransport,
  repo: string,
  issueNumber: number,
  workdir: string,
  logical: JournalLogical,
  census?: CommentCensusOptions,
  beforeCreate?: () => { ok: boolean; diagnostics?: LineageDiagnostic[] },
): OperationResult {
  const body = serializeCommentBody(logical);
  const fingerprint = logicalFingerprint(logical);
  return publishJournalEvent(
    transport,
    repo,
    issueNumber,
    workdir,
    body,
    logical.schema,
    logical['event-key'],
    fingerprint,
    census,
    beforeCreate,
  );
}

function confirmCanonicalEvent(
  transport: GhTransport,
  repo: string,
  issueNumber: number,
  eventKey: string,
  fingerprint: string,
  census?: CommentCensusOptions,
): { confirmed: boolean; diagnostics: LineageDiagnostic[]; failure?: GhFailure } {
  const censusState = loadIssueJournalCensus(transport, repo, issueNumber, census);
  if (!censusState.fetched.commentsComplete) {
    return {
      confirmed: false,
      diagnostics: [...censusState.diagnostics, {
        code: 'comments-truncated',
        message: 'cannot confirm event without complete comment census',
        eventKey,
      }],
      failure: censusState.fetched.failure,
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
  beforeCreate?: () => { ok: boolean; diagnostics?: LineageDiagnostic[] },
): OperationResult {
  const diagnostics: LineageDiagnostic[] = [];
  const publicationDeadline = Date.now() + GH_TIMEOUT_MS;
  const publicationTransport = withGhDeadline(transport, publicationDeadline);
  let censusState: ReturnType<typeof loadIssueJournalCensus>;
  try {
    censusState = loadIssueJournalCensus(publicationTransport, repo, issueNumber, census);
  } catch (error) {
    return censusFailureResult(diagnostics, error, 'publication census', {
      eventKey,
      workdir,
      event: { schema, eventKey, body },
      projectionPendingRepair: true,
      owner: 'exception publisher',
    });
  }
  diagnostics.push(...censusState.diagnostics);
  if (!censusState.fetched.commentsComplete) {
    return censusFailureResult(diagnostics, undefined, 'publication census', {
      eventKey,
      workdir,
      event: { schema, eventKey, body },
      projectionPendingRepair: true,
      failure: censusState.fetched.failure,
      owner: 'exception publisher',
    });
  }
  if (censusState.parsed.diagnostics.some((item) => item.code === 'malformed-marker')) {
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

  if (beforeCreate) {
    const check = beforeCreate();
    diagnostics.push(...(check.diagnostics ?? []));
    if (!check.ok) return { ok: false, diagnostics, eventKey, projectionPendingRepair: true };
  }

  writePendingEvent(workdir, {
    schema,
    eventKey,
    body,
    createdAt: new Date().toISOString(),
    delivery: 'immediate',
  });
  const created = createIssueComment(publicationTransport, repo, issueNumber, body);
  if (!created.ok) {
    const failure: GhFailure = created.timedOut
      ? { kind: 'timeout', message: 'comment creation timed out' }
      : created.terminalRefusal
        ? { kind: 'terminal-refusal', message: 'comment creation was explicitly refused' }
        : { kind: 'transport', message: 'comment creation transport failed' };
    pendingFailure(
      workdir,
      { schema, eventKey, body },
      failure.kind === 'timeout'
        ? 'publication-timeout'
        : failure.kind === 'terminal-refusal'
          ? 'terminal-refusal'
          : 'comment-create',
    );
    const terminal = terminalForCensusFailure(
      failure,
      'Repair the existing comment publication transport before retrying; do not resend ambiguous delivery.',
      'exception publisher',
    );
    diagnostics.push({
      code: 'comments-truncated',
      message: `comment create; terminal outcome: ${terminal.outcome}: ${failure.message}`,
      eventKey,
    });
    return { ok: false, diagnostics, eventKey, projectionPendingRepair: true, terminal };
  }
  let confirmed: ReturnType<typeof confirmCanonicalEvent>;
  try {
    confirmed = confirmCanonicalEvent(publicationTransport, repo, issueNumber, eventKey, fingerprint, census);
  } catch (error) {
    return censusFailureResult(diagnostics, error, 'publication confirmation', {
      eventKey,
      workdir,
      event: { schema, eventKey, body },
      projectionPendingRepair: true,
      owner: 'exception publisher',
    });
  }
  diagnostics.push(...confirmed.diagnostics);
  if (!confirmed.confirmed) {
    const terminal = terminalForCensusFailure(
      confirmed.failure,
      'Repair or complete the existing comment census confirmation before retrying.',
      'exception publisher',
    );
    pendingFailure(workdir, { schema, eventKey, body }, pendingFailureClass(confirmed.failure));
    return { ok: false, diagnostics, eventKey, projectionPendingRepair: true, terminal };
  }
  clearPendingEvent(workdir, eventKey);
  return { ok: true, diagnostics, eventKey };
}

export function retryPendingEvents(
  transport: GhTransport,
  repo: string,
  issueNumber: number,
  workdir?: string,
  census?: CommentCensusOptions,
): OperationResult[] {
  const resolvedWorkdir = resolveWorkdir(issueNumber, workdir);
  const pending = listPendingEvents(resolvedWorkdir);
  const results: OperationResult[] = [];
  for (const item of pending) {
    if (item.schema !== CYCLE_SCHEMA && item.schema !== STAGE_SCHEMA) {
      results.push({
        ok: false,
        diagnostics: [{ code: 'conflicting-remote-event', message: `pending ${item.schema} is owned by another finalizer`, eventKey: item.eventKey }],
        eventKey: item.eventKey,
      });
      continue;
    }
    let logical: ReturnType<typeof parseJournalEvents>['events'][number]['logical'] | null = null;
    try {
      const parsed = parseJournalEvents([{
        id: 0,
        body: item.body,
        createdAt: item.createdAt,
        updatedAt: item.createdAt,
        userLogin: 'pending-local',
        authorAssociation: 'OWNER',
      }]);
      logical = parsed.events[0]?.logical ?? null;
    } catch {
      logical = null;
    }
    if (!logical || logical.schema !== item.schema || logical['event-key'] !== item.eventKey) {
      results.push({
        ok: false,
        diagnostics: [{ code: 'malformed-marker', message: `pending event ${item.eventKey} is malformed`, eventKey: item.eventKey }],
        eventKey: item.eventKey,
      });
      continue;
    }
    const fingerprint = logicalFingerprint(logical);
    const published = publishJournalEvent(
      transport,
      repo,
      issueNumber,
      resolvedWorkdir,
      item.body,
      item.schema,
      item.eventKey,
      fingerprint,
      census,
    );
    if (published.ok && item.schema === CYCLE_SCHEMA) {
      try {
        const issue = fetchIssueRevision(transport, repo, issueNumber);
        const projection = syncIssueProjectionLabels(transport, repo, issueNumber, PROJECTION_IN_PROGRESS, issue.labels);
        results.push({ ...published, ok: projection.ok, diagnostics: [...published.diagnostics, ...projection.diagnostics], projectionPendingRepair: projection.pendingRepair });
      } catch {
        results.push({ ...published, ok: false, projectionPendingRepair: true, diagnostics: [...published.diagnostics, { code: 'comments-truncated', message: 'cycle projection retry could not read the issue', eventKey: item.eventKey }] });
      }
    } else {
      results.push(published);
    }
  }
  return results;
}

export function startReviewCycle(
  transport: GhTransport,
  input: StartCycleInput,
): OperationResult {
  const workdir = resolveWorkdir(input.issueNumber, input.workdir);
  const diagnostics: LineageDiagnostic[] = [];
  const bootstrapDiagnostics = ensureProjectionLabels(transport, input.repo);
  diagnostics.push(...bootstrapDiagnostics);
  if (bootstrapDiagnostics.length > 0) return { ok: false, diagnostics, projectionPendingRepair: true };

  let censusState: ReturnType<typeof loadIssueJournalCensus>;
  try {
    censusState = loadIssueJournalCensus(transport, input.repo, input.issueNumber, input.census);
  } catch (error) {
    return censusFailureResult(diagnostics, error, 'start-cycle census');
  }
  diagnostics.push(...censusState.diagnostics);
  if (!censusState.fetched.commentsComplete) {
    return censusFailureResult(diagnostics, undefined, 'start-cycle census', {
      failure: censusState.fetched.failure,
      owner: 'flow-manager',
    });
  }

  let issueBefore: ReturnType<typeof fetchIssueRevision>;
  try {
    issueBefore = fetchIssueRevision(transport, input.repo, input.issueNumber);
  } catch {
    diagnostics.push({ code: 'comments-truncated', message: 'unable to read issue before cycle admission' });
    return { ok: false, diagnostics, projectionPendingRepair: true };
  }
  const persistedCandidate = readPersistedCycleId(workdir);
  const persistedEvent = persistedCandidate ? censusState.lineage.eventsByKey.get(persistedCandidate) : undefined;
  const activeCycleIsAccepted = issueBefore.labels.includes('spec-review:accepted');
  const revisionChanged = persistedEvent?.logical.schema === CYCLE_SCHEMA
    && (persistedEvent.logical as CycleEventLogical)['source-revision'] !== input.sourceRevision;
  const persisted = !persistedCandidate || activeCycleIsAccepted || revisionChanged ? randomUUID() : persistedCandidate;
  persistCycleId(workdir, persisted);

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
  const published = appendPublishedLogicalJournalEvent(diagnostics, transport, input.repo, input.issueNumber, workdir, logical, input.census);
  if (!published.ok) {
    return {
      ok: false,
      diagnostics,
      cycleId: persisted,
      eventKey: persisted,
      projectionPendingRepair: published.projectionPendingRepair,
    };
  }

  let issue: ReturnType<typeof fetchIssueRevision>;
  try {
    issue = fetchIssueRevision(transport, input.repo, input.issueNumber);
  } catch {
    diagnostics.push({ code: 'comments-truncated', message: 'unable to confirm issue revision after cycle publication' });
    return { ok: false, diagnostics, cycleId: persisted, eventKey: persisted, projectionPendingRepair: true };
  }
  let finalCensus: ReturnType<typeof loadIssueJournalCensus>;
  try {
    finalCensus = loadIssueJournalCensus(transport, input.repo, input.issueNumber, input.census);
  } catch (error) {
    return censusFailureResult(diagnostics, error, 'cycle confirmation census', {
      eventKey: persisted,
      projectionPendingRepair: true,
    });
  }
  const head = finalCensus.lineage.head;
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
  let receiptInput = input.receipt;
  if (input.waiverPath && input.readJson) {
    const current = receiptInput && typeof receiptInput === 'object' ? receiptInput as Record<string, unknown> : {};
    if (current.producerEvidence === undefined) {
      receiptInput = {
        ...current,
        producerEvidence: readEvidenceWaiverProducerEvidence(input.waiverPath, input.readJson),
      };
    }
  }
  const parsedReceipt = parseConsumableStageReceipt(receiptInput);
  diagnostics.push(...parsedReceipt.errors.map((message) => ({
    code: 'malformed-marker' as const,
    message,
  })));
  if (!parsedReceipt.receipt) {
    return { ok: false, diagnostics };
  }
  const receipt = parsedReceipt.receipt;
  let censusState: ReturnType<typeof loadIssueJournalCensus>;
  try {
    censusState = loadIssueJournalCensus(transport, input.repo, input.issueNumber, input.census);
  } catch (error) {
    return censusFailureResult(diagnostics, error, 'stage publication census');
  }
  diagnostics.push(...censusState.diagnostics);
  if (!censusState.fetched.commentsComplete) {
    return censusFailureResult(diagnostics, undefined, 'stage publication census', {
      failure: censusState.fetched.failure,
      owner: 'stage publisher',
    });
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
  const published = publishLogicalJournalEvent(
    transport,
    input.repo,
    input.issueNumber,
    workdir,
    logical,
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
