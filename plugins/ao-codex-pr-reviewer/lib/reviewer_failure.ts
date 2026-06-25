import type { RunCodexReviewResult } from './run_review.js';
import {
  buildReviewerEvidence,
  formatReviewerEvidenceMarker,
  type ReviewerBudgetLedger,
  type ReviewerEvidencePayload,
  type ReviewerFailureClass,
} from './reviewer_budget.js';
import type { SelectReviewVerdictResult } from './verdict.js';

export const TIMEOUT_NO_VERDICT_MESSAGE =
  'reviewer timeout before verdict — structured timeout/no-verdict failure';

export const REPEATED_TIMEOUT_ESCALATION_REASON = 'repeated_timeout_no_verdict';

export function isSpawnTimeoutResult(codex: RunCodexReviewResult & { timedOut?: boolean }): boolean {
  if (codex.timedOut) {
    return true;
  }
  if (codex.exitCode === 0) {
    return false;
  }
  const combined = [codex.stderr, codex.lastMessage, codex.processJsonl].join('\n').toLowerCase();
  return (
    combined.includes('timed out') ||
    combined.includes('timeout before verdict') ||
    combined.includes('etimedout')
  );
}

export function classifyReviewerFailure(options: {
  codex: RunCodexReviewResult & { timedOut?: boolean };
  parsed?: SelectReviewVerdictResult;
  ledger: ReviewerBudgetLedger;
}): ReviewerFailureClass {
  if (isSpawnTimeoutResult(options.codex)) {
    return 'timeout_no_verdict';
  }
  if (options.codex.exitCode !== 0) {
    return 'process_error';
  }
  if (options.parsed?.kind === 'error') {
    const message = options.parsed.message.toLowerCase();
    if (message.includes('empty output')) {
      return 'empty_output';
    }
    return 'parse_error';
  }
  return 'process_error';
}

export function buildReviewerFailureEvidence(
  ledger: ReviewerBudgetLedger,
  failureClass: ReviewerFailureClass,
  extras: Partial<ReviewerEvidencePayload['reviewer']> = {},
): ReviewerEvidencePayload {
  return buildReviewerEvidence(ledger, { failureClass, ...extras });
}

export function buildReviewerFailureLogLines(
  ledger: ReviewerBudgetLedger,
  failureClass: ReviewerFailureClass,
  extras: Partial<ReviewerEvidencePayload['reviewer']> = {},
): string[] {
  const evidence = buildReviewerFailureEvidence(ledger, failureClass, extras);
  const lines = [formatReviewerEvidenceMarker(evidence)];
  if (failureClass === 'timeout_no_verdict') {
    lines.push(
      `${TIMEOUT_NO_VERDICT_MESSAGE} (effectiveBudgetMs=${ledger.effectiveBudgetMs}, softDeadlineMs=${ledger.softDeadlineMs})`,
    );
  }
  return lines;
}
