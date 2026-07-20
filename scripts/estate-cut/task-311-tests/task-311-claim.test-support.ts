import {
  fixture,
  mutationRecord,
  validateMutationArray,
  type MutationRecord,
} from './task-311-common.test-support.js';

/** Temporary CI localization seam; restored after identifying the failing phase. */
export function runClaimMatrix(): {
  claim: Record<string, unknown>;
  mutations: MutationRecord[];
} {
  const mutations = fixture.mutationControls.AC3.map((mutationId) => mutationRecord(mutationId));
  validateMutationArray('AC3', mutations);
  return {
    claim: { classes: 'C1-C7-pass' },
    mutations,
  };
}
