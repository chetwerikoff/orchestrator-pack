import { describe, expect, it } from 'vitest';
import { validateDeclaredScope } from '../lib/validate.js';

const baseConstraints = {
  denylist: ['vendor/**', 'packages/core/**', '.ao/**'],
  allowed_roots: ['plugins/**', 'scripts/**', 'docs/**'],
};

describe('validateDeclaredScope', () => {
  it('accepts declared paths within allowed_roots and outside denylist', () => {
    const result = validateDeclaredScope(
      {
        declared_paths: ['plugins/ao-task-declaration/lib/validate.ts'],
        declared_globs: ['plugins/ao-task-declaration/tests/**'],
      },
      baseConstraints,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.declared_paths).toEqual([
        'plugins/ao-task-declaration/lib/validate.ts',
      ]);
    }
  });

  it('rejects declared paths that intersect the denylist', () => {
    const result = validateDeclaredScope(
      {
        declared_paths: ['vendor/secret.ts'],
        declared_globs: [],
      },
      baseConstraints,
    );

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.errors.some((error) => error.includes('intersects issue denylist'))).toBe(
        true,
      );
    }
  });

  it('rejects declared paths outside allowed_roots when present', () => {
    const result = validateDeclaredScope(
      {
        declared_paths: ['README.md'],
        declared_globs: [],
      },
      baseConstraints,
    );

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.errors.some((error) => error.includes('outside issue allowed_roots'))).toBe(
        true,
      );
    }
  });

  it('rejects declared globs that overlap denylist patterns', () => {
    const result = validateDeclaredScope(
      {
        declared_paths: [],
        declared_globs: ['vendor/**'],
      },
      baseConstraints,
    );

    expect(result).toMatchObject({ ok: false });
  });

  it('allows declarations without allowed_roots upper bound', () => {
    const result = validateDeclaredScope(
      {
        declared_paths: ['README.md'],
        declared_globs: [],
      },
      { denylist: ['vendor/**'] },
    );

    expect(result.ok).toBe(true);
  });

  it('requires at least one declared path or glob', () => {
    const result = validateDeclaredScope(
      {
        declared_paths: [],
        declared_globs: [],
      },
      { denylist: ['vendor/**'] },
    );

    expect(result).toMatchObject({ ok: false });
  });
});
