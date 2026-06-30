import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..');
const aggregateScript = join(repoRoot, 'scripts/ci-test-aggregate.ps1');
const configPath = join(repoRoot, 'scripts/ci-pipeline-split.config.json');
const scopeGuardPath = join(repoRoot, '.github/workflows/scope-guard.yml');

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

describe('ci-test-aggregate fail-closed matrix (Issue #487)', () => {
  it('passes when all lanes succeed with head/run binding', () => {
    expect(
      runAggregate({
        TYPECHECK_RESULT: 'success',
        VITEST_RESULT: 'success',
        PESTER_RESULT: 'success',
        GITHUB_SHA: 'deadbeef',
        GITHUB_RUN_ID: '42',
      }),
    ).toBe(0);
  });

  it.each([
    ['typecheck failure', { TYPECHECK_RESULT: 'failure' }],
    ['vitest failure', { VITEST_RESULT: 'failure' }],
    ['pester cancelled', { PESTER_RESULT: 'cancelled' }],
    ['vitest skipped', { VITEST_RESULT: 'skipped' }],
    ['missing head', { GITHUB_SHA: '' }],
    ['missing run', { GITHUB_RUN_ID: '' }],
  ] as const)('fails closed on %s', (_label, overrides) => {
    const code = runAggregate({
      TYPECHECK_RESULT: 'success',
      VITEST_RESULT: 'success',
      PESTER_RESULT: 'success',
      GITHUB_SHA: 'deadbeef',
      GITHUB_RUN_ID: '42',
      ...overrides,
    });
    expect(code).not.toBe(0);
  });
});

describe('ci-pipeline-split config and workflow binding', () => {
  it('config declares eight vitest shards and stable aggregate name', () => {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      vitestShardCount: number;
      aggregateJobName: string;
    };
    expect(config.vitestShardCount).toBe(8);
    expect(config.aggregateJobName).toBe('Run pack contract tests');
  });

  it('scope-guard workflow exposes sharded lanes and aggregate job', () => {
    const yaml = readFileSync(scopeGuardPath, 'utf8');
    expect(yaml).toMatch(/test-vitest:/);
    expect(yaml).toMatch(/test-typecheck:/);
    expect(yaml).toMatch(/test-pester:/);
    expect(yaml).toMatch(/test-aggregate:/);
    expect(yaml).toMatch(/run-vitest-shard\.ps1/);
    expect(yaml).toMatch(/ci-test-aggregate\.ps1/);
    expect(yaml).toMatch(/name: Run pack contract tests/);
    expect(yaml).toMatch(/shard: \[1, 2, 3, 4, 5, 6, 7, 8\]/);
    expect(yaml).not.toMatch(/test-aggregate:[\s\S]*!cancelled\(\)/);
  });
});
