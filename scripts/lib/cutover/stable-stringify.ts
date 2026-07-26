import { createHash } from 'node:crypto';

export type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

function canonical(value: unknown, stack: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical_non_finite_number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (stack.has(value)) throw new Error('canonical_cycle');
    stack.add(value);
    const rendered = `[${value.map((entry) => canonical(entry, stack)).join(',')}]`;
    stack.delete(value);
    return rendered;
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (Object.getPrototypeOf(object) !== Object.prototype && Object.getPrototypeOf(object) !== null) {
      throw new Error('canonical_non_plain_object');
    }
    if (stack.has(object)) throw new Error('canonical_cycle');
    stack.add(object);
    const parts = Object.keys(object).sort().map((key) => {
      const entry = object[key];
      if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol' || typeof entry === 'bigint') {
        throw new Error(`canonical_unsupported_value:${key}`);
      }
      return `${JSON.stringify(key)}:${canonical(entry, stack)}`;
    });
    stack.delete(object);
    return `{${parts.join(',')}}`;
  }
  throw new Error(`canonical_unsupported_type:${typeof value}`);
}

export function stableStringify(value: unknown): string {
  return canonical(value, new Set());
}

export function sha256Bytes(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function sha256Stable(value: unknown): string {
  return sha256Bytes(Buffer.from(stableStringify(value), 'utf8'));
}
