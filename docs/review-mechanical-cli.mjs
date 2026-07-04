/**
 * Shared stdin/JSON CLI helpers for low-frequency review mechanical scripts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  assertTransportEnvelope,
  parseCompleteJsonText,
} from './mechanical-reconcile-bounds.mjs';

export function readStdinJson() {
  const inputFile = resolveMechanicalCliArg('--input-file');
  if (inputFile) {
    return parseCompleteJsonText(readFileSync(inputFile, 'utf8'));
  }
  const text = readFileSync(0, 'utf8').trim();
  if (!text) {
    return {};
  }
  return parseCompleteJsonText(text);
}

export function printJson(value) {
  const outputFile = resolveMechanicalCliArg('--output-file');
  const text = `${JSON.stringify(value)}\n`;
  assertTransportEnvelope(text);
  if (outputFile) {
    writeFileSync(outputFile, text, 'utf8');
    return;
  }
  process.stdout.write(text);
}

export function resolveMechanicalCliArg(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) {
    return '';
  }
  return String(process.argv[index + 1] ?? '').trim();
}

/**
 * Run an async stdin/JSON CLI main when this module is the entry script.
 * @param {string} scriptBasename
 * @param {() => Promise<unknown>} mainFn
 */
export function runAsyncStdinJsonCliMain(scriptBasename, mainFn) {
  const entry = process.argv[1] ?? '';
  const isCli =
    entry.endsWith(scriptBasename) || entry.endsWith(scriptBasename.replace(/\.mjs$/, '.js'));
  if (!isCli) return;
  mainFn()
    .then((result) => {
      printJson(result);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}

/**
 * @param {unknown} value
 */
export function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/**
 * @param {unknown} value
 */
export function toArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Scan argv tokens from cursor for force flags and the first non-flag target.
 * @param {string[]} list
 * @param {number} startIndex
 * @param {readonly string[]} forceTokens
 */
export function scanArgvForceTarget(list, startIndex, forceTokens) {
  let force = false;
  let target = null;
  let cursor = startIndex;
  while (cursor < list.length) {
    const token = list[cursor];
    if (forceTokens.includes(token)) {
      force = true;
      cursor += 1;
      continue;
    }
    if (!token.startsWith('-')) {
      target = token;
      break;
    }
    cursor += 1;
  }
  return { force, target };
}

/**
 * @param {string} scriptBasename
 * @param {(subcommand: string, payload: unknown) => unknown} handleCliSubcommand
 */
export function runAsyncStdinJsonSubcommandCli(scriptBasename, handleCliSubcommand) {
  runAsyncStdinJsonCliMain(scriptBasename, async () => {
    const subcommand = process.argv[2] ?? '';
    const payload = await readStdinJson();
    return handleCliSubcommand(subcommand, payload ?? {});
  });
}

/**
 * @param {string} scriptBasename e.g. review-trigger-reconcile.mjs
 * @param {Record<string, () => unknown>} handlers
 */
/**
 * @param {object} input
 * @param {number} input.nowMs
 * @param {number | undefined} input.lastTickMs
 * @param {number} [input.intervalMs]
 * @param {number} input.defaultIntervalMs
 */
export function evaluateMechanicalTickInterval({
  nowMs,
  lastTickMs,
  intervalMs,
  defaultIntervalMs,
}) {
  const interval = Math.max(1, Number(intervalMs) || defaultIntervalMs);
  if (!lastTickMs || lastTickMs <= 0) {
    return { ok: true, intervalMs: interval };
  }
  if (nowMs - lastTickMs >= interval) {
    return { ok: true, intervalMs: interval };
  }
  return { ok: false, reason: 'interval_not_elapsed', intervalMs: interval };
}

/**
 * @param {unknown} value
 * @param {number} defaultValue
 * @param {number} [min]
 */
export function resolveBoundedInt(value, defaultValue, min = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  return Math.max(min, parsed);
}

/** Spawn / claim-pr / kill forbidden on all mechanical reconcile entrypoints. */
export const MECHANICAL_FORBIDDEN_SPAWN_CLAIM_KILL = [
  /\bao\s+spawn\b/i,
  /--claim-pr\b/i,
  /\bao\s+session\s+kill\b/i,
];

/** Review-trigger / delivery-confirm paths also forbid worker ao send. */
export const MECHANICAL_FORBIDDEN_REVIEW_MECHANICAL = [
  ...MECHANICAL_FORBIDDEN_SPAWN_CLAIM_KILL,
  /\bao\s+send\b/i,
];

/**
 * @param {string[]} commandLines
 * @param {readonly RegExp[]} patterns
 */
export function findForbiddenCommandPatterns(commandLines, patterns) {
  /** @type {Array<{ command: string, pattern: string }>} */
  const violations = [];
  for (const command of commandLines ?? []) {
    const line = String(command ?? '');
    for (const pattern of patterns) {
      if (pattern.test(line)) {
        violations.push({ command: line, pattern: pattern.source });
      }
    }
  }
  return violations;
}

export function runStdinJsonCli(scriptBasename, handlers) {
  const isCli =
    process.argv[1] &&
    (process.argv[1].endsWith(scriptBasename) ||
      process.argv[1].endsWith(scriptBasename.replace(/\.mjs$/, '.js')));

  if (!isCli) {
    return;
  }

  const sub = process.argv[2];
  const handler = handlers[sub];
  if (!handler) {
    console.error(`Usage: node ${scriptBasename} <${Object.keys(handlers).join('|')}>`);
    process.exit(2);
  }

  printJson(handler());
  process.exit(0);
}
