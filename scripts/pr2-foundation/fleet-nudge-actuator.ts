import type {
  CensusRow,
  FleetObserverResult,
  FleetTransition,
  ObserverClass,
} from './fleet-observer.ts';
import type {
  RuntimeDispatchResult,
  RuntimeObservationToken,
  RuntimeWorkerIdentity,
} from '../runtime/contracts.ts';

export const S2_ONE_SHOT_POLICY = 's2-one-shot-v1' as const;
export const S2_MAX_STARTS_PER_TICK = 8 as const;
export const S2_RETENTION_TICKS = 128 as const;
export const S2_MAX_TERMINALS_PER_GENERATION = 1_024 as const;

export const IDLE_NUDGE_MESSAGE =
  'Continue the current task. If you are blocked or finished, publish the required worker report.' as const;
export const LIVELOCK_NUDGE_MESSAGE =
  'No progress was observed for the configured livelock window. Reassess the current task; continue, or publish a blocker/ready report.' as const;

export type EligibleFleetNudgeClass = Extract<ObserverClass, 'idle' | 'livelock'>;
export type FleetNudgeNoSendOutcome =
  | 'observer_untrusted'
  | 'class_ineligible'
  | 'external_provenance'
  | 'not_new_episode'
  | 'fresh_baseline_ineligible'
  | 'target_unresolved'
  | 'target_stale'
  | 'epoch_lost'
  | 'revalidation_failed'
  | 'claim_terminal'
  | 'claim_untrusted'
  | 'budget_exhausted';
export type FleetNudgeDispatchOutcome = 'dispatched' | 'send_failed' | 'dispatch_unknown';
export type FleetNudgeUnitOutcome = FleetNudgeNoSendOutcome | FleetNudgeDispatchOutcome;

export interface FleetNudgeEpisode {
  readonly projectId: string;
  readonly issueNumber: number;
  readonly schedulerGeneration: string;
  readonly tickSequence: number;
  readonly transitionIdentity: string;
  readonly unitRef: string;
  readonly eligibleClass: EligibleFleetNudgeClass;
  readonly intentClass: 'task-continuation';
  readonly policyTag: typeof S2_ONE_SHOT_POLICY;
}

export interface RuntimeFleetNudgeBinding extends FleetNudgeEpisode {
  /** Runtime-private identity remains in memory and is never passed to claims or journals. */
  readonly worker: RuntimeWorkerIdentity;
  readonly previousOutputToken?: RuntimeObservationToken | null;
}

export type FleetNudgeBindingResult =
  | { readonly status: 'resolved'; readonly binding: RuntimeFleetNudgeBinding }
  | { readonly status: 'target_unresolved' | 'target_stale' };

export type FleetNudgeRevalidationResult =
  | { readonly status: 'valid' }
  | { readonly status: 'epoch_lost' | 'revalidation_failed' };

export interface FleetNudgeClaimHandle {
  readonly opaque: unknown;
}

export type FleetNudgeClaimResult =
  | { readonly status: 'acquired'; readonly handle: FleetNudgeClaimHandle }
  | { readonly status: 'claim_terminal' | 'claim_untrusted' };

export interface FleetNudgeJournalHandle {
  readonly opaque: unknown;
}

export type FleetNudgeJournalAdmissionResult =
  | { readonly status: 'admitted'; readonly handle: FleetNudgeJournalHandle }
  | { readonly status: 'claim_untrusted' };

