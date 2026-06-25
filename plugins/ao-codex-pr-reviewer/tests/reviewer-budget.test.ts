import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyCommandBudgetDecision,
  classifyReviewShellCommand,
  evaluateCommandBudget,
} from '../lib/command_budget.js';
import {
  createReviewerBudgetLedger,
  extractReviewerEvidenceFromText,
  formatReviewerEvidenceMarker,
  resolveEffectiveBudgetMs,
  resolveSoftDeadlineMs,
  resolveTestBudgetMs,
} from '../lib/reviewer_budget.js';
import {
  buildReviewerFailureLogLines,
  classifyReviewerFailure,
  TIMEOUT_NO_VERDICT_MESSAGE,
} from '../lib/reviewer_failure.js';
import { executeReview } from '../lib/review_core.js';

const SCOPED_ISSUE_NUMBER = 6;
const GUARD_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'bin',
  'command-guard',
);

describe('reviewer effective budget (AC#1)', () => {
  it('records effectiveBudgetMs and derived soft/test budgets', () => {
    const ledger = createReviewerBudgetLedger({
      AO_CODEX_REVIEW_EFFECTIVE_BUDGET_MS: '480000',
    });
    expect(ledger.effectiveBudgetMs).toBe(480000);
    expect(resolveSoftDeadlineMs(ledger.effectiveBudgetMs)).toBe(408000);
    expect(resolveTestBudgetMs(ledger.effectiveBudgetMs)).toBe(120000);
    expect(resolveEffectiveBudgetMs({ AO_CODEX_REVIEW_EFFECTIVE_BUDGET_MS: '480000' })).toBe(
      480000,
    );
  });

  it('executeReview timeout fixture emits reviewer evidence with effectiveBudgetMs', () => {
    const result = executeReview({
      repoRoot: process.cwd(),
      baseRef: 'origin/main',
      issueNumber: SCOPED_ISSUE_NUMBER,
      fixtureTimedOut: true,
    });
    expect(result.exitCode).toBe(1);
    const evidence = extractReviewerEvidenceFromText(result.logLines.join('\n'));
    expect(evidence?.reviewer.effectiveBudgetMs).toBeGreaterThan(0);
    expect(evidence?.reviewer.failureClass).toBe('timeout_no_verdict');
    expect(result.logLines.join('\n')).toContain(TIMEOUT_NO_VERDICT_MESSAGE);
  });
});

