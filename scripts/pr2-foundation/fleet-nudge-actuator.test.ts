import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IDLE_NUDGE_MESSAGE,
  LIVELOCK_NUDGE_MESSAGE,
  S2_MAX_STARTS_PER_TICK,
  S2_MAX_TERMINALS_PER_GENERATION,
  S2_ONE_SHOT_POLICY,
  S2_RETENTION_TICKS,
  calculateFleetNudgeBudget,
  runFleetNudgeActuator,
  type FleetNudgeEffects,
  type FleetNudgeEpisode,
  type FleetNudgeResult,
  type FleetNudgeUnitOutcome,
  type RuntimeFleetNudgeBinding,
} from './fleet-nudge-actuator.ts';
import type {
  CensusRow,
  FleetObserverResult,
  FleetTransition,
  ObserverClass,
} from './fleet-observer.ts';
import {
  acquireS2OneShotWorkerNudgeClaim,
  finalizeS2OneShotWorkerNudgeClaim,
  markS2OneShotWorkerNudgeSendAttempted,
  markWorkerNudgeSendAttempted,
  persistWorkerNudgeMessageHash,
  pruneS2OneShotWorkerNudgeClaims,
  releaseS2OneShotWorkerNudgeClaim,
  type S2OneShotWorkerNudgeClaimHandle,
} from './worker-nudge-claim-store.ts';
import {
  admitS2FleetNudgeJournal,
  finalizeS2FleetNudgeJournal,
  type S2FleetNudgeJournalHandle,
} from './worker-dispatch-journal.ts';
import { buildS2EpisodeKey } from './worker-nudge-gate.ts';
import type { RuntimeDispatchResult } from '../runtime/contracts.ts';
import {
  productionSchedulerBoundary,
  runSchedulerTick,
  type SchedulerBoundary,
} from './scheduler.ts';

const roots: string[] = [];
const OPAQUE_ID = 'opaque-runtime-id-must-not-persist';
const OPAQUE_GENERATION = 'opaque-runtime-generation-must-not-persist';
const OPAQUE_TOKEN = 'opaque-observation-token-must-not-persist';

function root(prefix: string): string {
  const created = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(created);
  return created;
}

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function row(
  unitRef: string,
  className: ObserverClass,
  provenance: CensusRow['provenance'] = 'internal',
): CensusRow {
  return {
    unitRef,
    provenance,
    class: className,
    reason: className === 'livelock' ? 'configured-window-reached' : `positive-${className}`,
    probes: {
      output: className === 'unknown' ? 'failed' : 'valid',
      liveness: className === 'livelock' || className === 'busy'
        ? 'busy'
        : className === 'idle'
          ? 'idle'
          : className === 'unknown'
            ? 'failed'
            : 'idle',
    },
    livelockStreak: className === 'livelock' ? 60 : 0,
  };
}

function changed(
  unitRef: string,
  toClass: ObserverClass,
  tickSequence = 2,
  fromClass: ObserverClass = 'busy',
): FleetTransition {
  return {
    type: 'class-changed',
    unitRef,
    tickSequence,
    reason: toClass === 'livelock' ? 'configured-window-reached' : `positive-${toClass}`,
    fromClass,
    toClass,
  };
}

function appeared(unitRef: string, tickSequence = 2): FleetTransition {
  return { type: 'unit-appeared', unitRef, tickSequence, reason: 'unit-present' };
}

function observerResult(input: {
  rows: CensusRow[];
  transitions: FleetTransition[];
  tickSequence?: number;
  schedulerGeneration?: string;
  status?: 'complete' | 'failed';
}): FleetObserverResult {
  const tickSequence = input.tickSequence ?? 2;
  const schedulerGeneration = input.schedulerGeneration ?? 'sg-s2-test';
  const status = input.status ?? 'complete';
  return {
    result: status === 'complete' ? 'census-published-observer-only' : 'observer-failed',
    status,
    ...(status === 'failed' ? { reason: 'observer-failed' } : {}),
    snapshotCommitted: status === 'complete',
    snapshotPath: '/bounded/snapshot.json',
    schedulerGeneration,
    tickSequence,
    effectiveBudgetMs: 250,
    schedulerReturnedWithinBudget: true,
    staleCompletionRejected: false,
    fleetCapFailClosed: true,
    goneSemanticsClosed: true,
    exceptionCollisionRejected: true,
    zeroActuation: true,
    snapshot: {
      schemaVersion: 1,
      commitStatus: 'complete',
      schedulerGeneration,
      tickSequence,
      startedAt: '2026-08-06T00:00:00.000Z',
      completedAt: '2026-08-06T00:00:00.001Z',
      configuredBudgetMs: null,
      effectiveBudgetMs: 250,
      settlementReserveMs: 50,
      maxUnits: 256,
      maxSnapshotBytes: 1_048_576,
      result: status,
      census: input.rows,
      transitions: input.transitions,
      progress: [{
        type: status === 'complete' ? 'tick-complete' : 'tick-failed',
        schedulerGeneration,
        tickSequence,
        at: '2026-08-06T00:00:00.001Z',
      }],
    },
  };
}

function oneIdleObserver(
  unitRef = 'u-000001',
  tickSequence = 2,
  schedulerGeneration = 'sg-s2-test',
): FleetObserverResult {
  return observerResult({
    rows: [row(unitRef, 'idle')],
    transitions: [changed(unitRef, 'idle', tickSequence)],
    tickSequence,
    schedulerGeneration,
  });
}

