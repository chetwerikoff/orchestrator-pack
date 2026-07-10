export declare const REVIEW_DELIVERY_LIFECYCLE_SCHEMA_VERSION: number;
export declare const DEFAULT_TERMINAL_RETENTION_MS: number;
export declare const ENV_TERMINAL_RETENTION_DAYS: string;

export declare const LIFECYCLE_STARTED: string;
export declare const LIFECYCLE_VERDICT_RECORDED: string;
export declare const LIFECYCLE_DELIVERY_CLAIMED: string;
export declare const LIFECYCLE_DELIVERY_ATTEMPTED: string;
export declare const TERMINAL_DELIVERED: string;
export declare const TERMINAL_ESCALATED: string;
export declare const TERMINAL_SUPERSEDED: string;

export declare function hashReviewFindings(findings: unknown): string;

export declare function buildDeterministicDeliveryKey(input: {
  prNumber?: number;
  headSha?: string;
  verdictSource?: string;
  findingsHash?: string;
}): string | null;

export declare function parseDeterministicDeliveryKey(
  key: string,
): {
  prNumber: number;
  headSha: string;
  verdictSource: string;
  findingsHash: string;
} | null;

export declare function findSameHeadJournalConflict(
  journal: Record<string, unknown>,
  incomingKey: string,
): Record<string, unknown> | null;

export declare function buildDeterministicDeliveryId(
  sessionId: string,
  deterministicKey: string,
): string | null;

export declare function resolveTerminalRetentionMs(
  env?: Record<string, string | undefined>,
): number;

export declare function normalizeLifecycleStore(store: unknown): {
  schemaVersion: number;
  lastUpdatedMs: number;
  entries: Record<string, Record<string, unknown>>;
};

export declare function readLifecycleStore(path: string): ReturnType<typeof normalizeLifecycleStore>;

export declare function compactLifecycleStore(
  store: ReturnType<typeof normalizeLifecycleStore>,
  options?: { nowMs?: number; retentionMs?: number },
): { store: ReturnType<typeof normalizeLifecycleStore>; evicted: number };

export declare function writeLifecycleStore(
  path: string,
  store: ReturnType<typeof normalizeLifecycleStore>,
  options?: { nowMs?: number; retentionMs?: number },
): ReturnType<typeof normalizeLifecycleStore>;

export declare function isLifecycleTerminal(entry: Record<string, unknown> | null | undefined): boolean;

export declare function canResumeDeliveryFromLifecycle(
  entry: Record<string, unknown> | null | undefined,
): boolean;

export declare function isVerdictSnapshotLost(
  entry: Record<string, unknown> | null | undefined,
): boolean;

export declare function canEvictLifecycleEntry(input: {
  entry: Record<string, unknown>;
  prActionable?: boolean;
  nowMs?: number;
  terminalRetentionMs?: number;
}): { ok: boolean; reason?: string };

export declare function upsertLifecycleEntry(
  store: ReturnType<typeof normalizeLifecycleStore>,
  deliveryKey: string,
  patch: Record<string, unknown>,
  nowMs?: number,
):
  | { ok: false; reason: string; store: ReturnType<typeof normalizeLifecycleStore> }
  | {
      ok: true;
      store: ReturnType<typeof normalizeLifecycleStore>;
      entry: Record<string, unknown>;
    };

export declare function getLifecycleEntry(
  store: ReturnType<typeof normalizeLifecycleStore>,
  deliveryKey: string,
): Record<string, unknown> | null;

export declare function findJournalEntryByDeterministicKey(
  journal: Record<string, unknown>,
  deterministicKey: string,
): Record<string, unknown> | null;

export declare function evaluateDeterministicJournalAdmission(
  journal: Record<string, unknown>,
  incoming: { deterministicKey?: string; findingsHash?: string },
): {
  ok: boolean;
  action: 'admit' | 'no_op_terminal' | 'resume' | 'supersede' | 'escalate' | 'escalate_supersede';
  deliveryId?: string;
  priorDeliveryId?: string;
  reason?: string;
};
