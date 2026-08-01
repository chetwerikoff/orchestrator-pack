import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeFinalAcceptanceGuards } from './lib/create-issue-final-acceptance-contract.ts';
import { publishSettledStageRecord, startReviewCycle } from './lib/create-issue-stage-record-core.ts';
import {
  createMockGhState,
  createMockTransport,
} from './lib/create-issue-stage-record-test-helpers.ts';
import { makeTempDir, sampleStageReceipt } from './lib/create-issue-stage-record-test-helpers.ts';

const repo = 'chetwerikoff/orchestrator-pack';
const issueNumber = 1152;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('create-issue-stage-finalize integration', () => {
  it('starts a cycle, retries equal logical events, and rejects conflicting roots', () => {
    const state = createMockGhState({ issue: { title: 't', body: 'revision r01', labels: ['bug'] } });
    const transport = createMockTransport(state);
    const workdir = makeTempDir();

    const first = startReviewCycle(transport, {
      repo,
      issueNumber,
      sourceRevision: 'r01',
      tier: 'T3',
      publicActor: 'cursor-flow-manager',
      workdir,
    });
    expect(first.ok).toBe(true);
    expect(state.comments).toHaveLength(1);
    expect(state.issue.labels).toContain('spec-review:in-progress');

    const retry = startReviewCycle(transport, {
      repo,
      issueNumber,
      sourceRevision: 'r01',
      tier: 'T3',
      publicActor: 'cursor-flow-manager',
      workdir,
    });
    expect(retry.ok).toBe(true);
    expect(state.comments).toHaveLength(1);

    const conflicting = startReviewCycle(transport, {
      repo,
      issueNumber,
      sourceRevision: 'r02',
      tier: 'T3',
      publicActor: 'cursor-flow-manager',
      predecessorCycleId: 'none',
      workdir: makeTempDir(),
    });
    expect(conflicting.ok).toBe(false);
  });

  it('publishes a bound stage record and refuses github failure as non-authoritative local progression', () => {
    const state = createMockGhState({ issue: { title: 't', body: 'revision r01', labels: [] } });
    const transport = createMockTransport(state);
    const workdir = makeTempDir();
    const started = startReviewCycle(transport, {
      repo,
      issueNumber,
      sourceRevision: 'r01',
      tier: 'T3',
      publicActor: 'cursor-flow-manager',
      workdir,
    });
    const cycleId = started.cycleId!;
    const receipt = sampleStageReceipt(cycleId);
    const published = publishSettledStageRecord(transport, {
      repo,
      issueNumber,
      receipt,
      workdir,
    });
    expect(published.ok).toBe(true);
    expect(state.comments).toHaveLength(2);

    state.failCreate = true;
    const blocked = publishSettledStageRecord(transport, {
      repo,
      issueNumber,
      receipt: {
        ...receipt,
        stageAttemptId: 'attempt-2',
        stage: 'architectural-review',
      },
      workdir,
    });
    expect(blocked.ok).toBe(false);
    expect(state.comments).toHaveLength(2);
  });

  it('refuses stage publication when cycle binding is missing or cross-cycle', () => {
    const state = createMockGhState({ issue: { title: 't', body: 'revision r01', labels: [] } });
    const transport = createMockTransport(state);
    const workdir = makeTempDir();
    const started = startReviewCycle(transport, {
      repo,
      issueNumber,
      sourceRevision: 'r01',
      tier: 'T3',
      publicActor: 'cursor-flow-manager',
      workdir,
    });
    const missing = publishSettledStageRecord(transport, {
      repo,
      issueNumber,
      receipt: { ...sampleStageReceipt(started.cycleId!), cycleBinding: undefined },
      workdir,
    });
    expect(missing.ok).toBe(false);
    const cross = publishSettledStageRecord(transport, {
      repo,
      issueNumber,
      receipt: {
        ...sampleStageReceipt(started.cycleId!),
        cycleId: 'other-cycle',
      },
      workdir,
    });
    expect(cross.ok).toBe(false);
  });
});

describe('create-issue-final-acceptance contract', () => {
  it('rejects external PASS receipt consumption', () => {
    const result = executeFinalAcceptanceGuards({
      issueBody: 'revision r01',
      issueRevision: 'r01',
      cycleId: 'cycle-1',
      reviewDir: '/tmp/review',
      stageReceiptPaths: [],
      capturePaths: [],
      externalPassReceiptPath: '/tmp/pass.json',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/external PASS receipt/);
  });
});

describe('create-issue CLI entrypoints', () => {
  it('exports stage-finalize operations', () => {
    expect(typeof startReviewCycle).toBe('function');
    expect(typeof publishSettledStageRecord).toBe('function');
  });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'opk-1152-cli-'));
  tempDirs.push(dir);
  return dir;
}
