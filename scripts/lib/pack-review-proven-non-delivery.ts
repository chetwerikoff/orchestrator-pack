export interface ProvenNonDeliveryEvidence {
  exitCode?: number;
  scope?: string;
  cause?: string;
  phase?: string;
  remediationCompleted?: boolean;
}

/** Minimal pack-review-only predicate; replace with #1066 seam when landed. */
export function isProducerGroundedProvenNonDelivery(evidence: ProvenNonDeliveryEvidence): boolean {
  if (evidence.remediationCompleted !== true) return false;
  const scope = String(evidence.scope ?? '').trim();
  const cause = String(evidence.cause ?? '').trim();
  const phase = String(evidence.phase ?? '').trim();
  if (!scope || !cause) return false;
  if (scope === 'invocation' && phase === 'pre_send') {
    return cause === 'input_invalid' || cause === 'dispatch_request_not_issued' || cause === 'send_failed';
  }
  return false;
}

export function exitCodeAloneIsNotProvenNonDelivery(exitCode: number | undefined): boolean {
  return exitCode === 10;
}

export const PACK_REVIEW_PROVEN_NON_DELIVERY_SEAM = 'pack-review-proven-non-delivery/v1';
