import type { FoundationConfig } from './config.ts';
import { parseFoundationConfig } from './config.ts';
import { FileEpochAuthority } from '../lib/cutover/activation-epoch-authority.ts';
import { runProcess } from '../kernel/subprocess.ts';
import { evaluateHeadReadyForReview } from './review-head-ready.ts';
import { listPackReviewRuns } from '../lib/pack-review-run-store.ts';
import { startPackReview } from '../pack-review-runner.ts';
import { FleetObserver, type FleetObserverResult } from './fleet-observer.ts';
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

export interface DormantSchedulerState {
  component: 'pr2-foundation-scheduler';
  registered: false;
  running: false;
  claimAcquirer: false;
  activationEpochEnforced: false;
  pollIntervalMs: number;
  leaseMs: number;
}

export interface DormantActuatorResult {
  ok: true;
  executed: false;
  reason: 'foundation_inert';
}

export interface ActivatedSchedulerCandidate {
  sessionId: string;
  repoSlug: string;
  prNumber: number;
  boundHeadSha: string;
}

export interface SchedulerBoundary {
  listCandidates(): ActivatedSchedulerCandidate[];
  readCurrentPr(candidate: ActivatedSchedulerCandidate): Promise<{ number: number; headRefOid: string; state: string; isDraft: boolean }>;
  readChecks(candidate: ActivatedSchedulerCandidate): Promise<Array<{ name?: string; state?: string; conclusion?: string; status?: string }>>;
  listReviewRuns(): ReturnType<typeof listPackReviewRuns>;
  start(candidate: ActivatedSchedulerCandidate, freshHeadSha: string): Promise<{ ok: boolean; reason?: string }>;
  schedulerIntervalMs?: number;
  fleetObserver?: Pick<FleetObserver, 'tick'>;
}

const schedulerTickSequences = new WeakMap<object, number>();

