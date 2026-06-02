import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  extractStrictPackFindingsArray,
  NO_FINDINGS_TOKEN,
  normalizeStructuredPackFindings,
} from './parse_output.js';
import type { FindingType, ReviewSource, StructuredFinding } from './types.js';

/** Fail-closed message when JSONL has empty findings[] and non-clean overall verdict. */
export const SPLIT_CHANNEL_EMPTY_FINDINGS_MESSAGE =
  'review-mode JSONL reports no findings but overall_correctness is not "patch is correct" — refusing to mark run as clean';

/** Fail-closed when a hydrated finding anchors a path the wrapper cannot relativize. */
export const UNNORMALIZABLE_CODE_LOCATION_MESSAGE =
  'review-mode JSONL finding code_location.absolute_file_path cannot be normalized to a repo-relative path — refusing to mark run as clean';

const VALID_FINDING_TYPES: FindingType[] = [
  'scope-violation',
  'spec',
  'quality',
  'test',
  'ci',
  'security',
];

export interface CodexReviewOutput {
  findings?: unknown[];
  overall_correctness?: string;
  overall_explanation?: string;
  overall_confidence_score?: number;
}

export interface ParsedReviewModeEvent {
  reviewOutput: CodexReviewOutput;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function resolveCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured && configured.length > 0 ? configured : join(homedir(), '.codex');
}

/** Parse newline-delimited JSON events (process stdout or persisted session file). */
export function parseJsonlLines(raw: string): unknown[] {
  const events: unknown[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines (process JSONL only; session review-mode uses stricter parsing)
    }
  }
  return events;
}

function lineLooksLikeExitedReviewMode(line: string): boolean {
  return /exited_review_mode/i.test(line);
}

type SessionJsonlLine =
  | { kind: 'skip' }
  | { kind: 'malformed_review_mode' }
  | { kind: 'event'; value: unknown };

function parseSessionJsonlLine(line: string): SessionJsonlLine {
  const trimmed = line.trim();
  if (!trimmed) {
    return { kind: 'skip' };
  }
  try {
    return { kind: 'event', value: JSON.parse(trimmed) };
  } catch {
    if (lineLooksLikeExitedReviewMode(trimmed)) {
      return { kind: 'malformed_review_mode' };
    }
    return { kind: 'skip' };
  }
}

/** Extract parent thread/session id from Codex `--json` process stdout. */
export function extractThreadIdFromProcessJsonl(processJsonl: string): string | null {
  for (const event of parseJsonlLines(processJsonl)) {
    const record = asRecord(event);
    if (record?.type !== 'thread.started') {
      continue;
    }
    const threadId = record.thread_id;
    if (typeof threadId === 'string' && threadId.trim()) {
      return threadId.trim();
    }
  }
  return null;
}

function findSessionJsonlUnderDir(dir: string, sessionId: string): string | null {
  const suffix = `${sessionId}.jsonl`;
  let latest: string | null = null;

  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(suffix)) {
        latest = fullPath;
      }
    }
  }

  return latest;
}

export function findPersistedSessionJsonlPath(
  sessionId: string,
  codexHome = resolveCodexHome(),
): string | null {
  const sessionsRoot = join(codexHome, 'sessions');
  if (!existsSync(sessionsRoot)) {
    return null;
  }
  return findSessionJsonlUnderDir(sessionsRoot, sessionId);
}

