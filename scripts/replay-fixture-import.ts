#!/usr/bin/env -S node --experimental-strip-types
import './toolchain/native-entrypoint-preflight.ts';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDirectExecution } from '#opk-toolchain/baseline-io';

export const REPLAY_FIXTURE_SCRUB_RULES = [
  'chatgpt-url',
  'token-like',
  'home-root',
] as const;

export type ReplayFixtureScrubRule = typeof REPLAY_FIXTURE_SCRUB_RULES[number];

interface ScrubSpan {
  readonly start: number;
  readonly end: number;
  readonly rule: ReplayFixtureScrubRule;
  readonly replacement: string;
}

export interface SensitiveMatch {
  readonly start: number;
  readonly end: number;
  readonly rule: ReplayFixtureScrubRule;
}

export interface ScrubbedReplayFixture {
  readonly bytes: Buffer;
  readonly scrubRules: readonly ReplayFixtureScrubRule[];
}

export interface ReplayFixturePolicyResult {
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly inventory: readonly string[];
}

export interface ReplayFixtureImportOptions {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly sourceKind: string;
  readonly issue: number;
  readonly stage: string;
  readonly slot: string;
  readonly capturedAt: string;
  readonly jsonlRecord?: number;
}

export interface ReplayFixtureImportResult {
  readonly outputPath: string;
  readonly sidecarPath: string;
  readonly sourceSha256: string;
  readonly scrubbedSha256: string;
  readonly scrubRules: readonly ReplayFixtureScrubRule[];
}

const COVERED_REFERENCE_DIR = 'tests/external-output-references';
export const COVERED_REPLAY_FIXTURE_INVENTORY = [
  'tests/external-output-references/create-issue-author-reply-fenceless-1978-r02.txt',
  'tests/external-output-references/flow-manager-long-child-ok-retained-page.json',
] as const;

