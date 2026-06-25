import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');

describe('Get-GhChecksBundleByPr empty open PRs (Issue #205)', () => {
  it('returns an empty bundle without binding errors', () => {
    const scriptsDir = path.join(repoRoot, 'scripts');
    const script = `
$ErrorActionPreference = 'Stop'
. '${path.join(scriptsDir, 'lib/Gh-PrChecks.ps1').replace(/'/g, "''")}'
$bundle = Get-GhChecksBundleByPr -RepoRoot '${scriptsDir.replace(/'/g, "''")}' -OpenPrs @() -MergeRequiredNames { param($p) @{ names = @(); lookupFailed = $false } }
if (@($bundle.ciChecksByPr.Keys).Count -ne 0) { throw 'expected empty ciChecksByPr' }
if (@($bundle.requiredCheckNamesByPr.Keys).Count -ne 0) { throw 'expected empty requiredCheckNamesByPr' }
Write-Output 'ok'
`;
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: scriptsDir,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ok');
    expect(result.stderr ?? '').not.toMatch(/empty collection/i);
  });

  it('preserves empty arrays from ConvertTo-GhOpenPrArray in scalar hashtable assignments', () => {
    const scriptsDir = path.join(repoRoot, 'scripts');
    const script = `
$ErrorActionPreference = 'Stop'
. '${path.join(scriptsDir, 'lib/Gh-PrChecks.ps1').replace(/'/g, "''")}'
$payload = @{ openPrs = (ConvertTo-GhOpenPrArray -OpenPrs $null) }
if ($null -eq $payload.openPrs) { throw 'expected empty array, got null' }
if ($payload.openPrs.Count -ne 0) { throw 'expected count 0' }
$filtered = @{ openPrs = (ConvertTo-GhOpenPrArray -OpenPrs @($null)) }
if ($null -eq $filtered.openPrs) { throw 'expected filtered empty array, got null' }
Write-Output 'ok'
`;
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: scriptsDir,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ok');
  });
});
