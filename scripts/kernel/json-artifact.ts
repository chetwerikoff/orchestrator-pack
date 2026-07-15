import {
  expectBoolean,
  expectNumber,
  expectRecord,
  expectString,
  fail,
  propertyPath,
  type JsonValidator,
} from '#opk-kernel/json-contract';

export type JsonPrimitive = null | boolean | number | string;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export interface JsonArray extends ReadonlyArray<JsonValue> {}
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export type JsonKeyOrder = 'preserve' | 'lexicographic';

export interface JsonArtifactFormat {
  readonly indentation: number | null;
  readonly trailingNewline: boolean;
  readonly keyOrder: JsonKeyOrder;
}

export interface JsonArtifactContract<T> {
  readonly id: string;
  readonly validate: JsonValidator<T>;
  readonly format: JsonArtifactFormat;
  readonly toJsonValue?: (value: T) => JsonValue;
}

export const COMPACT_JSON_NO_NEWLINE = Object.freeze({
  indentation: null,
  trailingNewline: false,
  keyOrder: 'preserve',
} satisfies JsonArtifactFormat);

export const COMPACT_JSON_WITH_NEWLINE = Object.freeze({
  indentation: null,
  trailingNewline: true,
  keyOrder: 'preserve',
} satisfies JsonArtifactFormat);

export const PRETTY_JSON_WITH_NEWLINE = Object.freeze({
  indentation: 2,
  trailingNewline: true,
  keyOrder: 'preserve',
} satisfies JsonArtifactFormat);

function validateJsonRecord(value: unknown, path: string): Readonly<Record<string, JsonValue>> {
  const record = expectRecord(value, path);
  const output: Record<string, JsonValue> = {};
  for (const [key, nested] of Object.entries(record)) {
    if (nested === undefined) fail(propertyPath(path, key), 'undefined is not a JSON value');
    output[key] = validateJsonValue(nested, propertyPath(path, key));
  }
  return output;
}

export function validateJsonValue(value: unknown, path = '$'): JsonValue {
  if (value === null) return null;
  if (typeof value === 'string') return expectString(value, path);
  if (typeof value === 'boolean') return expectBoolean(value, path);
  if (typeof value === 'number') return expectNumber(value, path);
  if (Array.isArray(value)) {
    return value.map((nested, index) => validateJsonValue(nested, `${path}[${index}]`));
  }
  return validateJsonRecord(value, path);
}

function orderJsonValue(value: JsonValue, order: JsonKeyOrder): JsonValue {
  if (Array.isArray(value)) return value.map((nested) => orderJsonValue(nested, order));
  if (value === null || typeof value !== 'object') return value;
  const record = value as Readonly<Record<string, JsonValue>>;
  const keys = Object.keys(record);
  if (order === 'lexicographic') keys.sort((left, right) => left.localeCompare(right));
  return Object.fromEntries(keys.map((key) => [key, orderJsonValue(record[key]!, order)]));
}

export function serializeJsonArtifact<T>(
  value: T,
  contract: JsonArtifactContract<T>,
): Uint8Array {
  if (!contract.id.trim()) throw new TypeError('JSON artifact contract id must be non-empty');
  const validated = contract.validate(value, '$');
  const jsonValue = validateJsonValue(
    contract.toJsonValue ? contract.toJsonValue(validated) : validated,
    '$',
  );
  const ordered = orderJsonValue(jsonValue, contract.format.keyOrder);
  const indentation = contract.format.indentation === null ? undefined : contract.format.indentation;
  if (indentation !== undefined && (!Number.isInteger(indentation) || indentation < 0 || indentation > 10)) {
    throw new RangeError('JSON indentation must be an integer from 0 through 10, or null for compact output');
  }
  const body = JSON.stringify(ordered, null, indentation);
  return Buffer.from(`${body}${contract.format.trailingNewline ? '\n' : ''}`, 'utf8');
}

export function serializeGenericJsonArtifact(
  value: JsonValue,
  format: JsonArtifactFormat,
  id = 'generic-json/v1',
): Uint8Array {
  return serializeJsonArtifact(value, { id, validate: validateJsonValue, format });
}
