export type TerminalAction = 'SEND' | 'SUPPRESS';
export interface CiFailureEpisodeKey { repo: string; prNumber: number; headSha: string; redPeriod: string; targetId: string; targetGeneration: string; }
export interface CiFailureDecision { terminal_action: TerminalAction; reason: string; episode_key: CiFailureEpisodeKey; episode_key_digest: string; diagnostics: Record<string, unknown>; bound_reaction_event_id: string | null; intent_token_state: string; intent_token_id: string | null; audit: Record<string, unknown>; }
export declare const TERMINAL_ACTIONS: readonly TerminalAction[];
export declare const DEFAULT_HELPER_ERROR_LIMIT: number;
export declare const DEFAULT_MIN_RETENTION_MS: number;
export declare function assertTerminalAction(action: string): TerminalAction;
export declare function normalizeHeadSha(value: unknown): string;
export declare function normalizeEpisodeKey(episode: unknown): CiFailureEpisodeKey;
export declare function episodeKeyString(episode: unknown): string;
export declare function episodeKeyDigest(episode: unknown): string;
export declare function safeTokenName(episode: unknown): string;
export declare function eventEpisode(event: unknown): Partial<CiFailureEpisodeKey>;
export declare function bindReactionEvent(episode: unknown, events?: unknown[]): { status: string; eventId: string | null; event?: unknown };
export declare function bindSelfFixReport(episode: unknown, reports?: unknown[]): { status: string; reportId: string | null };
export declare function exactIntentTokenLookup(episode: unknown, tokens?: unknown[]): { status: string; tokenId: string | null };
export declare function deriveEpisodeFromCiSource(input: unknown): CiFailureEpisodeKey | null;
export declare function decideCiFailureNotification(input: unknown): CiFailureDecision;
export declare function buildAuditLine(input: unknown): Record<string, unknown>;
export declare function evaluateTargetApplySnapshot(input: unknown): { apply: boolean; reason: string; terminal_action: TerminalAction };
export declare function evaluateHelperErrorEscalation(input: unknown): Record<string, unknown>;
export declare function ensureStore(root: string): void;
export declare function claimIntentToken(input: unknown): Record<string, unknown>;
export declare function markObservableSendFailure(input: unknown): Record<string, unknown>;
export declare function appendAudit(input: unknown): Record<string, unknown>;
export declare function compactRecords(input: unknown): Record<string, unknown>;
export declare function scanFixtureSafety(value: unknown): { ok: boolean; findings: string[] };
export declare function buildAdoptionArtifact(input: unknown): Record<string, unknown>;
