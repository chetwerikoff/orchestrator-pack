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
  readSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';
import {
  AUDIT_BLOCKING_STATUSES,
  classifyUnitReads,
  delegableReadsFromClassifications,
  indexServedExcludedVolume,
  isKnownCursorSurface,
  loadClassifierManifest,
  READ_CLASSIFICATIONS,
} from './read-delegation-classifier.mjs';

/** T1 single-question volume floor (canonical; drift-checked in tracked policy). */
export const T1_VOLUME_FLOOR = 400;

/** Diff/log trigger floor (independent of T1). */
export const DIFF_LOG_FLOOR = 200;

/** File-count leg requires co-occurring combined lines at T1 (folded T2). */
export const T2_MIN_FILES = 3;

export const SURFACES = ['cursor', 'claude'];

export const AUDIT_SCHEMA_VERSION = 4;

/** Cursor-seat advisory classifications (Issue #359). */
export const CURSOR_ADVISORY_CLASSIFICATIONS = {
  ADVISORY: 'advisory',
  ADVISORY_SATISFIED: 'advisory-satisfied',
  SHELL_READ_AROUND: 'shell-read-around',
};
export const REVIEW_HOOK_CAPTURE_BRANCHES = {
  WORLD_A_NO_REVIEW_HOOK: 'world-a-no-review-hook',
  WORLD_B_HOOK_PRESENT: 'world-b-hook-present',
  UNKNOWN: 'unknown',
};
export const DENOMINATOR_CAUSES = {
  NO_TRIGGER: 'no-trigger',
  ALL_EXCLUDED: 'all-excluded',
  NORMAL: 'normal',
};
export const REVIEW_SIGNAL_SOURCES = {
  TRACKED_REVIEW_WRAPPER: 'tracked-review-wrapper',
  AMBIENT_ENV: 'ambient-env',
};

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const REVIEW_HOOK_CAPABILITY_RECORD_PATH = join(
  repoRoot,
  'docs',
  'read-delegation-review-hook-capability.json',
);
const STOP_HOOK_WRAPPER_RELATIVE_PATH = 'scripts/invoke-read-delegation-audit-stop.ps1';

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

const COWORKER_ASK_PATTERN =
  /\bcoworker\s+ask\b[\s\S]*?--profile(?:\s*=|\s+)code\b/i;

/**
 * @param {string} command
 */
export function normalizeShellCommandForAudit(command) {
  return String(command ?? '')
    .replace(/\\\r?\n/g, ' ')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} command
 */
export function matchesCoworkerAskCommand(command) {
  return COWORKER_ASK_PATTERN.test(normalizeShellCommandForAudit(command));
}

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

const READ_TOOL_NAMES = new Set(['Read', 'read', 'read_file', 'ReadFile']);
const EDIT_TOOL_NAMES = new Set([
  'Write',
  'write',
  'StrReplace',
  'str_replace',
  'search_replace',
  'Edit',
  'edit',
  'MultiEdit',
  'multi_edit',
  'EditNotebook',
  'edit_notebook',
]);
const SHELL_TOOL_NAMES = new Set(['Shell', 'shell', 'run_terminal_cmd', 'Bash', 'bash']);

const DIFF_LOG_SHELL_PATTERN =
  /\b(git\s+(diff|log|show)\b|git\s+diff\b|\bdiff\b[^|\n]{0,40}\b|journalctl\b)/i;

const SHELL_CHUNK_READ_PATTERN = /\b(head|tail|cat|sed|awk|grep|wc)\b/i;
const SHELL_SCRIPT_READ_PATTERN = /\b(?:open|read|Path)\s*\(/i;

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
    const kind =
      row.kind === 'diff' || row.kind === 'log' || row.kind === 'external' || row.kind === 'fetched'
        ? row.kind
        : 'file';
    return {
      path: typeof row.path === 'string' ? row.path : undefined,
      lines: Math.max(0, Number(row.lines) || 0),
      kind,
      isCodeClass: row.isCodeClass === true,
      fenceSignal: row.fenceSignal === true,
      capturedCommit: typeof row.capturedCommit === 'string' ? row.capturedCommit : undefined,
      classifierManifestHash:
        typeof row.classifierManifestHash === 'string' ? row.classifierManifestHash : undefined,
      surface: typeof row.surface === 'string' ? row.surface : undefined,
      readDiscriminator:
        typeof row.readDiscriminator === 'string' ? row.readDiscriminator : undefined,
      canonicalPath: typeof row.canonicalPath === 'string' ? row.canonicalPath : undefined,
      targetedRead: row.targetedRead === true,
    };
  });
}

const DELEGABLE_FILE_KINDS = new Set(['file', 'external', 'fetched']);

/**
 * @param {import('./read-delegation-audit.d.mts').ReadEntry[]} reads
 */
export function aggregateDelegableFileLines(reads) {
  return reads
    .filter((read) => DELEGABLE_FILE_KINDS.has(read.kind) && !read.isCodeClass)
    .reduce((sum, read) => sum + read.lines, 0);
}

/**
 * Delegable out-of-index file lines (excludes index-served source reads).
 * @param {import('./read-delegation-audit.d.mts').ReadEntry[]} reads
 */
export function aggregateOutOfIndexFileLines(reads) {
  return reads
    .filter((read) => read.kind === 'file')
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
    .filter((read) => DELEGABLE_FILE_KINDS.has(read.kind) && !read.isCodeClass && read.path)
    .map((read) => read.path);
  return new Set(paths).size;
}

