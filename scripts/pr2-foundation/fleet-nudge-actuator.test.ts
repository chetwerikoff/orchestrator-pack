import {
  existsSync,
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
  dispatchRuntimeFleetNudge,
  revalidateRuntimeFleetNudgeTarget,
  runFleetNudgeActuator,
  type FleetNudgeEffects,
  type FleetNudgeEpisode,
  type FleetNudgeResult,
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
  markWorkerNudgeSendAttempted,
  persistWorkerNudgeMessageHash,
  pruneS2OneShotWorkerNudgeClaims,
  releaseS2OneShotWorkerNudgeClaim,
  type S2OneShotWorkerNudgeClaimHandle,
} from './worker-nudge-claim-store.ts';
import type {
  RuntimeAdapter,
  RuntimeDispatchResult,
  RuntimeWorkerIdentity,
} from '../runtime/contracts.ts';
import { runSchedulerTick } from './scheduler.ts';

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

function claimBackedEffects(input: {
  namespace: string;
  dispatch?: RuntimeDispatchResult;
  now?: () => number;
  mutate?: Partial<FleetNudgeEffects>;
}): {
  effects: FleetNudgeEffects;
  sends: Array<{ binding: RuntimeFleetNudgeBinding; message: string }>;
  journals: Array<Record<string, unknown>>;
} {
  const sends: Array<{ binding: RuntimeFleetNudgeBinding; message: string }> = [];
  const journals: Array<Record<string, unknown>> = [];
  const base: FleetNudgeEffects = {
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
    persistMessageHash: async (handle, message) =>
      persistWorkerNudgeMessageHash(handle.opaque as S2OneShotWorkerNudgeClaimHandle, message),
    admitJournal: async (episode, message) => {
      const record = {
        policyTag: episode.policyTag,
        projectId: episode.projectId,
        issueNumber: episode.issueNumber,
        schedulerGeneration: episode.schedulerGeneration,
        tickSequence: episode.tickSequence,
        transitionIdentity: episode.transitionIdentity,
        unitRef: episode.unitRef,
        eligibleClass: episode.eligibleClass,
        intentClass: episode.intentClass,
        message,
      };
      journals.push(record);
      return { status: 'admitted', handle: { opaque: record } };
    },
    markSendAttempted: async (handle) =>
      markWorkerNudgeSendAttempted(handle.opaque as S2OneShotWorkerNudgeClaimHandle),
    releaseClaim: async (handle) =>
      releaseS2OneShotWorkerNudgeClaim(handle.opaque as S2OneShotWorkerNudgeClaimHandle),
    dispatch: async (binding, message) => {
      sends.push({ binding, message });
      return input.dispatch ?? { status: 'dispatched' };
    },
    finalizeClaim: async (handle, phase) =>
      finalizeS2OneShotWorkerNudgeClaim(
        handle.opaque as S2OneShotWorkerNudgeClaimHandle,
        phase,
      ),
    finalizeJournal: async () => ({ ok: true }),
    pruneClaims: async ({ schedulerGeneration, tickSequence }) => {
      pruneS2OneShotWorkerNudgeClaims({
        namespace: input.namespace,
        schedulerGeneration,
        tickSequence,
      });
    },
    ...(input.now ? { now: input.now } : {}),
  };
  return { effects: { ...base, ...input.mutate }, sends, journals };
}

function oneIdleObserver(unitRef = 'u-000001'): FleetObserverResult {
  return observerResult({ rows: [row(unitRef, 'idle')], transitions: [changed(unitRef, 'idle')] });
}

