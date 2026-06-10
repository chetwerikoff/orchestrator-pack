/**
 * Stop-time coworker read-delegation audit (Issue #255).
 * Vitest: scripts/read-delegation-audit.test.ts
 *
 * Tolerant compliance signal at work-unit completion — never blocks reads.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';

/** T1 single-question volume floor (canonical; drift-checked in tracked policy). */
export const T1_VOLUME_FLOOR = 400;

/** Diff/log trigger floor (independent of T1). */
export const DIFF_LOG_FLOOR = 200;

/** File-count leg requires co-occurring combined lines at T1 (folded T2). */
export const T2_MIN_FILES = 3;

export const SURFACES = ['cursor', 'claude'];

const EXCEPTED_REASON_PATTERNS = [
  /\bbelow the floor\b/i,
  /\bexcepted reasoning\b/i,
  /\bcorpus not fence-clean/i,
  /\bcoworker\b[^.\n]{0,80}\b(missing|unavailable|rate-?limited)\b/i,
  /\bno-?op\b[^.\n]{0,120}\b(evidence|documented|verified|confirmed)\b/i,
  /\bno edit (was )?needed\b[^.\n]{0,80}\b(evidence|because|after)\b/i,
];

const DELEGATION_STATUS_PATTERN =
  /\b(delegated|coworker ask|used coworker|routed through coworker)\b/i;

const COWORKER_ASK_PATTERN = /\bcoworker\s+ask\b[^|\n]*--profile\s+code\b/i;

const CODE_CLASS_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.cs',
  '.cpp',
  '.c',
  '.h',
  '.swift',
  '.kt',
  '.rb',
  '.php',
  '.vue',
  '.svelte',
]);

const READ_TOOL_NAMES = new Set(['Read', 'read']);
const EDIT_TOOL_NAMES = new Set([
  'Write',
  'write',
  'StrReplace',
  'str_replace',
  'search_replace',
  'EditNotebook',
  'edit_notebook',
]);
const SHELL_TOOL_NAMES = new Set(['Shell', 'shell', 'run_terminal_cmd', 'Bash', 'bash']);

const DIFF_LOG_SHELL_PATTERN =
  /\b(git\s+(diff|log|show)\b|git\s+diff\b|\bdiff\b[^|\n]{0,40}\b|journalctl\b|\btail\b[^|\n]{0,40}\b-[^\s]*f\b)/i;

const LOCK_RETRY_MS = 5;
const LOCK_MAX_ATTEMPTS = 200;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {import('./read-delegation-audit.d.mts').ReadEntry[]}
 */
export function normalizeReads(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    const row = isRecord(entry) ? entry : {};
    const kind = row.kind === 'diff' || row.kind === 'log' ? row.kind : 'file';
    return {
      path: typeof row.path === 'string' ? row.path : undefined,
      lines: Math.max(0, Number(row.lines) || 0),
      kind,
      isCodeClass: row.isCodeClass === true,
    };
  });
}

/**
 * @param {import('./read-delegation-audit.d.mts').ReadEntry[]} reads
 */
export function aggregateDelegableFileLines(reads) {
  return reads
    .filter((read) => read.kind === 'file' && !read.isCodeClass)
    .reduce((sum, read) => sum + read.lines, 0);
}

/**
 * @param {import('./read-delegation-audit.d.mts').ReadEntry[]} reads
 */
export function aggregateDiffLogLines(reads) {
  return reads
    .filter((read) => read.kind === 'diff' || read.kind === 'log')
    .reduce((sum, read) => sum + read.lines, 0);
}

/**
 * @param {import('./read-delegation-audit.d.mts').ReadEntry[]} reads
 */
export function countDelegableFiles(reads) {
  const paths = reads
    .filter((read) => read.kind === 'file' && !read.isCodeClass && read.path)
    .map((read) => read.path);
  return new Set(paths).size;
}

/**
 * @param {import('./read-delegation-audit.d.mts').ReadEntry[]} reads
 */
export function aggregateAllFileLines(reads) {
  return reads.filter((read) => read.kind === 'file').reduce((sum, read) => sum + read.lines, 0);
}

