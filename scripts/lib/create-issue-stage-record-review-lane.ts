import { fetchIssueRevision } from './create-issue-stage-record-gh.ts';
import {
  freezeAndProduceReviewLaneInput,
  parseReviewLaneAuthorDeclarationFromBody,
  parseReviewLaneSourceRevision,
} from './review-lane-input.ts';
import {
  classifyReviewLaneDeclaration,
  type ReviewLaneRouting,
} from './review-lane-routing.ts';
import type { ReviewLaneOverride } from './review-lane-selector.ts';
import { selectReviewLane } from './review-lane-selector.ts';
import type { GhTransport } from './create-issue-stage-record-types.ts';

export interface PrepareReviewLaneStageAttemptInput {
  transport: GhTransport;
  repo: string;
  issueNumber: number;
  sourceRevision: string;
  stageAttemptId: string;
  permittedLaneOverride?: ReviewLaneOverride;
}

export interface PrepareReviewLaneStageAttemptResult {
  ok: boolean;
  routing?: ReviewLaneRouting;
  diagnostics: string[];
}

export function prepareReviewLaneStageAttempt(
  input: PrepareReviewLaneStageAttemptInput,
): PrepareReviewLaneStageAttemptResult {
  let first;
  let second;
  try {
    first = fetchIssueRevision(input.transport, input.repo, input.issueNumber);
    second = fetchIssueRevision(input.transport, input.repo, input.issueNumber);
  } catch {
    return { ok: false, diagnostics: ['unable to obtain two live Issue reads for review-lane freeze'] };
  }

  const firstLiveRevision = parseReviewLaneSourceRevision(first.body);
  const secondLiveRevision = parseReviewLaneSourceRevision(second.body);
  if (!firstLiveRevision || !secondLiveRevision) {
    return { ok: false, diagnostics: ['live Issue body is missing its revision marker'] };
  }
  if (firstLiveRevision !== secondLiveRevision) {
    return { ok: false, diagnostics: ['live Issue revision changed during review-lane freeze'] };
  }
  if (input.sourceRevision !== secondLiveRevision) {
    return { ok: false, diagnostics: [`caller source revision ${input.sourceRevision} disagrees with live Issue revision ${secondLiveRevision}`] };
  }
  const produced = freezeAndProduceReviewLaneInput([
    { sourceRevision: firstLiveRevision, body: first.body },
    { sourceRevision: secondLiveRevision, body: second.body },
  ]);
  if (produced.status !== 'usable') {
    return { ok: false, diagnostics: [`review-lane input is not usable: ${produced.reason}`] };
  }
  const authorDeclaration = parseReviewLaneAuthorDeclarationFromBody(second.body);
  if (!authorDeclaration) {
    return { ok: false, diagnostics: ['review-lane declaration could not be recovered from the frozen Issue body'] };
  }
  const classification = classifyReviewLaneDeclaration(authorDeclaration);
  const selected = selectReviewLane(produced, classification, secondLiveRevision, input.stageAttemptId, input.permittedLaneOverride);
  if (!selected.ready || !selected.routing) {
    return { ok: false, diagnostics: [selected.reason ?? 'review-lane selection was not ready'] };
  }
  return { ok: true, routing: selected.routing, diagnostics: [] };
}
