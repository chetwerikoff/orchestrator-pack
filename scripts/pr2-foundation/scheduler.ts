import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FoundationConfig } from './config.ts';
import { runProcess } from '../kernel/subprocess.ts';
import { JsonEpochAuthority } from '../lib/cutover/activation-epoch-authority.ts';
import { verifyRegistryHash } from '../lib/cutover/activation-registry-projection.ts';
import { planReconcileActions } from './terminalized/review-trigger-reconcile.ts';
import { preRunHeadReadyRecheck } from './terminalized/review-head-ready.ts';
import {
  mergePackWorkerReportsIntoSessions,
  readWorkerReportStoreFile,
  resolveWorkerReportStorePath,
} from './terminalized/worker-report-store.ts';
import { listPackReviewRuns } from '../lib/pack-review-run-store.ts';
import { startPackReview } from '../pack-review-runner.ts';

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

export interface ActiveSchedulerOptions {
  repoRoot: string;
  stateDir?: string;
  epochId: string;
  nonce: string;
  epochAuthorityFile: string;
  registryPath: string;
  pollIntervalMs?: number;
  projectId?: string;
}

type OpenPr = Record<string, unknown> & { number: number; headRefOid: string; isDraft?: boolean };
type Session = Record<string, unknown>;
type CiCheck = Record<string, unknown>;

type SchedulerSnapshot = {
  openPrs: OpenPr[];
  reviewRuns: ReturnType<typeof listPackReviewRuns>;
  sessions: Session[];
  sessionDetailsById: Record<string, Record<string, unknown>>;
  ciChecksByPr: Record<string, CiCheck[]>;
  requiredCheckNamesByPr: Record<string, string[]>;
  requiredCheckLookupFailedByPr: Record<string, boolean>;
  tracking: Record<string, unknown>;
  cycleState: Record<string, unknown>;
  capCycleState: Record<string, unknown>;
  repoRoot: string;
  nowMs: number;
};

type StartAction = {
  type: 'start_review';
  prNumber: number;
  headSha: string;
  sessionId: string;
  startReason?: string;
};

function text(value: unknown): string { return String(value ?? '').trim(); }
function sessionId(row: Session): string { return text(row.id ?? row.name ?? row.sessionId); }

function parseJsonOutput(stdout: string, label: string): unknown {
  const objectAt = stdout.indexOf('{');
  const arrayAt = stdout.indexOf('[');
  const starts = [objectAt, arrayAt].filter((value) => value >= 0);
  if (!starts.length) throw new Error(`${label}_json_missing`);
  return JSON.parse(stdout.slice(Math.min(...starts)));
}

async function runJson(command: string, args: string[], cwd: string, label: string, acceptedExitCodes = [0]): Promise<unknown> {
  const result = await runProcess({
    command,
    args,
    cwd,
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: 60_000,
  });
  const exitCode = result.exitCode ?? -1;
  if (!acceptedExitCodes.includes(exitCode)) {
    throw new Error(`${label}_failed:${result.stderr || result.error || exitCode}`);
  }
  return parseJsonOutput(result.stdout, label);
}

function normalizeAoRows(payload: unknown, projectId: string): Session[] {
  const object = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const rows = Array.isArray(object.data) ? object.data : Array.isArray(object.sessions) ? object.sessions : [];
  return rows
    .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value)))
    .map((row): Session => {
      const id = sessionId(row);
      const project = text(row.projectId ?? row.project);
      return { ...row, id, name: text(row.name) || id, sessionId: text(row.sessionId) || id, projectId: project || projectId };
    })
    .filter((row) => Boolean(row.id) && (!projectId || text(row.projectId) === projectId))
    .filter((row) => row.isTerminated !== true && !/^(terminated|killed|exited|dead|closed)$/i.test(text(row.status)));
}

