import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import type { FoundationConfig } from './config.ts';
import { parseFoundationConfig } from './config.ts';
import { FileEpochAuthority } from '../lib/cutover/activation-epoch-authority.ts';
import { runProcess } from '../kernel/subprocess.ts';
import { evaluateHeadReadyForReview } from './review-head-ready.ts';
import { listPackReviewRuns } from '../lib/pack-review-run-store.ts';
import { startPackReview } from '../pack-review-runner.ts';
import { reconcilePostReviewSmoke, type PostReviewSmokeOutcome } from './post-review-smoke.ts';
import {
  createUnavailableFleetObserver,
  FleetObserver,
  type FleetObserverResult,
  type FleetObserverSource,
} from './fleet-observer.ts';
import {
  createTargetUnresolvedFleetNudgeActuator,
  runFleetNudgeActuator,
  type FleetNudgeResult,
  type FleetNudgeTickInput,
} from './fleet-nudge-actuator.ts';
import { selectRuntimeAdapter } from '../runtime/registry.ts';
import {
  isRowStale,
  readWorkerStatusStoreFile,
  resolveWorkerStatusStorePath,
} from '../lib/worker-status-store.mjs';
import {
  lookupBindingBySession,
  readPrSessionBindingCacheFile,
  resolvePrSessionBindingCachePath,
} from '../../docs/pr-session-binding-cache.mjs';
import {
  listCurrentWorkerAssignments,
  resolveWorkerAssignmentStorePath,
  type WorkerAssignment,
} from '../lib/worker-assignment-store.ts';
import { resolveCurrentWorkerAssignmentBindings } from '../lib/worker-assignment-runtime.ts';
import { runtimeFailure, sameRuntimeWorker, type RuntimeAdapter } from '../runtime/contracts.ts';
import { buildFleetAssignmentBindings, type FleetAssignmentBinding } from './fleet-assignment-binding.ts';
import { createProductionFleetNudgeEffects } from './fleet-nudge-production.ts';
import {
  publishFleetReconciliationHandoff,
  resolveFleetReconciliationHandoffPath,
  type FleetReconciliationHandoff,
  type FleetReconciliationReason,
} from './fleet-reconciliation-handoff.ts';
import {
  runFleetEscalationDelivery,
  type FleetEscalationInvocationInput,
  type FleetEscalationInvocationResultV1,
} from './fleet-escalation-delivery.ts';

export interface DormantSchedulerState {
  component: 'pr2-foundation-scheduler';
  registered: false;
  running: false;
  claimAcquirer: false;
  activationEpochEnforced: false;
  pollIntervalMs: number;
  leaseMs: number;
}

export interface DormantActuatorResult { ok: true; executed: false; reason: 'foundation_inert' }
export interface ActivatedSchedulerCandidate { sessionId: string; repoSlug: string; prNumber: number; boundHeadSha: string }
export interface SchedulerCurrentPr { number: number; headRefOid: string; state: string; isDraft: boolean; body?: string }

type SchedulerFleetObserver = Pick<FleetObserver, 'tick'> & Partial<Pick<FleetObserver, 'getEffectiveBudgetMs' | 'cancel' | 'schedulerGeneration' | 'snapshotPath'>>;
type SchedulerFleetNudgeActuator = { tick(input: FleetNudgeTickInput): Promise<FleetNudgeResult> };
type SchedulerFleetEscalation = (
  input: Pick<FleetEscalationInvocationInput, 'evidence' | 'committedReadBack' | 'expected'>,
) => Promise<FleetEscalationInvocationResultV1>;
interface SchedulerAssignmentReconciliation {
  readonly reason: FleetReconciliationReason;
  readonly assignment?: WorkerAssignment;
}
interface SchedulerPublishedHandoff {
  readonly required: boolean;
  readonly record?: FleetReconciliationHandoff;
}
interface SchedulerFleetIdentity {
  readonly schedulerGeneration: string;
  readonly tickSequence: number;
}

