export declare const ACTIONABLE_REVIEW_STATUSES: string[];

export declare const GATE0_CAPABILITIES: {
  selectiveSend: boolean;
  terminalNonForward: boolean;
  priorSentAtRouting: boolean;
};

export declare const UPSTREAM_TRACKING: {
  packIssue: string;
  pipelinePreferred: string[];
  legacyFallback: string;
  deliveryPrerequisites: string[];
};

export interface BulkSendSignal {
  kind: string;
  detail: string;
}

export interface ClassifiedBulkSendRun {
  runId: string;
  status: string;
  openFindingCount: number;
  sentFindingCount: number;
  findingCount: number;
  prNumber: unknown;
  linkedSessionId: unknown;
  signals: BulkSendSignal[];
  flagged: boolean;
}

export interface BulkSendDiagnoseResult {
  readOnly: boolean;
  gate0: {
    aoVersionNote: string;
    capabilities: typeof GATE0_CAPABILITIES;
    verdict: string;
  };
  upstream: typeof UPSTREAM_TRACKING;
  summary: {
    totalRuns: number;
    flaggedRuns: number;
    signalKinds: string[];
  };
  flaggedRuns: ClassifiedBulkSendRun[];
}

export declare function normalizeReviewRuns(payload: unknown): Array<Record<string, unknown>>;
export declare function classifyBulkSendRun(run: Record<string, unknown>): ClassifiedBulkSendRun;
export declare function diagnoseBulkSendBlock(input?: {
  runs?: unknown;
  projectId?: string;
}): BulkSendDiagnoseResult;
