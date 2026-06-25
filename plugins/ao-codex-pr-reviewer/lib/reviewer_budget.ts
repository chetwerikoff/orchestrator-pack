export const DEFAULT_EFFECTIVE_BUDGET_MS = 10 * 60_000;
export const DEFAULT_SOFT_DEADLINE_FRACTION = 0.85;
export const DEFAULT_TEST_BUDGET_FRACTION = 0.25;
export const DEFAULT_TEST_BUDGET_MAX_MS = 120_000;
export const DEFAULT_TIMEOUT_RETRY_MAX = 1;

export const REVIEWER_EVIDENCE_PREFIX = 'reviewer-evidence:';

export type TestBudgetDecision =
  | 'allowed'
  | 'skipped_or_denied_slow_test'
  | 'skipped_insufficient_budget';

export type ReviewerFailureClass =
  | 'timeout_no_verdict'
  | 'empty_output'
  | 'parse_error'
  | 'process_error';

export interface ReviewerEvidencePayload {
  reviewer: {
    effectiveBudgetMs: number;
    softDeadlineMs?: number;
    testBudgetMs?: number;
    testBudgetDecision?: TestBudgetDecision;
    failureClass?: ReviewerFailureClass;
    escalationReason?: string;
    elapsedMs?: number;
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export function resolveEffectiveBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInt(env.AO_CODEX_REVIEW_EFFECTIVE_BUDGET_MS, DEFAULT_EFFECTIVE_BUDGET_MS);
}

export function resolveSoftDeadlineMs(
  effectiveBudgetMs: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const explicit = env.AO_CODEX_REVIEW_SOFT_DEADLINE_MS?.trim();
  if (explicit) {
    return parsePositiveInt(explicit, Math.floor(effectiveBudgetMs * DEFAULT_SOFT_DEADLINE_FRACTION));
  }
  return Math.floor(effectiveBudgetMs * DEFAULT_SOFT_DEADLINE_FRACTION);
}

export function resolveTestBudgetMs(
  effectiveBudgetMs: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const explicit = env.AO_CODEX_REVIEW_TEST_BUDGET_MS?.trim();
  if (explicit) {
    return parsePositiveInt(explicit, Math.min(DEFAULT_TEST_BUDGET_MAX_MS, Math.floor(effectiveBudgetMs * DEFAULT_TEST_BUDGET_FRACTION)));
  }
  return Math.min(
    DEFAULT_TEST_BUDGET_MAX_MS,
    Math.floor(effectiveBudgetMs * DEFAULT_TEST_BUDGET_FRACTION),
  );
}

export function resolveTimeoutRetryMax(env: NodeJS.ProcessEnv = process.env): number {
  return parseNonNegativeInt(env.AO_CODEX_REVIEW_TIMEOUT_RETRY_MAX, DEFAULT_TIMEOUT_RETRY_MAX);
}

export interface ReviewerBudgetLedger {
  startedAtMs: number;
  effectiveBudgetMs: number;
  softDeadlineMs: number;
  testBudgetMs: number;
  testBudgetSpentMs: number;
  testBudgetDecision?: TestBudgetDecision;
}

export function createReviewerBudgetLedger(
  env: NodeJS.ProcessEnv = process.env,
  startedAtMs = Date.now(),
): ReviewerBudgetLedger {
  const effectiveBudgetMs = resolveEffectiveBudgetMs(env);
  return {
    startedAtMs,
    effectiveBudgetMs,
    softDeadlineMs: resolveSoftDeadlineMs(effectiveBudgetMs, env),
    testBudgetMs: resolveTestBudgetMs(effectiveBudgetMs, env),
    testBudgetSpentMs: 0,
  };
}

export function elapsedMs(ledger: ReviewerBudgetLedger, nowMs = Date.now()): number {
  return Math.max(0, nowMs - ledger.startedAtMs);
}

export function remainingReviewBudgetMs(ledger: ReviewerBudgetLedger, nowMs = Date.now()): number {
  return Math.max(0, ledger.effectiveBudgetMs - elapsedMs(ledger, nowMs));
}

export function remainingTestBudgetMs(ledger: ReviewerBudgetLedger): number {
  return Math.max(0, ledger.testBudgetMs - ledger.testBudgetSpentMs);
}

export function recordTestBudgetDecision(
  ledger: ReviewerBudgetLedger,
  decision: TestBudgetDecision,
): void {
  ledger.testBudgetDecision = decision;
}

export function buildReviewerEvidence(
  ledger: ReviewerBudgetLedger,
  extras: Partial<ReviewerEvidencePayload['reviewer']> = {},
  nowMs = Date.now(),
): ReviewerEvidencePayload {
  const reviewer: ReviewerEvidencePayload['reviewer'] = {
    effectiveBudgetMs: ledger.effectiveBudgetMs,
    softDeadlineMs: ledger.softDeadlineMs,
    testBudgetMs: ledger.testBudgetMs,
    elapsedMs: elapsedMs(ledger, nowMs),
    ...extras,
  };
  if (ledger.testBudgetDecision) {
    reviewer.testBudgetDecision = ledger.testBudgetDecision;
  }
  for (const key of Object.keys(reviewer) as Array<keyof typeof reviewer>) {
    if (reviewer[key] === undefined) {
      delete reviewer[key];
    }
  }
  return { reviewer };
}

export function formatReviewerEvidenceMarker(evidence: ReviewerEvidencePayload): string {
  return `${REVIEWER_EVIDENCE_PREFIX}${JSON.stringify(evidence)}`;
}

export function parseReviewerEvidenceMarker(line: string): ReviewerEvidencePayload | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(REVIEWER_EVIDENCE_PREFIX)) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed.slice(REVIEWER_EVIDENCE_PREFIX.length)) as ReviewerEvidencePayload;
    if (!parsed?.reviewer || typeof parsed.reviewer.effectiveBudgetMs !== 'number') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function extractReviewerEvidenceFromText(text: string): ReviewerEvidencePayload | null {
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseReviewerEvidenceMarker(line);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

export function buildReviewerBudgetSpawnEnv(
  ledger: ReviewerBudgetLedger,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const hardDeadlineMs = ledger.startedAtMs + ledger.effectiveBudgetMs;
  return {
    ...env,
    AO_REVIEW_EFFECTIVE_BUDGET_MS: String(ledger.effectiveBudgetMs),
    AO_REVIEW_SOFT_DEADLINE_MS: String(ledger.softDeadlineMs),
    AO_REVIEW_TEST_BUDGET_MS: String(ledger.testBudgetMs),
    AO_REVIEW_HARD_DEADLINE_MS: String(hardDeadlineMs),
    AO_REVIEW_BUDGET_STARTED_MS: String(ledger.startedAtMs),
  };
}
