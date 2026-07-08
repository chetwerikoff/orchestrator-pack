#!/usr/bin/env node
/**
 * Finding-disposition ledger guard (Issue #575).
 * Fails closed when protected findings are rejected or omitted vs verbatim capture.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const PROTECTED_TYPES = new Set(['security', 'scope-violation']);

const PROTECTED_TYPE_PATTERN =
  /(?<!binding-)\btype:\s*(security|scope-violation)\b/gi;
const ANY_TYPE_PATTERN = /(?<!binding-)\btype:\s*([a-z][a-z0-9-]*)\b/gi;
const FINDING_ID_PATTERN = /(?<!binding-)\bid:\s*([A-Za-z0-9._-]+)\b/gi;
const FINDING_ID_EXTRACT = /(?<!binding-)\bid:\s*([A-Za-z0-9._-]+)\b/i;
const UNTYPED_FINDING_LINE =
  /^(?:\s*)(?:\[(P[0-3])\]|(P[0-3]))\s*[-–—:]\s*(.+)$/;
const ECHOED_ARTIFACT_MARKER = /^--- ARTIFACT\s/m;
const ECHOED_DRAFT_REVIEW_PROMPT = /^#\s+Codex draft\/spec review prompt/m;

export function detectUntypedFindingsInCapture(capture) {
  const scanText = extractFindingsScanText(capture);
  if (isCleanNoFindings(scanText) || scanText.length === 0) {
    return [];
  }

  const findings = [];
  const lines = scanText.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(UNTYPED_FINDING_LINE);
    if (!match) {
      continue;
    }

    const blockLines = [line];
    let next = index + 1;
    while (next < lines.length && !UNTYPED_FINDING_LINE.test(lines[next])) {
      blockLines.push(lines[next]);
      next += 1;
    }

    const block = blockLines.join('\n');
    if (/\btype:\s*[a-z][a-z0-9-]*\b/i.test(block)) {
      index = next - 1;
      continue;
    }

    const idMatch = block.match(FINDING_ID_EXTRACT);
    const hasCaptureId = Boolean(idMatch);
    const id = idMatch ? idMatch[1] : `untyped-${findings.length + 1}`;
    findings.push({
      id,
      hasCaptureId,
      type: 'untyped',
      anchor: index,
      summary: match[3].trim().slice(0, 160),
    });
    index = next - 1;
  }

  return findings;
}

const PROTECTED_SIGNAL_PATTERNS = [
  { type: 'security', pattern: /\btype:\s*security\b/i },
  { type: 'security', pattern: /\[(?:P[0-3]\s+)?security\]/i },
  { type: 'security', pattern: /\bsecurity\s+issue\b/i },
  { type: 'security', pattern: /\bvulnerabilit(?:y|ies)\b/i },
  { type: 'scope-violation', pattern: /\btype:\s*scope-violation\b/i },
  { type: 'scope-violation', pattern: /\[(?:P[0-3]\s+)?scope-violation\]/i },
  { type: 'scope-violation', pattern: /\bscope[- ]violation\b/i },
  { type: 'scope-violation', pattern: /\bout of scope\b/i },
  { type: 'scope-violation', pattern: /\bdenylist\b/i },
  { type: 'scope-violation', pattern: /\ballowed_roots\b/i },
];

function isCleanNoFindings(capture) {
  return capture.trim() === 'NO_FINDINGS';
}

/** Remove fenced code blocks so echoed draft/spec fences do not trigger detection. */
export function stripMarkdownFencedCodeBlocks(text) {
  return text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
}

function hasEchoedReviewContext(text) {
  return ECHOED_ARTIFACT_MARKER.test(text) || ECHOED_DRAFT_REVIEW_PROMPT.test(text);
}

const TYPED_FINDING_LINE = /^(?<!binding-)\btype:\s*[a-z][a-z0-9-]*\b/i;

function isReviewerFindingLine(line) {
  const trimmed = line.trim();
  if (trimmed === 'NO_FINDINGS') {
    return true;
  }
  if (UNTYPED_FINDING_LINE.test(line)) {
    return true;
  }
  return TYPED_FINDING_LINE.test(trimmed);
}

