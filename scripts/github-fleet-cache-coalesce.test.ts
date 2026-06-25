import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { createGithubFleetCacheHarness, type FleetHarness } from './github-fleet-cache-test-harness.ts';

const repoRoot = join(import.meta.dirname, '..');
const scriptsDir = join(repoRoot, 'scripts');

function countAuditMatches(auditFile: string, pattern: RegExp): number {
  const lines = readFileSync(auditFile, 'utf8').split('\n').filter(Boolean);
  return lines.filter((line) => pattern.test(line)).length;
}

function invokeOpenPrListScript(packRoot: string): string {
  const packRootEscaped = packRoot.replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Stop'
. '${join(scriptsDir, 'lib/Gh-PrChecks.ps1').replace(/'/g, "''")}'
$prs = Invoke-GhOpenPrList -RepoRoot '${packRootEscaped}'
if (@($prs).Count -lt 1) { throw 'expected PR rows' }
Write-Output "ok:$($prs[0].headRefOid)"
`;
}

describe('github-fleet-cache coalesce (Issue #453 AC#1)', () => {
  let harness: FleetHarness;

  afterEach(() => {
    harness?.cleanup();
  });

  it('cold single reader performs one upstream gh pr list populate', () => {
    harness = createGithubFleetCacheHarness();
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', invokeOpenPrListScript(repoRoot)], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(countAuditMatches(harness.auditFile, /\bpr list\b/)).toBe(1);
  });

  it('warm snapshot serves concurrent readers with zero additional gh pr list calls', () => {
    harness = createGithubFleetCacheHarness();
    const warm = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', invokeOpenPrListScript(repoRoot)], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(warm.status).toBe(0);

    const workerScript = invokeOpenPrListScript(repoRoot).replace('Write-Output', '$null = $prs; Write-Output');
    const parallel = Array.from({ length: 5 }, () =>
      spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', workerScript], {
        cwd: repoRoot,
        env: harness.env,
        encoding: 'utf8',
      }),
    );
    for (const result of parallel) {
      expect(result.status).toBe(0);
    }
    expect(countAuditMatches(harness.auditFile, /\bpr list\b/)).toBe(1);
  });

  it('cold concurrent readers coalesce populate to at most two gh pr list calls', () => {
    harness = createGithubFleetCacheHarness();
    const workerScript = `
$ErrorActionPreference = 'Stop'
. '${join(scriptsDir, 'lib/Gh-PrChecks.ps1').replace(/'/g, "''")}'
$null = Invoke-GhOpenPrList -RepoRoot '${repoRoot.replace(/'/g, "''")}'
Write-Output 'done'
`;
    const parallel = Array.from({ length: 9 }, () =>
      spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', workerScript], {
        cwd: repoRoot,
        env: harness.env,
        encoding: 'utf8',
      }),
    );
    for (const result of parallel) {
      expect(result.status).toBe(0);
    }
    const listCalls = countAuditMatches(harness.auditFile, /\bpr list\b/);
    expect(listCalls).toBeGreaterThanOrEqual(1);
    expect(listCalls).toBeLessThanOrEqual(2);
  });

  it('propagates populate errors to waiters without silent per-child fallback', () => {
    harness = createGithubFleetCacheHarness();
    writeFileSync(
      join(harness.root, 'bin/gh'),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$GH_FLEET_TEST_AUDIT_FILE"\necho 'rate limited' >&2\nexit 1\n`,
      { mode: 0o755 },
    );

    const workerScript = `
$ErrorActionPreference = 'Stop'
. '${join(scriptsDir, 'lib/Gh-PrChecks.ps1').replace(/'/g, "''")}'
try {
  $null = Invoke-GhOpenPrList -RepoRoot '${repoRoot.replace(/'/g, "''")}'
  throw 'expected failure'
}
catch {
  if ($_.Exception.Message -notmatch 'gh pr list failed') { throw }
  Write-Output 'failed-expected'
}
`;
    const first = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', workerScript], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('failed-expected');

    const second = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', workerScript], {
      cwd: repoRoot,
      env: harness.env,
      encoding: 'utf8',
    });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('failed-expected');
    expect(countAuditMatches(harness.auditFile, /\bpr list\b/)).toBe(1);
  });
});
