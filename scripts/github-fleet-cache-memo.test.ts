import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { createGithubFleetCacheHarness, spawnPwshParallel } from './github-fleet-cache-test-harness.js';

const repoRoot = join(import.meta.dirname, '..');
const scriptsDir = join(repoRoot, 'scripts');

function commitLookupCount(auditFile: string): number {
  return readFileSync(auditFile, 'utf8')
    .split('\n')
    .filter((line) => line.includes('commits/sha1111111111111111111111111111111111111111')).length;
}

function repoViewCount(auditFile: string): number {
  return readFileSync(auditFile, 'utf8')
    .split('\n')
    .filter((line) => line.includes('repo view')).length;
}

describe.sequential('github-fleet-cache memo (Issue #453 AC#2)', () => {
  let harness: ReturnType<typeof createGithubFleetCacheHarness>;

  afterEach(() => {
    harness?.cleanup();
  });

  it('reuses SHA memo without a second gh api commits call', () => {
    harness = createGithubFleetCacheHarness('gh-fleet-memo-');
    const script = `
$ErrorActionPreference = 'Stop'
. '${join(scriptsDir, 'lib/Gh-PrChecks.ps1').replace(/'/g, "''")}'
$first = Invoke-GhOpenPrList -RepoRoot '${repoRoot.replace(/'/g, "''")}'
$second = Invoke-GhOpenPrList -RepoRoot '${repoRoot.replace(/'/g, "''")}'
if (-not $first[0].headCommittedAt) { throw 'missing headCommittedAt on first read' }
if (-not $second[0].headCommittedAt) { throw 'missing headCommittedAt on second read' }
Write-Output 'ok'
`;
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(commitLookupCount(harness.auditFile)).toBe(1);
    expect(repoViewCount(harness.auditFile)).toBe(0);
  });

  it('coalesces concurrent commit lookups for the same new SHA to at most two upstream calls', async () => {
    harness = createGithubFleetCacheHarness('gh-fleet-memo-');
    const worker = `
$ErrorActionPreference = 'Stop'
. '${join(scriptsDir, 'lib/Gh-PrChecks.ps1').replace(/'/g, "''")}'
$null = Invoke-GhOpenPrList -RepoRoot '${repoRoot.replace(/'/g, "''")}'
Write-Output 'done'
`;
    const parallel = await spawnPwshParallel(5, worker, repoRoot, harness.env);
    for (const result of parallel) {
      expect(result.status).toBe(0);
    }
    const sha1Lookups = commitLookupCount(harness.auditFile);
    expect(sha1Lookups).toBeGreaterThanOrEqual(1);
    expect(sha1Lookups).toBeLessThanOrEqual(2);
    expect(repoViewCount(harness.auditFile)).toBe(0);
  });
});
