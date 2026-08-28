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
import type { OperatorAcceptanceAdjudication } from './create-issue-stage-record-artifacts.ts';
import { resolvePublishedAuthorState } from './resolve-published-author-state.ts';
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
  operatorAdjudication?: OperatorAcceptanceAdjudication;
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

function compareSourceRevisions(left: string, right: string): number {
  const leftMatch = /^r([0-9]+)$/i.exec(left.trim());
  const rightMatch = /^r([0-9]+)$/i.exec(right.trim());
  if (!leftMatch || !rightMatch) {
    return left.trim().toLowerCase() === right.trim().toLowerCase() ? 0 : Number.NaN;
  }
  const leftDigits = leftMatch[1]!.replace(/^0+(?=\d)/, '');
  const rightDigits = rightMatch[1]!.replace(/^0+(?=\d)/, '');
  if (leftDigits.length !== rightDigits.length) return leftDigits.length - rightDigits.length;
  if (leftDigits === rightDigits) return 0;
  return leftDigits < rightDigits ? -1 : 1;
}

export function validateTerminalSourceRevision(
  canonicalRevision: string,
  terminalRevision: string,
  liveRevision: string,
): string[] {
  const comparison = compareSourceRevisions(canonicalRevision, terminalRevision);
  const canonicalIsLive = compareSourceRevisions(canonicalRevision, liveRevision) === 0;
  return Number.isNaN(comparison) || (comparison > 0 && !canonicalIsLive)
    ? [`terminal source revision ${terminalRevision} does not match original canonical cycle head ${canonicalRevision}`]
    : [];
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
  const revisionComparison = compareSourceRevisions(headCycle['source-revision'], sourceRevision);
  if (Number.isNaN(revisionComparison) || revisionComparison > 0) {
    errors.push(`final acceptance readback cycle revision changed: canonical ${headCycle['source-revision']} is newer than accepted ${sourceRevision}`);
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
  let projectionPendingRepair = bootstrapDiagnostics.length > 0;

  const censusState = loadIssueJournalCensus(transport, input.repo, input.issueNumber, input.census);
  diagnostics.push(...censusState.diagnostics);
  const censusUsable = censusState.fetched.commentsComplete
    && !censusState.diagnostics.some((item) => item.code === 'malformed-marker');
  if (!censusUsable) {
    projectionPendingRepair = true;
    diagnostics.push({
      code: 'public-journal-gap',
      message: 'public journal state is unavailable for audit/projection; content acceptance will use live Issue bytes and substantive result data',
    });
  }
  const publishedAuthorStateResult = censusUsable
    ? resolvePublishedAuthorState({
        adjudication: input.operatorAdjudication,
        repo: input.repo,
        issueNumber: input.issueNumber,
        comments: censusState.fetched.comments,
      })
    : { errors: [], state: undefined };
  if (publishedAuthorStateResult.errors.length > 0) {
    projectionPendingRepair = true;
    diagnostics.push(...publishedAuthorStateResult.errors.map((message) => ({
      code: 'public-journal-gap' as const,
      message: `author-state audit unavailable: ${message}`,
    })));
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
  const terminalSourceBody = input.terminalSourceBody ?? input.issueBody;
  const terminalRevisionResult = parseCanonicalSourceRevisionMarker(terminalSourceBody);
  if (terminalRevisionResult.errors.length > 0 || !terminalRevisionResult.revision) {
    return { ok: false, diagnostics, guardErrors: terminalRevisionResult.errors.map((error) => `terminal source: ${error}`) };
  }
  const terminalRevision = terminalRevisionResult.revision;

  const head = censusUsable ? censusState.lineage.head : null;
  const headCycle = head?.logical.schema === CYCLE_SCHEMA
    ? head.logical as CycleEventLogical
    : null;
  if (!headCycle) {
    projectionPendingRepair = true;
    diagnostics.push({ code: 'orphan-cycle', message: 'no canonical cycle head for audit/projection' });
  } else {
    if (headCycle['cycle-id'] !== input.cycleId) {
      projectionPendingRepair = true;
      diagnostics.push({
        code: 'public-journal-gap',
        message: `audit cycle differs from caller metadata: caller=${input.cycleId || '<missing>'} canonical=${headCycle['cycle-id']}`,
      });
    }
    const terminalRevisionErrors = validateTerminalSourceRevision(
      headCycle['source-revision'],
      terminalRevision,
      liveRevision,
    );
    if (terminalRevisionErrors.length > 0) {
      projectionPendingRepair = true;
      diagnostics.push(...terminalRevisionErrors.map((message) => ({
        code: 'public-journal-gap' as const,
        message: `audit revision mismatch: ${message}`,
      })));
    }
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
    terminalSourceBody,
    currentIssueBody: liveIssue.body,
    stageReceiptValues: canonicalInventory.receiptValues,
    stageReceiptPaths: canonicalInventory.receiptPaths,
    episodeAuthority: canonicalInventory.authority,
    tierIntakePath: canonicalInventory.intakePath,
    cycleId: input.cycleId,
    issueRevision: liveRevision,
    ...(censusUsable ? { canonicalLineage: censusState.lineage } : {}),
    ...(publishedAuthorStateResult.state ? { publishedAuthorState: publishedAuthorStateResult.state } : {}),
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
      eventKey: headCycle ? `${headCycle['cycle-id']}:final-acceptance:${liveRevision}` : undefined,
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
      eventKey: headCycle ? `${headCycle['cycle-id']}:final-acceptance:${liveRevision}` : undefined,
      projectionPendingRepair: true,
    };
  }

  if (!headCycle) {
    return {
      ok: true,
      diagnostics,
      guardErrors: [],
      projectionPendingRepair: true,
    };
  }

  const eventKey = `${headCycle['cycle-id']}:final-acceptance:${liveRevision}`;
  const logical: FinalEventLogical = {
    schema: FINAL_SCHEMA,
    'event-key': eventKey,
    'cycle-id': headCycle['cycle-id'],
    tier: headCycle.tier,
    'source-revision': liveRevision,
    outcome: 'accepted',
    'contract-version': FINAL_ACCEPTANCE_CONTRACT_VERSION,
    'public-actor': input.publicActor,
  };
  const fingerprint = logicalFingerprint(logical);
  let publicationReadbackErrors: string[] = [];
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
        if (errors.length === 0) return { ok: true };
        publicationReadbackErrors = errors;
        return {
          ok: false,
          diagnostics: [{
            code: 'public-journal-gap',
            message: errors.join('; '),
            eventKey,
          }],
        };
      } catch {
        publicationReadbackErrors = ['unable to re-read current Issue body before final event publication'];
        return {
          ok: false,
          diagnostics: [{
            code: 'public-journal-gap',
            message: publicationReadbackErrors[0]!,
            eventKey,
          }],
        };
      }
    },
  );
  if (!published.ok && publicationReadbackErrors.length > 0) {
    return {
      ok: false,
      diagnostics,
      guardErrors: [...new Set(publicationReadbackErrors)],
      eventKey,
      projectionPendingRepair: true,
    };
  }
  if (!published.ok) {
    return {
      ok: true,
      diagnostics: [...diagnostics, ...published.diagnostics],
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

  const refreshed = loadIssueJournalCensus(transport, input.repo, input.issueNumber, input.census);
  if (!refreshed.fetched.commentsComplete) {
    return {
      ok: true,
      diagnostics: [
        ...diagnostics,
        ...refreshed.diagnostics,
        { code: 'public-journal-gap', message: 'comment census incomplete after content acceptance' },
      ],
      guardErrors: [],
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
      ok: true,
      diagnostics: [
        ...diagnostics,
        ...refreshed.diagnostics,
        ...readbackHeadErrors.map((message) => ({ code: 'public-journal-gap' as const, message })),
      ],
      guardErrors: [],
      eventKey,
      projectionPendingRepair: true,
    };
  }
  const confirmed = refreshed.lineage.eventsByKey.get(eventKey);
  if (!confirmed || confirmed.fingerprint !== fingerprint) {
    return {
      ok: true,
      diagnostics: [
        ...diagnostics,
        { code: 'public-journal-gap', message: 'final content acceptance could not be confirmed in the public journal', eventKey },
      ],
      guardErrors: [],
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
    ok: true,
    diagnostics,
    guardErrors: [],
    eventKey,
    projectionPendingRepair: projection.pendingRepair || projectionPendingRepair,
  };
}

export {
  executeFinalAcceptanceGuards,
  FINAL_ACCEPTANCE_CONTRACT_VERSION,
};
