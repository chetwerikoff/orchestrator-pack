/**
 * Shared `runtime` field interpretation for ao status session rows (Issue #250).
 * Vitest: scripts/session-runtime-liveness.test.ts
 *
 * Governs only the missing-vs-present `runtime` rule. Role-specific session
 * status disqualifiers stay in each consumer (worker vs orchestrator launch).
 */

/** Affirmative live value when AO emits `runtime` (forward compatibility). */
export const AFFIRMATIVE_LIVE_RUNTIME = 'alive';

/** Terminal process-death values documented in capture-backed references. */
export const TERMINAL_RUNTIME_VALUES = new Set(['exited', 'process_missing']);

/**
 * @param {unknown} session
 */
export function hasRuntimeField(session) {
  if (!session || typeof session !== 'object') {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(session, 'runtime');
}

/**
 * @param {unknown} value
 */
export function normalizeRuntimeValue(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Shared runtime-field rule:
 * - absent: not disqualifying by runtime alone (fall back to status/head signals)
 * - affirmative `alive`: live
 * - any other present value (terminal death, empty, unknown): non-live (fail closed)
 *
 * @param {Record<string, unknown>} session
 */
export function isRuntimeFieldLive(session) {
  if (!hasRuntimeField(session)) {
    return true;
  }
  return normalizeRuntimeValue(session.runtime) === AFFIRMATIVE_LIVE_RUNTIME;
}

/** @deprecated Prefer isRuntimeFieldLive; kept for existing consumer imports. */
export function isRuntimeAlive(session) {
  return isRuntimeFieldLive(session);
}

/**
 * @param {Record<string, unknown>} session
 * @returns {'absent' | 'affirmative_live' | 'terminal_death' | 'present_non_live'}
 */
export function classifyRuntimeField(session) {
  if (!hasRuntimeField(session)) {
    return 'absent';
  }
  const runtime = normalizeRuntimeValue(session.runtime);
  if (runtime === AFFIRMATIVE_LIVE_RUNTIME) {
    return 'affirmative_live';
  }
  if (TERMINAL_RUNTIME_VALUES.has(runtime)) {
    return 'terminal_death';
  }
  return 'present_non_live';
}