export function readPersistedSessionJsonl(
  sessionId: string,
  options?: { codexHome?: string; fixtureSessionJsonl?: string },
): string | null {
  if (options?.fixtureSessionJsonl !== undefined) {
    return options.fixtureSessionJsonl;
  }
  const path = findPersistedSessionJsonlPath(sessionId, options?.codexHome);
  if (!path || !existsSync(path)) {
    return null;
  }
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export type ParseExitedReviewModeResult =
  | { status: 'absent' }
  | { status: 'valid'; reviewOutput: CodexReviewOutput }
  | { status: 'malformed'; message: string };

/** Last `exited_review_mode` event with `review_output` in persisted session JSONL. */
export function parseExitedReviewModeFromSessionJsonl(
  sessionJsonl: string,
): ParseExitedReviewModeResult {
  let latestValid: CodexReviewOutput | null = null;
  let sawMalformed = false;

  for (const line of sessionJsonl.split(/\r?\n/)) {
    const parsedLine = parseSessionJsonlLine(line);
    if (parsedLine.kind === 'skip') {
      continue;
    }
    if (parsedLine.kind === 'malformed_review_mode') {
      sawMalformed = true;
      continue;
    }

    const record = asRecord(parsedLine.value);
    if (record?.type !== 'event_msg') {
      continue;
    }
    const payload = asRecord(record.payload);
    if (payload?.type !== 'exited_review_mode') {
      continue;
    }
    const reviewOutput = asRecord(payload.review_output);
    if (!reviewOutput) {
      sawMalformed = true;
      continue;
    }
    latestValid = reviewOutput as CodexReviewOutput;
  }

  if (latestValid) {
    return { status: 'valid', reviewOutput: latestValid };
  }
  if (sawMalformed) {
    return {
      status: 'malformed',
      message:
        'review-mode JSONL contained malformed or incomplete exited_review_mode output — refusing to mark run as clean',
    };
  }
  return { status: 'absent' };
}

export function isPatchCorrectVerdict(overallCorrectness: unknown): boolean {
  if (typeof overallCorrectness !== 'string') {
    return false;
  }
  const trimmed = overallCorrectness.trim();
  if (!trimmed) {
    return false;
  }
  return /^patch is correct$/i.test(trimmed);
}

/** Split-channel recovery (#135) requires explicit `patch is incorrect` machine verdict. */
export function isExplicitNonCleanVerdict(overallCorrectness: unknown): boolean {
  if (typeof overallCorrectness !== 'string') {
    return false;
  }
  const trimmed = overallCorrectness.trim();
  if (!trimmed) {
    return false;
  }
  return /^patch is incorrect$/i.test(trimmed);
}

function parseBracketedPriority(title: string): number | null {
  const match = title.match(/^\[P(\d+)\]/i);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function priorityToSeverity(priority: unknown, title: string): 'blocking' | 'non-blocking' {
  if (typeof priority === 'number' && !Number.isNaN(priority)) {
    return priority <= 1 ? 'blocking' : 'non-blocking';
  }
  const bracketed = parseBracketedPriority(title);
  if (bracketed !== null) {
    return bracketed <= 1 ? 'blocking' : 'non-blocking';
  }
  return 'non-blocking';
}

function normalizeFindingType(value: unknown): FindingType | null {
  if (typeof value !== 'string') {
    return null;
  }
  const lowered = value.trim().toLowerCase();
  return VALID_FINDING_TYPES.includes(lowered as FindingType)
    ? (lowered as FindingType)
    : null;
}

function isScopeViolationFindingText(text: string): boolean {
  const lowered = text.toLowerCase();
  if (lowered.includes('scope-violation') || lowered.includes('scope violation')) {
    return true;
  }
  if (/\bout[- ]of[- ]scope\b/.test(lowered)) {
    return true;
  }
  if (/\boutside (the )?(declared|allowed)\b/.test(lowered)) {
    return true;
  }
  if (/\bdenylist\b/.test(lowered)) {
    return true;
  }
  if (/\ballowed[_ ]roots?\b/.test(lowered)) {
    return true;
  }
  if (/\bnot (in|within) (the )?declared\b/.test(lowered)) {
    return true;
  }
  if (/\bpath[- ]outside[- ]declaration\b/.test(lowered)) {
    return true;
  }
  if (/\btouches?\b.*\bdenylisted\b/.test(lowered)) {
    return true;
  }
  if (/\bmodify\b.*\bvendored\b/.test(lowered)) {
    return true;
  }
  if (
    /\bvendored?\b/.test(lowered) &&
    /\b(ao |agent-orchestrator|packages\/core|vendor\/)/.test(lowered)
  ) {
    return true;
  }
  return false;
}

function inferTypeFromTitle(title: string): FindingType {
  const lowered = title.toLowerCase();
  if (lowered.includes('scope')) {
    return 'scope-violation';
  }
  if (lowered.includes('security')) {
    return 'security';
  }
  if (lowered.includes('test')) {
    return 'test';
  }
  if (lowered.includes('ci')) {
    return 'ci';
  }
  if (lowered.includes('spec')) {
    return 'spec';
  }
  return 'quality';
}

function resolveFindingType(
  record: Record<string, unknown>,
  title: string,
  body: string,
): FindingType {
  const explicitType = normalizeFindingType(record.type);
  if (explicitType) {
    return explicitType;
  }

  const code = typeof record.code === 'string' ? record.code.trim() : '';
  if (code) {
    const prefix = code.split(':')[0];
    const fromCode = normalizeFindingType(prefix);
    if (fromCode) {
      return fromCode;
    }
  }

  if (/\[scope-violation\]/i.test(title)) {
    return 'scope-violation';
  }

  if (isScopeViolationFindingText(`${title}\n${body}`)) {
    return 'scope-violation';
  }

  return inferTypeFromTitle(title);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

const WINDOWS_DRIVE_ABS = /^[a-zA-Z]:[\\/]/;

function isPathInsideRepo(filePath: string, repoRoot: string): boolean {
  const resolvedRoot = resolve(repoRoot);
  const resolvedPath = resolve(filePath);
  const rootPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  const pathLower = resolvedPath.toLowerCase();
  const rootLower = rootPrefix.toLowerCase();
  return pathLower === resolvedRoot.toLowerCase() || pathLower.startsWith(rootLower);
}

/** Map Codex absolute paths to repository-relative paths for AO payloads. */
export function toRepoRelativePath(filePath: string, repoRoot: string): string | null {
  const trimmed = filePath.trim();
  if (!trimmed) {
    return null;
  }

  if (WINDOWS_DRIVE_ABS.test(trimmed) && process.platform !== 'win32') {
    return null;
  }

  if (!isAbsolute(trimmed) && !WINDOWS_DRIVE_ABS.test(trimmed)) {
    const resolvedPath = resolve(repoRoot, trimmed);
    if (!isPathInsideRepo(resolvedPath, repoRoot)) {
      return null;
    }
    const rel = relative(resolve(repoRoot), resolvedPath).replace(/\\/g, '/');
    if (!rel || rel === '.' || rel.startsWith('..')) {
      return null;
    }
    return rel;
  }

  if (!isPathInsideRepo(trimmed, repoRoot)) {
    return null;
  }

  const resolvedRoot = resolve(repoRoot);
  const resolvedPath = resolve(trimmed);
  const rel = relative(resolvedRoot, resolvedPath).replace(/\\/g, '/');
  if (!rel || rel === '.') {
    return null;
  }

  return rel;
}

function normalizeReviewFinding(
  raw: unknown,
  index: number,
  source: ReviewSource,
  repoRoot: string,
): StructuredFinding | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }

  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const body = typeof record.body === 'string' ? record.body.trim() : '';
  if (!title || !body) {
    return null;
  }

  let path: string | null = null;
  const codeLocation = asRecord(record.code_location);
  const absolutePath =
    typeof codeLocation?.absolute_file_path === 'string'
      ? codeLocation.absolute_file_path.trim()
      : '';
  if (absolutePath) {
    path = toRepoRelativePath(absolutePath, repoRoot);
  }

  const priority = record.priority;
  const severity = priorityToSeverity(priority, title);
  const type = resolveFindingType(record, title, body);
  const explicitCode = typeof record.code === 'string' ? record.code.trim() : '';
  const codeBase = slugify(title.replace(/^\[P\d\]\s*/i, '')) || `finding-${index + 1}`;
  const code = explicitCode || `${type}:${codeBase}`;

  return {
    type,
    code,
    severity,
    path,
    summary: title,
    details: body,
    source,
  };
}

export type ParseReviewOutputResult =
  | { kind: 'clean' }
  | { kind: 'findings'; findings: StructuredFinding[] }
  | { kind: 'error'; message: string };

export function parseCodexReviewOutput(
  reviewOutput: CodexReviewOutput,
  source: ReviewSource,
  repoRoot: string,
): ParseReviewOutputResult {
  if (!('findings' in reviewOutput)) {
    return {
      kind: 'error',
      message:
        'review-mode JSONL review_output is missing required findings array — refusing to mark run as clean',
    };
  }

  if (!Array.isArray(reviewOutput.findings)) {
    return {
      kind: 'error',
      message:
        'review-mode JSONL review_output findings must be an array — refusing to mark run as clean',
    };
  }

  const rawFindings = reviewOutput.findings;
  const findings = rawFindings
    .map((entry, index) => normalizeReviewFinding(entry, index, source, repoRoot))
    .filter((entry): entry is StructuredFinding => entry !== null);

  if (findings.length !== rawFindings.length) {
    return {
      kind: 'error',
      message: 'review-mode JSONL findings missing mandatory fields (title/body)',
    };
  }

  for (const raw of rawFindings) {
    const record = asRecord(raw);
    const codeLocation = asRecord(record?.code_location);
    const absolutePath =
      typeof codeLocation?.absolute_file_path === 'string'
        ? codeLocation.absolute_file_path.trim()
        : '';
    if (absolutePath && toRepoRelativePath(absolutePath, repoRoot) === null) {
      return {
        kind: 'error',
        message: UNNORMALIZABLE_CODE_LOCATION_MESSAGE,
      };
    }
  }

  const patchCorrect = isPatchCorrectVerdict(reviewOutput.overall_correctness);

  if (findings.length === 0 && patchCorrect) {
    return { kind: 'clean' };
  }

  if (findings.length === 0 && !patchCorrect) {
    if (!isExplicitNonCleanVerdict(reviewOutput.overall_correctness)) {
      return {
        kind: 'error',
        message:
          'review-mode JSONL review_output is missing explicit overall_correctness — refusing to mark run as clean',
      };
    }
    return {
      kind: 'error',
      message: SPLIT_CHANNEL_EMPTY_FINDINGS_MESSAGE,
    };
  }

  if (findings.length > 0 && patchCorrect) {
    return {
      kind: 'error',
      message:
        'review-mode JSONL reports findings while overall_correctness is "patch is correct" — contradictory machine verdict',
    };
  }

  if (findings.length > 0) {
    return { kind: 'findings', findings };
  }

  return {
    kind: 'error',
    message: 'review-mode JSONL review_output is missing findings and a clean verdict',
  };
}

type SecondaryChannelPayload =
  | { kind: 'clean' }
  | { kind: 'findings'; findings: StructuredFinding[] };

function isExactNoFindingsSecondary(text: string): boolean {
  return text.trim() === NO_FINDINGS_TOKEN;
}

/** Raw JSONL may coerce non-string secondary channel fields; never call string methods on them. */
function secondaryChannelText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** `NO_FINDINGS` present but not the sole trimmed channel payload (#135 exact token). */
function isMalformedNoFindingsSecondaryChannel(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || isExactNoFindingsSecondary(trimmed)) {
    return false;
  }
  return trimmed.includes(NO_FINDINGS_TOKEN);
}

/** Non-empty secondary text that is not exact NO_FINDINGS or strict pack JSON (#135). */
function isForbiddenProseSecondaryChannel(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || isExactNoFindingsSecondary(trimmed)) {
    return false;
  }
  if (extractStrictPackFindingsArray(trimmed)) {
    return false;
  }
  return true;
}

