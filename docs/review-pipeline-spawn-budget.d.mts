export declare const REVIEW_PIPELINE_SPAWN_BUDGET_VERSION: string;
export declare const REVIEW_PIPELINE_SPAWN_CAPTURE_VERSION: string;
export declare const REVIEW_PIPELINE_SPAWN_BUDGET_RELATIVE_PATH: string;
export declare const REQUIRED_SOURCE_CLASSES: readonly string[];

export declare function attributeSpawnSourceClass(
  commandLine: string,
  hints?: { childId?: string; sourceHint?: string },
): string;

export declare function validateReviewPipelineSpawnBudget(budget: unknown): {
  ok: boolean;
  reason: string;
};

export declare function loadReviewPipelineSpawnBudget(packRoot: string): {
  ok: boolean;
  reason: string;
  budget: Record<string, unknown> | null;
};

export declare function validateSpawnCapture(capture: unknown): {
  ok: boolean;
  reason: string;
  caseId?: string;
};

export declare function validateJournalRateAttribution(capture: unknown): {
  ok: boolean;
  reason: string;
  observedRatePerMinute?: number;
  subprocessInvocationCount?: number;
  bySource?: Record<string, number>;
  commandLine?: string;
};

export interface SpawnBudgetAggregation {
  totalProcessCount: number;
  bySource: Record<string, number>;
  topOffenders: Array<{ commandLine: string; count: number }>;
  nontrivialNonUnknownCount: number;
}

export declare function aggregateSpawnEvents(
  events: Array<{ commandLine?: string; sourceHint?: string; childId?: string; atMs?: number }>,
): SpawnBudgetAggregation;

export declare function measurePerStepCosts(
  bySource: Record<string, number>,
  totalEvents: number,
): Record<string, number>;

export declare function deriveReducedBudgetThreshold(input: {
  measuredPerStepCosts: Record<string, number>;
  callerCadencePerMinute: number;
  reductionFactor?: number;
  perStepCostFloor?: number;
}): {
  derivedBudgetThreshold: number;
  rawPreReduction: number;
  reductionFactor: number;
};

export interface SpawnBudgetReport {
  ok: boolean;
  reason?: string;
  derivedBudgetThreshold?: number;
  observedRatePerMinute?: number;
  totalProcessCount?: number;
  psSnapshotMissesBurst?: boolean;
  bySource?: Record<string, number>;
  [key: string]: unknown;
}

export declare function buildSpawnBudgetReport(
  capture: unknown,
  budgetManifest: Record<string, unknown>,
): SpawnBudgetReport;

export declare function evaluateSpawnBudgetReport(report: SpawnBudgetReport): {
  ok: boolean;
  reason: string;
  overBudget?: boolean;
  observedRatePerMinute?: number;
  totalProcessCount?: number;
  derivedBudgetThreshold?: number;
};

export interface CaptureReplayResult {
  ok: boolean;
  reason?: string;
  verdict?: { ok: boolean; reason?: string };
  [key: string]: unknown;
}

export declare function replayCaptureBudgetCheck(
  capture: unknown,
  budgetManifest: Record<string, unknown>,
  expectedCaseId: 'storm-baseline' | 'reduced-post-change',
): CaptureReplayResult;

export declare function verifyCommittedCaptureReplays(
  packRoot: string,
  budgetManifest?: Record<string, unknown>,
): {
  ok: boolean;
  reason?: string;
  storm?: CaptureReplayResult;
  reduced?: CaptureReplayResult;
  [key: string]: unknown;
};

export declare function collectLiveJournalSpawns(options?: {
  journalCommand?: string;
  since?: string;
  unit?: string;
}): Record<string, unknown>;