describe('reviewer test budget guard (AC#2)', () => {
  it('classifies PR #457-class supervisor tests as slow_test', () => {
    expect(
      classifyReviewShellCommand([
        'npm',
        'test',
        '--',
        'scripts/orchestrator-wake-supervisor.test.ts',
      ]),
    ).toBe('slow_test');
    expect(
      classifyReviewShellCommand(['npm', 'test', '--', 'orchestrator-wake-supervisor']),
    ).toBe('slow_test');
    expect(classifyReviewShellCommand(['npm', 'test'])).toBe('full_suite');
    expect(
      classifyReviewShellCommand(['pwsh', '-NoProfile', '-File', 'scripts/verify.ps1']),
    ).toBe('slow_test');
  });

  it('denies slow/full-suite commands via command_budget evaluation', () => {
    const ledger = createReviewerBudgetLedger();
    const evaluation = applyCommandBudgetDecision(
      ledger,
      evaluateCommandBudget(ledger, ['npm', 'test']),
    );
    expect(evaluation.allow).toBe(false);
    expect(evaluation.decision).toBe('skipped_or_denied_slow_test');
    expect(ledger.testBudgetDecision).toBe('skipped_or_denied_slow_test');
    const marker = formatReviewerEvidenceMarker({
      reviewer: {
        effectiveBudgetMs: ledger.effectiveBudgetMs,
        testBudgetDecision: ledger.testBudgetDecision,
      },
    });
    const parsed = extractReviewerEvidenceFromText(marker);
    expect(parsed?.reviewer.testBudgetDecision).toBe('skipped_or_denied_slow_test');
  });

  it('exec-level PATH guard blocks slow supervisor test invocation', () => {
    const ledger = createReviewerBudgetLedger({
      AO_CODEX_REVIEW_EFFECTIVE_BUDGET_MS: '600000',
      AO_CODEX_REVIEW_TEST_BUDGET_MS: '120000',
    });
    const startedMs = String(ledger.startedAtMs);
    const guardNpm = join(GUARD_DIR, 'npm');
    const result = spawnSync(
      'sh',
      [guardNpm, 'test', '--', 'scripts/orchestrator-wake-supervisor.test.ts'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${process.env.PATH ?? '/usr/bin'}`,
          AO_REVIEW_EFFECTIVE_BUDGET_MS: String(ledger.effectiveBudgetMs),
          AO_REVIEW_TEST_BUDGET_MS: String(ledger.testBudgetMs),
          AO_REVIEW_HARD_DEADLINE_MS: String(ledger.startedAtMs + ledger.effectiveBudgetMs),
          AO_REVIEW_BUDGET_STARTED_MS: startedMs,
        },
      },
    );
    expect(result.status ?? result.signal).toBe(127);
    expect(result.stderr).toContain('review-test-budget:');
    expect(result.stderr).toContain('skipped_or_denied_slow_test');
  });

  it('prompt-only skip guidance is insufficient without guard enforcement', () => {
    const ledger = createReviewerBudgetLedger();
    const slowAttempt = evaluateCommandBudget(ledger, [
      'pwsh',
      '-NoProfile',
      '-File',
      'scripts/verify.ps1',
    ]);
    expect(slowAttempt.allow).toBe(false);
    expect(slowAttempt.decision).toBe('skipped_or_denied_slow_test');
  });
});

describe('timeout/no-verdict classification (AC#3)', () => {
  it('distinguishes timeout_no_verdict from empty_output and parse_error', () => {
    const ledger = createReviewerBudgetLedger();
    expect(
      classifyReviewerFailure({
        codex: {
          exitCode: 1,
          processJsonl: '',
          lastMessage: '',
          stderr: 'reviewer timeout before verdict',
          stdout: '',
          timedOut: true,
          budgetLedger: ledger,
        },
        ledger,
      }),
    ).toBe('timeout_no_verdict');

    expect(
      classifyReviewerFailure({
        codex: {
          exitCode: 0,
          processJsonl: '',
          lastMessage: '',
          stderr: '',
          stdout: '',
          budgetLedger: ledger,
        },
        parsed: {
          kind: 'error',
          message: 'reviewer produced empty output — refusing to mark run as clean',
          verdictSource: 'last_message_fallback',
        },
        ledger,
      }),
    ).toBe('empty_output');

    expect(
      classifyReviewerFailure({
        codex: {
          exitCode: 0,
          processJsonl: '',
          lastMessage: '{bad json',
          stderr: '',
          stdout: '{bad json',
          budgetLedger: ledger,
        },
        parsed: {
          kind: 'error',
          message: 'malformed reviewer output',
          verdictSource: 'last_message_fallback',
        },
        ledger,
      }),
    ).toBe('parse_error');
  });

  it('emits structured timeout evidence marker', () => {
    const ledger = createReviewerBudgetLedger();
    const lines = buildReviewerFailureLogLines(ledger, 'timeout_no_verdict');
    const evidence = extractReviewerEvidenceFromText(lines.join('\n'));
    expect(evidence?.reviewer.failureClass).toBe('timeout_no_verdict');
    expect(evidence?.reviewer.effectiveBudgetMs).toBeGreaterThan(0);
  });

  it('executeReview empty output remains empty_output not timeout', () => {
    const result = executeReview({
      repoRoot: process.cwd(),
      baseRef: 'origin/main',
      issueNumber: SCOPED_ISSUE_NUMBER,
      fixtureStdout: '',
    });
    const evidence = extractReviewerEvidenceFromText(result.logLines.join('\n'));
    expect(evidence?.reviewer.failureClass).toBe('empty_output');
    expect(result.logLines.join('\n')).toContain('reviewer produced empty output');
    expect(result.logLines.join('\n')).not.toContain(TIMEOUT_NO_VERDICT_MESSAGE);
  });
});

describe('scenario matrix rows (AC#6 subset)', () => {
  it('verdict ready under budget stays clean when fixture is NO_FINDINGS', () => {
    const result = executeReview({
      repoRoot: process.cwd(),
      baseRef: 'origin/main',
      issueNumber: SCOPED_ISSUE_NUMBER,
      fixtureStdout: 'NO_FINDINGS',
    });
    expect(result.exitCode).toBe(0);
    expect(result.logLines.join('\n')).not.toContain('timeout_no_verdict');
  });

  it('full suite requested is denied before reviewer hard kill', () => {
    const ledger = createReviewerBudgetLedger();
    const denied = evaluateCommandBudget(ledger, ['npm', 'test']);
    expect(denied.decision).toBe('skipped_or_denied_slow_test');
    expect(denied.commandClass).toBe('full_suite');
  });
});
