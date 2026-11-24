// Issue #2888: a pre-send contention failure is retried by the turn itself,
// after a pause inside this turn. No lock, slot, counter or wait on another
// turn: the delay is local, and the random spread keeps turns that failed
// together from retrying at the same moment.

/** Minimum pause before a turn-local retry after pre-send contention. */
export const PRE_SEND_PAUSED_RETRY_MIN_MS = 10_000;
/** Upper bound of the random spread added to the minimum pause. */
export const PRE_SEND_PAUSED_RETRY_SPREAD_MS = 5_000;

/** Pre-send failures that mean "the shared browser is busy", not "this tab is wrong". */
export const PRE_SEND_CONTENTION_CAUSES: ReadonlySet<string> = new Set([
  'browser_operation_timeout:locator_count',
  'fresh_send_actionability_unknown_or_busy',
  'browser_operation_timeout:connect_over_cdp',
]);

export function isPreSendContentionCause(cause: string | undefined): boolean {
  return typeof cause === 'string' && PRE_SEND_CONTENTION_CAUSES.has(cause);
}

export function preSendPausedRetryDelayMs(random: () => number = Math.random): number {
  const sample = random();
  const unit = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 1) : 0;
  return PRE_SEND_PAUSED_RETRY_MIN_MS + Math.floor(unit * PRE_SEND_PAUSED_RETRY_SPREAD_MS);
}
