/**
 * Shared stdin/JSON CLI helpers for low-frequency review mechanical scripts.
 */
import { readFileSync } from 'node:fs';

export function readStdinJson() {
  const text = readFileSync(0, 'utf8').trim();
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
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
