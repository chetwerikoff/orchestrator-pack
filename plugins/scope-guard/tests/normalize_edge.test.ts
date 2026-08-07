import { describe, expect, it } from 'vitest';
import { normalizePath } from '@orchestrator-pack/shared/lib/normalize.js';
import { isControlArtifact } from '../lib/control_artifacts.js';
import {
  globIsWithinAllowedRoot,
  globPatternsOverlap,
  matchesGlob,
  parsePathPattern,
} from '../lib/glob_match.js';

describe('scope-guard normalization edge cases', () => {
  it('rejects parent traversal, drive letters, and absolute paths', () => {
    for (const input of ['../secret', 'plugins/../vendor/x', 'C:/Windows', '/etc/passwd']) {
      expect(normalizePath(input).ok).toBe(false);
    }
  });

  it('rejects mixed slashes and UNC-style paths', () => {
    expect(normalizePath('plugins\\scope-guard\\lib\\x.ts')).toMatchObject({ ok: false });
    expect(normalizePath('\\\\server\\share\\file.ts')).toMatchObject({ ok: false });
  });

  it('treats symlink-like path segments as literal path components', () => {
    const result = normalizePath('plugins/link-target/file.ts');
    expect(result).toEqual({ ok: true, path: 'plugins/link-target/file.ts' });
  });

  it('matches control-artifact globs', () => {
    expect(isControlArtifact('docs/declarations/5.iter.json')).toBe(true);
    expect(isControlArtifact('.orchestrator-pack/declarations/5.iter.json')).toBe(true);
    expect(isControlArtifact('plugins/scope-guard/lib/check.ts')).toBe(false);
  });

  it('matches declared globs used by runtime checks', () => {
    expect(
      matchesGlob('plugins/scope-guard/tests/**', 'plugins/scope-guard/tests/check.test.ts'),
    ).toBe(true);
    expect(
      matchesGlob('plugins/scope-guard/tests/**', 'plugins/other/x.ts'),
    ).toBe(false);
  });

  it('keeps literal, directory, and direct-child kinds distinct', () => {
    expect(matchesGlob('plugins/scope-guard', 'plugins/scope-guard')).toBe(true);
    expect(matchesGlob('plugins/scope-guard', 'plugins/scope-guard/lib/check.ts')).toBe(false);
    expect(matchesGlob('plugins/scope-guard/', 'plugins/scope-guard/lib/check.ts')).toBe(true);
    expect(matchesGlob('plugins/scope-guard/**', 'plugins/scope-guard')).toBe(true);
    expect(matchesGlob('plugins/scope-guard/*', 'plugins/scope-guard/lib')).toBe(true);
    expect(matchesGlob('plugins/scope-guard/*', 'plugins/scope-guard/lib/check.ts')).toBe(false);
  });

  it('decides repeated-double-star inclusion and intersection exactly', () => {
    expect(globIsWithinAllowedRoot('a/**/b/**/c', 'a/**/c')).toBe(true);
    expect(globIsWithinAllowedRoot('a/**/b/**/c', 'a/**/d/**/c')).toBe(false);
    expect(globPatternsOverlap('a/**/b/**/c', 'a/**/d/**/c')).toBe(true);
    expect(globPatternsOverlap('a/**/b/**/c', 'a/**/d/**/e')).toBe(false);
  });

  it.each([
    '',
    '../outside.ts',
    '/absolute.ts',
    'C:/drive.ts',
    'plugins\\mixed.ts',
    'plugins//duplicate.ts',
    'plugins/foo**/bar.ts',
    'plugins/foo*/bar.ts',
    'plugins/?/bar.ts',
    'plugins/[ab]/bar.ts',
  ])('rejects malformed pattern %s', (pattern) => {
    expect(parsePathPattern(pattern)).toMatchObject({ ok: false });
  });
});
