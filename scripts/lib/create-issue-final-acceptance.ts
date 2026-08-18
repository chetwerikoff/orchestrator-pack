import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
  validateExactTerminalBodyBinding,
  type FinalAcceptanceGuardInput,
} from './create-issue-final-acceptance-contract.ts';
import { loadCanonicalReceiptInventory } from '../stage-completeness-guard.ts';
import type {
  CanonicalLineage,
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

export function validatePublishBodyBinding(reviewedBody: string, currentBody: string): string[] {
  const errors: string[] = [];
  validateExactTerminalBodyBinding(reviewedBody, currentBody, errors);
  return errors;
}

export function parseCanonicalSourceRevisionMarker(body: string): {
  revision?: string;
  errors: string[];
} {
  const errors: string[] = [];
  let fencedCode: '`' | '~' | null = null;
  const markerLines: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (fencedCode !== null) {
      if (trimmed.startsWith(fencedCode.repeat(3))) fencedCode = null;
      continue;
    }
    if (trimmed.startsWith('```')) {
      fencedCode = '`';
      continue;
    }
    if (trimmed.startsWith('~~~')) {
      fencedCode = '~';
      continue;
    }
    if (line.includes('source-revision:')) markerLines.push(line);
  }
  if (markerLines.length === 0) {
    return { errors: ['live Issue body is missing the canonical source-revision marker'] };
  }

  const revisions: string[] = [];
  for (const line of markerLines) {
    const trimmed = line.trim();
    const prefix = '<!-- source-revision:';
    if (!trimmed.startsWith(prefix) || !trimmed.endsWith('-->')) {
      errors.push(`malformed source-revision marker: ${trimmed}`);
      continue;
    }
    const revision = trimmed.slice(prefix.length, -3).trim();
    if (!revision || /\s/.test(revision)) {
      errors.push(`malformed source-revision marker: ${trimmed}`);
      continue;
    }
    revisions.push(revision);
  }
  if (revisions.length > 1) {
    errors.push(`duplicate canonical source-revision markers: ${revisions.join(', ')}`);
  }
  return errors.length > 0 ? { errors } : { revision: revisions[0], errors: [] };
}

export function validateCanonicalReceiptPathSet(
  canonicalPaths: readonly string[],
  requestedPaths: readonly string[],
): string[] {
  const errors: string[] = [];
  const resolveRealPath = (path: string): string | null => {
    try {
      return realpathSync(resolve(path));
    } catch {
      errors.push(`receipt path does not resolve to a canonical file: ${path}`);
      return null;
    }
  };
  const canonicalRealPaths = canonicalPaths.flatMap((path) => {
    const resolved = resolveRealPath(path);
    return resolved ? [resolved] : [];
  });
  const requestedRealPaths = requestedPaths.flatMap((path) => {
    const resolved = resolveRealPath(path);
    return resolved ? [resolved] : [];
  });
  const canonicalSet = new Set(canonicalRealPaths);
  const requestedSet = new Set(requestedRealPaths);
  const duplicateRequested = requestedRealPaths.filter((path, index) => requestedRealPaths.indexOf(path) !== index);
  if (duplicateRequested.length > 0) {
    errors.push(`duplicate canonical receipt path aliases: ${[...new Set(duplicateRequested)].join(', ')}`);
  }
  const missing = canonicalRealPaths.filter((path) => !requestedSet.has(path));
  if (missing.length > 0) errors.push(`canonical receipt inventory omitted: ${[...new Set(missing)].join(', ')}`);
  const extra = requestedRealPaths.filter((path) => !canonicalSet.has(path));
  if (extra.length > 0) errors.push(`receipt inventory contains non-canonical paths: ${[...new Set(extra)].join(', ')}`);
  return [...new Set(errors)];
}