export function didAskTriggerFire(reads) {
  const fileLines = aggregateDelegableFileLines(reads);
  const fileCount = countDelegableFiles(reads);
  const diffLogLines = aggregateDiffLogLines(reads);
  const rawFileLines = aggregateAllFileLines(reads);

  const t1 = fileLines > T1_VOLUME_FLOOR;
  const t2 = fileCount >= T2_MIN_FILES && fileLines >= T1_VOLUME_FLOOR;
  const diffLog = diffLogLines > DIFF_LOG_FLOOR;
  const rawT1 = rawFileLines > T1_VOLUME_FLOOR;

  return {
    fired: t1 || t2 || diffLog,
    rawFired: rawT1 || t2 || diffLog,
    t1,
    t2,
    diffLog,
    fileLines,
    rawFileLines,
    fileCount,
    diffLogLines,
  };
}

/**
 * @param {import('./read-delegation-audit.d.mts').SessionContext} session
 */
export function isReviewerPathSession(session) {
  if (session.reviewerPath === true) {
    return true;
  }
  const env = session.env ?? {};
  return Boolean(
    (typeof env.PACK_REVIEWER === 'string' && env.PACK_REVIEWER.trim()) ||
      (typeof env.REVIEW_COMMAND === 'string' && env.REVIEW_COMMAND.trim()),
  );
}

/**
 * @param {import('./read-delegation-audit.d.mts').WorkUnit} unit
 */
export function isCodeClassUnit(unit) {
  if (unit.codeClassGated === true) {
    return true;
  }
  const reads = normalizeReads(unit.reads);
  return reads.length > 0 && reads.every((read) => read.isCodeClass);
}

/**
 * @param {string | undefined} statusText
 */