function mergeUniqueSessions(workerRows: Session[], orchestratorRows: Session[]): Session[] {
  const byId = new Map<string, Session>();
  for (const row of [...workerRows, ...orchestratorRows]) {
    const id = sessionId(row);
    if (!id) continue;
    const prior = byId.get(id);
    if (prior) byId.set(id, { ...prior, ...row });
    else byId.set(id, row);
  }
  return [...byId.values()];
}

async function collectSessionDetails(repoRoot: string, projectId: string, sessions: Session[]): Promise<Record<string, Record<string, unknown>>> {
  const details: Record<string, Record<string, unknown>> = {};
  const candidates = sessions.filter((row) => {
    const role = text(row.role).toLowerCase();
    const hasBindingHint = Number(row.prNumber ?? row.issueNumber ?? row.issueId ?? 0) > 0 || /^\d+$/.test(text(row.displayName));
    return (role === 'worker' || role === 'coding') && !hasBindingHint && Boolean(sessionId(row));
  }).slice(0, 16);
  for (const row of candidates) {
    const id = sessionId(row);
    try {
      const payload = await runJson('ao', ['session', 'get', id, '--json', '-p', projectId], repoRoot, 'scheduler_ao_session_get');
      const object = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
      const detail = object.session && typeof object.session === 'object' && !Array.isArray(object.session)
        ? object.session as Record<string, unknown>
        : object;
      details[id] = detail;
    } catch {
      // Detail enrichment is optional. Ambiguous ownership remains fail-closed in the existing planner.
    }
  }
  return details;
}

function statePath(options: ActiveSchedulerOptions): string {
  if (process.env.AO_REVIEW_TRIGGER_RECONCILE_STATE) return resolve(process.env.AO_REVIEW_TRIGGER_RECONCILE_STATE);
  return resolve(options.stateDir || tmpdir(), 'orchestrator-review-reconcile-state.json');
}

function readState(options: ActiveSchedulerOptions): Record<string, unknown> {
  const path = statePath(options);
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    throw new Error('scheduler_reconcile_state_corrupt');
  }
}

function writeState(options: ActiveSchedulerOptions, value: Record<string, unknown>): void {
  const path = statePath(options);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.cutover-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, 'utf8');
  renameSync(temp, path);
}

async function collectOpenPrs(options: ActiveSchedulerOptions): Promise<OpenPr[]> {
  const payload = await runJson(
    resolve(options.repoRoot, 'scripts/gh'),
    ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,headRefOid,isDraft'],
    options.repoRoot,
    'scheduler_open_pr_read',
  );
  if (!Array.isArray(payload)) throw new Error('scheduler_open_pr_shape_invalid');
  return payload.filter((row): row is OpenPr => Boolean(
    row && typeof row === 'object' &&
    Number.isInteger(Number((row as OpenPr).number)) &&
    /^[0-9a-f]{40}$/i.test(text((row as OpenPr).headRefOid)) &&
    (row as OpenPr).isDraft !== true,
  )).map((row) => ({ ...row, number: Number(row.number), headRefOid: text(row.headRefOid) }));
}

async function collectChecks(options: ActiveSchedulerOptions, openPrs: OpenPr[]): Promise<{
  ciChecksByPr: Record<string, CiCheck[]>;
  requiredCheckNamesByPr: Record<string, string[]>;
  requiredCheckLookupFailedByPr: Record<string, boolean>;
}> {
  const ciChecksByPr: Record<string, CiCheck[]> = {};
  const requiredCheckNamesByPr: Record<string, string[]> = {};
  const requiredCheckLookupFailedByPr: Record<string, boolean> = {};
  for (const pr of openPrs) {
    try {
      const payload = await runJson(
        resolve(options.repoRoot, 'scripts/gh'),
        ['pr', 'checks', String(pr.number), '--json', 'name,state,bucket,link,startedAt,completedAt,workflow,description'],
        options.repoRoot,
        `scheduler_pr_checks_${pr.number}`,
        [0, 1, 8],
      );
      if (!Array.isArray(payload)) throw new Error('checks_shape_invalid');
      ciChecksByPr[String(pr.number)] = payload as CiCheck[];
      requiredCheckNamesByPr[String(pr.number)] = [];
      requiredCheckLookupFailedByPr[String(pr.number)] = false;
    } catch {
      ciChecksByPr[String(pr.number)] = [];
      requiredCheckNamesByPr[String(pr.number)] = [];
      requiredCheckLookupFailedByPr[String(pr.number)] = true;
    }
  }
  return { ciChecksByPr, requiredCheckNamesByPr, requiredCheckLookupFailedByPr };
}

