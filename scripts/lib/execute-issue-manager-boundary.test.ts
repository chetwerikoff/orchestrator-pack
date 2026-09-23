import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

function trackedProbeStatuses(): ProbeStatus[] {
  const source = readFileSync(join(process.cwd(), 'scripts', 'browser-gpt-page-probe.ts'), 'utf8');
  const declaration = /export type ProbeStatus =([\s\S]*?);/u.exec(source)?.[1];
  if (!declaration) throw new Error('ProbeStatus declaration not found');
  return [...declaration.matchAll(/'([^']+)'/gu)].map((match) => match[1] as ProbeStatus);
}

const context: ExecuteIssueManagerBoundaryContext = {
  repository: 'chetwerikoff/orchestrator-pack',
  issueNumber: 2081,
  sourceRevision: 'r03',
  phase: 'implementation',
  cdp: 'http://127.0.0.1:9222',
  conversationUrl: 'https://chatgpt.com/c/owned-2081',
  prNumber: 2083,
  currentArgv: ['node', '--experimental-strip-types', 'scripts/execute-issue-manager-boundary.ts', 'classify'],
};

function turn(state: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'turn-result/v1',
    state,
    scope: 'invocation',
    cause: state,
    invocation_id: 'invocation-2081',
    configured_profile_key: 'profile-2081',
    conversation_id: 'owned-2081',
    ...overrides,
  };
}

function probe(status: ProbeStatus, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'browser-gpt-page-probe/v1',
    operation: 'inspect',
    status,
    diagnostic_only: true,
    workflow_authority: 'none',
    target_id: 'target-2081',
    ...overrides,
  };
}

function resultAction(evaluated: ReturnType<typeof classifyExecuteIssueManagerRecord>) {
  return evaluated.result.ok === false && 'nextAction' in evaluated.result
    ? evaluated.result.nextAction
    : null;
}