function nextSchedulerTickSequence(boundary: SchedulerBoundary): number {
  const next = (schedulerTickSequences.get(boundary) ?? 0) + 1;
  schedulerTickSequences.set(boundary, next);
  return next;
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

export function runDormantMergeActuator(_config: FoundationConfig): DormantActuatorResult {
  return { ok: true, executed: false, reason: 'foundation_inert' };
}

export function assertFoundationInert(input: {
  registryChanged: boolean;
  supervisorChanged: boolean;
  schedulerRegistered: boolean;
  schedulerRunning: boolean;
  schedulerClaimAcquirer: boolean;
  activationEpochEnforced: boolean;
  liveStoreOpened: boolean;
  legacyStarterDisabled: boolean;
  nonNotificationRuntimeDelta: boolean;
  notificationTypedConfigLive: boolean;
  dormantTypedConfigReaderLive: boolean;
}): { ok: true; result: 'live-acquirers-unchanged' } | { ok: false; reason: string } {
  const failures: Array<[boolean, string]> = [
    [input.registryChanged, 'registry_changed'],
    [input.supervisorChanged, 'supervisor_changed'],
    [input.schedulerRegistered, 'scheduler_registered'],
    [input.schedulerRunning, 'scheduler_running'],
    [input.schedulerClaimAcquirer, 'scheduler_claim_acquirer'],
    [input.activationEpochEnforced, 'activation_epoch_enforced'],
    [input.liveStoreOpened, 'live_store_opened'],
    [input.legacyStarterDisabled, 'legacy_starter_disabled'],
    [input.nonNotificationRuntimeDelta, 'non_notification_runtime_delta'],
    [!input.notificationTypedConfigLive, 'notification_config_reader_absent'],
    [input.dormantTypedConfigReaderLive, 'dormant_config_reader_live'],
  ];
  const failure = failures.find(([condition]) => condition);
  return failure
    ? { ok: false, reason: failure[1] }
    : { ok: true, result: 'live-acquirers-unchanged' };
}

function liveCandidates(env: NodeJS.ProcessEnv = process.env): ActivatedSchedulerCandidate[] {
  const workerStore = readWorkerStatusStoreFile(resolveWorkerStatusStorePath(env));
  const bindingStore = readPrSessionBindingCacheFile(resolvePrSessionBindingCachePath(env));
  const nowMs = Date.now();
  const candidates: ActivatedSchedulerCandidate[] = [];
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
  const result = await runProcess({
    command: pathlessGh(repoRoot),
    args,
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: 30_000,
  });
  if (!result.ok) throw new Error(`scheduler_gh_failed:${args.join('_')}:${result.stderr || result.error || result.exitCode}`);
  return JSON.parse(result.stdout);
}

function pathlessGh(repoRoot: string): string {
  return `${repoRoot}/scripts/gh`;
}

export function productionSchedulerBoundary(input: {
  repoRoot: string;
  projectId?: string;
  env?: NodeJS.ProcessEnv;
  fleetObserver?: Pick<FleetObserver, 'tick'>;
  schedulerIntervalMs?: number;
}): SchedulerBoundary {
  const env = input.env ?? process.env;
  const projectId = input.projectId ?? 'orchestrator-pack';
  return {
    listCandidates: () => liveCandidates(env),
    readCurrentPr: async (candidate) => ghJson(input.repoRoot, [
      'pr', 'view', String(candidate.prNumber), '--repo', candidate.repoSlug,
      '--json', 'number,headRefOid,state,isDraft',
    ]) as Promise<{ number: number; headRefOid: string; state: string; isDraft: boolean }>,
    readChecks: async (candidate) => ghJson(input.repoRoot, [
      'pr', 'checks', String(candidate.prNumber), '--repo', candidate.repoSlug,
      '--json', 'name,state,conclusion,status',
    ]) as Promise<Array<{ name?: string; state?: string; conclusion?: string; status?: string }>>,
    listReviewRuns: () => listPackReviewRuns({ projectId }),
    ...(input.fleetObserver ? { fleetObserver: input.fleetObserver } : {}),
    ...(input.schedulerIntervalMs === undefined ? {} : { schedulerIntervalMs: input.schedulerIntervalMs }),
    start: async (candidate, freshHeadSha) => {
      const result = await startPackReview({
        projectId,
        linkedSessionId: candidate.sessionId,
        prNumber: candidate.prNumber,
        headSha: freshHeadSha,
        sourceRepoRoot: input.repoRoot,
        startReason: 'scheduler',
        surface: 'pr2-scheduler',
        claimMode: 'acquire',
      });
      return {
        ok: result.ok === true,
        ...(typeof result.reason === 'string' ? { reason: result.reason } : {}),
      };
    },
  };
}

export async function runSchedulerTick(
  boundary: SchedulerBoundary,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  attempted: number;
  started: number;
  skipped: number;
  observer?: FleetObserverResult;
}> {
  assertSchedulerEpoch(env);
  let observer: FleetObserverResult | undefined;
  if (boundary.fleetObserver) {
    try {
      observer = await boundary.fleetObserver.tick({
        schedulerIntervalMs: boundary.schedulerIntervalMs ?? 5_000,
        tickSequence: nextSchedulerTickSequence(boundary),
      });
    } catch {
      // Observer failure is evidence only; the existing action phase remains authoritative.
    }
  }
  let attempted = 0;
  let started = 0;
  let skipped = 0;
  for (const candidate of boundary.listCandidates()) {
    attempted += 1;
    assertSchedulerEpoch(env);
    const fresh = await boundary.readCurrentPr(candidate);
    const freshHead = String(fresh.headRefOid ?? '').trim().toLowerCase();
    if (fresh.state !== 'OPEN' && String(fresh.state).toLowerCase() !== 'open') { skipped += 1; continue; }
    if (fresh.isDraft === true || freshHead !== candidate.boundHeadSha.toLowerCase()) { skipped += 1; continue; }
    const checks = await boundary.readChecks(candidate);
    const runs = boundary.listReviewRuns();
    const decision = evaluateHeadReadyForReview({
      prNumber: candidate.prNumber,
      headSha: freshHead,
      session: {
        id: candidate.sessionId,
        role: 'worker',
        status: 'ready_for_review',
        ownedHeadSha: freshHead,
        reports: [{ reportState: 'ready_for_review', headRefOid: freshHead, accepted: true }],
      },
      ciChecks: checks,
      reviewRuns: runs,
    });
    if (!decision.eligible) { skipped += 1; continue; }
    assertSchedulerEpoch(env);
    const result = await boundary.start(candidate, freshHead);
    if (result.ok) started += 1; else skipped += 1;
  }
  return observer
    ? { attempted, started, skipped, observer }
    : { attempted, started, skipped };
}

async function loadProductionBoundary(): Promise<{ boundary: SchedulerBoundary; cadence: number }> {
  const parsed = parseFoundationConfig({});
  if (!parsed.ok) throw new Error(`${parsed.reason}:${parsed.path}`);
  const repoRoot = process.cwd();
  const cadence = parsed.config.scheduler.pollIntervalMs;
  let fleetObserver: FleetObserver | undefined;
  try {
    const runtime = await selectRuntimeAdapter();
    fleetObserver = new FleetObserver({ source: runtime });
  } catch {
    // Runtime adapter failure is observer evidence; the existing action phase remains authoritative.
  }
  return {
    boundary: productionSchedulerBoundary({
      repoRoot,
      ...(fleetObserver ? { fleetObserver } : {}),
      schedulerIntervalMs: cadence,
    }),
    cadence,
  };
}

async function runSingleTick(): Promise<void> {
  const { boundary } = await loadProductionBoundary();
  const result = await runSchedulerTick(boundary);
  process.stdout.write(`${JSON.stringify({ scheduler: { result: 'epoch-gated-tick', ...result } })}\n`);
}

async function runLoop(): Promise<void> {
  const { boundary, cadence } = await loadProductionBoundary();
  for (;;) {
    try {
      const result = await runSchedulerTick(boundary);
      process.stdout.write(`${JSON.stringify({ scheduler: { result: 'epoch-gated-tick', ...result } })}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, cadence));
  }
}

if (process.argv[1]?.endsWith('scheduler.ts')) {
  if (process.argv[2] === 'run') {
    runLoop().catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  } else if (process.argv[2] === 'tick') {
    runSingleTick().catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  }
}
