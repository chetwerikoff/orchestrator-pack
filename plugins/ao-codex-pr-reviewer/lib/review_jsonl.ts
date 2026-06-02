import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ReviewSource, StructuredFinding } from './types.js';

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
      // skip malformed lines
    }
  }
  return events;
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

  for (const event of parseJsonlLines(sessionJsonl)) {
    const record = asRecord(event);
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
        'review-mode JSONL contained exited_review_mode without a valid review_output object — refusing to mark run as clean',
    };
  }
  return { status: 'absent' };
}

export function isPatchCorrectVerdict(overallCorrectness: string | undefined): boolean {
  if (!overallCorrectness?.trim()) {
    return false;
  }
  return /^patch is correct$/i.test(overallCorrectness.trim());
}

function priorityToSeverity(priority: unknown): 'blocking' | 'non-blocking' {
  if (typeof priority === 'number' && priority <= 1) {
    return 'blocking';
  }
  return 'non-blocking';
}

function inferTypeFromTitle(title: string): string {
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
    return trimmed.replace(/\\/g, '/').replace(/^\.\//, '');
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
  const severity = priorityToSeverity(priority);
  const type = inferTypeFromTitle(title);
  const codeBase = slugify(title.replace(/^\[P\d\]\s*/i, '')) || `finding-${index + 1}`;

  return {
    type,
    code: `${type}:${codeBase}`,
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

  const patchCorrect = isPatchCorrectVerdict(reviewOutput.overall_correctness);

  if (findings.length === 0 && patchCorrect) {
    return { kind: 'clean' };
  }

  if (findings.length === 0 && !patchCorrect) {
    return {
      kind: 'error',
      message:
        'review-mode JSONL reports no findings but overall_correctness is not "patch is correct" — refusing to mark run as clean',
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

export function parseReviewModeFromChannels(options: {
  processJsonl: string;
  sessionJsonl?: string | null;
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

  return parseCodexReviewOutput(exited.reviewOutput, options.source, options.repoRoot);
}

export function diagnosticSnippet(text: string, maxLen = 200): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (!oneLine) {
    return '(empty)';
  }
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}...` : oneLine;
}