async function collectRepoSlug(options: ActiveSchedulerOptions): Promise<string> {
  const fromEnv = text(process.env.GITHUB_REPOSITORY || process.env.AO_REPO_SLUG);
  if (fromEnv) return fromEnv.toLowerCase();
  const payload = await runJson(
    resolve(options.repoRoot, 'scripts/gh'),
    ['repo', 'view', '--json', 'nameWithOwner'],
    options.repoRoot,
    'scheduler_repo_view',
  );
  const object = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const slug = text(object.nameWithOwner).toLowerCase();
  if (!slug.includes('/')) throw new Error('scheduler_repo_slug_unresolved');
  return slug;
}

async function collectSessions(options: ActiveSchedulerOptions): Promise<{ sessions: Session[]; sessionDetailsById: Record<string, Record<string, unknown>> }> {
  const projectId = options.projectId ?? 'orchestrator-pack';
  const [workerPayload, orchestratorPayload, repoSlug] = await Promise.all([
    runJson('ao', ['session', 'ls', '--json', '-p', projectId], options.repoRoot, 'scheduler_ao_session_ls'),
    runJson('ao', ['orchestrator', 'ls', '--json'], options.repoRoot, 'scheduler_ao_orchestrator_ls'),
    collectRepoSlug(options),
  ]);
  const bare = mergeUniqueSessions(normalizeAoRows(workerPayload, projectId), normalizeAoRows(orchestratorPayload, projectId));
  const reportStore = readWorkerReportStoreFile(resolveWorkerReportStorePath(process.env));
  const sessions = mergePackWorkerReportsIntoSessions(bare, reportStore, repoSlug) as Session[];
  return { sessions, sessionDetailsById: await collectSessionDetails(options.repoRoot, projectId, sessions) };
}

async function collectSnapshot(options: ActiveSchedulerOptions): Promise<SchedulerSnapshot> {
  assertSchedulerEpoch(options);
  const openPrs = await collectOpenPrs(options);
  const [{ sessions, sessionDetailsById }, checks] = await Promise.all([
    collectSessions(options),
    collectChecks(options, openPrs),
  ]);
  const prior = readState(options);
  return {
    openPrs,
    reviewRuns: listPackReviewRuns({ projectId: options.projectId ?? 'orchestrator-pack' }),
    sessions,
    sessionDetailsById,
    ...checks,
    tracking: prior,
    cycleState: (prior.cycleState && typeof prior.cycleState === 'object' ? prior.cycleState : {}) as Record<string, unknown>,
    capCycleState: (prior.capCycleState && typeof prior.capCycleState === 'object' ? prior.capCycleState : {}) as Record<string, unknown>,
    repoRoot: options.repoRoot,
    nowMs: Date.now(),
  };
}

export function assertSchedulerEpoch(options: ActiveSchedulerOptions): void {
  const core = new JsonEpochAuthority(options.epochAuthorityFile).require(options.epochId, options.nonce);
  if (resolve(core.repoRoot) !== resolve(options.repoRoot)) throw new Error('scheduler_repo_binding_mismatch');
  verifyRegistryHash(options.registryPath, core.registryHash);
}

async function invokeStartReview(options: ActiveSchedulerOptions, action: StartAction): Promise<void> {
  const result = await startPackReview({
    projectId: options.projectId ?? 'orchestrator-pack',
    sessionId: action.sessionId,
    linkedSessionId: action.sessionId,
    prNumber: action.prNumber,
    headSha: action.headSha,
    sourceRepoRoot: options.repoRoot,
    startReason: action.startReason || 'scheduler',
    surface: 'pr2-cutover-scheduler',
  });
  if (result.ok === false && result.reused !== true) {
    throw new Error(`scheduler_review_start_failed:${action.prNumber}:${text(result.reason) || 'unknown'}`);
  }
}

