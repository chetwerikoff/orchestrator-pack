import { readFileSync } from 'node:fs';
// @vitest-pre-topology-seconds 1
// @vitest-ci-lane light
import { describe, expect, it } from 'vitest';

describe('Issue #2319 retired smoke execution caller removal', () => {
  it('does not invoke progress, cancellation, selective carry, or nested-run machinery from the active worker', () => {
    const source = readFileSync('scripts/worker-smoke-run.ts', 'utf8');
    expect(source).not.toContain('runSmokeAttempt');
    expect(source).not.toContain('buildSmokeProgressWriterCommand');
    expect(source).not.toContain('writeSmokeCancelRequest');
    expect(source).not.toContain('inspectSmokeProgress');
    expect(source).not.toContain('planWorkerSmokeSelectiveRetry(');
    expect(source).not.toContain('deriveMainMergeCarryProof');
  });
});
