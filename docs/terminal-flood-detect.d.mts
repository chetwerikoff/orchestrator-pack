export declare const TERMINAL_MUX_CONNECTED: string;
export declare const TERMINAL_MUX_DISCONNECTED: string;
export declare const GLOBAL_MUX_SESSION_KEY: string;
export declare const DEFAULT_WINDOW_MS: number;
export declare const DEFAULT_MIN_PAIRED_CYCLES: number;
export declare const DEFAULT_MIN_SPAN_MS: number;
export declare const DEFAULT_MAX_SUBSCRIBER_COUNT: number;
export declare const FLOOD_SIGNATURE_NAME: string;

export interface TerminalMuxEvidence {
  signature: string;
  windowMs: number;
  minPairedCycles: number;
  minSpanMs: number;
  connectedCount: number;
  disconnectedCount: number;
  pairedCycles: number;
  spanMs: number;
  benignMultiViewer: boolean;
  sessionLocal: boolean;
  firstTsMs: number | null;
  lastTsMs: number | null;
}

export interface TerminalMuxSessionResult {
  sessionId: string | null;
  sessionKey: string;
  flagged: boolean;
  sustained: boolean;
  globalMuxChurn: boolean;
  evidence: TerminalMuxEvidence;
}

export interface TerminalMuxFloodResult {
  signature: string | null;
  flagged: boolean;
  sessionIdFilter: string | null;
  windowMs: number;
  minPairedCycles: number;
  minSpanMs: number;
  globalMuxChurn: boolean;
  sessions: TerminalMuxSessionResult[];
  flaggedSessions: TerminalMuxSessionResult[];
}

export declare function normalizeAoEvents(payload: unknown): Array<Record<string, unknown>>;
export declare function resolveEventSessionId(event: Record<string, unknown>): string | null;
export declare function getEventTimestampMs(event: Record<string, unknown>): number | null;
export declare function isTerminalMuxEvent(event: Record<string, unknown>): boolean;
export declare function isTerminalMuxConnected(event: Record<string, unknown>): boolean;
export declare function isTerminalMuxDisconnected(event: Record<string, unknown>): boolean;
export declare function getDisconnectSubscriberCount(event: Record<string, unknown>): number | null;

export declare function detectTerminalMuxFlood(input: {
  events: Array<Record<string, unknown>> | unknown;
  nowMs: number;
  windowMs?: number;
  minPairedCycles?: number;
  minSpanMs?: number;
  maxSubscriberCount?: number;
  sessionIdFilter?: string;
}): TerminalMuxFloodResult;

export declare function resolveFloodDetectConfig(input?: Record<string, unknown>): {
  windowMs: number;
  minPairedCycles: number;
  minSpanMs: number;
  maxSubscriberCount: number;
  sessionIdFilter: string | undefined;
};