function indexOfFirstReviewerFindingLine(text, fromIndex = 0) {
  const lines = text.slice(fromIndex).split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (isReviewerFindingLine(lines[index])) {
      const prefix = lines.slice(0, index).join('\n');
      return fromIndex + prefix.length + (index > 0 ? 1 : 0);
    }
  }
  return -1;
}

const INLINE_PROTECTED_FINDING_PATTERN =
  /(?<!binding-)\btype:\s*(security|scope-violation)\b[^\n]{0,320}?(?<!binding-)\bid:\s*[A-Za-z0-9._-]+\b|(?<!binding-)\bid:\s*[A-Za-z0-9._-]+\b[^\n]{0,320}?(?<!binding-)\btype:\s*(security|scope-violation)\b/i;

function indexOfInlineProtectedFinding(text, fromIndex = 0) {
  const slice = text.slice(fromIndex);
  const match = INLINE_PROTECTED_FINDING_PATTERN.exec(slice);
  if (!match) {
    return -1;
  }
  return fromIndex + match.index;
}

function indexOfFirstFindingSignal(text, fromIndex = 0) {
  const headerIdx = indexOfFirstReviewerFindingLine(text, fromIndex);
  const inlineIdx = indexOfInlineProtectedFinding(text, fromIndex);
  if (headerIdx < 0 && inlineIdx < 0) {
    return -1;
  }
  if (headerIdx < 0) {
    return inlineIdx;
  }
  if (inlineIdx < 0) {
    return headerIdx;
  }
  return Math.min(headerIdx, inlineIdx);
}

/** Scope parsing to reviewer findings — skip echoed rubric, draft body, and fenced blocks. */
export function extractFindingsScanText(capture) {
  const withoutFences = stripMarkdownFencedCodeBlocks(capture);
  if (isCleanNoFindings(withoutFences)) {
    return withoutFences;
  }

  if (!hasEchoedReviewContext(withoutFences)) {
    return withoutFences;
  }

  let scanFrom = 0;
  const artifactMatch = withoutFences.match(ECHOED_ARTIFACT_MARKER);
  if (artifactMatch?.index !== undefined) {
    scanFrom = artifactMatch.index;
  } else {
    const headerMatch = withoutFences.match(ECHOED_DRAFT_REVIEW_PROMPT);
    if (headerMatch?.index !== undefined) {
      scanFrom = headerMatch.index;
    }
  }

  const findingStart = indexOfFirstFindingSignal(withoutFences, scanFrom);
  if (findingStart < 0) {
    return '';
  }

  const tail = withoutFences.slice(findingStart).trimStart();
  if (tail === 'NO_FINDINGS') {
    return 'NO_FINDINGS';
  }

  return withoutFences.slice(findingStart);
}

export function parseLedger(ledgerText) {
  let parsed;
  try {
    parsed = JSON.parse(ledgerText);
  } catch (error) {
    throw new Error(`finding-ledger guard: ledger is not valid JSON (${error.message})`);
  }

  if (!Array.isArray(parsed.findings)) {
    throw new Error('finding-ledger guard: ledger must include a findings array');
  }

  const findings = parsed.findings.map((row, index) => {
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    const summary = typeof row.summary === 'string' ? row.summary.trim() : '';
    const type = typeof row.type === 'string' ? row.type.trim().toLowerCase() : '';
    const disposition =
      typeof row.disposition === 'string' ? row.disposition.trim().toLowerCase() : '';
    const rejectReason =
      typeof row.rejectReason === 'string'
        ? row.rejectReason.trim()
        : typeof row['reject-reason'] === 'string'
          ? row['reject-reason'].trim()
          : '';

    if (!id) {
      throw new Error(`finding-ledger guard: findings[${index}] missing id`);
    }
    if (!summary) {
      throw new Error(`finding-ledger guard: findings[${index}] missing summary`);
    }
    if (!type) {
      throw new Error(`finding-ledger guard: findings[${index}] missing type`);
    }
    if (disposition !== 'addressed' && disposition !== 'rejected') {
      throw new Error(
        `finding-ledger guard: findings[${index}] disposition must be addressed or rejected`,
      );
    }
    if (disposition === 'rejected' && !rejectReason) {
      throw new Error(
        `finding-ledger guard: findings[${index}] rejected findings require rejectReason`,
      );
    }

    return { id, summary, type, disposition, rejectReason };
  });

  return { version: parsed.version ?? 1, draft: parsed.draft ?? null, findings };
}

