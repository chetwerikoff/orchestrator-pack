import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./pr-scope-check.ps1', import.meta.url), 'utf8');

describe('trusted PR scope path enumeration', () => {
  it('uses the paginated Pull Request Files API instead of the 300-file diff endpoint', () => {
    // `--paginate` is the contract that prevents silent truncation after page three.
    expect(source).not.toContain('gh pr diff');
    expect(source).toContain("pulls/$PrNumber/files?per_page=100");
    expect(source).toContain("'--paginate'");
    expect(source).toContain('foreach ($entry in @($filesRead.value))');
    expect(source).toContain('$paths.Add($filename)');
  });

  it('fails closed on API failure or malformed file entries', () => {
    expect(source).toContain('if (-not $filesRead.ok)');
    expect(source).toContain('Format-GhSignalFailureDetail -Result $filesRead');
    expect(source).toContain('[string]::IsNullOrWhiteSpace($filename)');
    expect(source).toContain('entry without filename');
  });
});