export interface SchedulerBoundary {
  listCandidates(): ActivatedSchedulerCandidate[];
  readCurrentPr(candidate: ActivatedSchedulerCandidate): Promise<SchedulerCurrentPr>;
  readChecks(candidate: ActivatedSchedulerCandidate): Promise<Array<{ name?: string; state?: string; conclusion?: string; status?: string }>>;
  listReviewRuns(): ReturnType<typeof listPackReviewRuns>;
  start(candidate: ActivatedSchedulerCandidate, freshHeadSha: string): Promise<{ ok: boolean; reason?: string }>;
  reconcilePostReviewSmoke?: (candidate: ActivatedSchedulerCandidate, fresh: SchedulerCurrentPr) => Promise<PostReviewSmokeOutcome>;
  schedulerIntervalMs?: number;
  fleetObserver?: SchedulerFleetObserver;
  fleetNudgeActuator?: SchedulerFleetNudgeActuator;
  fleetEscalation?: SchedulerFleetEscalation;
  projectId?: string;
  activationLineage?: string;
  repository?: string;
  unresolvedReason?: FleetReconciliationReason;
  assignmentReconciliation?: SchedulerAssignmentReconciliation;
  fleetBindings?: readonly FleetAssignmentBinding[];
  publishHandoff?: (input: {
    reason: FleetReconciliationReason;
    schedulerGeneration: string;
    tickSequence: number;
    unitRef?: string;
  }) => { ok: boolean; reason?: string; record?: FleetReconciliationHandoff };
}

const schedulerTickSequences = new WeakMap<object, number>();
function nextSchedulerTickSequence(boundary: SchedulerBoundary): number {
  const next = (schedulerTickSequences.get(boundary) ?? 0) + 1;
  schedulerTickSequences.set(boundary, next);
  return next;
}
function acceptObserverTickSequence(boundary: SchedulerBoundary, requestedTickSequence: number, observer: FleetObserverResult): number {
  const accepted = Number(observer.tickSequence);
  if (!Number.isInteger(accepted) || accepted <= 0) return requestedTickSequence;
  schedulerTickSequences.set(boundary, Math.max(requestedTickSequence, accepted));
  return accepted;
}

function requiredEnv(name: string, env: NodeJS.ProcessEnv): string {
  const value = String(env[name] ?? '').trim();
  if (!value) throw new Error(`scheduler_missing_${name.toLowerCase()}`);
  return value;
}

const GITHUB_REMOTE_PATTERN = /(?:github\.com[/:])([^/\s]+)\/([^/\s]+?)(?:\.git)?$/iu;

export function repositorySlugFromRemote(remote: string): string {
  const match = remote.trim().match(GITHUB_REMOTE_PATTERN);
  if (!match) throw new Error('scheduler_repository_identity_unresolved');
  return `${match[1]}/${match[2]}`.toLowerCase();
}

export function liveCandidateRepository(
  row: { readonly repoSlug?: unknown },
  repository?: string,
): string {
  const rowRepository = String(row.repoSlug ?? '').trim().toLowerCase();
  if (!rowRepository) return '';
  const localRepository = String(repository ?? '').trim().toLowerCase();
  return localRepository && rowRepository !== localRepository ? '' : rowRepository;
}

export async function resolveRepositoryFromRepoRoot(repoRoot: string): Promise<string> {
  const result = await runProcess({
    command: 'git',
    args: ['-C', repoRoot, 'remote', 'get-url', 'origin'],
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: 30_000,
  });
  if (!result.ok) {
    throw new Error(`scheduler_repository_identity_unresolved:${result.stderr || result.error || result.exitCode || 'git_remote_failed'}`);
  }
  return repositorySlugFromRemote(result.stdout);
}

export function assertSchedulerEpoch(env: NodeJS.ProcessEnv = process.env): { epochId: string; nonce: string } {
  const authorityPath = requiredEnv('ORCHESTRATOR_CUTOVER_EPOCH_AUTHORITY', env);
  const epochId = requiredEnv('ORCHESTRATOR_CUTOVER_EPOCH_ID', env);
  const nonce = requiredEnv('ORCHESTRATOR_CUTOVER_NONCE', env);
  new FileEpochAuthority(authorityPath).verify(epochId, nonce);
  return { epochId, nonce };
}

export function schedulerActivationLineage(epoch: { epochId: string; nonce: string }): string {
  return `al-${createHash('sha256').update(`${epoch.epochId}\u0000${epoch.nonce}`, 'utf8').digest('hex').slice(0, 32)}`;
}

export function buildDormantScheduler(config: FoundationConfig): DormantSchedulerState {
  return {
    component: 'pr2-foundation-scheduler',
    registered: false,
    running: false,
    claimAcquirer: false,
    activationEpochEnforced: false,
    pollIntervalMs: config.scheduler.pollIntervalMs,
    leaseMs: config.scheduler.leaseMs,
  };
}
export function runDormantMergeActuator(_config: FoundationConfig): DormantActuatorResult { return { ok: true, executed: false, reason: 'foundation_inert' }; }

