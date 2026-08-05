export interface CrashBackoffPolicy {
  readonly rapidExitThresholdMs: number;
  readonly maxRapidExitsBeforeBackoff: number;
  readonly terminalRapidExits: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
}

export interface CrashBackoffState {
  readonly rapidExits: number;
  readonly backoffUntilMs: number;
  readonly lastExitMs: number;
  readonly terminal: boolean;
  readonly terminalReason: string | null;
}

export interface CrashBackoffDecision extends CrashBackoffState {
  readonly restartAllowed: boolean;
  readonly reason: 'restart_allowed' | 'backoff' | 'terminal';
  readonly waitMs: number;
}

function positiveInteger(value: string | undefined, fallback: number, minimum = 1): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

export function crashBackoffPolicyFromEnv(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): CrashBackoffPolicy {
  return {
    rapidExitThresholdMs: positiveInteger(env.OPK_SUPERVISOR_CRASH_RAPID_EXIT_THRESHOLD_MS, 5_000, 1_000),
    maxRapidExitsBeforeBackoff: positiveInteger(env.OPK_SUPERVISOR_CRASH_MAX_RAPID_EXITS, 3),
    terminalRapidExits: positiveInteger(env.OPK_SUPERVISOR_CRASH_TERMINAL_RAPID_EXITS, 12, 2),
    baseBackoffMs: positiveInteger(env.OPK_SUPERVISOR_CRASH_BASE_BACKOFF_MS, 30_000),
    maxBackoffMs: positiveInteger(env.OPK_SUPERVISOR_CRASH_MAX_BACKOFF_MS, 600_000),
  };
}

export const EMPTY_CRASH_BACKOFF_STATE: CrashBackoffState = Object.freeze({
  rapidExits: 0,
  backoffUntilMs: 0,
  lastExitMs: 0,
  terminal: false,
  terminalReason: null,
});

export function isRapidExit(input: {
  readonly startedAtMs: number;
  readonly exitedAtMs: number;
  readonly policy: CrashBackoffPolicy;
  readonly progressObserved?: boolean;
}): boolean {
  // A successful one-shot scheduler tick is progress, not a crash, even when it
  // completes faster than the crash threshold.
  if (input.progressObserved === true) return false;
  if (input.startedAtMs <= 0 || input.exitedAtMs <= input.startedAtMs) return true;
  if (input.progressObserved === false) return true;
  return input.exitedAtMs - input.startedAtMs < input.policy.rapidExitThresholdMs;
}

export function crashBackoffDurationMs(
  rapidExits: number,
  policy: CrashBackoffPolicy,
): number {
  if (rapidExits < policy.maxRapidExitsBeforeBackoff) return 0;
  const exponent = Math.min(10, rapidExits - policy.maxRapidExitsBeforeBackoff);
  return Math.min(policy.maxBackoffMs, policy.baseBackoffMs * (2 ** exponent));
}

/**
 * Pure crash-loop transition. It never probes AO or another daemon and never
 * schedules retries. The caller owns persistence and may explicitly rearm a
 * terminal state after an independently verified healthy replacement.
 */
export function recordChildExit(input: {
  readonly previous?: CrashBackoffState;
  readonly startedAtMs: number;
  readonly exitedAtMs: number;
  readonly progressObserved?: boolean;
  readonly policy?: CrashBackoffPolicy;
}): CrashBackoffDecision {
  const previous = input.previous ?? EMPTY_CRASH_BACKOFF_STATE;
  const policy = input.policy ?? crashBackoffPolicyFromEnv();
  if (previous.terminal) {
    return { ...previous, restartAllowed: false, reason: 'terminal', waitMs: 0 };
  }
  const rapid = isRapidExit({
    startedAtMs: input.startedAtMs,
    exitedAtMs: input.exitedAtMs,
    progressObserved: input.progressObserved,
    policy,
  });
  const rapidExits = rapid ? previous.rapidExits + 1 : 0;
  if (rapidExits >= policy.terminalRapidExits) {
    const terminalReason = `crash_loop:${rapidExits}_rapid_exits`;
    return {
      rapidExits,
      backoffUntilMs: 0,
      lastExitMs: input.exitedAtMs,
      terminal: true,
      terminalReason,
      restartAllowed: false,
      reason: 'terminal',
      waitMs: 0,
    };
  }
  const waitMs = crashBackoffDurationMs(rapidExits, policy);
  return {
    rapidExits,
    backoffUntilMs: waitMs > 0 ? input.exitedAtMs + waitMs : 0,
    lastExitMs: input.exitedAtMs,
    terminal: false,
    terminalReason: null,
    restartAllowed: waitMs === 0,
    reason: waitMs === 0 ? 'restart_allowed' : 'backoff',
    waitMs,
  };
}

export function restartDecisionAt(
  state: CrashBackoffState,
  nowMs: number,
): CrashBackoffDecision {
  if (state.terminal) return { ...state, restartAllowed: false, reason: 'terminal', waitMs: 0 };
  const waitMs = Math.max(0, state.backoffUntilMs - nowMs);
  return {
    ...state,
    restartAllowed: waitMs === 0,
    reason: waitMs === 0 ? 'restart_allowed' : 'backoff',
    waitMs,
  };
}

/** Explicit degraded rearm. No implicit daemon-health parsing or retry loop. */
export function rearmTerminalCrashState(input: {
  readonly state: CrashBackoffState;
  readonly replacementHealthy: boolean;
}): CrashBackoffState {
  if (!input.state.terminal || !input.replacementHealthy) return input.state;
  return EMPTY_CRASH_BACKOFF_STATE;
}
