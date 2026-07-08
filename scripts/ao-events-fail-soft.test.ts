import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ao events fail-soft wrapper (Issue #688)', () => {
  const repoRoot = join(import.meta.dirname, '..');
  const lib = join(repoRoot, 'scripts/lib/Invoke-AoCliJson.ps1');
  const stub = join(repoRoot, 'scripts/fixtures/ao-events-removed-stub.ps1');
  const source = readFileSync(lib, 'utf8');

  it('exposes AO events availability and degraded classification helpers', () => {
    expect(source).toContain('function Test-AoEventsCliAvailable');
    expect(source).toContain('function Get-AoEventsDegradedClassification');
    expect(source).toContain("Reason = 'removed_cli_surface'");
  });

  it('Get-AoEventsSince returns an empty array when the events CLI is degraded', () => {
    expect(source).toContain('Test-AoEventsCliAvailable -AoCommand $AoCommand');
    expect(source).toMatch(/return @\(\)/);
    expect(source).toMatch(/Set-AoEventsDegradedClassification/);
  });

  it('returns empty events and classified degradation against removed CLI stub', () => {
    const out = execFileSync(
      'pwsh',
      [
        '-NoProfile',
        '-Command',
        `
          . '${lib}'
          $Script:AoEventsCliProbeState = $null
          $Script:AoEventsDegradedClassification = $null
          $events = Get-AoEventsSince -SinceMinutes 60 -AoCommand '${stub}'
          $degraded = Get-AoEventsDegradedClassification
          [pscustomobject]@{ count = @($events).Count; degraded = [bool]$degraded.degraded; reason = [string]$degraded.reason } | ConvertTo-Json -Compress
        `,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    const lines = out.trim().split(/\r?\n/).filter((line) => line.trim().length > 0);
    const parsed = JSON.parse(lines[lines.length - 1]) as { count: number; degraded: boolean; reason: string };
    expect(parsed.count).toBe(0);
    expect(parsed.degraded).toBe(true);
    expect(parsed.reason).toBe('removed_cli_surface');
  });
  it('surfaces non-removed ao events failures instead of fail-soft empty events', () => {
    const authStub = join(repoRoot, 'scripts/fixtures/ao-events-auth-fail-stub.ps1');
    expect(() => {
      execFileSync(
        'pwsh',
        [
          '-NoProfile',
          '-Command',
          `
            . '${lib}'
            $Script:AoEventsCliProbeState = $null
            $Script:AoEventsDegradedClassification = $null
            Get-AoEventsSince -SinceMinutes 60 -AoCommand '${authStub}' | Out-Null
          `,
        ],
        { cwd: repoRoot, encoding: 'utf8' },
      );
    }).toThrow();
    expect(source).toContain('function Test-AoEventsRemovedCliSurfaceText');
  });

});
