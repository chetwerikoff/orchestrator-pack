import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateDeclarationSnapshot } from '../lib/declaration_schema.js';

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'declarations',
  'valid-snapshot.json',
);

describe('validateDeclarationSnapshot', () => {
  it('accepts a valid declaration snapshot fixture', () => {
    const raw = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;
    const result = validateDeclarationSnapshot(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.issue_number).toBe(4);
      expect(result.snapshot.iteration_id_source).toBe('ao_session');
    }
  });

  it('rejects snapshots missing mandatory metadata', () => {
    const result = validateDeclarationSnapshot({
      issue_number: 1,
      iteration_id: 'x',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects invalid iteration_id_source values', () => {
    const base = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
    const result = validateDeclarationSnapshot({
      ...base,
      iteration_id_source: 'manual',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects baseline hashes without sha256 prefix', () => {
    const base = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
    const result = validateDeclarationSnapshot({
      ...base,
      baseline: {
        ...(base.baseline as object),
        active_scope_hash: 'not-a-hash',
      },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects unnormalized declared_paths', () => {
    const base = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
    const result = validateDeclarationSnapshot({
      ...base,
      declared_paths: ['../vendor/secret.ts'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('declared_paths'))).toBe(true);
    }
  });

  it('rejects declared_paths that need normalization', () => {
    const base = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
    const result = validateDeclarationSnapshot({
      ...base,
      declared_paths: ['./plugins/_shared/lib/normalize.ts'],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects backslashes in declared_globs', () => {
    const base = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
    const result = validateDeclarationSnapshot({
      ...base,
      declared_globs: ['plugins\\_shared\\tests\\**'],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects malformed amendment entries', () => {
    const base = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
    const result = validateDeclarationSnapshot({
      ...base,
      amendments: [{ reason: 'missing audit fields' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('amendments[0]'))).toBe(true);
    }
  });

  it('rejects more than one amendment per iteration', () => {
    const base = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
    const amendment = {
      previous_active_scope_hash: 'sha256:aaa',
      new_active_scope_hash: 'sha256:bbb',
      changed: { added: [], removed: [] },
      reason: 'scope tweak',
      actor: 'worker',
      timestamp: '2026-05-26T12:00:00.000Z',
      applied: true,
    };
    const result = validateDeclarationSnapshot({
      ...base,
      amendments: [amendment, amendment],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('at most 1 entry'))).toBe(true);
    }
  });
});
