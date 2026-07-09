import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import {
  artifactRequiresFreshnessProvenance,
  buildHeavyTopology,
  clampHeavyShardCount,
  deriveHeavyShardCountFromTotal,
  formatOversizedGuardFailures,
  loadRuntimeHistoryArtifact,
  msToSeconds,
  parseTopologyPolicy,
  resolveGuardWeightSeconds,
  validateTopologyPolicy,
} from './lib/vitest-heavy-topology.mjs';

const repoRoot = join(import.meta.dirname, '..');
const aggregateScript = join(repoRoot, 'scripts/ci-test-aggregate.ps1');
const configPath = join(repoRoot, 'scripts/ci-pipeline-split.config.json');
const scopeGuardPath = join(repoRoot, '.github/workflows/scope-guard.yml');
const lanesConfigPath = join(repoRoot, 'scripts/vitest-ci-lanes.config.json');
const fixtureRoot = join(repoRoot, 'tests/fixtures/vitest-heavy-topology');

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
        VITEST_TOPOLOGY_PLAN_RESULT: 'success',
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
    ['vitest topology plan failure', { VITEST_TOPOLOGY_PLAN_RESULT: 'failure' }],
    ['vitest topology plan cancelled', { VITEST_TOPOLOGY_PLAN_RESULT: 'cancelled' }],
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

