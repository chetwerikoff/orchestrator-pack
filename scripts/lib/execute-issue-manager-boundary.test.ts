// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120
import { describe, expect, it } from 'vitest';
import { TURN_STATES } from '../chatgpt-browser-turn/contracts.ts';
import type { ProbeStatus } from '../browser-gpt-page-probe.ts';
import {
  MANAGER_NEXT_ACTION_KINDS,
  managerNextAction,
  validateManagerResult,
} from './manager-boundary-result.ts';
import {
  EXECUTE_ISSUE_PROBE_CLASSIFICATION,
  EXECUTE_ISSUE_TURN_CLASSIFICATION,
  classifyExecuteIssueManagerRecord,
  isExecuteIssueReadOnlyArgv,
  type ExecuteIssueManagerBoundaryContext,
} from './execute-issue-manager-boundary.ts';
import { runExecuteIssueManagerBoundaryCli } from '../execute-issue-manager-boundary.ts';

const context: ExecuteIssueManagerBoundaryContext = {
  repository: 'chetwerikoff/orchestrator-pack', issueNumber: 2081, sourceRevision: 'r03', phase: 'smoke',
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
    expect(MANAGER_NEXT_ACTION_KINDS.filter((kind) => kind.startsWith('execute-'))).toEqual([
      'execute-observe-owned-turn', 'execute-github-first-read-only', 'execute-review-runner-read-only',
    ]);
    expect(validateManagerResult({
      ok: false, cause: 'invalid', nextAction: {
        schema: 'manager-next-action/v1', kind: 'execute-send-replacement', binding: {
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

  it('Issue #2495: bound vanished inspect selects only the existing GitHub-first read', () => {
    // The actual error envelope does not echo target, profile, invocation or identity_bound.
    const missing = {
      schema: 'browser-gpt-page-probe/v1', operation: 'inspect',
      status: 'not_found', reason: 'target_not_found',
      diagnostic_only: true, workflow_authority: 'none',
    };
    const bound = { ...context, profile: 'owned-profile', invocationId: 'owned-invocation' };
    for (const identity of [
      { ...bound, targetId: 'owned-target', conversationUrl: undefined },
      { ...bound, targetId: undefined, conversationUrl: 'https://chatgpt.com/c/owned-2081' },
    ]) {
      const evaluated = classifyExecuteIssueManagerRecord(missing, identity);
      expect(evaluated.exitCode).toBe(3);
      const action = expectReadOnly(evaluated);
      expect(action.kind).toBe('execute-github-first-read-only');
      expect(action.argv).toEqual([
        'scripts/gh', 'issue', 'view', '2081', '--json', 'state,title,body,closedAt',
      ]);
    }
    const negatives: Array<[Record<string, unknown>, ExecuteIssueManagerBoundaryContext]> = [
      [missing, context],
      [missing, { ...bound, profile: undefined }],
      [missing, { ...bound, profile: ' ' }],
      [missing, { ...bound, invocationId: undefined }],
      [missing, { ...bound, invocationId: ' ' }],
      [missing, { ...bound, targetId: undefined, conversationUrl: undefined }],
      [missing, { ...bound, targetId: ' ', conversationUrl: ' ' }],
      [{ ...missing, operation: 'export' }, bound],
      [{ ...missing, operation: 'list' }, bound],
      [{ ...missing, reason: 'other_missing_reason' }, bound],
      [{ ...missing, identity_bound: false }, bound],
      [{ ...missing, profile: 'foreign-profile' }, bound],
      [{ ...missing, invocation_id: 'foreign-invocation' }, bound],
      [{ ...missing, target_id: 'foreign-target' }, { ...bound, targetId: 'owned-target' }],
      [{ ...missing, conversation_url: 'https://chatgpt.com/c/foreign' }, bound],
      // A producer-only target locator cannot replace missing trusted manager identity.
      [{ ...missing, target_id: 'producer-target' }, context],
    ];
    for (const [envelope, identity] of negatives) {
      expect(actionOf(classifyExecuteIssueManagerRecord(envelope, identity))?.kind)
        .not.toBe('execute-github-first-read-only');
    }
    for (const status of ['stale_node', 'surface_unknown', 'unavailable', 'ambiguous'] as const) {
      expect(actionOf(classifyExecuteIssueManagerRecord(
        { ...missing, status }, bound,
      ))?.kind).not.toBe('execute-github-first-read-only');
    }
  });

  it('projects review runner success, read-only pass-through, and external failure', () => {
    expect(classifyExecuteIssueManagerRecord({ ok: true, created: true, publicationVerified: true, headSha: context.headSha, publicationHeadSha: context.headSha, prNumber: 2083 }, { ...context, phase: 'review' })).toMatchObject({ exitCode: 0 });
    const action = managerNextAction({ kind: 'execute-review-runner-read-only', binding: { ...context, stage: 'execute:review' }, argv: ['scripts/gh', 'pr', 'view', '2083', '--json', 'state'] });
    expect(classifyExecuteIssueManagerRecord({ ok: false, nextAction: action }, { ...context, phase: 'review' })).toMatchObject({ exitCode: 3, result: { nextAction: action } });
    const send = classifyExecuteIssueManagerRecord({ ok: false, nextAction: { schema: 'manager-next-action/v1', kind: 'execute-send-replacement', binding: { ...context, stage: 'execute:review' }, argv: ['node', 'scripts/chatgpt-browser-turn.ts', '--new-chat'] } }, { ...context, phase: 'review' });
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
      terminalCleanup: 'closed_owned_handle',
      terminalHandle: 'legacy-smoke-terminal',
      orcaExecutable: 'legacy-runtime-adapter',
    }), context)).toMatchObject({
      exitCode: 0,
      result: { ok: true, verdict: 'PASS', cause: 'execute_worker_smoke_pass', nextAction: null },
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

    expect(classifyExecuteIssueManagerRecord(smoke('BLOCKED', {
      causeFamily: 'harness_admission_refused',
      nonPassCause: 'trusted_target_stale',
    }), context)).toMatchObject({
      exitCode: 5,
      result: { ok: false, cause: 'producer_contract_defect', nextAction: null },
    });

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

  it('requires smoke context and consumes the publish record directly without an expected-head witness', () => {
    expect(classifyExecuteIssueManagerRecord(smoke('PASS'), { ...context, phase: 'implementation' })).toMatchObject({
      exitCode: 5, result: { cause: 'producer_contract_defect' },
    });

    const output: string[] = [];
    const errors: string[] = [];
    const code = runExecuteIssueManagerBoundaryCli([
      'classify', '--record', '/fixture/smoke.json', '--repo', context.repository,
      '--issue-number', String(context.issueNumber), '--source-revision', context.sourceRevision,
      '--phase', 'smoke', '--production-argv-json', JSON.stringify(context.productionArgv),
      '--pr-number', String(context.prNumber),
    ], {
      readFile: () => JSON.stringify(smoke('PASS', { headSha: 'b'.repeat(40) })),
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
      currentArgv: ['node', 'scripts/execute-issue-manager-boundary.ts', 'classify'],
    });
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(JSON.parse(output[0]!)).toMatchObject({
      ok: true,
      cause: 'execute_worker_smoke_pass',
      verdict: 'PASS',
      nextAction: null,
    });
  });

  it('accepts only exact read-only argv and rejects send-capable wrappers', () => {
    expect(isExecuteIssueReadOnlyArgv(['node', '--experimental-strip-types', 'scripts/browser-gpt-page-probe.ts', 'inspect', '--cdp', context.cdp!])).toBe(true);
    expect(isExecuteIssueReadOnlyArgv(['scripts/gh', 'pr', 'view', '2083', '--json', 'state'])).toBe(true);
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
  it('legacy-missing-next-action-bound-pr-read-only', () => {
    const evaluated = classifyExecuteIssueManagerRecord(
      { ok: false, reason: 'harvest_failed', runId: 'fixture-run' },
      { ...context, phase: 'review' },
    );
    expect(evaluated.exitCode).toBe(3);
    const action = expectReadOnly(evaluated);
    expect(action.kind).toBe('execute-review-runner-read-only');
    expect(action.argv).toContain('2083');
  });

  it('contradictory-pr-rejected', () => {
    for (const ok of [false, true]) {
      const evaluated = classifyExecuteIssueManagerRecord(
        { ok, created: true, publicationVerified: true, prNumber: 2099, headSha: context.headSha },
        { ...context, phase: 'review' },
      );
      expect(evaluated).toMatchObject({ exitCode: 5, result: { cause: 'producer_contract_defect', nextAction: null } });
    }
  });

  it('missing-trusted-pr-rejected', () => {
    for (const prNumber of [undefined, 2099]) {
      const evaluated = classifyExecuteIssueManagerRecord(
        { ok: false, prNumber, reason: 'review failed' },
        { ...context, phase: 'review', prNumber: undefined },
      );
      expect(evaluated).toMatchObject({ exitCode: 5, result: { cause: 'producer_contract_defect', nextAction: null } });
    }
  });

  it('positive-but-unfinished-never-completed', () => {
    for (const row of [
      { ok: true, created: true, status: 'reviewing', httpStatus: 202 },
      { ok: true, created: true, reason: 'journal_write_failed' },
      { ok: true, created: true, reason: 'completed_with_delivery_failures' },
      { ok: true, created: true, publicationVerified: false, reason: 'status_unverified' },
      { ok: true, created: false, reused: true, reason: 'terminal_run_exists' },
    ]) {
      const evaluated = classifyExecuteIssueManagerRecord({ prNumber: 2083, ...row }, { ...context, phase: 'review' });
      expect(evaluated.exitCode).toBe(3);
      expectReadOnly(evaluated);
    }
    // A legitimately delivered intermediate pending status completes only the runner action.
    expect(classifyExecuteIssueManagerRecord({
      ok: true, created: true, publicationVerified: true,
      prNumber: 2083, headSha: context.headSha, publicationHeadSha: context.headSha, requiredStatusState: 'pending',
    }, { ...context, phase: 'review' })).toMatchObject({ exitCode: 0 });
  });

  it('external-outage-vs-local-exception', () => {
    expect(classifyExecuteIssueManagerRecord({
      ok: false, outcome: 'review_target_unavailable', reason: 'GitHub HTTP 503', prNumber: 2083,
    }, { ...context, phase: 'review' })).toMatchObject({ exitCode: 4, result: { cause: 'external:github_unavailable' } });
    const local = classifyExecuteIssueManagerRecord({
      ok: false, outcome: 'review_target_unavailable',
      reason: 'invalid GitHub configuration argument', prNumber: 2083,
    }, { ...context, phase: 'review' });
    expect(local.exitCode).toBe(3);
    expectReadOnly(local);
  });


  it('stage-reuse-unverified-status-advances-manager: ACK is never verified delivery', () => {
    const trusted = { ...context, phase: 'review' as const };
    for (const reason of ['terminal_run_exists', 'review_stage_complete']) {
      for (const publicationVerified of [undefined, false]) {
        const result = classifyExecuteIssueManagerRecord({
          ok: true, created: false, reused: true, reason,
          prNumber: 2083, headSha: context.headSha,
          publicationHeadSha: context.headSha, statusPublished: true,
          ...(publicationVerified === undefined ? {} : { publicationVerified }),
        }, trusted);
        expect(result.exitCode).toBe(3);
        const action = expectReadOnly(result);
        expect(action.kind).toBe('execute-review-runner-read-only');
        expect(action.argv).toEqual(['scripts/gh', 'pr', 'view', '2083', '--json', 'number,headRefOid,baseRefName,state']);
      }
      expect(classifyExecuteIssueManagerRecord({
        ok: true, created: false, reused: true, reason,
        prNumber: 2083, headSha: context.headSha,
        publicationHeadSha: context.headSha, publicationVerified: true, statusPublished: true,
      }, trusted)).toMatchObject({ exitCode: 0, result: { cause: 'execute_review_runner_completed' } });
    }
  });

  it('verified publication must match the trusted current manager head', () => {
    const record = {
      ok: true, created: false, reused: true, reason: 'review_stage_complete',
      prNumber: 2083, headSha: context.headSha,
      publicationHeadSha: context.headSha, publicationVerified: true, statusPublished: true,
    };
    for (const headSha of [undefined, 'b'.repeat(40)]) {
      const result = classifyExecuteIssueManagerRecord(record, { ...context, phase: 'review', headSha });
      expect(result.exitCode).toBe(3);
      expectReadOnly(result);
    }
  });

  it('manager:github-4xx-misclassified-as-outage', () => {
    for (const status of [400, 404, 409, 422]) {
      const result = classifyExecuteIssueManagerRecord({
        ok: false, created: false, outcome: 'review_target_unavailable',
        prNumber: 2083, reason: `GitHub HTTP ${status}`,
      }, { ...context, phase: 'review' });
      expect(result.exitCode).toBe(3);
      expect(expectReadOnly(result).argv).toContain('2083');
    }
    for (const [status, cause] of [
      [401, 'external:login_required'],
      [403, 'external:permission_denied'],
      [429, 'external:quota_exhausted'],
      [503, 'external:github_unavailable'],
      [502, 'external:github_unavailable'],
    ] as const) {
      expect(classifyExecuteIssueManagerRecord({
        ok: false, created: false, outcome: 'review_target_unavailable',
        prNumber: 2083, reason: `GitHub HTTP ${status}`,
      }, { ...context, phase: 'review' })).toMatchObject({
        exitCode: 4, result: { cause, nextAction: null },
      });
    }
  });

  it('readonly-pr-target-check-bypassed-by-normalized-gh-path', () => {
    const trusted = { ...context, phase: 'review' as const };
    const binding = {
      repository: context.repository, issueNumber: context.issueNumber,
      sourceRevision: context.sourceRevision, stage: 'execute:review' as const,
    };
    const foreign = managerNextAction({
      kind: 'execute-review-runner-read-only',
      binding,
      argv: ['./scripts/gh', 'pr', 'view', '2099', '--json', 'state'],
    });
    expect(isExecuteIssueReadOnlyArgv(foreign.argv)).toBe(true);
    const result = classifyExecuteIssueManagerRecord({
      ok: false, reason: 'harvest_failed', nextAction: foreign,
      // Deliberately omitted legacy producer prNumber.
    }, trusted);
    expect(result.exitCode).toBe(3);
    const safe = expectReadOnly(result);
    expect(safe.argv).toEqual(['scripts/gh', 'pr', 'view', '2083', '--json', 'number,headRefOid,baseRefName,state']);

    // The normalized spelling is allowed when it selects the trusted PR.
    const valid = managerNextAction({
      kind: 'execute-review-runner-read-only',
      binding,
      argv: ['./scripts/gh', 'pr', 'view', '2083', '--json', 'state'],
    });
    const accepted = classifyExecuteIssueManagerRecord({ ok: false, nextAction: valid }, trusted);
    expect(accepted.exitCode).toBe(3);
    expect(expectReadOnly(accepted).argv).toEqual(valid.argv);
  });

});
