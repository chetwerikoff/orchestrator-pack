export const DEFAULT_EFFECTIVE_BUDGET_MS = 10 * 60_000;
export const DEFAULT_SOFT_DEADLINE_FRACTION = 0.85;
export const DEFAULT_TEST_BUDGET_FRACTION = 0.25;
export const DEFAULT_TEST_BUDGET_MAX_MS = 120_000;
export const DEFAULT_TIMEOUT_RETRY_MAX = 1;
export const REVIEWER_RUNNER_OVERHEAD_MS = 300_000;
export const NODE_TIMER_MAX_MS = 2_147_483_647;
export const MAX_EFFECTIVE_BUDGET_MS = 2_147_183_000;
export const MAX_RUNNER_TIMEOUT_SECONDS = Math.floor(NODE_TIMER_MAX_MS / 1000);

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

export type EffectiveBudgetSource = 'default' | 'env';
export type RunnerTimeoutSource = 'derived' | 'explicit';

export interface ReviewerBudgetDecision {
  effectiveBudgetMs: number;
  effectiveBudgetSource: EffectiveBudgetSource;
  maxEffectiveBudgetMs: number;
  runnerTimeoutRequiredMs: number;
  runnerTimeoutSeconds: number;
  runnerTimeoutMs: number;
  runnerTimeoutSource: RunnerTimeoutSource;
  runnerOverheadMs: number;
}

export class ReviewerBudgetError extends Error {
  readonly code = 'reviewer_budget_invalid';

  constructor(message: string) {
    super(`reviewer_budget_invalid: ${message}`);
    this.name = 'ReviewerBudgetError';
  }
}

export interface ReviewerEvidencePayload {
  reviewer: {
    effectiveBudgetMs: number;
    effectiveBudgetSource?: EffectiveBudgetSource;
    maxEffectiveBudgetMs?: number;
    runnerTimeoutRequiredMs?: number;
    runnerTimeoutSeconds?: number;
    runnerTimeoutMs?: number;
    runnerTimeoutSource?: RunnerTimeoutSource;
    runnerOverheadMs?: number;
    softDeadlineMs?: number;
    testBudgetMs?: number;
    testBudgetDecision?: TestBudgetDecision;
    failureClass?: ReviewerFailureClass;
    escalationReason?: string;
    elapsedMs?: number;
  };
}