/**
 * @param {import('./read-delegation-audit.d.mts').ReadEntry[]} reads
 */
export function aggregateAllFileLines(reads) {
  return reads
    .filter((read) => DELEGABLE_FILE_KINDS.has(read.kind))
    .reduce((sum, read) => sum + read.lines, 0);
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
export function normalizeReviewSignal(value) {
  if (!isRecord(value)) {
    return { present: false, source: 'absent', trusted: false, undecidable: false };
  }
  const present = value.present === true || value.isReviewExecution === true || value.kind === 'review-execution';
  const source = String(value.source ?? '');
  const trusted = present && source === REVIEW_SIGNAL_SOURCES.TRACKED_REVIEW_WRAPPER;
  const ambient = present && source === REVIEW_SIGNAL_SOURCES.AMBIENT_ENV;
  return {
    present,
    source: source || (present ? 'undecidable' : 'absent'),
    trusted,
    undecidable: present && !trusted && !ambient,
  };
}

/**
 * @param {import('./read-delegation-audit.d.mts').SessionContext} session
 */
export function isReviewerPathSession(session) {
  return normalizeReviewSignal(session.reviewSignal).trusted;
}

export function reviewMarkerState(session) {
  const signal = normalizeReviewSignal(session.reviewSignal);
  if (signal.trusted) {
    return 'trusted-review-execution';
  }
  if (signal.undecidable) {
    return 'undecidable';
  }
  if (signal.present) {
    return 'ambient';
  }
  return 'absent';
}

/**
 * @param {import('./read-delegation-audit.d.mts').WorkUnit} unit
 */
export function isCodeClassUnit(unit) {
  if (unit.codeClassGated === true) {
    return true;
  }
  const reads = normalizeReads(unit.reads);
  return reads.length > 0 && reads.every((read) => read.isCodeClass === true);
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
  return commands.some((command) => matchesCoworkerAskCommand(String(command ?? '')));
}



/**
 * @param {string} surface
 */
export function isCursorSeat(surface) {
  const { manifest } = loadClassifierManifest();
  return isKnownCursorSurface(surface, manifest);
}

/**
 * @param {import('./read-delegation-audit.d.mts').ReadClassificationResult[]} results
 * @param {import('./read-delegation-audit.d.mts').SessionContext} session
 */
export function applyCursorAdvisoryClassifications(results, session) {
  if (!isCursorSeat(session.surface)) {
    return results;
  }
  return results.map((row) => {
    if (
      row.classification === READ_CLASSIFICATIONS.OUT_OF_INDEX &&
      row.read.kind !== 'diff'
    ) {
      return {
        ...row,
        classification: CURSOR_ADVISORY_CLASSIFICATIONS.ADVISORY,
        delegable: false,
        excludedFromDenominator: true,
        exclusionRecord: {
          ...(row.exclusionRecord ?? {}),
          advisoryCarveOut: true,
          priorClassification: READ_CLASSIFICATIONS.OUT_OF_INDEX,
        },
      };
    }
    return row;
  });
}

/**
 * @param {import('./read-delegation-audit.d.mts').ReadClassificationResult[]} classifications
 */
export function advisoryReadsFromClassifications(classifications) {
  return classifications
    .filter((row) => row.classification === CURSOR_ADVISORY_CLASSIFICATIONS.ADVISORY)
    .map((row) => row.read);
}

/**
 * @param {string} command
 */
export function isShellReadAroundCommand(command) {
  const trimmed = String(command ?? '').trim();
  if (!trimmed || matchesCoworkerAskCommand(trimmed)) {
    return false;
  }
  if (/\bgit\s+(diff|log|show)\b/i.test(trimmed)) {
    return false;
  }
  if (SHELL_CHUNK_READ_PATTERN.test(trimmed)) {
    return true;
  }
  if (/\b(?:python\d*|perl)\b/i.test(trimmed)) {
    return SHELL_SCRIPT_READ_PATTERN.test(trimmed);
  }
  return false;
}

/**
 * @param {string | undefined} filePath
 */
function normalizePathForShellMatch(filePath) {
  return String(filePath ?? '').replace(/\\/g, '/').trim();
}

/**
 * @param {string} command
 * @param {string | undefined} filePath
 */
function commandReferencesPath(command, filePath) {
  const normalizedPath = normalizePathForShellMatch(filePath);
  if (!normalizedPath) {
    return false;
  }
  const commandText = String(command ?? '');
  if (commandText.includes(normalizedPath)) {
    return true;
  }
  const baseName = normalizedPath.split('/').pop();
  return Boolean(baseName && baseName.length > 1 && commandText.includes(baseName));
}

/**
 * @param {import('./read-delegation-audit.d.mts').WorkUnit} unit
 * @param {import('./read-delegation-audit.d.mts').ReadEntry[]} advisoryReads
 */
function advisoryRawReads(unit, advisoryReads) {
  const rawReads = Array.isArray(unit.reads) ? unit.reads : [];
  const advisoryPaths = new Set(
    advisoryReads
      .map((read) => normalizePathForShellMatch(read.path))
      .filter((filePath) => filePath),
  );
  if (advisoryPaths.size === 0) {
    return [];
  }
  return rawReads.filter((read) => advisoryPaths.has(normalizePathForShellMatch(read.path)));
}

/**
 * @param {import('./read-delegation-audit.d.mts').WorkUnit} unit
 * @param {import('./read-delegation-audit.d.mts').ReadEntry[]} advisoryReads
 */
export function hasShellReadAround(unit, advisoryReads) {
  const reads = Array.isArray(advisoryReads) ? advisoryReads : [];
  if (reads.length === 0) {
    return false;
  }
  const advisoryPaths = reads
    .map((read) => read.path)
    .filter((filePath) => typeof filePath === 'string' && filePath.trim());
  if (advisoryPaths.length === 0) {
    return false;
  }
  const commands = Array.isArray(unit.shellCommands) ? unit.shellCommands : [];
  return commands.some((command) => {
    const text = String(command ?? '');
    if (!isShellReadAroundCommand(text)) {
      return false;
    }
    return advisoryPaths.some((filePath) => commandReferencesPath(text, filePath));
  });
}

/**
 * @param {import('./read-delegation-audit.d.mts').ReadEntry[]} reads
 */
export function hasTargetedRead(reads) {
  return reads.some((read) => read.targetedRead === true);
}

/**
 * @param {import('./read-delegation-audit.d.mts').WorkUnit} unit
 * @param {import('./read-delegation-audit.d.mts').ReadEntry[]} advisoryReads
 */
export function resolveCursorAdvisoryOutcome(unit, advisoryReads) {
  if (hasMachineObservedDelegation(unit)) {
    return {
      advisoryOutcome: CURSOR_ADVISORY_CLASSIFICATIONS.ADVISORY_SATISFIED,
      advisorySatisfied: true,
      shellReadAround: false,
    };
  }
  if (hasTargetedRead(advisoryRawReads(unit, advisoryReads))) {
    return {
      advisoryOutcome: CURSOR_ADVISORY_CLASSIFICATIONS.ADVISORY_SATISFIED,
      advisorySatisfied: true,
      shellReadAround: false,
    };
  }
  if (hasShellReadAround(unit, advisoryReads)) {
    return {
      advisoryOutcome: CURSOR_ADVISORY_CLASSIFICATIONS.SHELL_READ_AROUND,
      advisorySatisfied: false,
      shellReadAround: true,
    };
  }
  return {
    advisoryOutcome: CURSOR_ADVISORY_CLASSIFICATIONS.ADVISORY,
    advisorySatisfied: false,
    shellReadAround: false,
  };
}

/**
 * @param {import('./read-delegation-audit.d.mts').WorkUnit} unit
 * @param {import('./read-delegation-audit.d.mts').ReadEntry[]} advisoryReads
 */
function buildCursorAdvisoryVerdictFields(unit, advisoryReads) {
  const advisoryExcludedLines = advisoryReads.reduce(
    (sum, read) => sum + (read.lines ?? 0),
    0,
  );
  return {
    advisory: true,
    advisoryExcludedLines,
    ...resolveCursorAdvisoryOutcome(unit, advisoryReads),
  };
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
  const rawReads = Array.isArray(unit.reads) ? unit.reads : [];
  const reads = normalizeReads(rawReads);
  const reviewerPath = isReviewerPathSession(session);
  const reviewSignalState = reviewMarkerState(session);

  if (reviewerPath) {
    const trigger = didAskTriggerFire(reads);
    return buildAuditVerdict(unit, session, {
      reads,
      trigger,
      triggerFired: trigger.rawFired,
      excludedFromDenominator: true,
      inDenominator: false,
      flagged: false,
      reviewerPath,
      reviewSignalState,
      codeClass: false,
      readClassifications: [],
      indexServedExcludedLines: 0,
    });
  }

  if (unit.codeClassGated === true) {
    const trigger = didAskTriggerFire(reads);
    return buildAuditVerdict(unit, session, {
      reads,
      trigger,
      triggerFired: trigger.rawFired,
      excludedFromDenominator: true,
      inDenominator: false,
      flagged: false,
      reviewerPath: false,
      reviewSignalState,
      codeClass: true,
      readClassifications: [],
      indexServedExcludedLines: 0,
    });
  }

  const classification = classifyUnitReads({ ...unit, reads: rawReads }, {
    surface: session.surface,
    checkoutCommit: session.checkoutCommit,
    trackedPathsOverride: session.trackedPathsOverride,
  });

  if (classification.blocking) {
    return buildAuditVerdict(unit, session, {
      reads,
      trigger: didAskTriggerFire(reads),
      triggerFired: false,
      excludedFromDenominator: false,
      inDenominator: false,
      flagged: false,
      reviewerPath: false,
      reviewSignalState,
      codeClass: false,
      readClassifications: classification.results,
      indexServedExcludedLines: indexServedExcludedVolume(classification.results),
      blockingFailure: classification.blocking,
    });
  }

  const remappedResults = applyCursorAdvisoryClassifications(
    classification.results,
    session,
  );
  const delegableReads = delegableReadsFromClassifications(remappedResults);
  const advisoryReads = advisoryReadsFromClassifications(remappedResults);
  const trigger = didAskTriggerFire(delegableReads);
  const advisoryTrigger = didAskTriggerFire(advisoryReads);
  const rawTrigger = didAskTriggerFire(reads);
  const indexServedExcludedLines = indexServedExcludedVolume(remappedResults);
  const allReadsExcluded =
    remappedResults.length > 0 &&
    remappedResults.every((row) => row.excludedFromDenominator);
  const codeClass =
    remappedResults.length > 0 &&
    remappedResults.every((row) => row.classification === READ_CLASSIFICATIONS.CODE_CLASS);
  const allIndexServed =
    remappedResults.length > 0 &&
    remappedResults.every((row) => row.classification === READ_CLASSIFICATIONS.INDEX_SERVED);
  const excludedFromDenominator =
    allReadsExcluded && rawTrigger.rawFired && !trigger.fired;

  if (!trigger.fired || excludedFromDenominator) {
    if (isCursorSeat(session.surface) && advisoryTrigger.fired) {
      const machineObservedDelegation = hasMachineObservedDelegation(unit);
      return buildAuditVerdict(unit, session, {
        reads,
        trigger: advisoryTrigger,
        triggerFired: advisoryTrigger.fired,
        excludedFromDenominator: true,
        inDenominator: false,
        flagged: false,
        reviewerPath: false,
        reviewSignalState,
        codeClass,
        allIndexServed,
        readClassifications: remappedResults,
        indexServedExcludedLines,
        machineObservedDelegation,
        ...buildCursorAdvisoryVerdictFields(unit, advisoryReads),
      });
    }

    return buildAuditVerdict(unit, session, {
      reads,
      trigger,
      triggerFired:
        advisoryTrigger.fired ||
        trigger.fired ||
        (allIndexServed && rawTrigger.rawFired),
      excludedFromDenominator,
      inDenominator: false,
      flagged: false,
      reviewerPath: false,
      reviewSignalState,
      codeClass,
      allIndexServed,
      readClassifications: remappedResults,
      indexServedExcludedLines,
    });
  }

  const machineObservedDelegation = hasMachineObservedDelegation(unit);
  const selfAttestedDelegation = hasSelfAttestedDelegation(unit);
  const exceptedReason = hasExceptedReason(unit.statusText);
  const editExempt = hasEditInUnit(unit);

  const flagged = !machineObservedDelegation && !editExempt && !exceptedReason;
  const advisoryFields =
    isCursorSeat(session.surface) && advisoryTrigger.fired
      ? buildCursorAdvisoryVerdictFields(unit, advisoryReads)
      : {};

  return buildAuditVerdict(unit, session, {
    reads,
    trigger,
    triggerFired: trigger.fired,
    excludedFromDenominator: false,
    inDenominator: true,
    flagged,
    reviewerPath: false,
    reviewSignalState,
    codeClass,
    allIndexServed,
    readClassifications: remappedResults,
    indexServedExcludedLines,
    selfAttestedDelegation,
    machineObservedDelegation,
    exceptedReason,
    editExempt,
    ...advisoryFields,
  });
}

/**
 * @param {import('./read-delegation-audit.d.mts').WorkUnit} unit
 * @param {import('./read-delegation-audit.d.mts').SessionContext} session
 * @param {Record<string, unknown>} fields
 */
function buildAuditVerdict(unit, session, fields) {
  return {
    workUnitKey: unit.key,
    inboundRequestId: unit.inboundRequestId,
    surface: session.surface,
    triggerFired: fields.triggerFired,
    excludedFromDenominator: fields.excludedFromDenominator,
    inDenominator: fields.inDenominator,
    flagged: fields.flagged,
    trigger: fields.trigger,
    reviewerPath: fields.reviewerPath,
    reviewSignalState: fields.reviewSignalState,
    auditSchemaVersion: AUDIT_SCHEMA_VERSION,
    hookWiringFingerprint: session.hookWiringFingerprint,
    codeClass: fields.codeClass,
    allIndexServed: fields.allIndexServed === true,
    readClassifications: fields.readClassifications ?? [],
    indexServedExcludedLines: fields.indexServedExcludedLines ?? 0,
    selfAttestedDelegation: fields.selfAttestedDelegation ?? false,
    machineObservedDelegation: fields.machineObservedDelegation ?? false,
    exceptedReason: fields.exceptedReason ?? false,
    editExempt: fields.editExempt ?? false,
    advisory: fields.advisory === true,
    advisoryOutcome: fields.advisoryOutcome,
    advisorySatisfied: fields.advisorySatisfied === true,
    shellReadAround: fields.shellReadAround === true,
    advisoryExcludedLines: fields.advisoryExcludedLines ?? 0,
    blockingFailure: fields.blockingFailure,
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
    if (typeof event.capturedCommit === 'string') {
      unit.capturedCommit = event.capturedCommit;
    }
    if (typeof event.classifierManifestHash === 'string') {
      unit.classifierManifestHash = event.classifierManifestHash;
    }

    const kind = String(event.kind ?? event.type ?? '');
    if (kind === 'read') {
      const readKind =
        event.readKind === 'diff' || event.readKind === 'log'
          ? event.readKind
          : event.readKind === 'external' || event.readKind === 'fetched'
            ? event.readKind
            : 'file';
      unit.reads.push(...normalizeReads([{ ...event, kind: readKind }]));
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

export function computeDenominatorCause(verdicts) {
  const triggerFiring = verdicts.filter((verdict) => verdict.triggerFired);
  if (triggerFiring.some((verdict) => verdict.inDenominator)) {
    return DENOMINATOR_CAUSES.NORMAL;
  }
  if (triggerFiring.some((verdict) => verdict.excludedFromDenominator)) {
    return DENOMINATOR_CAUSES.ALL_EXCLUDED;
  }
  return DENOMINATOR_CAUSES.NO_TRIGGER;
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
  const indexServedExcludedLines = verdicts.reduce(
    (sum, verdict) => sum + (verdict.indexServedExcludedLines ?? 0),
    0,
  );
  const advisoryUnits = verdicts.filter((verdict) => verdict.advisory === true);
  const advisorySatisfiedUnits = advisoryUnits.filter(
    (verdict) =>
      verdict.advisoryOutcome === CURSOR_ADVISORY_CLASSIFICATIONS.ADVISORY_SATISFIED,
  );
  const shellReadAroundUnits = advisoryUnits.filter(
    (verdict) =>
      verdict.advisoryOutcome === CURSOR_ADVISORY_CLASSIFICATIONS.SHELL_READ_AROUND,
  );
  const advisoryExcludedLines = advisoryUnits.reduce(
    (sum, verdict) => sum + (verdict.advisoryExcludedLines ?? 0),
    0,
  );

  const denominatorCause = computeDenominatorCause(verdicts);

  return {
    delegableTriggerUnits: denominator.length,
    flaggedUnits: flagged.length,
    flaggedReadLines,
    indexServedExcludedLines,
    advisoryUnits: advisoryUnits.length,
    advisorySatisfiedUnits: advisorySatisfiedUnits.length,
    shellReadAroundUnits: shellReadAroundUnits.length,
    advisoryExcludedLines,
    residualNonCompliance:
      denominator.length === 0 ? 0 : flagged.length / denominator.length,
    denominatorCause,
    denominatorEmptyCause: denominator.length === 0 ? denominatorCause : undefined,
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
  if (typeof input.target_file === 'string' && input.target_file.trim()) {
    return input.target_file;
  }
  if (typeof input.file_path === 'string' && input.file_path.trim()) {
    return input.file_path;
  }
  return undefined;
}

/**
 * @param {string} text
 */
export function countTextLines(text) {
  if (text === '') {
    return 0;
  }
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.length;
}

/**
 * @param {string} filePath
 * @param {number} [offset]
 * @param {number} [limit]
 */
export function countFileLinesFromDisk(filePath, offset = 0, limit) {
  const fd = openSync(filePath, 'r');
  try {
    const chunkSize = 64 * 1024;
    const buffer = Buffer.alloc(chunkSize);
    let position = 0;
    let lineCount = 0;
    let carry = '';
    const maxLinesToCount =
      limit !== undefined && !Number.isNaN(limit)
        ? offset + limit
        : Number.POSITIVE_INFINITY;

    while (true) {
      const bytesRead = readSync(fd, buffer, 0, chunkSize, position);
      if (bytesRead <= 0) {
        break;
      }
      position += bytesRead;
      const text = carry + buffer.toString('utf8', 0, bytesRead);
      let start = 0;
      while (start < text.length) {
        const newline = text.indexOf('\n', start);
        if (newline === -1) {
          carry = text.slice(start);
          break;
        }
        lineCount += 1;
        if (lineCount >= maxLinesToCount) {
          return limit;
        }
        start = newline + 1;
      }
      if (start >= text.length) {
        carry = '';
      }
    }

    if (carry.length > 0) {
      lineCount += 1;
    }

    const available = Math.max(0, lineCount - offset);
    if (limit !== undefined && !Number.isNaN(limit)) {
      return Math.min(limit, available);
    }
    return available;
  } finally {
    closeSync(fd);
  }
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
      return countTextLines(capturedText);
    }
  }

  const filePath = resolveReadToolPath(input) ?? '';
  if (filePath && existsSync(filePath)) {
    return countFileLinesFromDisk(filePath, offset, limit);
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
  return text === '' ? 0 : countTextLines(text);
}

const SHELL_COMMAND_WORDS = new Set([
  'head',
  'tail',
  'cat',
  'sed',
  'awk',
  'grep',
  'wc',
  'python',
  'python3',
  'perl',
  '-n',
  '-c',
]);

/**
 * @param {string} token
 */
function looksLikeShellCommandPath(token) {
  return token.includes('/') || /\.[a-z0-9]{1,8}$/i.test(token);
}

/**
 * @param {string} command
 */
function extractNestedQuotedPath(candidate) {
  const openMatch = String(candidate ?? '').match(/\bopen\s*\(\s*['"]([^'"]+)['"]/);
  if (openMatch && looksLikeShellCommandPath(openMatch[1])) {
    return openMatch[1];
  }
  const pathMatch = String(candidate ?? '').match(/\bPath\s*\(\s*['"]([^'"]+)['"]/);
  if (pathMatch && looksLikeShellCommandPath(pathMatch[1])) {
    return pathMatch[1];
  }
  return undefined;
}

export function extractShellCommandPath(command) {
  const trimmed = String(command ?? '').trim();
  const nestedFromWhole = extractNestedQuotedPath(trimmed);
  if (nestedFromWhole) {
    return nestedFromWhole;
  }
  const quotedMatches = [...trimmed.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
  for (const candidate of quotedMatches) {
    const nestedPath = extractNestedQuotedPath(candidate);
    if (nestedPath) {
      return nestedPath;
    }
    if (looksLikeShellCommandPath(candidate)) {
      return candidate;
    }
  }

  const tokens = trimmed.split(/\s+/);
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index].replace(/^['"]|['"]$/g, '');
    if (!token || token.startsWith('-')) {
      continue;
    }
    if (/^\d+$/.test(token)) {
      continue;
    }
    if (SHELL_COMMAND_WORDS.has(token.toLowerCase())) {
      continue;
    }
    const nestedFromToken = extractNestedQuotedPath(token);
    if (nestedFromToken) {
      return nestedFromToken;
    }
    if (looksLikeShellCommandPath(token)) {
      return token;
    }
  }

  return undefined;
}

/**
 * @param {string} command
 * @param {unknown} [capturedOutput]
 * @param {string} [filePath]
 */
export function inferShellReadAroundLines(command, capturedOutput, filePath) {
  if (capturedOutput !== undefined && capturedOutput !== null) {
    const text = extractToolResultText(capturedOutput);
    if (text !== '') {
      return countTextLines(text);
    }
  }

  const trimmed = String(command ?? '').trim();
  const headTailExplicit = trimmed.match(/\b(head|tail)\b\s+-n\s+(\d+)\b/i);
  if (headTailExplicit) {
    return Number(headTailExplicit[2]);
  }
  if (/\b(?:head|tail)\b/i.test(trimmed)) {
    return 10;
  }

  const sedRange = trimmed.match(/\bsed\s+-n\s+['"]?(\d+),(\d+)p['"]?/i);
  if (sedRange) {
    return Number(sedRange[2]) - Number(sedRange[1]) + 1;
  }

  return 0;
}

/**
 * @param {string} command
 * @param {string} filePath
 */
function inferShellReadAroundReadKind(command, filePath) {
  const trimmed = String(command ?? '').trim();
  if (/\btail\b/i.test(trimmed)) {
    return 'log';
  }
  if (/\.log$/i.test(filePath)) {
    return 'log';
  }
  return 'file';
}

/**
 * @param {string} command
 * @param {unknown} [capturedOutput]
 */
export function inferShellReadAroundRead(command, capturedOutput) {
  if (!isShellReadAroundCommand(command)) {
    return null;
  }
  const filePath = extractShellCommandPath(command);
  if (!filePath) {
    return null;
  }
  const lines = inferShellReadAroundLines(command, capturedOutput, filePath);
  if (lines <= 0) {
    return null;
  }
  return {
    path: filePath,
    lines,
    readKind: inferShellReadAroundReadKind(command, filePath),
  };
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
    const targetedRead = input.offset !== undefined || input.limit !== undefined;
    events.push({
      kind: 'read',
      inboundRequestId,
      path,
      lines: measureReadToolLines(input, options.toolOutput),
      readKind: 'file',
      targetedRead,
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
    if (matchesCoworkerAskCommand(command)) {
      events.push({ kind: 'coworker_ask', inboundRequestId, profile: 'code' });
    }
    const readAround = inferShellReadAroundRead(command, options.shellOutput);
    if (readAround) {
      events.push({
        kind: 'read',
        inboundRequestId,
        path: readAround.path,
        lines: readAround.lines,
        readKind: readAround.readKind,
      });
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


export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function currentAuditCodeHashes() {
  const files = [
    'docs/read-delegation-audit.mjs',
    STOP_HOOK_WRAPPER_RELATIVE_PATH,
  ];
  const hashes = {};
  for (const relativePath of files) {
    hashes[relativePath] = sha256File(join(repoRoot, relativePath));
  }
  return hashes;
}

export function currentHookWiringFingerprint() {
  const wrapperHash = sha256File(join(repoRoot, STOP_HOOK_WRAPPER_RELATIVE_PATH));
  return {
    wrapper: STOP_HOOK_WRAPPER_RELATIVE_PATH,
    wrapperHash,
    commandShape: 'pwsh <repo>/scripts/invoke-read-delegation-audit-stop.ps1 [-ArtifactPath <redacted>] [-RepoRoot <repo>]',
  };
}

function validateCapabilityEntry(entry, surface) {
  if (!isRecord(entry)) {
    return { branch: REVIEW_HOOK_CAPTURE_BRANCHES.UNKNOWN, degraded: true, reason: 'missing-entry' };
  }
  const branch = String(entry.branch ?? '');
  if (
    branch !== REVIEW_HOOK_CAPTURE_BRANCHES.WORLD_A_NO_REVIEW_HOOK &&
    branch !== REVIEW_HOOK_CAPTURE_BRANCHES.WORLD_B_HOOK_PRESENT
  ) {
    return { branch: REVIEW_HOOK_CAPTURE_BRANCHES.UNKNOWN, degraded: true, reason: 'invalid-branch' };
  }
  if (String(entry.surface ?? surface) !== surface) {
    return { branch: REVIEW_HOOK_CAPTURE_BRANCHES.UNKNOWN, degraded: true, reason: 'surface-mismatch' };
  }

  const expectedHashes = currentAuditCodeHashes();
  const recordedHashes = isRecord(entry.codeHashes) ? entry.codeHashes : {};
  for (const [relativePath, hash] of Object.entries(expectedHashes)) {
    if (recordedHashes[relativePath] !== hash) {
      return { branch: REVIEW_HOOK_CAPTURE_BRANCHES.UNKNOWN, degraded: true, reason: `hash-mismatch:${relativePath}` };
    }
  }

  const expectedFingerprint = currentHookWiringFingerprint();
  const recordedFingerprint = isRecord(entry.hookWiringFingerprint) ? entry.hookWiringFingerprint : {};
  if (
    recordedFingerprint.wrapper !== expectedFingerprint.wrapper ||
    recordedFingerprint.wrapperHash !== expectedFingerprint.wrapperHash ||
    recordedFingerprint.commandShape !== expectedFingerprint.commandShape
  ) {
    return { branch: REVIEW_HOOK_CAPTURE_BRANCHES.UNKNOWN, degraded: true, reason: 'hook-fingerprint-mismatch' };
  }

  return { branch, degraded: false, reason: 'ok' };
}

export function loadReviewHookCapability(recordPath = REVIEW_HOOK_CAPABILITY_RECORD_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch {
    return {
      branch: REVIEW_HOOK_CAPTURE_BRANCHES.UNKNOWN,
      degraded: true,
      reason: 'missing-or-unreadable',
      bySurface: Object.fromEntries(SURFACES.map((surface) => [surface, {
        branch: REVIEW_HOOK_CAPTURE_BRANCHES.UNKNOWN,
        degraded: true,
        reason: 'missing-or-unreadable',
      }])),
    };
  }
  if (!isRecord(parsed) || parsed.kind !== 'read-delegation-review-hook-capability.v1') {
    return {
      branch: REVIEW_HOOK_CAPTURE_BRANCHES.UNKNOWN,
      degraded: true,
      reason: 'malformed',
      bySurface: Object.fromEntries(SURFACES.map((surface) => [surface, {
        branch: REVIEW_HOOK_CAPTURE_BRANCHES.UNKNOWN,
        degraded: true,
        reason: 'malformed',
      }])),
    };
  }
  const entries = isRecord(parsed.surfaces) ? parsed.surfaces : {};
  const bySurface = {};
  for (const surface of SURFACES) {
    bySurface[surface] = validateCapabilityEntry(entries[surface], surface);
  }
  const degraded = Object.values(bySurface).some((entry) => entry.degraded);
  const branches = [...new Set(Object.values(bySurface).map((entry) => entry.branch))];
  return {
    branch: degraded || branches.length !== 1 ? REVIEW_HOOK_CAPTURE_BRANCHES.UNKNOWN : branches[0],
    degraded: degraded || branches.length !== 1,
    reason: degraded ? 'surface-capability-degraded' : 'ok',
    bySurface,
  };
}

function capabilityForVerdicts(capability, verdicts) {
  if (verdicts.some((verdict) => verdict.reviewSignalState === 'undecidable')) {
    return {
      branch: REVIEW_HOOK_CAPTURE_BRANCHES.UNKNOWN,
      degraded: true,
      reason: 'undecidable-review-marker',
      bySurface: capability.bySurface,
    };
  }
  const observedFingerprints = verdicts
    .map((verdict) => verdict.hookWiringFingerprint)
    .filter((fingerprint) => fingerprint !== undefined);
  if (observedFingerprints.length > 0) {
    const expected = currentHookWiringFingerprint();
    const mismatch = observedFingerprints.some((fingerprint) => {
      if (!isRecord(fingerprint)) return true;
      return fingerprint.wrapper !== expected.wrapper ||
        fingerprint.wrapperHash !== expected.wrapperHash ||
        fingerprint.commandShape !== expected.commandShape;
    });
    if (mismatch) {
      return {
        branch: REVIEW_HOOK_CAPTURE_BRANCHES.UNKNOWN,
        degraded: true,
        reason: 'live-hook-fingerprint-mismatch',
        bySurface: capability.bySurface,
      };
    }
  }
  return capability;
}

/**
 * @param {string} artifactPath
 */
export function loadMetricWindowSummary(artifactPath, options = {}) {
  const capability = loadReviewHookCapability(
    typeof options.capabilityRecordPath === 'string' ? options.capabilityRecordPath : REVIEW_HOOK_CAPABILITY_RECORD_PATH,
  );
  if (!existsSync(artifactPath)) {
    return {
      delegableTriggerUnits: 0,
      flaggedUnits: 0,
      flaggedReadLines: 0,
      indexServedExcludedLines: 0,
      advisoryUnits: 0,
      advisorySatisfiedUnits: 0,
      shellReadAroundUnits: 0,
      advisoryExcludedLines: 0,
      residualNonCompliance: 0,
      auditErrors: 0,
      missingWindows: 0,
      denominatorCause: DENOMINATOR_CAUSES.NO_TRIGGER,
      reviewHookCaptureBranch: capability.branch,
      reviewHookCapability: capability,
      degraded: capability.degraded,
      bySurface: {},
    };
  }

  /** @type {import('./read-delegation-audit.d.mts').AuditVerdict[]} */
  const verdicts = [];
  let auditErrors = 0;
  let missingWindows = 0;
  /** @type {Record<string, { delegableTriggerUnits: number, flaggedUnits: number, auditErrors: number, denominatorCause?: string, reviewHookCaptureBranch?: string }>} */
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
      if (parsed.verdict.auditSchemaVersion !== AUDIT_SCHEMA_VERSION) {
        continue;
      }
      if (parsed.hookWiringFingerprint !== undefined && parsed.verdict.hookWiringFingerprint === undefined) {
        parsed.verdict.hookWiringFingerprint = parsed.hookWiringFingerprint;
      }
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
  const effectiveCapability = capabilityForVerdicts(capability, verdicts);
  for (const surface of Object.keys(bySurface)) {
    const surfaceVerdicts = verdicts.filter((verdict) => String(verdict.surface ?? surface) === surface);
    bySurface[surface].denominatorCause = summarizeAuditVerdicts(surfaceVerdicts).denominatorCause;
    bySurface[surface].reviewHookCaptureBranch = isRecord(effectiveCapability.bySurface?.[surface])
      ? effectiveCapability.bySurface[surface].branch
      : effectiveCapability.branch;
  }
  return {
    ...summary,
    auditErrors,
    missingWindows,
    reviewHookCaptureBranch: effectiveCapability.branch,
    reviewHookCapability: effectiveCapability,
    degraded: auditErrors > 0 || missingWindows > 0 || effectiveCapability.degraded || summary.denominatorCause === DENOMINATOR_CAUSES.ALL_EXCLUDED,
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
export function resolveAuditWorkUnits(payload) {
  const workUnits = Array.isArray(payload.workUnits) ? payload.workUnits : [];
  const events = Array.isArray(payload.events) ? payload.events : [];
  if (workUnits.length > 0) {
    return workUnits;
  }
  if (events.length > 0) {
    return partitionEventsIntoWorkUnits(events);
  }
  return [];
}

/**
 * @param {string | undefined} artifactPath
 * @param {Record<string, unknown>} health
 */
function appendAuditHealthRecord(artifactPath, health) {
  if (!artifactPath) {
    return;
  }
  try {
    appendMetricRecord(artifactPath, health);
  } catch {
    // fail-open: health persistence is best-effort
  }
}

/**
 * @param {Record<string, unknown>} payload
 * @param {{ skipPopulate?: boolean }} [options]
 */
export function evaluateStopAudit(payload, options = {}) {
  const enriched = options.skipPopulate ? payload : populateStopAuditPayload(payload);
  const surface = String(enriched.surface ?? 'cursor');
  if (!SURFACES.includes(surface)) {
    throw new Error(`unsupported surface: ${surface}`);
  }

  const session = {
    surface,
    env: isRecord(enriched.env) ? enriched.env : {},
    reviewSignal: isRecord(enriched.reviewSignal)
      ? enriched.reviewSignal
      : isRecord(enriched.reviewExecution)
        ? enriched.reviewExecution
        : {
            present: enriched.reviewerPath === true || enriched.reviewMarkerPresent === true,
            source: String(enriched.reviewerPathSource ?? enriched.reviewMarkerSource ?? 'undecidable'),
          },
    hookWiringFingerprint: isRecord(enriched.hookWiringFingerprint)
      ? enriched.hookWiringFingerprint
      : currentHookWiringFingerprint(),
  };

  const units = resolveAuditWorkUnits(enriched);

  const verdicts = auditWorkUnits(units, session);
  const blocking = verdicts.find((verdict) => verdict.blockingFailure);
  if (blocking?.blockingFailure) {
    throw new Error(
      `read-delegation audit blocking status: ${blocking.blockingFailure.status}`,
    );
  }
  const baseSummary = summarizeAuditVerdicts(verdicts);
  const effectiveCapability = capabilityForVerdicts(loadReviewHookCapability(), verdicts);
  const summary = {
    ...baseSummary,
    reviewHookCaptureBranch: effectiveCapability.branch,
    reviewHookCapability: effectiveCapability,
    degraded: effectiveCapability.degraded || baseSummary.denominatorCause === DENOMINATOR_CAUSES.ALL_EXCLUDED,
  };

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
  const raw = isRecord(payload) ? payload : {};
  const normalized = normalizeStopHookPayload(raw);

  try {
    const enriched = populateStopAuditPayload(raw);
    const artifactPath =
      typeof enriched.artifactPath === 'string' ? enriched.artifactPath : undefined;
    const windowId = String(enriched.windowId ?? 'default');
    const eventId = String(enriched.eventId ?? enriched.workUnitKey ?? `stop:${Date.now()}`);

    const result = evaluateStopAudit(enriched, { skipPopulate: true });
    const records = [];

    for (const verdict of result.verdicts) {
      const perUnitEventId = `${eventId}:${verdict.workUnitKey}`;
      records.push({
        kind: 'work_unit_verdict',
        windowId,
        surface: result.surface,
        eventId: perUnitEventId,
        emittedAtMs: Number(enriched.nowMs) || Date.now(),
        auditSchemaVersion: AUDIT_SCHEMA_VERSION,
        hookWiringFingerprint: verdict.hookWiringFingerprint,
        verdict,
      });
    }

    const appendResults = [];
    if (artifactPath) {
      if (records.length === 0 && !result.verdicts.length) {
        const transcriptPath = enriched.transcriptPath ?? enriched.transcript_path;
        const hasExtractedData =
          (Array.isArray(enriched.workUnits) && enriched.workUnits.length > 0) ||
          (Array.isArray(enriched.events) && enriched.events.length > 0);
        if (!hasExtractedData) {
          appendResults.push(
            appendMetricRecord(artifactPath, {
              kind: 'missing_window',
              windowId,
              surface: result.surface,
              eventId: `missing:${eventId}`,
              emittedAtMs: Number(enriched.nowMs) || Date.now(),
              message:
                typeof transcriptPath === 'string' && transcriptPath.trim()
                  ? 'transcript_path present but produced no recognizable tool events'
                  : 'stop hook payload lacked workUnits/events and transcript_path',
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
    const artifactPath =
      typeof normalized.artifactPath === 'string' ? normalized.artifactPath : undefined;
    const windowId = String(normalized.windowId ?? 'default');
    const conversationId = String(
      normalized.conversationId ?? normalized.conversation_id ?? 'conversation',
    );
    const generationId = String(
      normalized.generationId ?? normalized.generation_id ?? 'generation',
    );
    const eventId = String(
      normalized.eventId ?? normalized.workUnitKey ?? `stop:${conversationId}:${generationId}`,
    );
    const health = {
      kind: 'audit_error',
      windowId,
      surface: String(normalized.surface ?? 'unknown'),
      eventId: `error:${eventId}`,
      emittedAtMs: Number(normalized.nowMs) || Date.now(),
      message: error instanceof Error ? error.message : String(error),
    };

    appendAuditHealthRecord(artifactPath, health);

    let metric;
    if (artifactPath) {
      try {
        metric = { artifactPath, window: loadMetricWindowSummary(artifactPath) };
      } catch {
        metric = { artifactPath };
      }
    }

    return {
      ok: false,
      failOpen: true,
      error: health.message,
      health,
      metric,
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