/** Bare `[...]` findings JSON in a secondary channel (#135 pack-object shape only). */
function isBareFindingsArraySecondaryChannel(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || isExactNoFindingsSecondary(trimmed)) {
    return false;
  }
  let jsonText = trimmed;
  const entireFence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (entireFence?.[1]) {
    jsonText = entireFence[1].trim();
  }
  if (!jsonText.startsWith('[')) {
    return false;
  }
  try {
    return Array.isArray(JSON.parse(jsonText));
  } catch {
    return true;
  }
}

/** Trimmed secondary text (after optional whole-line fence) is a pack `{"findings":...}` object. */
function channelTextLooksLikePackFindingsObject(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  let jsonText = trimmed;
  const entireFence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (entireFence?.[1]) {
    jsonText = entireFence[1].trim();
  }
  if (jsonText.startsWith('{"findings"')) {
    return true;
  }
  // Pretty-printed pack object, e.g. `{\n  "findings": [` (must not match prose mid-string).
  return /^\{\s*"findings"\s*[:[]/.test(jsonText);
}

/** Pack `{"findings":[...]}` present but syntactically invalid or entries fail normalization — fail closed. */
function isMalformedPackFindingsSecondaryChannel(
  text: string,
  source: ReviewSource,
  repoRoot: string,
): boolean {
  const trimmed = text.trim();
  if (!trimmed || isExactNoFindingsSecondary(trimmed)) {
    return false;
  }
  const strictFindings = extractStrictPackFindingsArray(trimmed);
  if (strictFindings) {
    return tryParsePackFindingsFromSecondaryText(text, source, repoRoot) === null;
  }
  return channelTextLooksLikePackFindingsObject(trimmed);
}

function otherChannelBlocksSoleRecovery(
  text: string,
  source: ReviewSource,
  repoRoot: string,
): boolean {
  if (!text.trim()) {
    return false;
  }
  return (
    isMalformedNoFindingsSecondaryChannel(text) ||
    isBareFindingsArraySecondaryChannel(text) ||
    isForbiddenProseSecondaryChannel(text) ||
    isMalformedPackFindingsSecondaryChannel(text, source, repoRoot)
  );
}

/**
 * Split-channel secondary parser (#135). Must not call `parseCodexOutput` — its
 * stdout normalization treats "Review complete" plus NO_FINDINGS and similar forms
 * as clean; recovery accepts only exact trimmed `NO_FINDINGS` or strict pack JSON.
 */
function tryParsePackFindingsFromSecondaryText(
  text: string,
  source: ReviewSource,
  repoRoot: string,
): SecondaryChannelPayload | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  if (isExactNoFindingsSecondary(trimmed)) {
    return { kind: 'clean' };
  }

  const rawFindings = extractStrictPackFindingsArray(trimmed);
  if (!rawFindings) {
    return null;
  }

  const structured = normalizeStructuredPackFindings(rawFindings);
  if (structured) {
    return { kind: 'findings', findings: structured };
  }

  const codexNative = parseCodexReviewOutput(
    {
      findings: rawFindings,
      overall_correctness: 'patch is incorrect',
    },
    source,
    repoRoot,
  );
  if (codexNative.kind === 'findings') {
    return { kind: 'findings', findings: codexNative.findings };
  }

  return null;
}

function findingSignature(findings: StructuredFinding[]): string {
  return findings
    .map(
      (finding) =>
        `${finding.type}|${finding.code}|${finding.path ?? ''}|${finding.summary}|${finding.severity}`,
    )
    .sort()
    .join('\n');
}

function secondaryPayloadsAgree(
  left: SecondaryChannelPayload,
  right: SecondaryChannelPayload,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'clean') {
    return true;
  }
  if (left.kind === 'findings' && right.kind === 'findings') {
    return findingSignature(left.findings) === findingSignature(right.findings);
  }
  return false;
}

