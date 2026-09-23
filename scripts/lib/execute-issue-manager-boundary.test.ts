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
  repository: 'chetwerikoff/orchestrator-pack', issueNumber: 2081, sourceRevision: 'r03', phase: 'implementation',
  productionArgv: ['node', 'scripts/execute-issue-manager-boundary.ts', 'classify'],
  cdp: 'http://127.0.0.1:9222', conversationUrl: 'https://chatgpt.com/c/owned-2081', prNumber: 2083,
};
function turn(state: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: 'turn-result/v1', state, scope: 'invocation', cause: state, invocation_id: 'invocation-2081', configured_profile_key: 'profile-2081', conversation_id: 'owned-2081', ...overrides };
}
function probe(status: ProbeStatus, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: 'browser-gpt-page-probe/v1', operation: 'inspect', status, diagnostic_only: true, workflow_authority: 'none', target_id: 'target-2081', ...overrides };
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

  it('projects typed external pauses and retains producer evidence', () => {
    const turnPause = classifyExecuteIssueManagerRecord(turn('chrome_not_running', { scope: 'machine' }), context);
    expect(turnPause.exitCode).toBe(4);
    expect(turnPause.result).toMatchObject({ cause: 'external:chrome_not_running', pause: { resume_when: { operator: true } }, nextAction: null });
    const envelope = probe('ambiguous', { reason: 'owned marker conflict', evidence_token: 'evidence-2081' });
    const probePause = classifyExecuteIssueManagerRecord(envelope, context);
    expect(probePause.exitCode).toBe(4);
    expect(probePause.result).toMatchObject({ cause: 'external:content_authority_conflict' });
    if (probePause.result.ok !== false || !('pause' in probePause.result)) throw new Error('expected pause');
    expect(JSON.parse(probePause.result.pause.evidence)).toEqual(envelope);
  });

  it('uses GitHub-first reconciliation for the two supported conversation causes', () => {
    for (const cause of ['message_delivery_timed_out', 'product_network_error']) {
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
    expect(expectReadOnly(classifyExecuteIssueManagerRecord(probe('ok', { execution_recovery_inspect: { cause: 'product_network_error', generation_in_progress: false } }), context)).kind).toBe('execute-github-first-read-only');
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
