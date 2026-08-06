import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, vi } from 'vitest';
import {
  BEFORE_CDP_BROWSER_RELEASE,
  releaseCdpBrowser,
} from './chatgpt-browser-turn/browser-session.ts';
import { configuredProfileKey } from './chatgpt-browser-turn/storage-common.ts';
import {
  parsePostSettlementCloseArgs,
  rewritePreservedTurnResult,
  runEnhancedPageProbeCli,
  runPostSettlementClose,
  type CdpTarget,
  type ExactTargetChannel,
  type PostSettlementCloseDependencies,
} from './browser-gpt-post-settlement-close.ts';

const profile = '/tmp/opk-profile-1266';
const cdp = 'http://127.0.0.1:9222';
const profileKey = configuredProfileKey(profile, cdp);
const reply = 'settled browser reply';
const replyBytes = Buffer.from(reply, 'utf8');
const replySha = createHash('sha256').update(replyBytes).digest('hex');

const target: CdpTarget = {
  id: 'target-owned',
  type: 'page',
  url: 'https://chatgpt.com/c/owned',
  webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/target-owned',
};
const sibling: CdpTarget = {
  id: 'target-sibling',
  type: 'page',
  url: 'https://chatgpt.com/c/sibling',
  webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/target-sibling',
};

function directResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'turn-result/v1',
    state: 'ok',
    scope: 'none',
    cause: 'completed_page_only',
    invocation_id: 'invocation-1266',
    configured_profile_key: profileKey,
    send_count: 1,
    cleanup: 'skipped',
    witness: {
      user_message_id: 'user-1',
      assistant_message_id: 'assistant-1',
      relation: 'reply_to',
      source: 'service',
    },
    post_settlement_target: {
      disposition: 'preserved_after_settlement',
      configured_profile_key: profileKey,
      target_id: target.id,
      normalized_url: target.url,
      assistant_message_id: 'assistant-1',
      representation: 'innerText',
      byte_length: replyBytes.byteLength,
      sha256: replySha,
      document_ordinal: 1,
      observed_user_nodes: 1,
      observed_assistant_nodes: 1,
      observed_message_nodes: 2,
      generation_in_progress: false,
      nodes_truncated: false,
    },
    ...overrides,
  };
}

function probeResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'browser-gpt-page-probe/v1',
    operation: 'export',
    status: 'ok',
    diagnostic_only: true,
    workflow_authority: 'none',
    configured_profile_key: profileKey,
    target_id: target.id,
    normalized_url: target.url,
    page_url: target.url,
    node: {
      role: 'assistant',
      ordinal: 0,
      document_ordinal: 1,
      message_id: 'assistant-1',
    },
    assistant_message_id: 'assistant-1',
    representation: 'innerText',
    byte_length: replyBytes.byteLength,
    sha256: replySha,
    output_identity: {
      path: '/tmp/reply-1266.txt',
      byte_length: replyBytes.byteLength,
      sha256: replySha,
    },
    observed_user_nodes: 1,
    observed_assistant_nodes: 1,
    observed_message_nodes: 2,
    generation_in_progress: false,
    nodes_truncated: false,
    last_assistant: true,
    last_message: true,
    ...overrides,
  };
}

function guard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    normalized_url: target.url,
    byte_length: replyBytes.byteLength,
    sha256: replySha,
    observed_user_nodes: 1,
    observed_assistant_nodes: 1,
    observed_message_nodes: 2,
    generation_in_progress: false,
    nodes_truncated: false,
    assistant_message_id: 'assistant-1',
    representation: 'innerText',
    document_ordinal: 1,
    ordinal: 0,
    last_assistant: true,
    last_message: true,
    completion_ready: true,
    continuation_available: false,
    ...overrides,
  };
}

