export const GOVERNOR_VERSION: string;
export const GOVERNOR_DENIAL_EXIT_CODE: number;
export const GOVERNOR_AUDIT_LABEL: string;
export const LANES: readonly ['background', 'retry', 'interactive-preflight', 'interactive'];

export type GovernorLane = (typeof LANES)[number];

export type GovernorAdmissionResult = {
  admitted: boolean;
  skipped?: boolean;
  lane?: GovernorLane;
  partitionKey?: string;
  statePath?: string;
  emergency?: boolean;
  reason?: string;
  audit?: Record<string, unknown>;
  release?: (fields?: Record<string, unknown>) => void;
};

export function isGovernorEnabled(env?: NodeJS.ProcessEnv): boolean;
export function resolveGovernorStateDir(env?: NodeJS.ProcessEnv): string;
export function governorStatePath(stateDir: string, partitionKey: string): string;
export function governorLockPath(stateDir: string, partitionKey: string): string;
export function resolveGovernorBudget(env?: NodeJS.ProcessEnv): Record<string, number>;
export function normalizeLane(lane: string): GovernorLane;
export function resolveCallerLane(env?: NodeJS.ProcessEnv, argv?: string[]): GovernorLane;
export function classifyGovernorTransportOutcome(input?: Record<string, unknown>): Record<string, unknown>;
export function applyObservedLimitToState(
  state: Record<string, unknown>,
  outcome: Record<string, unknown>,
  now: number,
  budget: Record<string, number>,
): Record<string, unknown>;
export function acquireGithubGovernorAdmission(options?: Record<string, unknown>): GovernorAdmissionResult;
export function releaseGithubGovernorAdmission(options?: Record<string, unknown>): void;
export function recordGithubGovernorObservedLimit(options?: Record<string, unknown>): Record<string, unknown> | null;
export function formatGovernorDenialMessage(denial: Record<string, unknown>): string;
export function readGovernorStateForFixture(
  stateDir: string,
  partitionKey: string,
): Record<string, unknown> | null;
