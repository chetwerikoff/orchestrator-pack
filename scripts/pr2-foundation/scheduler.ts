import { createHash } from 'node:crypto';
import type { FoundationConfig } from './config.ts';
import { parseFoundationConfig } from './config.ts';
import { FileEpochAuthority } from '../lib/cutover/activation-epoch-authority.ts';
import { runProcess } from '../kernel/subprocess.ts';
import { evaluateHeadReadyForReview } from './review-head-ready.ts';
import { listPackReviewRuns } from '../lib/pack-review-run-store.ts';
import { startPackReview } from '../pack-review-runner.ts';
import { createUnavailableFleetObserver, FleetObserver, type FleetObserverResult } from './fleet-observer.ts';
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
} from '../lib/worker-assignment-store.ts';
import { resolveCurrentWorkerAssignmentBindings } from '../lib/worker-assignment-runtime.ts';
import { buildFleetAssignmentBindings, type FleetAssignmentBinding } from './fleet-assignment-binding.ts';
import { createProductionFleetNudgeEffects } from './fleet-nudge-production.ts';
import {
  publishFleetReconciliationHandoff,
  resolveFleetReconciliationHandoffPath,
  type FleetReconciliationReason,
} from './fleet-reconciliation-handoff.ts';

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

type SchedulerFleetObserver = Pick<FleetObserver, 'tick'> & Partial<Pick<FleetObserver, 'getEffectiveBudgetMs' | 'cancel'>>;
type SchedulerFleetNudgeActuator = { tick(input: FleetNudgeTickInput): Promise<FleetNudgeResult> };

