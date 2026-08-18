import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startReviewCycle } from './lib/create-issue-stage-record-core.ts';
import {
  createMockGhState,
  createMockTransport,
} from './lib/create-issue-stage-record-test-helpers.ts';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'opk-stage-slot-consumed-'));
  roots.push(root);
  return root;
}

function writeIntake(stateRoot: string): string {
  const reviewDir = join(stateRoot, '.review', '1439');
  mkdirSync(reviewDir, { recursive: true });
  writeFileSync(join(reviewDir, 'tier-intake.json'), JSON.stringify({
    schema: 'tier-intake/v1',
    producer: 'flow-manager',
    taskIdentity: 'issue:1439',
    kind: 'fresh',
    priorTier: 'T2',
    firstRevision: 'r01',
  }, null, 2));
  return reviewDir;
}

function settledReceipt(stageAttemptId: string) {
  const cycleId = 'cycle-architectural-review';
  return {
    schema: 'stage-completeness-receipt/v1',
    tier: 'T2',
    taskIdentity: 'issue:1439',
    episodeFirstRevision: 'r01',
    reviewEpisodeId: 'issue:1439@r01',
    stage: 'architectural-review',
    stageAttemptId,
    stageSequence: 1,
    cycleId,
    policyVersion: 'triple-source/v1',
    reviewerCardinality: 3,
    completedSourceCount: 2,
    sourceRevision: 'r01',
    outcome: 'partial',
    producerEvidence: 'not-applicable',
    tierTransition: 'none',
    cycleBinding: { cycleId, sourceRevision: 'r01', boundBeforeLaunch: true },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('stage-slot-consumed start-cycle admission', () => {
  it('refuses a settled Issue-lifetime slot before cycle or new attempt minting', () => {
    const stateRoot = tempRoot();
    const workdir = tempRoot();
    const reviewDir = writeIntake(stateRoot);
    const consumingStageAttemptId = '9886473e-3531-419d-97d9-f0b9257b6217';
    writeFileSync(
      join(reviewDir, `stage-completeness-receipt-${consumingStageAttemptId}.json`),
      JSON.stringify(settledReceipt(consumingStageAttemptId), null, 2),
    );
    const state = createMockGhState({
      issue: {
        title: 'Issue #1439 fixture',
        body: '<!-- source-revision: r03 -->\nrepaired body',
        labels: [],
      },
    });

    const result = startReviewCycle(createMockTransport(state), {
      repo: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1439,
      sourceRevision: 'r03',
      stage: 'architectural-review',
      tier: 'T2',
      publicActor: 'cursor-flow-manager',
      workdir,
      stateRootOverride: stateRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.stageAttemptId).toBe(consumingStageAttemptId);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'stage_slot_consumed', eventKey: consumingStageAttemptId }),
    ]));
    expect(state.comments).toHaveLength(0);
    expect(existsSync(join(workdir, '.create-issue-cycle-id'))).toBe(false);
  });

  it('admits the same first stage when the canonical slot is absent', () => {
    const stateRoot = tempRoot();
    const workdir = tempRoot();
    writeIntake(stateRoot);
    const state = createMockGhState({
      issue: {
        title: 'Issue #1439 fixture',
        body: '<!-- source-revision: r03 -->\nbody',
        labels: [],
      },
    });

    const result = startReviewCycle(createMockTransport(state), {
      repo: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1439,
      sourceRevision: 'r03',
      stage: 'architectural-review',
      tier: 'T2',
      publicActor: 'cursor-flow-manager',
      workdir,
      stateRootOverride: stateRoot,
    });

    expect(result.ok).toBe(true);
    expect(result.stageAttemptId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(state.comments).toHaveLength(1);
    expect(existsSync(join(workdir, '.create-issue-cycle-id'))).toBe(true);
  });
});
