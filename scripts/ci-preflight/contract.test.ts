import { describe, expect, it } from 'vitest';
import { TABLE, INVENTORY, WORKFLOW_BLOB_SHA, WORKFLOW_CONTENT_SHA256, workflowCoverage, nativeOutput } from './contract.ts';
import { directDependencyExecutable, pesterProbeEnvironment } from './cli.ts';

describe('ci preflight contract', () => {
  it('keeps the exact seven-row fixed table', () => {
    expect(TABLE.map(row => row.row_id)).toEqual([
      'structure.verify', 'structure.reusable', 'structure.cheap-wins',
      'structure.verify-runtime', 'typescript.typecheck', 'vitest.light-lane-all', 'pester.track',
    ]);
    expect(TABLE[4].args).toEqual(['--no-install', 'tsc', '--project', 'tsconfig.base.json', '--noEmit']);
    expect(TABLE[5].paths).toContain('scripts/vitest-ci-lanes.config.json');
  });

  it('keeps callable omissions distinct from workflow-only records', () => {
    const coverage = workflowCoverage();
    expect(coverage.inventory).toHaveLength(INVENTORY.length);
    expect(coverage.inventory.filter(item => item.selection === 'not_selected')).toHaveLength(7);
    expect(coverage.inventory.filter(item => item.selection === 'not_applicable')).toHaveLength(13);
    expect(coverage.inventory.every(item => item.execution === 'not_started' && item.command_verdict === 'not_evaluated' && item.workflow_coverage === 'uncovered')).toBe(true);
    expect(coverage.inventory.find(item => item.inventory_id === 'topology-producer.github-output')?.rationale).toContain('fallback_classification');
  });

  it('binds both workflow identity hashes and canonical empty output', () => {
    expect(WORKFLOW_BLOB_SHA).toMatch(/^[0-9a-f]{40}$/);
    expect(WORKFLOW_CONTENT_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(nativeOutput('preflight-probe').stdout.sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('probes the real TypeScript executable and preserves Pester discovery variables', () => {
    expect(directDependencyExecutable('typescript')).toBe('tsc');
    expect(directDependencyExecutable('vitest')).toBe('vitest');
    expect(pesterProbeEnvironment({ HOME: '/home/tester', PSModulePath: '/home/tester/modules', CI: 'true' })).toEqual({
      HOME: '/home/tester',
      PSModulePath: '/home/tester/modules',
    });
  });
});
