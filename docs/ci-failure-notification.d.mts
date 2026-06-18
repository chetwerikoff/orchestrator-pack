export type TerminalAction = 'SEND' | 'SUPPRESS';

export interface CiFailureEpisodeKey {
  repo: string;
  prNumber: number;
  headSha: string;
  redPeriod: string;
  targetId: string;
  targetGeneration: string;
}

export interface CiFailureDecision {
  terminal_action?: TerminalAction;
  reason?: string;
  episode_key?: CiFailureEpisodeKey;
  episode_key_digest?: string;
  diagnostics?: Record<string, unknown>;
  bound_reaction_event_id?: string | null;
  intent_token_state?: string;
  intent_token_id?: string | null;
  read_source?: string | null;
  audit?: { phase?: string; reason?: string; diagnostic?: Record<string, unknown>; [key: string]: unknown };
  hard_failure?: boolean;
  reevaluable?: boolean;
  diagnostic?: { error_kind?: string; [key: string]: unknown };
}

export declare const TERMINAL_ACTIONS: readonly TerminalAction[];
export declare const DEFAULT_HELPER_ERROR_LIMIT: number;
export declare const DEFAULT_MIN_RETENTION_MS: number;
export declare const DEFAULT_RECONCILE_INTERVAL_MS: number;
export declare const DEFAULT_MAX_ELIGIBLE_EVALUATION_AGE_MS: number;
export declare const DEFAULT_PENDING_EXPIRY_MS: number;
export declare const REPORT_STALE_BACKSTOP_MS: number;
export declare const TERMINAL_REASONS: readonly string[];
export declare const EPISODE_OUTBOX_STATES: readonly string[];
export declare const WORKER_STATE_REQUIRED_TOP: readonly string[];

export declare function assertTerminalAction(action: string): TerminalAction;
export declare function normalizeHeadSha(value: unknown): string;
export declare function normalizeEpisodeKey(episode: unknown): CiFailureEpisodeKey;
export declare function episodeKeyString(episode: unknown): string;
export declare function episodeKeyDigest(episode: unknown): string;
export declare function safeTokenName(episode: unknown): string;
export declare function safeEpisodeRecordName(episode: unknown): string;
export declare function eventEpisode(event: unknown): Partial<CiFailureEpisodeKey>;
export declare function deriveTargetGeneration(session: unknown): string;
export declare function findSessionByIdentifier(sessions: unknown, identifier: unknown): Record<string, unknown> | null;
export declare function validateWorkerStateInput(workerState: unknown): { ok: boolean; error?: string; code?: string; field?: string };
export declare function resolveConfig(input?: unknown): {
  reconcileIntervalMs?: number;
  maxEligibleEvaluationAgeMs?: number;
  pendingExpiryMs?: number;
  [key: string]: unknown;
};
export declare function evaluateSnapshotCoherence(input: unknown): Record<string, unknown>;
export declare function resolveLivePrOwner(input: unknown): Record<string, unknown>;
export declare function evaluateLiveWorkerSuppressor(input: unknown): Record<string, unknown>;
export declare function bindReactionEvent(episode: unknown, events?: unknown[], options?: unknown): { status: string; eventId: string | null; event?: unknown };
export declare function bindSelfFixReport(episode: unknown, reports?: unknown[]): { status: string; reportId: string | null };
export declare function exactIntentTokenLookup(episode: unknown, tokens?: unknown[], options?: unknown): { status: string; tokenId: string | null };

