#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { defaultGhTransport } from '../lib/create-issue-stage-record-gh.ts';

const SOURCE_MARKER = '<!-- issue-1168-too-many-requests-production-shape:v2 -->';
const SOURCE_SCHEMA = 'issue-1168-too-many-requests-production-shape/v2';
const SHAPE_SCHEMA = 'too-many-requests-dialog-shape/v2';
const BINDING_SCHEMA = 'issue-1168-source-binding/v1';
const VERIFICATION_SCHEMA = 'issue-1168-source-verification/v1';
const ISSUE_NUMBER = 1168;
const REPO = 'chetwerikoff/orchestrator-pack';
const SOURCE_TOKEN_RE = /^[a-z0-9][a-z0-9._:-]{0,79}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const LOWER_TAG_RE = /^[a-z][a-z0-9-]*$/;
const OBSERVED_AT_RE = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

type JsonRecord = Record<string, unknown>;

export interface TooManyRequestsDialogShapeV2 {
  readonly schema: typeof SHAPE_SCHEMA;
  readonly dialog: {
    readonly page_dialog_ordinal: 0;
    readonly tag_name: string;
    readonly role_attribute_class: 'dialog';
    readonly aria_modal_attribute_class: 'true';
    readonly aria_owns_attribute_class: 'absent' | 'empty';
  };
  readonly heading: {
    readonly child_index_path: number[];
    readonly tag_name: string;
    readonly role_attribute_class: 'heading';
  };
  readonly acknowledgement: {
    readonly child_index_path: number[];
    readonly tag_name: string;
    readonly role_attribute_class: 'button';
  };
}

export interface TooManyRequestsSourceV2 {
  readonly schema: typeof SOURCE_SCHEMA;
  readonly issue: typeof ISSUE_NUMBER;
  readonly observation_kind: 'natural';
  readonly observed_at: string;
  readonly source_local_occurrence: string;
  readonly operator_attestation: 'scrubbed-no-private-data';
  readonly shape_sha256: string;
  readonly shape: TooManyRequestsDialogShapeV2;
}

export type VerificationSelector =
  | 'too-many-requests-live-source-receipt'
  | 'too-many-requests-source-verifier';

export type VerificationRejectReason =
  | 'identity_mismatch'
  | 'body_digest_mismatch'
  | 'body_grammar_invalid'
  | 'source_schema_invalid'
  | 'shape_digest_mismatch'
  | 'fixture_mismatch';

interface SourceBindingV1 {
  readonly schema: typeof BINDING_SCHEMA;
  readonly comment_id: number;
  readonly comment_url: string;
  readonly updated_at: string;
  readonly body_sha256: string;
  readonly shape_sha256: string;
}

interface GhTransportLike {
  runGh(argv: string[], timeoutMs?: number): {
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
  };
}

export interface VerificationSuccess {
  readonly schema: typeof VERIFICATION_SCHEMA;
  readonly status: 'verified';
  readonly selector: VerificationSelector;
  readonly comment_id: number;
  readonly comment_url: string;
  readonly updated_at: string;
  readonly body_sha256: string;
  readonly shape_sha256: string;
  readonly fixture_sha256: string;
}

export interface VerificationRejected {
  readonly schema: typeof VERIFICATION_SCHEMA;
  readonly status: 'rejected';
  readonly reason: VerificationRejectReason;
}

class VerificationError extends Error {
  readonly reason: VerificationRejectReason;

  constructor(reason: VerificationRejectReason) {
    super(reason);
    this.name = 'VerificationError';
    this.reason = reason;
  }
}

