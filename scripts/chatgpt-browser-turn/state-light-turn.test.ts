// @vitest-ci-lane light
// @vitest-pre-topology-seconds 2
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runProbe, type ProbeDependencies } from '../browser-gpt-page-probe.ts';
import { configuredProfileKey, profileDirs } from './storage-common.ts';
import {
  admitStateLightTurnObservation,
  observationRecordKey,
  readStateLightTurnObservation,
  transitionStateLightTurnObservation,
} from './state-light-turn-observation.ts';
import { runStateLightTurn, type TurnRunOutcome } from './state-light-turn.ts';

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function harvestRow(
  role: 'user' | 'assistant',
  ordinal: number,
  documentOrdinal: number,
  messageId: string,
  text: string,
) {
  return {
    role,
    ordinal,
    document_ordinal: documentOrdinal,
    message_id: messageId,
    text,
    byte_length: Buffer.byteLength(text, 'utf8'),
    sha256: sha256(text),
  };
}

describe('Issue #1430 retirement cleanup visibility', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'opk-1430-retirement-'));
    process.env.CHATGPT_BROWSER_TURN_STATE_DIR = join(root, 'state');
  });

  afterEach(() => {
    delete process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
    if (root) rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('surfaces a post-commit mutation-retirement failure from harvest without undoing the committed reply', async () => {
    const cdp = 'http://127.0.0.1:9222';
    const profile = join(root, 'profile');
    const profileKey = configuredProfileKey(profile, cdp);
    const invocationId = randomUUID();
    const marker = `OPKTURNV1${'44'.repeat(16)}`;
    const conversationUrl = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
    const output = join(root, 'reply.txt');
    const reply = 'FINAL';

    admitStateLightTurnObservation({ profileKey, invocationId, marker });
    transitionStateLightTurnObservation({
      profileKey,
      invocationId,
      phase: 'dispatching',
      reason: 'retirement_fault_dispatch_boundary',
    });
    transitionStateLightTurnObservation({
      profileKey,
      invocationId,
      phase: 'sent_unharvested',
      reason: 'retirement_fault_send',
      sendCount: 1,
      sendWitness: 'numeric_send_count',
      conversationUrl,
    });

    const mutationSlot = join(
      profileDirs(profileKey).locks,
      `state-light-turn-observation-${observationRecordKey(invocationId)}.slot`,
    );
    const deps: ProbeDependencies = {
      listTargets: async () => [{
        id: 'retirement-target',
        type: 'page',
        url: conversationUrl,
        title: 'Retirement fixture',
        webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/retirement-target',
      }],
      evaluate: async () => ({
        status: 'ok',
        page_url: conversationUrl,
        generation_in_progress: false,
        rows: [
          harvestRow('user', 0, 0, 'u-retirement', `${marker}\n\nprompt`),
          harvestRow('assistant', 0, 1, 'a-retirement', reply),
        ],
      }),
      publish: async (destination, bytes) => {
        writeFileSync(destination, Buffer.from(bytes), { flag: 'wx' });
        // Publication is committed. Leave an extra child in the mutation slot
        // so lease retirement fails as cleanup-only evidence after finalization.
        writeFileSync(join(mutationSlot, 'retirement-blocker'), 'block');
      },
    };

    const result = await runProbe({
      operation: 'harvest',
      cdp,
      profile,
      invocationId,
      output,
    }, deps);

    expect(result).toMatchObject({
      status: 'ok',
      harvested: true,
      retirement_cleanup_required: true,
      workflow_authority: 'none',
      byte_length: Buffer.byteLength(reply, 'utf8'),
      sha256: sha256(reply),
    });
    expect(readFileSync(output, 'utf8')).toBe(reply);
    expect(readStateLightTurnObservation(profileKey, invocationId).phase).toBe('harvested');
  });

  it('keeps retirement_cleanup_required visible in the public normal-turn result', async () => {
    const invocationId = randomUUID();
    const outcome: TurnRunOutcome = {
      result: {
        schema: 'turn-result/v1',
        state: 'ok',
        scope: 'none',
        cause: 'completed_page_only',
        invocation_id: invocationId,
        configured_profile_key: 'profile-test',
        send_count: 1,
        poll_count: 2,
        goto_count: 0,
        new_chat_click_count: 0,
        navigation_count: 0,
        incidents: [],
        retirement_cleanup_required: true,
      },
    };
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    try {
      const code = await runStateLightTurn([
        '--profile', join(root, 'profile'),
        '--cdp', 'http://127.0.0.1:9222',
        '--input', join(root, 'prompt.txt'),
        '--invocation-id', invocationId,
      ], {
        runTurn: async () => outcome,
      });
      expect(code).toBe(0);
    } finally {
      stdout.mockRestore();
    }

    const result = JSON.parse(writes.at(-1) ?? '{}') as Record<string, unknown>;
    expect(result).toMatchObject({
      schema: 'turn-result/v1',
      state: 'ok',
      invocation_id: invocationId,
      retirement_cleanup_required: true,
      cleanup: 'skipped',
    });
  });
});
