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
});
