import { logicalFingerprint } from './create-issue-stage-record-marker.ts';
import {
  clearPendingEvent,
  clearPersistedCycleId,
  defaultWorkdir,
  ensureProjectionLabels,
  fetchIssueRevision,
  loadIssueJournalCensus,
  syncIssueProjectionLabels,
} from './create-issue-stage-record-gh.ts';
import { appendPublishedLogicalJournalEvent } from './create-issue-stage-record-core.ts';
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

export function runFinalAcceptance(
  transport: GhTransport,
  input: FinalAcceptanceInput,
): FinalAcceptanceResult {
  const diagnostics: LineageDiagnostic[] = [];
  const workdir = input.workdir ?? defaultWorkdir(input.issueNumber);
  const bootstrapDiagnostics = ensureProjectionLabels(transport, input.repo);
  diagnostics.push(...bootstrapDiagnostics);
  if (bootstrapDiagnostics.length > 0) {
    return { ok: false, diagnostics, guardErrors: ['projection label bootstrap failed'], projectionPendingRepair: true };
  }

  const censusState = loadIssueJournalCensus(transport, input.repo, input.issueNumber, input.census);
  diagnostics.push(...censusState.diagnostics);
  if (!censusState.fetched.commentsComplete) {
    return { ok: false, diagnostics, guardErrors: ['comment census incomplete'] };
  }
  if (censusState.diagnostics.some((item) => item.code === 'malformed-marker')) {
    return { ok: false, diagnostics, guardErrors: ['journal contains a malformed hidden marker'] };
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
  if (headCycle['source-revision'] !== input.issueRevision) {
    return { ok: false, diagnostics, guardErrors: ['issue revision does not match canonical cycle head'] };
  }

  let currentIssueBody: string;
  try {
    currentIssueBody = fetchIssueRevision(transport, input.repo, input.issueNumber).body;
  } catch {
    return { ok: false, diagnostics, guardErrors: ['unable to read current Issue body for exact terminal binding'] };
  }

  const guard = executeFinalAcceptanceGuards({
    ...input,
    currentIssueBody,
    cycleId: headCycle['cycle-id'],
    issueRevision: input.issueRevision,
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
  const fingerprint = logicalFingerprint(logical);
  const published = appendPublishedLogicalJournalEvent(diagnostics, transport, input.repo, input.issueNumber, workdir, logical, input.census);
  if (!published.ok) {
    return {
      ok: false,
      diagnostics,
      guardErrors: [],
      eventKey,
      projectionPendingRepair: true,
    };
  }

  let issue: ReturnType<typeof fetchIssueRevision>;
  try {
    issue = fetchIssueRevision(transport, input.repo, input.issueNumber);
  } catch {
    return {
      ok: false,
      diagnostics,
      guardErrors: ['unable to confirm issue revision after final event confirmation'],
      eventKey,
      projectionPendingRepair: true,
    };
  }
  const refreshed = loadIssueJournalCensus(transport, input.repo, input.issueNumber, input.census);
  if (!refreshed.fetched.commentsComplete) {
    return {
      ok: false,
      diagnostics: [...diagnostics, ...refreshed.diagnostics],
      guardErrors: ['comment census incomplete after final event confirmation'],
      eventKey,
      projectionPendingRepair: true,
    };
  }
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
  if (projection.ok) clearPersistedCycleId(workdir);
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