class StrictJsonParser {
  private offset = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  parse(): unknown {
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.offset !== this.source.length) throw new Error('json_trailing_data');
    return value;
  }

  private parseValue(): unknown {
    this.skipWhitespace();
    const char = this.source[this.offset];
    if (char === '{') return this.parseObject();
    if (char === '[') return this.parseArray();
    if (char === '"') return this.parseString();
    if (char === 't') return this.parseLiteral('true', true);
    if (char === 'f') return this.parseLiteral('false', false);
    if (char === 'n') return this.parseLiteral('null', null);
    return this.parseNumber();
  }

  private parseObject(): JsonRecord {
    this.expect('{');
    const record: JsonRecord = {};
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.source[this.offset] === '}') {
      this.offset++;
      return record;
    }
    while (true) {
      this.skipWhitespace();
      if (this.source[this.offset] !== '"') throw new Error('json_object_key_invalid');
      const key = this.parseString();
      if (seen.has(key)) throw new Error('json_duplicate_key');
      seen.add(key);
      this.skipWhitespace();
      this.expect(':');
      const parsedValue = this.parseValue();
      Object.defineProperty(record, key, {
        value: parsedValue,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      this.skipWhitespace();
      const separator = this.source[this.offset++];
      if (separator === '}') return record;
      if (separator !== ',') throw new Error('json_object_separator_invalid');
    }
  }

  private parseArray(): unknown[] {
    this.expect('[');
    const values: unknown[] = [];
    this.skipWhitespace();
    if (this.source[this.offset] === ']') {
      this.offset++;
      return values;
    }
    while (true) {
      values.push(this.parseValue());
      this.skipWhitespace();
      const separator = this.source[this.offset++];
      if (separator === ']') return values;
      if (separator !== ',') throw new Error('json_array_separator_invalid');
    }
  }

  private parseString(): string {
    const start = this.offset;
    this.expect('"');
    let escaped = false;
    while (this.offset < this.source.length) {
      const char = this.source[this.offset++];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        return JSON.parse(this.source.slice(start, this.offset)) as string;
      }
      if (char.charCodeAt(0) < 0x20) throw new Error('json_string_control_character');
    }
    throw new Error('json_string_unterminated');
  }

  private parseNumber(): number {
    const rest = this.source.slice(this.offset);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (!match) throw new Error('json_value_invalid');
    this.offset += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new Error('json_number_nonfinite');
    return value;
  }

  private parseLiteral<T>(text: string, value: T): T {
    if (!this.source.startsWith(text, this.offset)) throw new Error('json_literal_invalid');
    this.offset += text.length;
    return value;
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.source[this.offset] ?? '')) this.offset++;
  }

  private expect(char: string): void {
    if (this.source[this.offset] !== char) throw new Error('json_token_invalid');
    this.offset++;
  }
}

export function parseJsonRejectingDuplicateKeys(text: string): unknown {
  return new StrictJsonParser(text).parse();
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('record_invalid');
  return value as JsonRecord;
}

function requireExactKeys(record: JsonRecord, expected: readonly string[]): void {
  const actual = Object.keys(record);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('keys_invalid');
  }
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('string_invalid');
  return value;
}

function requireLiteral<T extends string | number>(value: unknown, expected: T): T {
  if (value !== expected) throw new Error('literal_invalid');
  return expected;
}

function validateCanonicalTimestamp(value: unknown): string {
  const timestamp = requireString(value);
  if (!OBSERVED_AT_RE.test(timestamp)) throw new Error('timestamp_invalid');
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) throw new Error('timestamp_invalid');
  return timestamp;
}

function validateTag(value: unknown): string {
  const tag = requireString(value);
  if (!LOWER_TAG_RE.test(tag)) throw new Error('tag_invalid');
  return tag;
}

function validatePath(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('path_invalid');
  const path = value.map((part) => {
    if (!Number.isSafeInteger(part) || (part as number) < 0) throw new Error('path_invalid');
    return part as number;
  });
  return path;
}

export function canonicalizeShape(value: unknown): TooManyRequestsDialogShapeV2 {
  const shape = asRecord(value);
  requireExactKeys(shape, ['schema', 'dialog', 'heading', 'acknowledgement']);
  requireLiteral(shape.schema, SHAPE_SCHEMA);

  const dialog = asRecord(shape.dialog);
  requireExactKeys(dialog, [
    'page_dialog_ordinal',
    'tag_name',
    'role_attribute_class',
    'aria_modal_attribute_class',
    'aria_owns_attribute_class',
  ]);
  requireLiteral(dialog.page_dialog_ordinal, 0);
  const ariaOwns = requireString(dialog.aria_owns_attribute_class);
  if (ariaOwns !== 'absent' && ariaOwns !== 'empty') throw new Error('aria_owns_invalid');

  const heading = asRecord(shape.heading);
  requireExactKeys(heading, ['child_index_path', 'tag_name', 'role_attribute_class']);

  const acknowledgement = asRecord(shape.acknowledgement);
  requireExactKeys(acknowledgement, ['child_index_path', 'tag_name', 'role_attribute_class']);

  return {
    schema: SHAPE_SCHEMA,
    dialog: {
      page_dialog_ordinal: 0,
      tag_name: validateTag(dialog.tag_name),
      role_attribute_class: requireLiteral(dialog.role_attribute_class, 'dialog'),
      aria_modal_attribute_class: requireLiteral(dialog.aria_modal_attribute_class, 'true'),
      aria_owns_attribute_class: ariaOwns,
    },
    heading: {
      child_index_path: validatePath(heading.child_index_path),
      tag_name: validateTag(heading.tag_name),
      role_attribute_class: requireLiteral(heading.role_attribute_class, 'heading'),
    },
    acknowledgement: {
      child_index_path: validatePath(acknowledgement.child_index_path),
      tag_name: validateTag(acknowledgement.tag_name),
      role_attribute_class: requireLiteral(acknowledgement.role_attribute_class, 'button'),
    },
  };
}