const HEX64 = /^[0-9a-f]{64}$/u;
const TOKEN_BODY = /^[A-Za-z0-9_]$/u;
const SK_TOKEN_BODY = /^[A-Za-z0-9_-]$/u;
const TOKEN_BOUNDARY = /^[^A-Za-z0-9_-]$/u;
const HOME_USER = /^[A-Za-z0-9._-]$/u;
const HOME_BOUNDARY = /^[\t\n\v\f\r "'=:\[(\{,]$/u;

function isAsciiWhitespace(char: string | undefined): boolean {
  return char !== undefined && /^[\t\n\v\f\r ]$/u.test(char);
}

function isQuote(char: string | undefined): boolean {
  return char === '"' || char === "'";
}

function isUrlStop(char: string | undefined): boolean {
  return char === undefined
    || isAsciiWhitespace(char)
    || isQuote(char)
    || char === '<'
    || char === '>'
    || char === ')'
    || char === ']'
    || char === '}'
    || char === ',';
}

function isAsciiUrlChar(char: string | undefined): boolean {
  return char !== undefined && /^[A-Za-z0-9\-._~:/?#[\]@!$&()*+;=%]$/u.test(char);
}

function chatUrlSpans(text: string): ScrubSpan[] {
  const spans: ScrubSpan[] = [];
  const prefixes = [
    { prefix: 'https://chatgpt.com/', escaped: false },
    { prefix: 'https:\\/\\/chatgpt.com\\/', escaped: true },
  ] as const;

  for (const { prefix, escaped } of prefixes) {
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const start = text.indexOf(prefix, searchFrom);
      if (start < 0) break;
      let end = start + prefix.length;
      while (end < text.length) {
        const char = text[end];
        if (isUrlStop(char)) break;
        if (escaped && char === '\\' && text[end + 1] === '/') {
          end += 2;
          continue;
        }
        if (!isAsciiUrlChar(char)) break;
        end += 1;
      }
      spans.push({ start, end, rule: 'chatgpt-url', replacement: '<chatgpt-url>' });
      searchFrom = Math.max(end, start + prefix.length);
    }
  }
  return spans;
}

function tokenSpans(text: string): ScrubSpan[] {
  const spans: ScrubSpan[] = [];
  const prefixes = [
    { test: (index: number) => /^gh[pousr]_/u.test(text.slice(index, index + 4)), length: 4, body: TOKEN_BODY },
    { test: (index: number) => text.startsWith('github_pat_', index), length: 11, body: TOKEN_BODY },
    { test: (index: number) => text.startsWith('sk-', index), length: 3, body: SK_TOKEN_BODY },
  ] as const;

  for (let index = 0; index < text.length; index += 1) {
    const previous = index === 0 ? undefined : text[index - 1];
    if (previous !== undefined && !TOKEN_BOUNDARY.test(previous)) continue;
    for (const prefix of prefixes) {
      if (!prefix.test(index)) continue;
      let end = index + prefix.length;
      const bodyStart = end;
      while (end < text.length && prefix.body.test(text[end]!)) end += 1;
      if (end - bodyStart < 20) continue;
      spans.push({ start: index, end, rule: 'token-like', replacement: '<redacted-token>' });
      index = end - 1;
      break;
    }
  }
  return spans;
}

function isHomeTerminator(char: string | undefined): boolean {
  return char === undefined || char === '/' || char === '\\' || isAsciiWhitespace(char) || isQuote(char);
}

function homeRootAt(text: string, start: number): number | null {
  const candidates: Array<{ prefixLength: number; userStart: number }> = [];
  for (const prefix of ['/home/', '/Users/', '\\/home\\/', '\\/Users\\/']) {
    if (text.startsWith(prefix, start)) candidates.push({ prefixLength: prefix.length, userStart: start + prefix.length });
  }

  const drive = text[start];
  if (drive && /^[A-Za-z]$/u.test(drive) && text[start + 1] === ':') {
    for (const suffix of ['\\Users\\', '\\\\Users\\\\']) {
      if (text.startsWith(suffix, start + 2)) {
        candidates.push({ prefixLength: 2 + suffix.length, userStart: start + 2 + suffix.length });
      }
    }
  }

  for (const candidate of candidates) {
    let end = candidate.userStart;
    while (end < text.length && HOME_USER.test(text[end]!)) end += 1;
    if (end === candidate.userStart || !isHomeTerminator(text[end])) continue;
    return end;
  }
  return null;
}

function homeSpans(text: string): ScrubSpan[] {
  const spans: ScrubSpan[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const previous = index === 0 ? undefined : text[index - 1];
    if (previous !== undefined && !HOME_BOUNDARY.test(previous)) continue;
    const end = homeRootAt(text, index);
    if (end === null) continue;
    spans.push({ start: index, end, rule: 'home-root', replacement: '<home>' });
    index = end - 1;
  }
  return spans;
}

function scrubSpans(bytes: Buffer): ScrubSpan[] {
  const text = bytes.toString('latin1');
  const spans = [...chatUrlSpans(text), ...tokenSpans(text), ...homeSpans(text)]
    .sort((left, right) => left.start - right.start || right.end - left.end);
  const nonOverlapping: ScrubSpan[] = [];
  let cursor = -1;
  for (const span of spans) {
    if (span.start < cursor) continue;
    nonOverlapping.push(span);
    cursor = span.end;
  }
  return nonOverlapping;
}

export function scanReplayFixtureSensitivePatterns(bytes: Buffer): readonly SensitiveMatch[] {
  return scrubSpans(bytes).map(({ start, end, rule }) => ({ start, end, rule }));
}

export function scrubReplayFixtureBytes(bytes: Buffer): ScrubbedReplayFixture {
  const spans = scrubSpans(bytes);
  if (spans.length === 0) return { bytes: Buffer.from(bytes), scrubRules: [] };

  const chunks: Buffer[] = [];
  let cursor = 0;
  for (const span of spans) {
    chunks.push(bytes.subarray(cursor, span.start));
    chunks.push(Buffer.from(span.replacement, 'ascii'));
    cursor = span.end;
  }
  chunks.push(bytes.subarray(cursor));

  const used = new Set(spans.map((span) => span.rule));
  return {
    bytes: Buffer.concat(chunks),
    scrubRules: REPLAY_FIXTURE_SCRUB_RULES.filter((rule) => used.has(rule)),
  };
}

export function sha256ReplayFixtureBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function selectJsonlRecordBytes(bytes: Buffer, oneBasedIndex: number): Buffer {
  if (!Number.isInteger(oneBasedIndex) || oneBasedIndex < 1) {
    throw new Error('--jsonl-record must be a positive 1-based integer');
  }
  let record = 1;
  let start = 0;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index !== bytes.length && bytes[index] !== 0x0a) continue;
    if (index === bytes.length && start === bytes.length) break;
    if (record === oneBasedIndex) {
      let end = index;
      if (end > start && bytes[end - 1] === 0x0d) end -= 1;
      return Buffer.from(bytes.subarray(start, end));
    }
    record += 1;
    start = index + 1;
  }
  throw new Error(`--jsonl-record ${oneBasedIndex} is outside the input record range`);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateScrubRules(value: unknown): value is readonly ReplayFixtureScrubRule[] {
  return Array.isArray(value)
    && value.every((rule) => typeof rule === 'string' && REPLAY_FIXTURE_SCRUB_RULES.includes(rule as ReplayFixtureScrubRule))
    && new Set(value).size === value.length;
}

