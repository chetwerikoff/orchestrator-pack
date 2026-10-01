// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120
import { describe, expect, it } from 'vitest';
import { TURN_STATES } from '../chatgpt-browser-turn/contracts.ts';
import type { ProbeStatus } from '../browser-gpt-page-probe.ts';
import {
  CREATE_ISSUE_NEXT_ACTION_KINDS,
  createIssueNextAction,
  validateCreateIssueManagerResult,
} from './create-issue-next-action.ts';
import {
  EXECUTE_ISSUE_PROBE_CLASSIFICATION,
  EXECUTE_ISSUE_TURN_CLASSIFICATION,
  classifyExecuteIssueManagerRecord,
  isExecuteIssueReadOnlyArgv,
  type ExecuteIssueManagerBoundaryContext,
} from './execute-issue-manager-boundary.ts';
import { runExecuteIssueManagerBoundaryCli } from '../execute-issue-manager-boundary.ts';

const context: ExecuteIssueManagerBoundaryContext = {
  repository: 'chetwerikoff/orchestrator-pack', issueNumber: 2081, sourceRevision: 'r03', phase: 'independent-smoke',
  productionArgv: ['node', 'scripts/execute-issue-manager-boundary.ts', 'classify'],
  cdp: 'http://127.0.0.1:9222', conversationUrl: 'https://chatgpt.com/c/owned-2081', prNumber: 2083,
  headSha: 'a'.repeat(40),
};
function turn(state: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: 'turn-result/v1', state, scope: 'invocation', cause: state, invocation_id: 'invocation-2081', configured_profile_key: 'profile-2081', conversation_id: 'owned-2081', ...overrides };
}
function probe(status: ProbeStatus, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: 'browser-gpt-page-probe/v1', operation: 'inspect', status, diagnostic_only: true, workflow_authority: 'none', target_id: 'target-2081', ...overrides };
}
function smoke(
  result: 'PASS' | 'FAIL' | 'BLOCKED',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const scenarioCauseFamily = typeof overrides.causeFamily === 'string'
    && ['scenario_precondition_unavailable', 'scenario_assertion_failed', 'scenario_evidence_missing'].includes(overrides.causeFamily)
    ? overrides.causeFamily
    : undefined;
  return {
    schema: 'pack-worker-smoke-report/v1',
    producer: 'orchestrator-pack/worker-smoke-run/v1',
    result,
    issueNumber: context.issueNumber,
    prNumber: context.prNumber,
    headSha: context.headSha,
    trackedFilesUnmodified: result === 'PASS',
    terminalCleanup: result === 'PASS' ? 'closed_owned_handle' : 'not_recorded',
    orcaExecutable: result === 'PASS' ? 'orca' : undefined,
    terminalHandle: result === 'PASS' ? 'term_fixture' : undefined,
    scenarios: [{
      action: 'exercise smoke fixture',
      expected: 'fixture expectation',
      observed: 'fixture observation',
      outcome: result === 'PASS' ? 'pass' : result === 'FAIL' ? 'fail' : 'blocked',
      ...(scenarioCauseFamily ? { causeFamily: scenarioCauseFamily } : {}),
    }],
    ...overrides,
  };
}

function actionOf(evaluated: ReturnType<typeof classifyExecuteIssueManagerRecord>) {
  return evaluated.result.ok === false && 'nextAction' in evaluated.result ? evaluated.result.nextAction : null;
}
function expectReadOnly(evaluated: ReturnType<typeof classifyExecuteIssueManagerRecord>) {
  const action = actionOf(evaluated);
  expect(action).not.toBeNull();
  expect(isExecuteIssueReadOnlyArgv(action!.argv)).toBe(true);
  return action!;
}

