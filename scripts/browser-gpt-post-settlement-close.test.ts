import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import { configuredProfileKey } from './chatgpt-browser-turn/storage-common.ts';
import {
  parsePostSettlementCloseArgs,
  runPostSettlementClose,
  type ExactTargetChannel,
  type PostSettlementCloseDependencies,
} from './browser-gpt-post-settlement-close.ts';

const profile = '/tmp/opk-profile-1266';
const cdp = 'http://127.0.0.1:9222';
const profileKey = configuredProfileKey(profile, cdp);
const reply = 'settled browser reply';
const replyBytes = Buffer.from(reply, 'utf8');
const replySha = createHash('sha256').update(replyBytes).digest('hex');

const target = {
  id: 'target-owned',
  type: 'page',
  url: 'https://chatgpt.com/c/owned',
  webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/target-owned',
};
const sibling = {
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
    ...overrides,
  };
}

function fixture(overrides: {
  direct?: Record<string, unknown>;
  probe?: Record<string, unknown>;
  harvest?: Uint8Array;
  initialTargets?: readonly Record<string, unknown>[];
  remainingTargets?: readonly Record<string, unknown>[];
  guards?: readonly Record<string, unknown>[];
  closeThrows?: boolean;
  beforeFinalGuard?: () => void;
} = {}): { deps: PostSettlementCloseDependencies; closeCalls: () => number; openedIds: () => readonly string[] } {
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
        const result = censusCount++ === 0
          ? (overrides.initialTargets ?? [target, sibling])
          : (overrides.remainingTargets ?? [sibling]);
        return result;
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

const args = { turnResult: 'turn.json', probeResult: 'probe.json', harvest: 'reply.txt', profile, cdp };

test('fixed CLI accepts only the five governed artifact and namespace inputs', () => {
  assert.deepEqual(parsePostSettlementCloseArgs([
    '--turn-result', 'turn.json',
    '--probe-result', 'probe.json',
    '--harvest', 'reply.txt',
    '--profile', profile,
    '--cdp', cdp,
  ]), args);
  assert.throws(() => parsePostSettlementCloseArgs([
    '--turn-result', 'turn.json', '--target-id', target.id,
  ]), /argument_invalid|argument_set_invalid/u);
});

test('closes exactly the byte-bound owned target and leaves sibling present', async () => {
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

test('launcher envelope is settlement_untrusted and never reaches CDP', async () => {
  const state = fixture({ direct: { schema: 'flow-manager-long-running-child-terminal/v1' } });
  const result = await runPostSettlementClose(args, state.deps);
  assert.equal(result.status, 'settlement_untrusted');
  assert.equal(result.close_attempt_count, 0);
  assert.deepEqual(state.openedIds(), []);
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
