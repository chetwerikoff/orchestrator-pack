export declare const ENV_CONTENT_SHAPE_DISABLED: string;
export declare const DEFAULT_MAX_RETRIGGER_COUNT: number;

export declare const CONTENT_SHAPE_ACCEPT: 'accept';
export declare const CONTENT_SHAPE_REJECT_RETRIGGER: 'reject_retrigger';
export declare const CONTENT_SHAPE_WAIT_RUNNING: 'wait_running';
export declare const CONTENT_SHAPE_ROUTE_FAILED: 'route_failed';
export declare const CONTENT_SHAPE_ESCALATE: 'escalate';

export declare const TERMINAL_ACCEPT_STATUSES: ReadonlySet<string>;
export declare const RUNNING_STATUSES: ReadonlySet<string>;

export interface ContentShapeKillSwitchEvaluation {
  disabled: boolean;
  reason: string;
}

export interface HarnessContentShapeDecision {
  action: string;
  reason?: string;
  status?: string;
  payload?: unknown;
  retriggerCount?: number;
  maxRetriggerCount?: number;
  needsSupersede?: boolean;
  priorReason?: string;
  skipped?: boolean;
}

export interface GateTerminalFromContentShape {
  action: string | null;
  reason?: string;
}

export declare function evaluateContentShapeKillSwitch(env?: NodeJS.ProcessEnv): ContentShapeKillSwitchEvaluation;
export declare function isHarnessLatestRun(latestRun: unknown): boolean;
export declare function normalizeHarnessRunStatus(status: unknown): string;
export declare function evaluateHarnessLatestRunContentShape(latestRun: unknown): HarnessContentShapeDecision;
export declare function evaluateHarnessContentShapeStage(input: Record<string, unknown>): HarnessContentShapeDecision;
export declare function mapContentShapeToGateTerminal(contentShape: HarnessContentShapeDecision): GateTerminalFromContentShape;
export declare function shouldRunHarnessContentShapeStage(
  input: Record<string, unknown>,
  attribution?: { latestRun?: unknown } | null,
): boolean;
