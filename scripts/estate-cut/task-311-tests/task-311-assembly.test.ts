import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { runClaimMatrix } from './task-311-claim.test-support.js';
import {
  captureEvidenceDocument,
  installEgressTrap,
  runStaleHeadGate,
  runThreeSubjectAssembly,
  tempRoot,
  validateCompleteEvidence,
  type AcceptanceEvidence,
} from './task-311-common.test-support.js';
import { runDeliveryMatrix } from './task-311-delivery.test-support.js';
import { runScopeGate } from './task-311-scope.test-support.js';

describe('TASK-311 real surviving review-cycle assembly gate', () => {
  it('drives three real subjects, C1-C7 and J0-J6 with exact mutation and hermetic evidence', async () => {
    const trapRoot = tempRoot('task-311-egress-');
    const trap = installEgressTrap(trapRoot);
    try {
      expect(trap.active).toBe(true);
      expect(trap.attempts()).toEqual([]);

      const assembled = await runThreeSubjectAssembly(trap);
      const claim = runClaimMatrix();
      const delivery = await runDeliveryMatrix();
      const reviewStart = runStaleHeadGate();
      expect(trap.attempts()).toEqual([]);
      const scope = runScopeGate(trap);

      const evidence: AcceptanceEvidence = {
        schemaVersion: 2,
        issue: 918,
        task: 311,
        assembly: assembled.assembly,
        capture: captureEvidenceDocument(),
        claim: claim.claim,
        delivery: delivery.delivery,
        reviewStart: reviewStart.reviewStart,
        scope: scope.scope,
        mutationEvidence: {
          AC1: assembled.mutations.AC1,
          AC2: assembled.mutations.AC2,
          AC3: claim.mutations,
          AC4: delivery.mutations,
          AC5: reviewStart.mutations,
          AC6: scope.mutations,
        },
      };

      validateCompleteEvidence(evidence);
      expect((evidence.assembly as any).binding.consumer.source).toBe('cache');
      expect((evidence.assembly as any).identity).toBe('one-pr-head-worker-chain');
      expect((evidence.claim as any).classes).toBe('C1-C7-pass');
      expect((evidence.delivery as any).classes).toBe('J0-J6-pass');
      expect((evidence.reviewStart as any).headDecision).toBe('stale-head-review-start-denied');
      expect((evidence.scope as any).result).toBe('test-only-offline-capture-backed');
      process.stdout.write(`TASK311_ACCEPTANCE_EVIDENCE=${JSON.stringify(evidence)}\n`);
    } finally {
      trap.restore();
      rmSync(trapRoot, { recursive: true, force: true });
    }
  }, 300_000);
});
