import { createHash } from 'node:crypto';
import { fetchIssueRevision } from './create-issue-stage-record-gh.ts';
import { parseReviewLaneSourceRevision } from './review-lane-input.ts';
import {
  freezeConsistentReviewLaneBody,
  REVIEW_LANE_ROUTING_POLICY_VERSION,
  type ReviewLaneRouting,
} from './review-lane-routing.ts';
import type { ReviewLaneOverride } from './review-lane-selector.ts';
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
 * Create-issue T3 stages keep the routed-cycle evidence envelope, but reviewer
 * cardinality is no longer selected by the legacy review-lane declaration.
 * Issue #1439 makes the canonical create-issue stage plan the sole authority:
 * competitive/architectural-review are fixed three-source stages. Two exact
 * live Issue reads remain the transport/body-identity witness before launch.
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