export async function runSchedulerTick(
  options: ActiveSchedulerOptions,
  deps: {
    collectSnapshot?: (options: ActiveSchedulerOptions) => Promise<SchedulerSnapshot>;
    startReview?: (options: ActiveSchedulerOptions, action: StartAction) => Promise<void>;
  } = {},
): Promise<{ considered: number; eligible: number; attempted: number; deferred: number }> {
  assertSchedulerEpoch(options);
  const collector = deps.collectSnapshot ?? collectSnapshot;
  const starter = deps.startReview ?? invokeStartReview;
  const snapshot = await collector(options);
  const plan = planReconcileActions(snapshot as never) as { actions: Array<Record<string, unknown>>; cycleState: Record<string, unknown>; capCycleState: Record<string, unknown> };
  const starts = plan.actions.filter((action): action is StartAction => action.type === 'start_review');
  const prior = readState(options);
  writeState(options, { ...prior, cycleState: plan.cycleState, capCycleState: plan.capCycleState, lastTickMs: snapshot.nowMs });

  let attempted = 0;
  let eligible = 0;
  for (const action of starts) {
    assertSchedulerEpoch(options);
    const fresh = await collector(options);
    const freshChecks = fresh.ciChecksByPr[String(action.prNumber)] ?? [];
    const recheck = preRunHeadReadyRecheck(action, {
      openPrs: fresh.openPrs,
      reviewRuns: fresh.reviewRuns,
      sessions: fresh.sessions,
      sessionDetailsById: fresh.sessionDetailsById,
      ciChecks: freshChecks,
      requiredCheckNames: fresh.requiredCheckNamesByPr[String(action.prNumber)] ?? [],
      requiredCheckLookupFailed: fresh.requiredCheckLookupFailedByPr[String(action.prNumber)] ?? false,
      cycleState: fresh.cycleState,
      repoRoot: options.repoRoot,
      nowMs: fresh.nowMs,
    } as never) as { emitReviewRun: boolean; reason: string };
    if (!recheck.emitReviewRun) continue;
    eligible += 1;
    assertSchedulerEpoch(options);
    await starter(options, action);
    attempted += 1;
  }
  return { considered: snapshot.openPrs.length, eligible, attempted, deferred: snapshot.openPrs.length - attempted };
}

export async function runActiveScheduler(options: ActiveSchedulerOptions, signal?: AbortSignal): Promise<void> {
  const poll = Math.max(1_000, options.pollIntervalMs ?? 5_000);
  while (!signal?.aborted) {
    try {
      const result = await runSchedulerTick(options);
      process.stdout.write(`${JSON.stringify({ scheduler: 'tick', epochId: options.epochId, ...result })}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, poll));
  }
}

function cliValue(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_argument:${name}`);
  return process.argv[index + 1]!;
}

function cliOptional(name: string, fallback = ''): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

async function main(): Promise<void> {
  if (!process.argv.includes('--supervised')) return;
  const options: ActiveSchedulerOptions = {
    repoRoot: resolve(cliOptional('--repo-root', process.cwd())),
    stateDir: resolve(cliOptional('--state-dir', process.env.ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR || tmpdir())),
    epochId: cliValue('--activation-epoch'),
    nonce: cliValue('--activation-nonce'),
    epochAuthorityFile: resolve(cliValue('--epoch-authority-file')),
    registryPath: resolve(cliValue('--registry-path')),
    projectId: cliOptional('--project-id', 'orchestrator-pack'),
  };
  const controller = new AbortController();
  process.on('SIGTERM', () => controller.abort());
  process.on('SIGINT', () => controller.abort());
  await runActiveScheduler(options, controller.signal);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
