import { describe, expect, it, vi } from 'vitest';
import { runProcessSync } from '#opk-kernel/subprocess';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  validateSupervisorHeavyLaneRpcArtifacts,
  assertRpcMetadataCommitSha,
  resolveExpectedCaptureSha,
} from './lib/validate-supervisor-heavy-lane-rpc-artifacts.mjs';
import { resolveHeavyLaneFingerprint } from './lib/vitest-ci-lanes.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function runInventory(mode: 'production' | 'negative-regression'): string {
  const result = runProcessSync({
    command: 'pwsh',
    args: [
      '-NoProfile',
      '-File',
      'scripts/check-supervisor-test-wait-inventory.ps1',
      '-Root',
      repoRoot,
      '-Mode',
      mode,
    ],
    cwd: repoRoot,
    encoding: 'utf8',
    inheritParentEnv: true,
  });
  if (!result.ok) {
    throw new Error(`inventory wrapper failed ${result.exitCode ?? result.outcome}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return result.stdout;
}

describe('check-supervisor-test-wait-inventory guard (Issue #693)', () => {
  it('production inventory passes', () => {
    expect(runInventory('production')).toContain('[PASS]');
  });

  it('negative regression corpus is rejected', () => {
    expect(runInventory('negative-regression')).toContain('negative regression corpus rejected');
  });

  it('derives heavy-lane fingerprint from vitest.config.ts', () => {
    expect(resolveHeavyLaneFingerprint(repoRoot)).toBe('CI=true maxWorkers=1 fileParallelism=false');
  });

  it('heavy-lane RPC artifact manifest is fail-closed clean', () => {
    const result = validateSupervisorHeavyLaneRpcArtifacts(repoRoot);
    expect(result.passCount).toBeGreaterThanOrEqual(3);
  });

  it('rejects @HEAD placeholder and stale ancestor commitSha in RPC metadata', () => {
    const expectedCaptureSha = resolveExpectedCaptureSha(repoRoot);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    expect(() => assertRpcMetadataCommitSha('@HEAD', expectedCaptureSha, 'pass-test', repoRoot)).toThrow('exit:1');
    expect(() =>
      assertRpcMetadataCommitSha(expectedCaptureSha, expectedCaptureSha, 'pass-test', repoRoot),
    ).not.toThrow();
    expect(() =>
      assertRpcMetadataCommitSha('fe9a7f3e669013211689d90891ec25fdb764ef0b', expectedCaptureSha, 'pass-test', repoRoot),
    ).toThrow('exit:1');
    exitSpy.mockRestore();
  });
});
