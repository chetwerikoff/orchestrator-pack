import { describe, expect, it } from 'vitest';
import type { DeclarationSnapshot } from '@orchestrator-pack/shared/lib/declaration_schema.js';
import { checkScope, classifyScopedPaths } from '../lib/check.js';

const declaration: DeclarationSnapshot = {
  issue_number: 5,
  iteration_id: 'test-iteration',
  iteration_id_source: 'wrapper_generated',
  supersedes: null,
  created_at: '2026-05-27T00:00:00.000Z',
  baseline: {
    commit_sha: 'abc123def4567890abc123def4567890abc12345',
    worktree_dirty: false,
    active_scope_hash: 'sha256:deadbeef',
  },
  declared_paths: ['plugins/scope-guard/lib/check.ts'],
  declared_globs: ['plugins/scope-guard/tests/**'],
  amendments: [],
};

const denylist = ['vendor/**', 'packages/core/**', '.orchestrator-pack/**'];

describe('checkScope', () => {
  it('allows pure control-artifact changes without a declaration', () => {
    const result = checkScope(
      ['docs/declarations/5.test.json', '.orchestrator-pack/declarations/5.test.json'],
      null,
      denylist,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checked_paths).toEqual([]);
      expect(result.skipped_control_artifacts).toEqual([
        'docs/declarations/5.test.json',
        '.orchestrator-pack/declarations/5.test.json',
      ]);
    }
  });

  it('rejects mixed control-artifact and scoped paths without a declaration', () => {
    const result = checkScope(
      ['docs/declarations/5.test.json', 'README.md'],
      null,
      denylist,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_declaration');
      expect(result.out_of_scope).toEqual(['README.md']);
    }
  });

  it('accepts in-scope paths and skips control artifacts in mixed sets', () => {
    const result = checkScope(
      [
        'plugins/scope-guard/lib/check.ts',
        'docs/declarations/5.test.json',
      ],
      declaration,
      denylist,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checked_paths).toEqual(['plugins/scope-guard/lib/check.ts']);
    }
  });

  it('rejects out-of-scope paths', () => {
    const result = checkScope(['README.md'], declaration, denylist);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('scope_violation');
      expect(result.out_of_scope).toEqual(['README.md']);
    }
  });

  it('rejects denylisted paths even when a broad glob would allow them', () => {
    const broadDeclaration: DeclarationSnapshot = {
      ...declaration,
      declared_paths: [],
      declared_globs: ['**'],
    };

    const result = checkScope(['vendor/secret.txt'], broadDeclaration, denylist);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.denied).toEqual(['vendor/secret.txt']);
    }
  });

  it('rejects invalid normalized paths', () => {
    const result = checkScope(['../outside.ts'], declaration, denylist);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_path');
      expect(result.invalid_paths[0]?.path).toBe('../outside.ts');
    }
  });

  it('uses marked directory entries passed through declared_paths by the live-Issue route', () => {
    const classification = classifyScopedPaths(
      ['scripts/tools/nested/tool.ts', 'scripts/other.ts'],
      {
        denylist: [],
        declaredPaths: ['scripts/tools/'],
        declaredGlobs: [],
      },
    );

    expect(classification.outOfScope).toEqual(['scripts/other.ts']);
  });

  it('keeps nested file-pattern classification isolated from declaration admission', () => {
    const classification = classifyScopedPaths(
      [
        'plugins/tests/check.test.ts',
        'plugins/scope-guard/tests/check.test.ts',
        'plugins/scope-guard/tests/secret-access.test.ts',
        'plugins/scope-guard/lib/check.test.ts',
      ],
      {
        denylist: ['plugins/**/tests/secret*.test.ts'],
        declaredPaths: [],
        declaredGlobs: ['plugins/**/tests/*.test.ts'],
      },
    );

    expect(classification.denied).toEqual([
      'plugins/scope-guard/tests/secret-access.test.ts',
    ]);
    expect(classification.outOfScope).toEqual([
      'plugins/scope-guard/lib/check.test.ts',
    ]);
  });

  it('keeps exact literals exact in changed-path classification', () => {
    const classification = classifyScopedPaths(
      ['scripts/tool', 'scripts/tool/child.ts'],
      {
        denylist: [],
        declaredPaths: ['scripts/tool'],
        declaredGlobs: [],
      },
    );

    expect(classification.outOfScope).toEqual(['scripts/tool/child.ts']);
  });
});