export function shapeSha256(shape: TooManyRequestsDialogShapeV2): string {
  return sha256(JSON.stringify(canonicalizeShape(shape)));
}

export function canonicalizeSource(value: unknown): TooManyRequestsSourceV2 {
  const source = asRecord(value);
  requireExactKeys(source, [
    'schema',
    'issue',
    'observation_kind',
    'observed_at',
    'source_local_occurrence',
    'operator_attestation',
    'shape_sha256',
    'shape',
  ]);
  const occurrence = requireString(source.source_local_occurrence);
  if (!SOURCE_TOKEN_RE.test(occurrence)) throw new Error('occurrence_invalid');
  const declaredShapeSha = requireString(source.shape_sha256);
  if (!SHA256_RE.test(declaredShapeSha)) throw new Error('shape_sha_invalid');
  const shape = canonicalizeShape(source.shape);
  const actualShapeSha = shapeSha256(shape);
  if (declaredShapeSha !== actualShapeSha) throw new VerificationError('shape_digest_mismatch');
  return {
    schema: requireLiteral(source.schema, SOURCE_SCHEMA),
    issue: requireLiteral(source.issue, ISSUE_NUMBER),
    observation_kind: requireLiteral(source.observation_kind, 'natural'),
    observed_at: validateCanonicalTimestamp(source.observed_at),
    source_local_occurrence: occurrence,
    operator_attestation: requireLiteral(source.operator_attestation, 'scrubbed-no-private-data'),
    shape_sha256: declaredShapeSha,
    shape,
  };
}

export function parseSourceCommentBody(body: string): TooManyRequestsSourceV2 {
  if (body.includes('\r') || body.endsWith('\n')) throw new VerificationError('body_grammar_invalid');
  const lines = body.split('\n');
  if (lines.length !== 2 || lines[0] !== SOURCE_MARKER || !lines[1]) {
    throw new VerificationError('body_grammar_invalid');
  }
  let parsed: unknown;
  try {
    parsed = parseJsonRejectingDuplicateKeys(lines[1]);
  } catch {
    throw new VerificationError('body_grammar_invalid');
  }
  let source: TooManyRequestsSourceV2;
  try {
    source = canonicalizeSource(parsed);
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    throw new VerificationError('source_schema_invalid');
  }
  if (JSON.stringify(source) !== lines[1]) throw new VerificationError('body_grammar_invalid');
  return source;
}

function parseBinding(text: string): SourceBindingV1 {
  let value: unknown;
  try {
    value = parseJsonRejectingDuplicateKeys(text);
  } catch {
    throw new VerificationError('identity_mismatch');
  }
  try {
    const record = asRecord(value);
    requireExactKeys(record, ['schema', 'comment_id', 'comment_url', 'updated_at', 'body_sha256', 'shape_sha256']);
    requireLiteral(record.schema, BINDING_SCHEMA);
    if (!Number.isSafeInteger(record.comment_id) || (record.comment_id as number) <= 0) throw new Error('comment_id_invalid');
    const commentId = record.comment_id as number;
    const commentUrl = requireString(record.comment_url);
    if (commentUrl !== canonicalCommentUrl(commentId)) throw new Error('comment_url_invalid');
    const updatedAt = requireString(record.updated_at);
    if (!Number.isFinite(Date.parse(updatedAt)) || new Date(updatedAt).toISOString().replace('.000Z', 'Z') !== updatedAt) {
      throw new Error('updated_at_invalid');
    }
    const bodySha = requireString(record.body_sha256);
    const shapeSha = requireString(record.shape_sha256);
    if (!SHA256_RE.test(bodySha) || !SHA256_RE.test(shapeSha)) throw new Error('digest_invalid');
    return {
      schema: BINDING_SCHEMA,
      comment_id: commentId,
      comment_url: commentUrl,
      updated_at: updatedAt,
      body_sha256: bodySha,
      shape_sha256: shapeSha,
    };
  } catch {
    throw new VerificationError('identity_mismatch');
  }
}