export function isSplitChannelRecoveryCandidate(
  reviewOutput: CodexReviewOutput,
  parsed: ParseReviewOutputResult,
): boolean {
  if (parsed.kind !== 'error' || parsed.message !== SPLIT_CHANNEL_EMPTY_FINDINGS_MESSAGE) {
    return false;
  }
  if (!Array.isArray(reviewOutput.findings) || reviewOutput.findings.length > 0) {
    return false;
  }
  return isExplicitNonCleanVerdict(reviewOutput.overall_correctness);
}

/**
 * Shape-gated recovery for split-channel Codex review-mode output: empty JSONL
 * findings[] with pack JSON or exact NO_FINDINGS in secondary channels only.
 */
export function attemptSplitChannelRecovery(
  reviewOutput: CodexReviewOutput,
  lastMessage: string,
  source: ReviewSource,
  repoRoot: string,
): ParseReviewOutputResult | null {
  if (!isExplicitNonCleanVerdict(reviewOutput.overall_correctness)) {
    return null;
  }

  const explanation = secondaryChannelText(reviewOutput.overall_explanation);
  const lastMsg = lastMessage.trim();

  const explanationPayload = explanation
    ? tryParsePackFindingsFromSecondaryText(explanation, source, repoRoot)
    : null;
  const lastMessagePayload = lastMsg
    ? tryParsePackFindingsFromSecondaryText(lastMsg, source, repoRoot)
    : null;

  if (!explanationPayload && !lastMessagePayload) {
    return null;
  }

  if (explanationPayload && lastMessagePayload) {
    if (!secondaryPayloadsAgree(explanationPayload, lastMessagePayload)) {
      return null;
    }
    if (explanationPayload.kind === 'clean') {
      return { kind: 'clean' };
    }
    return { kind: 'findings', findings: explanationPayload.findings };
  }

  const sole = explanationPayload ?? lastMessagePayload;
  if (!sole) {
    return null;
  }

  const otherChannelText = explanationPayload ? lastMsg : explanation;
  if (otherChannelText && otherChannelBlocksSoleRecovery(otherChannelText, source, repoRoot)) {
    return null;
  }

  if (sole.kind === 'clean') {
    return { kind: 'clean' };
  }
  return { kind: 'findings', findings: sole.findings };
}

