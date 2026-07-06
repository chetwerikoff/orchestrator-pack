/**
 * Review-start repeat classifier for orchestrator pipeline diagnostics (Issue #480).
 * Composes with #332/#318 claim and cycle gates — diagnostic only, not a second state machine.
 * Vitest: scripts/review-start-repeat-classifier.test.ts
 */
import { evaluateReviewCycleGate } from './worker-iteration-cycle.mjs';
import { evaluateCurrentHeadCoverage } from './orchestrator-claimed-review-run.mjs';
import { normalizeLegacyReviewRunStatus } from './review-reconcile-primitives.mjs';
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';

export const REVIEW_START_REPEAT_CLASSIFIER_VERSION = 'review-start-repeat-classifier/v1';

/** @type {readonly string[]} */
export const CLASSIFIER_INPUT_KEYS = Object.freeze([
  'project',
  'session',
  'pr',
  'head',
  'cycle',
  'claimId',
  'reviewRunState',
  'triggerSurface',
]);

const IN_FLIGHT_RUN_STATES = new Set(['queued', 'preparing', 'running', 'reviewing']);
const COVERED_TERMINAL_STATES = new Set(['up_to_date', 'changes_requested']);

/**
 * @param {object} input
 */
export function classifyReviewStartAttempt(input) {
  const row = {
    project: String(input.project ?? ''),
    session: String(input.session ?? ''),
    pr: Number(input.pr ?? 0),
    head: String(input.head ?? '').toLowerCase(),
    cycle: String(input.cycle ?? ''),
    claimId: String(input.claimId ?? ''),
    reviewRunState: String(input.reviewRunState ?? ''),
    triggerSurface: String(input.triggerSurface ?? ''),
  };

  const priorAttempts = Array.isArray(input.priorAttempts) ? input.priorAttempts : [];
  const reviewRuns = Array.isArray(input.reviewRuns) ? input.reviewRuns : [];
  const claimOutcome = String(input.claimOutcome ?? '');
  const started = Boolean(input.started);

  const sameCyclePriorStarts = priorAttempts.filter(
    (attempt) =>
      Number(attempt.pr) === row.pr &&
      String(attempt.cycle ?? '') === row.cycle &&
      String(attempt.head ?? '').toLowerCase() === row.head &&
      Boolean(attempt.started),
  );

  const coverage = evaluateCurrentHeadCoverage(reviewRuns, row.pr, row.head);
  const normalizedReviewRunState = normalizeLegacyReviewRunStatus(row.reviewRunState);
  const coveredInFlight =
    IN_FLIGHT_RUN_STATES.has(row.reviewRunState) ||
    IN_FLIGHT_RUN_STATES.has(normalizedReviewRunState) ||
    (coverage.verdict === 'covered' &&
      (IN_FLIGHT_RUN_STATES.has(String(coverage.status ?? '')) ||
        IN_FLIGHT_RUN_STATES.has(normalizeLegacyReviewRunStatus(String(coverage.status ?? ''))) ||
        COVERED_TERMINAL_STATES.has(String(coverage.status ?? '')) ||
        COVERED_TERMINAL_STATES.has(normalizeLegacyReviewRunStatus(String(coverage.status ?? '')))));

  if (coveredInFlight && !started) {
    return {
      ...row,
      classification: 'covered_in_flight_suppressed',
      coverageVerdict: coverage.verdict,
      coverageReason: coverage.reason,
    };
  }

  if (claimOutcome === 'claim_lost' || claimOutcome === 'claim_loser' || claimOutcome === 'claim_lost_race') {
    return { ...row, classification: 'claim_loser', claimOutcome };
  }

  const cycleRecord =
    input.cycleState && typeof input.cycleState === 'object'
      ? /** @type {Record<string, unknown>} */ (input.cycleState)
      : {};
  const reviewGate = evaluateReviewCycleGate({
    cycle: cycleRecord,
    openRevision: input.openRevision ?? { open: false },
    reviewRuns,
    prNumber: row.pr,
    headSha: row.head,
    handoffAccepted: Boolean(input.handoffAccepted),
    readyDebounce: input.readyDebounce ?? { waiting: false },
  });

  if (
    sameCyclePriorStarts.length > 0 &&
    !COVERED_TERMINAL_STATES.has(normalizedReviewRunState) &&
    !IN_FLIGHT_RUN_STATES.has(row.reviewRunState) &&
    !IN_FLIGHT_RUN_STATES.has(normalizedReviewRunState)
  ) {
    return {
      ...row,
      classification: 'same_cycle_repeat_regression',
      priorStartCount: sameCyclePriorStarts.length,
    };
  }

  if (!reviewGate.allow && reviewGate.blockers?.includes('already_reviewed_this_cycle')) {
    return {
      ...row,
      classification: 'same_cycle_repeat_regression',
      blockers: reviewGate.blockers,
    };
  }

  const priorHeadsSameCycle = priorAttempts.filter(
    (attempt) => Number(attempt.pr) === row.pr && String(attempt.cycle ?? '') === row.cycle,
  );
  const distinctHeadSeen = priorHeadsSameCycle.some(
    (attempt) => String(attempt.head ?? '').toLowerCase() !== row.head,
  );
  if (distinctHeadSeen) {
    return { ...row, classification: 'distinct_new_head' };
  }

  const priorCycles = new Set(
    priorAttempts.filter((attempt) => Number(attempt.pr) === row.pr).map((attempt) => String(attempt.cycle ?? '')),
  );
  if (priorCycles.size > 0 && !priorCycles.has(row.cycle)) {
    return { ...row, classification: 'distinct_new_cycle' };
  }

  if (started) {
    return { ...row, classification: 'explainable_distinct_start' };
  }

  return { ...row, classification: 'deferred_no_start' };
}

/**
 * @param {Array<Record<string, unknown>>} attempts
 */
export function classifyReviewStartAttemptSeries(attempts) {
  /** @type {Array<ReturnType<typeof classifyReviewStartAttempt>>} */
  const rows = [];
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index] ?? {};
    const priorAttempts = attempts.slice(0, index);
    rows.push(
      classifyReviewStartAttempt({
        ...attempt,
        priorAttempts,
      }),
    );
  }
  return rows;
}

runStdinJsonCli('review-start-repeat-classifier.mjs', {
  classify: () => classifyReviewStartAttempt(readStdinJson()),
  classifySeries: () => classifyReviewStartAttemptSeries(readStdinJson().attempts ?? []),
});