export declare function buildCiSourceFromRequiredChecks(checks?: unknown[], options?: unknown): Record<string, unknown>;
export declare function buildRedFailureFingerprint(checks?: unknown[], options?: unknown): string | null;
export declare function resolveRedPeriodAggregateId(input: unknown): string | null;
export declare function listIntentTokensFromStore(storeDir: string): unknown[];
export declare function planCiFailureReactionRecords(input: unknown): { records?: Array<{ episode: CiFailureEpisodeKey; ciSource?: Record<string, unknown> }> };
export declare function preSendCiRedRecheck(episode: unknown, fresh: unknown): { ok: boolean; reason: string };
export declare function deriveEpisodeFromCiSource(input: unknown): CiFailureEpisodeKey | null;
export declare function buildDiagnosticAudit(input: unknown): Record<string, unknown>;
export declare function mapReasonToTerminalAction(reason: string): TerminalAction;
export declare function mapTerminalReasonToAuditReason(reason: string): string;
export declare function evaluateEpisodeTerminal(input: unknown): Record<string, unknown>;
export declare function decideCiFailureNotification(input: unknown): CiFailureDecision;
export declare function buildTerminalAudit(input: unknown): Record<string, unknown>;
export declare function buildAuditLine(input: unknown): Record<string, unknown>;
export declare function buildRecordAudit(input: unknown): Record<string, unknown>;
export declare function evaluateTargetApplySnapshot(input: unknown): { apply: boolean; reason: string; terminal_action: TerminalAction };
export declare function evaluateHelperErrorEscalation(input: unknown): Record<string, unknown>;
export declare function ensureStore(root: string): void;
export declare function readEpisodeRecord(storeDir: string, episode: unknown): Record<string, unknown> | null;
export declare function writeEpisodeRecord(input: unknown): Record<string, unknown>;
export declare function recordPendingEpisode(input: unknown): {
  recorded?: boolean;
  audit?: { phase?: string; [key: string]: unknown };
  [key: string]: unknown;
};
export declare function isEvaluationEligible(record: unknown, nowMs?: number, options?: unknown): { eligible: boolean; reason?: string };
export declare function claimEpisodePreflight(input: unknown): Record<string, unknown>;
export declare function reserveSubmitIntent(input: unknown): Record<string, unknown>;
export declare function markSubmittedUnacked(input: unknown): Record<string, unknown>;
export declare function markSendDelivered(input: unknown): Record<string, unknown>;
export declare function releaseSubmitIntent(input: unknown): Record<string, unknown>;
export declare function terminalizeEpisode(input: unknown): Record<string, unknown>;
export declare function resolveSubmittedDelivery(input: unknown): Record<string, unknown>;
export declare function evaluatePreflightRevalidation(input: unknown): {
  action?: string;
  terminal?: { audit?: { reason?: string; [key: string]: unknown }; [key: string]: unknown };
  [key: string]: unknown;
};
export declare function scanExpiredPendingRecords(storeDir: string, nowMs?: number): Record<string, unknown>;
export declare function scanFreshnessSlaExceededPendingRecords(storeDir: string, nowMs?: number, config?: unknown): { exceeded: unknown[] };
export declare function expirePendingEpisode(input: unknown): {
  audit?: { reason?: string; diagnostic?: { backstop_handoff?: string; [key: string]: unknown }; [key: string]: unknown };
  [key: string]: unknown;
};
export declare function migrateLegacyEpisodeRecord(record: unknown): Record<string, unknown>;
export declare function interpretLegacyAuditLine(audit: unknown): Record<string, unknown>;
export declare function computeReconcileHealth(input: unknown): Record<string, unknown>;
export declare function planReconcileTick(input: unknown): {
  actions?: Array<{ type?: string; [key: string]: unknown }>;
  [key: string]: unknown;
};
export declare function claimIntentToken(input: unknown): Record<string, unknown>;
export declare function markObservableSendFailure(input: unknown): Record<string, unknown>;
export declare function appendAudit(input: unknown): Record<string, unknown>;
export declare function compactRecords(input: unknown): Record<string, unknown>;
export declare function scanFixtureSafety(value: unknown): { ok: boolean; findings: string[] };
export declare function validateInitGate(input: unknown): Record<string, unknown>;
export declare function buildAdoptionArtifact(input: unknown): Record<string, unknown>;
