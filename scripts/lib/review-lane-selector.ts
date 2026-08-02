import {
  buildReviewLaneRouting,
  type ReviewLaneClassification,
  type ReviewLaneInput,
  type ReviewLaneRouting,
  type UsableReviewLaneInput,
} from './review-lane-routing.ts';

export type ReviewLaneOverride = 'normal' | 'disputed' | undefined;

export interface ReviewLaneSelection {
  ready: boolean;
  reason?: string;
  routing?: ReviewLaneRouting;
}

function usable(input: ReviewLaneInput): input is UsableReviewLaneInput {
  return input.status === 'usable';
}

function normalOverrideAllowed(input: UsableReviewLaneInput, classification: ReviewLaneClassification): boolean {
  return classification.policyStatus === 'available'
    && classification.scopeClass === 'safe'
    && input.blastRadius === 'high';
}


export function selectReviewLane(
  input: ReviewLaneInput,
  classification: ReviewLaneClassification,
  sourceRevision: string,
  stageAttemptId: string,
  override?: ReviewLaneOverride,
): ReviewLaneSelection {
  if (!usable(input)) return { ready: false, reason: input.reason };
  if (classification.policyStatus !== 'available') return { ready: false, reason: classification.unavailableReason ?? 'classifier-unavailable' };

  if (override === 'normal' && !normalOverrideAllowed(input, classification)) {
    return { ready: false, reason: 'normal override is permitted only for exact high safe scope' };
  }
  if (override === 'disputed' && classification.scopeClass === 'safe' && input.blastRadius === 'low') {
    return {
      ready: true,
      routing: buildReviewLaneRouting({ ...input, blastRadius: 'high' }, classification, sourceRevision, stageAttemptId),
    };
  }
  if (override === 'normal') {
    const routing = buildReviewLaneRouting({ ...input, blastRadius: 'low' }, classification, sourceRevision, stageAttemptId);
    return { ready: true, routing };
  }
  return { ready: true, routing: buildReviewLaneRouting(input, classification, sourceRevision, stageAttemptId) };
}
