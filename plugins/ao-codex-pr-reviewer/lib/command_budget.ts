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
  /\bvitest\s+run\b/i,
  /\bpnpm\s+test\b/i,
  /\byarn\s+test\b/i,
];

function isOptionToken(token: string): boolean {
  return token.startsWith('-');
}

const BOOLEAN_FLAGS = new Set([
  '--coverage',
  '--watch',
  '--run',
  '--passWithNoTests',
  '--silent',
  '--bail',
  '--changed',
  '--standalone',
  '--merge-reports',
  '-h',
  '--help',
  '--version',
]);

function optionConsumesValue(token: string): boolean {
  if (!isOptionToken(token) || token === '-') {
    return false;
  }
  if (token.includes('=')) {
    return false;
  }
  if (BOOLEAN_FLAGS.has(token)) {
    return false;
  }
  if (token.startsWith('-') && !token.startsWith('--') && token.length > 2) {
    return false;
  }
  return true;
}

export function hasPositionalSelector(argv: string[], startIndex: number): boolean {
  let index = startIndex;
  while (index < argv.length) {
    const token = argv[index]?.trim();
    if (!token) {
      index += 1;
      continue;
    }
    if (!isOptionToken(token)) {
      return true;
    }
    if (token.includes('=')) {
      index += 1;
      continue;
    }
    if (optionConsumesValue(token)) {
      index += 2;
      continue;
    }
    index += 1;
  }
  return false;
}

export function hasTargetedTestSelector(argv: string[], executable?: string): boolean {
  const parts = argv.map((part) => part.trim()).filter(Boolean);
  let vitestArgs = parts;
  let vitestExecutable = executable;

  if (executable === 'npx' && parts[0] === 'vitest') {
    vitestArgs = parts.slice(1);
    vitestExecutable = 'vitest';
  }

  if (vitestExecutable === 'vitest') {
    const selectorStart = vitestArgs[0] === 'run' ? 1 : 0;
    return hasPositionalSelector(vitestArgs, selectorStart);
  }

  let previous = '';

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === '--' && previous === 'test') {
      return hasPositionalSelector(parts, index + 1);
    }
    if (part === 'run' && previous === 'vitest') {
      return hasPositionalSelector(parts, index + 1);
    }
    previous = part;
  }
  return false;
}

export function isBareVitestFullSuiteInvocation(
  executable: string | undefined,
  commandArgs: string[],
): boolean {
  if (executable === 'vitest') {
    return !hasTargetedTestSelector(commandArgs, executable);
  }
  if (executable === 'npx' && commandArgs[0]?.trim() === 'vitest') {
    return !hasTargetedTestSelector(commandArgs, executable);
  }
  return false;
}

function hasNpmTestSeparator(argv: string[]): boolean {
  let previous = '';
  for (const part of argv.map((token) => token.trim()).filter(Boolean)) {
    if (part === '--' && previous === 'test') {
      return true;
    }
    previous = part;
  }
  return false;
}

export function flattenCommandArgv(argv: string[]): string {
  return argv.map((part) => part.trim()).filter(Boolean).join(' ');
}

export function classifyReviewShellCommand(argv: string[]): ReviewCommandClass {
  const joined = flattenCommandArgv(argv);
  const executable = argv[0]?.trim();
  const commandArgs = argv.slice(1);
  if (!joined) {
    return 'cheap_targeted';
  }

  if (SLOW_TEST_MARKERS.some((pattern) => pattern.test(joined))) {
    return 'slow_test';
  }
  if (hasTargetedTestSelector(commandArgs, executable)) {
    return 'cheap_targeted';
  }
  if (isBareVitestFullSuiteInvocation(executable, commandArgs)) {
    return 'full_suite';
  }
  if (hasNpmTestSeparator(argv) || FULL_SUITE_MARKERS.some((pattern) => pattern.test(joined))) {
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