function canonicalCommentUrl(commentId: number): string {
  return `https://github.com/${REPO}/issues/${ISSUE_NUMBER}#issuecomment-${commentId}`;
}

function parseLiveComment(text: string): { id: number; html_url: string; updated_at: string; body: string } {
  let value: unknown;
  try {
    value = parseJsonRejectingDuplicateKeys(text);
  } catch {
    throw new VerificationError('identity_mismatch');
  }
  const record = asRecord(value);
  if (!Number.isSafeInteger(record.id) || typeof record.html_url !== 'string'
    || typeof record.updated_at !== 'string' || typeof record.body !== 'string') {
    throw new VerificationError('identity_mismatch');
  }
  return {
    id: record.id as number,
    html_url: record.html_url,
    updated_at: record.updated_at,
    body: record.body,
  };
}

export function verifyLiveSource(
  input: { bindingPath: string; fixturePath: string; selector: VerificationSelector },
  dependencies: { transport?: GhTransportLike } = {},
): VerificationSuccess | VerificationRejected {
  try {
    if (input.selector !== 'too-many-requests-live-source-receipt'
      && input.selector !== 'too-many-requests-source-verifier') {
      throw new VerificationError('identity_mismatch');
    }
    const binding = parseBinding(readFileSync(input.bindingPath, 'utf8'));
    const transport = dependencies.transport ?? (defaultGhTransport() as unknown as GhTransportLike);
    const response = transport.runGh(['gh', 'api', `repos/${REPO}/issues/comments/${binding.comment_id}`]);
    if (response.exitCode !== 0) throw new VerificationError('identity_mismatch');
    const comment = parseLiveComment(response.stdout);
    if (comment.id !== binding.comment_id
      || comment.html_url !== binding.comment_url
      || comment.html_url !== canonicalCommentUrl(binding.comment_id)
      || comment.updated_at !== binding.updated_at) {
      throw new VerificationError('identity_mismatch');
    }
    const bodySha = sha256(Buffer.from(comment.body, 'utf8'));
    if (bodySha !== binding.body_sha256) throw new VerificationError('body_digest_mismatch');
    const source = parseSourceCommentBody(comment.body);
    if (source.shape_sha256 !== binding.shape_sha256) throw new VerificationError('shape_digest_mismatch');
    const canonicalShapeBytes = Buffer.from(JSON.stringify(source.shape), 'utf8');
    if (sha256(canonicalShapeBytes) !== source.shape_sha256) throw new VerificationError('shape_digest_mismatch');
    let fixtureBytes: Buffer;
    try {
      fixtureBytes = readFileSync(input.fixturePath);
    } catch {
      throw new VerificationError('fixture_mismatch');
    }
    if (!fixtureBytes.equals(canonicalShapeBytes)) throw new VerificationError('fixture_mismatch');
    const fixtureSha = sha256(fixtureBytes);
    return {
      schema: VERIFICATION_SCHEMA,
      status: 'verified',
      selector: input.selector,
      comment_id: comment.id,
      comment_url: comment.html_url,
      updated_at: comment.updated_at,
      body_sha256: bodySha,
      shape_sha256: source.shape_sha256,
      fixture_sha256: fixtureSha,
    };
  } catch (error) {
    return {
      schema: VERIFICATION_SCHEMA,
      status: 'rejected',
      reason: error instanceof VerificationError ? error.reason : 'identity_mismatch',
    };
  }
}

async function soleVisible(locator: any): Promise<{ locator: any; ordinal: number }> {
  const count = await locator.count();
  const visible: { locator: any; ordinal: number }[] = [];
  for (let index = 0; index < count; index++) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible()) visible.push({ locator: candidate, ordinal: index });
  }
  if (visible.length !== 1) throw new Error('capture_ambiguous_visible_match');
  return visible[0]!;
}

async function elementTag(locator: any): Promise<string> {
  const tag = await locator.evaluate((element: Element) => element.tagName.toLowerCase());
  return validateTag(tag);
}

