import type { TerminalVerdictPayload } from '../plugins/ao-codex-pr-reviewer/lib/emit.js';

export declare const HARNESS_BRIDGE_KILL_SWITCH_ENV: string;
export declare const HARNESS_NESTED_BUDGET_ENV: string;
export declare const HARNESS_BOARD_FIELD_DENYLIST: readonly string[];

export interface HarnessExecutionSurfaces {
  trustedPackRoot: string;
  promptPath: string;
  bridgeEntrypoint: string;
  bridgeRunner: string;
  mapperPath: string;
  reviewScript: string;
}

export interface HarnessKillSwitchEvaluation {
  disabled: boolean;
  reason: string;
}

export interface NestedReviewBudgetEvaluation {
  ok: boolean;
  reason?: string;
}

export interface ReviewerHarnessAbortClassification {
  abort: boolean;
  reason: string;
  harness?: string | null;
  expectedHarness?: string;
  httpStatus?: number;
  classified?: boolean;
}

export interface MapperSubmitValidation {
  ok: boolean;
  reason?: string;
  payload?: TerminalVerdictPayload;
}

export interface TrustedPackRootExecutionAssertion {
  ok: boolean;
  violations: string[];
}

export interface HarnessBridgeFailureClassification {
  classified: boolean;
  failureClass: string;
}

export declare function parseTerminalVerdictPayload(stdout: string): TerminalVerdictPayload | null;
export declare function resolveHarnessExecutionSurfaces(trustedPackRoot: string): HarnessExecutionSurfaces;
export declare function isPathUnderWorkerWorktree(candidatePath: string, workerWorktreeRoot: string): boolean;
export declare function assertTrustedPackRootExecution(
  surfaces: HarnessExecutionSurfaces,
  workerWorktreeRoot?: string,
): TrustedPackRootExecutionAssertion;
export declare function evaluateHarnessKillSwitch(env?: NodeJS.ProcessEnv): HarnessKillSwitchEvaluation;
export declare function evaluateNestedReviewBudget(env?: NodeJS.ProcessEnv): NestedReviewBudgetEvaluation;
export declare function classifyReviewerHarnessAbort(
  configPayload: unknown,
  expectedHarness?: string,
): ReviewerHarnessAbortClassification;
export declare function containsProseSubmitMarkers(text: string): boolean;
export declare function validateMapperSubmitPayload(stdout: string): MapperSubmitValidation;
export declare function validateHarnessSubmitBody(body: string): MapperSubmitValidation;
export declare function buildHarnessSubmitVerdict(payload: TerminalVerdictPayload): 'approved' | 'changes_requested';
export declare function assertNoBoardFieldEmission(value: unknown, path?: string): string[];
export declare function formatHarnessSubmitBody(payload: TerminalVerdictPayload): string;
export declare function classifyHarnessBridgeFailure(failureClass: string): HarnessBridgeFailureClassification;