describe('execute-Issue manager boundary', () => {
  it('covers every TURN_STATES and ProbeStatus entry', () => {
    expect(Object.keys(EXECUTE_ISSUE_TURN_CLASSIFICATION).sort()).toEqual([...TURN_STATES].sort());
    expect(Object.keys(EXECUTE_ISSUE_PROBE_CLASSIFICATION).sort()).toEqual([
      'ok', 'not_found', 'ambiguous', 'stale_node', 'unsafe_output', 'surface_unknown', 'unavailable',
      'export_failed', 'cleanup_failed', 'input_invalid',
    ].sort());
  });

  it('keeps execute next actions closed and read-only', () => {
    expect(CREATE_ISSUE_NEXT_ACTION_KINDS.filter((kind) => kind.startsWith('execute-'))).toEqual([
      'execute-observe-owned-turn', 'execute-github-first-read-only', 'execute-review-runner-read-only',
    ]);
    expect(validateCreateIssueManagerResult({
      ok: false, cause: 'invalid', nextAction: {
        schema: 'create-issue-next-action/v1', kind: 'execute-send-replacement', binding: {
          repository: context.repository, issueNumber: context.issueNumber, sourceRevision: context.sourceRevision, stage: 'execute:implementation',
        }, argv: ['send'],
      },
    })).toContain('nextAction.kind is outside the closed manager kind set');
  });

  it('projects successful and recoverable turn results', () => {
    expect(classifyExecuteIssueManagerRecord(turn('ok'), context)).toMatchObject({ exitCode: 0, result: { ok: true, nextAction: null } });
    const evaluated = classifyExecuteIssueManagerRecord(turn('observation_uncertain'), context);
    expect(evaluated.exitCode).toBe(3);
    expect(expectReadOnly(evaluated).kind).toBe('execute-observe-owned-turn');
    expect(expectReadOnly(classifyExecuteIssueManagerRecord(turn('orphaned_fresh_turn', { conversation_id: undefined }), { ...context, targetId: undefined, conversationUrl: undefined })).kind).toBe('execute-observe-owned-turn');
  });

  it('pauses when recoverable observation has no retained CDP surface', () => {
    const evaluated = classifyExecuteIssueManagerRecord(
      turn('observation_uncertain'),
      { ...context, cdp: undefined },
    );
    expect(evaluated.exitCode).toBe(4);
    expect(evaluated.result).toMatchObject({
      cause: 'external:chrome_not_running',
      pause: { resume_when: { coordinator: true } },
      nextAction: null,
    });
  });

  it('projects typed external pauses and retains producer evidence', () => {
    const turnPause = classifyExecuteIssueManagerRecord(turn('chrome_not_running', { scope: 'machine' }), context);
    expect(turnPause.exitCode).toBe(4);
    expect(turnPause.result).toMatchObject({ cause: 'external:chrome_not_running', pause: { resume_when: { coordinator: true } }, nextAction: null });
    const envelope = probe('ambiguous', { reason: 'owned marker conflict', evidence_token: 'evidence-2081' });
    const probePause = classifyExecuteIssueManagerRecord(envelope, context);
    expect(probePause.exitCode).toBe(4);
    expect(probePause.result).toMatchObject({ cause: 'external:content_authority_conflict' });
    if (probePause.result.ok !== false || !('pause' in probePause.result)) throw new Error('expected pause');
    expect(JSON.parse(probePause.result.pause.evidence)).toEqual(envelope);
  });

  it('uses GitHub-first reconciliation for the supported conversation causes', () => {
    for (const cause of [
      'message_delivery_timed_out',
      'product_network_error',
      'message_stream_error',
      'stream_recovery_polling_timed_out',
      'product_error_banner',
    ]) {
      const evaluated = classifyExecuteIssueManagerRecord(turn('recovery_required', { scope: 'conversation', cause }), context);
      expect(evaluated.exitCode).toBe(3);
      const action = expectReadOnly(evaluated);
      expect(action.kind).toBe('execute-github-first-read-only');
      expect(action.argv).toEqual(['scripts/gh', 'issue', 'view', '2081', '--json', 'state,title,body,closedAt']);
    }
  });

  it('keeps probe observation read-only until stopped recovery is proven', () => {
    expect(expectReadOnly(classifyExecuteIssueManagerRecord(probe('not_found'), context)).kind).toBe('execute-observe-owned-turn');
    expect(expectReadOnly(classifyExecuteIssueManagerRecord(probe('ok', { execution_recovery_inspect: { cause: null, generation_in_progress: true } }), context)).kind).toBe('execute-observe-owned-turn');
    for (const cause of ['product_network_error', 'message_stream_error', 'stream_recovery_polling_timed_out']) {
      expect(expectReadOnly(classifyExecuteIssueManagerRecord(probe('ok', { execution_recovery_inspect: { cause, generation_in_progress: false } }), context)).kind).toBe('execute-github-first-read-only');
    }
    expect(classifyExecuteIssueManagerRecord(probe('ok', { execution_recovery_inspect: { reason: 'ambiguous_marker' } }), context)).toMatchObject({ exitCode: 4, result: { cause: 'external:content_authority_conflict' } });
    const unsafe = classifyExecuteIssueManagerRecord(probe('unsafe_output', { reason: 'unsafe-evidence-2081' }), context);
    expect(unsafe.exitCode).toBe(5);
    expect(JSON.stringify(unsafe.result)).toContain('unsafe-evidence-2081');
  });

  it('projects review runner success, read-only pass-through, and external failure', () => {
    expect(classifyExecuteIssueManagerRecord({ ok: true, prNumber: 2083 }, { ...context, phase: 'review' })).toMatchObject({ exitCode: 0 });
    const action = createIssueNextAction({ kind: 'execute-review-runner-read-only', binding: { ...context, stage: 'execute:review' }, argv: ['scripts/gh', 'pr', 'view', '2083', '--json', 'state'] });
    expect(classifyExecuteIssueManagerRecord({ ok: false, nextAction: action }, { ...context, phase: 'review' })).toMatchObject({ exitCode: 3, result: { nextAction: action } });
    const send = classifyExecuteIssueManagerRecord({ ok: false, nextAction: { schema: 'create-issue-next-action/v1', kind: 'retry-start-cycle', binding: { ...context, stage: 'execute:review' }, argv: ['node', 'scripts/chatgpt-browser-turn.ts', '--new-chat'] } }, { ...context, phase: 'review' });
    expect(expectReadOnly(send).kind).toBe('execute-review-runner-read-only');
    expect(classifyExecuteIssueManagerRecord({ ok: false, outcome: 'review_target_unavailable', reason: 'GitHub HTTP 503', prNumber: 2083 }, { ...context, phase: 'review' })).toMatchObject({ exitCode: 4, result: { cause: 'external:github_unavailable' } });
  });

  it('projects worker-smoke through the four manager outcomes without prose inference', () => {
    expect(classifyExecuteIssueManagerRecord(smoke('PASS'), context)).toMatchObject({
      exitCode: 0,
      result: { ok: true, verdict: 'PASS', cause: 'execute_worker_smoke_pass', nextAction: null },
    });
    expect(classifyExecuteIssueManagerRecord(smoke('PASS', {
      scenarios: [{
        action: 'exercise smoke fixture',
        expected: 'fixture expectation',
        observed: 'blocked despite PASS',
        outcome: 'blocked',
      }],
    }), context)).toMatchObject({
      exitCode: 5,
      result: { ok: false, cause: 'producer_contract_defect', nextAction: null },
    });
    expect(classifyExecuteIssueManagerRecord(smoke('PASS', {
      terminalCleanup: 'not_recorded',
      terminalHandle: undefined,
    }), context)).toMatchObject({
      exitCode: 5,
      result: { ok: false, cause: 'producer_contract_defect', nextAction: null },
    });

    const assertionFailure = smoke('FAIL', {
      causeFamily: 'scenario_assertion_failed',
      nonPassCause: 'executed_scenario_failure',
      scenarios: [{
        action: 'assert behavior',
        expected: 'expected behavior',
        observed: 'actual mismatch',
        outcome: 'fail',
        causeFamily: 'scenario_assertion_failed',
      }],
    });
    expect(classifyExecuteIssueManagerRecord(assertionFailure, context)).toMatchObject({
      exitCode: 0,
      result: { ok: true, verdict: 'FAIL', cause: 'execute_worker_smoke_assertion_failed', nextAction: null },
    });

    expect(classifyExecuteIssueManagerRecord(smoke('FAIL', {
      causeFamily: 'scenario_assertion_failed',
      nonPassCause: 'executed_scenario_failure',
      scenarios: [
        {
          action: 'assert behavior',
          expected: 'expected behavior',
          observed: 'actual mismatch',
          outcome: 'fail',
          causeFamily: 'scenario_assertion_failed',
        },
        {
          action: 'later scenario must not run',
          expected: 'not reached',
          observed: 'contradictory second terminal',
          outcome: 'blocked',
          causeFamily: 'scenario_precondition_unavailable',
        },
      ],
    }), context)).toMatchObject({
      exitCode: 5,
      result: { ok: false, cause: 'producer_contract_defect', nextAction: null },
    });

    expect(classifyExecuteIssueManagerRecord(smoke('BLOCKED', {
      causeFamily: 'scenario_precondition_unavailable',
      nonPassCause: 'login_required',
      scenarios: [{
        action: 'assert behavior',
        expected: 'expected behavior',
        observed: 'actual mismatch',
        outcome: 'fail',
        causeFamily: 'scenario_assertion_failed',
      }],
    }), context)).toMatchObject({
      exitCode: 5,
      result: { ok: false, cause: 'producer_contract_defect', nextAction: null },
    });

    for (const nonPassCause of ['trusted_target_stale']) {
      const projected = classifyExecuteIssueManagerRecord(smoke('BLOCKED', {
        causeFamily: 'harness_admission_refused',
        nonPassCause,
      }), context);
      expect(projected.exitCode).toBe(3);
      const action = expectReadOnly(projected);
      expect(action.binding.stage).toBe('execute:independent-smoke');
      expect(action.argv.slice(0, 4)).toEqual([
        'node',
        '--experimental-strip-types',
        'scripts/execute-issue-manager-boundary.ts',
        'observe-worker-smoke-recoverable',
      ]);
      expect(action.argv).toEqual(expect.arrayContaining([
        '--repo', context.repository,
        '--issue-number', String(context.issueNumber),
        '--pr-number', String(context.prNumber),
        '--head-sha', context.headSha!,
        '--source-revision', context.sourceRevision,
        '--phase', 'independent-smoke',
        '--cause', nonPassCause,
      ]));
    }

    const externalCases = [
      ['browser_cdp_unavailable', 'external:chrome_not_running'],
      ['profile_mismatch', 'external:profile_mismatch'],
      ['login_required', 'external:login_required'],
      ['quota_exhausted', 'external:quota_exhausted'],
      ['product_challenge', 'external:product_challenge'],
    ] as const;
    for (const [nonPassCause, cause] of externalCases) {
      const projected = classifyExecuteIssueManagerRecord(smoke('BLOCKED', {
        causeFamily: 'scenario_precondition_unavailable',
        nonPassCause,
      }), context);
      expect(projected).toMatchObject({
        exitCode: 4,
        result: { cause, pause: { resume_when: { coordinator: true }, remedy: expect.any(String) }, nextAction: null },
      });
      if (projected.result.ok !== false || !('pause' in projected.result)) throw new Error('expected worker-smoke pause');
      const structured = JSON.parse(projected.result.pause.evidence);
      expect(structured).toMatchObject({
        marker: 'pack-worker-smoke-report/v1',
        issueNumber: context.issueNumber,
        prNumber: context.prNumber,
        headSha: context.headSha,
        nonPassCause,
      });
      expect(JSON.stringify(structured)).not.toContain('fixture observation');
    }

    expect(classifyExecuteIssueManagerRecord(smoke('FAIL', {
      causeFamily: 'harness_admission_refused',
      nonPassCause: 'profile_mismatch',
    }), context)).toMatchObject({
      exitCode: 5,
      result: { cause: 'producer_contract_defect', nextAction: null },
    });
    expect(classifyExecuteIssueManagerRecord(smoke('BLOCKED', {
      causeFamily: 'harness_admission_refused',
      nonPassCause: 'profile_mismatch',
    }), context)).toMatchObject({
      exitCode: 5,
      result: { cause: 'producer_contract_defect', nextAction: null },
    });

    for (const nonPassCause of [
      'invalid_adapter_arguments',
      'missing_required_flag',
      'unsupported_executor_capability',
      'malformed_producer_output',
      'unknown_new_code',
    ]) {
      expect(classifyExecuteIssueManagerRecord(smoke('BLOCKED', {
        causeFamily: 'harness_admission_refused',
        nonPassCause,
      }), context)).toMatchObject({
        exitCode: 5,
        result: { cause: 'producer_contract_defect', nextAction: null },
      });
    }

    const proseOnly = smoke('BLOCKED', {
      causeFamily: 'scenario_precondition_unavailable',
      scenarios: [{
        action: 'open browser',
        expected: 'authenticated browser',
        observed: 'login quota challenge chrome unavailable',
        outcome: 'blocked',
        causeFamily: 'scenario_precondition_unavailable',
      }],
    });
    expect(classifyExecuteIssueManagerRecord(proseOnly, context)).toMatchObject({
      exitCode: 5,
      result: { cause: 'producer_contract_defect' },
    });

    expect(classifyExecuteIssueManagerRecord(smoke('FAIL', {
      causeFamily: 'scenario_assertion_failed',
      nonPassCause: 'login_required',
      scenarios: [{
        action: 'assert behavior',
        expected: 'expected',
        observed: 'mismatch',
        outcome: 'fail',
        causeFamily: 'scenario_assertion_failed',
      }],
    }), context)).toMatchObject({ exitCode: 5, result: { cause: 'producer_contract_defect' } });
  });

  it('rejects worker-smoke binding drift before classification', () => {
    expect(classifyExecuteIssueManagerRecord(smoke('PASS', { headSha: 'b'.repeat(40) }), context)).toMatchObject({
      exitCode: 0,
      result: { ok: true, verdict: 'PASS', cause: 'execute_worker_smoke_pass' },
    });
    expect(classifyExecuteIssueManagerRecord(smoke('PASS', { prNumber: 9999 }), context)).toMatchObject({
      exitCode: 5,
      result: { cause: 'producer_contract_defect' },
    });
  });

  it('requires independent-smoke context and preserves read-only observer for trusted-target staleness', () => {
    expect(classifyExecuteIssueManagerRecord(smoke('PASS'), { ...context, phase: 'implementation' })).toMatchObject({
      exitCode: 5, result: { cause: 'producer_contract_defect' },
    });


    const output: string[] = [];
    const errors: string[] = [];
    const code = runExecuteIssueManagerBoundaryCli([
      'classify', '--record', '/fixture/smoke.json', '--repo', context.repository,
      '--issue-number', String(context.issueNumber), '--source-revision', context.sourceRevision,
      '--phase', 'independent-smoke', '--production-argv-json', JSON.stringify(context.productionArgv),
      '--pr-number', String(context.prNumber), '--head-sha', context.headSha,
    ], {
      readFile: () => JSON.stringify(smoke('BLOCKED', { causeFamily: 'harness_admission_refused', nonPassCause: 'trusted_target_stale' })),
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      currentArgv: ['node', 'scripts/execute-issue-manager-boundary.ts', 'classify'],
    });
    expect(code).toBe(3);
    expect(errors).toEqual([]);
    const projected = JSON.parse(output[0]!) as { nextAction: { binding: { stage: string }; argv: string[] } };
    expect(projected.nextAction.binding.stage).toBe('execute:independent-smoke');
    expect(projected.nextAction.argv.join(' ')).toContain(context.headSha);
    expect(projected.nextAction.argv).toContain(String(context.prNumber));
    expect(projected.nextAction.argv).toContain(String(context.issueNumber));
  });

  it('observes recoverable worker-smoke state with the full exact-target binding', () => {
    const output: string[] = [];
    const calls: string[][] = [];
    const okResult = (stdout: string) => ({
      outcome: 'exit' as const,
      ok: true,
      exitCode: 0,
      signal: null,
      stdout,
      stderr: '',
      timedOut: false,
      cancelled: false,
    });
    const code = runExecuteIssueManagerBoundaryCli([
      'observe-worker-smoke-recoverable',
      '--repo', context.repository,
      '--issue-number', String(context.issueNumber),
      '--pr-number', String(context.prNumber),
      '--head-sha', context.headSha!,
      '--source-revision', context.sourceRevision,
      '--phase', 'independent-smoke',
      '--cause', 'trusted_target_stale',
    ], {
      stdout: { write: (value) => output.push(value) },
      stderr: { write: () => undefined },
      runGitHubRead: (args) => {
        calls.push([...args]);
        if (args[0] === 'pr') {
          return okResult(JSON.stringify({
            number: context.prNumber,
            headRefOid: context.headSha,
            body: 'Closes #' + context.issueNumber,
          }));
        }
        return okResult(JSON.stringify({
          number: context.issueNumber,
          state: 'OPEN',
          body: '<!-- source-revision: ' + context.sourceRevision + ' -->',
          labels: [{ name: 'spec-review:accepted' }],
        }));
      },
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(output[0]!)).toMatchObject({
      ok: true,
      phase: 'independent-smoke',
      cause: 'trusted_target_stale',
      issueNumber: context.issueNumber,
      prNumber: context.prNumber,
      headSha: context.headSha,
      issue: { sourceRevisionPresent: true },
      pr: { headRefOid: context.headSha, closesIssue: true },
    });

    output.length = 0;
    const driftCode = runExecuteIssueManagerBoundaryCli([
      'observe-worker-smoke-recoverable',
      '--repo', context.repository,
      '--issue-number', String(context.issueNumber),
      '--pr-number', String(context.prNumber),
      '--head-sha', context.headSha!,
      '--source-revision', context.sourceRevision,
      '--phase', 'independent-smoke',
      '--cause', 'trusted_target_stale',
    ], {
      stdout: { write: (value) => output.push(value) },
      stderr: { write: () => undefined },
      runGitHubRead: () => okResult(JSON.stringify({
        number: context.prNumber,
        headRefOid: 'b'.repeat(40),
        body: 'Closes #' + context.issueNumber,
      })),
    });
    expect(driftCode).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      ok: false,
      reason: 'worker_smoke_observation_target_drift',
      expectedHeadSha: context.headSha,
      observedHeadSha: 'b'.repeat(40),
    });
  });

  it('accepts only exact read-only argv and rejects send-capable wrappers', () => {
    expect(isExecuteIssueReadOnlyArgv(['node', '--experimental-strip-types', 'scripts/browser-gpt-page-probe.ts', 'inspect', '--cdp', context.cdp!])).toBe(true);
    expect(isExecuteIssueReadOnlyArgv(['scripts/gh', 'pr', 'view', '2083', '--json', 'state'])).toBe(true);
    expect(isExecuteIssueReadOnlyArgv([
      'node', '--experimental-strip-types', 'scripts/execute-issue-manager-boundary.ts',
      'observe-worker-smoke-recoverable', '--repo', context.repository,
      '--issue-number', String(context.issueNumber), '--pr-number', String(context.prNumber),
      '--head-sha', context.headSha!, '--source-revision', context.sourceRevision,
      '--phase', 'independent-smoke', '--cause', 'tier_order_input_stale',
    ])).toBe(true);
    expect(isExecuteIssueReadOnlyArgv(['node', 'scripts/wrapper.ts', 'scripts/gh', 'pr', 'view', '2083'])).toBe(false);
    expect(isExecuteIssueReadOnlyArgv(['node', '--experimental-strip-types', 'scripts/browser-gpt-page-probe.ts', 'inspect', '--open-if-missing'])).toBe(false);
    expect(isExecuteIssueReadOnlyArgv(['node', 'scripts/chatgpt-browser-turn.ts', '--new-chat'])).toBe(false);
  });

  it('binds a complete identity pair to inspect and refuses census fallback without a target', () => {
    const identityContext = { ...context, profile: '/operator/profile', invocationId: 'invocation-2081' };
    const evaluated = classifyExecuteIssueManagerRecord(turn('observation_uncertain'), identityContext);
    expect(evaluated.exitCode).toBe(3);
    expect(expectReadOnly(evaluated).argv).toEqual([
      'node', '--experimental-strip-types', 'scripts/browser-gpt-page-probe.ts', 'inspect',
      '--cdp', context.cdp, '--url', context.conversationUrl,
      '--profile', '/operator/profile', '--invocation-id', 'invocation-2081',
    ]);

    const withoutTarget = classifyExecuteIssueManagerRecord(
      turn('observation_uncertain', { conversation_id: undefined }),
      { ...identityContext, targetId: undefined, conversationUrl: undefined },
    );
    expect(withoutTarget.exitCode).toBe(5);
    expect(withoutTarget.result).toMatchObject({ cause: 'producer_contract_defect', nextAction: null });
  });

  it('emits one JSON result and the shared exit discriminator through the CLI', () => {
    const output: string[] = [];
    const errors: string[] = [];
    const code = runExecuteIssueManagerBoundaryCli([
      'classify', '--record', '/fixture/turn.json', '--repo', context.repository, '--issue-number', '2081', '--source-revision', 'r03', '--phase', 'implementation', '--production-argv-json', JSON.stringify(context.productionArgv), '--cdp', context.cdp!, '--conversation-url', context.conversationUrl!,
    ], {
      readFile: () => JSON.stringify(turn('chrome_not_running', { scope: 'machine' })),
      stdout: { write: (value) => output.push(value) }, stderr: { write: (value) => errors.push(value) },
      currentArgv: ['node', 'scripts/execute-issue-manager-boundary.ts', 'classify'],
    });
    expect(code).toBe(4);
    expect(output).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(JSON.parse(output[0]!)).toMatchObject({ cause: 'external:chrome_not_running', nextAction: null });
  });

  it('uses explicit CLI CDP and conversation URL for read-only uncertain-turn inspection', () => {
    const output: string[] = [];
    const errors: string[] = [];
    const code = runExecuteIssueManagerBoundaryCli([
      'classify', '--record', '/fixture/turn.json', '--repo', context.repository, '--issue-number', '2081',
      '--source-revision', 'r03', '--phase', 'implementation', '--production-argv-json', JSON.stringify(context.productionArgv),
      '--cdp', context.cdp!, '--conversation-url', context.conversationUrl!,
    ], {
      readFile: () => JSON.stringify(turn('observation_uncertain')),
      stdout: { write: (value) => output.push(value) }, stderr: { write: (value) => errors.push(value) },
      currentArgv: ['node', 'scripts/execute-issue-manager-boundary.ts', 'classify'],
    });
    expect(code).toBe(3);
    expect(output).toHaveLength(1);
    expect(errors).toEqual([]);
    const result = JSON.parse(output[0]!);
    expect(result.cause).toBe('execute_owned_turn_reobserve');
    expect(result.nextAction.argv).toEqual([
      'node', '--experimental-strip-types', 'scripts/browser-gpt-page-probe.ts', 'inspect',
      '--cdp', context.cdp, '--url', context.conversationUrl,
    ]);
    expect(isExecuteIssueReadOnlyArgv(result.nextAction.argv)).toBe(true);
  });

  it('rejects an incomplete identity pair at the CLI boundary', () => {
    const output: string[] = [];
    const errors: string[] = [];
    const code = runExecuteIssueManagerBoundaryCli([
      'classify', '--record', '/fixture/turn.json', '--repo', context.repository, '--issue-number', '2081', '--source-revision', 'r03', '--phase', 'implementation',
      '--production-argv-json', JSON.stringify(['node', 'producer.ts']), '--profile', '/operator/profile',
    ], {
      readFile: () => JSON.stringify(turn('observation_uncertain')),
      stdout: { write: (value) => output.push(value) }, stderr: { write: (value) => errors.push(value) },
      currentArgv: ['classifier', 'argv'],
    });
    expect(code).toBe(5);
    expect(JSON.parse(output[0]!)).toMatchObject({ cause: 'producer_contract_defect', nextAction: null });
    expect(errors.join('')).toContain('--profile and --invocation-id must be supplied together');
  });

  it('uses production argv for self-recommendation rather than classifier argv', () => {
    const productionArgv = [
      'node', '--experimental-strip-types', 'scripts/browser-gpt-page-probe.ts', 'inspect',
      '--cdp', context.cdp!, '--url', context.conversationUrl!,
    ];
    const run = (argv: readonly string[], classifierArgv: readonly string[]) => {
      const output: string[] = [];
      const code = runExecuteIssueManagerBoundaryCli([
        'classify', '--record', '/fixture/turn.json', '--repo', context.repository, '--issue-number', '2081',
        '--source-revision', 'r03', '--phase', 'implementation', '--production-argv-json', JSON.stringify(argv),
        '--cdp', context.cdp!, '--conversation-url', context.conversationUrl!,
      ], {
        readFile: () => JSON.stringify(turn('observation_uncertain')),
        stdout: { write: (value) => output.push(value) }, stderr: { write: () => undefined },
        currentArgv: classifierArgv,
      });
      return { code, result: JSON.parse(output[0]!) as Record<string, unknown> };
    };

    expect(run(productionArgv, ['classifier', 'different']).code).toBe(5);
    expect(run(productionArgv, ['classifier', 'different']).result).toMatchObject({ cause: 'self_recommendation' });
    expect(run([...productionArgv, 'different'], productionArgv)).toMatchObject({
      code: 3,
      result: { cause: 'execute_owned_turn_reobserve' },
    });
  });
});
