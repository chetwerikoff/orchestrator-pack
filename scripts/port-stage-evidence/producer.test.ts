import { describe, expect, it } from 'vitest';
import { ARTIFACT_PATHS, ARTIFACT_ROLES } from './producer.ts';
import { jsonStringValueRanges, scanPowerShellTokens, tsStringRanges, yamlScalarRanges } from './tokens.ts';

function scan(source: string, ranges?: readonly { start: number; end: number }[]) {
  return scanPowerShellTokens({
    sourcePath: 'fixture.txt',
    bytes: Buffer.from(source, 'utf8'),
    ranges,
    resolvesWholePath: (candidate) => candidate.replaceAll('\\', '/') === 'scripts/path with spaces/check.ps1',
  });
}

describe('Issue #1415 role-neutral port-stage evidence', () => {
  it('has exactly the three stable role mappings', () => {
    expect(ARTIFACT_ROLES).toEqual(['baseline', 'post-port', 'final']);
    expect(ARTIFACT_PATHS).toEqual({
      baseline: 'docs/investigations/orca-pwsh-zero-estate/baseline.json',
      'post-port': 'docs/investigations/orca-pwsh-zero-estate/post-port.json',
      final: 'docs/investigations/orca-pwsh-zero-estate/final.json',
    });
  });

  it('records exact LF/UTF-8 byte coordinates and preserves matched bytes', () => {
    const source = 'α run scripts/verify.ps1\r\npwsh -File scripts/check-reusable.ps1\n';
    const tokens = scan(source);
    expect(tokens.map(({ line, column, tokenKind, matchedBytes }) => ({ line, column, tokenKind, matchedBytes }))).toEqual([
      { line: 1, column: 8, tokenKind: 'script', matchedBytes: 'scripts/verify.ps1' },
      { line: 2, column: 1, tokenKind: 'runtime', matchedBytes: 'pwsh' },
      { line: 2, column: 12, tokenKind: 'script', matchedBytes: 'scripts/check-reusable.ps1' },
    ]);
  });

  it('handles whole-delimited paths, quoted commands and unmatched delimiters deterministically', () => {
    const tokens = scan('"scripts/path with spaces/check.ps1" "pwsh -File scripts/verify.ps1" `scripts/verify.ps1\n');
    expect(tokens.map((token) => [token.tokenKind, token.matchedBytes])).toEqual([
      ['script', 'scripts/path with spaces/check.ps1'],
      ['runtime', 'pwsh'],
      ['script', 'scripts/verify.ps1'],
      ['script', 'scripts/verify.ps1'],
    ]);
  });

  it('limits workflow scanning to scalar value ranges including block scalar content', () => {
    const bytes = Buffer.from('pwsh_key: harmless\nrun: pwsh -File scripts/verify.ps1\nscript: |\n  scripts/check-reusable.ps1\n', 'utf8');
    const tokens = scanPowerShellTokens({ sourcePath: '.github/workflows/x.yml', bytes, ranges: yamlScalarRanges(bytes), resolvesWholePath: () => false });
    expect(tokens.map((token) => token.matchedBytes)).toEqual(['pwsh', 'scripts/verify.ps1', 'scripts/check-reusable.ps1']);
  });

  it('scans JSON/TypeScript string values but not JSON keys or TS comments', () => {
    const json = Buffer.from('{"pwsh":"scripts/verify.ps1","other":"pwsh"}', 'utf8');
    expect(scanPowerShellTokens({ sourcePath: 'package.json', bytes: json, ranges: jsonStringValueRanges(json), resolvesWholePath: () => false }).map((token) => token.matchedBytes)).toEqual(['scripts/verify.ps1', 'pwsh']);
    const ts = Buffer.from('// pwsh\nexport default { value: "scripts/verify.ps1", shell: `pwsh` };', 'utf8');
    expect(scanPowerShellTokens({ sourcePath: 'tool.config.ts', bytes: ts, ranges: tsStringRanges(ts), resolvesWholePath: () => false }).map((token) => token.matchedBytes)).toEqual(['scripts/verify.ps1', 'pwsh']);
  });
});
