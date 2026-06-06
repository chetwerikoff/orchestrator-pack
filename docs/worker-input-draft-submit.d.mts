export declare const DEFAULT_MAX_SUBMITS: number;
export declare const INPUT_AFFECTING_EVENT_KINDS: ReadonlySet<string>;

export declare function resolveSubmitConfig(config?: {
  maxSubmits?: number;
}): { maxSubmits: number };

export declare function buildSubmitDecisionKey(
  runId: string,
  headSha: string | undefined,
): string | null;

export declare function getControlledDeliveryAnchorMs(record: {
  sendObservedAtMs?: number;
  lastRedeliveryAtMs?: number;
}): number;

export declare function hasInterveningInputActivity(
  events: Array<Record<string, unknown>>,
  sessionId: string,
  anchorMs: number,
): boolean;

export declare function isSessionFloodActive(
  floodActiveSessions: Record<string, boolean | undefined>,
  sessionId: string,
): boolean;

export declare function evaluateSubmitEligibility(input: {
  run: import('./review-finding-delivery-confirm.d.mts').ReviewRun;
  sessions: import('./review-trigger-reconcile.d.mts').AoSession[];
  tracking: import('./review-finding-delivery-confirm.d.mts').DeliveryTrackingState;
  allRuns: import('./review-finding-delivery-confirm.d.mts').ReviewRun[];
  openPrs?: import('./review-trigger-reconcile.d.mts').OpenPr[];
  aoEvents?: Array<Record<string, unknown>>;
  floodActiveSessions?: Record<string, boolean>;
  nowMs: number;
  config?: { maxSubmits?: number };
}): {
  ok: boolean;
  reason: string;
  defer?: boolean;
  runId?: string;
  sessionId?: string;
  prNumber?: number;
  headSha?: string;
  decisionKey?: string | null;
  attempt?: number;
  maxSubmits?: number;
};

export declare function buildSubmitEnterArgv(tmuxTarget: string): string[];

export declare function evaluateSubmitAdapterGate(input: {
  sessionId: string;
  expectedSessionId: string;
  tmuxAvailable: boolean;
  tmuxSessionExists: boolean;
  tmuxTarget?: string;
}): {
  ok: boolean;
  reason: string;
  enter: boolean;
  tmuxTarget?: string;
};

export declare function assertSubmitArgvIsEnterOnly(argv: string[]): void;