export function hasExceptedReason(statusText) {
  const text = String(statusText ?? '');
  if (!text.trim()) {
    return false;
  }
  return EXCEPTED_REASON_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * @param {import('./read-delegation-audit.d.mts').WorkUnit} unit
 */
export function hasSelfAttestedDelegation(unit) {
  const statusText = String(unit.statusText ?? '');
  if (!DELEGATION_STATUS_PATTERN.test(statusText)) {
    return false;
  }
  return !hasMachineObservedDelegation(unit);
}

/**
 * @param {import('./read-delegation-audit.d.mts').WorkUnit} unit
 */
export function hasMachineObservedDelegation(unit) {
  const events = Array.isArray(unit.coworkerEvents) ? unit.coworkerEvents : [];
  if (
    events.some(
      (event) =>
        isRecord(event) &&
        (event.kind === 'coworker_ask' || event.kind === 'ask') &&
        (event.profile === 'code' || event.profile === undefined),
    )
  ) {
    return true;
  }

  const commands = Array.isArray(unit.shellCommands) ? unit.shellCommands : [];
  return commands.some((command) => COWORKER_ASK_PATTERN.test(String(command ?? '')));
}

/**
 * @param {import('./read-delegation-audit.d.mts').WorkUnit} unit
 */
export function hasEditInUnit(unit) {
  const edits = Array.isArray(unit.edits) ? unit.edits : [];
  return edits.length > 0;
}

/**
 * @param {import('./read-delegation-audit.d.mts').WorkUnit} unit
 * @param {import('./read-delegation-audit.d.mts').SessionContext} session
 */
export function auditWorkUnit(unit, session) {
  const reads = normalizeReads(unit.reads);
  const trigger = didAskTriggerFire(reads);
  const reviewerPath = isReviewerPathSession(session);
  const codeClass = isCodeClassUnit({ ...unit, reads });
  const excludedFromDenominator = reviewerPath || codeClass;
  const triggerFired = excludedFromDenominator ? trigger.rawFired : trigger.fired;

  if (!triggerFired || excludedFromDenominator) {
    return {
      workUnitKey: unit.key,
      inboundRequestId: unit.inboundRequestId,
      surface: session.surface,
      triggerFired,
      excludedFromDenominator,
      inDenominator: false,
      flagged: false,
      trigger,
      reviewerPath,
      codeClass,
      selfAttestedDelegation: false,
      machineObservedDelegation: false,
      exceptedReason: false,
      editExempt: false,
    };
  }

  const machineObservedDelegation = hasMachineObservedDelegation(unit);
  const selfAttestedDelegation = hasSelfAttestedDelegation(unit);
  const exceptedReason = hasExceptedReason(unit.statusText);
  const editExempt = hasEditInUnit(unit);

  const flagged =
    !machineObservedDelegation && !editExempt && !exceptedReason;

  return {
    workUnitKey: unit.key,
    inboundRequestId: unit.inboundRequestId,
    surface: session.surface,
    triggerFired,
    excludedFromDenominator: false,
    inDenominator: true,
    flagged,
    trigger,
    reviewerPath,
    codeClass,
    selfAttestedDelegation,
    machineObservedDelegation,
    exceptedReason,
    editExempt,
  };
}

/**
 * @param {import('./read-delegation-audit.d.mts').WorkUnit[]} units
 * @param {import('./read-delegation-audit.d.mts').SessionContext} session
 */
export function auditWorkUnits(units, session) {
  return units.map((unit) => auditWorkUnit(unit, session));
}

/**
 * Group tool-call spans into work units keyed by inbound request id.
 *
 * @param {Array<Record<string, unknown>>} events
 */
export function partitionEventsIntoWorkUnits(events) {
  /** @type {Map<string, import('./read-delegation-audit.d.mts').WorkUnit>} */
  const units = new Map();

  for (const event of events ?? []) {
    if (!isRecord(event)) {
      continue;
    }
    const inboundRequestId = String(event.inboundRequestId ?? event.requestId ?? 'default');
    const key = String(event.workUnitKey ?? `${inboundRequestId}`);
    const unit =
      units.get(key) ??
      ({
        key,
        inboundRequestId,
        reads: [],
        edits: [],
        shellCommands: [],
        coworkerEvents: [],
        statusText: '',
      });

    if (typeof event.statusText === 'string') {
      unit.statusText = event.statusText;
    }
    if (event.codeClassGated === true) {
      unit.codeClassGated = true;
    }

    const kind = String(event.kind ?? event.type ?? '');
    if (kind === 'read') {
      unit.reads.push({
        path: typeof event.path === 'string' ? event.path : undefined,
        lines: Math.max(0, Number(event.lines) || 0),
        kind: event.readKind === 'diff' || event.readKind === 'log' ? event.readKind : 'file',
        isCodeClass: event.isCodeClass === true,
      });
    } else if (kind === 'edit') {
      unit.edits.push({ path: typeof event.path === 'string' ? event.path : undefined });
    } else if (kind === 'shell') {
      unit.shellCommands.push(String(event.command ?? ''));
    } else if (kind === 'coworker_ask' || kind === 'coworker') {
      unit.coworkerEvents.push({
        kind: 'coworker_ask',
        profile: typeof event.profile === 'string' ? event.profile : 'code',
      });
    }

    units.set(key, unit);
  }

  return [...units.values()];
}

/**
 * @param {import('./read-delegation-audit.d.mts').AuditVerdict[]} verdicts
 */
export function summarizeAuditVerdicts(verdicts) {
  const denominator = verdicts.filter((verdict) => verdict.inDenominator);
  const flagged = denominator.filter((verdict) => verdict.flagged);
  const flaggedReadLines = flagged.reduce(
    (sum, verdict) => sum + (verdict.trigger?.fileLines ?? 0) + (verdict.trigger?.diffLogLines ?? 0),
    0,
  );

  return {
    delegableTriggerUnits: denominator.length,
    flaggedUnits: flagged.length,
    flaggedReadLines,
    residualNonCompliance:
      denominator.length === 0 ? 0 : flagged.length / denominator.length,
  };
}

/**
 * @param {string | undefined} filePath
 */
export function isCodeClassPath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return false;
  }
  const lower = filePath.toLowerCase();
  for (const ext of CODE_CLASS_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {Record<string, unknown>} input
 */
export function resolveReadToolPath(input) {
  if (typeof input.path === 'string' && input.path.trim()) {
    return input.path;
  }
  if (typeof input.file_path === 'string' && input.file_path.trim()) {
    return input.file_path;
  }
  return undefined;
}

/**
 * @param {Record<string, unknown>} input
 * @param {unknown} [capturedOutput]
 */
export function measureReadToolLines(input, capturedOutput) {
  const offset = Math.max(0, Number(input.offset) || 0);
  const limit = input.limit === undefined ? undefined : Math.max(0, Number(input.limit) || 0);

  if (capturedOutput !== undefined && capturedOutput !== null) {
    const capturedText = extractToolResultText(capturedOutput);
    if (capturedText !== '') {
      return capturedText.split('\n').length;
    }
  }

  const filePath = resolveReadToolPath(input) ?? '';
  if (filePath && existsSync(filePath)) {
    const text = readFileSync(filePath, 'utf8');
    const totalLines = text === '' ? 0 : text.split('\n').length;
    const available = Math.max(0, totalLines - offset);
    if (limit !== undefined && !Number.isNaN(limit)) {
      return Math.min(limit, available);
    }
    return available;
  }

  return 0;
}

/**
 * @param {unknown} value
 */
export function extractToolResultText(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    return '';
  }
  return value
    .map((part) => {
      if (!isRecord(part)) {
        return '';
      }
      if (part.type === 'text' && typeof part.text === 'string') {
        return part.text;
      }
      if (typeof part.content === 'string') {
        return part.content;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * @param {string} command
 * @param {unknown} [capturedOutput]
 */
export function measureShellDiffLogLines(command, capturedOutput) {
  const trimmed = String(command ?? '').trim();
  if (!trimmed || !DIFF_LOG_SHELL_PATTERN.test(trimmed)) {
    return 0;
  }
  if (capturedOutput === undefined || capturedOutput === null) {
    return 0;
  }

  const text = extractToolResultText(capturedOutput);
  return text === '' ? 0 : text.split('\n').length;
}

/**
 * @param {string} transcriptPath
 */
export function parseTranscriptJsonl(transcriptPath) {
  if (!existsSync(transcriptPath)) {
    return [];
  }

  const records = [];
  const text = readFileSync(transcriptPath, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      records.push(JSON.parse(line));
    } catch {
      // skip corrupt lines
    }
  }
  return records;
}

/**
 * @param {unknown} record
 */
function transcriptRole(record) {
  if (!isRecord(record)) {
    return undefined;
  }
  if (typeof record.role === 'string') {
    return record.role;
  }
  if (typeof record.type === 'string') {
    return record.type;
  }
  return undefined;
}

/**
 * @param {unknown} record
 */
export function isInboundUserRequest(record) {
  const role = transcriptRole(record);
  if (role !== 'user') {
    return false;
  }

  const message = isRecord(record) && isRecord(record.message) ? record.message : record;
  const content = isRecord(message) ? message.content : undefined;
  if (!Array.isArray(content) || content.length === 0) {
    return true;
  }

  return content.some((part) => isRecord(part) && part.type !== 'tool_result');
}

/**
 * @param {Array<Record<string, unknown>>} records
 */
export function buildTranscriptToolResultIndex(records) {
  /** @type {Map<string, string>} */
  const index = new Map();

  for (const record of records) {
    if (transcriptRole(record) !== 'user') {
      continue;
    }
    const message = isRecord(record.message) ? record.message : record;
    const content = isRecord(message) ? message.content : undefined;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (!isRecord(part) || part.type !== 'tool_result') {
        continue;
      }
      const toolUseId = String(part.tool_use_id ?? '');
      if (!toolUseId) {
        continue;
      }
      index.set(toolUseId, extractToolResultText(part.content));
    }
  }

  return index;
}

/**
 * @param {unknown} record
 * @returns {Array<Record<string, unknown>>}
 */
function transcriptToolUses(record) {
  if (!isRecord(record)) {
    return [];
  }

  const uses = [];
  const message = isRecord(record.message) ? record.message : record;
  const content = message.content;

  if (Array.isArray(content)) {
    for (const part of content) {
      if (!isRecord(part)) {
        continue;
      }
      if (part.type === 'tool_use' && typeof part.name === 'string') {
        uses.push({
          id: typeof part.id === 'string' ? part.id : undefined,
          name: part.name,
          input: isRecord(part.input) ? part.input : {},
        });
      }
    }
  }

  if (Array.isArray(record.tool_uses)) {
    for (const toolUse of record.tool_uses) {
      if (!isRecord(toolUse)) {
        continue;
      }
      uses.push({
        id: typeof toolUse.id === 'string' ? toolUse.id : undefined,
        name: String(toolUse.name ?? toolUse.tool_name ?? ''),
        input: isRecord(toolUse.input) ? toolUse.input : isRecord(toolUse.tool_input) ? toolUse.tool_input : {},
      });
    }
  }

  return uses;
}

/**
 * @param {string} toolName
 * @param {Record<string, unknown>} input
 * @param {string} inboundRequestId
 * @param {{ shellOutput?: unknown, toolOutput?: unknown }} [options]
 */
export function toolUseToAuditEvents(toolName, input, inboundRequestId, options = {}) {
  /** @type {Array<Record<string, unknown>>} */
  const events = [];
  const name = String(toolName ?? '');

  if (READ_TOOL_NAMES.has(name)) {
    const path = resolveReadToolPath(input);
    events.push({
      kind: 'read',
      inboundRequestId,
      path,
      lines: measureReadToolLines(input, options.toolOutput),
      readKind: 'file',
      isCodeClass: isCodeClassPath(path),
    });
  }

  if (EDIT_TOOL_NAMES.has(name)) {
    const path =
      (typeof input.path === 'string' && input.path) ||
      (typeof input.target_file === 'string' && input.target_file) ||
      (typeof input.file_path === 'string' && input.file_path) ||
      (typeof input.target_notebook === 'string' && input.target_notebook) ||
      undefined;
    events.push({ kind: 'edit', inboundRequestId, path });
  }

  if (SHELL_TOOL_NAMES.has(name)) {
    const command = String(input.command ?? '');
    events.push({ kind: 'shell', inboundRequestId, command });
    if (COWORKER_ASK_PATTERN.test(command)) {
      events.push({ kind: 'coworker_ask', inboundRequestId, profile: 'code' });
    }
    const diffLogLines = measureShellDiffLogLines(command, options.shellOutput);
    if (diffLogLines > 0) {
      events.push({
        kind: 'read',
        inboundRequestId,
        lines: diffLogLines,
        readKind: 'diff',
      });
    }
  }

  return events;
}

/**
 * @param {Array<Record<string, unknown>>} records
 * @param {{ generationId?: string, conversationId?: string, statusText?: string, workUnitIndex?: number }} [options]
 */
export function extractEventsFromTranscriptRecords(records, options = {}) {
  /** @type {Array<{ inboundRequestId: string, records: Array<Record<string, unknown>> }>} */
  const units = [];
  let current = null;

  for (const record of records) {
    if (isInboundUserRequest(record)) {
      const inboundRequestId =
        options.generationId && units.length === 0
          ? String(options.generationId)
          : `req-${units.length + 1}`;
      current = { inboundRequestId, records: [record] };
      units.push(current);
      continue;
    }
    if (current) {
      current.records.push(record);
    }
  }

  if (units.length === 0) {
    return { events: [], workUnits: [], eventId: undefined };
  }

  const targetIndex =
    typeof options.workUnitIndex === 'number'
      ? Math.min(Math.max(options.workUnitIndex, 0), units.length - 1)
      : units.length - 1;
  const target = units[targetIndex];
  const conversationId = options.conversationId ? String(options.conversationId) : 'conversation';
  const inboundRequestId =
    options.generationId && targetIndex === units.length - 1
      ? String(options.generationId)
      : target.inboundRequestId;
  const workUnitKey = `${conversationId}:${inboundRequestId}`;

  const toolResults = buildTranscriptToolResultIndex(target.records);

  /** @type {Array<Record<string, unknown>>} */
  const events = [];
  for (const record of target.records) {
    if (transcriptRole(record) !== 'assistant') {
      continue;
    }
    for (const toolUse of transcriptToolUses(record)) {
      const capturedOutput =
        typeof toolUse.id === 'string' ? toolResults.get(toolUse.id) : undefined;
      events.push(
        ...toolUseToAuditEvents(toolUse.name, toolUse.input, inboundRequestId, {
          shellOutput: capturedOutput,
          toolOutput: capturedOutput,
        }).map((event) => ({
          ...event,
          workUnitKey,
        })),
      );
    }
  }

  const workUnits = [
    partitionEventsIntoWorkUnits(
      events.map((event) => ({
        ...event,
        inboundRequestId,
        workUnitKey,
        statusText: options.statusText ?? '',
      })),
    )[0],
  ].filter(Boolean);

  if (workUnits[0]) {
    workUnits[0].key = workUnitKey;
    workUnits[0].inboundRequestId = inboundRequestId;
    if (options.statusText) {
      workUnits[0].statusText = options.statusText;
    }
  }

  return {
    events,
    workUnits,
    eventId: `stop:${workUnitKey}`,
    workUnitKey,
  };
}

/**
 * @param {string} transcriptPath
 * @param {{ generationId?: string, conversationId?: string, statusText?: string, workUnitIndex?: number }} [options]
 */
export function extractEventsFromTranscript(transcriptPath, options = {}) {
  const records = parseTranscriptJsonl(transcriptPath);
  return extractEventsFromTranscriptRecords(records, options);
}

/**
 * @param {string} artifactPath
 */
function acquireArtifactLock(artifactPath) {
  const lockPath = `${artifactPath}.lock`;
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      return { fd, lockPath };
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST') {
        const waitUntil = Date.now() + LOCK_RETRY_MS;
        while (Date.now() < waitUntil) {
          // spin
        }
        continue;
      }
      throw error;
    }
  }
  throw new Error(`failed to acquire append lock for ${artifactPath}`);
}