export function assertFoundationInert(input: {
  registryChanged: boolean; supervisorChanged: boolean; schedulerRegistered: boolean; schedulerRunning: boolean;
  schedulerClaimAcquirer: boolean; activationEpochEnforced: boolean; liveStoreOpened: boolean; legacyStarterDisabled: boolean;
  nonNotificationRuntimeDelta: boolean; notificationTypedConfigLive: boolean; dormantTypedConfigReaderLive: boolean;
}): { ok: true; result: 'live-acquirers-unchanged' } | { ok: false; reason: string } {
  const failures: Array<[boolean, string]> = [
    [input.registryChanged, 'registry_changed'], [input.supervisorChanged, 'supervisor_changed'],
    [input.schedulerRegistered, 'scheduler_registered'], [input.schedulerRunning, 'scheduler_running'],
    [input.schedulerClaimAcquirer, 'scheduler_claim_acquirer'], [input.activationEpochEnforced, 'activation_epoch_enforced'],
    [input.liveStoreOpened, 'live_store_opened'], [input.legacyStarterDisabled, 'legacy_starter_disabled'],
    [input.nonNotificationRuntimeDelta, 'non_notification_runtime_delta'], [!input.notificationTypedConfigLive, 'notification_config_reader_absent'],
    [input.dormantTypedConfigReaderLive, 'dormant_config_reader_live'],
  ];
  const failure = failures.find(([condition]) => condition);
  return failure ? { ok: false, reason: failure[1] } : { ok: true, result: 'live-acquirers-unchanged' };
}

function liveCandidates(env: NodeJS.ProcessEnv = process.env, repository?: string): ActivatedSchedulerCandidate[] {
  const workerStore = readWorkerStatusStoreFile(resolveWorkerStatusStorePath(env));
  const bindingStore = readPrSessionBindingCacheFile(resolvePrSessionBindingCachePath(env));
  const nowMs = Date.now(); const candidates: ActivatedSchedulerCandidate[] = [];
  for (const row of Object.values(workerStore.records ?? {})) {
    if ((row.derivedStatus ?? row.status) !== 'ready_for_review' || isRowStale(row, nowMs, Number(workerStore.repoTickGeneration ?? 0))) continue;
    const sessionId = String(row.sessionId ?? '').trim();
    const repoSlug = liveCandidateRepository(row, repository);
    if (!sessionId || !repoSlug) continue;
    const binding = lookupBindingBySession(bindingStore, repoSlug, sessionId);
    if (!binding || Number(binding.prNumber ?? 0) <= 0 || !String(binding.headSha ?? '').trim()) continue;
    candidates.push({ sessionId, repoSlug, prNumber: Number(binding.prNumber), boundHeadSha: String(binding.headSha) });
  }
  return candidates;
}

async function ghJson(repoRoot: string, args: string[]): Promise<unknown> {
  const result = await runProcess({ command: `${repoRoot}/scripts/gh`, args, cwd: repoRoot, inheritParentEnv: true, allowEmptyStdout: false, timeoutMs: 30_000 });
  if (!result.ok) throw new Error(`scheduler_gh_failed:${args.join('_')}:${result.stderr || result.error || result.exitCode}`);
  return JSON.parse(result.stdout);
}

export function productionSchedulerBoundary(input: {
  repoRoot: string; projectId?: string; env?: NodeJS.ProcessEnv; fleetObserver?: SchedulerFleetObserver;
  fleetNudgeActuator?: SchedulerFleetNudgeActuator; fleetEscalation?: SchedulerFleetEscalation;
  schedulerIntervalMs?: number; activationLineage?: string;
  repository?: string; unresolvedReason?: FleetReconciliationReason; assignmentReconciliation?: SchedulerAssignmentReconciliation;
  fleetBindings?: readonly FleetAssignmentBinding[];
  reconcilePostReviewSmoke?: SchedulerBoundary['reconcilePostReviewSmoke'];
  publishHandoff?: SchedulerBoundary['publishHandoff'];
}): SchedulerBoundary {
  const env = input.env ?? process.env; const projectId = input.projectId ?? 'orchestrator-pack';
  return {
    listCandidates: () => liveCandidates(env, input.repository),
    readCurrentPr: async (candidate) => ghJson(input.repoRoot, ['pr', 'view', String(candidate.prNumber), '--repo', candidate.repoSlug, '--json', 'number,headRefOid,state,isDraft,body']) as Promise<SchedulerCurrentPr>,
    readChecks: async (candidate) => ghJson(input.repoRoot, ['pr', 'checks', String(candidate.prNumber), '--repo', candidate.repoSlug, '--json', 'name,state,conclusion,status']) as Promise<Array<{ name?: string; state?: string; conclusion?: string; status?: string }>>,
    listReviewRuns: () => listPackReviewRuns({ projectId }),
    fleetNudgeActuator: input.fleetNudgeActuator ?? createTargetUnresolvedFleetNudgeActuator(),
    projectId,
    ...(input.fleetObserver ? { fleetObserver: input.fleetObserver } : {}),
    ...(input.fleetEscalation ? { fleetEscalation: input.fleetEscalation } : {}),
    ...(input.schedulerIntervalMs === undefined ? {} : { schedulerIntervalMs: input.schedulerIntervalMs }),
    ...(input.activationLineage ? { activationLineage: input.activationLineage } : {}),
    ...(input.repository ? { repository: input.repository } : {}),
    ...(input.unresolvedReason ? { unresolvedReason: input.unresolvedReason } : {}),
    ...(input.assignmentReconciliation ? { assignmentReconciliation: input.assignmentReconciliation } : {}),
    ...(input.fleetBindings ? { fleetBindings: input.fleetBindings } : {}),
    ...(input.reconcilePostReviewSmoke ? { reconcilePostReviewSmoke: input.reconcilePostReviewSmoke } : {}),
    ...(input.publishHandoff ? { publishHandoff: input.publishHandoff } : {}),
    start: async (candidate, freshHeadSha) => {
      const result = await startPackReview({ projectId, linkedSessionId: candidate.sessionId, prNumber: candidate.prNumber, headSha: freshHeadSha, sourceRepoRoot: input.repoRoot, startReason: 'scheduler', surface: 'pr2-scheduler', claimMode: 'acquire' });
      return { ok: result.ok === true, ...(typeof result.reason === 'string' ? { reason: result.reason } : {}) };
    },
  };
}

