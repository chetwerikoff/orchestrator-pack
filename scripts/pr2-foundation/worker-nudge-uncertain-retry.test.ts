import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestRootRegistry } from './test-root.ts';
import {
  acquireWorkerNudgeClaim,
  finalizeWorkerNudgeClaim,
  markWorkerNudgeSendAttempted,
  persistWorkerNudgeMessageHash,
  workerNudgeClaimNamespace,
} from './worker-nudge-claim-store.ts';

const testRoots = createTestRootRegistry();
const originalAoBaseDir = process.env.AO_BASE_DIR;

afterEach(() => {
  if (originalAoBaseDir === undefined) delete process.env.AO_BASE_DIR;
  else process.env.AO_BASE_DIR = originalAoBaseDir;
  testRoots.cleanup();
});

function request(cycleSuffix: string) {
  return {
    prNumber: 923,
    cycleKey: `stdout:sha256:${'c'.repeat(64)}${cycleSuffix}`,
    intentClass: 'review-findings',
    workerTarget: 'worker-923:generation-d4',
    sessionId: 'worker-923',
    targetId: 'worker-923',
    targetGeneration: 'generation-d4',
    surface: 'scripted-review-stdout-delivery',
    projectId: 'orchestrator-pack',
    message: 'Pack review completed for PR #923.',
  };
}

async function prepareSendAttempt(input: ReturnType<typeof request>) {
  const claim = await acquireWorkerNudgeClaim(input);
  expect(claim).toMatchObject({ acquired: true });
  if (!claim.acquired) throw new Error(claim.reason);
  expect(await persistWorkerNudgeMessageHash(claim, input.message)).toMatchObject({ ok: true });
  expect(await markWorkerNudgeSendAttempted(claim)).toEqual({ ok: true });
  return claim;
}

function terminalRecords(): Array<Record<string, unknown>> {
  const directory = path.join(workerNudgeClaimNamespace('orchestrator-pack'), 'terminal');
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(path.join(directory, name), 'utf8')) as Record<string, unknown>);
}

describe('[AC4/D4] uncertain worker notification retries', () => {
  it('retries after an explicitly finalized uncertain send while preserving its durable attempt', async () => {
    const root = testRoots.create('opk-pr2-d4-finalized-');
    process.env.AO_BASE_DIR = path.join(root, 'ao-base');
    const input = request(':finalized');

    const uncertain = await prepareSendAttempt(input);
    expect(await finalizeWorkerNudgeClaim(uncertain, 'UNCERTAIN', {
      reason: 'dispatch_timeout',
    })).toMatchObject({ ok: true });
    expect(terminalRecords()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phase: 'UNCERTAIN',
        state: 'UNCERTAIN',
        messageContentHash: expect.any(String),
      }),
    ]));

    const retry = await acquireWorkerNudgeClaim(input);
    expect(retry).toMatchObject({ acquired: true });
    if (!retry.acquired) throw new Error(retry.reason);
    expect(retry.claim.holder.processGuid).not.toBe(uncertain.claim.holder.processGuid);
    expect(await persistWorkerNudgeMessageHash(retry, input.message)).toMatchObject({ ok: true });
    expect(await markWorkerNudgeSendAttempted(retry)).toEqual({ ok: true });
    expect(await finalizeWorkerNudgeClaim(retry, 'SENT')).toMatchObject({ ok: true });

    expect(await acquireWorkerNudgeClaim(input)).toMatchObject({
      acquired: false,
      reason: 'already_served',
      terminal: true,
      phase: 'SENT',
    });
  });

  it('recovers a crashed send-attempt and returns the replacement claim in the same acquisition', async () => {
    const root = testRoots.create('opk-pr2-d4-interrupted-');
    process.env.AO_BASE_DIR = path.join(root, 'ao-base');
    const input = request(':interrupted');

    const interrupted = await prepareSendAttempt(input);
    const recovered = await acquireWorkerNudgeClaim(input);
    expect(recovered).toMatchObject({ acquired: true });
    if (!recovered.acquired) throw new Error(recovered.reason);
    expect(recovered.claim.holder.processGuid).not.toBe(interrupted.claim.holder.processGuid);
    expect(terminalRecords()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phase: 'UNCERTAIN',
        state: 'UNCERTAIN',
        recoveredFromPhase: 'SEND_ATTEMPTED',
        retryAllowed: true,
      }),
    ]));

    expect(await persistWorkerNudgeMessageHash(recovered, input.message)).toMatchObject({ ok: true });
    expect(await markWorkerNudgeSendAttempted(recovered)).toEqual({ ok: true });
    expect(await finalizeWorkerNudgeClaim(recovered, 'SENT')).toMatchObject({ ok: true });
  });
});