describe('S2 fleet nudge actuator', () => {
  it('uses the exact total-budget formula and exact bounded messages', () => {
    expect(calculateFleetNudgeBudget(16_000)).toEqual({
      effectiveS2BudgetMs: 2_000,
      settlementReserveMs: 200,
    });
    expect(calculateFleetNudgeBudget(800)).toEqual({
      effectiveS2BudgetMs: 100,
      settlementReserveMs: 20,
    });
    expect(Buffer.from(IDLE_NUDGE_MESSAGE, 'utf8').toString('utf8')).toBe(
      'Continue the current task. If you are blocked or finished, publish the required worker report.',
    );
    expect(Buffer.from(LIVELOCK_NUDGE_MESSAGE, 'utf8').toString('utf8')).toBe(
      'No progress was observed for the configured livelock window. Reassess the current task; continue, or publish a blocker/ready report.',
    );
  });

  it('fails production closed at target_unresolved before claim, journal, hash, or send', async () => {
    const result = await runFleetNudgeActuator({
      observer: observerResult({
        rows: [row('u-000001', 'idle'), row('u-000002', 'livelock')],
        transitions: [changed('u-000001', 'idle'), changed('u-000002', 'livelock')],
      }),
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
    expect(result.outcomes.map((entry) => entry.outcome)).toEqual([
      'target_unresolved',
      'target_unresolved',
    ]);
  });

  it('admits only current-generation internal idle/livelock class changes', async () => {
    const namespace = root('opk-s2-matrix-');
    const { effects, sends } = claimBackedEffects({ namespace });
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
      schedulerIntervalMs: 2_000,
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
  });

  it('keeps opaque #1245 identity and observation values out of all durable bytes', async () => {
    const namespace = root('opk-s2-persistence-');
    const { effects, journals } = claimBackedEffects({ namespace });
    const result = await runFleetNudgeActuator({
      observer: oneIdleObserver(),
      schedulerIntervalMs: 1_000,
      tickSequence: 2,
    }, effects);
    expect(result.dispatched).toBe(1);

    const persisted = filesUnder(namespace)
      .map((name) => readFileSync(path.join(namespace, name), 'utf8'))
      .join('\n');
    const journalBytes = JSON.stringify(journals);
    for (const forbidden of [
      OPAQUE_ID,
      OPAQUE_GENERATION,
      OPAQUE_TOKEN,
      '/secret/worktree',
      'private terminal output',
    ]) {
      expect(persisted).not.toContain(forbidden);
      expect(journalBytes).not.toContain(forbidden);
    }
    expect(persisted).toContain(S2_ONE_SHOT_POLICY);
    expect(persisted).toContain('sg-s2-test');
    expect(persisted).toContain('u-000001');
  });

  it('revalidates exact runtime-neutral identity, provenance, output, liveness, and epoch', async () => {
    const worker: RuntimeWorkerIdentity = {
      runtime: 'fake-runtime',
      id: OPAQUE_ID,
      generation: OPAQUE_GENERATION,
    };
    const episode = {
      projectId: 'orchestrator-pack',
      issueNumber: 1259,
      schedulerGeneration: 'sg-s2-test',
      tickSequence: 2,
      transitionIdentity: 'class-changed:2:u-000001:busy:idle:positive-idle',
      unitRef: 'u-000001',
      eligibleClass: 'idle' as const,
      intentClass: 'task-continuation' as const,
      policyTag: S2_ONE_SHOT_POLICY,
      worker,
      previousOutputToken: { opaque: OPAQUE_TOKEN },
    };
    const runtime: Pick<RuntimeAdapter, 'findWorker' | 'readBoundedOutput' | 'liveness'> = {
      findWorker: () => ({
        status: 'ok',
        value: { identity: worker, workspacePath: '/secret/worktree', title: null, provenance: 'internal' },
      }),
      readBoundedOutput: () => ({
        status: 'ok',
        value: {
          worker,
          lines: ['private terminal output'],
          observationToken: { opaque: 'next-token' },
          changed: false,
          terminalState: 'running',
        },
      }),
      liveness: () => ({ status: 'idle', worker }),
    };

    expect(await revalidateRuntimeFleetNudgeTarget({
      runtime,
      binding: episode,
      deadlineMs: Date.now() + 1_000,
    })).toEqual({ status: 'valid' });

    runtime.readBoundedOutput = () => ({
      status: 'ok',
      value: {
        worker,
        lines: ['new output'],
        observationToken: { opaque: 'changed-token' },
        changed: true,
        terminalState: 'running',
      },
    });
    expect(await revalidateRuntimeFleetNudgeTarget({
      runtime,
      binding: episode,
      deadlineMs: Date.now() + 1_000,
    })).toEqual({ status: 'revalidation_failed' });

    expect(await revalidateRuntimeFleetNudgeTarget({
      runtime,
      binding: episode,
      deadlineMs: Date.now() + 1_000,
      assertEpoch: () => { throw new Error('lost'); },
    })).toEqual({ status: 'epoch_lost' });
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
    const { effects } = claimBackedEffects({ namespace, dispatch });
    const first = await runFleetNudgeActuator({
      observer: oneIdleObserver(),
      schedulerIntervalMs: 1_000,
      tickSequence: 2,
    }, effects);
    expect(first.outcomes[0]?.outcome).toBe(dispatchStatus);

    const second = await runFleetNudgeActuator({
      observer: oneIdleObserver(),
      schedulerIntervalMs: 1_000,
      tickSequence: 2,
    }, effects);
    expect(second.outcomes[0]?.outcome).toBe('claim_terminal');
    const terminalBytes = filesUnder(namespace)
      .map((name) => readFileSync(path.join(namespace, name), 'utf8'))
      .join('\n');
    expect(terminalBytes).toContain(`\"phase\":\"${phase}\"`);
  });

  it('has one concurrent acquisition winner and terminalizes stale SEND_ATTEMPTED as UNCERTAIN', async () => {
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
    expect(await persistWorkerNudgeMessageHash(winner, IDLE_NUDGE_MESSAGE)).toMatchObject({ ok: true });
    expect(await markWorkerNudgeSendAttempted(winner)).toEqual({ ok: true });

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

  it('prunes at 128 completed ticks, drops old generations, and caps active-generation terminals at 1024', async () => {
    const namespace = root('opk-s2-retention-');
    const terminalDirectory = path.join(namespace, 'terminal', S2_ONE_SHOT_POLICY);
    const template = {
      schemaVersion: 1,
      key: 'key',
      tupleKey: 'tuple',
      prNumber: 0,
      issueNumber: 1259,
      projectId: 'orchestrator-pack',
      cycleKey: 'class-changed:1:u-000001:busy:idle:positive-idle',
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
      tickSequence: 1,
      transitionIdentity: 'class-changed:1:u-000001:busy:idle:positive-idle',
      unitRef: 'u-000001',
      eligibleClass: 'idle',
    };
    await acquireS2OneShotWorkerNudgeClaim({
      projectId: 'orchestrator-pack',
      issueNumber: 1259,
      schedulerGeneration: 'sg-retain',
      tickSequence: 1,
      transitionIdentity: 'class-changed:1:u-000001:busy:idle:positive-idle',
      unitRef: 'u-000001',
      eligibleClass: 'idle',
      namespace,
      deadlineMs: Date.now() + 1_000,
    });
    rmSync(namespace, { recursive: true, force: true });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(terminalDirectory, { recursive: true });
    for (let index = 0; index < S2_MAX_TERMINALS_PER_GENERATION + 2; index += 1) {
      writeFileSync(path.join(terminalDirectory, `${index}.json`), `${JSON.stringify({
        ...template,
        key: `key-${index}`,
        tupleKey: `tuple-${index}`,
        tickSequence: 129 + index,
      })}\n`, 'utf8');
    }
    writeFileSync(path.join(terminalDirectory, 'expired.json'), `${JSON.stringify({
      ...template,
      key: 'expired',
      tupleKey: 'expired',
      tickSequence: 1,
    })}\n`, 'utf8');
    writeFileSync(path.join(terminalDirectory, 'old-generation.json'), `${JSON.stringify({
      ...template,
      key: 'old-generation',
      tupleKey: 'old-generation',
      schedulerGeneration: 'sg-old',
      tickSequence: 1_100,
    })}\n`, 'utf8');

    const pruned = pruneS2OneShotWorkerNudgeClaims({
      namespace,
      schedulerGeneration: 'sg-retain',
      tickSequence: 1_100,
    });
    expect(pruned.retained).toBe(S2_MAX_TERMINALS_PER_GENERATION);
    expect(pruned.removed).toBeGreaterThanOrEqual(4);
    expect(readdirSync(terminalDirectory)).toHaveLength(S2_MAX_TERMINALS_PER_GENERATION);
    expect(S2_RETENTION_TICKS).toBe(128);
  });

  it('orders deterministically, processes serially, and starts no more than eight candidates', async () => {
    const rows = Array.from({ length: 12 }, (_, index) => row(`u-${String(index + 1).padStart(6, '0')}`, 'idle'));
    const transitions = [...rows].reverse().map((entry) => changed(entry.unitRef, 'idle'));
    const started: string[] = [];
    let active = 0;
    let peak = 0;
    const effects: FleetNudgeEffects = {
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
      markSendAttempted: async () => ({ ok: true }),
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
    expect(result.sendAttempts).toBe(S2_MAX_STARTS_PER_TICK);
  });

  it('settles pre-attempt expiry as budget_exhausted and post-attempt expiry as dispatch_unknown', async () => {
    const namespace = root('opk-s2-deadline-');
    let now = 0;
    let releases = 0;
    const pre = claimBackedEffects({
      namespace,
      now: () => now,
      mutate: {
        persistMessageHash: async () => {
          now = 80;
          return { ok: true };
        },
        releaseClaim: async () => {
          releases += 1;
          return { ok: true };
        },
      },
    });
    const beforeAttempt = await runFleetNudgeActuator({
      observer: oneIdleObserver(),
      schedulerIntervalMs: 800,
      tickSequence: 2,
      phaseStartMs: 0,
    }, pre.effects);
    expect(beforeAttempt.outcomes[0]?.outcome).toBe('budget_exhausted');
    expect(beforeAttempt.sendAttempts).toBe(0);
    expect(releases).toBe(1);

    now = 0;
    const post = claimBackedEffects({
      namespace: root('opk-s2-post-attempt-'),
      now: () => now,
      mutate: {
        dispatch: async () => {
          now = 101;
          return { status: 'dispatched' };
        },
      },
    });
    const afterAttempt = await runFleetNudgeActuator({
      observer: oneIdleObserver(),
      schedulerIntervalMs: 800,
      tickSequence: 2,
      phaseStartMs: 0,
    }, post.effects);
    expect(afterAttempt.outcomes[0]?.outcome).toBe('dispatch_unknown');
    expect(afterAttempt.sendAttempts).toBe(1);
  });

  it('uses the runtime-neutral dispatch choke point and side-effect fence', async () => {
    const worker: RuntimeWorkerIdentity = {
      runtime: 'fake-runtime',
      id: OPAQUE_ID,
      generation: OPAQUE_GENERATION,
    };
    const binding = {
      projectId: 'orchestrator-pack',
      issueNumber: 1259,
      schedulerGeneration: 'sg-s2-test',
      tickSequence: 2,
      transitionIdentity: 'class-changed:2:u-000001:busy:idle:positive-idle',
      unitRef: 'u-000001',
      eligibleClass: 'idle' as const,
      intentClass: 'task-continuation' as const,
      policyTag: S2_ONE_SHOT_POLICY,
      worker,
    };
    const dispatchInput = vi.fn(() => ({ status: 'dispatched' as const }));
    const sideEffectFence = vi.fn(async <T>(action: () => T | PromiseLike<T>) => ({
      ok: true as const,
      value: await action(),
    }));
    expect(await dispatchRuntimeFleetNudge({
      runtime: { dispatchInput },
      binding,
      message: IDLE_NUDGE_MESSAGE,
      deadlineMs: Date.now() + 1_000,
      sideEffectFence,
    })).toEqual({ status: 'dispatched' });
    expect(sideEffectFence).toHaveBeenCalledTimes(1);
    expect(dispatchInput).toHaveBeenCalledWith({ worker, text: IDLE_NUDGE_MESSAGE }, expect.any(Object));
  });

  it('keeps scheduler review-start accounting and call sets identical across S2 outcomes and failure', async () => {
    const authorityRoot = root('opk-s2-epoch-');
    const authorityPath = path.join(authorityRoot, 'epoch.json');
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
    const env = {
      ORCHESTRATOR_CUTOVER_EPOCH_AUTHORITY: authorityPath,
      ORCHESTRATOR_CUTOVER_EPOCH_ID: epochId,
      ORCHESTRATOR_CUTOVER_NONCE: nonce,
    };
    const head = 'b'.repeat(40);
    const checks = [
      'verify orchestrator-pack structure',
      'pr scope guard',
      'run pack contract tests',
      'self-architect lint',
    ].map((name) => ({ name, state: 'SUCCESS' }));

    const run = async (actuator: { tick: () => Promise<FleetNudgeResult> }): Promise<{
      result: Awaited<ReturnType<typeof runSchedulerTick>>;
      starts: number;
      reads: number;
    }> => {
      let starts = 0;
      let reads = 0;
      const result = await runSchedulerTick({
        listCandidates: () => [{
          sessionId: 'worker-1259',
          repoSlug: 'chetwerikoff/orchestrator-pack',
          prNumber: 1259,
          boundHeadSha: head,
        }],
        readCurrentPr: async () => {
          reads += 1;
          return { number: 1259, headRefOid: head, state: 'OPEN', isDraft: false };
        },
        readChecks: async () => checks,
        listReviewRuns: () => [],
        start: async () => {
          starts += 1;
          return { ok: true };
        },
        schedulerIntervalMs: 1_000,
        fleetObserver: { tick: async () => oneIdleObserver() },
        fleetNudgeActuator: actuator,
      }, env);
      return { result, starts, reads };
    };

    const baseline = await run({ tick: async () => runFleetNudgeActuator({
      observer: oneIdleObserver(),
      schedulerIntervalMs: 1_000,
      tickSequence: 1,
    }) });
    const failure = await run({ tick: async () => { throw new Error('global S2 failure'); } });
    expect(baseline.result).toMatchObject({ attempted: 1, started: 1, skipped: 0 });
    expect(failure.result).toMatchObject({ attempted: 1, started: 1, skipped: 0 });
    expect({ starts: failure.starts, reads: failure.reads }).toEqual({
      starts: baseline.starts,
      reads: baseline.reads,
    });
  });
});
