/**
 * Terminal mux Device-Attributes flood detection from ao events (Issue #173).
 * Vitest: scripts/terminal-flood-detect.test.ts
 *
 * Observable signature: session-local, paired ui.terminal_connected +
 * ui.terminal_disconnected cycling sustained over a bounded window — no tmux pane scraping.
 */
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';

export const TERMINAL_MUX_CONNECTED = 'ui.terminal_connected';
export const TERMINAL_MUX_DISCONNECTED = 'ui.terminal_disconnected';

/** Events without a session id are global mux WebSocket churn (not session-local flood). */
export const GLOBAL_MUX_SESSION_KEY = '__global__';

/** Default sliding window for sustained paired flapping (60 seconds). */
export const DEFAULT_WINDOW_MS = 60_000;

/** Default minimum connect/disconnect pairs in the window (~1 Hz for six seconds). */
export const DEFAULT_MIN_PAIRED_CYCLES = 6;

/** Flap must span at least this long within the window (not a single refresh/blip). */
export const DEFAULT_MIN_SPAN_MS = 30_000;

/** Disconnect events with more subscribers are treated as benign multi-viewer churn. */
export const DEFAULT_MAX_SUBSCRIBER_COUNT = 1;

export const FLOOD_SIGNATURE_NAME = 'terminal_mux_paired_flap';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * @param {unknown} payload
 * @returns {Array<Record<string, unknown>>}
 */
export function normalizeAoEvents(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (isRecord(payload) && Array.isArray(payload.events)) {
    return payload.events;
  }
  return [];
}

/**
 * @param {Record<string, unknown>} event
 */
export function resolveEventSessionId(event) {
  const top = nonEmptyString(event.sessionId);
  if (top) {
    return top;
  }
  const data = event.data;
  if (!isRecord(data)) {
    return null;
  }
  return (
    nonEmptyString(data.sessionId) ??
    nonEmptyString(data.terminalSessionId) ??
    nonEmptyString(data.targetSessionId) ??
    null
  );
}

/**
 * @param {Record<string, unknown>} event
 */