export interface SchedulerBoundary {
  listCandidates(): ActivatedSchedulerCandidate[];
  readCurrentPr(candidate: ActivatedSchedulerCandidate): Promise<{ number: number; headRefOid: string; state: string; isDraft: boolean }>;
  readChecks(candidate: ActivatedSchedulerCandidate): Promise<Array<{ name?: string; state?: string; conclusion?: string; status?: string }>>;
  listReviewRuns(): ReturnType<typeof listPackReviewRuns>;
  start(candidate: ActivatedSchedulerCandidate, freshHeadSha: string): Promise<{ ok: boolean; reason?: string }>;
  schedulerIntervalMs?: number;
  fleetObserver?: SchedulerFleetObserver;
  fleetNudgeActuator?: SchedulerFleetNudgeActuator;
  activationLineage?: string;
  repository?: string;
  unresolvedReason?: FleetReconciliationReason;
  fleetBindings?: readonly FleetAssignmentBinding[];
  publishHandoff?: (input: {
    reason: FleetReconciliationReason;
    schedulerGeneration: string;
    tickSequence: number;
    unitRef?: string;
  }) => { ok: boolean; reason?: string };
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
    component: 'pr2-foundation-scheduler', registered: false, running: false, claimAcquirer: false,
    activationEpochEnforced: false, pollIntervalMs: config.scheduler.pollIntervalMs, leaseMs: config.scheduler.leaseMs,
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

function liveCandidates(env: NodeJS.ProcessEnv = process.env): ActivatedSchedulerCandidate[] {
  const workerStore = readWorkerStatusStoreFile(resolveWorkerStatusStorePath(env));
  const bindingStore = readPrSessionBindingCacheFile(resolvePrSessionBindingCachePath(env));
  const nowMs = Date.now(); const candidates: ActivatedSchedulerCandidate[] = [];
  for (const row of Object.values(workerStore.records ?? {})) {
    if ((row.derivedStatus ?? row.status) !== 'ready_for_review' || isRowStale(row, nowMs, Number(workerStore.repoTickGeneration ?? 0))) continue;
    const sessionId = String(row.sessionId ?? '').trim();
    const repoSlug = String(row.repoSlug ?? env.GITHUB_REPOSITORY ?? '').trim().toLowerCase();
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
  fleetNudgeActuator?: SchedulerFleetNudgeActuator; schedulerIntervalMs?: number; activationLineage?: string;
  repository?: string; unresolvedReason?: FleetReconciliationReason; fleetBindings?: readonly FleetAssignmentBinding[];
  publishHandoff?: SchedulerBoundary['publishHandoff'];
}): SchedulerBoundary {
  const env = input.env ?? process.env; const projectId = input.projectId ?? 'orchestrator-pack';
  return {
    listCandidates: () => liveCandidates(env),
    readCurrentPr: async (candidate) => ghJson(input.repoRoot, ['pr', 'view', String(candidate.prNumber), '--repo', candidate.repoSlug, '--json', 'number,headRefOid,state,isDraft']) as Promise<{ number: number; headRefOid: string; state: string; isDraft: boolean }>,
    readChecks: async (candidate) => ghJson(input.repoRoot, ['pr', 'checks', String(candidate.prNumber), '--repo', candidate.repoSlug, '--json', 'name,state,conclusion,status']) as Promise<Array<{ name?: string; state?: string; conclusion?: string; status?: string }>>,
    listReviewRuns: () => listPackReviewRuns({ projectId }),
    fleetNudgeActuator: input.fleetNudgeActuator ?? createTargetUnresolvedFleetNudgeActuator(),
    ...(input.fleetObserver ? { fleetObserver: input.fleetObserver } : {}),
    ...(input.schedulerIntervalMs === undefined ? {} : { schedulerIntervalMs: input.schedulerIntervalMs }),
    ...(input.activationLineage ? { activationLineage: input.activationLineage } : {}),
    ...(input.repository ? { repository: input.repository } : {}),
    ...(input.unresolvedReason ? { unresolvedReason: input.unresolvedReason } : {}),
    ...(input.fleetBindings ? { fleetBindings: input.fleetBindings } : {}),
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
  if (outcome === 'observer_untrusted') return 'observer_untrusted';
  if (outcome === 'claim_untrusted') return 'effect_untrusted';
  return null;
}

function publishRequiredHandoff(boundary: SchedulerBoundary, observer: FleetObserverResult, fleetNudge: FleetNudgeResult): boolean {
  const candidate = fleetNudge.outcomes.find((row) => reconciliationReason(boundary, row.outcome) !== null);
  if (!candidate) return false;
  const reason = reconciliationReason(boundary, candidate.outcome)!;
  if (!boundary.publishHandoff) throw new Error(`scheduler_reconciliation_handoff_unavailable:${reason}`);
  const result = boundary.publishHandoff({ reason, schedulerGeneration: observer.schedulerGeneration, tickSequence: observer.tickSequence, unitRef: candidate.unitRef });
  if (!result.ok) throw new Error(`scheduler_reconciliation_handoff_failed:${result.reason ?? reason}`);
  return true;
}

export async function runSchedulerTick(boundary: SchedulerBoundary, env: NodeJS.ProcessEnv = process.env): Promise<{
  attempted: number; started: number; skipped: number; observer?: FleetObserverResult; fleetNudge?: FleetNudgeResult; orchestratorRequired?: boolean;
}> {
  assertSchedulerEpoch(env);
  let observer: FleetObserverResult | undefined; let fleetNudge: FleetNudgeResult | undefined; let orchestratorRequired = false;
  const observerBoundary: SchedulerFleetObserver = boundary.fleetObserver ?? { tick: async () => undefined as unknown as FleetObserverResult };
  const schedulerIntervalMs = boundary.schedulerIntervalMs ?? 5_000; const requestedTickSequence = nextSchedulerTickSequence(boundary); const observerStartMs = Date.now();
  const observerBudgetMs = observerBoundary.getEffectiveBudgetMs?.(schedulerIntervalMs) ?? Math.max(1, Math.floor(schedulerIntervalMs / 4));
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { deadlineTimer = setTimeout(() => resolve(null), Math.max(1, observerBudgetMs)); });
  const attempt = Promise.resolve().then(() => observerBoundary.tick({ schedulerIntervalMs, tickSequence: requestedTickSequence, phaseStartMs: observerStartMs })).catch(() => undefined);
  const completed = await Promise.race([attempt, timeout]); if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  if (completed === null) observerBoundary.cancel?.(); else if (boundary.fleetObserver) observer = completed;
  if (observer && boundary.fleetNudgeActuator) {
    const acceptedTickSequence = acceptObserverTickSequence(boundary, requestedTickSequence, observer);
    try {
      assertSchedulerEpoch(env);
      fleetNudge = await boundary.fleetNudgeActuator.tick({ observer, schedulerIntervalMs, tickSequence: acceptedTickSequence, phaseStartMs: Date.now() });
      orchestratorRequired = publishRequiredHandoff(boundary, observer, fleetNudge);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('scheduler_reconciliation_handoff_')) throw error;
      const fallback: FleetNudgeResult = fleetNudge ?? {
        result: 'observer-untrusted', status: 'failed', schedulerGeneration: observer.schedulerGeneration,
        tickSequence: acceptedTickSequence, effectiveS2BudgetMs: 1, settlementReserveMs: 1, candidateOrder: [],
        outcomes: observer.snapshot?.census.map((row) => ({ unitRef: row.unitRef, class: row.class, outcome: 'observer_untrusted' as const })) ?? [],
        claimStarts: 0, sendAttempts: 0, dispatched: 0, returnedWithinBudget: true, targetBindingAvailable: false,
      };
      fleetNudge = fallback;
      orchestratorRequired = publishRequiredHandoff(boundary, observer, fallback);
    }
  }
  let attempted = 0; let started = 0; let skipped = 0;
  for (const candidate of boundary.listCandidates()) {
    attempted += 1; assertSchedulerEpoch(env); const fresh = await boundary.readCurrentPr(candidate); const freshHead = String(fresh.headRefOid ?? '').trim().toLowerCase();
    if (fresh.state !== 'OPEN' && String(fresh.state).toLowerCase() !== 'open') { skipped += 1; continue; }
    if (fresh.isDraft === true || freshHead !== candidate.boundHeadSha.toLowerCase()) { skipped += 1; continue; }
    const checks = await boundary.readChecks(candidate); const runs = boundary.listReviewRuns();
    const decision = evaluateHeadReadyForReview({ prNumber: candidate.prNumber, headSha: freshHead, session: { id: candidate.sessionId, role: 'worker', status: 'ready_for_review', ownedHeadSha: freshHead, reports: [{ reportState: 'ready_for_review', headRefOid: freshHead, accepted: true }] }, ciChecks: checks, reviewRuns: runs });
    if (!decision.eligible) { skipped += 1; continue; }
    assertSchedulerEpoch(env); const result = await boundary.start(candidate, freshHead); if (result.ok) started += 1; else skipped += 1;
  }
  return { attempted, started, skipped, ...(observer ? { observer } : {}), ...(fleetNudge ? { fleetNudge } : {}), ...(orchestratorRequired ? { orchestratorRequired: true } : {}) };
}