/**
 * @param {{ fd: number, lockPath: string } | undefined} lock
 */
function releaseArtifactLock(lock) {
  if (!lock) {
    return;
  }
  try {
    closeSync(lock.fd);
  } catch {
    // ignore
  }
  try {
    unlinkSync(lock.lockPath);
  } catch {
    // ignore
  }
}

/**
 * @param {string} artifactPath
 * @param {Record<string, unknown>} record
 */
export function readMetricEventIds(artifactPath) {
  if (!existsSync(artifactPath)) {
    return new Set();
  }
  const ids = new Set();
  const text = readFileSync(artifactPath, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.eventId === 'string') {
        ids.add(parsed.eventId);
      }
    } catch {
      // ignore corrupt lines; health record captures parse issues separately
    }
  }
  return ids;
}

/**
 * @param {string} artifactPath
 * @param {Record<string, unknown>} record
 */
export function appendMetricRecord(artifactPath, record) {
  const eventId = String(record.eventId ?? '');
  if (!eventId) {
    throw new Error('metric record requires eventId');
  }

  const parent = dirname(artifactPath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }

  const lock = acquireArtifactLock(artifactPath);
  try {
    const existingIds = readMetricEventIds(artifactPath);
    if (existingIds.has(eventId)) {
      return { appended: false, duplicate: true, artifactPath };
    }

    const line = `${JSON.stringify(record)}\n`;
    const fd = openSync(artifactPath, 'a');
    try {
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }

    return { appended: true, duplicate: false, artifactPath };
  } finally {
    releaseArtifactLock(lock);
  }
}

