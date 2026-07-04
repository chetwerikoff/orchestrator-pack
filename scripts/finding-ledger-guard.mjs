#!/usr/bin/env node
/**
 * Finding-disposition ledger guard (Issue #575).
 * Fails closed when protected findings are rejected or omitted vs verbatim capture.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const PROTECTED_TYPES = new Set(['security', 'scope-violation']);

const PROTECTED_TYPE_PATTERN =
  /\btype:\s*(security|scope-violation)\b/gi;
const ANY_TYPE_PATTERN = /\btype:\s*([a-z][a-z0-9-]*)\b/gi;
const FINDING_ID_PATTERN = /\bid:\s*([A-Za-z0-9._-]+)\b/gi;
const FINDING_ID_EXTRACT = /\bid:\s*([A-Za-z0-9._-]+)\b/i;
const UNTYPED_FINDING_LINE =
  /^(?:\s*)(?:\[(P[0-3])\]|(P[0-3]))\s*[-–—:]\s*(.+)$/;

export function detectUntypedFindingsInCapture(capture) {
  if (isCleanNoFindings(capture)) {
    return [];
  }

  const findings = [];
  const lines = capture.split('\n');

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
    const id = idMatch ? idMatch[1] : `untyped-${findings.length + 1}`;
    findings.push({
      id,
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
  if (isCleanNoFindings(capture)) {
    return [];
  }

  const findings = [];
  const seen = new Set();
  let match;

  ANY_TYPE_PATTERN.lastIndex = 0;
  while ((match = ANY_TYPE_PATTERN.exec(capture)) !== null) {
    const type = match[1].toLowerCase();
    const key = `type:${type}@${match.index}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const windowStart = Math.max(0, match.index - 400);
    const windowEnd = Math.min(capture.length, match.index + 120);
    const before = capture.slice(windowStart, match.index);
    const after = capture.slice(match.index, windowEnd);
    const idMatch = after.match(FINDING_ID_EXTRACT) ?? [...before.matchAll(FINDING_ID_PATTERN)].at(-1);
    const id = idMatch ? idMatch[1] : `capture-${type}-${findings.length + 1}`;

    findings.push({
      id,
      type,
      anchor: match.index,
      summary: `${before}${after}`.replace(/\s+/g, ' ').trim().slice(0, 160),
    });
  }

  return findings;
}

export function detectProtectedSignalsInCapture(capture) {
  if (isCleanNoFindings(capture)) {
    return [];
  }

  const signals = [];
  for (const { type, pattern } of PROTECTED_SIGNAL_PATTERNS) {
    if (pattern.test(capture)) {
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

function ledgerRowForCaptureFinding(captureFinding, ledger) {
  return ledger.findings.find((row) => row.id === captureFinding.id);
}

function validateCaptureFindingInLedger(captureFinding, ledger, errors) {
  const row = ledgerRowForCaptureFinding(captureFinding, ledger);
  if (!row) {
    if (captureFinding.type === 'untyped') {
      errors.push(
        `untyped capture finding (id: ${captureFinding.id}) is missing from the ledger — add type: when normalizing`,
      );
      return;
    }
    errors.push(
      `capture finding type: ${captureFinding.type} (id: ${captureFinding.id}) is missing from the ledger`,
    );
    return;
  }

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

  for (const captureFinding of captureFindings) {
    validateCaptureFindingInLedger(captureFinding, ledger, errors);
  }

  const protectedSignals = new Set();
  for (const capture of captures) {
    for (const signal of detectProtectedSignalsInCapture(capture)) {
      protectedSignals.add(signal);
    }
  }

  for (const protectedType of protectedSignals) {
    const typedInCapture = captureFindings.some((row) => row.type === protectedType);
    const covered =
      typedInCapture
        ? captureFindings
            .filter((row) => row.type === protectedType)
            .every((row) => {
              const ledgerRow = ledgerRowForCaptureFinding(row, ledger);
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
