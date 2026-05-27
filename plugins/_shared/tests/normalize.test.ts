import { describe, expect, it } from 'vitest';
import { normalizePath, normalizePaths } from '../lib/normalize.js';

describe('normalizePath', () => {
  it('normalizes simple relative paths', () => {
    expect(normalizePath('plugins/foo.ts')).toEqual({
      ok: true,
      path: 'plugins/foo.ts',
    });
  });

  it('strips leading ./ segments', () => {
    expect(normalizePath('./scripts/verify.ps1')).toEqual({
      ok: true,
      path: 'scripts/verify.ps1',
    });
  });

  it('rejects parent directory traversal', () => {
    const cases = ['../secret', 'plugins/../vendor/x', 'a/../../b'];
    for (const input of cases) {
      const result = normalizePath(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/parent directory/i);
      }
    }
  });

  it('rejects drive letters and absolute paths', () => {
    expect(normalizePath('C:\\Windows\\System32')).toMatchObject({ ok: false });
    expect(normalizePath('/etc/passwd')).toMatchObject({ ok: false });
    expect(normalizePath('\\repo\\file')).toMatchObject({ ok: false });
  });

  it('rejects backslashes', () => {
    const result = normalizePath('plugins\\ao-scope-guard\\lib\\x.ts');
    expect(result).toEqual({
      ok: false,
      reason: 'backslashes are not allowed; use forward slashes',
    });
  });

  it('rejects empty paths', () => {
    expect(normalizePath('   ')).toMatchObject({ ok: false });
  });
});

describe('normalizePaths', () => {
  it('normalizes a batch or returns the first failure', () => {
    expect(
      normalizePaths(['plugins/a.ts', './scripts/b.ps1']),
    ).toEqual({
      ok: true,
      paths: ['plugins/a.ts', 'scripts/b.ps1'],
    });

    expect(normalizePaths(['ok/path', '../bad'])).toMatchObject({ ok: false });
  });
});