function reconciliationReason(boundary: SchedulerBoundary, outcome: string): FleetReconciliationReason | null {
  if (outcome === 'target_unresolved') return boundary.unresolvedReason ?? 'target_unresolved';
  if (outcome === 'target_stale' || outcome === 'revalidation_failed') return 'target_stale';
  if (outcome === 'dispatch_unknown') return 'dispatch_unknown';
  if (outcome === 'send_failed') return 'effect_untrusted';
  if (outcome === 'observer_untrusted') return 'observer_untrusted';
  if (outcome === 'claim_untrusted') return 'effect_untrusted';
  return null;
}

function publishRequiredHandoff(
  boundary: SchedulerBoundary,
  observer: FleetObserverResult,
  fleetNudge: FleetNudgeResult,
): SchedulerPublishedHandoff {
  const candidate = fleetNudge.outcomes.find((row) => reconciliationReason(boundary, row.outcome) !== null);
  let reason: FleetReconciliationReason | null = null;
  let unitRef: string | undefined;
  if (candidate) {
    reason = reconciliationReason(boundary, candidate.outcome)!;
    unitRef = candidate.unitRef;
  } else if (fleetNudge.status === 'failed') {
    reason = observer.status === 'failed' || fleetNudge.result === 'observer-untrusted'
      ? 'observer_untrusted'
      : 'effect_untrusted';
  } else if (boundary.assignmentReconciliation) {
    reason = boundary.assignmentReconciliation.reason;
  }
  if (!reason) return { required: false };
  if (!boundary.publishHandoff) throw new Error(`scheduler_reconciliation_handoff_unavailable:${reason}`);
  const result = boundary.publishHandoff({
    reason,
    schedulerGeneration: observer.schedulerGeneration,
    tickSequence: observer.tickSequence,
    ...(unitRef ? { unitRef } : {}),
  });
  if (!result.ok) throw new Error(`scheduler_reconciliation_handoff_failed:${result.reason ?? reason}`);
  return { required: true, ...(result.record ? { record: result.record } : {}) };
}

async function evaluateFleetEscalation(
  boundary: SchedulerBoundary,
  handoff: SchedulerPublishedHandoff,
  identity: SchedulerFleetIdentity,
): Promise<FleetEscalationInvocationResultV1 | undefined> {
  if (!handoff.required || !boundary.fleetEscalation) return undefined;
  return boundary.fleetEscalation({
    evidence: handoff.record ?? null,
    committedReadBack: handoff.record !== undefined,
    expected: {
      projectId: String(boundary.projectId ?? ''),
      repository: String(boundary.repository ?? ''),
      activationLineage: String(boundary.activationLineage ?? ''),
      schedulerGeneration: identity.schedulerGeneration,
      tickSequence: identity.tickSequence,
    },
  });
}

