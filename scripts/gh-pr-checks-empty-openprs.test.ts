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

  it('does not nest multi-PR arrays when assigned without @() wrapper', () => {
    const scriptsDir = path.join(repoRoot, 'scripts');
    const script = `
$ErrorActionPreference = 'Stop'
. '${path.join(scriptsDir, 'lib/Gh-PrChecks.ps1').replace(/'/g, "''")}'
$mockPrs = @(
  @{ number = 101; headRefOid = 'sha101'; baseRefName = 'main' },
  @{ number = 202; headRefOid = 'sha202'; baseRefName = 'main' }
)
$openPrs = ConvertTo-GhOpenPrArray -OpenPrs $mockPrs
if ($openPrs.Count -ne 2) { throw "expected 2 open PRs, got $($openPrs.Count)" }
if ($openPrs[0].number -is [System.Array]) { throw 'nested PR array: first element number is an array' }
$nested = @(ConvertTo-GhOpenPrArray -OpenPrs $mockPrs)
if ($nested.Count -ne 1) { throw "expected nested wrapper count 1, got $($nested.Count)" }
if (-not ($nested[0] -is [System.Array])) { throw 'nested wrapper should contain inner PR array as single element' }
if ($nested[0].Count -ne 2) { throw "expected inner array count 2, got $($nested[0].Count)" }
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