/**
 * @param {string} artifactPath
 */
export function loadMetricWindowSummary(artifactPath) {
  if (!existsSync(artifactPath)) {
    return {
      delegableTriggerUnits: 0,
      flaggedUnits: 0,
      flaggedReadLines: 0,
      residualNonCompliance: 0,
      auditErrors: 0,
      missingWindows: 0,
      degraded: false,
      bySurface: {},
    };
  }

  /** @type {import('./read-delegation-audit.d.mts').AuditVerdict[]} */
  const verdicts = [];
  let auditErrors = 0;
  let missingWindows = 0;
  /** @type {Record<string, { delegableTriggerUnits: number, flaggedUnits: number, auditErrors: number }>} */
  const bySurface = {};

  const text = readFileSync(artifactPath, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      auditErrors += 1;
      continue;
    }
    if (!isRecord(parsed)) {
      auditErrors += 1;
      continue;
    }

    if (parsed.kind === 'audit_error') {
      auditErrors += 1;
      const surface = String(parsed.surface ?? 'unknown');
      bySurface[surface] = bySurface[surface] ?? {
        delegableTriggerUnits: 0,
        flaggedUnits: 0,
        auditErrors: 0,
      };
      bySurface[surface].auditErrors += 1;
      continue;
    }
    if (parsed.kind === 'missing_window') {
      missingWindows += 1;
      continue;
    }
    if (parsed.kind === 'work_unit_verdict' && isRecord(parsed.verdict)) {
      verdicts.push(/** @type {import('./read-delegation-audit.d.mts').AuditVerdict} */ (parsed.verdict));
      const surface = String(parsed.surface ?? parsed.verdict.surface ?? 'unknown');
      bySurface[surface] = bySurface[surface] ?? {
        delegableTriggerUnits: 0,
        flaggedUnits: 0,
        auditErrors: 0,
      };
      if (parsed.verdict.inDenominator) {
        bySurface[surface].delegableTriggerUnits += 1;
      }
      if (parsed.verdict.flagged) {
        bySurface[surface].flaggedUnits += 1;
      }
    }
  }

  const summary = summarizeAuditVerdicts(verdicts);
  return {
    ...summary,
    auditErrors,
    missingWindows,
    degraded: auditErrors > 0 || missingWindows > 0,
    bySurface,
  };
}

