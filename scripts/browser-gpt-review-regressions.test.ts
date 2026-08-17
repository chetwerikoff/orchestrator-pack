import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import {
  HARVEST_EXPRESSION,
  runProbe,
  type CdpTarget,
  type CompatibleTarget,
  type ProbeDependencies,
} from './browser-gpt-page-probe.ts';
import {
  admitStateLightTurnObservation,
  mutateStateLightTurnObservation,
  observationRecordKey,
  readStateLightTurnObservation,
  transitionStateLightTurnObservation,
} from './chatgpt-browser-turn/state-light-turn-observation.ts';
import { configuredProfileKey, profileDirs } from './chatgpt-browser-turn/storage-common.ts';

function sha256(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

function harvestSnapshot(marker: string, pageUrl = 'https://chatgpt.com/c/test') {
  const prompt = `${marker}\n\nprompt`;
  const reply = 'FINAL';
  return {
    status: 'ok',
    page_url: pageUrl,
    generation_in_progress: false,
    rows: [
      {
        role: 'user',
        ordinal: 0,
        document_ordinal: 0,
        message_id: 'user-review-regression',
        text: prompt,
        byte_length: Buffer.byteLength(prompt, 'utf8'),
        sha256: sha256(prompt),
      },
      {
        role: 'assistant',
        ordinal: 0,
        document_ordinal: 1,
        message_id: 'assistant-review-regression',
        text: reply,
        byte_length: Buffer.byteLength(reply, 'utf8'),
        sha256: sha256(reply),
      },
    ],
  } as const;
}

function probeDeps(
  targets: readonly CdpTarget[],
  evaluate: (target: CompatibleTarget, expression: string) => Promise<unknown>,
  publish?: ProbeDependencies['publish'],
): ProbeDependencies {
  return {
    listTargets: async () => targets,
    evaluate,
    publish: publish ?? (async () => {}),
  };
}

async function withObservation<T>(
  setup: (input: { profileKey: string; invocationId: string; marker: string }) => void,
  callback: (input: {
    stateDir: string;
    profile: string;
    cdp: string;
    profileKey: string;
    invocationId: string;
    marker: string;
    output: string;
  }) => Promise<T>,
): Promise<T> {
  const previous = process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
  const stateDir = mkdtempSync(join(tmpdir(), 'opk-1430-review-regression-'));
  process.env.CHATGPT_BROWSER_TURN_STATE_DIR = stateDir;
  const cdp = 'http://127.0.0.1:9222';
  const profile = join(stateDir, 'profile');
  const profileKey = configuredProfileKey(profile, cdp);
  const invocationId = '22222222-2222-4222-8222-222222222222';
  const marker = `OPKTURNV1${'44'.repeat(16)}`;
  const output = join(stateDir, 'reply.txt');
  try {
    admitStateLightTurnObservation({ profileKey, invocationId, marker });
    setup({ profileKey, invocationId, marker });
    return await callback({ stateDir, profile, cdp, profileKey, invocationId, marker, output });
  } finally {
    if (previous === undefined) delete process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
    else process.env.CHATGPT_BROWSER_TURN_STATE_DIR = previous;
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test('ordinary long-run invocation identity is forwarded without selecting direct publication mode', () => {
  const source = readFileSync(new URL('./flow-manager-browser-gpt-long-run.ts', import.meta.url), 'utf8');
  const directKeys = source.match(/const directArgumentKeys = \[([^\]]+)\];/u);
  assert.ok(directKeys, 'directArgumentKeys declaration must remain inspectable');
  assert.doesNotMatch(directKeys[1]!, /invocation-id/u);
  assert.match(
    source,
    /for \(const key of \['invocation-id', 'reviewer-source', 'repository', 'issue-number', 'source-revision', 'timeout-ms', 'poll-ms'\]\)/u,
  );
});

test('harvest recovers an already-bound dispatching turn from its exact owned marker without inventing send_count', async () => {
  await withObservation(
    ({ profileKey, invocationId }) => {
      transitionStateLightTurnObservation({
        profileKey,
        invocationId,
        phase: 'dispatching',
        reason: 'review_regression_dispatch_boundary',
        conversationUrl: 'https://chatgpt.com/c/test',
      });
    },
    async ({ profile, cdp, profileKey, invocationId, marker, output }) => {
      const target: CdpTarget = {
        id: 'owned-bound-dispatching',
        type: 'page',
        url: 'https://chatgpt.com/c/test',
        title: 'Owned',
        webSocketDebuggerUrl: 'ws://example/owned-bound-dispatching',
      };
      const result = await runProbe(
        { operation: 'harvest', cdp, profile, invocationId, output },
        probeDeps(
          [target],
          async (_target, expression) => {
            assert.equal(expression, HARVEST_EXPRESSION);
            return harvestSnapshot(marker);
          },
          async (destination, bytes) => { writeFileSync(destination, bytes); },
        ),
      );

      assert.equal(result.status, 'ok');
      assert.equal(result.harvested, true);
      const record = readStateLightTurnObservation(profileKey, invocationId);
      assert.equal(record.phase, 'harvested');
      assert.equal(record.conversation_url, 'https://chatgpt.com/c/test');
      assert.equal(record.send_witness, 'owned_marker');
      assert.equal(record.send_count, undefined);
      assert.equal(readFileSync(output, 'utf8'), 'FINAL');
    },
  );
});

test('unbound harvest fails closed when any compatible candidate cannot be read', async () => {
  await withObservation(
    ({ profileKey, invocationId }) => {
      transitionStateLightTurnObservation({
        profileKey,
        invocationId,
        phase: 'dispatching',
        reason: 'review_regression_dispatch_boundary',
      });
      transitionStateLightTurnObservation({
        profileKey,
        invocationId,
        phase: 'sent_unbound',
        reason: 'review_regression_unbound_send',
        sendWitness: 'owned_marker',
      });
    },
    async ({ profile, cdp, profileKey, invocationId, marker, output }) => {
      const targets: readonly CdpTarget[] = [
        {
          id: 'readable-owned',
          type: 'page',
          url: 'https://chatgpt.com/c/owned',
          webSocketDebuggerUrl: 'ws://example/readable-owned',
        },
        {
          id: 'unreadable-compatible',
          type: 'page',
          url: 'https://chatgpt.com/c/unreadable',
          webSocketDebuggerUrl: 'ws://example/unreadable-compatible',
        },
      ];
      let publishCalls = 0;
      await assert.rejects(
        runProbe(
          { operation: 'harvest', cdp, profile, invocationId, output },
          probeDeps(
            targets,
            async (target, expression) => {
              assert.equal(expression, HARVEST_EXPRESSION);
              if (target.target_id === 'unreadable-compatible') throw new Error('fixture_unreadable');
              return harvestSnapshot(marker, 'https://chatgpt.com/c/owned');
            },
            async () => { publishCalls += 1; },
          ),
        ),
        (error: any) => error.status === 'surface_unknown'
          && error.reason === 'owned_turn_unbound_census_incomplete',
      );
      assert.equal(publishCalls, 0);
      assert.equal(readStateLightTurnObservation(profileKey, invocationId).phase, 'sent_unbound');
    },
  );
});

test('ordinary observation mutation exposes retirement cleanup and the next mutation retires the empty slot', async () => {
  await withObservation(
    () => {},
    async ({ profileKey, invocationId }) => {
      const slotPath = join(
        profileDirs(profileKey).locks,
        `state-light-turn-observation-${observationRecordKey(invocationId)}.slot`,
      );
      const blocker = join(slotPath, 'retirement-blocker');

      assert.throws(
        () => mutateStateLightTurnObservation(profileKey, invocationId, (current) => {
          writeFileSync(blocker, 'block retirement');
          return {
            ...current,
            phase: 'dispatching',
            transitioned_at: new Date().toISOString(),
            transition_reason: 'review_regression_committed_before_retirement',
          };
        }),
        /observation_mutation_retirement_cleanup_required/u,
      );
      assert.equal(readStateLightTurnObservation(profileKey, invocationId).phase, 'dispatching');

      unlinkSync(blocker);
      const recovered = transitionStateLightTurnObservation({
        profileKey,
        invocationId,
        phase: 'sent_unbound',
        reason: 'review_regression_retirement_retry',
        sendWitness: 'owned_marker',
      });
      assert.equal(recovered.phase, 'sent_unbound');
      assert.equal(recovered.send_witness, 'owned_marker');
    },
  );
});
