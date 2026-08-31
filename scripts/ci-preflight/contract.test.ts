// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60

import { describe, expect, it } from 'vitest';
import { TABLE, INVENTORY, WORKFLOW_BLOB_SHA, WORKFLOW_CONTENT_SHA256, workflowCoverage, workflowHashes, nativeOutput } from './contract.ts';
import { directDependencyExecutable } from './cli.ts';

describe('ci preflight contract', () => {
  it('keeps the exact six-row fixed table', () => {
    expect(TABLE.map(row => row.row_id)).toEqual([
      'structure.verify', 'structure.reusable', 'structure.cheap-wins',
      'structure.verify-runtime', 'typescript.typecheck', 'vitest.light-lane-all',
    ]);
    expect(TABLE[4].args).toEqual(['--no-install', 'tsc', '--project', 'tsconfig.base.json', '--noEmit']);
    expect(TABLE[5].paths).toContain('scripts/vitest-ci-lanes.config.json');
    expect(TABLE.slice(0, 4).every(row => row.command === process.execPath)).toBe(true);
    expect(TABLE[5].command).toBe(process.execPath);
    expect(JSON.stringify(TABLE)).not.toContain('.ps1');
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
    const hashes = workflowHashes(process.cwd());
    expect(WORKFLOW_BLOB_SHA).toBe(hashes.blob);
    expect(WORKFLOW_CONTENT_SHA256).toBe(hashes.content);
    expect(nativeOutput('preflight-probe').stdout.sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('probes the real TypeScript executables', () => {
    expect(directDependencyExecutable('typescript')).toBe('tsc');
    expect(directDependencyExecutable('vitest')).toBe('vitest');
  });
});