export function validateFinalAcceptanceReadbackHead(
  lineage: CanonicalLineage,
  cycleId: string,
  sourceRevision: string,
): string[] {
  const head = lineage.head;
  if (!head || head.logical.schema !== CYCLE_SCHEMA) {
    return ['final acceptance readback has no canonical cycle head'];
  }
  const headCycle = head.logical as CycleEventLogical;
  const errors: string[] = [];
  if (headCycle['cycle-id'] !== cycleId) {
    errors.push(`final acceptance readback cycle head changed: expected ${cycleId}, got ${headCycle['cycle-id']}`);
  }
  if (headCycle['source-revision'] !== sourceRevision) {
    errors.push(`final acceptance readback cycle revision changed: expected ${sourceRevision}, got ${headCycle['source-revision']}`);
  }
  return errors;
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
  let liveIssue: ReturnType<typeof fetchIssueRevision>;
  try {
    liveIssue = fetchIssueRevision(transport, input.repo, input.issueNumber);
  } catch {
    return { ok: false, diagnostics, guardErrors: ['unable to read current Issue body before final acceptance'] };
  }
  const liveRevisionResult = parseCanonicalSourceRevisionMarker(liveIssue.body);
  if (liveRevisionResult.errors.length > 0 || !liveRevisionResult.revision) {
    return { ok: false, diagnostics, guardErrors: liveRevisionResult.errors };
  }
  const liveRevision = liveRevisionResult.revision;
  if (input.issueRevision !== liveRevision) {
    return {
      ok: false,
      diagnostics,
      guardErrors: [`caller issue revision ${input.issueRevision} does not match live source-revision marker ${liveRevision}`],
    };
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
  if (headCycle['source-revision'] !== liveRevision) {
    return { ok: false, diagnostics, guardErrors: ['issue revision does not match canonical cycle head'] };
  }

  let canonicalInventory: ReturnType<typeof loadCanonicalReceiptInventory>;
  try {
    canonicalInventory = loadCanonicalReceiptInventory({
      tierIntakePath: input.tierIntakePath ?? join(input.reviewDir, 'tier-intake.json'),
      receiptDirectory: input.reviewDir,
      stageReceiptPaths: input.stageReceiptPaths,
      claudeProducerEvidencePaths: input.claudeProducerEvidencePaths,
    });
  } catch (error) {
    return {
      ok: false,
      diagnostics,
      guardErrors: [error instanceof Error ? error.message : String(error)],
    };
  }
  const inventoryErrors = validateCanonicalReceiptPathSet(
    canonicalInventory.receiptPaths,
    input.stageReceiptPaths,
  );
  if (inventoryErrors.length > 0) {
    return { ok: false, diagnostics, guardErrors: inventoryErrors };
  }

  const guard = executeFinalAcceptanceGuards({
    ...input,
    issueBody: liveIssue.body,
    currentIssueBody: liveIssue.body,
    stageReceiptValues: canonicalInventory.receiptValues,
    stageReceiptPaths: canonicalInventory.receiptPaths,
    episodeAuthority: canonicalInventory.authority,
    tierIntakePath: canonicalInventory.intakePath,
    cycleId: headCycle['cycle-id'],
    issueRevision: liveRevision,
    canonicalLineage: censusState.lineage,
  });
  if (!guard.ok) {
    return { ok: false, diagnostics, guardErrors: guard.errors };
  }

  let publishIssue: ReturnType<typeof fetchIssueRevision>;
  try {
    publishIssue = fetchIssueRevision(transport, input.repo, input.issueNumber);
  } catch {
    return {
      ok: false,
      diagnostics,
      guardErrors: ['unable to re-read current Issue body before final event publication'],
      eventKey: `${headCycle['cycle-id']}:final-acceptance:${headCycle['source-revision']}`,
      projectionPendingRepair: true,
    };
  }
  const publishRevisionResult = parseCanonicalSourceRevisionMarker(publishIssue.body);
  const publishBodyErrors = [
    ...publishRevisionResult.errors,
    ...(publishRevisionResult.revision !== liveRevision
      ? [`live source-revision marker changed before final publication: expected ${liveRevision}, got ${publishRevisionResult.revision ?? '<missing>'}`]
      : []),
    ...validatePublishBodyBinding(liveIssue.body, publishIssue.body),
  ];
  if (publishBodyErrors.length > 0) {
    return {
      ok: false,
      diagnostics,
      guardErrors: publishBodyErrors,
      eventKey: `${headCycle['cycle-id']}:final-acceptance:${headCycle['source-revision']}`,
      projectionPendingRepair: true,
    };
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
  const published = appendPublishedLogicalJournalEvent(
    diagnostics,
    transport,
    input.repo,
    input.issueNumber,
    workdir,
    logical,
    input.census,
    () => {
      try {
        const latest = fetchIssueRevision(transport, input.repo, input.issueNumber);
        const latestRevisionResult = parseCanonicalSourceRevisionMarker(latest.body);
        const errors = [
          ...latestRevisionResult.errors,
          ...(latestRevisionResult.revision !== liveRevision
            ? [`live source-revision marker changed during final publication: expected ${liveRevision}, got ${latestRevisionResult.revision ?? '<missing>'}`]
            : []),
          ...validatePublishBodyBinding(liveIssue.body, latest.body),
        ];
        return errors.length === 0
          ? { ok: true }
          : {
            ok: false,
            diagnostics: [{
              code: 'public-journal-gap',
              message: errors.join('; '),
              eventKey,
            }],
          };
      } catch {
        return {
          ok: false,
          diagnostics: [{
            code: 'public-journal-gap',
            message: 'unable to re-read current Issue body before final event publication',
            eventKey,
          }],
        };
      }
    },
  );
  if (!published.ok) {
    return {
      ok: false,
      diagnostics,
      guardErrors: published.diagnostics.map((item) => item.message),
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
  const readbackHeadErrors = validateFinalAcceptanceReadbackHead(
    refreshed.lineage,
    headCycle['cycle-id'],
    headCycle['source-revision'],
  );
  if (readbackHeadErrors.length > 0) {
    return {
      ok: false,
      diagnostics: [...diagnostics, ...refreshed.diagnostics],
      guardErrors: readbackHeadErrors,
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
  const confirmedRevisionResult = parseCanonicalSourceRevisionMarker(issue.body);
  const confirmedErrors = [
    ...confirmedRevisionResult.errors,
    ...(confirmedRevisionResult.revision !== liveRevision
      ? [`live source-revision marker changed after final event confirmation: expected ${liveRevision}, got ${confirmedRevisionResult.revision ?? '<missing>'}`]
      : []),
    ...validatePublishBodyBinding(liveIssue.body, issue.body),
  ];
  if (confirmedErrors.length > 0) {
    return {
      ok: false,
      diagnostics,
      guardErrors: confirmedErrors,
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