function fixture(overrides: {
  direct?: Record<string, unknown>;
  probe?: Record<string, unknown>;
  harvest?: Uint8Array;
  initialTargets?: readonly CdpTarget[];
  remainingTargets?: readonly CdpTarget[];
  guards?: readonly Record<string, unknown>[];
  closeThrows?: boolean;
  remainingCensusThrows?: boolean;
  beforeFinalGuard?: () => void;
} = {}): {
  deps: PostSettlementCloseDependencies;
  closeCalls: () => number;
  openedIds: () => readonly string[];
} {
  let closeCount = 0;
  let censusCount = 0;
  let evaluateCount = 0;
  const opened: string[] = [];
  const channel: ExactTargetChannel = {
    evaluate: async () => (overrides.guards ?? [guard(), guard()])[evaluateCount++]!,
    close: async () => {
      closeCount++;
      if (overrides.closeThrows) throw new Error('close_dispatch_failed');
      return 'acknowledged';
    },
    disconnect: () => {},
  };
  return {
    deps: {
      readText: async (path) => JSON.stringify(path === 'turn.json'
        ? (overrides.direct ?? directResult())
        : (overrides.probe ?? probeResult())),
      readBytes: async () => overrides.harvest ?? replyBytes,
      listTargets: async () => {
        if (censusCount++ > 0 && overrides.remainingCensusThrows) {
          throw new Error('fresh_absence_census_failed');
        }
        return censusCount === 1
          ? (overrides.initialTargets ?? [target, sibling])
          : (overrides.remainingTargets ?? [sibling]);
      },
      openExactTargetChannel: async (candidate) => {
        opened.push(candidate.id);
        return channel;
      },
      ...(overrides.beforeFinalGuard ? { beforeFinalGuard: overrides.beforeFinalGuard } : {}),
    },
    closeCalls: () => closeCount,
    openedIds: () => opened,
  };
}

const args = {
  turnResult: 'turn.json',
  probeResult: 'probe.json',
  harvest: 'reply.txt',
  profile,
  cdp,
};

test('fixed CLI accepts only five governed artifact and namespace inputs', () => {
  assert.deepEqual(parsePostSettlementCloseArgs([
    '--turn-result', 'turn.json',
    '--probe-result', 'probe.json',
    '--harvest', 'reply.txt',
    '--profile', profile,
    '--cdp', cdp,
  ]), args);
  assert.throws(() => parsePostSettlementCloseArgs([
    '--turn-result', 'turn.json', '--target-id', String(target.id),
  ]), /argument_invalid|argument_set_invalid/u);
});

test('closes exactly the byte-bound completed owned target and leaves sibling present', async () => {
  const state = fixture();
  const result = await runPostSettlementClose(args, state.deps);
  assert.equal(result.status, 'closed');
  assert.equal(result.close_attempt_count, 1);
  assert.deepEqual(state.openedIds(), [target.id]);
  assert.equal(state.closeCalls(), 1);
  assert.equal(result.resend_authority, 'none');
});

test('settled target already absent is success with zero close attempts', async () => {
  const state = fixture({ initialTargets: [sibling] });
  const result = await runPostSettlementClose(args, state.deps);
  assert.equal(result.status, 'already_absent');
  assert.equal(result.close_attempt_count, 0);
  assert.equal(state.closeCalls(), 0);
});

test('prior close or capture-failure terminal records never authorize CDP', async () => {
  for (const direct of [
    directResult({ cleanup: 'confirmed' }),
    directResult({ cleanup: 'unconfirmed' }),
    directResult({
      post_settlement_target_capture: { status: 'unavailable', cause: 'surface_incomplete' },
    }),
  ]) {
    const state = fixture({ direct });
    const result = await runPostSettlementClose(args, state.deps);
    assert.equal(result.status, 'settlement_untrusted');
    assert.equal(result.close_attempt_count, 0);
    assert.deepEqual(state.openedIds(), []);
    assert.equal(state.closeCalls(), 0);
  }
});

test('launcher and generic recovery envelopes never become close authority', async () => {
  for (const direct of [
    { schema: 'flow-manager-long-running-child-terminal/v1' },
    directResult({
      state: 'recovery_required',
      scope: 'conversation',
      cause: 'generic_recovery_required',
    }),
  ]) {
    const state = fixture({ direct });
    const result = await runPostSettlementClose(args, state.deps);
    assert.equal(result.status, 'settlement_untrusted');
    assert.equal(result.close_attempt_count, 0);
    assert.deepEqual(state.openedIds(), []);
  }
});