function publishObserverFailureHandoff(
  boundary: SchedulerBoundary,
  observer: SchedulerFleetObserver,
  tickSequence: number,
  reason: 'observer_timeout' | 'observer_threw',
): { readonly handoff: SchedulerPublishedHandoff; readonly identity: SchedulerFleetIdentity } {
  const schedulerGeneration = String(observer.schedulerGeneration ?? '').trim();
  if (!schedulerGeneration) throw new Error(`scheduler_observer_identity_unavailable:${reason}`);
  if (!boundary.publishHandoff) throw new Error('scheduler_reconciliation_handoff_unavailable:observer_untrusted');
  const published = boundary.publishHandoff({
    reason: 'observer_untrusted',
    schedulerGeneration,
    tickSequence,
  });
  if (!published.ok) throw new Error(`scheduler_reconciliation_handoff_failed:${published.reason ?? 'observer_untrusted'}`);
  return {
    handoff: { required: true, ...(published.record ? { record: published.record } : {}) },
    identity: { schedulerGeneration, tickSequence },
  };
}

export async function runSchedulerTick(boundary: SchedulerBoundary, env: NodeJS.ProcessEnv = process.env): Promise<{
  attempted: number;
  started: number;
  skipped: number;
  observer?: FleetObserverResult;
  fleetNudge?: FleetNudgeResult;
  orchestratorRequired?: boolean;
  fleetEscalation?: FleetEscalationInvocationResultV1;
}> {
  assertSchedulerEpoch(env);
  let observer: FleetObserverResult | undefined;
  let fleetNudge: FleetNudgeResult | undefined;
  let fleetEscalation: FleetEscalationInvocationResultV1 | undefined;
  let orchestratorRequired = false;
  const schedulerIntervalMs = boundary.schedulerIntervalMs ?? 5_000; const requestedTickSequence = nextSchedulerTickSequence(boundary);
  if (boundary.fleetObserver) {
    const observerBoundary = boundary.fleetObserver; const observerStartMs = Date.now();
    const observerBudgetMs = observerBoundary.getEffectiveBudgetMs?.(schedulerIntervalMs) ?? Math.max(1, Math.floor(schedulerIntervalMs / 4));
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ status: 'timeout' }>((resolve) => {
      deadlineTimer = setTimeout(() => resolve({ status: 'timeout' }), Math.max(1, observerBudgetMs));
    });
    const attempt = Promise.resolve()
      .then(() => observerBoundary.tick({ schedulerIntervalMs, tickSequence: requestedTickSequence, phaseStartMs: observerStartMs }))
      .then((value) => ({ status: 'complete' as const, value }))
      .catch(() => ({ status: 'failed' as const }));
    const completed = await Promise.race([attempt, timeout]);
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (completed.status !== 'complete') {
      observerBoundary.cancel?.();
      const observerFailureReason = completed.status === 'timeout' ? 'observer_timeout' : 'observer_threw';
      const observerFailure = publishObserverFailureHandoff(
        boundary,
        observerBoundary,
        requestedTickSequence,
        observerFailureReason,
      );
      orchestratorRequired = observerFailure.handoff.required;
      fleetEscalation = await evaluateFleetEscalation(
        boundary,
        observerFailure.handoff,
        observerFailure.identity,
      );
      if (!fleetEscalation) throw new Error(`scheduler_observer_untrusted:${observerFailureReason}`);
      return {
        attempted: 0,
        started: 0,
        skipped: 0,
        ...(orchestratorRequired ? { orchestratorRequired: true } : {}),
        fleetEscalation,
      };
    }
    observer = completed.value;
  }
  if (observer && boundary.fleetNudgeActuator) {
    const acceptedTickSequence = acceptObserverTickSequence(boundary, requestedTickSequence, observer);
    try {
      assertSchedulerEpoch(env);
      fleetNudge = await boundary.fleetNudgeActuator.tick({ observer, schedulerIntervalMs, tickSequence: acceptedTickSequence, phaseStartMs: Date.now() });
    } catch {
      fleetNudge = {
        result: 'observer-untrusted', status: 'failed', schedulerGeneration: observer.schedulerGeneration,
        tickSequence: acceptedTickSequence, effectiveS2BudgetMs: 1, settlementReserveMs: 1, candidateOrder: [],
        outcomes: observer.snapshot?.census.map((row) => ({ unitRef: row.unitRef, class: row.class, outcome: 'observer_untrusted' as const })) ?? [],
        claimStarts: 0, sendAttempts: 0, dispatched: 0, returnedWithinBudget: true, targetBindingAvailable: false,
      };
    }
    const handoff = publishRequiredHandoff(boundary, observer, fleetNudge);
    orchestratorRequired = handoff.required;
    fleetEscalation = await evaluateFleetEscalation(boundary, handoff, observer);
    if (fleetNudge.status === 'failed') {
      return {
        attempted: 0,
        started: 0,
        skipped: 0,
        observer,
        fleetNudge,
        ...(orchestratorRequired ? { orchestratorRequired: true } : {}),
        ...(fleetEscalation ? { fleetEscalation } : {}),
      };
    }
  }
  let attempted = 0; let started = 0; let skipped = 0;
  for (const candidate of boundary.listCandidates()) {
    attempted += 1; assertSchedulerEpoch(env); const fresh = await boundary.readCurrentPr(candidate); const freshHead = String(fresh.headRefOid ?? '').trim().toLowerCase();
    if (fresh.state !== 'OPEN' && String(fresh.state).toLowerCase() !== 'open') { skipped += 1; continue; }
    if (fresh.isDraft === true || freshHead !== candidate.boundHeadSha.toLowerCase()) { skipped += 1; continue; }
    if (boundary.reconcilePostReviewSmoke) {
      assertSchedulerEpoch(env);
      const smoke = await boundary.reconcilePostReviewSmoke(candidate, fresh);
      if (smoke.handled) { skipped += 1; continue; }
    }
    const checks = await boundary.readChecks(candidate); const runs = boundary.listReviewRuns();
    const decision = evaluateHeadReadyForReview({ prNumber: candidate.prNumber, headSha: freshHead, session: { id: candidate.sessionId, role: 'worker', status: 'ready_for_review', ownedHeadSha: freshHead, reports: [{ reportState: 'ready_for_review', headRefOid: freshHead, accepted: true }] }, ciChecks: checks, reviewRuns: runs });
    if (!decision.eligible) { skipped += 1; continue; }
    assertSchedulerEpoch(env); const result = await boundary.start(candidate, freshHead); if (result.ok) started += 1; else skipped += 1;
  }
  return {
    attempted,
    started,
    skipped,
    ...(observer ? { observer } : {}),
    ...(fleetNudge ? { fleetNudge } : {}),
    ...(orchestratorRequired ? { orchestratorRequired: true } : {}),
    ...(fleetEscalation ? { fleetEscalation } : {}),
  };
}

