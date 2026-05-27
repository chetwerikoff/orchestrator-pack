import { describe, expect, it } from 'vitest';
import { normalizePath } from '@orchestrator-pack/shared/lib/normalize.js';
import { isControlArtifact } from '../lib/control_artifacts.js';
import { matchesGlob } from '../lib/glob_match.js';

describe('scope-guard normalization edge cases', () => {
  it('rejects parent traversal, drive letters, and absolute paths', () => {
    for (const input of ['../secret', 'plugins/../vendor/x', 'C:/Windows', '/etc/passwd']) {
      expect(normalizePath(input).ok).toBe(false);
    }
  });

  it('rejects mixed slashes and UNC-style paths', () => {
    expect(normalizePath('plugins\\ao-scope-guard\\lib\\x.ts')).toMatchObject({ ok: false });
    expect(normalizePath('\\\\server\\share\\file.ts')).toMatchObject({ ok: false });
  });

  it('treats symlink-like path segments as literal path components', () => {
    const result = normalizePath('plugins/link-target/file.ts');
    expect(result).toEqual({ ok: true, path: 'plugins/link-target/file.ts' });
  });

  it('matches control-artifact globs', () => {
    expect(isControlArtifact('docs/declarations/5.iter.json')).toBe(true);
    expect(isControlArtifact('.ao/declarations/5.iter.json')).toBe(true);
    expect(isControlArtifact('plugins/ao-scope-guard/lib/check.ts')).toBe(false);
  });

  it('matches declared globs used by runtime checks', () => {
    expect(
      matchesGlob('plugins/ao-scope-guard/tests/**', 'plugins/ao-scope-guard/tests/check.test.ts'),
    ).toBe(true);
    expect(
      matchesGlob('plugins/ao-scope-guard/tests/**', 'plugins/other/x.ts'),
    ).toBe(false);
  });
});
