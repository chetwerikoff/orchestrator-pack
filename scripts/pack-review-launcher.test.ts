import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquirePackReviewStageClaim,
  establishPriorTurnState,
  isGenericRunnerClaimPath,
  isPackReviewStageClaimPath,
  readPackReviewStageClaim,
  resolvePackReviewStageClaimNamespace,
  updatePackReviewStageClaimFields,
} from './lib/pack-review-stage-claim.ts';
import {
  decideLauncherAction,
  launchPackReviewChat,
  readLauncherWitness,
  type CallerClass,
  type CallerObservationClass,
  type EstablishedPriorTurnState,
  type PrResolution,
} from './lib/pack-review-launcher.ts';
import {
  exitCodeAloneIsNotProvenNonDelivery,
  isProducerGroundedProvenNonDelivery,
  PACK_REVIEW_PROVEN_NON_DELIVERY_SEAM,
} from './lib/pack-review-proven-non-delivery.ts';
import { acquireReviewStartClaim, claimPath, initializeNamespace, resolveReviewStartClaimNamespace } from './lib/review-start-claim-store.ts';

const HEAD = 'a'.repeat(40);
const HEAD_H2 = 'b'.repeat(40);
const PR = 1111;
const tempRoots: string[] = [];

function tempNamespace(): string {
  const root = mkdtempSync(join(tmpdir(), 'opk-pack-review-launcher-'));
  tempRoots.push(root);
  initializeNamespace(root);
  return root;
}

