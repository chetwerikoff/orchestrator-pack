import { describe, expect, it } from 'vitest';
import {
  CREATE_ISSUE_MANAGER_ENTRYPOINTS,
  createIssueEscalationThreadId,
  emitCreateIssueManagerResult,
  evaluateCreateIssueManagerBoundary,
} from './create-issue-manager-boundary.ts';
import {
  createIssueExternalPauseResult,
  createIssueNextAction,
  createIssueRecoverableResult,
  createIssueTerminalResult,
  validateCreateIssueManagerResult,
  type CreateIssueActionBinding,
} from './create-issue-next-action.ts';

const binding: CreateIssueActionBinding = {
  repository: 'chetwerikoff/orchestrator-pack',
  issueNumber: 2078,
  sourceRevision: 'r02',
  stage: 'architectural-review',
  stageAttemptId: 'attempt-2078',
};

function action(argv: readonly string[]) {
  return createIssueNextAction({
    kind: 'reconcile-stage-read-only',
    binding,
    argv,
  });
}

describe('create-Issue manager boundary', () => {
  it('maps the four outcomes to one JSON object and exit codes 0/3/4/5', () => {
    const fixtures = [
      { expected: 0, value: createIssueTerminalResult({ ok: true, cause: 'completed' }) },
      { expected: 3, value: createIssueRecoverableResult({ cause: 'stale_next_action', nextAction: action(['reconcile']) }) },
      {
        expected: 4,
        value: createIssueExternalPauseResult({
          cause: 'external:github_unavailable',
          remedy: 'restore GitHub',
          resumeWhen: { operator: true },
          evidence: 'HTTP 503',
        }),
      },
    ] as const;
    for (const fixture of fixtures) {
      const writes: string[] = [];
      const evaluated = emitCreateIssueManagerResult({
        producer: 'fixture',
        currentArgv: ['current'],
        produce: () => fixture.value,
        stdout: (text) => writes.push(text),
      });
      expect(evaluated.exitCode).toBe(fixture.expected);
      expect(writes).toHaveLength(1);
      expect(() => JSON.parse(writes[0]!)).not.toThrow();
    }

    const defect = evaluateCreateIssueManagerBoundary({
      producer: 'fixture-producer',
      currentArgv: ['current'],
      produce: () => ({ ok: false, cause: 'broken', nextAction: null }),
    });
    expect(defect.exitCode).toBe(5);
    expect(defect.result).toMatchObject({
      ok: false,
      cause: 'producer_contract_defect',
      defect: { producer: 'fixture-producer' },
      nextAction: null,
    });
    expect(validateCreateIssueManagerResult(defect.result, { boundary: true })).toEqual([]);
    expect(validateCreateIssueManagerResult(defect.result)).toContain(
      'contract_defect may only be constructed by the manager boundary',
    );
  });

  it('turns a byte-identical recommendation into self_recommendation without executing it', () => {
    const argv = ['node', 'scripts/create-issue-stage-finalize.ts', 'reconcile-stage', '--expected-stage-attempt-id', '316369ff'];
    const evaluated = evaluateCreateIssueManagerBoundary({
      producer: 'reconcile-stage',
      currentArgv: argv,
      produce: () => createIssueRecoverableResult({
        cause: 'stale_next_action',
        nextAction: action(argv),
      }),
    });
    expect(evaluated.exitCode).toBe(5);
    expect(evaluated.result).toMatchObject({
      cause: 'self_recommendation',
      defect: { producer: 'reconcile-stage' },
    });
  });

  it('converts a producer throw into contract_defect and keeps a readonly reconciliation when supplied', () => {
    const reconciliation = action(['node', 'reconcile-read-only']);
    const recoverable = evaluateCreateIssueManagerBoundary({
      producer: 'deep-evidence-producer',
      currentArgv: ['current'],
      reconcileAction: reconciliation,
      produce: () => { throw new Error('unexpected repository invariant'); },
    });
    expect(recoverable.exitCode).toBe(3);
    expect(recoverable.result).toMatchObject({ ok: false, nextAction: reconciliation });

    const defect = evaluateCreateIssueManagerBoundary({
      producer: 'deep-evidence-producer',
      currentArgv: ['current'],
      produce: () => { throw new Error('unexpected repository invariant'); },
    });
    expect(defect.exitCode).toBe(5);
    expect(defect.result).toMatchObject({ cause: 'producer_contract_defect' });
  });

  it('classifies exhausted reviewer transport by recorded external causes only', () => {
    const paused = evaluateCreateIssueManagerBoundary({
      producer: 'reviewer-slot-01',
      currentArgv: ['current'],
      retryBudgetEvidence: {
        reviewerSlot: '01',
        externalCauses: ['HTTP 503 from GitHub', 'HTTP 503 from GitHub'],
      },
      produce: () => { throw new Error('reviewerSlot 01 retry budget is exhausted'); },
    });
    expect(paused.exitCode).toBe(4);
    expect(paused.result).toMatchObject({ cause: 'external:github_unavailable' });

    const defect = evaluateCreateIssueManagerBoundary({
      producer: 'reviewer-slot-01',
      currentArgv: ['current'],
      retryBudgetEvidence: {
        reviewerSlot: '01',
        externalCauses: ['argument_mode_invalid', 'argument_mode_invalid'],
      },
      produce: () => { throw new Error('reviewerSlot 01 retry budget is exhausted'); },
    });
    expect(defect.exitCode).toBe(5);
    expect(defect.result).toMatchObject({ cause: 'producer_contract_defect' });
  });

  it('keeps escalation thread ids deterministic for the same issue/stage/cause/resume predicate', () => {
    const input = {
      issueNumber: 2078,
      stage: 'architectural-review' as const,
      cause: 'external:waiting_on_pr',
      resumeWhen: { pr: 1885, condition: 'pr_merged' as const },
    };
    expect(createIssueEscalationThreadId(input)).toBe(createIssueEscalationThreadId(input));
    expect(createIssueEscalationThreadId(input)).not.toBe(createIssueEscalationThreadId({
      ...input,
      resumeWhen: { pr: 1886, condition: 'pr_merged' as const },
    }));
  });

  it('enumerates the complete manager-facing entrypoint registry', () => {
    expect(CREATE_ISSUE_MANAGER_ENTRYPOINTS).toEqual([
      'create-issue-stage-record-cli.ts:main',
      'flow-manager-browser-gpt-long-run.ts:main',
      'create-issue-browser-gpt-preflight.ts:caller',
    ]);
  });
});