function bindingFor(episode: Omit<FleetNudgeEpisode, 'issueNumber'>): RuntimeFleetNudgeBinding {
  return {
    ...episode,
    issueNumber: 1259,
    worker: {
      runtime: 'fake-runtime',
      id: OPAQUE_ID,
      generation: OPAQUE_GENERATION,
    },
    previousOutputToken: { opaque: OPAQUE_TOKEN },
  };
}

function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.json'));
}

function realEffects(input: {
  namespace: string;
  journalPath?: string;
  dispatch?: RuntimeDispatchResult;
  mutate?: Partial<FleetNudgeEffects>;
}): {
  effects: FleetNudgeEffects;
  sends: Array<{ binding: RuntimeFleetNudgeBinding; message: string }>;
  journalPath: string;
} {
  const sends: Array<{ binding: RuntimeFleetNudgeBinding; message: string }> = [];
  const journalPath = input.journalPath ?? path.join(input.namespace, 'dispatch-journal.json');
  const base: FleetNudgeEffects = {
    assertEpoch: () => {},
    resolveTarget: async (episode) => ({ status: 'resolved', binding: bindingFor(episode) }),
    revalidate: async () => ({ status: 'valid' }),
    acquireClaim: async (episode, options) => {
      const acquired = await acquireS2OneShotWorkerNudgeClaim({
        ...episode,
        namespace: input.namespace,
        deadlineMs: options.deadlineMs,
      });
      return acquired.acquired
        ? { status: 'acquired', handle: { opaque: acquired } }
        : { status: acquired.reason === 'claim_terminal' ? 'claim_terminal' : 'claim_untrusted' };
    },
    persistMessageHash: async (handle, message, options) =>
      persistWorkerNudgeMessageHash(
        handle.opaque as S2OneShotWorkerNudgeClaimHandle,
        message,
        options,
      ),
    admitJournal: async (episode, message, options) => {
      const admitted = await admitS2FleetNudgeJournal({
        journalPath,
        episode,
        message,
        deadlineMs: options.deadlineMs,
      });
      return admitted.status === 'admitted'
        ? { status: 'admitted', handle: { opaque: admitted.handle } }
        : { status: 'claim_untrusted' };
    },
    markSendAttempted: async (handle, options) =>
      markS2OneShotWorkerNudgeSendAttempted(
        handle.opaque as S2OneShotWorkerNudgeClaimHandle,
        options,
      ),
    releaseClaim: async (handle, options) =>
      releaseS2OneShotWorkerNudgeClaim(
        handle.opaque as S2OneShotWorkerNudgeClaimHandle,
        options,
      ),
    dispatch: async (binding, message) => {
      sends.push({ binding, message });
      return input.dispatch ?? { status: 'dispatched' };
    },
    finalizeClaim: async (handle, phase, options) =>
      finalizeS2OneShotWorkerNudgeClaim(
        handle.opaque as S2OneShotWorkerNudgeClaimHandle,
        phase,
        {},
        options,
      ),
    finalizeJournal: async (handle, outcome, options) =>
      finalizeS2FleetNudgeJournal(
        handle.opaque as S2FleetNudgeJournalHandle,
        outcome,
        options,
      ),
    pruneClaims: async ({ schedulerGeneration, tickSequence, deadlineMs }) => {
      pruneS2OneShotWorkerNudgeClaims({
        namespace: input.namespace,
        schedulerGeneration,
        tickSequence,
        deadlineMs,
      });
    },
  };
  return { effects: { ...base, ...input.mutate }, sends, journalPath };
}

function authorityEnv(directory: string): NodeJS.ProcessEnv {
  const authorityPath = path.join(directory, 'epoch.json');
  const epochId = 'epoch-1259';
  const nonce = 'nonce-1259';
  writeFileSync(authorityPath, JSON.stringify({
    schemaVersion: 1,
    currentEpochId: epochId,
    records: [{
      epochId,
      nonce,
      hostId: 'host-1259',
      repoRoot: process.cwd(),
      installedCommitSha: 'a'.repeat(40),
      snapshotDigests: { reconcile: 'a', reevaluation: 'b', reportStateSeed: 'c' },
      importDigests: { reconcile: 'd', reevaluation: 'e', reportStateSeed: 'f' },
      registryHash: 'g',
      preCommitLogDigest: 'h',
      commitAt: '2026-08-06T00:00:00.000Z',
    }],
  }));
  return {
    ORCHESTRATOR_CUTOVER_EPOCH_AUTHORITY: authorityPath,
    ORCHESTRATOR_CUTOVER_EPOCH_ID: epochId,
    ORCHESTRATOR_CUTOVER_NONCE: nonce,
  };
}

function resultFor(outcome: FleetNudgeUnitOutcome): FleetNudgeResult {
  const attempted = ['dispatched', 'send_failed', 'dispatch_unknown'].includes(outcome);
  return {
    result: 'one-budgeted-gated-nudge-per-new-eligible-episode',
    status: 'complete',
    schedulerGeneration: 'sg-scheduler',
    tickSequence: 1,
    effectiveS2BudgetMs: 125,
    settlementReserveMs: 25,
    candidateOrder: ['episode'],
    outcomes: [{ unitRef: 'u-000001', class: 'idle', outcome }],
    claimStarts: outcome === 'target_unresolved' ? 0 : 1,
    sendAttempts: attempted ? 1 : 0,
    dispatched: 0,
    returnedWithinBudget: true,
    targetBindingAvailable: outcome !== 'target_unresolved',
  };
}