export interface FleetNudgeEffects {
  readonly resolveTarget: (
    episode: Omit<FleetNudgeEpisode, 'issueNumber'>,
    options: { readonly deadlineMs: number },
  ) => FleetNudgeBindingResult | PromiseLike<FleetNudgeBindingResult>;
  readonly revalidate: (
    binding: RuntimeFleetNudgeBinding,
    options: { readonly deadlineMs: number },
  ) => FleetNudgeRevalidationResult | PromiseLike<FleetNudgeRevalidationResult>;
  readonly acquireClaim: (
    episode: FleetNudgeEpisode,
    options: { readonly deadlineMs: number },
  ) => FleetNudgeClaimResult | PromiseLike<FleetNudgeClaimResult>;
  readonly persistMessageHash: (
    handle: FleetNudgeClaimHandle,
    message: string,
    options: { readonly deadlineMs: number },
  ) => { readonly ok: boolean } | PromiseLike<{ readonly ok: boolean }>;
  readonly admitJournal: (
    episode: FleetNudgeEpisode,
    message: string,
    options: { readonly deadlineMs: number },
  ) => FleetNudgeJournalAdmissionResult | PromiseLike<FleetNudgeJournalAdmissionResult>;
  readonly markSendAttempted: (
    handle: FleetNudgeClaimHandle,
    options: { readonly deadlineMs: number },
  ) => { readonly ok: boolean } | PromiseLike<{ readonly ok: boolean }>;
  readonly releaseClaim: (
    handle: FleetNudgeClaimHandle,
  ) => { readonly ok: boolean } | PromiseLike<{ readonly ok: boolean }>;
  readonly dispatch: (
    binding: RuntimeFleetNudgeBinding,
    message: string,
    options: { readonly deadlineMs: number },
  ) => RuntimeDispatchResult | PromiseLike<RuntimeDispatchResult>;
  readonly finalizeClaim: (
    handle: FleetNudgeClaimHandle,
    phase: 'SENT' | 'FAILED_DEFINITIVE' | 'UNCERTAIN',
    options: { readonly deadlineMs: number },
  ) => { readonly ok: boolean } | PromiseLike<{ readonly ok: boolean }>;
  readonly finalizeJournal: (
    handle: FleetNudgeJournalHandle,
    outcome: FleetNudgeDispatchOutcome,
    options: { readonly deadlineMs: number },
  ) => { readonly ok: boolean } | PromiseLike<{ readonly ok: boolean }>;
  readonly assertEpoch?: () => void;
  readonly pruneClaims?: (input: {
    readonly schedulerGeneration: string;
    readonly tickSequence: number;
  }) => void | PromiseLike<void>;
  readonly now?: () => number;
}

export interface FleetNudgeCandidateResult {
  readonly unitRef: string;
  readonly class: ObserverClass;
  readonly outcome: FleetNudgeUnitOutcome;
  readonly transitionIdentity?: string;
  readonly issueNumber?: number;
}

export interface FleetNudgeResult {
  readonly result:
    | 'target-binding-unresolved-fail-closed'
    | 'one-budgeted-gated-nudge-per-new-eligible-episode'
    | 'observer-untrusted';
  readonly status: 'complete' | 'failed';
  readonly schedulerGeneration: string;
  readonly tickSequence: number;
  readonly effectiveS2BudgetMs: number;
  readonly settlementReserveMs: number;
  readonly candidateOrder: readonly string[];
  readonly outcomes: readonly FleetNudgeCandidateResult[];
  readonly claimStarts: number;
  readonly sendAttempts: number;
  readonly dispatched: number;
  readonly returnedWithinBudget: boolean;
  readonly targetBindingAvailable: boolean;
}

export interface FleetNudgeTickInput {
  readonly observer: FleetObserverResult;
  readonly schedulerIntervalMs: number;
  readonly tickSequence: number;
  readonly phaseStartMs?: number;
  readonly projectId?: string;
}

interface EligibleCandidate {
  readonly row: CensusRow;
  readonly transition: FleetTransition & {
    readonly type: 'class-changed';
    readonly fromClass: ObserverClass;
    readonly toClass: EligibleFleetNudgeClass;
  };
  readonly transitionIdentity: string;
}