function sidecarFor(outputPath: string): string {
  return `${outputPath}.provenance.json`;
}

export function importReplayFixture(options: ReplayFixtureImportOptions): ReplayFixtureImportResult {
  if (!Number.isInteger(options.issue) || options.issue < 1) throw new Error('--issue must be a positive integer');
  for (const [name, value] of [
    ['--source-kind', options.sourceKind],
    ['--stage', options.stage],
    ['--slot', options.slot],
    ['--captured-at', options.capturedAt],
  ] as const) {
    if (!nonEmpty(value)) throw new Error(`${name} must be non-empty`);
  }

  const rawWholeFile = readFileSync(options.inputPath);
  const rawSelected = options.jsonlRecord === undefined
    ? rawWholeFile
    : selectJsonlRecordBytes(rawWholeFile, options.jsonlRecord);
  const scrubbed = scrubReplayFixtureBytes(rawSelected);
  const sourceSha256 = sha256ReplayFixtureBytes(rawSelected);
  const scrubbedSha256 = sha256ReplayFixtureBytes(scrubbed.bytes);

  writeFileSync(options.outputPath, scrubbed.bytes);
  const sidecarPath = sidecarFor(options.outputPath);
  writeFileSync(sidecarPath, `${JSON.stringify({
    source_kind: options.sourceKind,
    issue: options.issue,
    stage: options.stage,
    slot: options.slot,
    captured_at: options.capturedAt,
    source_sha256: sourceSha256,
    scrubbed_sha256: scrubbedSha256,
    scrub_rules: scrubbed.scrubRules,
    synthetic: false,
  }, null, 2)}\n`, 'utf8');

  return {
    outputPath: options.outputPath,
    sidecarPath,
    sourceSha256,
    scrubbedSha256,
    scrubRules: scrubbed.scrubRules,
  };
}

function coveredInventory(repoRoot: string): string[] {
  const dir = resolve(repoRoot, COVERED_REFERENCE_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.endsWith('.provenance.json'))
    .filter((name) => /^flow-manager-long-child-.*\.json$/u.test(name) || /^create-issue-author-reply-.*\.txt$/u.test(name))
    .map((name) => `${COVERED_REFERENCE_DIR}/${name}`)
    .sort();
}

function validateSidecar(fixturePath: string, sidecarPath: string, fixtureBytes: Buffer): string[] {
  const failures: string[] = [];
  if (!existsSync(sidecarPath)) return [`${fixturePath}: missing provenance sidecar`];

  let sidecar: unknown;
  try {
    sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as unknown;
  } catch (error) {
    return [`${fixturePath}: provenance sidecar is malformed JSON (${error instanceof Error ? error.message : String(error)})`];
  }
  if (!isRecord(sidecar)) return [`${fixturePath}: provenance sidecar must be an object`];

  const currentSha = sha256ReplayFixtureBytes(fixtureBytes);
  if (!nonEmpty(sidecar.scrubbed_sha256) || !HEX64.test(sidecar.scrubbed_sha256)) {
    failures.push(`${fixturePath}: scrubbed_sha256 must be lowercase 64-hex`);
  } else if (sidecar.scrubbed_sha256 !== currentSha) {
    failures.push(`${fixturePath}: scrubbed_sha256 does not match current fixture bytes`);
  }
  if (!validateScrubRules(sidecar.scrub_rules)) {
    failures.push(`${fixturePath}: scrub_rules must be a unique array of tracked scrub rule ids`);
  }
  if (sidecar.synthetic !== true && sidecar.synthetic !== false) {
    failures.push(`${fixturePath}: synthetic must be explicit true or false`);
    return failures;
  }
  if (sidecar.synthetic === true) {
    if (sidecar.source_sha256 !== undefined || sidecar.source_unavailable !== undefined) {
      failures.push(`${fixturePath}: synthetic provenance must not invent raw-source provenance`);
    }
    return failures;
  }

  for (const field of ['source_kind', 'stage', 'slot', 'captured_at'] as const) {
    if (!nonEmpty(sidecar[field])) failures.push(`${fixturePath}: harvested provenance requires ${field}`);
  }
  if (!Number.isInteger(sidecar.issue) || Number(sidecar.issue) < 1) {
    failures.push(`${fixturePath}: harvested provenance requires a positive integer issue`);
  }

  if (typeof sidecar.source_sha256 === 'string') {
    if (!HEX64.test(sidecar.source_sha256)) failures.push(`${fixturePath}: source_sha256 must be lowercase 64-hex`);
    if (sidecar.source_unavailable !== undefined) failures.push(`${fixturePath}: source_unavailable is invalid when source_sha256 is present`);
  } else if (sidecar.source_sha256 === null) {
    if (sidecar.source_unavailable !== 'historical-backfill') {
      failures.push(`${fixturePath}: null source_sha256 requires source_unavailable="historical-backfill"`);
    }
  } else {
    failures.push(`${fixturePath}: harvested provenance requires source_sha256 or the historical-backfill null form`);
  }
  return failures;
}

