import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateSupervisorHeavyLaneRpcArtifacts, assertRpcMetadataCommitSha } from './lib/validate-supervisor-heavy-lane-rpc-artifacts.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('check-supervisor-test-wait-inventory guard (Issue #693)', () => {
  it('production inventory passes', () => {
    const out = execFileSync(
      'node',
      ['scripts/lib/supervisor-test-wait-inventory.mjs', 'production'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    expect(out).toContain('[PASS]');
  });

  it('negative regression corpus is rejected', () => {
    const out = execFileSync(
      'node',
      ['scripts/lib/supervisor-test-wait-inventory.mjs', 'negative-regression'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    expect(out).toContain('negative regression corpus rejected');
  });

  it('heavy-lane RPC artifact manifest is fail-closed clean', () => {
    const result = validateSupervisorHeavyLaneRpcArtifacts(repoRoot);
    expect(result.passCount).toBeGreaterThanOrEqual(3);
  });

  it('rejects @HEAD placeholder commitSha in RPC metadata', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    expect(() => assertRpcMetadataCommitSha('@HEAD', head, 'pass-test', repoRoot)).toThrow('exit:1');
    expect(() => assertRpcMetadataCommitSha(head, head, 'pass-test', repoRoot)).not.toThrow();
    exitSpy.mockRestore();
  });
});
