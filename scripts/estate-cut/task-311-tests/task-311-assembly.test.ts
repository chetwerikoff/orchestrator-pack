import { describe, expect, it } from 'vitest';

import {
  captureEvidenceDocument,
  runClaimMatrix,
  runDeliveryMatrix,
  runRealAssembly,
  runScopeGate,
  runStaleHeadGate,
  validateCompleteEvidence,
  type MutationRecord,
} from './task-311.test-support.js';

interface AcceptanceEvidence {
  schemaVersion: 1;
  issue: 918;
  task: 311;
  assembly?: Record<string, unknown>;
  capture?: Record<string, unknown>;
  claim?: Record<string, unknown>;
  delivery?: Record<string, unknown>;
  reviewStart?: Record<string, unknown>;
  scope?: Record<string, unknown>;
  mutationEvidence: Partial<Record<'AC1' | 'AC2' | 'AC3' | 'AC4' | 'AC5' | 'AC6', MutationRecord>>;
}

const evidence: AcceptanceEvidence = {
  schemaVersion: 1,
  issue: 918,
  task: 311,
  mutationEvidence: {},
};

describe('task 311 real vertical-slice assembly gate', () => {
  it('AC1-AC2 assembles real binding, cache, fresh-head, claim, runner, reviewer, journal and delivery boundaries', async () => {
    const result = await runRealAssembly();
    evidence.assembly = result.assembly;
    evidence.capture = captureEvidenceDocument();
    evidence.mutationEvidence.AC1 = result.mutations.AC1;
    evidence.mutationEvidence.AC2 = result.mutations.AC2;

    expect(evidence.assembly.binding).toBeDefined();
    expect((evidence.assembly as any).binding.consumer.source).toBe('cache');
    expect((evidence.assembly as any).identity).toBe('one-pr-head-worker-chain');
    expect((evidence.capture as any).data[0].id).toBe('orchestrator-pack-7');
  }, 120_000);

  it('AC3 exercises the real C1-C7 claim and reaper matrix', () => {
    const result = runClaimMatrix();
    evidence.claim = result.claim;
    evidence.mutationEvidence.AC3 = result.mutation;

    expect((evidence.claim as any).classes).toBe('C1-C7-pass');
  }, 120_000);

  it('AC4 exercises the real J0-J6 delivery crash matrix', async () => {
    const result = await runDeliveryMatrix();
    evidence.delivery = result.delivery;
    evidence.mutationEvidence.AC4 = result.mutation;

    expect((evidence.delivery as any).classes).toBe('J0-J6-pass');
  }, 60_000);

  it('AC5 denies stale-head review start before runner or delivery invocation', () => {
    const result = runStaleHeadGate();
    evidence.reviewStart = result.reviewStart;
    evidence.mutationEvidence.AC5 = result.mutation;

    expect((evidence.reviewStart as any).headDecision).toBe('stale-head-review-start-denied');
    expect((evidence.reviewStart as any).runnerInvocations).toBe(0);
    expect((evidence.reviewStart as any).deliveryInvocations).toBe(0);
  });

  it('AC6 validates add-only scope, capture provenance, offline boundaries and complete machine-readable evidence', () => {
    const result = runScopeGate();
    evidence.scope = result.scope;
    evidence.mutationEvidence.AC6 = result.mutation;

    validateCompleteEvidence(evidence);
    expect((evidence.scope as any).result).toBe('test-only-offline-capture-backed');
    process.stdout.write(`TASK311_ACCEPTANCE_EVIDENCE=${JSON.stringify(evidence)}\n`);
  });
});
