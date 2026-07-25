import { createHash } from 'node:crypto';

export type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

function encode(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical_non_finite_number');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== 'object') throw new Error(`canonical_unsupported_type:${typeof value}`);
  if (seen.has(value)) throw new Error('canonical_cycle');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => encode(item, seen)).join(',')}]`;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(record[key], seen)}`).join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

export function stableStringify(value: unknown): string {
  return encode(value, new Set());
}

export function sha256Bytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256Canonical(value: unknown): string {
  return sha256Bytes(Buffer.from(stableStringify(value), 'utf8'));
}
