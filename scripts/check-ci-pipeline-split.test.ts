import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assignHeavyShards,
  buildLanePlan,
  discoverVitestFiles,
  loadLanesConfig,
  loadRuntimeHistory,
  resolveHeavyFilePool,
  resolveHeavyFileRunPlan,
  scanWorkerRpcSignatures,
  validateClassification,
} from './lib/vitest-ci-lanes.mjs';

const repoRoot = join(import.meta.dirname, '..');
const aggregateScript = join(repoRoot, 'scripts/ci-test-aggregate.ps1');
const configPath = join(repoRoot, 'scripts/ci-pipeline-split.config.json');
const scopeGuardPath = join(repoRoot, '.github/workflows/scope-guard.yml');
const lanesConfigPath = join(repoRoot, 'scripts/vitest-ci-lanes.config.json');

function runAggregate(env: Record<string, string>) {
  const merged = { ...process.env, ...env };
  try {
    execFileSync(
      'pwsh',
      ['-NoProfile', '-File', aggregateScript],
      { cwd: repoRoot, env: merged, stdio: 'pipe' },
    );
    return 0;
  } catch (error) {
    const err = error as { status?: number };
    return typeof err.status === 'number' ? err.status : 1;
  }
}

describe('ci-test-aggregate fail-closed matrix (Issue #487/#556)', () => {
  it('passes when all lanes succeed with head/run binding', () => {
    expect(
      runAggregate({
        TYPECHECK_RESULT: 'success',
        VITEST_LIGHT_RESULT: 'success',
        VITEST_HEAVY_RESULT: 'success',
        PESTER_RESULT: 'success',
        GITHUB_SHA: 'deadbeef',
        GITHUB_RUN_ID: '42',
      }),
    ).toBe(0);
  });

  it.each([
    ['typecheck failure', { TYPECHECK_RESULT: 'failure' }],
    ['vitest light failure', { VITEST_LIGHT_RESULT: 'failure' }],
    ['vitest heavy cancelled', { VITEST_HEAVY_RESULT: 'cancelled' }],
    ['vitest light skipped', { VITEST_LIGHT_RESULT: 'skipped' }],
    ['missing head', { GITHUB_SHA: '' }],
    ['missing run', { GITHUB_RUN_ID: '' }],
  ] as const)('fails closed on %s', (_label, overrides) => {
    const code = runAggregate({
      TYPECHECK_RESULT: 'success',
      VITEST_LIGHT_RESULT: 'success',
      VITEST_HEAVY_RESULT: 'success',
      PESTER_RESULT: 'success',
      GITHUB_SHA: 'deadbeef',
      GITHUB_RUN_ID: '42',
      ...overrides,
    });
    expect(code).not.toBe(0);
  });
});

describe('ci-pipeline-split config and workflow binding (#556 lanes)', () => {
  it('config declares heavy shard count and stable aggregate name', () => {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      heavyShardCount: number;
      aggregateJobName: string;
      lightLaneJobName: string;
    };
    expect(config.heavyShardCount).toBe(7);
    expect(config.aggregateJobName).toBe('Run pack contract tests');
    expect(config.lightLaneJobName).toBe('Vitest light lane');
  });

  it('scope-guard workflow exposes light/heavy lanes and aggregate job', () => {
    const yaml = readFileSync(scopeGuardPath, 'utf8');
    expect(yaml).toMatch(/test-vitest-light:/);
    expect(yaml).toMatch(/test-vitest-heavy:/);
    expect(yaml).toMatch(/test-typecheck:/);
    expect(yaml).toMatch(/test-pester:/);
    expect(yaml).toMatch(/test-aggregate:/);
    expect(yaml).toMatch(/run-vitest-light-lane\.ps1/);
    expect(yaml).toMatch(/run-vitest-heavy-shard\.ps1/);
    expect(yaml).toMatch(/ci-test-aggregate\.ps1/);
    expect(yaml).toMatch(/name: Run pack contract tests/);
    expect(yaml).toMatch(/shard: \[1, 2, 3, 4, 5, 6, 7\]/);
    expect(yaml).not.toMatch(/test-aggregate:[\s\S]*!cancelled\(\)/);
  });
});

