export declare const DEAD_WORKER_RECONCILER_VERSION: string;
export declare const AUTONOMOUS_RESPAWN_POLICY_VERSION: string;
export declare const DEFAULT_DEAD_WORKER_INTERVAL_MS: number;
export declare const DEFAULT_DEAD_WORKER_MAX_ATTEMPTS: number;
export declare const DEFAULT_DEAD_WORKER_BACKOFF_MS: number;
export declare const DEFAULT_DEAD_WORKER_CONCURRENCY: number;
export declare const OPERATOR_SHUTDOWN_SUPPRESSION_MS: number;
export declare const DEFAULT_SHUTDOWN_SUPPRESSION_WINDOW_MS: number;

export interface DeathEvidence {
  verdict: 'suppressed' | 'dead' | 'audit_only' | 'live_or_unknown';
  reason: string;
  escalate?: boolean;
  event?: Record<string, unknown> | null;
  matchedEvents?: Array<Record<string, unknown>>;
  evidence?: Record<string, unknown>;
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
  escalate?: boolean;
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
  absentSessions?: Array<Record<string, unknown>>;
  livenessContext?: Record<string, unknown>;
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
  openPrs?: Array<{ number?: number; headRefName?: string; head?: string }>;
  terminalPrs?: Array<{ number?: number; headRefName?: string; head?: string; state?: string }>;
  issueOnlyPrAmbiguous?: boolean;
  prLookupFailed?: boolean;
}

export declare function parseAndClassifyDeadWorkerRecoveryOutput(rawOutput: unknown): {
  ok: boolean;
  deadWorkerOutcome: string;
  reason: string;
  recoveryOutcome?: string;
  spawn?: string;
};

export declare function classifyDeadWorkerRecoveryInvokeResult(result: unknown): {
  ok: boolean;
  deadWorkerOutcome: string;
  reason: string;
  recoveryOutcome?: string;
  spawn?: string;
};

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
  options?: { respawnPolicy?: Record<string, unknown> },
): DeathEvidence;

export declare function classifyWorkerLivenessEvidence(
  session: Record<string, unknown>,
  livenessContext?: Record<string, unknown>,
): DeathEvidence;

export declare function resolveShutdownSuppressionWindowMs(policy: unknown): number;

export declare function resolveAttemptLeaseTtlMs(
  bounds?: { maxAttempts?: number; backoffMs?: number; attemptLeaseTtlMs?: number },
): number;

export declare function expireStaleAttemptLeases(
  tracking?: Record<string, unknown>,
  bounds?: { maxAttempts?: number; backoffMs?: number; attemptLeaseTtlMs?: number },
  nowMs?: number,
): Record<string, unknown>;

export declare function buildDeadWorkerReconcileKey(candidate: Record<string, unknown>): string;

export declare function issueLinkedWorkerBranches(issueNumber: number): string[];

export declare const AO_WORKER_ITERATION_BRANCH_PATTERN: RegExp;

export declare function isAoWorkerIterationBranch(branch: unknown): boolean;

export declare function issueLinkedOpenPrs(
  issueNumber: number,
  openPrs?: Array<{ number?: number; headRefName?: string; head?: string }>,
  session?: Record<string, unknown> | null,
): Array<{ number?: number; headRefName?: string; head?: string }>;

export declare function isTerminalPrState(state: unknown): boolean;

export declare function issueLinkedTerminalPrs(
  issueNumber: number,
  terminalPrs?: Array<{ number?: number; headRefName?: string; head?: string; state?: string }>,
  session?: Record<string, unknown> | null,
): Array<{ number?: number; headRefName?: string; head?: string; state?: string }>;

export declare function resolveIssueOnlyPrLookup(
  session: Record<string, unknown>,
  input?: Record<string, unknown>,
): {
  prLookupFailed?: boolean;
  issueOnlyPrAmbiguous?: boolean;
  terminalPrBlocksRespawn?: boolean;
  resolvedPrNumber?: number;
  matchedPrNumbers?: number[];
  matchedTerminalPrNumber?: number;
  matchedTerminalPrNumbers?: number[];
};

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
): { actions: DeadWorkerReconcileAction[]; gates: DeadWorkerGateResult; tracking?: Record<string, unknown> };

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


export declare function extractWorktreeSessionId(worktreePath: string): string;
export declare function parseIssueNumberFromWorkerBranch(branch: string): number;
export declare function discoverAbsentSessions(input?: {
  sessions?: Array<Record<string, unknown>>;
  worktreeRecords?: Array<Record<string, unknown>>;
  worktreePorcelain?: string;
  auditCandidates?: Array<Record<string, unknown>>;
  openPrs?: Array<Record<string, unknown>>;
}): Array<Record<string, unknown>>;

export declare function probeRecoveryChecks(packRoot: string): {
  workerRecoveryAvailable: boolean;
  branchSafeRecoveryAvailable: boolean;
};