function uniqueRepository(assignments: ReturnType<typeof listCurrentWorkerAssignments>, env: NodeJS.ProcessEnv): string {
  const explicit = String(env.OPK_REPOSITORY ?? env.GITHUB_REPOSITORY ?? '').trim().toLowerCase();
  if (explicit) return explicit;
  if (!assignments) return '';
  const values = [...new Set(assignments.map((assignment) => assignment.repository))];
  return values.length === 1 ? values[0]! : '';
}

async function loadProductionBoundary(): Promise<{ boundary: SchedulerBoundary; cadence: number }> {
  const parsed = parseFoundationConfig({}); if (!parsed.ok) throw new Error(`${parsed.reason}:${parsed.path}`);
  const repoRoot = process.cwd(); const cadence = parsed.config.scheduler.pollIntervalMs; const env = process.env; const projectId = 'orchestrator-pack';
  const epoch = assertSchedulerEpoch(env); const activationLineage = schedulerActivationLineage(epoch);
  const assignmentStorePath = resolveWorkerAssignmentStorePath(projectId, env); const storedAssignments = listCurrentWorkerAssignments(assignmentStorePath);
  const repository = uniqueRepository(storedAssignments, env);
  let fleetObserver: FleetObserver; let fleetNudgeActuator: SchedulerFleetNudgeActuator = createTargetUnresolvedFleetNudgeActuator();
  let unresolvedReason: FleetReconciliationReason = storedAssignments === null ? 'assignment_untrusted' : 'target_unresolved';
  let fleetBindings: readonly FleetAssignmentBinding[] = [];
  try {
    const runtime = await selectRuntimeAdapter();
    const resolution = repository
      ? resolveCurrentWorkerAssignmentBindings({ file: assignmentStorePath, repository, adapter: runtime })
      : { status: 'assignment_untrusted' as const, bindings: [] as const };
    const built = resolution.status === 'ok' ? buildFleetAssignmentBindings(resolution.bindings) : null;
    if (resolution.status === 'ok' && built) {
      fleetBindings = built;
      fleetObserver = new FleetObserver({ source: runtime, activationLineage, assignmentBindings: fleetBindings });
      const effects = createProductionFleetNudgeEffects({ projectId, assignmentStorePath, adapter: runtime, resolvedAssignments: resolution.bindings, fleetBindings, assertEpoch: () => { assertSchedulerEpoch(env); }, env });
      fleetNudgeActuator = { tick: (input) => runFleetNudgeActuator(input, effects) };
      unresolvedReason = 'target_unresolved';
    } else {
      unresolvedReason = resolution.status === 'runtime_unavailable' ? 'runtime_unavailable' : 'assignment_untrusted';
      fleetObserver = new FleetObserver({ source: runtime, activationLineage, assignmentBindings: [] });
    }
  } catch {
    unresolvedReason = 'runtime_unavailable'; fleetObserver = createUnavailableFleetObserver('runtime-adapter-unavailable');
  }
  const handoffPath = resolveFleetReconciliationHandoffPath(projectId, env);
  const publishHandoff: NonNullable<SchedulerBoundary['publishHandoff']> = ({ reason, schedulerGeneration, tickSequence, unitRef }) => {
    const binding = unitRef ? fleetBindings.find((candidate) => candidate.unitRef === unitRef) : undefined;
    const result = publishFleetReconciliationHandoff({ file: handoffPath, projectId, repository: repository || 'unknown/repository', activationLineage, schedulerGeneration, tickSequence, reason, role: binding ? 'worker' : undefined, issueNumber: binding?.issueNumber, taskId: binding?.taskId, assignmentId: binding?.assignmentId, assignmentGeneration: binding?.assignmentGeneration });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  };
  return {
    boundary: productionSchedulerBoundary({ repoRoot, projectId, env, fleetObserver, fleetNudgeActuator, schedulerIntervalMs: cadence, activationLineage, repository, unresolvedReason, fleetBindings, publishHandoff }),
    cadence,
  };
}

async function runSingleTick(): Promise<void> {
  const { boundary } = await loadProductionBoundary(); const result = await runSchedulerTick(boundary);
  process.stdout.write(`${JSON.stringify({ scheduler: { result: 'epoch-gated-tick', ...result } })}\n`);
}
async function runLoop(): Promise<void> {
  const { boundary, cadence } = await loadProductionBoundary();
  for (;;) {
    try { const result = await runSchedulerTick(boundary); process.stdout.write(`${JSON.stringify({ scheduler: { result: 'epoch-gated-tick', ...result } })}\n`); }
    catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); }
    await new Promise((resolve) => setTimeout(resolve, cadence));
  }
}

if (process.argv[1]?.endsWith('scheduler.ts')) {
  if (process.argv[2] === 'run') runLoop().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
  else if (process.argv[2] === 'tick') runSingleTick().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