test('profile namespace, probe evidence and harvested bytes must all match', async () => {
  for (const state of [
    fixture({ direct: directResult({ configured_profile_key: 'profile-wrong' }) }),
    fixture({ probe: probeResult({ configured_profile_key: 'profile-wrong' }) }),
    fixture({ harvest: Buffer.from('different', 'utf8') }),
  ]) {
    const result = await runPostSettlementClose(args, state.deps);
    assert.ok(result.status === 'settlement_untrusted' || result.status === 'harvest_untrusted');
    assert.equal(result.close_attempt_count, 0);
    assert.equal(state.closeCalls(), 0);
  }
});

test('mutation between initial and final same-channel guards is stale_harvest', async () => {
  let mutated = false;
  const state = fixture({
    guards: [guard(), guard({ ok: false, sha256: '0'.repeat(64) })],
    beforeFinalGuard: () => { mutated = true; },
  });
  const result = await runPostSettlementClose(args, state.deps);
  assert.equal(mutated, true);
  assert.equal(result.status, 'stale_harvest');
  assert.equal(result.close_attempt_count, 0);
  assert.equal(state.closeCalls(), 0);
});

test('active, resumable or completion-unproven replies fail the final guard', async () => {
  for (const changed of [
    { generation_in_progress: true },
    { continuation_available: true },
    { completion_ready: false },
  ]) {
    const state = fixture({ guards: [guard(changed)] });
    const result = await runPostSettlementClose(args, state.deps);
    assert.equal(result.status, 'stale_harvest');
    assert.equal(result.close_attempt_count, 0);
    assert.equal(state.closeCalls(), 0);
  }
});

test('appended, resumed and older-node surfaces cannot close', async () => {
  for (const changed of [
    { observed_message_nodes: 3, last_message: false },
    { sha256: '1'.repeat(64), continuation_available: true },
    { document_ordinal: 0, last_assistant: false, last_message: false },
  ]) {
    const state = fixture({ guards: [guard(changed)] });
    const result = await runPostSettlementClose(args, state.deps);
    assert.equal(result.status, 'stale_harvest');
    assert.equal(result.close_attempt_count, 0);
    assert.equal(state.closeCalls(), 0);
  }
});

test('same id with changed URL fails closed without replacement or sibling close', async () => {
  const state = fixture({ initialTargets: [{ ...target, url: sibling.url }, sibling] });
  const result = await runPostSettlementClose(args, state.deps);
  assert.equal(result.status, 'target_identity_mismatch');
  assert.equal(result.close_attempt_count, 0);
  assert.deepEqual(state.openedIds(), []);
});

test('one dispatched close without fresh absence proof is close_unconfirmed', async () => {
  const state = fixture({ remainingTargets: [target, sibling] });
  const result = await runPostSettlementClose(args, state.deps);
  assert.equal(result.status, 'close_unconfirmed');
  assert.equal(result.close_attempt_count, 1);
  assert.equal(state.closeCalls(), 1);
});

test('post-dispatch census failure preserves close_unconfirmed and count one', async () => {
  const state = fixture({ remainingCensusThrows: true });
  const result = await runPostSettlementClose(args, state.deps);
  assert.equal(result.status, 'close_unconfirmed');
  assert.equal(result.close_attempt_count, 1);
  assert.equal(state.closeCalls(), 1);
  assert.match(result.reason ?? '', /fresh_absence_census_failed/u);
});

test('a close transport error is still one attempt and requires fresh absence proof', async () => {
  const state = fixture({ closeThrows: true, remainingTargets: [target, sibling] });
  const result = await runPostSettlementClose(args, state.deps);
  assert.equal(result.status, 'close_unconfirmed');
  assert.equal(result.close_attempt_count, 1);
  assert.equal(state.closeCalls(), 1);
});