function openPr(headSha = HEAD): PrResolution {
  return { repoSlug: 'chetwerikoff/orchestrator-pack', prNumber: PR, headSha, state: 'OPEN' };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

const OBSERVATIONS: CallerObservationClass[] = ['A1', 'A2', 'A3', 'A4'];
const B_STATES: EstablishedPriorTurnState[] = ['B1', 'B2', 'B3', 'B4', 'B5'];
const CALLERS: CallerClass[] = ['worker', 'operator', 'fanout'];

function seedEstablishedState(namespace: string, state: EstablishedPriorTurnState, replyPath?: string): void {
  if (state === 'B1') return;
  const existing = readPackReviewStageClaim(namespace, PR, HEAD);
  if (existing.ok && state === 'B5') {
    rmSync(existing.path, { force: true });
  } else if (existing.ok) {
    return;
  }
  const claim = acquirePackReviewStageClaim({
    prNumber: PR,
    headSha: HEAD,
    surface: 'fixture',
    namespace,
    startReason: 'fixture',
  });
  expect(claim.acquired).toBe(true);
  const workDir = join(namespace, 'work', 'fixture');
  mkdirSync(workDir, { recursive: true });
  switch (state) {
    case 'B2':
      updatePackReviewStageClaimFields(claim, { turnState: 'live', childPid: process.pid, workDir });
      break;
    case 'B3':
      updatePackReviewStageClaimFields(claim, { turnState: 'possible_delivery', childPid: 999999, workDir });
      break;
    case 'B4': {
      const reply = replyPath ?? join(workDir, 'reply.txt');
      writeFileSync(reply, '{"verdict":"clean","findings":[]}', 'utf8');
      updatePackReviewStageClaimFields(claim, { turnState: 'completed', replyPath: reply, workDir });
      break;
    }
    case 'B5':
      updatePackReviewStageClaimFields(claim, {
        turnState: 'proven_non_delivery',
        remediationCompleted: true,
        provenNonDelivery: { scope: 'invocation', cause: 'dispatch_request_not_issued', phase: 'pre_send', remediatedAtUtc: new Date().toISOString() },
        workDir,
      });
      break;
    default:
      break;
  }
}

describe('pack-review launcher matrix (Issue #1111 AC11)', () => {
  for (const observation of OBSERVATIONS) {
    for (const established of B_STATES) {
      for (const caller of CALLERS) {
        it(`${observation}×${established}×${caller}`, async () => {
          const namespace = tempNamespace();
          let sendCount = 0;
          seedEstablishedState(namespace, established);
          const result = await launchPackReviewChat({
            prNumber: PR,
            namespace,
            caller,
            observation,
            deps: {
              resolvePr: async () => openPr(),
              spawnDetachedReview: async ({ workDir, claim }) => {
                sendCount += 1;
                mkdirSync(workDir, { recursive: true });
                writeFileSync(join(workDir, 'launcher-started.json'), JSON.stringify({ childPid: 4242 }), 'utf8');
                updatePackReviewStageClaimFields(claim, { turnState: 'live', childPid: 4242, workDir });
                return { childPid: 4242, workDir };
              },
              childAlive: (pid) => pid === process.pid || pid === 4242,
              replyExists: (path) => existsSync(path),
            },
          });
          const decision = decideLauncherAction({ observation, established, caller });
          if (decision.allowSend) {
            expect(result.newChatSendCount).toBe(1);
            expect(result.disposition).toBe('started');
            expect(sendCount).toBe(1);
          } else if (established === 'unknown' && (observation === 'A2' || observation === 'A4')) {
            expect(result.disposition).toBe('recovery_required');
            expect(sendCount).toBe(0);
          } else {
            expect(sendCount).toBe(0);
            expect(result.newChatSendCount).toBe(0);
            expect(['adopted', 'recovery', 'consumed', 'recovery_required', 'ambiguous_claim']).toContain(result.disposition);
          }
        });
      }
    }
  }
});

describe('pack-review launcher regressions and boundaries', () => {
  it('AC1: pre-claim errors create zero stage claims and zero sends', async () => {
    const namespace = tempNamespace();
    let sendCount = 0;
    const closed = await launchPackReviewChat({
      prNumber: PR,
      namespace,
      deps: {
        resolvePr: async () => ({ ...openPr(), state: 'CLOSED' }),
        spawnDetachedReview: async () => { sendCount += 1; return { childPid: 1, workDir: '/tmp/x' }; },
      },
    });
    expect(closed.disposition).toBe('pre_claim_error');
    expect(sendCount).toBe(0);
    expect(readPackReviewStageClaim(namespace, PR, HEAD).ok).toBe(false);

    const ghFail = await launchPackReviewChat({
      prNumber: PR,
      namespace,
      deps: {
        resolvePr: async () => { throw new Error('gh_pr_resolution_failed:offline'); },
        spawnDetachedReview: async () => { sendCount += 1; return { childPid: 1, workDir: '/tmp/x' }; },
      },
    });
    expect(ghFail.disposition).toBe('pre_claim_error');
    expect(sendCount).toBe(0);
  });

  it('AC2: concurrent same-identity contenders deduplicate to one send', async () => {
    const namespace = tempNamespace();
    let sendCount = 0;
    const deps = {
      resolvePr: async () => openPr(),
      spawnDetachedReview: async ({ workDir }: { workDir: string }) => {
        sendCount += 1;
        return { childPid: 9000, workDir };
      },
      childAlive: (pid: number) => pid === 9000,
    };
    const results = await Promise.all(
      Array.from({ length: 3 }, () => launchPackReviewChat({ prNumber: PR, namespace, deps })),
    );
    expect(sendCount).toBe(1);
    expect(results.filter((r) => r.newChatSendCount === 1)).toHaveLength(1);
    expect(results.filter((r) => r.disposition === 'adopted').length).toBeGreaterThanOrEqual(1);
  });

  it('AC7: A2/A4 without established B fail closed', async () => {
    const namespace = tempNamespace();
    const stagePath = join(namespace, `pr-${PR}-${HEAD}.json`);
    writeFileSync(stagePath, '{not-json', 'utf8');
    for (const observation of ['A2', 'A4'] as const) {
      const result = await launchPackReviewChat({
        prNumber: PR,
        namespace,
        observation,
        deps: { resolvePr: async () => openPr() },
      });
      expect(result.disposition).toBe('recovery_required');
      expect(result.newChatSendCount).toBe(0);
    }
  });

  it('AC6: B5 requires producer-grounded predicate and remediation', () => {
    expect(isProducerGroundedProvenNonDelivery({
      scope: 'invocation',
      cause: 'dispatch_request_not_issued',
      phase: 'pre_send',
      remediationCompleted: true,
    })).toBe(true);
    expect(isProducerGroundedProvenNonDelivery({ exitCode: 10, remediationCompleted: true })).toBe(false);
    expect(exitCodeAloneIsNotProvenNonDelivery(10)).toBe(true);
    expect(PACK_REVIEW_PROVEN_NON_DELIVERY_SEAM).toContain('pack-review');
  });

  it('AC8: detached witness survives parent read-back', async () => {
    const namespace = tempNamespace();
    const workDir = join(namespace, 'work', 'detached');
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, 'launcher-started.json'), JSON.stringify({ childPid: 5151, startedAtUtc: new Date().toISOString() }), 'utf8');
    const witness = readLauncherWitness(workDir);
    expect(witness?.childPid).toBe(5151);
    const adopt = await launchPackReviewChat({
      prNumber: PR,
      namespace,
      deps: {
        resolvePr: async () => openPr(),
        childAlive: (pid) => pid === 5151,
        spawnDetachedReview: async () => ({ childPid: 5151, workDir }),
      },
    });
    const adopted = await launchPackReviewChat({
      prNumber: PR,
      namespace,
      deps: {
        resolvePr: async () => openPr(),
        childAlive: (pid) => pid === 5151,
        spawnDetachedReview: async () => ({ childPid: 5151, workDir }),
      },
    });
    expect(adopted.newChatSendCount).toBe(0);
    expect(adopted.disposition).toBe('adopted');
    expect(adopt.newChatSendCount).toBeLessThanOrEqual(1);
  });

  it('AC9: new head is distinct identity', async () => {
    const namespace = tempNamespace();
    seedEstablishedState(namespace, 'B3');
    let sendCount = 0;
    const h2 = await launchPackReviewChat({
      prNumber: PR,
      headSha: HEAD_H2,
      namespace,
      deps: {
        resolvePr: async () => openPr(HEAD_H2),
        spawnDetachedReview: async ({ workDir }) => { sendCount += 1; return { childPid: 1, workDir }; },
      },
    });
    expect(h2.newChatSendCount).toBe(1);
    expect(readPackReviewStageClaim(namespace, PR, HEAD).ok).toBe(true);
    const h2again = await launchPackReviewChat({
      prNumber: PR,
      headSha: HEAD_H2,
      namespace,
      deps: {
        resolvePr: async () => openPr(HEAD_H2),
        spawnDetachedReview: async ({ workDir }) => { sendCount += 1; return { childPid: 2, workDir }; },
        childAlive: () => true,
      },
    });
    expect(h2again.newChatSendCount).toBe(0);
    expect(sendCount).toBe(1);
  });

  it('AC10 two-session: independent PR identities do not serialize', async () => {
    const namespace = tempNamespace();
    const sendByPr = new Map<number, number>();
    const deps = {
      resolvePr: async (_root: string, prNumber: number) => openPr(HEAD.slice(0, 39) + String(prNumber % 10)),
      spawnDetachedReview: async ({ workDir, claim }: { workDir: string; claim: { path?: string } }) => {
        const current = Number((claim.path ?? '').match(/pr-(\d+)-/)?.[1] ?? 0);
        sendByPr.set(current, (sendByPr.get(current) ?? 0) + 1);
        return { childPid: 100 + current, workDir };
      },
    };
    await Promise.all([1106, 1107, 1108].map((pr) => launchPackReviewChat({ prNumber: pr, namespace, deps })));
    expect([...sendByPr.values()].reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('fresh-orphan: a dead live claim does not permit a new send', async () => {
    const namespace = tempNamespace();
    const claim = acquirePackReviewStageClaim({
      prNumber: PR,
      headSha: HEAD,
      surface: 'fixture',
      namespace,
      startReason: 'fixture',
    });
    expect(claim.acquired).toBe(true);
    updatePackReviewStageClaimFields(claim, {
      turnState: 'live',
      childPid: 9_999_999,
      workDir: join(namespace, 'work', 'fresh-orphan'),
    });

    let sendCount = 0;
    const result = await launchPackReviewChat({
      prNumber: PR,
      namespace,
      observation: 'A3',
      deps: {
        resolvePr: async () => openPr(),
        spawnDetachedReview: async () => {
          sendCount += 1;
          return { childPid: 1234, workDir: join(namespace, 'work', 'fresh-orphan-send') };
        },
        childAlive: () => false,
      },
    });

    expect(result.newChatSendCount).toBe(0);
    expect(sendCount).toBe(0);
    expect(['adopted', 'recovery', 'ambiguous_claim', 'recovery_required']).toContain(result.disposition);
  });

  it('AC12 duplicate-1088: delayed second start adopts', async () => {
    const namespace = tempNamespace();
    let sendCount = 0;
    const deps = {
      resolvePr: async () => openPr(),
      spawnDetachedReview: async ({ workDir }: { workDir: string }) => {
        sendCount += 1;
        updatePackReviewStageClaimFields(
          acquirePackReviewStageClaim({ prNumber: PR, headSha: HEAD, surface: 'x', namespace }),
          { turnState: 'live', childPid: 1088, workDir },
        );
        return { childPid: 1088, workDir };
      },
      childAlive: (pid: number) => pid === 1088,
    };
    const first = await launchPackReviewChat({ prNumber: PR, namespace, deps });
    await new Promise((r) => setTimeout(r, 20));
    const second = await launchPackReviewChat({ prNumber: PR, namespace, deps });
    expect(sendCount).toBe(1);
    expect(first.newChatSendCount + second.newChatSendCount).toBe(1);
    expect(second.disposition).toBe('adopted');
  });

  it('PR-1107 shell-scope: stage and generic runner claims occupy distinct namespaces', async () => {
    const generic = resolveReviewStartClaimNamespace({});
    const stage = resolvePackReviewStageClaimNamespace({});
    const genericPath = claimPath(generic, PR, HEAD);
    const stagePath = claimPath(stage, PR, HEAD);
    expect(isPackReviewStageClaimPath(stagePath)).toBe(true);
    expect(isGenericRunnerClaimPath(genericPath, generic)).toBe(true);
    expect(stagePath).not.toBe(genericPath);
    expect(stage).toContain('stage-pack-review');

    const genericClaim = acquireReviewStartClaim({
      prNumber: PR,
      headSha: HEAD,
      surface: 'generic-shell-scope',
      namespace: generic,
      startReason: 'fixture',
    });
    expect(genericClaim.acquired).toBe(true);

    let sendCount = 0;
    const result = await launchPackReviewChat({
      prNumber: PR,
      namespace: stage,
      deps: {
        resolvePr: async () => openPr(),
        spawnDetachedReview: async ({ workDir }) => {
          sendCount += 1;
          return { childPid: 2024, workDir };
        },
      },
    });

    expect(result.newChatSendCount).toBe(1);
    expect(sendCount).toBe(1);
  });

  it('AC19: #1066 open — local seam is pack-review scoped', () => {
    expect(PACK_REVIEW_PROVEN_NON_DELIVERY_SEAM.startsWith('pack-review')).toBe(true);
  });

  it('establishPriorTurnState positive B1 on missing claim', () => {
    const namespace = tempNamespace();
    const read = readPackReviewStageClaim(namespace, PR, HEAD);
    expect(establishPriorTurnState({ claimRead: read })).toBe('B1');
  });
});
