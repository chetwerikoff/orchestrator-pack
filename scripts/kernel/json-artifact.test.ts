import { describe, expect, it } from 'vitest';
import {
  COMPACT_JSON_NO_NEWLINE,
  PRETTY_JSON_WITH_NEWLINE,
  serializeGenericJsonArtifact,
  serializeJsonArtifact,
  validateJsonValue,
} from '#opk-kernel/json-artifact';

describe('JSON artifact serializer', () => {
  it('preserves contract key insertion order and exact trailing newline policy', () => {
    const value = { status: 'working', deliveredAt: '2026-07-15T00:00:00.000Z', diagnostics: [] };
    const bytes = serializeGenericJsonArtifact(value, PRETTY_JSON_WITH_NEWLINE);
    expect(Buffer.from(bytes).toString('utf8')).toBe(
      '{\n  "status": "working",\n  "deliveredAt": "2026-07-15T00:00:00.000Z",\n  "diagnostics": []\n}\n',
    );
  });

  it('keeps an absent optional field absent rather than serializing null', () => {
    const value = { status: 'working', diagnostics: [] };
    const text = Buffer.from(serializeGenericJsonArtifact(value, COMPACT_JSON_NO_NEWLINE)).toString('utf8');
    expect(text).toBe('{"status":"working","diagnostics":[]}');
    expect(text).not.toContain('deliveredAt');
  });

  it('matches empty arrays, unicode, escaping, and compact output exactly', () => {
    const text = Buffer.from(serializeGenericJsonArtifact(
      { workers: [], note: 'Đà Nẵng "worker"\nnext' },
      COMPACT_JSON_NO_NEWLINE,
    )).toString('utf8');
    expect(text).toBe('{"workers":[],"note":"Đà Nẵng \\"worker\\"\\nnext"}');
  });

  it('can impose lexicographic ordering only when the contract requests it', () => {
    const text = Buffer.from(serializeGenericJsonArtifact(
      { z: 1, a: { y: 2, b: 3 } },
      { indentation: null, trailingNewline: false, keyOrder: 'lexicographic' },
    )).toString('utf8');
    expect(text).toBe('{"a":{"b":3,"y":2},"z":1}');
  });

  it('rejects undefined and non-finite numbers before emission', () => {
    expect(() => validateJsonValue({ value: undefined })).toThrow(/undefined is not a JSON value/);
    expect(() => validateJsonValue({ value: Number.NaN })).toThrow(/finite number/);
  });

  it('validates through the named contract before serialization', () => {
    expect(() => serializeJsonArtifact(
      { ok: true },
      {
        id: 'reject/v1',
        validate(_value, path) {
          throw new Error(`rejected at ${path}`);
        },
        format: COMPACT_JSON_NO_NEWLINE,
      },
    )).toThrow(/rejected at \$/);
  });
});
