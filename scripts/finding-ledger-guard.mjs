#!/usr/bin/env node
/**
 * Finding-disposition ledger guard (Issue #575).
 * Fails closed when protected findings are rejected or omitted vs verbatim capture.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PROTECTED_TYPES = new Set(['security', 'scope-violation']);

const PROTECTED_TYPE_PATTERN =
  /\btype:\s*(security|scope-violation)\b/gi;
const ANY_TYPE_PATTERN = /\btype:\s*([a-z][a-z0-9-]*)\b/gi;
const FINDING_ID_PATTERN = /\bid:\s*([A-Za-z0-9._-]+)\b/g;

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
  return /(?:^|\n)\s*NO_FINDINGS\s*(?:\n|$)/m.test(capture);
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
    const idMatch = [...before.matchAll(FINDING_ID_PATTERN)].at(-1) ?? after.match(FINDING_ID_PATTERN);
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

function typedFindingCoveredInLedger(captureFinding, ledger) {
  const byId = ledger.findings.find((row) => row.id === captureFinding.id);
  if (byId) {
    return true;
  }
  return ledger.findings.some(
    (row) => row.type === captureFinding.type && row.summary.length > 0,
  );
}

export function checkFindingLedgerGuard(capture, ledgerText) {
  const errors = [];
  const ledger = parseLedger(ledgerText);

  for (const row of ledgerHasProtectedRejection(ledger)) {
    errors.push(
      `protected finding ${row.id} (type: ${row.type}) cannot be disposed rejected`,
    );
  }

  const captureFindings = detectTypedFindingsInCapture(capture);
  for (const captureFinding of captureFindings) {
    if (!typedFindingCoveredInLedger(captureFinding, ledger)) {
      errors.push(
        `capture finding type: ${captureFinding.type} (id: ${captureFinding.id}) is missing from the ledger`,
      );
    }
  }

  const protectedSignals = detectProtectedSignalsInCapture(capture);
  for (const protectedType of protectedSignals) {
    const typedInCapture = captureFindings.some((row) => row.type === protectedType);
    const covered =
      typedInCapture
        ? captureFindings
            .filter((row) => row.type === protectedType)
            .every((row) => typedFindingCoveredInLedger(row, ledger))
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

  return { ok: errors.length === 0, errors, ledger, captureFindings, protectedSignals };
}

function isCliMain() {
  const entry = process.argv[1]?.replace(/\\/g, '/');
  return Boolean(entry?.endsWith('finding-ledger-guard.mjs'));
}

export function runCli(argv) {
  const captureFlag = argv.indexOf('--capture');
  const ledgerFlag = argv.indexOf('--ledger');

  if (captureFlag < 0 || ledgerFlag < 0) {
    process.stderr.write('finding-ledger guard: --capture <path> and --ledger <path> are required\n');
    return 2;
  }

  const capturePath = argv[captureFlag + 1];
  const ledgerPath = argv[ledgerFlag + 1];
  const capture = readFileSync(capturePath, 'utf8');
  const ledgerText = readFileSync(ledgerPath, 'utf8');

  let result;
  try {
    result = checkFindingLedgerGuard(capture, ledgerText);
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

  process.stdout.write('finding-ledger guard: PASS\n');
  return 0;
}

if (isCliMain()) {
  process.exit(runCli(process.argv));
}