/**
 * @param {Record<string, unknown>} rawPayload
 */
export function populateStopAuditPayload(rawPayload) {
  const payload = normalizeStopHookPayload(isRecord(rawPayload) ? rawPayload : {});

  const hasWorkUnits = Array.isArray(payload.workUnits) && payload.workUnits.length > 0;
  const hasEvents = Array.isArray(payload.events) && payload.events.length > 0;

  if (!hasWorkUnits && !hasEvents) {
    const transcriptPath = payload.transcriptPath ?? payload.transcript_path;
    if (typeof transcriptPath === 'string' && transcriptPath.trim()) {
      const extracted = extractEventsFromTranscript(transcriptPath, {
        generationId: String(payload.generationId ?? payload.generation_id ?? ''),
        conversationId: String(payload.conversationId ?? payload.conversation_id ?? ''),
        statusText: typeof payload.statusText === 'string' ? payload.statusText : '',
      });
      if (extracted.events.length > 0) {
        payload.events = extracted.events;
      }
      if (extracted.workUnits.length > 0) {
        payload.workUnits = extracted.workUnits;
      }
      if (!payload.eventId && extracted.eventId) {
        payload.eventId = extracted.eventId;
      }
      if (!payload.workUnitKey && extracted.workUnitKey) {
        payload.workUnitKey = extracted.workUnitKey;
      }
    }
  }

  if (!payload.eventId) {
    const conversationId = String(payload.conversationId ?? payload.conversation_id ?? 'conversation');
    const generationId = String(payload.generationId ?? payload.generation_id ?? 'generation');
    payload.eventId = `stop:${conversationId}:${generationId}`;
  }

  return payload;
}