describe('ci-pipeline-split config and workflow binding (#556/#695 lanes)', () => {
  it('config declares fallback heavy shard count and stable aggregate name', () => {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      fallbackHeavyShardCount: number;
      aggregateJobName: string;
      lightLaneJobName: string;
    };
    expect(config.fallbackHeavyShardCount).toBe(7);
    expect(config.aggregateJobName).toBe('Run pack contract tests');
    expect(config.lightLaneJobName).toBe('Vitest light lane');
  });

  it('scope-guard workflow exposes derived heavy topology plan job and dynamic matrix', () => {
    const yaml = readFileSync(scopeGuardPath, 'utf8');
    expect(yaml).toMatch(/plan-vitest-ci-topology:/);
    expect(yaml).toMatch(/test-vitest-light:/);
    expect(yaml).toMatch(/test-vitest-heavy:/);
    expect(yaml).toMatch(/test-typecheck:/);
    expect(yaml).toMatch(/test-pester:/);
    expect(yaml).toMatch(/test-aggregate:/);
    expect(yaml).toMatch(/emit-vitest-heavy-topology\.mjs/);
    expect(yaml).toMatch(/fromJson\(needs\.plan-vitest-ci-topology\.outputs\.heavy_shard_matrix\)/);
    expect(yaml).toMatch(/run-vitest-light-lane\.ps1/);
    expect(yaml).toMatch(/run-vitest-heavy-shard\.ps1/);
    expect(yaml).toMatch(/ci-test-aggregate\.ps1/);
    expect(yaml).toMatch(/VITEST_TOPOLOGY_PLAN_RESULT/);
    expect(yaml).toMatch(/name: Run pack contract tests/);
    expect(yaml).not.toMatch(/shard: \[1, 2, 3, 4, 5, 6, 7\]/);
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
    expect(plan.heavyShards).toHaveLength(plan.topology.heavyShardCount);
    expect(plan.topology.heavyShardMatrix).toHaveLength(plan.topology.heavyShardCount);
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
    expect(plan.tests?.length ?? 0).toBeGreaterThan(0);
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

function makeTopologyFixtureRoot(runtimeHistoryFixture: string) {
  const root = mkdtempSync(join(tmpdir(), 'opk-topology-'));
  const scriptsDir = join(root, 'scripts');
  const pluginsDir = join(root, 'plugins');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(pluginsDir, { recursive: true });
  cpSync(join(fixtureRoot, 'scripts'), scriptsDir, { recursive: true });
  cpSync(join(fixtureRoot, 'lanes-config.json'), join(scriptsDir, 'vitest-ci-lanes.config.json'));
  cpSync(runtimeHistoryFixture, join(scriptsDir, 'vitest-runtime-history.json'));
  return root;
}

describe('heavy topology weight-input fail-closed (#695)', () => {
  it('derives shard count from moderate heavy-lane total weight (seconds)', () => {
    const root = makeTopologyFixtureRoot(join(fixtureRoot, 'runtime-history-moderate.json'));
    try {
      const result = buildHeavyTopology(root);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.topology.fallbackClassification).toBe('derived');
      expect(result.topology.heavyShardCount).toBe(2);
      expect(result.topology.heavyShardMatrix).toEqual([1, 2]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('clamps cap-hit totals and marks under-provisioned without blocking', () => {
    const root = makeTopologyFixtureRoot(join(fixtureRoot, 'runtime-history-cap-hit.json'));
    try {
      const result = buildHeavyTopology(root);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.topology.heavyShardCount).toBe(3);
      expect(result.topology.underProvisioned).toBe(true);
      expect(result.topology.rawDerivedCount).toBeGreaterThan(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags oversized discovered files and names split-or-speed-up action', () => {
    const root = makeTopologyFixtureRoot(join(fixtureRoot, 'runtime-history-oversized.json'));
    try {
      const result = buildHeavyTopology(root);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const failures = formatOversizedGuardFailures(result);
      expect(failures.some((line: string) => line.includes('scripts/sample-oversized.test.ts'))).toBe(true);
      expect(failures.some((line: string) => line.includes('split the file or speed it up'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['empty', 'runtime-history-empty.json'],
    ['degenerate', 'runtime-history-degenerate.json'],
  ])('falls back to fixed count for present-but-unusable %s history', (_label, fixtureName) => {
    const root = makeTopologyFixtureRoot(join(fixtureRoot, fixtureName));
    try {
      const result = buildHeavyTopology(root);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.topology.fallbackClassification).toBe('fixed-fallback');
      expect(result.topology.heavyShardCount).toBe(3);
      expect(formatOversizedGuardFailures(result).length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when runtime-history artifact is absent (post-#691 loud error)', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-topology-absent-'));
    const scriptsDir = join(root, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(join(root, 'plugins'), { recursive: true });
    cpSync(join(fixtureRoot, 'lanes-config.json'), join(scriptsDir, 'vitest-ci-lanes.config.json'));
    cpSync(join(fixtureRoot, 'scripts'), scriptsDir, { recursive: true });
    try {
      const result = buildHeavyTopology(root);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.errors.join('\n')).toMatch(/missing|broken harvest/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid topology policy before emission', () => {
    const errors = validateTopologyPolicy({
      targetShardSeconds: 0,
      minShardCount: 0,
      maxShardCount: 0,
      fallbackHeavyShardCount: 0,
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('normalizes runtime-history milliseconds to seconds for guard comparison', () => {
    const artifact = {
      files: { 'scripts/sample-heavy-a.test.ts': 90_000 },
      provenance: { 'scripts/sample-heavy-a.test.ts': 'measured' },
      source: 'ci-measured',
    };
    const policy = parseTopologyPolicy(JSON.parse(readFileSync(join(fixtureRoot, 'lanes-config.json'), 'utf8')));
    const resolved = resolveGuardWeightSeconds('scripts/sample-heavy-a.test.ts', artifact, repoRoot);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    expect(resolved.weightSeconds).toBe(msToSeconds(90_000));
    expect(resolved.weightSeconds).toBeLessThan(policy.targetShardSeconds);
  });

  it('fails closed when a weighted file lacks freshness provenance (#695 review)', () => {
    const artifact = {
      source: 'ci-measured',
      files: {
        'scripts/sample-heavy-a.test.ts': 45_000,
        'scripts/sample-heavy-b.test.ts': 60_000,
      },
      provenance: { 'scripts/sample-heavy-a.test.ts': 'measured' },
    };
    expect(artifactRequiresFreshnessProvenance(artifact)).toBe(true);
    const resolved = resolveGuardWeightSeconds('scripts/sample-heavy-b.test.ts', artifact, repoRoot);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      return;
    }
    expect(resolved.reason).toBe('missing-freshness-provenance');
  });

  it('flags missing freshness provenance and unknown weights for all discovered files under ci-measured history', () => {
    const root = makeTopologyFixtureRoot(join(fixtureRoot, 'runtime-history-missing-provenance.json'));
    try {
      const result = buildHeavyTopology(root);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const failures = formatOversizedGuardFailures(result);
      expect(failures.some((line: string) => line.includes('missing-freshness-provenance'))).toBe(true);
      expect(failures.some((line: string) => line.includes('scripts/sample-light.test.ts'))).toBe(true);
      expect(failures.some((line: string) => line.includes('scripts/sample-oversized.test.ts'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when a changed ci-measured file lacks contentSha binding', () => {
    const root = makeTopologyFixtureRoot(join(fixtureRoot, 'runtime-history-missing-provenance.json'));
    try {
      const result = buildHeavyTopology(root, {
        changedFiles: ['scripts/sample-heavy-a.test.ts'],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const failures = formatOversizedGuardFailures(result);
      expect(failures.some((line: string) => line.includes('stale-unassociated-weight'))).toBe(true);
      expect(failures.some((line: string) => line.includes('scripts/sample-heavy-a.test.ts'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when a changed file only has unassociated baseline-estimate weight (no contentSha)', () => {
    const root = makeTopologyFixtureRoot(join(fixtureRoot, 'runtime-history-baseline-estimates.json'));
    try {
      const result = buildHeavyTopology(root, {
        changedFiles: ['scripts/sample-heavy-a.test.ts'],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const failures = formatOversizedGuardFailures(result);
      expect(failures.some((line: string) => line.includes('stale-unassociated-weight'))).toBe(true);
      expect(failures.some((line: string) => line.includes('scripts/sample-heavy-a.test.ts'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts pre-topology measurement for changed baseline-estimate files without contentSha', () => {
    const root = makeTopologyFixtureRoot(join(fixtureRoot, 'runtime-history-baseline-estimates.json'));
    try {
      const result = buildHeavyTopology(root, {
        changedFiles: ['scripts/sample-heavy-a.test.ts'],
        preTopologyMeasurements: { 'scripts/sample-heavy-a.test.ts': 45 },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(formatOversizedGuardFailures(result)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags unknown weights for unchanged discovered files when history omits them', () => {
    const root = makeTopologyFixtureRoot(join(fixtureRoot, 'runtime-history-missing-provenance.json'));
    try {
      const result = buildHeavyTopology(root, { changedFiles: [] });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const failures = formatOversizedGuardFailures(result);
      expect(failures.some((line: string) => line.includes('scripts/sample-light.test.ts'))).toBe(true);
      expect(failures.some((line: string) => line.includes('missing-per-file-weight'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed for changed files with stale contentSha provenance', () => {
    const root = makeTopologyFixtureRoot(join(fixtureRoot, 'runtime-history-stale-sha.json'));
    try {
      const result = buildHeavyTopology(root, {
        changedFiles: ['scripts/sample-heavy-a.test.ts'],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const failures = formatOversizedGuardFailures(result);
      expect(failures.some((line: string) => line.includes('stale-content-sha'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts deterministic pre-topology same-run measurement for changed files', () => {
    const root = makeTopologyFixtureRoot(join(fixtureRoot, 'runtime-history-stale-sha.json'));
    try {
      const result = buildHeavyTopology(root, {
        changedFiles: ['scripts/sample-heavy-a.test.ts'],
        preTopologyMeasurements: { 'scripts/sample-heavy-a.test.ts': 45 },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(formatOversizedGuardFailures(result)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses heavy-lane-only total for shard numerator while floor guard scans discovered files', () => {
    const root = makeTopologyFixtureRoot(join(fixtureRoot, 'runtime-history-moderate.json'));
    try {
      const result = buildHeavyTopology(root);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.heavy).toHaveLength(3);
      expect(result.discovered).toHaveLength(4);
      expect(result.topology.heavyLaneTotalWeightSeconds).toBeCloseTo((45_000 + 60_000 + 30_000) / 1000, 5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects matrix/count drift via parity fields', () => {
    const derived = deriveHeavyShardCountFromTotal(250, {
      targetShardSeconds: 100,
      minShardCount: 1,
      maxShardCount: 3,
      fallbackHeavyShardCount: 7,
    });
    expect(derived.heavyShardCount).toBe(3);
    expect(derived.rawDerivedCount).toBe(3);
  });

  it('clamps fixed fallback shard count to maxShardCount', () => {
    const policy = {
      targetShardSeconds: 100,
      minShardCount: 1,
      maxShardCount: 3,
      fallbackHeavyShardCount: 7,
    };
    expect(clampHeavyShardCount(policy.fallbackHeavyShardCount, policy)).toBe(3);
  });

  it('classifies corrupt runtime-history JSON as present-but-unusable', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-topology-corrupt-'));
    const scriptsDir = join(root, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(join(root, 'plugins'), { recursive: true });
    cpSync(join(fixtureRoot, 'lanes-config.json'), join(scriptsDir, 'vitest-ci-lanes.config.json'));
    cpSync(join(fixtureRoot, 'scripts'), scriptsDir, { recursive: true });
    writeFileSync(join(scriptsDir, 'vitest-runtime-history.json'), '{not-json');
    try {
      const loaded = loadRuntimeHistoryArtifact(root);
      expect(loaded.state).toBe('present_but_unusable');
      const result = buildHeavyTopology(root);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.topology.fallbackClassification).toBe('fixed-fallback');
      expect(formatOversizedGuardFailures(result).length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