function parsePositiveIntLegacy(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function parseNonNegativeIntLegacy(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function parseCanonicalPositiveInteger(raw: unknown, label: string): number {
  const text = String(raw ?? '');
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new ReviewerBudgetError(`${label} must match ^[1-9][0-9]*$`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ReviewerBudgetError(`${label} must be a positive safe integer`);
  }
  return parsed;
}

export function resolveEffectiveBudgetDecision(
  env: NodeJS.ProcessEnv = process.env,
): Pick<ReviewerBudgetDecision, 'effectiveBudgetMs' | 'effectiveBudgetSource' | 'maxEffectiveBudgetMs'> {
  const raw = env.AO_CODEX_REVIEW_EFFECTIVE_BUDGET_MS;
  if (raw === undefined || raw === '') {
    return {
      effectiveBudgetMs: DEFAULT_EFFECTIVE_BUDGET_MS,
      effectiveBudgetSource: 'default',
      maxEffectiveBudgetMs: MAX_EFFECTIVE_BUDGET_MS,
    };
  }
  const effectiveBudgetMs = parseCanonicalPositiveInteger(
    raw,
    'AO_CODEX_REVIEW_EFFECTIVE_BUDGET_MS',
  );
  if (effectiveBudgetMs > MAX_EFFECTIVE_BUDGET_MS) {
    throw new ReviewerBudgetError(
      `AO_CODEX_REVIEW_EFFECTIVE_BUDGET_MS exceeds ${MAX_EFFECTIVE_BUDGET_MS}`,
    );
  }
  return {
    effectiveBudgetMs,
    effectiveBudgetSource: 'env',
    maxEffectiveBudgetMs: MAX_EFFECTIVE_BUDGET_MS,
  };
}

export function resolveReviewerBudgetDecision(
  env: NodeJS.ProcessEnv = process.env,
  explicitTimeoutSeconds?: unknown,
): ReviewerBudgetDecision {
  const effective = resolveEffectiveBudgetDecision(env);
  const runnerTimeoutRequiredMs = effective.effectiveBudgetMs + REVIEWER_RUNNER_OVERHEAD_MS;
  if (!Number.isSafeInteger(runnerTimeoutRequiredMs) || runnerTimeoutRequiredMs > NODE_TIMER_MAX_MS) {
    throw new ReviewerBudgetError('effective budget plus runner overhead exceeds Node timer ceiling');
  }
  const derivedTimeoutSeconds = Math.ceil(runnerTimeoutRequiredMs / 1000);
  let runnerTimeoutSeconds = derivedTimeoutSeconds;
  let runnerTimeoutSource: RunnerTimeoutSource = 'derived';
  if (explicitTimeoutSeconds !== undefined && explicitTimeoutSeconds !== null && explicitTimeoutSeconds !== '') {
    const parsed = parseCanonicalPositiveInteger(explicitTimeoutSeconds, 'timeoutSeconds');
    if (parsed > MAX_RUNNER_TIMEOUT_SECONDS) {
      throw new ReviewerBudgetError(`timeoutSeconds exceeds ${MAX_RUNNER_TIMEOUT_SECONDS}`);
    }
    if (parsed < derivedTimeoutSeconds) {
      throw new ReviewerBudgetError(
        `timeoutSeconds ${parsed} is below required ${derivedTimeoutSeconds}`,
      );
    }
    runnerTimeoutSeconds = parsed;
    runnerTimeoutSource = 'explicit';
  }
  const runnerTimeoutMs = runnerTimeoutSeconds * 1000;
  if (!Number.isSafeInteger(runnerTimeoutMs) || runnerTimeoutMs > NODE_TIMER_MAX_MS) {
    throw new ReviewerBudgetError('resolved runner timeout exceeds Node timer ceiling');
  }
  return {
    ...effective,
    runnerTimeoutRequiredMs,
    runnerTimeoutSeconds,
    runnerTimeoutMs,
    runnerTimeoutSource,
    runnerOverheadMs: REVIEWER_RUNNER_OVERHEAD_MS,
  };
}

export function resolveEffectiveBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  return resolveEffectiveBudgetDecision(env).effectiveBudgetMs;
}

export function resolveSoftDeadlineMs(
  effectiveBudgetMs: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const explicit = env.AO_CODEX_REVIEW_SOFT_DEADLINE_MS?.trim();
  if (explicit) {
    return parsePositiveIntLegacy(
      explicit,
      Math.floor(effectiveBudgetMs * DEFAULT_SOFT_DEADLINE_FRACTION),
    );
  }
  return Math.floor(effectiveBudgetMs * DEFAULT_SOFT_DEADLINE_FRACTION);
}

export function resolveTestBudgetMs(
  effectiveBudgetMs: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const explicit = env.AO_CODEX_REVIEW_TEST_BUDGET_MS?.trim();
  if (explicit) {
    return parsePositiveIntLegacy(
      explicit,
      Math.min(
        DEFAULT_TEST_BUDGET_MAX_MS,
        Math.floor(effectiveBudgetMs * DEFAULT_TEST_BUDGET_FRACTION),
      ),
    );
  }
  return Math.min(
    DEFAULT_TEST_BUDGET_MAX_MS,
    Math.floor(effectiveBudgetMs * DEFAULT_TEST_BUDGET_FRACTION),
  );
}

export function resolveTimeoutRetryMax(env: NodeJS.ProcessEnv = process.env): number {
  return parseNonNegativeIntLegacy(
    env.AO_CODEX_REVIEW_TIMEOUT_RETRY_MAX,
    DEFAULT_TIMEOUT_RETRY_MAX,
  );
}

export interface ReviewerBudgetLedger extends ReviewerBudgetDecision {
  startedAtMs: number;
  softDeadlineMs: number;
  testBudgetMs: number;
  testBudgetSpentMs: number;
  testBudgetDecision?: TestBudgetDecision;
}

export function createReviewerBudgetLedger(
  env: NodeJS.ProcessEnv = process.env,
  startedAtMs = Date.now(),
  explicitTimeoutSeconds?: unknown,
): ReviewerBudgetLedger {
  const decision = resolveReviewerBudgetDecision(env, explicitTimeoutSeconds);
  return {
    startedAtMs,
    ...decision,
    softDeadlineMs: resolveSoftDeadlineMs(decision.effectiveBudgetMs, env),
    testBudgetMs: resolveTestBudgetMs(decision.effectiveBudgetMs, env),
    testBudgetSpentMs: 0,
  };
}

export function elapsedMs(ledger: ReviewerBudgetLedger, nowMs = Date.now()): number {
  return Math.max(0, nowMs - ledger.startedAtMs);
}

export function remainingReviewBudgetMs(
  ledger: ReviewerBudgetLedger,
  nowMs = Date.now(),
): number {
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
    effectiveBudgetSource: ledger.effectiveBudgetSource,
    maxEffectiveBudgetMs: ledger.maxEffectiveBudgetMs,
    runnerTimeoutRequiredMs: ledger.runnerTimeoutRequiredMs,
    runnerTimeoutSeconds: ledger.runnerTimeoutSeconds,
    runnerTimeoutMs: ledger.runnerTimeoutMs,
    runnerTimeoutSource: ledger.runnerTimeoutSource,
    runnerOverheadMs: ledger.runnerOverheadMs,
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
    const parsed = JSON.parse(
      trimmed.slice(REVIEWER_EVIDENCE_PREFIX.length),
    ) as ReviewerEvidencePayload;
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
    AO_REVIEW_RUNNER_TIMEOUT_REQUIRED_MS: String(ledger.runnerTimeoutRequiredMs),
    AO_REVIEW_RUNNER_TIMEOUT_SECONDS: String(ledger.runnerTimeoutSeconds),
    AO_REVIEW_RUNNER_TIMEOUT_MS: String(ledger.runnerTimeoutMs),
  };
}
