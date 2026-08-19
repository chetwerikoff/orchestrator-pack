// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { validateHeavyBatchReportPayload, type HeavyInvocationUnit } from './lib/vitest-heavy-batching.mjs';
import { hasFailedTestsVitestJsonReport } from './lib/vitest-json-report.mjs';
import { observeHeavyLaneContext, readHeavyLaneContexts } from './lib/testmode-fleet-lane.ts';
import {
  aggregateFailures,
  aggregateFromEnv,
  buildHeavyInvocations,
  hasRpcFlake,
  heavyAttemptLimit,
  repositoryRootFromModuleUrl,
  runtimeReportAvailable,
  type HeavyFileRunPlan,
} from './vitest-ci-runner.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function greenAggregate() {
  return {
    typecheckResult: 'success',
    vitestLightResult: 'success',
    vitestHeavyResult: 'success',
    contractResult: 'success',
    topologyResult: 'success',
    headSha: 'a'.repeat(40),
    runId: '12345',
  };
}

describe('Vitest CI aggregate authority', () => {
  it.each([
    ['', 'vitest-contracts result missing'],
    ['skipped', 'vitest-contracts unexpectedly skipped'],
    ['cancelled', 'vitest-contracts cancelled'],
    ['failure', 'vitest-contracts failed'],
    ['timed_out', 'vitest-contracts inconclusive (timed_out)'],
  ])('fails closed for contract result %j', (contractResult, expected) => {
    expect(aggregateFailures({ ...greenAggregate(), contractResult })).toContain(expected);
  });

  it('fails closed when current-head or current-run binding is absent', () => {
    const failures = aggregateFailures({ ...greenAggregate(), headSha: '', runId: '' });
    expect(failures).toContain('GITHUB_SHA missing (current-head binding)');
    expect(failures).toContain('GITHUB_RUN_ID missing (current-run binding)');
  });

  it('does not treat the retired PESTER_RESULT variable as a contract signal', () => {
    const input = aggregateFromEnv({
      TYPECHECK_RESULT: 'success',
      VITEST_LIGHT_RESULT: 'success',
      VITEST_HEAVY_RESULT: 'success',
      VITEST_TOPOLOGY_PLAN_RESULT: 'success',
      PESTER_RESULT: 'success',
      GITHUB_SHA: 'a'.repeat(40),
      GITHUB_RUN_ID: '12345',
    });
    expect(input.contractResult).toBe('');
    expect(aggregateFailures(input)).toContain('vitest-contracts result missing');
  });
});

describe('Vitest CI runner platform and report fail-closed helpers', () => {
  it('derives the repository root through fileURLToPath-compatible URLs', () => {
    const moduleUrl = pathToFileURL(path.join(process.cwd(), 'scripts', 'vitest-ci-runner.ts')).href;
    expect(repositoryRootFromModuleUrl(moduleUrl)).toBe(path.resolve(process.cwd()));
  });

  it('fails closed when a successful lane did not emit its JSON report', () => {
    const root = makeRoot('opk-vitest-report-');
    expect(runtimeReportAvailable(path.join(root, 'missing.json'))).toBe(false);
    const present = path.join(root, 'present.json');
    writeFileSync(present, '{}\n', 'utf8');
    expect(runtimeReportAvailable(present)).toBe(true);
  });

  it('distinguishes RPC-flake signatures from genuine assertion failures', () => {
    expect(hasRpcFlake('vitest-worker onTaskUpdate RPC timeout')).toBe(true);
    expect(hasRpcFlake('AssertionError: expected 1 to be 2')).toBe(false);
    expect(hasFailedTestsVitestJsonReport({
      numFailedTests: 1,
      testResults: [{
        name: path.join(process.cwd(), 'scripts', 'sample.test.ts'),
        assertionResults: [{ status: 'failed', title: 'genuine failure' }],
      }],
    })).toBe(true);
  });

  it('bounds heavy retry count to five in CI and one outside CI', () => {
    expect(heavyAttemptLimit({ CI: 'true' })).toBe(5);
    expect(heavyAttemptLimit({ CI: 'false' })).toBe(1);
    expect(heavyAttemptLimit({})).toBe(1);
  });
});

describe('Vitest heavy batching and report validation', () => {
  it('batches compatible files while keeping isolated tests separate', () => {
    const plans = new Map<string, HeavyFileRunPlan>([
      ['a.test.ts', { mode: 'file', pool: 'threads' }],
      ['b.test.ts', { mode: 'file', pool: 'threads' }],
      ['c.test.ts', { mode: 'tests', pool: 'forks', tests: ['isolated case'] }],
    ]);
    const invocations = buildHeavyInvocations([...plans.keys()], plans, 4);
    expect(invocations).toHaveLength(2);
    expect(invocations[0]?.files).toEqual(['a.test.ts', 'b.test.ts']);
    expect(invocations[1]).toMatchObject({ files: ['c.test.ts'], testPattern: 'isolated case' });
  });

  it('throws rather than silently omitting a heavy file with no run plan', () => {
    expect(() => buildHeavyInvocations(['missing.test.ts'], new Map(), 4)).toThrow('missing heavy run plan');
  });

  it('rejects a batch report that omits one of the planned members', () => {
    const members: HeavyInvocationUnit[] = [
      { kind: 'file', file: 'scripts/a.test.ts', pool: 'threads', testPattern: null, label: 'a', batchable: true },
      { kind: 'file', file: 'scripts/b.test.ts', pool: 'threads', testPattern: null, label: 'b', batchable: true },
    ];
    const result = validateHeavyBatchReportPayload({
      testResults: [{
        name: path.join(process.cwd(), 'scripts', 'a.test.ts'),
        assertionResults: [{ status: 'passed', title: 'a' }],
      }],
    }, members, process.cwd());
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('missing reported file: scripts/b.test.ts');
  });
});

describe('Vitest heavy TestMode fleet hygiene', () => {
  it('fails closed when a lane context exists but its lease record is untrusted', async () => {
    const root = makeRoot('opk-vitest-fleet-');
    const leaseRoot = path.join(root, 'leases-root');
    mkdirSync(leaseRoot, { recursive: true });
    writeFileSync(path.join(leaseRoot, 'vitest-lane-context-shard-2.json'), JSON.stringify({
      leaseId: 'lease-untrusted',
      leaseRoot,
      writtenMs: Date.now(),
    }), 'utf8');
    const contexts = readHeavyLaneContexts(2, { OPK_TESTMODE_LEASE_ROOT: leaseRoot });
    expect(contexts).toHaveLength(1);
    await expect(observeHeavyLaneContext(contexts[0]!)).resolves.toEqual({
      ok: false,
      survivors: [],
      leaseId: 'lease-untrusted',
      reason: 'lease_record_untrusted',
    });
  });
});
