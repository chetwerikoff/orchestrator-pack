import { describe, expect, it } from 'vitest';
import { classifyScopedPaths } from '../../ao-scope-guard/lib/check.js';
import {
  globIsWithinAllowedRoot,
  globPatternsOverlap,
  matchesGlob,
} from '../lib/glob_match.js';
import { validateDeclaredScope } from '../lib/validate.js';

const baseConstraints = {
  denylist: ['vendor/**', 'packages/core/**', '.ao/**'],
  allowed_roots: ['plugins/**', 'scripts/**', 'docs/**'],
};

const predicateVerdictMatrix = [
  {
    name: 'exact literal is not a directory',
    declared: 'scripts/tool.ts',
    allowed: 'scripts/tool.ts',
    denied: 'scripts/other.ts',
    path: 'scripts/tool.ts',
    matches: true,
    within: true,
    overlap: false,
    admission: true,
    classification: 'allowed',
  },
  {
    name: 'trailing slash is a directory root',
    declared: 'scripts/tools/',
    allowed: 'scripts/',
    denied: 'scripts/private/**',
    path: 'scripts/tools/nested/tool.ts',
    matches: true,
    within: true,
    overlap: false,
    admission: true,
    classification: 'allowed',
  },
  {
    name: 'terminal double-star includes the root itself',
    declared: 'scripts/tools/**',
    allowed: 'scripts/**',
    denied: 'scripts/private/**',
    path: 'scripts/tools',
    matches: true,
    within: true,
    overlap: false,
    admission: true,
    classification: 'allowed',
  },
  {
    name: 'terminal single-star grants one child only',
    declared: 'scripts/tools/*',
    allowed: 'scripts/**',
    denied: 'scripts/private/**',
    path: 'scripts/tools/nested/tool.ts',
    matches: false,
    within: true,
    overlap: false,
    admission: true,
    classification: 'out-of-scope',
  },
  {
    name: 'repeated double-star inclusion',
    declared: 'a/**/b/**/c',
    allowed: 'a/**/c',
    denied: 'a/**/d/**/e',
    path: 'a/x/b/y/c',
    matches: true,
    within: true,
    overlap: false,
    admission: true,
    classification: 'allowed',
  },
  {
    name: 'repeated double-star intersection without inclusion',
    declared: 'a/**/b/**/c',
    allowed: 'a/**',
    denied: 'a/**/d/**/c',
    path: 'a/b/d/c',
    matches: true,
    within: true,
    overlap: true,
    admission: false,
    classification: 'denied',
  },
  {
    name: 'final-segment deny intersection',
    declared: 'scripts/foo*.test.ts',
    allowed: 'scripts/**',
    denied: 'scripts/foo-secret.test.ts',
    path: 'scripts/foo-ok.test.ts',
    matches: true,
    within: true,
    overlap: true,
    admission: false,
    classification: 'allowed',
  },
  {
    name: 'nested file pattern deny priority',
    declared: 'plugins/**/tests/*.test.ts',
    allowed: 'plugins/**',
    denied: 'plugins/**/tests/secret*.test.ts',
    path: 'plugins/ao-scope-guard/tests/secret-access.test.ts',
    matches: true,
    within: true,
    overlap: true,
    admission: false,
    classification: 'denied',
  },
] as const;

describe('allowed-root predicate verdict matrix', () => {
  for (const row of predicateVerdictMatrix) {
    it(row.name, () => {
      expect(matchesGlob(row.declared, row.path)).toBe(row.matches);
      expect(globIsWithinAllowedRoot(row.declared, row.allowed)).toBe(row.within);
      expect(globPatternsOverlap(row.declared, row.denied)).toBe(row.overlap);

      const admission = validateDeclaredScope(
        { declared_paths: [], declared_globs: [row.declared] },
        { denylist: [row.denied], allowed_roots: [row.allowed] },
      );
      expect(admission.ok).toBe(row.admission);

      const classification = classifyScopedPaths([row.path], {
        denylist: [row.denied],
        declaredPaths: [],
        declaredGlobs: [row.declared],
      });
      const verdict =
        classification.denied.length > 0
          ? 'denied'
          : classification.outOfScope.length > 0
            ? 'out-of-scope'
            : 'allowed';
      expect(verdict).toBe(row.classification);
    });
  }
});

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

  it('treats an unmarked allowed-root literal as exact authority', () => {
    const result = validateDeclaredScope(
      {
        declared_paths: ['plugins/ao-task-declaration/lib/validate.ts'],
        declared_globs: [],
      },
      {
        denylist: ['vendor/**'],
        allowed_roots: ['plugins/ao-task-declaration'],
      },
    );

    expect(result).toMatchObject({ ok: false });
  });

  it.each([
    'plugins/ao-task-declaration/',
    'plugins/ao-task-declaration/**',
  ])('accepts the marked directory root %s', (root) => {
    const result = validateDeclaredScope(
      {
        declared_paths: ['plugins/ao-task-declaration/lib/validate.ts'],
        declared_globs: [],
      },
      {
        denylist: ['vendor/**'],
        allowed_roots: [root],
      },
    );

    expect(result.ok).toBe(true);
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

  it('rejects malformed pattern syntax with an indexed error', () => {
    const result = validateDeclaredScope(
      {
        declared_paths: [],
        declared_globs: ['plugins/foo*/tests/**'],
      },
      baseConstraints,
    );

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.errors).toEqual([
        expect.stringContaining('declared_globs[0]'),
      ]);
    }
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
