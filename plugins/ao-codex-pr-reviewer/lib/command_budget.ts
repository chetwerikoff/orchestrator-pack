import {
  type ReviewerBudgetLedger,
  recordTestBudgetDecision,
  remainingReviewBudgetMs,
  remainingTestBudgetMs,
  type TestBudgetDecision,
} from './reviewer_budget.js';

export type ReviewCommandClass = 'cheap_targeted' | 'slow_test' | 'full_suite';

const SLOW_TEST_MARKERS = [
  /orchestrator-wake-supervisor\.test\.ts/i,
  /orchestrator-wake-supervisor-test-child/i,
  /scripts\/verify\.ps1/i,
  /check-reusable\.ps1/i,
  /supervisor/i,
];

const FULL_SUITE_MARKERS = [
  /\bnpm\s+test\b(?!\s+--\s)/i,
  /\bnpm\s+run\s+test\b(?!\s+--\s)/i,
  /\bvitest\s+run\b(?!\s+[^\s-])/i,
  /\bpnpm\s+test\b/i,
  /\byarn\s+test\b/i,
];

const CHEAP_TARGETED_MARKERS = [
  /\bnpm\s+test\s+--\s+/i,
  /\bnpm\s+run\s+test\s+--\s+/i,
  /\bvitest\s+run\s+[^\s]/i,
  /\bnpx\s+vitest\s+run\s+[^\s]/i,
];

export function flattenCommandArgv(argv: string[]): string {
  return argv.map((part) => part.trim()).filter(Boolean).join(' ');
}

export function classifyReviewShellCommand(argv: string[]): ReviewCommandClass {
  const joined = flattenCommandArgv(argv);
  if (!joined) {
    return 'cheap_targeted';
  }

  if (SLOW_TEST_MARKERS.some((pattern) => pattern.test(joined))) {
    return 'slow_test';
  }
  if (CHEAP_TARGETED_MARKERS.some((pattern) => pattern.test(joined))) {
    return 'cheap_targeted';
  }
  if (FULL_SUITE_MARKERS.some((pattern) => pattern.test(joined))) {
    return 'full_suite';
  }
  if (/\btest\b/i.test(joined) && /\b(ps1|pwsh|npm|pnpm|yarn|vitest)\b/i.test(joined)) {
    return 'slow_test';
  }
  return 'cheap_targeted';
}

export interface CommandBudgetEvaluation {
  allow: boolean;
  decision: TestBudgetDecision;
  reason: string;
  commandClass: ReviewCommandClass;
}

export function evaluateCommandBudget(
  ledger: ReviewerBudgetLedger,
  argv: string[],
  nowMs = Date.now(),
): CommandBudgetEvaluation {
  const commandClass = classifyReviewShellCommand(argv);
  const reviewRemaining = remainingReviewBudgetMs(ledger, nowMs);
  const testRemaining = remainingTestBudgetMs(ledger);

  if (commandClass === 'cheap_targeted') {
    if (reviewRemaining <= 0) {
      return {
        allow: false,
        decision: 'skipped_insufficient_budget',
        reason: 'review budget exhausted before cheap targeted check',
        commandClass,
      };
    }
    return {
      allow: true,
      decision: 'allowed',
      reason: 'cheap targeted check within review budget',
      commandClass,
    };
  }

  if (reviewRemaining <= 0 || testRemaining <= 0) {
    return {
      allow: false,
      decision: 'skipped_or_denied_slow_test',
      reason: 'insufficient review/test budget for slow or full-suite command',
      commandClass,
    };
  }

  return {
    allow: false,
    decision: 'skipped_or_denied_slow_test',
    reason: 'slow/full-suite reviewer checks are denied; CI owns exhaustive tests',
    commandClass,
  };
}

export function applyCommandBudgetDecision(
  ledger: ReviewerBudgetLedger,
  evaluation: CommandBudgetEvaluation,
): CommandBudgetEvaluation {
  if (!evaluation.allow) {
    recordTestBudgetDecision(ledger, evaluation.decision);
  }
  return evaluation;
}

export function formatDeniedCommandAudit(
  executable: string,
  argv: string[],
  evaluation: CommandBudgetEvaluation,
): string {
  return [
    'review-test-budget:',
    JSON.stringify({
      executable,
      command: flattenCommandArgv(argv),
      commandClass: evaluation.commandClass,
      decision: evaluation.decision,
      reason: evaluation.reason,
    }),
  ].join(' ');
}