function productionObserverBoundary(observer: FleetObserver): SchedulerFleetObserver {
  return {
    // The FleetObserver owns the persisted sequence. The scheduler process is
    // intentionally short-lived, so never overwrite restored continuity with a
    // fresh process-local sequence of 1.
    tick: (input) => observer.tick({ ...input, tickSequence: undefined }),
    getEffectiveBudgetMs: (interval) => observer.getEffectiveBudgetMs(interval),
    cancel: () => observer.cancel(),
    schedulerGeneration: observer.schedulerGeneration,
    snapshotPath: observer.snapshotPath,
  };
}

export function productionFleetObserverSource(
  runtime: FleetObserverSource,
  assignmentBindings: readonly FleetAssignmentBinding[],
): FleetObserverSource {
  return {
    listWorkers: async (_input, options) => {
      const deadlineMs = typeof options?.timeoutMs === 'number'
        ? Date.now() + Math.max(0, options.timeoutMs)
        : undefined;
      const listed = [];
      for (const binding of assignmentBindings) {
        const remainingTimeoutMs = deadlineMs === undefined
          ? undefined
          : deadlineMs - Date.now();
        if (remainingTimeoutMs !== undefined && remainingTimeoutMs <= 0) {
          return runtimeFailure('find_worker', 'phase_budget_expired');
        }
        const lookupOptions = remainingTimeoutMs === undefined
          ? options
          : { ...options, timeoutMs: Math.max(1, Math.floor(remainingTimeoutMs)) };
        const result = await runtime.findWorker(binding.worker, lookupOptions);
        if (result.status !== 'ok') return result;
        listed.push(result);
      }
      const assigned = assignmentBindings.map((binding) => binding.worker);
      return {
        status: 'ok',
        value: listed.flatMap((result) => {
          if (result.status !== 'ok' || result.value === null) return [];
          const worker = result.value;
          return worker.provenance !== 'external'
            || assigned.some((identity) => sameRuntimeWorker(identity, worker.identity))
            ? [worker]
            : [];
        }),
      };
    },
    findWorker: (identity, options) => runtime.findWorker(identity, options),
    readBoundedOutput: (input, options) => runtime.readBoundedOutput(input, options),
    liveness: (input, options) => runtime.liveness(input, options),
  };
}

function operatorHome(env: NodeJS.ProcessEnv): string {
  return String(env.HOME ?? '').trim() || homedir();
}

function productionFleetObserverConfigPath(env: NodeJS.ProcessEnv): string {
  const explicit = String(env.OPK_FLEET_OBSERVER_CONFIG ?? '').trim();
  return explicit || path.join(operatorHome(env), '.config', 'orchestrator-pack', 'fleet-observer.json');
}