async function childIndexPath(root: any, target: any): Promise<number[]> {
  const handle = await target.elementHandle();
  if (!handle) throw new Error('capture_target_unreadable');
  const path = await root.evaluate((rootElement: Element, targetElement: Element) => {
    const result: number[] = [];
    let current: Element | null = targetElement;
    while (current && current !== rootElement) {
      const parent: Element | null = current.parentElement;
      if (!parent) return null;
      const index = Array.prototype.indexOf.call(parent.children, current) as number;
      if (index < 0) return null;
      result.unshift(index);
      current = parent;
    }
    return current === rootElement ? result : null;
  }, handle);
  if (!Array.isArray(path) || path.length === 0) throw new Error('capture_path_invalid');
  return validatePath(path);
}

export async function captureTooManyRequestsSource(
  page: any,
  options: { observedAt?: string; sourceLocalOccurrence?: string } = {},
): Promise<TooManyRequestsSourceV2> {
  const dialogs = page.locator('[role="dialog"][aria-modal="true"]');
  const visibleDialog = await soleVisible(dialogs);
  if (visibleDialog.ordinal !== 0) throw new Error('capture_dialog_ordinal_invalid');
  const dialog = visibleDialog.locator;
  const role = await dialog.getAttribute('role');
  const ariaModal = await dialog.getAttribute('aria-modal');
  const ariaOwns = await dialog.getAttribute('aria-owns');
  if (role !== 'dialog' || ariaModal !== 'true' || (ariaOwns !== null && ariaOwns !== '')) {
    throw new Error('capture_dialog_attributes_invalid');
  }

  const heading = (await soleVisible(dialog.getByRole('heading', { name: 'Too many requests', exact: true }))).locator;
  const acknowledgement = (await soleVisible(dialog.getByRole('button', { name: 'Got it', exact: true }))).locator;
  if (!(await acknowledgement.isEnabled())) throw new Error('capture_acknowledgement_disabled');

  const shape = canonicalizeShape({
    schema: SHAPE_SCHEMA,
    dialog: {
      page_dialog_ordinal: 0,
      tag_name: await elementTag(dialog),
      role_attribute_class: 'dialog',
      aria_modal_attribute_class: 'true',
      aria_owns_attribute_class: ariaOwns === null ? 'absent' : 'empty',
    },
    heading: {
      child_index_path: await childIndexPath(dialog, heading),
      tag_name: await elementTag(heading),
      role_attribute_class: 'heading',
    },
    acknowledgement: {
      child_index_path: await childIndexPath(dialog, acknowledgement),
      tag_name: await elementTag(acknowledgement),
      role_attribute_class: 'button',
    },
  });
  const observedAt = options.observedAt ?? new Date().toISOString();
  const sourceLocalOccurrence = options.sourceLocalOccurrence
    ?? `capture:${randomUUID().replaceAll('-', '')}`;
  return canonicalizeSource({
    schema: SOURCE_SCHEMA,
    issue: ISSUE_NUMBER,
    observation_kind: 'natural',
    observed_at: observedAt,
    source_local_occurrence: sourceLocalOccurrence,
    operator_attestation: 'scrubbed-no-private-data',
    shape_sha256: shapeSha256(shape),
    shape,
  });
}

export function writeCapturedSource(path: string, source: TooManyRequestsSourceV2): void {
  const canonical = canonicalizeSource(source);
  writeFileSync(path, JSON.stringify(canonical), { encoding: 'utf8', flag: 'wx' });
}

function parseCli(argv: readonly string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) throw new Error('argument_invalid');
    const name = key.slice(2);
    if (options.has(name)) throw new Error('argument_duplicate');
    options.set(name, value);
  }
  return options;
}

export function runTooManyRequestsSourceCli(argv: readonly string[]): number {
  let result: VerificationSuccess | VerificationRejected;
  try {
    if (argv[0] !== 'verify-live') throw new Error('command_invalid');
    const options = parseCli(argv);
    if (options.size !== 3) throw new Error('argument_invalid');
    const bindingPath = options.get('binding');
    const fixturePath = options.get('fixture');
    const selector = options.get('emit-selector');
    if (!bindingPath || !fixturePath
      || (selector !== 'too-many-requests-live-source-receipt'
        && selector !== 'too-many-requests-source-verifier')) {
      throw new Error('argument_invalid');
    }
    result = verifyLiveSource({ bindingPath, fixturePath, selector });
  } catch {
    result = { schema: VERIFICATION_SCHEMA, status: 'rejected', reason: 'identity_mismatch' };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.status === 'verified' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = runTooManyRequestsSourceCli(process.argv.slice(2));
}