function terminalTemplate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    key: 'key',
    tupleKey: 'tuple',
    prNumber: 0,
    issueNumber: 1259,
    projectId: 'orchestrator-pack',
    cycleKey: 'class-changed:200:u-000001:busy:idle:positive-idle',
    intentClass: 'task-continuation',
    workerTarget: 'sg-retain:u-000001',
    sessionId: 'sg-retain:u-000001',
    targetId: 'u-000001',
    targetGeneration: 'sg-retain',
    phase: 'SENT',
    state: 'SENT',
    holder: { processGuid: 'holder', pid: 1, surface: 's2', host: 'host' },
    acquiredAtUtc: '2026-08-06T00:00:00.000Z',
    claimLeaseExpiresAtMs: 1,
    tokenNonce: 'nonce',
    policyTag: S2_ONE_SHOT_POLICY,
    schedulerGeneration: 'sg-retain',
    tickSequence: 200,
    transitionIdentity: 'class-changed:200:u-000001:busy:idle:positive-idle',
    unitRef: 'u-000001',
    eligibleClass: 'idle',
    ...overrides,
  };
}

describe('S2 fleet nudge actuator', () => {
  it('uses the exact budget formula and bounded messages', () => {
    expect(calculateFleetNudgeBudget(16_000)).toEqual({
      effectiveS2BudgetMs: 2_000,
      settlementReserveMs: 200,
    });
    expect(calculateFleetNudgeBudget(800)).toEqual({
      effectiveS2BudgetMs: 100,
      settlementReserveMs: 20,
    });
    expect(IDLE_NUDGE_MESSAGE).toBe(
      'Continue the current task. If you are blocked or finished, publish the required worker report.',
    );
    expect(LIVELOCK_NUDGE_MESSAGE).toBe(
      'No progress was observed for the configured livelock window. Reassess the current task; continue, or publish a blocker/ready report.',
    );
  });

  it('honors an injected actuator while default remains target_unresolved', async () => {
    const injected = { tick: vi.fn(async () => resultFor('dispatched')) };
    const injectedBoundary = productionSchedulerBoundary({
      repoRoot: '/not-used',
      fleetNudgeActuator: injected,
    } as unknown as Parameters<typeof productionSchedulerBoundary>[0]);
    const injectedResult = await injectedBoundary.fleetNudgeActuator!.tick({
      observer: oneIdleObserver(),
      schedulerIntervalMs: 1_000,
      tickSequence: 2,
    });
    expect(injected.tick).toHaveBeenCalledTimes(1);
    expect(injectedResult).toEqual(resultFor('dispatched'));

    const defaultBoundary = productionSchedulerBoundary({ repoRoot: '/not-used' });
    const result = await defaultBoundary.fleetNudgeActuator!.tick({
      observer: oneIdleObserver(),
      schedulerIntervalMs: 1_000,
      tickSequence: 2,
    });
    expect(result).toMatchObject({
      result: 'target-binding-unresolved-fail-closed',
      claimStarts: 0,
      sendAttempts: 0,
      dispatched: 0,
      targetBindingAvailable: false,
    });
    expect(result.outcomes[0]?.outcome).toBe('target_unresolved');
  });

  it('admits exactly current-generation internal idle/livelock class changes', async () => {
    const namespace = root('opk-s2-matrix-');
    const { effects, sends } = realEffects({ namespace });
    const result = await runFleetNudgeActuator({
      observer: observerResult({
        rows: [
          row('u-000001', 'idle'),
          row('u-000002', 'livelock'),
          row('u-000003', 'busy'),
          row('u-000004', 'exempt'),
          row('u-000005', 'unknown'),
          row('u-000006', 'idle', 'external'),
          row('u-000007', 'idle'),
          row('u-000008', 'livelock'),
        ],
        transitions: [
          changed('u-000001', 'idle'),
          changed('u-000002', 'livelock'),
          changed('u-000003', 'busy', 2, 'idle'),
          appeared('u-000007'),
        ],
      }),
      schedulerIntervalMs: 16_000,
      tickSequence: 2,
    }, effects);

    expect(sends.map((entry) => entry.message)).toEqual([
      IDLE_NUDGE_MESSAGE,
      LIVELOCK_NUDGE_MESSAGE,
    ]);
    expect(Object.fromEntries(result.outcomes.map((entry) => [entry.unitRef, entry.outcome]))).toEqual({
      'u-000001': 'dispatched',
      'u-000002': 'dispatched',
      'u-000003': 'class_ineligible',
      'u-000004': 'class_ineligible',
      'u-000005': 'class_ineligible',
      'u-000006': 'external_provenance',
      'u-000007': 'fresh_baseline_ineligible',
      'u-000008': 'not_new_episode',
    });
    expect(result.dispatched).toBe(0);
  });

  it('persists canonical claim and journal bytes without laundering submit into delivery evidence', async () => {
    const namespace = root('opk-s2-persistence-');
    const { effects, journalPath } = realEffects({ namespace });
    const result = await runFleetNudgeActuator({
      observer: oneIdleObserver(),
      schedulerIntervalMs: 16_000,
      tickSequence: 2,
    }, effects);
    expect(result).toMatchObject({ status: 'complete', dispatched: 0 });
    expect(result.outcomes[0]?.outcome).toBe('dispatched');
    expect(existsSync(journalPath)).toBe(true);

    const persisted = [
      ...filesUnder(namespace).map((name) => readFileSync(path.join(namespace, name), 'utf8')),
      readFileSync(journalPath, 'utf8'),
    ].join('\n');
    for (const forbidden of [
      OPAQUE_ID,
      OPAQUE_GENERATION,
      OPAQUE_TOKEN,
      '/secret/worktree',
      'private terminal output',
    ]) expect(persisted).not.toContain(forbidden);
    expect(persisted).toContain(S2_ONE_SHOT_POLICY);
    expect(persisted).toContain('sg-s2-test');
    expect(persisted).toContain('u-000001');

    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Record<string, Record<string, unknown>>;
    const record = Object.values(journal).find((entry) => entry?.policyTag === S2_ONE_SHOT_POLICY);
    expect(record).toMatchObject({
      source: 's2-fleet-nudge',
      dispatchOutcome: 'dispatched',
      fenceLifecycle: 'completed',
    });
  });

  it.each([
    ['dispatched', 'SENT'],
    ['send_failed', 'FAILED_DEFINITIVE'],
    ['dispatch_unknown', 'UNCERTAIN'],
  ] as const)('maps %s to terminal %s and refuses reacquisition', async (dispatchStatus, phase) => {
    const namespace = root(`opk-s2-${dispatchStatus}-`);
    const dispatch: RuntimeDispatchResult = dispatchStatus === 'dispatched'
      ? { status: 'dispatched' }
      : { status: dispatchStatus, reason: 'injected' };
    const { effects } = realEffects({ namespace, dispatch });
    const first = await runFleetNudgeActuator({
      observer: oneIdleObserver(),
      schedulerIntervalMs: 16_000,
      tickSequence: 2,
    }, effects);
    expect(first.outcomes[0]?.outcome).toBe(dispatchStatus);
    expect(first.status).toBe('complete');
    const second = await runFleetNudgeActuator({
      observer: oneIdleObserver(),
      schedulerIntervalMs: 16_000,
      tickSequence: 2,
    }, effects);
    expect(second.outcomes[0]?.outcome).toBe('claim_terminal');
    const terminalBytes = filesUnder(namespace)
      .map((name) => readFileSync(path.join(namespace, name), 'utf8'))
      .join('\n');
    expect(terminalBytes).toContain(`\"phase\":\"${phase}\"`);
  });

  it('safely releases a pre-send claim and permits exact-episode reacquisition', async () => {
    const namespace = root('opk-s2-release-');
    let admissions = 0;
    const real = realEffects({ namespace });
    const originalAdmit = real.effects.admitJournal;
    const effects: FleetNudgeEffects = {
      ...real.effects,
      admitJournal: async (...args) => {
        admissions += 1;
        return admissions === 1
          ? { status: 'claim_untrusted' }
          : originalAdmit(...args);
      },
    };
    const first = await runFleetNudgeActuator({
      observer: oneIdleObserver(),
      schedulerIntervalMs: 16_000,
      tickSequence: 2,
    }, effects);
    expect(first.outcomes[0]?.outcome).toBe('claim_untrusted');
    const second = await runFleetNudgeActuator({
      observer: oneIdleObserver(),
      schedulerIntervalMs: 16_000,
      tickSequence: 2,
    }, effects);
    expect(second.outcomes[0]?.outcome).toBe('dispatched');
  });

  it('classifies a proved absent SEND_ATTEMPTED as budget_exhausted and releases', async () => {
    const namespace = root('opk-s2-no-attempt-');
    const real = realEffects({ namespace });
    let attempts = 0;
    const effects: FleetNudgeEffects = {
      ...real.effects,
      markSendAttempted: async (...args) => {
        attempts += 1;
        return attempts === 1
          ? { status: 'definitely_not_recorded' }
          : real.effects.markSendAttempted(...args);
      },
    };
    const first = await runFleetNudgeActuator({
      observer: oneIdleObserver(),
      schedulerIntervalMs: 16_000,
      tickSequence: 2,
    }, effects);
    expect(first).toMatchObject({ status: 'complete', sendAttempts: 0 });
    expect(first.outcomes[0]?.outcome).toBe('budget_exhausted');
    const second = await runFleetNudgeActuator({
      observer: oneIdleObserver(),
      schedulerIntervalMs: 16_000,
      tickSequence: 2,
    }, effects);
    expect(second.outcomes[0]?.outcome).toBe('dispatched');
  });

  it('settles post-SEND_ATTEMPTED deadline expiry as UNCERTAIN without dispatch', async () => {
    const namespace = root('opk-s2-post-attempt-expiry-');
    const startedAt = Date.now();
    let observedNow = startedAt;
    const real = realEffects({ namespace });
    const originalMark = real.effects.markSendAttempted;
    const effects: FleetNudgeEffects = {
      ...real.effects,
      now: () => observedNow,
      markSendAttempted: async (...args) => {
        const recorded = await originalMark(...args);
        observedNow = startedAt + 1_900;
        return recorded;
      },
    };
    const result = await runFleetNudgeActuator({
      observer: oneIdleObserver(),
      schedulerIntervalMs: 16_000,
      tickSequence: 2,
      phaseStartMs: startedAt,
    }, effects);
    expect(result).toMatchObject({
      status: 'complete',
      sendAttempts: 1,
      dispatched: 0,
    });
    expect(result.outcomes[0]?.outcome).toBe('dispatch_unknown');
    const terminalBytes = filesUnder(namespace)
      .map((name) => readFileSync(path.join(namespace, name), 'utf8'))
      .join('\n');
    expect(terminalBytes).toContain('"phase":"UNCERTAIN"');
  });

  it('does not report complete when authoritative terminal settlement fails', async () => {
    const namespace = root('opk-s2-settlement-failure-');
    const real = realEffects({ namespace });
    const result = await runFleetNudgeActuator({
      observer: oneIdleObserver(),
      schedulerIntervalMs: 16_000,
      tickSequence: 2,
    }, {
      ...real.effects,
      finalizeJournal: async () => ({ ok: false }),
    });
    expect(result.status).toBe('failed');
    expect(result.outcomes[0]?.outcome).toBe('dispatched');
  });

  it('has one claim winner and terminalizes stale SEND_ATTEMPTED as UNCERTAIN', async () => {
    const namespace = root('opk-s2-concurrent-');
    const base = {
      projectId: 'orchestrator-pack',
      issueNumber: 1259,
      schedulerGeneration: 'sg-concurrent',
      tickSequence: 10,
      transitionIdentity: 'class-changed:10:u-000001:busy:idle:positive-idle',
      unitRef: 'u-000001',
      eligibleClass: 'idle' as const,
      namespace,
      deadlineMs: Date.now() + 2_000,
    };
    const results = await Promise.all([
      acquireS2OneShotWorkerNudgeClaim(base),
      acquireS2OneShotWorkerNudgeClaim(base),
    ]);
    expect(results.filter((entry) => entry.acquired)).toHaveLength(1);
    expect(results.filter((entry) => !entry.acquired)).toEqual([
      expect.objectContaining({ reason: 'claim_terminal' }),
    ]);
    const winner = results.find((entry): entry is S2OneShotWorkerNudgeClaimHandle => entry.acquired)!;
    const deadlineMs = Date.now() + 2_000;
    expect(await persistWorkerNudgeMessageHash(winner, IDLE_NUDGE_MESSAGE, { deadlineMs })).toMatchObject({ ok: true });
    expect(await markWorkerNudgeSendAttempted(winner, { deadlineMs })).toEqual({ ok: true });

    const active = JSON.parse(readFileSync(winner.path, 'utf8')) as Record<string, unknown>;
    active.claimLeaseExpiresAtMs = 0;
    active.holder = { ...(active.holder as Record<string, unknown>), pid: 2_147_483_647 };
    writeFileSync(winner.path, `${JSON.stringify(active)}\n`, 'utf8');
    expect(await acquireS2OneShotWorkerNudgeClaim({
      ...base,
      deadlineMs: Date.now() + 2_000,
    })).toMatchObject({
      acquired: false,
      reason: 'claim_terminal',
      phase: 'UNCERTAIN',
    });
  });

  it('binds deterministic tombstones and fails closed on malformed or ambiguous matches', async () => {
    const namespace = root('opk-s2-corrupt-');
    const base = {
      projectId: 'orchestrator-pack',
      issueNumber: 1259,
      schedulerGeneration: 'sg-corrupt',
      tickSequence: 11,
      transitionIdentity: 'class-changed:11:u-000001:busy:idle:positive-idle',
      unitRef: 'u-000001',
      eligibleClass: 'idle' as const,
      namespace,
      deadlineMs: Date.now() + 2_000,
    };
    const acquired = await acquireS2OneShotWorkerNudgeClaim(base);
    if (!acquired.acquired) throw new Error(acquired.reason);
    const deadlineMs = Date.now() + 2_000;
    await persistWorkerNudgeMessageHash(acquired, IDLE_NUDGE_MESSAGE, { deadlineMs });
    await markWorkerNudgeSendAttempted(acquired, { deadlineMs });
    const finalized = await finalizeS2OneShotWorkerNudgeClaim(
      acquired,
      'SENT',
      {},
      { deadlineMs },
    );
    expect(finalized.ok).toBe(true);
    const terminalPath = finalized.terminalPath!;
    expect(path.basename(terminalPath)).toBe(`${buildS2EpisodeKey(base)}.json`);
    const validBytes = readFileSync(terminalPath, 'utf8');

    writeFileSync(terminalPath, '{not-json', 'utf8');
    expect(await acquireS2OneShotWorkerNudgeClaim({
      ...base,
      deadlineMs: Date.now() + 2_000,
    })).toMatchObject({ acquired: false, reason: 'claim_untrusted' });

    writeFileSync(terminalPath, validBytes, 'utf8');
    copyFileSync(terminalPath, path.join(path.dirname(terminalPath), `${acquired.key}-duplicate.json`));
    expect(await acquireS2OneShotWorkerNudgeClaim({
      ...base,
      deadlineMs: Date.now() + 2_000,
    })).toMatchObject({ acquired: false, reason: 'claim_untrusted' });
  });

  it('bounds a contended release by its absolute deadline without a late unlink', async () => {
    const namespace = root('opk-s2-release-contention-');
    const acquired = await acquireS2OneShotWorkerNudgeClaim({
      projectId: 'orchestrator-pack',
      issueNumber: 1259,
      schedulerGeneration: 'sg-release',
      tickSequence: 12,
      transitionIdentity: 'class-changed:12:u-000001:busy:idle:positive-idle',
      unitRef: 'u-000001',
      eligibleClass: 'idle',
      namespace,
      deadlineMs: Date.now() + 2_000,
    });
    if (!acquired.acquired) throw new Error(acquired.reason);
    const lock = path.join(namespace, `.lock-${acquired.key}`);
    mkdirSync(lock);
    writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
    const startedAt = Date.now();
    const released = await releaseS2OneShotWorkerNudgeClaim(acquired, {
      deadlineMs: startedAt + 120,
    });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(released).toMatchObject({ ok: false, reason: 'claim_deadline_expired' });
    expect(existsSync(acquired.path)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(existsSync(acquired.path)).toBe(true);
  });

  it('returns within the full 2s phase budget when a mutation never resolves', async () => {
    const namespace = root('opk-s2-never-resolve-');
    const { effects } = realEffects({ namespace, mutate: {
      persistMessageHash: async () => new Promise<{ ok: boolean }>(() => {}),
    } });
    const startedAt = Date.now();
    const result = await runFleetNudgeActuator({
      observer: oneIdleObserver(),
      schedulerIntervalMs: 16_000,
      tickSequence: 2,
      phaseStartMs: startedAt,
    }, effects);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(1_700);
    expect(elapsed).toBeLessThan(2_250);
    expect(result.outcomes[0]?.outcome).toBe('budget_exhausted');
    expect(result.returnedWithinBudget).toBe(true);
  }, 5_000);

  it('requires exact binding, revalidation, and both epoch assertions before claim', async () => {
    const scenarios: Array<{
      name: string;
      mutate: (effects: FleetNudgeEffects) => FleetNudgeEffects;
      outcome: FleetNudgeUnitOutcome;
    }> = [
      {
        name: 'target unresolved',
        mutate: (effects) => ({ ...effects, resolveTarget: async () => ({ status: 'target_unresolved' }) }),
        outcome: 'target_unresolved',
      },
      {
        name: 'stale binding',
        mutate: (effects) => ({
          ...effects,
          resolveTarget: async (episode) => ({
            status: 'resolved',
            binding: { ...bindingFor(episode), unitRef: 'u-999999' },
          }),
        }),
        outcome: 'target_stale',
      },
      {
        name: 'first epoch lost',
        mutate: (effects) => ({ ...effects, assertEpoch: () => { throw new Error('lost'); } }),
        outcome: 'epoch_lost',
      },
      {
        name: 'revalidation failed',
        mutate: (effects) => ({ ...effects, revalidate: async () => ({ status: 'revalidation_failed' }) }),
        outcome: 'revalidation_failed',
      },
      {
        name: 'revalidation epoch lost',
        mutate: (effects) => ({ ...effects, revalidate: async () => ({ status: 'epoch_lost' }) }),
        outcome: 'epoch_lost',
      },
      {
        name: 'second epoch lost',
        mutate: (effects) => {
          let assertions = 0;
          return {
            ...effects,
            assertEpoch: () => {
              assertions += 1;
              if (assertions === 2) throw new Error('lost');
            },
          };
        },
        outcome: 'epoch_lost',
      },
    ];

    for (const scenario of scenarios) {
      const namespace = root(`opk-s2-revalidate-${scenario.name.replaceAll(' ', '-')}-`);
      const real = realEffects({ namespace });
      let claims = 0;
      const effects = scenario.mutate({
        ...real.effects,
        acquireClaim: async (...args) => {
          claims += 1;
          return real.effects.acquireClaim(...args);
        },
      });
      const result = await runFleetNudgeActuator({
        observer: oneIdleObserver(),
        schedulerIntervalMs: 16_000,
        tickSequence: 2,
      }, effects);
      expect(result.outcomes[0]?.outcome, scenario.name).toBe(scenario.outcome);
      expect(claims, scenario.name).toBe(0);
    }

    const namespace = root('opk-s2-missing-epoch-');
    const missing = realEffects({ namespace }).effects as FleetNudgeEffects & { assertEpoch?: () => void };
    delete missing.assertEpoch;
    const result = await runFleetNudgeActuator({
      observer: oneIdleObserver(),
      schedulerIntervalMs: 16_000,
      tickSequence: 2,
    }, missing as FleetNudgeEffects);
    expect(result.outcomes[0]?.outcome).toBe('epoch_lost');
  });

  it('prunes after 128 ticks or restart and rejects malformed retained state', () => {
    const namespace = root('opk-s2-retention-');
    const terminalDirectory = path.join(namespace, 'terminal', S2_ONE_SHOT_POLICY);
    mkdirSync(terminalDirectory, { recursive: true });
    for (let index = 0; index < 32; index += 1) {
      writeFileSync(path.join(terminalDirectory, `${index}.json`), `${JSON.stringify(terminalTemplate({
        key: `key-${index}`,
        tupleKey: `tuple-${index}`,
        tickSequence: 200 + (index % 10),
      }))}\n`, 'utf8');
    }
    writeFileSync(path.join(terminalDirectory, 'expired.json'), `${JSON.stringify(terminalTemplate({
      key: 'expired',
      tupleKey: 'expired',
      tickSequence: 72,
    }))}\n`, 'utf8');
    writeFileSync(path.join(terminalDirectory, 'old-generation.json'), `${JSON.stringify(terminalTemplate({
      key: 'old-generation',
      tupleKey: 'old-generation',
      schedulerGeneration: 'sg-old',
    }))}\n`, 'utf8');

    const pruned = pruneS2OneShotWorkerNudgeClaims({
      namespace,
      schedulerGeneration: 'sg-retain',
      tickSequence: 200,
      deadlineMs: Date.now() + 2_000,
    });
    expect(pruned).toEqual({ removed: 2, retained: 32, untrusted: 0 });
    expect(readdirSync(terminalDirectory)).toHaveLength(32);
    expect(S2_RETENTION_TICKS).toBe(128);

    writeFileSync(path.join(terminalDirectory, 'malformed.json'), '{not-json', 'utf8');
    expect(() => pruneS2OneShotWorkerNudgeClaims({
      namespace,
      schedulerGeneration: 'sg-retain',
      tickSequence: 200,
      deadlineMs: Date.now() + 2_000,
    })).toThrow('claim_untrusted');
  });

  it('fails closed within budget for an oversized real store and a 256-unit fleet', async () => {
    const namespace = root('opk-s2-large-store-');
    const terminalDirectory = path.join(namespace, 'terminal', S2_ONE_SHOT_POLICY);
    mkdirSync(terminalDirectory, { recursive: true });
    for (let index = 0; index < S2_MAX_TERMINALS_PER_GENERATION + 1; index += 1) {
      writeFileSync(path.join(terminalDirectory, `${index}.json`), '{}\n', 'utf8');
    }
    const rows = Array.from({ length: 256 }, (_, index) =>
      row(`u-${String(index + 1).padStart(6, '0')}`, 'idle'));
    const transitions = rows.map((entry) => changed(entry.unitRef, 'idle'));
    const { effects, sends } = realEffects({ namespace });
    const startedAt = Date.now();
    const result = await runFleetNudgeActuator({
      observer: observerResult({ rows, transitions }),
      schedulerIntervalMs: 16_000,
      tickSequence: 2,
      phaseStartMs: startedAt,
    }, effects);
    expect(Date.now() - startedAt).toBeLessThan(2_250);
    expect(sends).toHaveLength(0);
    expect(result.status).toBe('failed');
    expect(result.outcomes).toHaveLength(256);
    expect(result.outcomes.every((entry) => entry.outcome === 'claim_untrusted')).toBe(true);
    expect(result.returnedWithinBudget).toBe(true);
  }, 5_000);

  it('orders serially and starts no more than eight candidates', async () => {
    const rows = Array.from({ length: 12 }, (_, index) => row(`u-${String(index + 1).padStart(6, '0')}`, 'idle'));
    const transitions = [...rows].reverse().map((entry) => changed(entry.unitRef, 'idle'));
    const started: string[] = [];
    let active = 0;
    let peak = 0;
    const effects: FleetNudgeEffects = {
      assertEpoch: () => {},
      resolveTarget: async (episode) => {
        active += 1;
        peak = Math.max(peak, active);
        started.push(episode.transitionIdentity);
        await Promise.resolve();
        active -= 1;
        return { status: 'resolved', binding: bindingFor(episode) };
      },
      revalidate: async () => ({ status: 'valid' }),
      acquireClaim: async () => ({ status: 'acquired', handle: { opaque: {} } }),
      persistMessageHash: async () => ({ ok: true }),
      admitJournal: async () => ({ status: 'admitted', handle: { opaque: {} } }),
      markSendAttempted: async () => ({ status: 'recorded' }),
      releaseClaim: async () => ({ ok: true }),
      dispatch: async () => ({ status: 'dispatched' }),
      finalizeClaim: async () => ({ ok: true }),
      finalizeJournal: async () => ({ ok: true }),
    };
    const result = await runFleetNudgeActuator({
      observer: observerResult({ rows, transitions }),
      schedulerIntervalMs: 16_000,
      tickSequence: 2,
    }, effects);
    expect(peak).toBe(1);
    expect(started).toHaveLength(S2_MAX_STARTS_PER_TICK);
    expect(started).toEqual([...result.candidateOrder].slice(0, S2_MAX_STARTS_PER_TICK));
    expect(result.outcomes.filter((entry) => entry.outcome === 'budget_exhausted')).toHaveLength(4);
  });

  it('does not carry a fresh-baseline episode into later ticks', async () => {
    const namespace = root('opk-s2-no-carryover-');
    const { effects, sends } = realEffects({ namespace });
    const first = await runFleetNudgeActuator({
      observer: observerResult({
        rows: [row('u-000001', 'idle')],
        transitions: [appeared('u-000001', 2)],
        tickSequence: 2,
        schedulerGeneration: 'sg-no-carryover',
      }),
      schedulerIntervalMs: 16_000,
      tickSequence: 2,
    }, effects);
    const second = await runFleetNudgeActuator({
      observer: observerResult({
        rows: [row('u-000001', 'idle')],
        transitions: [],
        tickSequence: 3,
        schedulerGeneration: 'sg-no-carryover',
      }),
      schedulerIntervalMs: 16_000,
      tickSequence: 3,
    }, effects);
    const third = await runFleetNudgeActuator({
      observer: oneIdleObserver('u-000001', 4, 'sg-no-carryover'),
      schedulerIntervalMs: 16_000,
      tickSequence: 4,
    }, effects);
    expect(first.outcomes[0]?.outcome).toBe('fresh_baseline_ineligible');
    expect(second.outcomes[0]?.outcome).toBe('not_new_episode');
    expect(third.outcomes[0]?.outcome).toBe('dispatched');
    expect(sends).toHaveLength(1);
  });

  it('uses restored observer tickSequence after scheduler restart and on the next tick', async () => {
    const directory = root('opk-s2-restart-');
    const env = authorityEnv(directory);
    const requested: number[] = [];
    const actuated: number[] = [];
    const handoffs: string[] = [];
    let invocation = 0;
    const boundary: SchedulerBoundary = {
      listCandidates: () => [],
      readCurrentPr: async () => { throw new Error('not called'); },
      readChecks: async () => [],
      listReviewRuns: () => [],
      start: async () => ({ ok: true }),
      schedulerIntervalMs: 1_000,
      fleetObserver: {
        tick: async (input) => {
          requested.push(input.tickSequence ?? 0);
          invocation += 1;
          return invocation === 1
            ? observerResult({
              rows: [row('u-000001', 'idle')],
              transitions: [appeared('u-000001', 41)],
              tickSequence: 41,
              schedulerGeneration: 'sg-restored',
            })
            : oneIdleObserver('u-000001', 42, 'sg-restored');
        },
      },
      fleetNudgeActuator: {
        tick: async (input) => {
          actuated.push(input.tickSequence);
          return runFleetNudgeActuator(input);
        },
      },
      publishHandoff: ({ reason }) => {
        handoffs.push(reason);
        return { ok: true };
      },
    };

    const first = await runSchedulerTick(boundary, env);
    const second = await runSchedulerTick(boundary, env);
    expect(requested).toEqual([1, 42]);
    expect(actuated).toEqual([41, 42]);
    expect(first.fleetNudge?.outcomes[0]?.outcome).toBe('fresh_baseline_ineligible');
    expect(second.fleetNudge).toMatchObject({
      result: 'target-binding-unresolved-fail-closed',
      status: 'complete',
    });
    expect(second.fleetNudge?.outcomes[0]?.outcome).toBe('target_unresolved');
    expect(handoffs).toEqual(['target_unresolved']);
  });

  it.each([
    'target_unresolved',
    'claim_terminal',
    'budget_exhausted',
    'dispatch_unknown',
    'send_failed',
    'dispatched',
  ] as const)('keeps review-start accounting identical for S2 outcome %s', async (outcome) => {
    const directory = root(`opk-s2-differential-${outcome}-`);
    const env = authorityEnv(directory);
    const head = 'b'.repeat(40);
    let starts = 0;
    let prReads = 0;
    let checkReads = 0;
    const handoffs: string[] = [];
    const boundary: SchedulerBoundary = {
      listCandidates: () => [{
        sessionId: 'worker-1259',
        repoSlug: 'chetwerikoff/orchestrator-pack',
        prNumber: 1259,
        boundHeadSha: head,
      }],
      readCurrentPr: async () => {
        prReads += 1;
        return { number: 1259, headRefOid: head, state: 'OPEN', isDraft: false };
      },
      readChecks: async () => {
        checkReads += 1;
        return [
          'verify orchestrator-pack structure',
          'pr scope guard',
          'run pack contract tests',
          'self-architect lint',
        ].map((name) => ({ name, state: 'SUCCESS' }));
      },
      listReviewRuns: () => [],
      start: async () => {
        starts += 1;
        return { ok: true };
      },
      schedulerIntervalMs: 1_000,
      fleetObserver: { tick: async () => oneIdleObserver('u-000001', 1, 'sg-scheduler') },
      fleetNudgeActuator: {
        tick: async () => resultFor(outcome),
      },
      publishHandoff: ({ reason }) => {
        handoffs.push(reason);
        return { ok: true };
      },
    };
    const result = await runSchedulerTick(boundary, env);
    expect(result).toMatchObject({ attempted: 1, started: 1, skipped: 0 });
    expect({ starts, prReads, checkReads }).toEqual({ starts: 1, prReads: 1, checkReads: 1 });
  });

  it('fails the fleet phase on an actuator throw without starting review', async () => {
    const directory = root('opk-s2-actuator-throw-');
    const env = authorityEnv(directory);
    const head = 'b'.repeat(40);
    let starts = 0;
    let prReads = 0;
    let checkReads = 0;
    const handoffs: string[] = [];
    const boundary: SchedulerBoundary = {
      listCandidates: () => [{
        sessionId: 'worker-1259',
        repoSlug: 'chetwerikoff/orchestrator-pack',
        prNumber: 1259,
        boundHeadSha: head,
      }],
      readCurrentPr: async () => {
        prReads += 1;
        return { number: 1259, headRefOid: head, state: 'OPEN', isDraft: false };
      },
      readChecks: async () => {
        checkReads += 1;
        return [
          'verify orchestrator-pack structure',
          'pr scope guard',
          'run pack contract tests',
          'self-architect lint',
        ].map((name) => ({ name, state: 'SUCCESS' }));
      },
      listReviewRuns: () => [],
      start: async () => {
        starts += 1;
        return { ok: true };
      },
      schedulerIntervalMs: 1_000,
      fleetObserver: { tick: async () => oneIdleObserver('u-000001', 1, 'sg-scheduler') },
      fleetNudgeActuator: {
        tick: async () => { throw new Error('injected'); },
      },
      publishHandoff: ({ reason }) => {
        handoffs.push(reason);
        return { ok: true };
      },
    };

    await expect(runSchedulerTick(boundary, env))
      .rejects.toThrow('scheduler_fleet_phase_failed:observer-untrusted');
    expect(handoffs).toEqual(['observer_untrusted']);
    expect({ starts, prReads, checkReads }).toEqual({ starts: 0, prReads: 0, checkReads: 0 });
  });
});