export function runReplayFixturePolicyCheck(repoRoot = resolve(import.meta.dirname, '..')): ReplayFixturePolicyResult {
  const inventory = coveredInventory(repoRoot);
  const expected = [...COVERED_REPLAY_FIXTURE_INVENTORY].sort();
  const failures: string[] = [];
  if (JSON.stringify(inventory) !== JSON.stringify(expected)) {
    failures.push(`replay fixture coverage scope drift: expected ${expected.join(', ')}; observed ${inventory.join(', ') || '(none)'}`);
  }

  for (const fixturePath of inventory.filter((path) => expected.includes(path as typeof expected[number]))) {
    const absolute = resolve(repoRoot, fixturePath);
    const fixtureBytes = readFileSync(absolute);
    const sensitive = scanReplayFixtureSensitivePatterns(fixtureBytes);
    if (sensitive.length > 0) {
      failures.push(`${fixturePath}: forbidden sensitive pattern(s): ${[...new Set(sensitive.map((match) => match.rule))].join(', ')}`);
    }
    failures.push(...validateSidecar(fixturePath, `${absolute}.provenance.json`, fixtureBytes));
  }

  return { ok: failures.length === 0, failures, inventory };
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function requiredOption(argv: readonly string[], name: string): string {
  const value = option(argv, name);
  if (!nonEmpty(value)) throw new Error(`${name} is required`);
  return value;
}

export async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];
  if (command === 'check') {
    const repoRoot = resolve(option(argv, '--repo-root') ?? resolve(import.meta.dirname, '..'));
    const result = runReplayFixturePolicyCheck(repoRoot);
    for (const failure of result.failures) process.stderr.write(`[FAIL] replay-fixture-policy: ${failure}\n`);
    if (result.ok) process.stdout.write(`[PASS] replay-fixture-policy: covered=${result.inventory.length}\n`);
    return result.ok ? 0 : 1;
  }
  if (command !== 'import') {
    process.stderr.write('Usage: replay-fixture-import.ts import --input <path> --output <path> --source-kind <kind> --issue <n> --stage <stage> --slot <slot> --captured-at <value> [--jsonl-record <1-based-index>]\n');
    process.stderr.write('       replay-fixture-import.ts check [--repo-root <path>]\n');
    return 1;
  }

  const issue = Number(requiredOption(argv, '--issue'));
  const recordRaw = option(argv, '--jsonl-record');
  const result = importReplayFixture({
    inputPath: resolve(requiredOption(argv, '--input')),
    outputPath: resolve(requiredOption(argv, '--output')),
    sourceKind: requiredOption(argv, '--source-kind'),
    issue,
    stage: requiredOption(argv, '--stage'),
    slot: requiredOption(argv, '--slot'),
    capturedAt: requiredOption(argv, '--captured-at'),
    jsonlRecord: recordRaw === undefined ? undefined : Number(recordRaw),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (isDirectExecution(import.meta.url, process.argv[1])) process.exitCode = await main(process.argv.slice(2));
