/**
 * Stop-time coworker read-delegation audit (Issue #255).
 * Vitest: scripts/read-delegation-audit.test.ts
 *
 * Tolerant compliance signal at work-unit completion — never blocks reads.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
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

  const existingIds = readMetricEventIds(artifactPath);
  if (existingIds.has(eventId)) {
    return { appended: false, duplicate: true, artifactPath };
  }

  const parent = dirname(artifactPath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }

  const line = `${JSON.stringify(record)}\n`;
  const fd = openSync(artifactPath, 'a');
  try {
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }

  return { appended: true, duplicate: false, artifactPath };
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
 * @param {Record<string, unknown>} payload
 */
export function evaluateStopAudit(payload) {
  const surface = String(payload.surface ?? 'cursor');
  if (!SURFACES.includes(surface)) {
    throw new Error(`unsupported surface: ${surface}`);
  }

  const session = {
    surface,
    reviewerPath: payload.reviewerPath === true,
    env: isRecord(payload.env) ? payload.env : {},
  };

  const units = Array.isArray(payload.workUnits)
    ? payload.workUnits
    : partitionEventsIntoWorkUnits(
        Array.isArray(payload.events) ? payload.events : [],
      );

  const verdicts = auditWorkUnits(units, session);
  const summary = summarizeAuditVerdicts(verdicts);

  return {
    surface,
    verdicts,
    summary,
    flags: verdicts.filter((verdict) => verdict.flagged),
  };
}

/**
 * @param {Record<string, unknown>} payload
 */
export function runStopAudit(payload) {
  const artifactPath = typeof payload.artifactPath === 'string' ? payload.artifactPath : undefined;
  const windowId = String(payload.windowId ?? 'default');
  const eventId = String(payload.eventId ?? payload.workUnitKey ?? `stop:${Date.now()}`);

  try {
    const result = evaluateStopAudit(payload);
    const records = [];

    for (const verdict of result.verdicts) {
      const perUnitEventId = `${eventId}:${verdict.workUnitKey}`;
      records.push({
        kind: 'work_unit_verdict',
        windowId,
        surface: result.surface,
        eventId: perUnitEventId,
        emittedAtMs: Number(payload.nowMs) || Date.now(),
        verdict,
      });
    }

    const appendResults = [];
    if (artifactPath) {
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
      surface: String(payload.surface ?? 'unknown'),
      eventId: `error:${eventId}`,
      emittedAtMs: Number(payload.nowMs) || Date.now(),
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
  const surface = hookPayload.hookEventName === 'Stop' ? 'claude' : 'cursor';
  return {
    ...hookPayload,
    surface: hookPayload.surface ?? surface,
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
