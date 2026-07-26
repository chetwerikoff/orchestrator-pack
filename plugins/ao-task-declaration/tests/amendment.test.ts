import { describe, expect, it } from 'vitest';
import type { DeclarationSnapshot } from '@orchestrator-pack/shared/lib/declaration_schema.js';
import { applyAmendment } from '../lib/amendment.js';
import validSnapshot from '../../_shared/tests/fixtures/declarations/valid-snapshot.json' with {
  type: 'json',
};

const constraints = {
  denylist: ['vendor/**', 'packages/core/**'],
  allowed_roots: ['plugins/**', 'docs/**'],
};

function loadFixture(): DeclarationSnapshot {
  return structuredClone(validSnapshot) as DeclarationSnapshot;
}

describe('applyAmendment', () => {
  it('records the first amendment and updates active scope hash', () => {
    const existing = loadFixture();
    const result = applyAmendment(
      existing,
      {
        declared_paths: [
          'plugins/_shared/lib/normalize.ts',
          'plugins/ao-task-declaration/lib/validate.ts',
        ],
        declared_globs: ['plugins/_shared/tests/**'],
        reason: 'add validator module',
        actor: 'worker-1',
      },
      constraints,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.amendments).toHaveLength(1);
      expect(result.snapshot.amendments[0]?.applied).toBe(true);
      expect(result.snapshot.baseline.active_scope_hash).toMatch(/^sha256:/);
      expect(result.snapshot.baseline.active_scope_hash).not.toBe(
        existing.baseline.active_scope_hash,
      );
    }
  });

  it('rejects a second amendment within the same iteration', () => {
    const existing = loadFixture();
    const first = applyAmendment(
      existing,
      {
        declared_paths: ['plugins/ao-task-declaration/lib/validate.ts'],
        declared_globs: [],
        reason: 'narrow scope',
        actor: 'worker-1',
      },
      constraints,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    const second = applyAmendment(
      first.snapshot,
      {
        declared_paths: ['plugins/ao-task-declaration/lib/mirror.ts'],
        declared_globs: [],
        reason: 'another change',
        actor: 'worker-1',
      },
      constraints,
    );

    expect(second).toEqual({
      ok: false,
      error:
        'amendment rejected: one amendment per iteration_id has already been recorded',
    });
  });
});