describe('vitest CI lane classification and shard assignment (#556)', () => {
  it('classifies every discovered file and partitions without overlap', () => {
    const plan = buildLanePlan(repoRoot);
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.discovered.length).toBeGreaterThan(0);
    expect(plan.light.length + plan.heavy.length).toBe(plan.discovered.length);
    const union = new Set([...plan.light, ...plan.heavy]);
    expect(union.size).toBe(plan.discovered.length);
  });

  it('fails classification-required for synthetic unclassified files', () => {
    const discovered = [...discoverVitestFiles(repoRoot), 'scripts/__new_unclassified__.test.ts'];
    const classification = JSON.parse(readFileSync(lanesConfigPath, 'utf8')).classification as Record<
      string,
      string
    >;
    const errors = validateClassification(discovered, classification);
    expect(errors.some((line) => line.includes('classification-required'))).toBe(true);
  });

  it('runtime-weighted heavy shards cover all heavy files exactly once', () => {
    const plan = buildLanePlan(repoRoot);
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    const assigned = plan.heavyShards.flatMap((shard) => shard.files);
    expect(new Set(assigned).size).toBe(assigned.length);
    expect([...assigned].sort()).toEqual([...plan.heavy].sort());
    expect(plan.heavyShards).toHaveLength(7);
  });

  it('uses conservative fallback runtime for heavy files without history', () => {
    const shards = assignHeavyShards(
      ['scripts/a-heavy.test.ts', 'scripts/b-heavy.test.ts'],
      {},
      2,
      120_000,
    );
    expect(shards[0].files.length + shards[1].files.length).toBe(2);
    expect(shards[0].totalRuntimeMs + shards[1].totalRuntimeMs).toBe(240_000);
  });

  it('selects forks pool for long-runtime heavy files', () => {
    expect(
      resolveHeavyFilePool(
        'scripts/orchestrator-wake-supervisor-orphan-integration.test.ts',
        { 'scripts/orchestrator-wake-supervisor-orphan-integration.test.ts': 120_000 },
        120_000,
        120_000,
      ),
    ).toBe('forks');
    expect(resolveHeavyFilePool('scripts/fast-heavy.test.ts', {}, 120_000, 120_000)).toBe('threads');
  });

  it('plans per-test isolation for configured heavy subprocess files', () => {
    const config = loadLanesConfig(repoRoot);
    const runtimeHistory = loadRuntimeHistory(repoRoot);
    const plan = resolveHeavyFileRunPlan(
      'scripts/autonomous-orchestrator-boundary.test.ts',
      config,
      runtimeHistory,
      repoRoot,
    );
    expect(plan.mode).toBe('tests');
    if (plan.mode !== 'tests') {
      throw new Error('expected per-test isolation plan');
    }
    expect(plan.pool).toBe('forks');
    expect(plan.tests.length).toBeGreaterThan(0);
  });

  it('detects worker-RPC flake signatures in log text', () => {
    const hits = scanWorkerRpcSignatures('vitest-worker onTaskUpdate RPC timeout');
    expect(hits.length).toBeGreaterThan(0);
  });

  it('treats clean vitest JSON reports as success despite shutdown RPC noise', () => {
    const reportScript = join(repoRoot, 'scripts/lib/vitest-json-report.mjs');
    const tempDir = mkdtempSync(join(tmpdir(), 'vitest-json-report-clean-'));
    try {
      const cleanPath = join(tempDir, 'clean.json');
      const failedPath = join(tempDir, 'failed.json');
      writeFileSync(cleanPath, `${JSON.stringify({ success: true, numFailedTests: 0 })}\n`);
      writeFileSync(failedPath, `${JSON.stringify({ success: true, numFailedTests: 1 })}\n`);
      const clean = execFileSync('node', [reportScript, 'is-clean', cleanPath], {
        encoding: 'utf8',
      }).trim();
      const failed = execFileSync('node', [reportScript, 'is-clean', failedPath], {
        encoding: 'utf8',
      }).trim();
      expect(clean).toBe('1');
      expect(failed).toBe('0');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('vitest runtime-history refresh workflow binding (#691)', () => {
  it('refresh workflow is main-only with concurrency and artifact handoff', () => {
    const refreshWorkflow = join(repoRoot, '.github/workflows/vitest-runtime-history-refresh.yml');
    const yaml = readFileSync(refreshWorkflow, 'utf8');
    expect(yaml).toMatch(/push:[\s\S]*branches:[\s\S]*main/);
    expect(yaml).toMatch(/schedule:/);
    expect(yaml).toMatch(/workflow_dispatch:/);
    expect(yaml).not.toMatch(/pull_request:/);
    expect(yaml).toMatch(/concurrency:/);
    expect(yaml).toMatch(/refresh-runtime-history:/);
    expect(yaml).toMatch(/needs:.*test-vitest-heavy/);
    expect(yaml).toMatch(/download-artifact@v4/);
    expect(yaml).toMatch(/upload-artifact@v4/);
    expect(yaml).toMatch(/include-hidden-files:\s*true/);
    expect(yaml).toMatch(/if-no-files-found:\s*error/);
    expect(yaml).toMatch(/refresh-vitest-runtime-history\.ps1/);
  });
});
