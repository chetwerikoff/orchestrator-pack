import { describe, expect, it } from 'vitest';
import { executeFinalAcceptanceGuards } from './create-issue-final-acceptance-contract.ts';

describe('create-issue-final-acceptance contract parity', () => {
  it('requires direct guard execution inputs instead of a PASS receipt shortcut', () => {
    const result = executeFinalAcceptanceGuards({
      issueBody: 'body without revision marker',
      issueRevision: 'r01',
      cycleId: 'cycle-1',
      reviewDir: '/tmp/review',
      stageReceiptPaths: [],
      capturePaths: [],
      externalPassReceiptPath: '/tmp/fake-pass.json',
    });
    expect(result.ok).toBe(false);
    expect(result.contractVersion).toBe('create-issue-final-acceptance-contract/v1');
    expect(result.errors[0]).toMatch(/external PASS receipt/);
  });

  it('runs the three acceptance guards and cycle witness validation directly', () => {
    const result = executeFinalAcceptanceGuards({
      issueBody: '```complexity-tier\ntier: T1\nadvisory-prior: T1\n```\nr01',
      issueRevision: 'r01',
      cycleId: 'cycle-1',
      reviewDir: '/tmp/review',
      stageReceiptPaths: ['receipt.json'],
      capturePaths: [],
      readJson: () => ({
        tier: 'T1', stage: 'architectural', cycleId: 'cycle-2', stageAttemptId: 'attempt-1',
        policyVersion: 'single-source/v1', sourceRevision: 'r01', outcome: 'complete',
        reviewerCardinality: 1, completedSourceCount: 1, producerEvidence: 'not-applicable', tierTransition: 'none',
        cycleBinding: { cycleId: 'cycle-2', sourceRevision: 'r01', boundBeforeLaunch: true },
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.startsWith('tier-gate:'))).toBe(true);
    expect(result.errors.some((error) => error.startsWith('stage-completeness:'))).toBe(true);
    expect(result.errors.some((error) => error.startsWith('finding-ledger:'))).toBe(true);
    expect(result.errors.some((error) => error.startsWith('cycle-binding:'))).toBe(true);
  });
});
