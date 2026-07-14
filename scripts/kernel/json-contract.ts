export interface JsonValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class JsonContractError extends Error {
  readonly issues: readonly JsonValidationIssue[];

  constructor(message: string, issues: readonly JsonValidationIssue[]) {
    super(message);
    this.name = 'JsonContractError';
    this.issues = issues;
  }
}

export type JsonValidator<T> = (value: unknown, path: string) => T;

export interface ModifiedJsonOptions {
  readonly indentation?: number;
  readonly trailingNewline?: boolean;
}

export interface ValidatedJsonDocument<T> {
  readonly value: T;
  readonly sourceBytes: Uint8Array;
  serializeUnchanged(): Uint8Array;
  serializeModified(value: T, options?: ModifiedJsonOptions): Uint8Array;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(object)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
      .map((key) => [key, stableValue(object[key])]),
  );
}

export function parseJsonDocument<T>(
  source: string | Uint8Array,
  validator: JsonValidator<T>,
): ValidatedJsonDocument<T> {
  const sourceBytes = typeof source === 'string'
    ? Buffer.from(source, 'utf8')
    : Buffer.from(source);
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceBytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new JsonContractError('JSON syntax validation failed', [
      { path: '$', message: error instanceof Error ? error.message : String(error) },
    ]);
  }

  const value = deepFreeze(validator(parsed, '$'));
  const original = Buffer.from(sourceBytes);
  return Object.freeze({
    value,
    sourceBytes: Buffer.from(original),
    serializeUnchanged(): Uint8Array {
      return Buffer.from(original);
    },
    serializeModified(nextValue: T, options: ModifiedJsonOptions = {}): Uint8Array {
      const indentation = options.indentation ?? 2;
      const newline = options.trailingNewline === false ? '' : '\n';
      const validated = validator(nextValue, '$');
      return Buffer.from(`${JSON.stringify(stableValue(validated), null, indentation)}${newline}`, 'utf8');
    },
  });
}

export function fail(path: string, message: string): never {
  throw new JsonContractError(`JSON contract validation failed at ${path}: ${message}`, [
    { path, message },
  ]);
}

export function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'expected an object');
  }
  return value as Record<string, unknown>;
}

export function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'expected a string');
  return value;
}

export function expectNullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return expectString(value, path);
}

export function expectNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'expected a finite number');
  return value;
}

export function expectInteger(value: unknown, path: string): number {
  const number = expectNumber(value, path);
  if (!Number.isInteger(number)) fail(path, 'expected an integer');
  return number;
}

export function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'expected a boolean');
  return value;
}

export function expectExactKeys(
  record: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(propertyPath(path, key), 'unexpected key');
  }
  for (const key of required) {
    if (!(key in record)) fail(propertyPath(path, key), 'missing required key');
  }
}

export function propertyPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}
