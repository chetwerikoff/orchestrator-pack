import { createHash } from 'node:crypto';
import { fetchIssueRevision } from './create-issue-stage-record-gh.ts';
import {
  freezeAndProduceReviewLaneInput,
  parseReviewLaneAuthorDeclarationFromBody,
  parseReviewLaneSourceRevision,
} from './review-lane-input.ts';
import {
  classifyReviewLaneDeclaration,
  freezeConsistentReviewLaneBody,
  REVIEW_LANE_ROUTING_POLICY_VERSION,
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

function canonicalFixedThreeRouting(
  sourceRevision: string,
  stageAttemptId: string,
  bodyIdentity: string,
  permittedLaneOverride?: ReviewLaneOverride,
): ReviewLaneRouting {
  const possibleSlots = ['01', '02', '03'];
  const cardinalityConfigIdentity = createHash('sha256').update(JSON.stringify({
    authority: 'create-issue-stage-topology-plan/v1',
    policyVersion: REVIEW_LANE_ROUTING_POLICY_VERSION,
    topology: 'fixed/v1',
    possibleSlots,
    initiallyActivatedSlots: possibleSlots,
    conditionalActivationRule: null,
  }), 'utf8').digest('hex');
  return {
    schema: REVIEW_LANE_ROUTING_POLICY_VERSION,
    routingPolicyIdentity: REVIEW_LANE_ROUTING_POLICY_VERSION,
    lane: 'disputed',
    topology: 'fixed/v1',
    policyVersion: REVIEW_LANE_ROUTING_POLICY_VERSION,
    reviewerCardinality: 3,
    cardinalityConfigIdentity,
    possibleSlots,
    initiallyActivatedSlots: [...possibleSlots],
    conditionalActivationRule: null,
    sourceRevision,
    stageAttemptId,
    laneInputIdentity: `${sourceRevision}:${bodyIdentity}`,
    classifierIdentity: 'create-issue-stage-topology-plan/v1',
    permittedLaneOverride: permittedLaneOverride ?? null,
  };
}

/**
 * Explicit legacy review-lane declarations retain their historical selector so
 * already-created Issues preserve their frozen routing contract. New create-
 * issue flows without that declaration use the #1439 canonical fixed-three
 * route; the legacy declaration is no longer required to launch the canonical
 * three-source competitive/architectural-review stages.
 */
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
  if (input.sourceRevision !== secondLiveRevision) {
    return { ok: false, diagnostics: [`caller source revision ${input.sourceRevision} disagrees with live Issue revision ${secondLiveRevision}`] };
  }

  const authorDeclaration = parseReviewLaneAuthorDeclarationFromBody(second.body);
  if (authorDeclaration) {
    const produced = freezeAndProduceReviewLaneInput([
      { sourceRevision: firstLiveRevision, body: first.body },
      { sourceRevision: secondLiveRevision, body: second.body },
    ]);
    if (produced.status !== 'usable') {
      return { ok: false, diagnostics: [`review-lane input is not usable: ${produced.reason}`] };
    }
    const classification = classifyReviewLaneDeclaration(authorDeclaration);
    const selected = selectReviewLane(
      produced,
      classification,
      secondLiveRevision,
      input.stageAttemptId,
      input.permittedLaneOverride,
    );
    if (!selected.ready || !selected.routing) {
      return { ok: false, diagnostics: [selected.reason ?? 'review-lane selection was not ready'] };
    }
    return { ok: true, routing: selected.routing, diagnostics: [] };
  }

  const frozen = freezeConsistentReviewLaneBody([
    { sourceRevision: firstLiveRevision, body: first.body },
    { sourceRevision: secondLiveRevision, body: second.body },
  ]);
  if (frozen.status !== 'frozen') {
    return { ok: false, diagnostics: [`review-lane body identity is not usable: ${frozen.reason}`] };
  }
  return {
    ok: true,
    routing: canonicalFixedThreeRouting(
      secondLiveRevision,
      input.stageAttemptId,
      frozen.bodyIdentity,
      input.permittedLaneOverride,
    ),
    diagnostics: [],
  };
}