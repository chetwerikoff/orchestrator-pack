import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CREATE_ISSUE_MANAGER_ENTRYPOINTS,
  createIssueEscalationThreadId,
  emitCreateIssueManagerResult,
  evaluateCreateIssueManagerBoundary,
  evaluateLegacyCreateIssueManagerBoundaryRead,
} from './create-issue-manager-boundary.ts';
import {
  CREATE_ISSUE_NEXT_ACTION_KINDS,
  createIssueExternalPauseResult,
  createIssueNextAction,
  createIssueRecoverableResult,
  createIssueTerminalResult,
  evaluateCreateIssueManagerBoundary as evaluateNextActionManagerBoundary,
  evaluateLegacyCreateIssueManagerBoundaryRead as evaluateLegacyNextActionManagerBoundaryRead,
  validateCreateIssueManagerResult,
  normalizeLegacyResumePredicateInManagerResult,
  type CreateIssueActionBinding,
} from './create-issue-next-action.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function productionTsFiles(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      out.push(...productionTsFiles(path));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}

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
  it('retains legacy manager helpers only as non-acceptance compatibility after Issue #2256 cutover', () => {
    const boundary = readFileSync(join(repoRoot, 'scripts/lib/create-issue-manager-boundary.ts'), 'utf8');
    const actions = readFileSync(join(repoRoot, 'scripts/lib/create-issue-next-action.ts'), 'utf8');
    expect(boundary).toContain('NOT create-Issue review-completion or');
    expect(boundary).toContain('per-round author dispositions');
    expect(boundary).toContain('Historical cleanup of unreachable producers is deliberately deferred');
    expect(actions).toContain('not a source of create-Issue review or label authority');
    // Preserve the existing execute-Issue and sender compatibility contracts:
    expect(CREATE_ISSUE_NEXT_ACTION_KINDS).toContain('execute-github-first-read-only');
    expect(CREATE_ISSUE_MANAGER_ENTRYPOINTS).toContain('flow-manager-browser-gpt-long-run.ts:main');
  });

  it('documents Issue #2256 published-comment acceptance and real brief text in the active owners', () => {
    const skill = readFileSync(join(repoRoot, '.cursor/skills/create-issue-draft/SKILL.md'), 'utf8');
    const tiering = readFileSync(join(repoRoot, 'docs/tiering.md'), 'utf8');
    const carrier = readFileSync(join(repoRoot, '.cursor/rules/flow-manager-browser-turn-monitoring.mdc'), 'utf8');
    const authorPrompt = readFileSync(join(repoRoot, 'docs/browser-gpt-turn-runbook.md'), 'utf8');
    expect(skill).toContain('**every required round**');
    expect(skill).toContain('without awaiting its envelope');
    expect(skill).toContain('single permitted post-terminal correction');
    expect(skill).toContain('one required Claude architectural-lens');
    expect(tiering).toContain('No T3 competitive stage');
    expect(carrier).toContain('Already-published review');
    expect(carrier).toContain('create-Issue label/review authority');
    expect(authorPrompt).toContain('<BRIEF_TEXT>');
    expect(authorPrompt).not.toContain('<BRIEF_REFERENCE>');
    expect(authorPrompt).toContain('never pass a local path');
  });

  it('maps the four outcomes to one JSON object and exit codes 0/3/4/5', () => {
    const fixtures = [
      { expected: 0, value: createIssueTerminalResult({ ok: true, cause: 'completed' }) },
      { expected: 3, value: createIssueRecoverableResult({ cause: 'reconciliation_ready', nextAction: action(['reconcile']) }) },
      {
        expected: 4,
        value: createIssueExternalPauseResult({
          cause: 'external:github_unavailable',
          remedy: 'restore GitHub',
          resumeWhen: { coordinator: true },
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

  it('consumes legacy operator pause input only through the historical-read adapter without mutating bytes', () => {
    const legacy = {
      ok: false,
      cause: 'external:github_unavailable',
      pause: {
        remedy: 'restore GitHub',
        resume_when: { operator: true },
        evidence: 'historical HTTP 503',
      },
      nextAction: null,
    };
    const historicalBytes = JSON.stringify(legacy);
    const normalized = normalizeLegacyResumePredicateInManagerResult(legacy);
    expect(normalized).toMatchObject({
      pause: { resume_when: { coordinator: true } },
    });
    expect(validateCreateIssueManagerResult(legacy)).toContain(
      'external_pause result.pause.resume_when must be issue_closed, pr_merged, or coordinator',
    );

    for (const strictProduced of [evaluateCreateIssueManagerBoundary, evaluateNextActionManagerBoundary]) {
      expect(strictProduced({
        producer: 'legacy-pause-must-not-be-emitted',
        currentArgv: ['current'],
        produce: () => legacy,
      })).toMatchObject({
        exitCode: 5,
        result: { cause: 'producer_contract_defect', nextAction: null },
      });
    }

    for (const historicalRead of [evaluateLegacyCreateIssueManagerBoundaryRead, evaluateLegacyNextActionManagerBoundaryRead]) {
      expect(historicalRead({
        producer: 'persisted-live-manager-result',
        currentArgv: ['current'],
        produce: () => legacy,
      })).toMatchObject({
        exitCode: 4,
        result: {
          cause: 'external:github_unavailable',
          pause: { resume_when: { coordinator: true } },
          nextAction: null,
        },
      });
    }
    expect(JSON.stringify(legacy)).toBe(historicalBytes);
  });

  it('rejects a producer-constructed contract_defect and reconstructs it at the boundary', () => {
    const evaluated = evaluateCreateIssueManagerBoundary({
      producer: 'producer-that-tried-to-forge-defect',
      currentArgv: ['current'],
      produce: () => ({
        ok: false,
        cause: 'producer_contract_defect',
        defect: {
          producer: 'forged-producer',
          detail: ['forged'],
        },
        nextAction: null,
      }),
    });
    expect(evaluated.exitCode).toBe(5);
    expect(evaluated.result).toMatchObject({
      cause: 'producer_contract_defect',
      defect: {
        producer: 'producer-that-tried-to-forge-defect',
      },
    });
    expect(
      evaluated.result.ok === false && 'defect' in evaluated.result
        ? evaluated.result.defect.detail.join('\n')
        : '',
    ).toContain('contract_defect may only be constructed by the manager boundary');
  });

  it('turns a byte-identical recommendation into self_recommendation without executing it', () => {
    const argv = ['node', 'scripts/create-issue-stage-finalize.ts', 'reconcile-stage', '--expected-stage-attempt-id', '316369ff'];
    const evaluated = evaluateCreateIssueManagerBoundary({
      producer: 'reconcile-stage',
      currentArgv: argv,
      produce: () => createIssueRecoverableResult({
        cause: 'reconciliation_ready',
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

  it('keeps stale producer throws inside the boundary as readonly recovery', () => {
    const reconciliation = action(['node', 'reconcile-read-only']);
    const evaluated = evaluateCreateIssueManagerBoundary({
      producer: 'stale-producer',
      currentArgv: ['current'],
      reconcileAction: reconciliation,
      produce: () => { throw new Error('stale_next_action: source revision moved'); },
    });
    expect(evaluated.exitCode).toBe(3);
    expect(evaluated.result).toMatchObject({
      ok: false,
      cause: 'stale_next_action_reconciliation',
      nextAction: reconciliation,
    });
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

    const stageCli = readFileSync(join(repoRoot, 'scripts/lib/create-issue-stage-record-cli.ts'), 'utf8');
    const browserCarrier = readFileSync(join(repoRoot, 'scripts/flow-manager-browser-gpt-long-run.ts'), 'utf8');
    expect(stageCli).toContain('emitCreateIssueManagerResult');
    expect(browserCarrier).toContain('emitCreateIssueManagerResult');
    expect(stageCli).not.toContain('console.log(JSON.stringify(output))');
    expect(browserCarrier).not.toContain('process.stdout.write(`${JSON.stringify(');
  });

  it('keeps the closed kind registry equal to production createIssueNextAction literals', () => {
    const produced = new Set<string>();
    for (const file of productionTsFiles(join(repoRoot, 'scripts'))) {
      const source = readFileSync(file, 'utf8');
      let cursor = 0;
      while ((cursor = source.indexOf('createIssueNextAction({', cursor)) >= 0) {
        const fragment = source.slice(cursor, cursor + 800);
        const literal = /\bkind:\s*'([^']+)'/.exec(fragment)?.[1];
        if (literal) produced.add(literal);
        cursor += 'createIssueNextAction({'.length;
      }
    }
    expect([...produced].sort()).toEqual([...CREATE_ISSUE_NEXT_ACTION_KINDS].sort());
  });

  it('frames all four outcomes once for every registered manager entrypoint', () => {
    for (const producer of CREATE_ISSUE_MANAGER_ENTRYPOINTS) {
      const cases = [
        { exitCode: 0, produce: () => createIssueTerminalResult({ ok: true, cause: 'completed' }) },
        { exitCode: 3, produce: () => createIssueRecoverableResult({ cause: 'retry', nextAction: action(['retry']) }) },
        {
          exitCode: 4,
          produce: () => createIssueExternalPauseResult({
            cause: 'external:github_unavailable',
            remedy: 'restore GitHub',
            resumeWhen: { coordinator: true },
            evidence: 'HTTP 503',
          }),
        },
        { exitCode: 5, produce: () => ({ ok: false, cause: 'broken', nextAction: null }) },
      ] as const;
      for (const fixture of cases) {
        const writes: string[] = [];
        const result = emitCreateIssueManagerResult({
          producer,
          currentArgv: ['current-entrypoint'],
          produce: fixture.produce,
          stdout: (value) => writes.push(value),
        });
        expect(result.exitCode).toBe(fixture.exitCode);
        expect(writes).toHaveLength(1);
        expect(() => JSON.parse(writes[0]!)).not.toThrow();
      }

      const writes: string[] = [];
      const thrown = emitCreateIssueManagerResult({
        producer,
        currentArgv: ['current-entrypoint'],
        produce: () => { throw new Error('result construction failed'); },
        stdout: (value) => writes.push(value),
      });
      expect(thrown.exitCode).toBe(5);
      expect(writes).toHaveLength(1);
      const emitted = JSON.parse(writes[0]!) as unknown;
      expect(validateCreateIssueManagerResult(emitted, { boundary: true })).toEqual([]);
      expect(emitted).toMatchObject({
        ok: false,
        cause: 'producer_contract_defect',
        defect: { producer },
        nextAction: null,
      });
    }
  });
});
