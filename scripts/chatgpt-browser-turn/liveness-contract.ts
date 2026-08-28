export const OBSERVATION_HEARTBEAT_SCHEMA = 'observation-heartbeat/v1' as const;

export const BROWSER_TURN_LIVENESS_PHASES = [
  'admitted_pre_send',
  'composer_dispatch',
  'post_send_observation',
] as const;

export type BrowserTurnLivenessPhase = typeof BROWSER_TURN_LIVENESS_PHASES[number];

export interface ObservationHeartbeatV1 {
  readonly schema: typeof OBSERVATION_HEARTBEAT_SCHEMA;
  readonly phase: BrowserTurnLivenessPhase;
  readonly poll_count: number;
  readonly observation_state: string;
  readonly stable_reads: number;
  readonly completion_ready: boolean;
  readonly last_reply_length?: number;
  readonly last_reply_sha256_head?: string;
}

export interface BrowserTurnLivenessTiming {
  readonly startupAllowanceMs: number;
  readonly maxHealthyHeartbeatGapMs: number;
  readonly liveChildIdleWindowMs: number;
  readonly schedulerIntervalMs: number;
}

const DEFAULT_STARTUP_ALLOWANCE_MS = 120_000;
const DEFAULT_MAX_HEALTHY_HEARTBEAT_GAP_MS = 15_000;
const DEFAULT_LIVE_CHILD_IDLE_WINDOW_MS = 45_000;

const STARTUP_ENV = 'OPK_BROWSER_TURN_STARTUP_ALLOWANCE_MS';
const HEARTBEAT_GAP_ENV = 'OPK_BROWSER_TURN_MAX_HEALTHY_HEARTBEAT_GAP_MS';
const IDLE_WINDOW_ENV = 'OPK_BROWSER_TURN_LIVE_CHILD_IDLE_WINDOW_MS';

function positiveIntegerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`browser_turn_liveness_contract_invalid:${name}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`browser_turn_liveness_contract_invalid:${name}`);
  }
  return parsed;
}

export function validateBrowserTurnLivenessTiming(
  timing: Omit<BrowserTurnLivenessTiming, 'schedulerIntervalMs'>,
): BrowserTurnLivenessTiming {
  const { startupAllowanceMs, maxHealthyHeartbeatGapMs, liveChildIdleWindowMs } = timing;
  for (const [name, value] of Object.entries({
    startupAllowanceMs,
    maxHealthyHeartbeatGapMs,
    liveChildIdleWindowMs,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`browser_turn_liveness_contract_invalid:${name}`);
    }
  }
  if (maxHealthyHeartbeatGapMs >= liveChildIdleWindowMs) {
    throw new Error('browser_turn_liveness_contract_invalid:heartbeat_gap_not_inside_idle_window');
  }
  return {
    startupAllowanceMs,
    maxHealthyHeartbeatGapMs,
    liveChildIdleWindowMs,
    schedulerIntervalMs: Math.max(1, Math.floor(maxHealthyHeartbeatGapMs / 2)),
  };
}

export function resolveBrowserTurnLivenessTiming(
  env: NodeJS.ProcessEnv = process.env,
): BrowserTurnLivenessTiming {
  return validateBrowserTurnLivenessTiming({
    startupAllowanceMs: positiveIntegerEnv(env, STARTUP_ENV, DEFAULT_STARTUP_ALLOWANCE_MS),
    maxHealthyHeartbeatGapMs: positiveIntegerEnv(
      env,
      HEARTBEAT_GAP_ENV,
      DEFAULT_MAX_HEALTHY_HEARTBEAT_GAP_MS,
    ),
    liveChildIdleWindowMs: positiveIntegerEnv(
      env,
      IDLE_WINDOW_ENV,
      DEFAULT_LIVE_CHILD_IDLE_WINDOW_MS,
    ),
  });
}

function isLivenessPhase(value: unknown): value is BrowserTurnLivenessPhase {
  return typeof value === 'string'
    && (BROWSER_TURN_LIVENESS_PHASES as readonly string[]).includes(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function parseObservationHeartbeatLine(line: string): ObservationHeartbeatV1 | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const body = JSON.parse(trimmed) as Record<string, unknown>;
    const phase = body.phase;
    const pollCount = body.poll_count;
    const stableReads = body.stable_reads;
    const completionReady = body.completion_ready;
    const observationState = body.observation_state;
    const lastReplyLength = body.last_reply_length;
    const lastReplySha256Head = body.last_reply_sha256_head;
    if (body.schema !== OBSERVATION_HEARTBEAT_SCHEMA) return null;
    if (!isLivenessPhase(phase)) return null;
    if (!isNonNegativeSafeInteger(pollCount)) return null;
    if (!isNonNegativeSafeInteger(stableReads)) return null;
    if (typeof completionReady !== 'boolean') return null;
    if (typeof observationState !== 'string' || observationState.length > 96) return null;
    if (lastReplyLength !== undefined && !isNonNegativeSafeInteger(lastReplyLength)) return null;
    if (
      lastReplySha256Head !== undefined
      && (typeof lastReplySha256Head !== 'string' || lastReplySha256Head.length > 32)
    ) return null;
    return {
      schema: OBSERVATION_HEARTBEAT_SCHEMA,
      phase,
      poll_count: pollCount,
      observation_state: observationState,
      stable_reads: stableReads,
      completion_ready: completionReady,
      ...(typeof lastReplyLength === 'number' ? { last_reply_length: lastReplyLength } : {}),
      ...(typeof lastReplySha256Head === 'string'
        ? { last_reply_sha256_head: lastReplySha256Head }
        : {}),
    };
  } catch {
    return null;
  }
}

export interface TurnScopedHeartbeatScheduler {
  pulse(): void;
  dispose(): void;
}

export function startTurnScopedHeartbeatScheduler(input: {
  readonly timing: BrowserTurnLivenessTiming;
  readonly emit: () => void;
}): TurnScopedHeartbeatScheduler {
  const timing = validateBrowserTurnLivenessTiming(input.timing);
  let disposed = false;
  const pulse = (): void => {
    if (!disposed) input.emit();
  };

  pulse();
  const timer = setInterval(pulse, timing.schedulerIntervalMs);
  (timer as unknown as { unref?: () => void }).unref?.();

  return {
    pulse,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
    },
  };
}
