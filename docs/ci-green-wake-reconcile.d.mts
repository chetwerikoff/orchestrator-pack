export declare const DEFAULT_CI_GREEN_WAKE_INTERVAL_MS: number;

export declare const PRE_HANDOFF_REPORT_STATES: ReadonlySet<string>;
export declare const POST_HANDOFF_REPORT_STATES: ReadonlySet<string>;
export declare const FORBIDDEN_LIFECYCLE_PATTERNS: readonly RegExp[];
export declare const CI_GREEN_WAKE_MESSAGE: string;

export type CiLevel = 'green' | 'red' | 'pending';

export interface CiCheck {
  name?: string;
  state?: string;
  conclusion?: string;
  status?: string;
}

export interface OpenPr {
  number?: number;
  headRefOid?: string;
}

export interface AoSession {
  name?: string;
  sessionId?: string;
  id?: string;
  role?: string;
  prNumber?: number | null;
  pr?: string | null;
  ownedHeadSha?: string;
  headRefOid?: string;
  status?: string;
  runtime?: string;
  reports?: Array<Record<string, unknown>>;
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
  tracking?: CiGreenWakeState;
}

export declare function classifyRequiredCiLevel(checks: CiCheck[]): CiLevel;

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

export declare function isPreHandOffWorkerForHead(session: AoSession, headSha: string): boolean;

export declare function evaluateCiGreenWakeCandidate(input: {
  session: AoSession;
  prNumber: number;
  headSha: string;
  openPrs?: OpenPr[];
  ciChecks?: CiCheck[];
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