/**
 * @param {Record<string, unknown>} payload
 */
export function evaluateStopAudit(payload) {
  const enriched = populateStopAuditPayload(payload);
  const surface = String(enriched.surface ?? 'cursor');
  if (!SURFACES.includes(surface)) {
    throw new Error(`unsupported surface: ${surface}`);
  }

  const session = {
    surface,
    reviewerPath: enriched.reviewerPath === true,
    env: isRecord(enriched.env) ? enriched.env : {},
  };

  const units = Array.isArray(enriched.workUnits)
    ? enriched.workUnits
    : partitionEventsIntoWorkUnits(
        Array.isArray(enriched.events) ? enriched.events : [],
      );

  const verdicts = auditWorkUnits(units, session);
  const summary = summarizeAuditVerdicts(verdicts);

  return {
    surface,
    verdicts,
    summary,
    flags: verdicts.filter((verdict) => verdict.flagged),
    populatedFromTranscript:
      Boolean(enriched.transcriptPath ?? enriched.transcript_path) &&
      !Array.isArray(payload.workUnits) &&
      !Array.isArray(payload.events),
  };
}

/**
 * @param {Record<string, unknown>} payload
 */
export function runStopAudit(payload) {
  const enriched = populateStopAuditPayload(payload);
  const artifactPath =
    typeof enriched.artifactPath === 'string' ? enriched.artifactPath : undefined;
  const windowId = String(enriched.windowId ?? 'default');
  const eventId = String(enriched.eventId ?? enriched.workUnitKey ?? `stop:${Date.now()}`);

  try {
    const result = evaluateStopAudit(enriched);
    const records = [];

    for (const verdict of result.verdicts) {
      const perUnitEventId = `${eventId}:${verdict.workUnitKey}`;
      records.push({
        kind: 'work_unit_verdict',
        windowId,
        surface: result.surface,
        eventId: perUnitEventId,
        emittedAtMs: Number(enriched.nowMs) || Date.now(),
        verdict,
      });
    }

    const appendResults = [];
    if (artifactPath) {
      if (records.length === 0 && !result.verdicts.length) {
        const transcriptPath = enriched.transcriptPath ?? enriched.transcript_path;
        if (!transcriptPath) {
          appendResults.push(
            appendMetricRecord(artifactPath, {
              kind: 'missing_window',
              windowId,
              surface: result.surface,
              eventId: `missing:${eventId}`,
              emittedAtMs: Number(enriched.nowMs) || Date.now(),
              message: 'stop hook payload lacked workUnits/events and transcript_path',
            }),
          );
        }
      }

      for (const record of records) {
        appendResults.push(appendMetricRecord(artifactPath, record));
      }
    }

    return {
      ok: true,
      failOpen: true,
      ...result,
      metric: artifactPath
        ? {
            artifactPath,
            appendResults,
            window: loadMetricWindowSummary(artifactPath),
          }
        : undefined,
    };
  } catch (error) {
    const health = {
      kind: 'audit_error',
      windowId,
      surface: String(enriched.surface ?? 'unknown'),
      eventId: `error:${eventId}`,
      emittedAtMs: Number(enriched.nowMs) || Date.now(),
      message: error instanceof Error ? error.message : String(error),
    };

    if (artifactPath) {
      appendMetricRecord(artifactPath, health);
    }

    return {
      ok: false,
      failOpen: true,
      error: health.message,
      health,
      metric: artifactPath
        ? { artifactPath, window: loadMetricWindowSummary(artifactPath) }
        : undefined,
    };
  }
}

