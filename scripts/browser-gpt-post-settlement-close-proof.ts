#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { configuredProfileKey } from './chatgpt-browser-turn/storage-common.ts';
import {
  parsePostSettlementCloseArgs,
  runPostSettlementClose,
  type ExactTargetChannel,
  type PostSettlementCloseDependencies,
} from './browser-gpt-post-settlement-close.ts';

const profile = '/proof/browser-gpt-profile';
const cdp = 'http://127.0.0.1:9222';
const profileKey = configuredProfileKey(profile, cdp);
const targetId = 'proof-owned-target';
const foreignTargetId = 'proof-foreign-target';
const normalizedUrl = 'https://chatgpt.com/c/proof-owned';
const reply = Buffer.from('deterministic settled proof reply', 'utf8');
const sha256 = createHash('sha256').update(reply).digest('hex');
let targetPresent = true;
const foreignTargetPresent = true;
let finalGuardSeen = false;
let closeCalls = 0;
let evaluateCalls = 0;

const directResult = {
  schema: 'turn-result/v1',
  state: 'ok',
  scope: 'none',
  cause: 'completed_page_only',
  invocation_id: 'proof-invocation',
  configured_profile_key: profileKey,
  send_count: 1,
  cleanup: 'skipped',
  witness: {
    user_message_id: 'proof-user',
    assistant_message_id: 'proof-assistant',
    relation: 'reply_to',
    source: 'service',
  },
  post_settlement_target: {
    disposition: 'preserved_after_settlement',
    configured_profile_key: profileKey,
    target_id: targetId,
    normalized_url: normalizedUrl,
    assistant_message_id: 'proof-assistant',
    representation: 'innerText',
    byte_length: reply.byteLength,
    sha256,
    document_ordinal: 1,
    observed_user_nodes: 1,
    observed_assistant_nodes: 1,
    observed_message_nodes: 2,
    generation_in_progress: false,
    nodes_truncated: false,
  },
};

const probeResult = {
  schema: 'browser-gpt-page-probe/v1',
  operation: 'export',
  status: 'ok',
  diagnostic_only: true,
  workflow_authority: 'none',
  configured_profile_key: profileKey,
  target_id: targetId,
  normalized_url: normalizedUrl,
  page_url: normalizedUrl,
  node: {
    role: 'assistant',
    ordinal: 0,
    document_ordinal: 1,
    message_id: 'proof-assistant',
  },
  assistant_message_id: 'proof-assistant',
  representation: 'innerText',
  byte_length: reply.byteLength,
  sha256,
  output_identity: {
    path: 'harvest.txt',
    byte_length: reply.byteLength,
    sha256,
  },
  observed_user_nodes: 1,
  observed_assistant_nodes: 1,
  observed_message_nodes: 2,
  generation_in_progress: false,
  nodes_truncated: false,
  last_assistant: true,
  last_message: true,
};

const guard = {
  ok: true,
  normalized_url: normalizedUrl,
  byte_length: reply.byteLength,
  sha256,
  observed_user_nodes: 1,
  observed_assistant_nodes: 1,
  observed_message_nodes: 2,
  generation_in_progress: false,
  nodes_truncated: false,
  assistant_message_id: 'proof-assistant',
  representation: 'innerText',
  document_ordinal: 1,
  ordinal: 0,
  last_assistant: true,
  last_message: true,
};

const channel: ExactTargetChannel = {
  evaluate: async () => {
    evaluateCalls++;
    if (evaluateCalls === 2) finalGuardSeen = true;
    return guard;
  },
  close: async () => {
    if (!finalGuardSeen) throw new Error('close_before_final_guard');
    closeCalls++;
    targetPresent = false;
    return 'acknowledged';
  },
  disconnect: () => {},
};

const deps: PostSettlementCloseDependencies = {
  readText: async (path) => JSON.stringify(path === 'direct-result.json' ? directResult : probeResult),
  readBytes: async () => reply,
  listTargets: async () => [
    ...(targetPresent ? [{
      id: targetId,
      type: 'page',
      url: normalizedUrl,
      webSocketDebuggerUrl: 'ws://proof/owned',
    }] : []),
    ...(foreignTargetPresent ? [{
      id: foreignTargetId,
      type: 'page',
      url: 'https://chatgpt.com/c/proof-foreign',
      webSocketDebuggerUrl: 'ws://proof/foreign',
    }] : []),
  ],
  openExactTargetChannel: async (target) => {
    if (target.id !== targetId) throw new Error('foreign_target_selected');
    return channel;
  },
};

const parsed = parsePostSettlementCloseArgs([
  '--turn-result', 'direct-result.json',
  '--probe-result', 'probe-result.json',
  '--harvest', 'harvest.txt',
  '--profile', profile,
  '--cdp', cdp,
]);
const result = await runPostSettlementClose(parsed, deps);
const proof = {
  ...result,
  proof: {
    boundary: 'browser-gpt-post-settlement-close-cli',
    transport: 'deterministic-in-memory-cdp',
    namespace_bound: result.configured_profile_key === profileKey,
    terminal_reply_bound: result.target_id === targetId && result.normalized_url === normalizedUrl,
    freshness_bound: evaluateCalls === 2,
    final_guard_before_close: finalGuardSeen && closeCalls === 1,
    foreign_target_present: foreignTargetPresent,
    external_side_effect_count: 0,
  },
};
process.stdout.write(`${JSON.stringify(proof)}\n`);
if (result.status !== 'closed'
  || result.close_attempt_count !== 1
  || !foreignTargetPresent
  || targetPresent
  || closeCalls !== 1
  || evaluateCalls !== 2) {
  process.exitCode = 1;
}