interface DeadlineResult<T> {
  readonly completed: boolean;
  readonly value?: T;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function calculateFleetNudgeBudget(schedulerIntervalMs: number): {
  readonly effectiveS2BudgetMs: number;
  readonly settlementReserveMs: number;
} {
  const interval = Math.max(1, Math.floor(schedulerIntervalMs));
  const effectiveS2BudgetMs = Math.min(2_000, Math.max(1, Math.floor(interval / 8)));
  return {
    effectiveS2BudgetMs,
    settlementReserveMs: Math.min(200, Math.max(1, Math.floor(effectiveS2BudgetMs / 5))),
  };
}

export function fleetNudgeMessage(eligibleClass: EligibleFleetNudgeClass): string {
  return eligibleClass === 'idle' ? IDLE_NUDGE_MESSAGE : LIVELOCK_NUDGE_MESSAGE;
}

export function buildFleetTransitionIdentity(transition: FleetTransition): string {
  if (transition.type !== 'class-changed'
    || !positiveInteger(transition.tickSequence)
    || !transition.unitRef
    || !transition.fromClass
    || !transition.toClass
    || transition.fromClass === transition.toClass) {
    throw new Error('invalid_fleet_transition_identity');
  }
  const identity = [
    'class-changed',
    transition.tickSequence,
    transition.unitRef,
    transition.fromClass,
    transition.toClass,
    transition.reason,
  ].join(':');
  if (Buffer.byteLength(identity, 'utf8') > 384) throw new Error('fleet_transition_identity_too_large');
  return identity;
}

function trustworthyObserver(input: FleetNudgeTickInput): boolean {
  const { observer, tickSequence } = input;
  const snapshot = observer.snapshot;
  if (observer.result !== 'census-published-observer-only'
    || observer.status !== 'complete'
    || observer.snapshotCommitted !== true
    || !snapshot
    || snapshot.commitStatus !== 'complete'
    || snapshot.result !== 'complete'
    || snapshot.schedulerGeneration !== observer.schedulerGeneration
    || snapshot.tickSequence !== observer.tickSequence
    || snapshot.tickSequence !== tickSequence) return false;

  const refs = new Set<string>();
  for (const row of snapshot.census) {
    if (!row.unitRef || refs.has(row.unitRef)) return false;
    refs.add(row.unitRef);
  }
  const currentClassChanges = new Set<string>();
  for (const transition of snapshot.transitions) {
    if (transition.tickSequence !== tickSequence || transition.type !== 'class-changed') continue;
    if (currentClassChanges.has(transition.unitRef)) return false;
    currentClassChanges.add(transition.unitRef);
    const row = snapshot.census.find((candidate) => candidate.unitRef === transition.unitRef);
    if (!row || transition.toClass !== row.class || !transition.fromClass) return false;
  }
  return true;
}

function classifyCandidates(input: FleetNudgeTickInput): {
  readonly eligible: EligibleCandidate[];
  readonly settled: FleetNudgeCandidateResult[];
} {
  const snapshot = input.observer.snapshot!;
  const transitions = snapshot.transitions.filter((transition) => transition.tickSequence === input.tickSequence);
  const eligible: EligibleCandidate[] = [];
  const settled: FleetNudgeCandidateResult[] = [];

  for (const row of snapshot.census) {
    if (row.provenance !== 'internal') {
      settled.push({ unitRef: row.unitRef, class: row.class, outcome: 'external_provenance' });
      continue;
    }
    if (row.class !== 'idle' && row.class !== 'livelock') {
      settled.push({ unitRef: row.unitRef, class: row.class, outcome: 'class_ineligible' });
      continue;
    }
    const classChange = transitions.find((transition) =>
      transition.type === 'class-changed'
      && transition.unitRef === row.unitRef
      && transition.toClass === row.class,
    );
    if (!classChange || classChange.type !== 'class-changed' || !classChange.fromClass) {
      const appeared = transitions.some((transition) =>
        transition.type === 'unit-appeared' && transition.unitRef === row.unitRef);
      settled.push({
        unitRef: row.unitRef,
        class: row.class,
        outcome: appeared ? 'fresh_baseline_ineligible' : 'not_new_episode',
      });
      continue;
    }
    const transition = classChange as EligibleCandidate['transition'];
    eligible.push({ row, transition, transitionIdentity: buildFleetTransitionIdentity(transition) });
  }

  eligible.sort((left, right) =>
    left.transitionIdentity.localeCompare(right.transitionIdentity)
    || left.row.unitRef.localeCompare(right.row.unitRef));
  return { eligible, settled };
}

async function beforeDeadline<T>(
  action: () => T | PromiseLike<T>,
  deadlineMs: number,
  now: () => number,
): Promise<DeadlineResult<T>> {
  const remaining = Math.floor(deadlineMs - now());
  if (remaining <= 0) return { completed: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DeadlineResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ completed: false }), remaining);
  });
  const operation = Promise.resolve()
    .then(action)
    .then((value): DeadlineResult<T> => now() <= deadlineMs
      ? { completed: true, value }
      : { completed: false })
    .catch((): DeadlineResult<T> => ({ completed: false }));
  const settled = await Promise.race([operation, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return settled;
}

function assertEpoch(effects: FleetNudgeEffects): boolean {
  try {
    effects.assertEpoch?.();
    return true;
  } catch {
    return false;
  }
}

function safeEpisode(
  projectId: string,
  candidate: EligibleCandidate,
  schedulerGeneration: string,
  tickSequence: number,
  issueNumber: number,
): FleetNudgeEpisode {
  return {
    projectId,
    issueNumber,
    schedulerGeneration,
    tickSequence,
    transitionIdentity: candidate.transitionIdentity,
    unitRef: candidate.row.unitRef,
    eligibleClass: candidate.row.class as EligibleFleetNudgeClass,
    intentClass: 'task-continuation',
    policyTag: S2_ONE_SHOT_POLICY,
  };
}

function exactBinding(
  binding: RuntimeFleetNudgeBinding,
  episode: FleetNudgeEpisode,
): boolean {
  return positiveInteger(binding.issueNumber)
    && binding.projectId === episode.projectId
    && binding.issueNumber === episode.issueNumber
    && binding.schedulerGeneration === episode.schedulerGeneration
    && binding.tickSequence === episode.tickSequence
    && binding.transitionIdentity === episode.transitionIdentity
    && binding.unitRef === episode.unitRef
    && binding.eligibleClass === episode.eligibleClass
    && binding.intentClass === 'task-continuation'
    && binding.policyTag === S2_ONE_SHOT_POLICY
    && typeof binding.worker?.runtime === 'string'
    && typeof binding.worker?.id === 'string'
    && typeof binding.worker?.generation === 'string';
}

async function finalizeAttempt(
  effects: FleetNudgeEffects,
  claim: FleetNudgeClaimHandle,
  journal: FleetNudgeJournalHandle,
  outcome: FleetNudgeDispatchOutcome,
  hardDeadline: number,
  now: () => number,
): Promise<void> {
  const phase = outcome === 'dispatched'
    ? 'SENT'
    : outcome === 'send_failed'
      ? 'FAILED_DEFINITIVE'
      : 'UNCERTAIN';
  await beforeDeadline(
    () => effects.finalizeClaim(claim, phase, { deadlineMs: hardDeadline }),
    hardDeadline,
    now,
  );
  await beforeDeadline(
    () => effects.finalizeJournal(journal, outcome, { deadlineMs: hardDeadline }),
    hardDeadline,
    now,
  );
}

export async function runFleetNudgeActuator(
  input: FleetNudgeTickInput,
  effects?: FleetNudgeEffects,
): Promise<FleetNudgeResult> {
  const now = effects?.now ?? Date.now;
  const phaseStart = input.phaseStartMs ?? now();
  const budget = calculateFleetNudgeBudget(input.schedulerIntervalMs);
  const hardDeadline = phaseStart + budget.effectiveS2BudgetMs;
  const admissionDeadline = hardDeadline - budget.settlementReserveMs;
  const dispatchDeadline = hardDeadline - Math.max(1, Math.floor(budget.settlementReserveMs / 2));
  const schedulerGeneration = input.observer.schedulerGeneration || 'unknown';
  const base = {
    schedulerGeneration,
    tickSequence: input.tickSequence,
    effectiveS2BudgetMs: budget.effectiveS2BudgetMs,
    settlementReserveMs: budget.settlementReserveMs,
  };

  if (!trustworthyObserver(input)) {
    return {
      ...base,
      result: 'observer-untrusted',
      status: 'failed',
      candidateOrder: [],
      outcomes: (input.observer.snapshot?.census ?? []).map((row) => ({
        unitRef: row.unitRef,
        class: row.class,
        outcome: 'observer_untrusted' as const,
      })),
      claimStarts: 0,
      sendAttempts: 0,
      dispatched: 0,
      returnedWithinBudget: now() <= hardDeadline,
      targetBindingAvailable: Boolean(effects),
    };
  }

  const { eligible, settled } = classifyCandidates(input);
  const candidateOrder = eligible.map((candidate) => candidate.transitionIdentity);
  if (!effects) {
    const outcomes = [
      ...settled,
      ...eligible.map((candidate): FleetNudgeCandidateResult => ({
        unitRef: candidate.row.unitRef,
        class: candidate.row.class,
        transitionIdentity: candidate.transitionIdentity,
        outcome: 'target_unresolved',
      })),
    ];
    return {
      ...base,
      result: 'target-binding-unresolved-fail-closed',
      status: 'complete',
      candidateOrder,
      outcomes,
      claimStarts: 0,
      sendAttempts: 0,
      dispatched: 0,
      returnedWithinBudget: now() <= hardDeadline,
      targetBindingAvailable: false,
    };
  }

  await beforeDeadline(
    () => effects.pruneClaims?.({ schedulerGeneration, tickSequence: input.tickSequence }),
    admissionDeadline,
    now,
  );

  const outcomes = [...settled];
  let claimStarts = 0;
  let sendAttempts = 0;
  let dispatched = 0;
  const projectId = input.projectId?.trim() || 'orchestrator-pack';

  for (const candidate of eligible) {
    if (claimStarts >= S2_MAX_STARTS_PER_TICK || now() >= admissionDeadline) {
      outcomes.push({
        unitRef: candidate.row.unitRef,
        class: candidate.row.class,
        transitionIdentity: candidate.transitionIdentity,
        outcome: 'budget_exhausted',
      });
      continue;
    }

    claimStarts += 1;
    const unresolvedEpisode = {
      projectId,
      schedulerGeneration,
      tickSequence: input.tickSequence,
      transitionIdentity: candidate.transitionIdentity,
      unitRef: candidate.row.unitRef,
      eligibleClass: candidate.row.class as EligibleFleetNudgeClass,
      intentClass: 'task-continuation' as const,
      policyTag: S2_ONE_SHOT_POLICY,
    };
    const resolution = await beforeDeadline(
      () => effects.resolveTarget(unresolvedEpisode, { deadlineMs: admissionDeadline }),
      admissionDeadline,
      now,
    );
    if (!resolution.completed || !resolution.value) {
      outcomes.push({ ...candidateResult(candidate), outcome: 'budget_exhausted' });
      continue;
    }
    if (resolution.value.status !== 'resolved') {
      outcomes.push({ ...candidateResult(candidate), outcome: resolution.value.status });
      continue;
    }

    const binding = resolution.value.binding;
    const issueNumber = binding.issueNumber;
    const episode = safeEpisode(
      projectId,
      candidate,
      schedulerGeneration,
      input.tickSequence,
      issueNumber,
    );
    if (!exactBinding(binding, episode)) {
      outcomes.push({ ...candidateResult(candidate), outcome: 'target_stale' });
      continue;
    }
    if (!assertEpoch(effects) {
      outcomes.push({ ...candidateResult(candidate), issueNumber, outcome: 'epoch_lost' });
      continue;
    }

    const revalidation = await beforeDeadline(
      () => effects.revalidate(binding, { deadlineMs: admissionDeadline }),
      admissionDeadline,
      now,
    );
    if (!revalidation.completed || !revalidation.value) {
      outcomes.push({ ...candidateResult(candidate), issueNumber, outcome: 'budget_exhausted' });
      continue;
    }
    if (revalidation.value.status !== 'valid') {
      outcomes.push({ ...candidateResult(candidate), issueNumber, outcome: revalidation.value.status });
      continue;
    }
    if (!assertEpoch(effects)) {
      outcomes.push({ ...candidateResult(candidate), issueNumber, outcome: 'epoch_lost' });
      continue;
    }

    const claimResult = await beforeDeadline(
      () => effects.acquireClaim(episode, { deadlineMs: admissionDeadline }),
      admissionDeadline,
      now,
    );
    if (!claimResult.completed || !claimResult.value) {
      outcomes.push({ ...candidateResult(candidate), issueNumber, outcome: 'budget_exhausted' });
      continue;
    }
    if (claimResult.value.status !== 'acquired') {
      outcomes.push({ ...candidateResult(candidate), issueNumber, outcome: claimResult.value.status });
      continue;
    }

    const claim = claimResult.value.handle;
    const message = fleetNudgeMessage(episode.eligibleClass);
    const hashResult = await beforeDeadline(
      () => effects.persistMessageHash(claim, message, { deadlineMs: admissionDeadline }),
      admissionDeadline,
      now,
    );
    if (+h¢V(º¯{®9÷{h‘éì•çí