export function getEventTimestampMs(event) {
  if (typeof event.tsEpoch === 'number' && Number.isFinite(event.tsEpoch)) {
    return event.tsEpoch;
  }
  const iso = nonEmptyString(event.ts);
  if (!iso) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {Record<string, unknown>} event
 */
export function isTerminalMuxEvent(event) {
  const kind = nonEmptyString(event.kind) ?? nonEmptyString(event.type);
  return kind === TERMINAL_MUX_CONNECTED || kind === TERMINAL_MUX_DISCONNECTED;
}

/**
 * @param {Record<string, unknown>} event
 */
export function isTerminalMuxConnected(event) {
  const kind = nonEmptyString(event.kind) ?? nonEmptyString(event.type);
  return kind === TERMINAL_MUX_CONNECTED;
}

/**
 * @param {Record<string, unknown>} event
 */
export function isTerminalMuxDisconnected(event) {
  const kind = nonEmptyString(event.kind) ?? nonEmptyString(event.type);
  return kind === TERMINAL_MUX_DISCONNECTED;
}

/**
 * @param {Record<string, unknown>} event
 */
export function getDisconnectSubscriberCount(event) {
  if (!isTerminalMuxDisconnected(event)) {
    return null;
  }
  const data = event.data;
  if (!isRecord(data)) {
    return null;
  }
  const count = data.subscriberCount;
  return typeof count === 'number' && Number.isFinite(count) ? count : null;
}

/**
 * @param {object} input
 * @param {Array<Record<string, unknown>>} input.events
 * @param {number} input.nowMs
 * @param {number} [input.windowMs]
 * @param {number} [input.minPairedCycles]
 * @param {number} [input.minSpanMs]
 * @param {number} [input.maxSubscriberCount]
 * @param {string} [input.sessionIdFilter]
 */
export function detectTerminalMuxFlood({
  events,
  nowMs,
  windowMs = DEFAULT_WINDOW_MS,
  minPairedCycles = DEFAULT_MIN_PAIRED_CYCLES,
  minSpanMs = DEFAULT_MIN_SPAN_MS,
  maxSubscriberCount = DEFAULT_MAX_SUBSCRIBER_COUNT,
  sessionIdFilter,
}) {
  const windowStart = nowMs - windowMs;
  const muxEvents = normalizeAoEvents(events)
    .filter(isTerminalMuxEvent)
    .map((event) => {
      const tsMs = getEventTimestampMs(event);
      return tsMs === null ? null : { event, tsMs };
    })
    .filter((row) => row !== null && row.tsMs >= windowStart && row.tsMs <= nowMs);

  /** @type {Map<string, { connected: number, disconnected: number, rows: Array<{ event: Record<string, unknown>, tsMs: number }> }>} */
  const groups = new Map();

  for (const row of muxEvents) {
    const sessionKey = resolveEventSessionId(row.event) ?? GLOBAL_MUX_SESSION_KEY;
    if (!groups.has(sessionKey)) {
      groups.set(sessionKey, { connected: 0, disconnected: 0, rows: [] });
    }
    const group = groups.get(sessionKey);
    group.rows.push(row);
    if (isTerminalMuxConnected(row.event)) {
      group.connected += 1;
    }
    if (isTerminalMuxDisconnected(row.event)) {
      group.disconnected += 1;
    }
  }

  /** @type {Array<Record<string, unknown>>} */
  const sessions = [];

  for (const [sessionKey, group] of groups.entries()) {
    const pairedCycles = Math.min(group.connected, group.disconnected);
    const timestamps = group.rows.map((row) => row.tsMs).sort((a, b) => a - b);
    const spanMs =
      timestamps.length >= 2 ? timestamps[timestamps.length - 1] - timestamps[0] : 0;

    const disconnectSubscribers = group.rows
      .map((row) => getDisconnectSubscriberCount(row.event))
      .filter((count) => count !== null);
    const multiViewerDisconnects = disconnectSubscribers.filter(
      (count) => count > maxSubscriberCount,
    ).length;
    const benignMultiViewer =
      disconnectSubscribers.length > 0 &&
      multiViewerDisconnects / disconnectSubscribers.length > 0.5;

    const sessionLocal = sessionKey !== GLOBAL_MUX_SESSION_KEY;
    const sustained =
      pairedCycles >= minPairedCycles && spanMs >= minSpanMs && !benignMultiViewer;
    const flagged = sessionLocal && sustained;

    const evidence = {
      signature: FLOOD_SIGNATURE_NAME,
      windowMs,
      minPairedCycles,
      minSpanMs,
      connectedCount: group.connected,
      disconnectedCount: group.disconnected,
      pairedCycles,
      spanMs,
      benignMultiViewer,
      sessionLocal,
      firstTsMs: timestamps[0] ?? null,
      lastTsMs: timestamps[timestamps.length - 1] ?? null,
    };

    sessions.push({
      sessionId: sessionLocal ? sessionKey : null,
      sessionKey,
      flagged,
      sustained,
      globalMuxChurn: !sessionLocal && sustained,
      evidence,
    });
  }

  sessions.sort((a, b) => {
    if (a.flagged !== b.flagged) {
      return a.flagged ? -1 : 1;
    }
    return String(a.sessionKey).localeCompare(String(b.sessionKey));
  });

  const filter = nonEmptyString(sessionIdFilter);
  const scoped = filter
    ? sessions.filter((row) => row.sessionKey === filter)
    : sessions;

  const flaggedSessions = scoped.filter((row) => row.flagged);
  const globalMuxChurn = sessions.some((row) => row.globalMuxChurn);

  return {
    signature: flaggedSessions.length > 0 ? FLOOD_SIGNATURE_NAME : null,
    flagged: flaggedSessions.length > 0,
    sessionIdFilter: filter ?? null,
    windowMs,
    minPairedCycles,
    minSpanMs,
    globalMuxChurn,
    sessions: scoped,
    flaggedSessions,
  };
}

/**
 * @param {object} input
 */
export function resolveFloodDetectConfig(input = {}) {
  return {
    windowMs: Math.max(1, Number(input.windowMs) || DEFAULT_WINDOW_MS),
    minPairedCycles: Math.max(1, Number(input.minPairedCycles) || DEFAULT_MIN_PAIRED_CYCLES),
    minSpanMs: Math.max(1, Number(input.minSpanMs) || DEFAULT_MIN_SPAN_MS),
    maxSubscriberCount:
      Number(input.maxSubscriberCount) >= 0
        ? Number(input.maxSubscriberCount)
        : DEFAULT_MAX_SUBSCRIBER_COUNT,
    sessionIdFilter: nonEmptyString(input.sessionId) ?? nonEmptyString(input.sessionIdFilter),
  };
}

runStdinJsonCli('terminal-flood-detect.mjs', {
  detect() {
    const payload = readStdinJson();
    const config = resolveFloodDetectConfig(payload.config ?? payload);
    const nowMs = Number(payload.nowMs) || Date.now();
    return detectTerminalMuxFlood({
      events: normalizeAoEvents(payload.events ?? payload),
      nowMs,
      ...config,
    });
  },
});
