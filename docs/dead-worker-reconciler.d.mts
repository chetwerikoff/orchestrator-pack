export declare const DEAD_WORKER_RECONCILER_VERSION: string;
export declare const AUTONOMOUS_RESPAWN_POLICY_VERSION: string;
export declare const DEFAULT_DEAD_WORKER_INTERVAL_MS: number;
export declare const DEFAULT_DEAD_WORKER_MAX_ATTEMPTS: number;
export declare const DEFAULT_DEAD_WORKER_BACKOFF_MS: number;
export declare const DEFAULT_DEAD_WORKER_CONCURRENCY: number;
export declare const OPERATOR_SHUTDOWN_SUPPRESSION_MS: number;

export interface DeathEvidence {
  verdict: 'suppressed' | 'dead' | 'audit_only' | 'live_or_unknown';
  reason: string;
  event?: Record<string, unknown> | null;
  matchedEvents?: Array<Record<string, unknown>>;
}

export interface RecoveryRoute {
  ok: boolean;
  reason?: string;
  escalate?: boolean;
  spawnAction?: string;
  issueNumber?: number;
  prNumber?: number;
}

export interface DeadWorkerGateResult {
  ok: boolean;
  reason?: string;
  bounds?: {
    maxAttempts: number;
    backoffMs: number;
    concurrency: number;
  };
}

export interface DeadWorkerReconcileAction {
  key: string;
  type: string;
  outcome: string;
  reason: string;
  sessionId?: string;
  issueNumber?: number;
  prNumber?: number;
  branch?: string;
  worktree?: string;
  deathEventId?: string;
  deathTimestampMs?: number;
  classifierVersion?: string;
  attempt?: number;
  spawnAction?: string;
  evidence?: DeathEvidence;
  invoke?: {
    trigger: string;
    probedDeadEvidence: boolean;
    sessionId: string;
    worktreePath: string;
    spawnAction: string;
    issueNumber: number;
    prNumber: number;
  };
}

export interface PlanDeadWorkerReconcileInput {
  sessions?: Array<Record<string, unknown>>;
  aoEvents?: Array<Record<string, unknown>>;
  respawnPolicy?: Record<string, unknown>;
  recoveryChecks?: {
    workerRecoveryAvailable?: boolean;
    branchSafeRecoveryAvailable?: boolean;
  };
  effectiveRuntimePolicy?: string;
  bounds?: {
    maxAttempts?: number;
    backoffMs?: number;
    concurrency?: number;
  };
  tracking?: Record<string, unknown>;
  nowMs?: number;
  issueOnlyPrAmbiguous?: boolean;
  prLookupFailed?: boolean;
}

export declare function validateAutonomousRespawnPolicy(
  policy: unknown,
): { ok: boolean; reason?: string; policy?: { allowReconcileDeadWorkerRespawn: boolean } };

export declare function loadAutonomousRespawnPolicy(
  packRoot: string,
): { ok: boolean; reason?: string; policy?: { allowReconcileDeadWorkerRespawn: boolean } };

export declare function classifyWorkerDeathEvidence(
  session: Record<string, unknown>,
  aoEvents?: Array<Record<string, unknown>>,
  nowMs?: number,
): DeathEvidence;

export declare function buildDeadWorkerReconcileKey(candidate: Record<string, unknown>): string;

export declare function resolveRecoveryRoute(
  session: Record<string, unknown>,
  evidence: DeathEvidence,
  input?: Record<string, unknown>,
): RecoveryRoute;

export declare function validateDeadWorkerGates(
  input?: Record<string, unknown>,
): DeadWorkerGateResult;

export declare function resolveDeadWorkerBounds(
  policy: unknown,
  overrideBounds?: Record<string, unknown> | null,
): DeadWorkerGateResult;

export declare function evaluateDeadWorkerRuntimeAdoption(
  input?: { orchestratorRules?: string },
): {
  ok: boolean;
  effectiveRuntimePolicy: string;
  reason?: string;
  missing?: string[];
};

export declare function planDeadWorkerReconcile(
  input?: PlanDeadWorkerReconcileInput,
): { actions: DeadWorkerReconcileAction[]; gates: DeadWorkerGateResult };

export declare function commitDeadWorkerAction(
  tracking?: Record<string, unknown>,
  action?: Record<string, unknown>,
  nowMs?: number,
): Record<string, unknown>;

export declare function evaluateDeadWorkerInterval(input: {
  nowMs: number;
  lastTickMs?: number;
  intervalMs?: number;
}): { ok: boolean; reason?: string; intervalMs: number };

export declare function probeRecoveryChecks(packRoot: string): {
  workerRecoveryAvailable: boolean;
  branchSafeRecoveryAvailable: boolean;
};