function productionFleetObserverSnapshotPath(env: NodeJS.ProcessEnv): string {
  const explicitRoot = String(env.OPK_SIDE_PROCESS_STATE_DIR ?? '').trim();
  return explicitRoot
    ? path.join(explicitRoot, 'fleet-observer-snapshot.json')
    : path.join(operatorHome(env), '.local', 'state', 'orchestrator-pack', 'fleet-observer', 'snapshot.json');
}

export function createProductionPostReviewSmokeReconciler(input: {
  projectId: string;
  repoRoot: string;
  assignmentStorePath: string;
  env: NodeJS.ProcessEnv;
  selectAdapter?: () => Promise<RuntimeAdapter>;
}): NonNullable<SchedulerBoundary['reconcilePostReviewSmoke']> {
  const selectAdapter = input.selectAdapter ?? (() => selectRuntimeAdapter({ env: input.env }));
  return async (candidate, fresh) => {
    let adapter: RuntimeAdapter;
    try {
      adapter = await selectAdapter();
    } catch (error) {
      return {
        handled: true,
        attempted: false,
        reason: `post_review_smoke_runtime_unavailable:${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return reconcilePostReviewSmoke({
      repoSlug: candidate.repoSlug,
      prNumber: candidate.prNumber,
      headSha: String(fresh.headRefOid ?? '').trim().toLowerCase(),
      prBody: String(fresh.body ?? ''),
    }, {
      projectId: input.projectId,
      repoRoot: input.repoRoot,
      assignmentStorePath: input.assignmentStorePath,
      adapter,
      env: input.env,
    });
  };
}

async function loadProductionBoundary(): Promise<{ boundary: SchedulerBoundary; cadence: number }> {
  const parsed = parseFoundationConfig({}); if (!parsed.ok) throw new Error(`${parsed.reason}:${parsed.path}`);
  const repoRoot = process.cwd(); const cadence = parsed.config.scheduler.pollIntervalMs; const env = process.env; const projectId = 'orchestrator-pack';
  const epoch = assertSchedulerEpoch(env); const activationLineage = schedulerActivationLineage(epoch);
  const assignmentStorePath = resolveWorkerAssignmentStorePath(projectId, env); const storedAssignments = listCurrentWorkerAssignments(assignmentStorePath);
  const repository = await resolveRepositoryFromRepoRoot(repoRoot);
  const scopedAssignment = storedAssignments?.find((assignment) => assignment.repository === repository);
  let fleetObserver: FleetObserver; let fleetNudgeActuator: SchedulerFleetNudgeActuator = createTargetUnresolvedFleetNudgeActuator();
  let unresolvedReason: FleetReconciliationReason = storedAssignments === null ? 'assignment_untrusted' : 'target_unresolved';
  let assignmentReconciliation: SchedulerAssignmentReconciliation | undefined;
  let fleetBindings: readonly FleetAssignmentBinding[] = [];
  try {
    const runtime = await selectRuntimeAdapter({ env });
    const resolution = repository
      ? resolveCurrentWorkerAssignmentBindings({ file: assignmentStorePath, repository, adapter: runtime })
      : { status: 'assignment_untrusted' as const, bindings: [] as const, reconciliations: [] as const };
    const built = resolution.status === 'ok' ? buildFleetAssignmentBindings(resolution.bindings) : null;
    if (resolution.status === 'ok' && built) {
      fleetBindings = built;
      assignmentReconciliation = resolution.reconciliations[0];
      fleetObserver = new FleetObserver({
        source: productionFleetObserverSource(runtime, fleetBindings),
        activationLineage,
        assignmentBindings: fleetBindings,
        configPath: productionFleetObserverConfigPath(env),
        snapshotPath: productionFleetObserverSnapshotPath(env),
      });
      const effects = createProductionFleetNudgeEffects({ projectId, assignmentStorePath, adapter: runtime, resolvedAssignments: resolution.bindings, fleetBindings, assertEpoch: () => { assertSchedulerEpoch(env); }, env });
      fleetNudgeActuator = { tick: (input) => runFleetNudgeActuator(input, effects) };
      unresolvedReason = 'target_unresolved';
    } else {
      unresolvedReason = resolution.status === 'runtime_unavailable' ? 'runtime_unavailable' : 'assignment_untrusted';
      assignmentReconciliation = {
        reason: unresolvedReason,
        ...(scopedAssignment ? { assignment: scopedAssignment } : {}),
      };
      fleetObserver = new FleetObserver({
        source: productionFleetObserverSource(runtime, []),
        activationLineage,
        assignmentBindings: [],
        configPath: productionFleetObserverConfigPath(env),
        snapshotPath: productionFleetObserverSnapshotPath(env),
      });
    }
  } catch {
    unresolvedReason = 'runtime_unavailable';
    assignmentReconciliation = {
      reason: 'runtime_unavailable',
      ...(scopedAssignment ? { assignment: scopedAssignment } : {}),
    };
    fleetObserver = createUnavailableFleetObserver('runtime-adapter-unavailable');
  }
  const handoffPath = resolveFleetReconciliationHandoffPath(projectId, env);
  const publishHandoff: NonNullable<SchedulerBoundary['publishHandoff']> = ({ reason, schedulerGeneration, tickSequence, unitRef }) => {
    if (!repository) return { ok: false, reason: 'repository_identity_unresolved' };
    const binding = unitRef ? fleetBindings.find((candidate) => candidate.unitRef === unitRef) : undefined;
    const reconciliationAssignment = !binding && assignmentReconciliation?.reason === reason
      ? assignmentReconciliation.assignment
      : undefined;
    const assignmentMetadata = binding
      ? {
          role: 'worker' as const,
          issueNumber: binding.issueNumber,
          taskId: binding.taskId,
          assignmentId: binding.assignmentId,
          assignmentGeneration: binding.assignmentGeneration,
        }
      : reconciliationAssignment
        ? {
            role: 'worker' as const,
            issueNumber: reconciliationAssignment.issueNumber,
            taskId: reconciliationAssignment.taskId,
            assignmentId: reconciliationAssignment.assignmentId,
            assignmentGeneration: reconciliationAssignment.generation,
          }
        : {};
    const result = publishFleetReconciliationHandoff({
      file: handoffPath,
      projectId,
      repository,
      activationLineage,
      schedulerGeneration,
      tickSequence,
      reason,
      ...assignmentMetadata,
    });
    return result.ok ? { ok: true, record: result.record } : { ok: false, reason: result.reason };
  };
  const fleetEscalation: SchedulerFleetEscalation = (invocation) => runFleetEscalationDelivery({
    ...invocation,
    assignmentStorePath,
    selectAdapter: () => selectRuntimeAdapter({ env }),
  });
  const postReviewSmoke = createProductionPostReviewSmokeReconciler({
    projectId,
    repoRoot,
    assignmentStorePath,
    env,
  });
  return {
    boundary: productionSchedulerBoundary({
      repoRoot,
      projectId,
      env,
      fleetObserver: productionObserverBoundary(fleetObserver),
      fleetNudgeActuator,
      fleetEscalation,
      schedulerIntervalMs: cadence,
      activationLineage,
      repository,
      unresolvedReason,
      ...(assignmentReconciliation ? { assignmentReconciliation } : {}),
      fleetBindings,
      reconcilePostReviewSmoke: postReviewSmoke,
      publishHandoff,
    }),
    cadence,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatSchedulerError(error: unknown): string {
  if (error instanceof AggregateError) {
    return `${error.message}: ${error.errors.map(errorText).join('; ')}`;
  }
  return errorText(error);
}

function schedulerFleetPhaseFailure(result: Awaited<ReturnType<typeof runSchedulerTick>>): string | null {
  if (result.fleetNudge?.status !== 'failed') return null;
  return `scheduler_fleet_phase_failed:${result.fleetNudge.result}`;
}

async function runSingleTick(): Promise<void> {
  const { boundary } = await loadProductionBoundary();
  const result = await runSchedulerTick(boundary);
  process.stdout.write(`${JSON.stringify({ scheduler: { result: 'epoch-gated-tick', ...result } })}\n`);
  const failure = schedulerFleetPhaseFailure(result);
  if (failure) throw new Error(failure);
}
async function runLoop(): Promise<void> {
  const { boundary, cadence } = await loadProductionBoundary();
  for (;;) {
    try {
      const result = await runSchedulerTick(boundary);
      process.stdout.write(`${JSON.stringify({ scheduler: { result: 'epoch-gated-tick', ...result } })}\n`);
      const failure = schedulerFleetPhaseFailure(result);
      if (failure) throw new Error(failure);
    }
    catch (error) { process.stderr.write(`${formatSchedulerError(error)}\n`); }
    await new Promise((resolve) => setTimeout(resolve, cadence));
  }
}

if (process.argv[1]?.endsWith('scheduler.ts')) {
  if (process.argv[2] === 'run') runLoop().catch((error) => { process.stderr.write(`${formatSchedulerError(error)}\n`); process.exitCode = 1; });
  else if (process.argv[2] === 'tick') runSingleTick().catch((error) => { process.stderr.write(`${formatSchedulerError(error)}\n`); process.exitCode = 1; });
}