export function detectTypedFindingsInCapture(capture) {
  const scanText = extractFindingsScanText(capture);
  if (isCleanNoFindings(scanText) || scanText.length === 0) {
    return [];
  }

  const findings = [];
  const seen = new Set();
  let match;

  ANY_TYPE_PATTERN.lastIndex = 0;
  while ((match = ANY_TYPE_PATTERN.exec(scanText)) !== null) {
    const type = match[1].toLowerCase();
    const key = `type:${type}@${match.index}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const windowStart = Math.max(0, match.index - 400);
    const windowEnd = Math.min(scanText.length, match.index + 120);
    const before = scanText.slice(windowStart, match.index);
    const after = scanText.slice(match.index, windowEnd);
    const idMatch = after.match(FINDING_ID_EXTRACT) ?? [...before.matchAll(FINDING_ID_PATTERN)].at(-1);
    const hasCaptureId = Boolean(idMatch);
    const id = idMatch ? idMatch[1] : `capture-${type}@${match.index}`;

    findings.push({
      id,
      hasCaptureId,
      type,
      anchor: match.index,
      summary: `${before}${after}`.replace(/\s+/g, ' ').trim().slice(0, 160),
    });
  }

  return findings;
}

export function detectProtectedSignalsInCapture(capture) {
  const scanText = extractFindingsScanText(capture);
  if (isCleanNoFindings(scanText) || scanText.length === 0) {
    return [];
  }

  const signals = [];
  for (const { type, pattern } of PROTECTED_SIGNAL_PATTERNS) {
    if (pattern.test(scanText)) {
      signals.push(type);
    }
    pattern.lastIndex = 0;
  }
  return [...new Set(signals)];
}

function ledgerHasProtectedCoverage(ledger, protectedType) {
  return ledger.findings.some(
    (row) => row.type === protectedType && row.disposition === 'addressed',
  );
}

function ledgerHasProtectedRejection(ledger) {
  return ledger.findings.filter(
    (row) => PROTECTED_TYPES.has(row.type) && row.disposition === 'rejected',
  );
}

function ledgerRowForCaptureFinding(captureFinding, ledger, consumedLedgerIds = new Set()) {
  if (captureFinding.hasCaptureId) {
    return ledger.findings.find((row) => row.id === captureFinding.id);
  }

  return ledger.findings.find(
    (row) => row.type === captureFinding.type && !consumedLedgerIds.has(row.id),
  );
}

function validateCaptureFindingInLedger(captureFinding, ledger, errors, consumedLedgerIds) {
  const row = ledgerRowForCaptureFinding(captureFinding, ledger, consumedLedgerIds);
  if (!row) {
    if (captureFinding.type === 'untyped') {
      errors.push(
        `untyped capture finding (id: ${captureFinding.id}) is missing from the ledger — add type: when normalizing`,
      );
      return;
    }
    if (captureFinding.hasCaptureId) {
      errors.push(
        `capture finding type: ${captureFinding.type} (id: ${captureFinding.id}) is missing from the ledger`,
      );
      return;
    }
    errors.push(
      `capture finding type: ${captureFinding.type} has no matching ledger row — normalize the reviewer finding into the ledger`,
    );
    return;
  }

  consumedLedgerIds.add(row.id);

  if (captureFinding.type === 'untyped') {
    return;
  }
  if (PROTECTED_TYPES.has(captureFinding.type) && row.type !== captureFinding.type) {
    errors.push(
      `protected finding ${captureFinding.id} was reclassified in the ledger as type: ${row.type} (capture type: ${captureFinding.type})`,
    );
    return;
  }

  if (PROTECTED_TYPES.has(captureFinding.type) && row.disposition !== 'addressed') {
    errors.push(
      `protected finding ${captureFinding.id} (type: ${captureFinding.type}) must be disposition addressed`,
    );
  }
}

export function mergeCaptureFindings(captures) {
  const merged = new Map();
  const errors = [];

  for (const capture of captures) {
    for (const finding of [
      ...detectTypedFindingsInCapture(capture),
      ...detectUntypedFindingsInCapture(capture),
    ]) {
      const existing = merged.get(finding.id);
      if (existing && existing.type !== finding.type) {
        if (existing.type === 'untyped' || finding.type === 'untyped') {
          merged.set(finding.id, finding.type === 'untyped' ? existing : finding);
          continue;
        }
        errors.push(
          `capture finding ${finding.id} has conflicting types across passes (${existing.type} vs ${finding.type})`,
        );
      }
      merged.set(finding.id, finding);
    }
  }

  return { findings: [...merged.values()], errors };
}

export function checkFindingLedgerGuard(captureOrCaptures, ledgerText) {
  const captures = Array.isArray(captureOrCaptures) ? captureOrCaptures : [captureOrCaptures];
  const errors = [];
  const ledger = parseLedger(ledgerText);

  for (const row of ledgerHasProtectedRejection(ledger)) {
    errors.push(
      `protected finding ${row.id} (type: ${row.type}) cannot be disposed rejected`,
    );
  }

  const { findings: captureFindings, errors: mergeErrors } = mergeCaptureFindings(captures);
  errors.push(...mergeErrors);

  const consumedLedgerIds = new Set();
  for (const captureFinding of captureFindings) {
    validateCaptureFindingInLedger(captureFinding, ledger, errors, consumedLedgerIds);
  }

  const protectedSignals = new Set();
  for (const capture of captures) {
    for (const signal of detectProtectedSignalsInCapture(capture)) {
      protectedSignals.add(signal);
    }
  }

  const protectedConsumedLedgerIds = new Set();
  for (const protectedType of protectedSignals) {
    const typedInCapture = captureFindings.some((row) => row.type === protectedType);
    const covered =
      typedInCapture
        ? captureFindings
            .filter((row) => row.type === protectedType)
            .every((row) => {
              const ledgerRow = ledgerRowForCaptureFinding(row, ledger, protectedConsumedLedgerIds);
              return (
                ledgerRow &&
                ledgerRow.type === row.type &&
                ledgerRow.disposition === 'addressed'
              );
            })
        : ledgerHasProtectedCoverage(ledger, protectedType);

    if (!covered) {
      errors.push(
        `protected signal type: ${protectedType} present in capture but not addressed in the ledger`,
      );
    }
  }

  for (const row of ledger.findings) {
    if (PROTECTED_TYPES.has(row.type) && row.disposition !== 'addressed') {
      if (!errors.some((message) => message.includes(row.id))) {
        errors.push(
          `protected finding ${row.id} (type: ${row.type}) must be disposition addressed`,
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    ledger,
    captureFindings,
    protectedSignals: [...protectedSignals],
  };
}

function listCaptureFilesInDir(capturesDir) {
  return readdirSync(capturesDir)
    .filter((name) => name.endsWith('.capture.txt'))
    .sort()
    .map((name) => path.join(capturesDir, name));
}

export function runCli(argv) {
  const ledgerFlag = argv.indexOf('--ledger');
  const capturesDirFlag = argv.indexOf('--captures-dir');
  const capturePaths = [];

  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--capture' && argv[index + 1]) {
      capturePaths.push(argv[index + 1]);
      index += 1;
    }
  }

  if (capturesDirFlag >= 0) {
    capturePaths.push(...listCaptureFilesInDir(argv[capturesDirFlag + 1]));
  }

  if (ledgerFlag < 0 || capturePaths.length === 0) {
    process.stderr.write(
      'finding-ledger guard: --ledger <path> and at least one --capture <path> or --captures-dir <path> are required\n',
    );
    return 2;
  }

  const ledgerPath = argv[ledgerFlag + 1];
  const captures = capturePaths.map((capturePath) => readFileSync(capturePath, 'utf8'));
  const ledgerText = readFileSync(ledgerPath, 'utf8');

  let result;
  try {
    result = checkFindingLedgerGuard(captures, ledgerText);
  } catch (error) {
    process.stderr.write(`finding-ledger guard: ${error.message}\n`);
    return 1;
  }

  if (!result.ok) {
    for (const error of result.errors) {
      process.stderr.write(`finding-ledger guard: ${error}\n`);
    }
    return 1;
  }

  process.stdout.write(`finding-ledger guard: PASS (${captures.length} capture file(s))\n`);
  return 0;
}

function isCliMain() {
  const entry = process.argv[1]?.replace(/\\/g, '/');
  return Boolean(entry?.endsWith('finding-ledger-guard.mjs'));
}

if (isCliMain()) {
  process.exit(runCli(process.argv));
}