export function parseReviewModeFromChannels(options: {
  processJsonl: string;
  sessionJsonl?: string | null;
  lastMessage?: string;
  source: ReviewSource;
  repoRoot: string;
  codexHome?: string;
}): ParseReviewOutputResult | null {
  const sessionId = extractThreadIdFromProcessJsonl(options.processJsonl);
  if (!sessionId) {
    return null;
  }

  const sessionJsonl =
    options.sessionJsonl ??
    readPersistedSessionJsonl(sessionId, { codexHome: options.codexHome });
  if (!sessionJsonl?.trim()) {
    return null;
  }

  const exited = parseExitedReviewModeFromSessionJsonl(sessionJsonl);
  if (exited.status === 'malformed') {
    return { kind: 'error', message: exited.message };
  }
  if (exited.status === 'absent') {
    return null;
  }

  const parsed = parseCodexReviewOutput(exited.reviewOutput, options.source, options.repoRoot);
  if (
    isSplitChannelRecoveryCandidate(exited.reviewOutput, parsed) &&
    options.lastMessage !== undefined
  ) {
    const recovered = attemptSplitChannelRecovery(
      exited.reviewOutput,
      options.lastMessage,
      options.source,
      options.repoRoot,
    );
    if (recovered) {
      return recovered;
    }
  }
  return parsed;
}

export function diagnosticSnippet(text: string, maxLen = 200): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (!oneLine) {
    return '(empty)';
  }
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}...` : oneLine;
}