test('preserved eligible direct result receives witnesses only before any prior cleanup', () => {
  const causalWitness = {
    user_message_id: 'user-1',
    assistant_message_id: 'assistant-1',
    relation: 'reply_to' as const,
    source: 'service' as const,
  };
  const targetWitness = directResult().post_settlement_target as Record<string, unknown>;
  const capture = {
    config: {
      profile,
      cdp,
      profileKey,
      repositoryFullName: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1266,
    },
    causalWitness,
    targetWitness: targetWitness as any,
  };
  const eligible = {
    ...directResult(),
    state: 'recovery_required',
    scope: 'conversation',
    cause: 'direct_publication_receipt_invalid',
    witness: undefined,
    post_settlement_target: undefined,
  };
  const rewritten = rewritePreservedTurnResult(eligible, capture);
  assert.deepEqual(rewritten.witness, causalWitness);
  assert.deepEqual(rewritten.post_settlement_target, targetWitness);
  for (const ineligible of [
    { ...eligible, cleanup: 'confirmed' },
    { ...eligible, post_settlement_target_capture: { status: 'unavailable', cause: 'timeout' } },
    { ...eligible, cause: 'generic_recovery_required' },
  ]) {
    assert.deepEqual(rewritePreservedTurnResult(ineligible, capture), ineligible);
  }
});

test('production browser release awaits capture hook before disconnect', async () => {
  const order: string[] = [];
  let releaseCapture!: () => void;
  const capture = new Promise<void>((resolve) => { releaseCapture = resolve; });
  const browser = {
    [BEFORE_CDP_BROWSER_RELEASE]: async () => {
      order.push('capture-start');
      await capture;
      order.push('capture-fixed');
    },
    close: async () => { order.push('disconnect'); },
  };
  const release = releaseCdpBrowser(browser);
  await Promise.resolve();
  assert.deepEqual(order, ['capture-start']);
  releaseCapture();
  await release;
  assert.deepEqual(order, ['capture-start', 'capture-fixed', 'disconnect']);
});

test('enhanced production probe entrypoint is read-only and enriches two observations', async () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const calls: string[] = [];
  try {
    const code = await runEnhancedPageProbeCli([
      'export',
      '--cdp', cdp,
      '--target-id', String(target.id),
      '--assistant-index', '0',
      '--representation', 'innerText',
      '--output', '/tmp/reply-1266.txt',
      '--profile', profile,
    ], {
      runProbe: async (parsed) => {
        calls.push(parsed.operation);
        if (parsed.operation === 'export') return {
          ...probeResult(),
          configured_profile_key: undefined,
          normalized_url: undefined,
          assistant_message_id: undefined,
          output_identity: undefined,
          observed_user_nodes: undefined,
          observed_assistant_nodes: undefined,
          observed_message_nodes: undefined,
          last_assistant: undefined,
          last_message: undefined,
          output: '/tmp/reply-1266.txt',
        };
        return {
          schema: 'browser-gpt-page-probe/v1',
          operation: 'inspect',
          status: 'ok',
          diagnostic_only: true,
          workflow_authority: 'none',
          target_id: target.id,
          snapshot: {
            page_url: target.url,
            observed_user_nodes: 1,
            observed_assistant_nodes: 1,
            observed_message_nodes: 2,
            generation_in_progress: false,
            nodes_truncated: false,
            nodes: [
              { role: 'user', ordinal: 0, document_ordinal: 0, message_id: 'user-1' },
              {
                role: 'assistant',
                ordinal: 0,
                document_ordinal: 1,
                message_id: 'assistant-1',
                innerText: { byte_length: replyBytes.byteLength, sha256: replySha },
              },
            ],
          },
        };
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(calls, ['export', 'inspect']);
    const emitted = JSON.parse(String(stdout.mock.calls.at(-1)?.[0] ?? '{}')) as Record<string, unknown>;
    assert.equal(emitted.workflow_authority, 'none');
    assert.equal(emitted.configured_profile_key, profileKey);
    assert.equal(emitted.last_message, true);
  } finally {
    stdout.mockRestore();
  }
});
