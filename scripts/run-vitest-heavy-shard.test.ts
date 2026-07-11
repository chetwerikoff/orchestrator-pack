import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ISOLATE_TEST_BATCH_SIZE,
  HEAVY_BATCHING_REDUCTION_TARGET,
  buildHeavyInvocationUnits,
  countBaselineInvocations,
  countBatchedInvocations,
  groupHeavyInvocationUnits,
  validateHeavyBatchReportPayload,
} from './lib/vitest-heavy-batching.mjs';
import { hasFailedTestsVitestJsonReport } from './lib/vitest-json-report.mjs';
import { parseWorkflowJobs, verifyWorkflowTimeoutPolicy } from './check-ci-job-timeouts.mjs';

function reportFor(files: string[], options: { failedFile?: string } = {}) {
  return {
    success: !options.failedFile,
    numFailedTests: options.failedFile ? 1 : 0,
    testResults: files.map((file, index) => ({
      name: `/repo/${file}`,
      startTime: index * 10,
      endTime: index * 10 + 5,
      assertionResults: [
        {
          ancestorTitles: ['suite'],
          title: 'works',
          fullName: 'suite works',
          duration: 5,
          status: options.failedFile === file ? 'failed' : 'passed',
        },
      ],
    })),
  };
}

describe('batched invocation grouping', () => {
  it('groups non-isolate file invocations by pool and records the reduction target', () => {
    const units = buildHeavyInvocationUnits([
      { file: 'scripts/a.test.ts', mode: 'file', pool: 'threads' },
      { file: 'scripts/b.test.ts', mode: 'file', pool: 'threads' },
      { file: 'scripts/c.test.ts', mode: 'file', pool: 'threads' },
      { file: 'scripts/d.test.ts', mode: 'file', pool: 'forks' },
    ]);

    const batches = groupHeavyInvocationUnits(units, { nonIsolateFileBatchSize: 3 });

    expect(countBaselineInvocations(units)).toBe(4);
    expect(countBatchedInvocations(batches)).toBe(2);
    expect(batches[0].files).toEqual([
      'scripts/a.test.ts',
      'scripts/b.test.ts',
      'scripts/c.test.ts',
    ]);
    expect(batches[0].testPattern).toBeNull();
    expect(batches[1].files).toEqual(['scripts/d.test.ts']);
    expect(HEAVY_BATCHING_REDUCTION_TARGET.minimumInvocationReductionPercent).toBeGreaterThan(0);
    expect(HEAVY_BATCHING_REDUCTION_TARGET.minimumBootTimeReductionPercent).toBeGreaterThan(0);
  });

  it('preserves batching-disabled baseline parity when file batch size is 1', () => {
    const units = buildHeavyInvocationUnits([
      { file: 'scripts/a.test.ts', mode: 'file', pool: 'threads' },
      { file: 'scripts/b.test.ts', mode: 'file', pool: 'threads' },
    ]);

    const batches = groupHeavyInvocationUnits(units, { nonIsolateFileBatchSize: 1 });

    expect(countBatchedInvocations(batches)).toBe(countBaselineInvocations(units));
    expect(batches.map((batch) => batch.files)).toEqual([
      ['scripts/a.test.ts'],
      ['scripts/b.test.ts'],
    ]);
  });
});

describe('RPC flake retry under batching', () => {
  it('validates exactly one reported entry per planned batch member after retry resolves', () => {
    const units = buildHeavyInvocationUnits([
      { file: 'scripts/a.test.ts', mode: 'file', pool: 'threads' },
      { file: 'scripts/b.test.ts', mode: 'file', pool: 'threads' },
    ]);
    const [batch] = groupHeavyInvocationUnits(units, { nonIsolateFileBatchSize: 2 });

    const result = validateHeavyBatchReportPayload(
      reportFor(['scripts/a.test.ts', 'scripts/b.test.ts']),
      batch.members,
      '/repo',
    );

    expect(result).toEqual({ ok: true, errors: [] });
  });

  it('fails closed when retry exhaustion would leave a planned member missing', () => {
    const units = buildHeavyInvocationUnits([
      { file: 'scripts/a.test.ts', mode: 'file', pool: 'threads' },
      { file: 'scripts/b.test.ts', mode: 'file', pool: 'threads' },
    ]);
    const [batch] = groupHeavyInvocationUnits(units, { nonIsolateFileBatchSize: 2 });

    const result = validateHeavyBatchReportPayload(reportFor(['scripts/a.test.ts']), batch.members, '/repo');

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('missing reported file: scripts/b.test.ts');
  });

  it('keeps genuine assertion failures terminal so cross-attempt passes cannot overwrite them', () => {
    const failed = reportFor(['scripts/a.test.ts', 'scripts/b.test.ts'], {
      failedFile: 'scripts/a.test.ts',
    });

    expect(hasFailedTestsVitestJsonReport(failed)).toBe(true);
  });
});

describe('heavyPerTestIsolate batching safety default', () => {
  it('keeps isolate-listed file tests at batch size 1 without an explicit opt-in proof', () => {
    const units = buildHeavyInvocationUnits([
      {
        file: 'scripts/autonomous-orchestrator-boundary.test.ts',
        mode: 'tests',
        pool: 'forks',
        tests: ['first isolate test', 'second isolate test'],
      },
    ]);

    const batches = groupHeavyInvocationUnits(units, { isolateTestBatchSize: 5 });

    expect(DEFAULT_ISOLATE_TEST_BATCH_SIZE).toBe(1);
    expect(batches).toHaveLength(2);
    expect(batches.map((batch) => batch.members)).toEqual([
      [
        expect.objectContaining({
          file: 'scripts/autonomous-orchestrator-boundary.test.ts',
          testPattern: 'first isolate test',
        }),
      ],
      [
        expect.objectContaining({
          file: 'scripts/autonomous-orchestrator-boundary.test.ts',
          testPattern: 'second isolate test',
        }),
      ],
    ]);
  });
});

describe('batch crash fail-closed attribution', () => {
  it('names missing batch members as unresolved instead of silently passing partial reports', () => {
    const units = buildHeavyInvocationUnits([
      { file: 'scripts/a.test.ts', mode: 'file', pool: 'threads' },
      { file: 'scripts/b.test.ts', mode: 'file', pool: 'threads' },
      { file: 'scripts/c.test.ts', mode: 'file', pool: 'threads' },
    ]);
    const [batch] = groupHeavyInvocationUnits(units, { nonIsolateFileBatchSize: 3 });

    const result = validateHeavyBatchReportPayload(
      reportFor(['scripts/a.test.ts', 'scripts/c.test.ts']),
      batch.members,
      '/repo',
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['missing reported file: scripts/b.test.ts']);
  });
});

describe('CI job timeout walls', () => {
  it('rejects duplicate job-level keys while verifying job-scoped timeout-minutes', () => {
    const workflow = `name: fixture
on: push
jobs:
  unit:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    timeout-minutes: 11
    steps: []
`;

    expect(() => parseWorkflowJobs(workflow)).toThrow(/duplicate key timeout-minutes/);
  });

  it('verifies declared timeout values against recorded runtime references and margins', () => {
    const workflow = `name: fixture
on: push
jobs:
  unit:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps: []
`;
    const result = verifyWorkflowTimeoutPolicy('fixture.yml', workflow, {
      references: { p90: { minutes: 10, margin: 2 } },
      jobs: { unit: { timeout: 30, reference: 'p90' } },
    });

    expect(result.ok).toBe(true);
    expect(result.jobs).toHaveLength(1);
  });
});
