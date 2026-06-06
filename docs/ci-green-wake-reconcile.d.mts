export declare const DEFAULT_CI_GREEN_WAKE_INTERVAL_MS: number;

export declare const PRE_HANDOFF_REPORT_STATES: ReadonlySet<string>;
export declare const POST_HANDOFF_REPORT_STATES: ReadonlySet<string>;
export declare const FORBIDDEN_LIFECYCLE_PATTERNS: readonly RegExp[];
export declare const CI_GREEN_WAKE_MESSAGE: string;

import type { AoSession, OpenPr } from './review-trigger-reconcile.d.mts';

export type { AoSession, OpenPr };

export type CiLevel = 'green' | 'red' | 'pending';

export interface CiCheck {
  name?: string;
  state?: string;
  conclusion?: string;
  status?: string;
}

export interface HeadCiRecord {
  lastCiLevel?: CiLevel;
  greenEpoch?: number;
}

export interface CiGreenWakeState {
  heads?: Record<string, HeadCiRecord>;
  nudged?: Record<string, { sessionId?: string; sentAtMs?: number }>;
  lastTickMs?: number;
}

export type CiGreenWakeAction =
  | {
      type: 'nudge';
      prNumber: number;
      headSha: string;
      sessionId: string;
      transitionId: string;
      message: string;
    }
  | {
      type: 'skip';
      prNumber: number;
      headSha: string;
      reason: string;
      transitionId?: string;
    };

export interface PlanCiGreenWakeInput {
  openPrs: OpenPr[];
  sessions: AoSession[];
  ciChecksByPr: Record<string, CiCheck[]> | Array<{ prNumber: number; checks: CiCheck[] }>;
  requiredCheckNamesByPr?:
    | Record<string, string[]>
    | Array<{ prNumber: number; requiredCheckNames: string[] }>;
  requiredCheckLookupFailedByPr?:
    | Record<string, boolean>
    | Array<{ prNumber: number; failed: boolean }>;
  tracking?: CiGreenWakeState;
}

export declare function classifyRequiredCiLevel(
  checks: CiCheck[],
  options?: { requiredCheckNames?: string[]; requiredCheckLookupFailed?: boolean },
): CiLevel;

export declare function normalizeRequiredCheckNamesByPr(
  requiredByPr: PlanCiGreenWakeInput['requiredCheckNamesByPr'],
): Map<number, string[]>;

export declare function headTrackingKey(prNumber: number, headSha: string): string;

export declare function buildTransitionId(
  prNumber: number,
  headSha: string,
  greenEpoch: number,
): string;

export declare function deriveGreenEpoch(
  record: HeadCiRecord | undefined,
  currentLevel: CiLevel,
): { greenEpoch: number; lastCiLevel: CiLevel };

export declare function normalizeSessionReportState(session: AoSession): string;

export declare function isPreHandOffWorkerForHead(
  session: AoSession,
  headSha: string,
  openPrs?: OpenPr[],
  prNumber?: number,
): boolean;

export declare function normalizeRequiredCheckLookupFailedByPr(
  lookupFailedByPr: PlanCiGreenWakeInput['requiredCheckLookupFailedByPr'],
): Map<number, boolean>;

export { resolveHeadOwningWorkerSessionId } from './review-trigger-reconcile.d.mts';

export declare function evaluateCiGreenWakeCandidate(input: {
  session: AoSession;
  prNumber: number;
  headSha: string;
  openPrs?: OpenPr[];
  ciChecks?: CiCheck[];
  requiredCheckNames?: string[];
  requiredCheckLookupFailed?: boolean;
}): {
  eligible: boolean;
  reasons: string[];
  sessionId: string;
  ciLevel: CiLevel;
};

export declare function planCiGreenWakeActions(
  input: PlanCiGreenWakeInput,
): { actions: CiGreenWakeAction[]; headRecords: Record<string, HeadCiRecord> };

export declare function normalizeCiChecksByPr(
  ciChecksByPr: PlanCiGreenWakeInput['ciChecksByPr'],
): Map<number, CiCheck[]>;

export declare function preSendRecheck(
  planned: { sessionId: string; prNumber: number; headSha: string },
  fresh: {
    openPrs: OpenPr[];
    sessions: AoSession[];
    ciChecksByPr: PlanCiGreenWakeInput['ciChecksByPr'];
    requiredCheckNamesByPr?: PlanCiGreenWakeInput['requiredCheckNamesByPr'];
    requiredCheckLookupFailedByPr?: PlanCiGreenWakeInput['requiredCheckLookupFailedByPr'];
  },
): { ok: boolean; reason: string };

export declare function recordSuccessfulNudge(
  tracking: CiGreenWakeState,
  transitionId: string,
  sessionId: string,
  sentAtMs: number,
): CiGreenWakeState;

export declare function mergeTrackingAfterTick(
  tracking: CiGreenWakeState,
  headRecords: Record<string, HeadCiRecord>,
  lastTickMs: number,
): CiGreenWakeState;

export declare function evaluateCiGreenWakeInterval(input: {
  nowMs: number;
  lastTickMs?: number;
  intervalMs?: number;
}): { ok: true; intervalMs: number } | { ok: false; reason: 'interval_not_elapsed'; intervalMs: number };

export declare function findForbiddenCiGreenWakeCommands(
  commandLines: string[],
): Array<{ command: string; pattern: string }>;

export declare function buildCiGreenWakeSendArgv(
  sessionId: string,
  message: string,
): string[];

export declare function mergeBranchRequiredCheckNames(
  contexts: string[] | undefined,
  checks: Array<string | { context?: string }> | undefined,
): string[];
