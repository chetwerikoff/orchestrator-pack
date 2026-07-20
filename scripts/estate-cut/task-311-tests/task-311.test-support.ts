import {
  captureEvidenceDocument,
  fixture,
  invariant,
  runScopeGate,
  validateMutationSet,
  type AcceptanceCriterion,
  type MutationRecord,
} from './task-311-core.test-support.js';
import {
  runRealAssembly,
  validateAssemblyEvidence,
  type AssemblyEvidence,
} from './task-311-assembly-subjects.test-support.js';
import {
  runClaimMatrix,
  validateClaimMatrix,
} from './task-311-claim-matrix.test-support.js';
import {
  runDeliveryMatrix,
  validateDeliveryMatrix,
} from './task-311-delivery-matrix.test-support.js';
import {
  runStaleHeadGate,
  validateReviewStart,
} from './task-311-review-start.test-support.js';

export {
  captureEvidenceDocument,
  runClaimMatrix,
  runDeliveryMatrix,
  runRealAssembly,
  runScopeGate,
  runStaleHeadGate,
};
export type { AcceptanceCriterion, MutationRecord };

export function validateCompleteEvidence(candidate: unknown): void {
  invariant(candidate !== null && typeof candidate === 'object', 'complete evidence missing');
  const evidence = candidate as Record<string, any>;
  validateAssemblyEvidence(evidence.assembly as AssemblyEvidence);
  validateClaimMatrix(evidence.claim as Record<string, any>);
  validateDeliveryMatrix(evidence.delivery as Record<string, any>);
  validateReviewStart(evidence.reviewStart as Record<string, any>);
  invariant(evidence.scope?.result === 'test-only-offline-capture-backed', 'scope result marker missing');
  invariant(evidence.assembly?.binding?.consumer?.source === 'cache', 'assembly.binding.consumer.source selector failed');
  invariant(evidence.capture?.data?.[0]?.id === 'orchestrator-pack-7', 'capture data[0].id selector failed');
  invariant(evidence.assembly?.identity === 'one-pr-head-worker-chain', 'assembly.identity selector failed');
  invariant(evidence.claim?.classes === 'C1-C7-pass', 'claim.classes selector failed');
  invariant(evidence.delivery?.classes === 'J0-J6-pass', 'delivery.classes selector failed');
  invariant(evidence.reviewStart?.headDecision === 'stale-head-review-start-denied', 'reviewStart.headDecision selector failed');

  for (const ac of ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6'] as AcceptanceCriterion[]) {
    const records = evidence.mutationEvidence?.[ac] as MutationRecord[] | undefined;
    invariant(Array.isArray(records), `${ac} mutation evidence is not an array`);
    invariant(records.length === fixture.mutationControls[ac].length, `${ac} mutation evidence cardinality drifted`);
    validateMutationSet(ac, records);
  }
}
