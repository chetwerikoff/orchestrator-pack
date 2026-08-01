import { buildCanonicalLineage } from './create-issue-stage-record-lineage.ts';
import {
  logicalFingerprint,
  serializeCommentBody,
} from './create-issue-stage-record-marker.ts';
import {
  clearPendingEvent,
  defaultWorkdir,
  ensureProjectionLabels,
  fetchIssueComments,
  fetchIssueRevision,
  fetchRepositoryOwnerLogin,
  parseJournalEvents,
  syncIssueProjectionLabels,
  writePendingEvent,
} from './create-issue-stage-record-gh.ts';
import { publishJournalEvent } from './create-issue-stage-record-core.ts';
import {
  executeFinalAcceptanceGuards,
  FINAL_ACCEPTANCE_CONTRACT_VERSION,
  type FinalAcceptanceGuardInput,
} from './create-issue-final-acceptance-contract.ts';
import type {
  CommentCensusOptions,
  CycleEventLogical,
  FinalEventLogical,
  GhTransport,
  LineageDiagnostic,
  PublicActor,
} from './create-issue-stage-record-types.ts';
import {
  CYCLE_SCHEMA,
  FINAL_SCHEMA,
  PROJECTION_ACCEPTED,
} from './create-issue-stage-record-types.ts';

export interface FinalAcceptanceInput extends FinalAcceptanceGuardInput {
  repo: string;
  issueNumber: number;
  publicActor: PublicActor;
  workdir?: string;
  census?: CommentCensusOptions;
}

export interface FinalAcceptanceResult {
  ok: boolean;
  diagnostics: LineageDiagnostic[];
  guardErrors: string[];
  eventKey?: string;
  projectionPendingRepair?: boolean;
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
    fetched,
    lineage,
    diagnostics: [...fetched.diagnostics, ...parsed.diagnostics, ...lineage.diagnostics],
  };
}

export function runFinalAcceptance(
  transport: GhTransport,
  input: FinalAcceptanceInput,
): FinalAcceptanceResult {
  const diagnostics: LineageDiagnostic[] = [];
  const workdir = input.workdir ?? defaultWorkdir(input.issueNumber);
  diagnostics.push(...ensureProjectionLabels(transport, input.repo));

  const censusState = loadCensus(transport, input.repo, input.issueNumber, input.census);
  diagnostics.push(...censusState.diagnostics);
  if (!censusState.fetched.commentsComplete) {
    return { ok: false, diagnostics, guardErrors: ['comment census incomplete'] };
  }
  const head = censusState.lineage.head;
  if (!head || head.logical.schema !== CYCLE_SCHEMA) {
    diagnostics.push({ code: 'orphan-cycle', message: 'no canonical cycle head for final acceptance' });
    return { ok: false, diagnostics, guardErrors: ['missing canonical cycle head'] };
  }
  const headCycle = head.logical as CycleEventLogical;
  if (headCycle['cycle-id'] !== input.cycleId) {
    return { ok: false, diagnostics, guardErrors: ['cycle head mismatch'] };
  }

  const guard = executeFinalAcceptanceGuards({
    ...input,
    cycleId: headCycle['cycle-id'],
    issueRevision: headCycle['source-revision'],
  });
  if (!guard.ok) {
    return { ok: false, diagnostics, guardErrors: guard.errors };
  }

  const eventKey = `${headCycle['cycle-id']}:final-acceptance:${headCycle['source-revision']}`;
  const logical: FinalEventLogical = {
    schema: FINAL_SCHEMA,
    'event-key': eventKey,
    'cycle-id': headCycle['cycle-id'],
    tier: headCycle.tier,
    'source-revision': headCycle['source-revision'],
    outcome: 'accepted',
    'contract-version': FINAL_ACCEPTANCE_CONTRACT_VERSION,
    'public-actor': input.publicActor,
  };
  const body = serializeCommentBody(logical);
  const fingerprint = logicalFingerprint(logical);
  writePendingEvent(workdir, {
    schema: FINAL_SCHEMA,
    eventKey,
    body,
    createdAt: new Date().toISOString(),
    delivery: 'immediate',
  });
  const published = publishJournalEvent(
    transport,
    input.repo,
    input.issueNumber,
    workdir,
    body,
    FINAL_SCHEMA,
    eventKey,
    fingerprint,
    input.census,
  );
  diagnostics.push(...published.diagnostics);
  if (!published.ok) {
    return {
      ok: false,
      diagnostics,
      guardErrors: [],
      eventKey,
      projectionPendingRepair: true,
    };
  }

  const issue = fetchIssueRevision(transport, input.repo, input.issueNumber);
  const refreshed = loadCensus(transport, input.repo, input.issueNumber, input.census);
  const confirmed = refreshed.lineage.eventsByKey.get(eventKey);
  if (!confirmed || confirmed.fingerprint !== fingerprint) {
    return {
      ok: false,
      diagnostics,
      guardErrors: [],
      eventKey,
      projectionPendingRepair: true,
    };
  }
  if (!issue.body.includes(headCycle['source-revision'])) {
    return {
      ok: false,
      diagnostics,
      guardErrors: ['issue revision drift after final event confirmation'],
      eventKey,
      projectionPendingRepair: true,
    };
  }

  clearPendingEvent(workdir, eventKey);
  const projection = syncIssueProjectionLabels(
    transport,
    input.repo,
    input.issueNumber,
    PROJECTION_ACCEPTED,
    issue.labels,
  );
  diagnostics.push(...projection.diagnostics);
  return {
    ok: projection.ok,
    diagnostics,
    guardErrors: [],
    eventKey,
    projectionPendingRepair: projection.pendingRepair,
  };
}

export {
  executeFinalAcceptanceGuards,
  FINAL_ACCEPTANCE_CONTRACT_VERSION,
};