describe('execute-Issue manager boundary', () => {
  it('covers the exact closed TURN_STATES and ProbeStatus sets', () => {
    expect(Object.keys(EXECUTE_ISSUE_TURN_CLASSIFICATION).sort()).toEqual([...TURN_STATES].sort());
    expect(Object.keys(EXECUTE_ISSUE_PROBE_CLASSIFICATION).sort()).toEqual(trackedProbeStatuses().sort());
  });

  it('extends the one shared kind vocabulary with exactly three execute read-only reconciliation kinds', () => {
    const executeKinds = CREATE_ISSUE_NEXT_ACTION_KINDS.filter((kind) => kind.startsWith('execute-'));
    expect(executeKinds).toEqual([
      'execute-observe-owned-turn',
      'execute-github-first-read-only',
      'execute-review-runner-read-only',
    ]);
    expect(validateCreateIssueManagerResult({
      ok: false,
      cause: 'unknown-kind',
      nextAction: {
        schema: 'create-issue-next-action/v1',
        kind: 'execute-send-replacement',
        binding: {
          repository: context.repository,
          issueNumber: context.issueNumber,
          sourceRevision: context.sourceRevision,
          stage: 'execute:implementation',
        },
        argv: ['send'],
      },
    })).toContain('nextAction.kind is outside the closed manager kind set');
  });

  it('replays observation_uncertain then ok using only read-only re-observation', () => {
    const first = classifyExecuteIssueManagerRecord(turn('observation_uncertain'), context);
    expect(first.exitCode).toBe(3);
    expect(first.result).toMatchObject({
      ok: false,
      cause: 'execute_owned_turn_reobserve',
      nextAction: { kind: 'execute-observe-owned-turn' },
    });
    const firstAction = resultAction(first);
    expect(firstAction).not.toBeNull();
    expect(isExecuteIssueReadOnlyArgv(firstAction!.argv)).toBe(true);
    expect(firstAction!.argv).not.toContain('--new-chat');

    const settled = classifyExecuteIssueManagerRecord(turn('ok', { scope: 'none', cause: 'completed' }), context);
    expect(settled.exitCode).toBe(0);
    expect(settled.result).toMatchObject({ ok: true, nextAction: null });
  });

  it('replays chrome_not_running as one typed external pause and never a failed terminal', () => {
    const evaluated = classifyExecuteIssueManagerRecord(turn('chrome_not_running', {
      scope: 'machine',
      cause: 'chrome_not_running',
    }), context);
    expect(evaluated.exitCode).toBe(4);
    expect(evaluated.result).toMatchObject({
      ok: false,
      cause: 'external:chrome_not_running',
      pause: { resume_when: { operator: true } },
      nextAction: null,
    });
  });

  it('routes supported conversation recovery through the read-only GitHub-first prerequisite', () => {
    const evaluated = classifyExecuteIssueManagerRecord(turn('recovery_required', {
      scope: 'conversation',
      cause: 'message_delivery_timed_out',
    }), context);
    expect(evaluated.exitCode).toBe(3);
    expect(evaluated.result).toMatchObject({
      ok: false,
      nextAction: { kind: 'execute-github-first-read-only' },
    });
    const action = resultAction(evaluated);
    expect(action).not.toBeNull();
    expect(action!.argv.slice(0, 3)).toEqual(['scripts/gh', 'issue', 'view']);
    expect(isExecuteIssueReadOnlyArgv(action!.argv)).toBe(true);
    expect(action!.argv.join(' ')).not.toMatch(/--new-chat|chatgpt-browser-turn\.ts/u);
  });

  it('keeps bounded observer expiry and active observation read-only before stopped recovery', () => {
    for (const record of [
      turn('observation_uncertain', { cause: 'observer_expired' }),
      turn('no_reply', { cause: 'owned_turn_still_active' }),
      probe('ok', {
        execution_recovery_inspect: {
          cause: null,
          owned_user_turn_key: 'turn-1',
          candidate_assistant_turn_key: null,
          retry_control_present: false,
          generation_in_progress: true,
          reason: 'literal_not_found',
        },
      }),
    ]) {
      const evaluated = classifyExecuteIssueManagerRecord(record, context);
      expect(evaluated.exitCode).toBe(3);
      const action = resultAction(evaluated);
      expect(action).not.toBeNull();
      expect(action!.kind).toBe('execute-observe-owned-turn');
      expect(isExecuteIssueReadOnlyArgv(action!.argv)).toBe(true);
    }

    const stopped = classifyExecuteIssueManagerRecord(probe('ok', {
      execution_recovery_inspect: {
        cause: 'product_network_error',
        owned_user_turn_key: 'turn-1',
        candidate_assistant_turn_key: null,
        retry_control_present: true,
        generation_in_progress: false,
      },
    }), context);
    expect(stopped.exitCode).toBe(3);
    expect(resultAction(stopped)?.kind).toBe('execute-github-first-read-only');
  });

  it('projects ambiguous_marker to content-authority pause with the envelope preserved as evidence', () => {
    const envelope = probe('ok', {
      execution_recovery_inspect: {
        cause: null,
        owned_user_turn_key: null,
        candidate_assistant_turn_key: null,
        retry_control_present: false,
        generation_in_progress: false,
        reason: 'ambiguous_marker',
      },
    });
    const evaluated = classifyExecuteIssueManagerRecord(envelope, context);
    expect(evaluated.exitCode).toBe(4);
    expect(evaluated.result).toMatchObject({
      cause: 'external:content_authority_conflict',
      pause: { resume_when: { operator: true } },
      nextAction: null,
    });
    expect(JSON.stringify(evaluated.result)).toContain('ambiguous_marker');
  });

  it('classifies every probe status without turning zero-send evidence into send authority', () => {
    const notSent = classifyExecuteIssueManagerRecord(probe('not_found', { reason: 'owned_turn_not_sent' }), context);
    expect(notSent.exitCode).toBe(3);
    expect(resultAction(notSent)?.kind).toBe('execute-observe-owned-turn');

    const unsafe = classifyExecuteIssueManagerRecord(probe('unsafe_output', { reason: 'primary_binding_target_conflict' }), context);
    expect(unsafe.exitCode).toBe(5);
    expect(unsafe.result).toMatchObject({ cause: 'producer_contract_defect', nextAction: null });

    const unavailable = classifyExecuteIssueManagerRecord(probe('unavailable', { reason: 'cdp_unavailable' }), context);
    expect(unavailable.exitCode).toBe(4);
    expect(unavailable.result).toMatchObject({ cause: 'external:chrome_not_running' });
  });

  it('keeps runner budget/send authority outside the boundary', () => {
    const completed = classifyExecuteIssueManagerRecord({ ok: true, prNumber: 2083 }, {
      ...context,
      phase: 'review',
    });
    expect(completed.exitCode).toBe(0);

    const readOnly = createIssueNextAction({
      kind: 'execute-review-runner-read-only',
      binding: {
        repository: context.repository,
        issueNumber: context.issueNumber,
        sourceRevision: context.sourceRevision,
        stage: 'execute:review',
      },
      argv: ['scripts/gh', 'pr', 'view', '2083', '--json', 'state'],
    });
    const passThrough = classifyExecuteIssueManagerRecord({
      ok: false,
      prNumber: 2083,
      nextAction: readOnly,
    }, { ...context, phase: 'review' });
    expect(passThrough.exitCode).toBe(3);
    expect(resultAction(passThrough)).toEqual(readOnly);

    const sendCapable = classifyExecuteIssueManagerRecord({
      ok: false,
      prNumber: 2083,
      nextAction: {
        schema: 'create-issue-next-action/v1',
        kind: 'retry-start-cycle',
        binding: {
          repository: context.repository,
          issueNumber: context.issueNumber,
          sourceRevision: context.sourceRevision,
          stage: 'execute:review',
        },
        argv: ['node', 'scripts/chatgpt-browser-turn.ts', '--new-chat'],
      },
    }, { ...context, phase: 'review' });
    expect(sendCapable.exitCode).toBe(3);
    expect(resultAction(sendCapable)?.kind).toBe('execute-review-runner-read-only');
    expect(isExecuteIssueReadOnlyArgv(resultAction(sendCapable)!.argv)).toBe(true);

    const unavailable = classifyExecuteIssueManagerRecord({
      ok: false,
      outcome: 'review_target_unavailable',
      reason: 'GitHub HTTP 503',
      prNumber: 2083,
    }, { ...context, phase: 'review' });
    expect(unavailable.exitCode).toBe(4);
    expect(unavailable.result).toMatchObject({ cause: 'external:github_unavailable' });

    const malformed = classifyExecuteIssueManagerRecord({
      ok: false,
      outcome: 'review_not_started',
      runnerReason: 'unclassifiable_runner_failure',
      prNumber: 2083,
    }, { ...context, phase: 'review' });
    expect(malformed.exitCode).toBe(5);
    expect(malformed.result).toMatchObject({ cause: 'producer_contract_defect' });
  });

  it('rejects exact self-recommendation through the shared boundary', () => {
    const argv = ['scripts/gh', 'pr', 'view', '2083', '--json', 'state'];
    const action = createIssueNextAction({
      kind: 'execute-review-runner-read-only',
      binding: {
        repository: context.repository,
        issueNumber: context.issueNumber,
        sourceRevision: context.sourceRevision,
        stage: 'execute:review',
      },
      argv,
    });
    const evaluated = classifyExecuteIssueManagerRecord({
      ok: false,
      prNumber: 2083,
      nextAction: action,
    }, {
      ...context,
      phase: 'review',
      currentArgv: argv,
    });
    expect(evaluated.exitCode).toBe(5);
    expect(evaluated.result).toMatchObject({ cause: 'self_recommendation' });
  });

  it('never classifies an execute-specific boundary action as send-capable', () => {
    const fixtures = [
      classifyExecuteIssueManagerRecord(turn('observation_uncertain'), context),
      classifyExecuteIssueManagerRecord(turn('recovery_required', {
        scope: 'conversation',
        cause: 'product_network_error',
      }), context),
      classifyExecuteIssueManagerRecord({
        ok: false,
        prNumber: 2083,
        nextAction: 'start another reviewer chat',
      }, { ...context, phase: 'review' }),
    ];
    for (const evaluated of fixtures) {
      const action = resultAction(evaluated);
      expect(action).not.toBeNull();
      expect(isExecuteIssueReadOnlyArgv(action!.argv)).toBe(true);
      expect(action!.argv.join(' ')).not.toMatch(/--new-chat|chatgpt-browser-turn\.ts|fresh[-_ ]conversation/u);
    }
  });

  it('accepts only exact read-only command prefixes', () => {
    expect(isExecuteIssueReadOnlyArgv([
      'node',
      '--experimental-strip-types',
      'scripts/browser-gpt-page-probe.ts',
      'inspect',
      '--cdp',
      context.cdp!,
      '--url',
      context.conversationUrl!,
    ])).toBe(true);
    expect(isExecuteIssueReadOnlyArgv([
      'scripts/gh',
      'pr',
      'view',
      '2083',
      '--json',
      'state',
    ])).toBe(true);

    expect(isExecuteIssueReadOnlyArgv([
      'node',
      'scripts/chatgpt-browser-turn.ts',
      'scripts/browser-gpt-page-probe.ts',
      'inspect',
      '--cdp',
      context.cdp!,
      '--url',
      context.conversationUrl!,
    ])).toBe(false);
    expect(isExecuteIssueReadOnlyArgv([
      'node',
      'scripts/wrapper.ts',
      'scripts/gh',
      'pr',
      'view',
      '2083',
    ])).toBe(false);
    expect(isExecuteIssueReadOnlyArgv([
      'node',
      '--experimental-strip-types',
      'scripts/browser-gpt-page-probe.ts',
      'inspect',
      '--cdp',
      context.cdp!,
      '--url',
      context.conversationUrl!,
      '--open-if-missing',
      'true',
    ])).toBe(false);
  });

  it('emits one JSON object and the shared 0/3/4/5 discriminator from the CLI', () => {
    const outputs: string[] = [];
    const errors: string[] = [];
    const code = runExecuteIssueManagerBoundaryCli([
      'classify',
      '--record', '/fixture/turn.json',
      '--repo', context.repository,
      '--issue-number', String(context.issueNumber),
      '--source-revision', context.sourceRevision,
      '--phase', 'implementation',
      '--cdp', context.cdp!,
      '--conversation-url', context.conversationUrl!,
    ], {
      readFile: () => JSON.stringify(turn('chrome_not_running', {
        scope: 'machine',
        cause: 'chrome_not_running',
      })),
      stdout: { write: (value) => outputs.push(value) },
      stderr: { write: (value) => errors.push(value) },
      currentArgv: ['node', 'scripts/execute-issue-manager-boundary.ts', 'classify'],
    });
    expect(code).toBe(4);
    expect(outputs).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(JSON.parse(outputs[0]!)).toMatchObject({
      cause: 'external:chrome_not_running',
      nextAction: null,
    });
  });
});