/**
 * @param {Record<string, unknown>} hookPayload
 */
export function normalizeStopHookPayload(hookPayload) {
  const hookEventName = String(
    hookPayload.hookEventName ?? hookPayload.hook_event_name ?? '',
  );
  const surface =
    hookPayload.surface ?? (hookEventName === 'Stop' ? 'claude' : 'cursor');

  return {
    ...hookPayload,
    surface,
    transcriptPath: hookPayload.transcriptPath ?? hookPayload.transcript_path,
    conversationId: hookPayload.conversationId ?? hookPayload.conversation_id,
    generationId: hookPayload.generationId ?? hookPayload.generation_id,
    hookEventName,
  };
}

export function resolveAuditArtifactDefaultPath() {
  const home = process.env.HOME || process.env.USERPROFILE || '.';
  return join(home, '.orchestrator-pack', 'read-delegation-audit.jsonl');
}

const modulePath = fileURLToPath(import.meta.url);

runStdinJsonCli('read-delegation-audit.mjs', {
  evaluate: () => evaluateStopAudit(readStdinJson()),
  stop: () => runStopAudit(readStdinJson()),
  summarize: () => {
    const payload = readStdinJson();
    const artifactPath =
      typeof payload.artifactPath === 'string'
        ? payload.artifactPath
        : resolveAuditArtifactDefaultPath();
    return loadMetricWindowSummary(artifactPath);
  },
});
