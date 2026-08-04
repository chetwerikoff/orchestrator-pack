import './toolchain/native-entrypoint-preflight.ts';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReviewerBudgetSpawnEnv,
  createReviewerBudgetLedger,
  type ReviewerBudgetLedger,
} from '../plugins/ao-codex-pr-reviewer/lib/reviewer_budget.ts';
import { runProcess, type ProcessResult } from './kernel/subprocess.ts';
import {
  deriveMergeTriageEvidenceTuple,
  produceMergeTriageEvidence,
  selectMergeTriageEvidence,
  sha256Bytes,
} from './merge-triage-evidence.ts';
import {
  replayMergeForCarryover,
  validateFocusedResolutionReview,
  type CarryoverReplayResult,
} from './pack-review-carryover.ts';
import {
  PACK_REVIEW_AUTHORITY_PHASES,
  acknowledgePackReviewReset,
  commitPackReviewAuthorityTransition,
  commitPackReviewTerminal,
  commitPackReviewTriage,
  initializePackReviewAuthority,
  observePackReviewHead,
  readPackReviewAuthority,
  recordPackReviewPublication,
  selectPackReviewEvidence,
  stableJson,
  type PackReviewAuthorityDocument,
  type PackReviewAuthorityOptions,
  type PackReviewAuthorityPhase,
  type PackReviewTerminalV2,
  type PackReviewTier,
} from './pack-review-state.ts';
import {
  acquireReviewStartClaim,
  completeAfterRunInvoke,
  releaseAfterRunFailure,
  type ClaimResult,
} from './lib/review-start-claim-store.ts';
import {
  createPackReviewRun,
  getPackReviewRun,
  hasPersistedPackReviewVerdict,
  resolvePackReviewRunOrder,
  heartbeatPackReviewRun,
  isPackReviewRunStale,
  isPackReviewUnfinishedTerminalRun,
  listPackReviewRunRecordsRaw,
  listPackReviewRuns,
  packReviewLogsDir,
  packReviewWorktreesDir,
  resolvePackReviewRunStoreRoot,
  setPackReviewRunTerminal,
  terminalizePackReviewStaleRun,
  updatePackReviewRun,
  type PackReviewRunRecord,
  type PackReviewRunStatus,
} from './lib/pack-review-run-store.ts';
import {
  createGithubReviewTransport,
  requireProcess,
  reconcileGithubCommentReview,
  writeGithubReviewCapture,
  type GithubReviewTransport,
} from './lib/github-review-reconciliation.ts';
import {
  classifyPackReviewFailureReason,
  deliverPackReviewVerdict,
  packReviewDeliveryNeedsResume,
  packReviewJournaledPayload,
  packReviewRequiredStatusNeedsStaleReconciliation,
  publishPackReviewRequiredStatus,
  recordMalformedPackReviewStatus,
  recordPackReviewUnfinishedTerminalStatus,
  recordPackReviewPendingStatus,
  recordPackReviewStaleRequiredStatus,
  restorePackReviewAuthoritativeRequiredStatus,
  resumePackReviewVerdictDelivery,
  sendPackReviewWorkerNotification,
  type PackReviewJournalWriter,
  type PackReviewRequiredStatusWriter,
  type PackReviewWorkerNotifier,
} from './lib/pack-review-delivery.ts';
import {
  PACK_REVIEW_BOUND_REVIEWER_ENV,
  resolvePackReviewerFromEnv,
  type PackReviewer,
  type PackReviewerLayerOverrides,
} from './lib/resolve-pack-reviewer.ts';
import { resolveRepositorySlug } from './lib/pack-gpt-reviewer.ts';
import { loadValidatedBoundSnapshotBody } from './lib/reverify-bound-issue-snapshot.ts';
export { resolveRepositorySlug };

interface StartInput {
  projectId?: string;
  sessionId?: string;
  linkedSessionId?: string;
  prNumber?: number;
  headSha?: string;
  repoRoot?: string;
  sourceRepoRoot?: string;
  baseRef?: string;
  startReason?: string;
  surface?: string;
  storeRoot?: string;
  timeoutSeconds?: unknown;
  tier?: 'T1' | 'T2' | 'T3';
  claimMode?: 'acquire' | 'preacquired';
  onRunStarted?: (event: {
    prNumber: number;
    headSha: string;
    runId: string;
    timeoutSeconds: number;
  }) => void | Promise<void>;
  fixtureCurrentPrHeadSha?: string;
  fixturePrState?: string;
  fixtureReviewStdout?: string;
  fixtureReviewExitCode?: number;
  fixtureReviewTimedOut?: boolean;
  fixtureReviewerLayerOverrides?: PackReviewerLayerOverrides;
  fixtureEmulateWin32Selector?: boolean;
  fixturePostReviewHeadSha?: string;
  fixtureGithubReviewId?: number;
  fixtureRepoSlug?: string;
  fixtureGithubReviewTransport?: GithubReviewTransport;
  fixtureRequiredStatusWriter?: PackReviewRequiredStatusWriter;
  fixtureWorkerNotifier?: PackReviewWorkerNotifier;
  fixtureJournalWriter?: PackReviewJournalWriter;
  fixtureBeforeStaleStatusWrite?: (run: PackReviewRunRecord) => void | Promise<void>;
  fixtureCarryoverReplay?: CarryoverReplayResult;
  fixtureCarryoverSourceCleanRunId?: string;
  fixtureFocusedResolutionBundleDigest?: string;
  fixtureIssueBody?: string;
  fixtureChangedPaths?: string[];
  fixtureBoundIssueSnapshotBytes?: string;
}

export interface ReconcileStalePackReviewRunsInput {
  repoSlug: string;
  sourceRepoRoot: string;
  projectId?: string;
  storeRoot?: string;
  fixtureRequiredStatusWriter?: PackReviewRequiredStatusWriter;
  resolveRepositorySlug?: (repoRoot: string) => Promise<string>;
  beforeStaleStatusWrite?: (run: PackReviewRunRecord) => void | Promise<void>;
  fixturePauseBeforeStaleStatusWrite?: () => void | Promise<void>;
  fixturePauseAfterStaleStatusWrite?: () => void | Promise<void>;
  fixturePauseAfterPendingRestoreWrite?: () => void | Promise<void>;
}

interface ListInput {
  projectId?: string;
  storeRoot?: string;
}

interface BindingRecord {
  sessionId: string;
  prNumber: number;
  headSha?: string | null;
  repoSlug?: string;
  issueNumber?: number | null;
  superseded?: boolean;
}

interface ReviewPayloadFinding {
  title?: string;
  body?: string;
  severity?: string;
  filePath?: string;
}

interface ReviewPayload {
  verdict: 'clean' | 'findings';
  findingCount: number;
  findings: ReviewPayloadFinding[];
  bundleDigest?: string;
}

interface ClaimLease {
  acquired: boolean;
  reason: string;
  directory: string;
  release: (action: 'run_started' | 'failure', reviewRuns: PackReviewRunRecord[], detail?: string) => Promise<void>;
}

const RUNNER_RELATIVE_PATH = 'scripts/pack-review-runner.ts';
const REVIEWER_RELATIVE_PATH = 'scripts/invoke-pack-review.ps1';
const CLAIM_RELATIVE_PATH = 'scripts/lib/review-start-claim-store.ts';
const DEFAULT_PROJECT_ID = 'orchestrator-pack';
const DEFAULT_BASE_REF = 'origin/main';
const HEARTBEAT_INTERVAL_MS = 30_000;

function trim(value: unknown): string {
  return String(value ?? '').trim();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTerminalPersistenceFailure(error: unknown): boolean {
  const message = describeError(error);
  return message.includes('required-status delivery outcome was not durably persisted')
    || message.includes('pack review terminal state was not durably persisted');
}

function pathInside(candidate: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function resolveTrustedRunnerPaths(env: NodeJS.ProcessEnv = process.env): {
  trustedPackRoot: string;
  runnerPath: string;
  reviewerPath: string;
  claimPath: string;
} {
  const ownPath = resolve(fileURLToPath(import.meta.url));
  const ownRoot = resolve(dirname(ownPath), '..');
  const configured = trim(env.AO_TRUSTED_PACK_ROOT || env.OPK_TRUSTED_PACK_ROOT);
  const trustedPackRoot = configured ? resolve(configured) : ownRoot;
  const runnerPath = resolve(trustedPackRoot, RUNNER_RELATIVE_PATH);
  const reviewerPath = resolve(trustedPackRoot, REVIEWER_RELATIVE_PATH);
  const claimPath = resolve(trustedPackRoot, CLAIM_RELATIVE_PATH);

  if (resolve(runnerPath) !== ownPath) {
    throw new Error(`trusted runner mismatch: executing ${ownPath}, expected ${runnerPath}`);
  }
  for (const [label, path] of [['reviewer', reviewerPath], ['claim', claimPath]] as const) {
    if (!pathInside(path, trustedPackRoot) || !existsSync(path)) {
      throw new Error(`trusted ${label} unavailable at ${path}`);
    }
  }
  return { trustedPackRoot, runnerPath, reviewerPath, claimPath };
}

function bindingCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = trim(env.AO_PR_SESSION_BINDING_CACHE);
  if (explicit) return resolve(explicit);
  const seed = trim(env.AO_REPORT_STATE_SEED_STATE);
  if (seed) return join(dirname(resolve(seed)), 'pr-session-binding-cache.json');
  return join(homedir(), '.local', 'state', 'orchestrator-pack-wake-supervisor', 'pr-session-binding-cache.json');
}

export function resolveBindingFromCache(sessionId: string, env: NodeJS.ProcessEnv = process.env): BindingRecord {
  const target = trim(sessionId);
  if (!target) throw new Error('pack review runner requires sessionId or explicit PR/head');
  const path = bindingCachePath(env);
  if (!existsSync(path)) throw new Error(`pack review session binding cache missing at ${path}`);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`pack review session binding cache corrupt at ${path}: ${describeError(error)}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`pack review session binding cache corrupt at ${path}`);
  const records = (raw as { records?: Record<string, unknown> }).records;
  if (!records || typeof records !== 'object') throw new Error(`pack review session binding cache corrupt at ${path}: missing records`);

  const matches = new Map<string, BindingRecord>();
  for (const value of Object.values(records)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (trim(record.sessionId) !== target || record.superseded === true) continue;
    const prNumber = Number(record.prNumber);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error(`pack review session binding cache corrupt at ${path}: invalid PR for ${target}`);
    }
    const normalized: BindingRecord = {
      sessionId: target,
      prNumber,
      headSha: trim(record.headSha) || null,
      repoSlug: trim(record.repoSlug),
      issueNumber: Number(record.issueNumber) > 0 ? Number(record.issueNumber) : null,
      superseded: false,
    };
    const key = `${normalized.repoSlug ?? ''}|${normalized.prNumber}|${normalized.headSha ?? ''}`;
    matches.set(key, normalized);
  }
  if (matches.size !== 1) {
    throw new Error(matches.size === 0
      ? `pack review session binding missing for ${target}`
      : `pack review session binding ambiguous for ${target}`);
  }
  return [...matches.values()][0]!;
}

function positiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

function advancePackReviewAuthority(
  authority: PackReviewAuthorityDocument,
  nextPhase: PackReviewAuthorityPhase,
  prNumber: number,
  options: PackReviewAuthorityOptions,
): PackReviewAuthorityDocument {
  const currentIndex = PACK_REVIEW_AUTHORITY_PHASES.indexOf(authority.phase);
  const nextIndex = PACK_REVIEW_AUTHORITY_PHASES.indexOf(nextPhase);
  if (currentIndex >= nextIndex) return authority;
  return commitPackReviewAuthorityTransition({
    prNumber,
    expectedTransitionSeq: authority.transitionSeq,
    nextPhase,
    mutate: (current) => current,
    options,
  });
}

function terminalV2FromPayload(input: {
  runId: string;
  targetSha: string;
  verdict: ReviewPayload['verdict'];
  findingCount: number;
  findings: ReviewPayload['findings'];
  carryover?: { replay: CarryoverReplayResult; sourceCleanRunId: string; focusedResolutionRunId?: string };
}): PackReviewTerminalV2 {
  const carryover = input.carryover;
  const terminalSource = carryover?.replay.kind === 'merge_composite'
    ? 'merge_composite'
    : carryover?.replay.kind === 'conflict_free_carryover'
      ? 'conflict_free_carryover'
      : 'normal';
  return {
    schemaVersion: 1,
    terminalContractVersion: 2,
    terminalSource,
    runId: input.runId,
    targetSha: input.targetSha,
    reviewVerdict: input.verdict === 'clean' && input.findingCount === 0 ? 'clean' : 'findings',
    findingCount: input.findingCount,
    findingsDigest: sha256Bytes(JSON.stringify(input.findings)),
    ...(carryover ? {
      sourceCleanRunId: carryover.sourceCleanRunId,
      sourceHeadSha: carryover.replay.sourceHeadSha,
      mainSha: carryover.replay.mainSha,
      mergeBaseSha: carryover.replay.mergeBaseSha,
      replayDigest: carryover.replay.replayDigest,
      ...(carryover.replay.bundle ? {
        orderedParentShas: carryover.replay.bundle.orderedParentShas,
        bundleDigest: carryover.replay.bundle.bundleDigest,
        helperVersion: carryover.replay.bundle.helperVersion,
        focusedResolutionRunId: carryover.focusedResolutionRunId ?? input.runId,
        focusedResolutionVerdict: 'clean' as const,
      } : {}),
    } : {}),
  };
}

async function runGit(repoRoot: string, args: readonly string[], label: string): Promise<string> {
  return requireProcess(await runProcess({
    command: 'git',
    args,
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: true,
  }), label);
}

async function resolveCurrentPrHead(repoRoot: string, repoSlug: string, prNumber: number): Promise<string> {
  const result = await runProcess({
    command: 'gh',
    args: ['pr', 'view', String(prNumber), '--repo', repoSlug, '--json', 'headRefOid,state', '--jq', '.headRefOid + " " + .state'],
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: 30_000,
  });
  const output = await requireProcess(result, `gh pr view ${prNumber}`);
  const [headSha, state] = output.split(/\s+/, 2);
  if (!/^[0-9a-f]{40}$/i.test(headSha ?? '')) throw new Error(`PR #${prNumber} returned invalid head SHA`);
  if (String(state ?? '').toUpperCase() !== 'OPEN') throw new Error(`PR #${prNumber} is not open`);
  return headSha!.toLowerCase();
}

async function resolveTarget(input: StartInput, trustedPackRoot: string): Promise<{
  prNumber: number;
  headSha: string;
  sessionId: string;
  issueNumber?: number;
  repoSlug: string;
  sourceRepoRoot: string;
}> {
  const sessionId = trim(input.sessionId || input.linkedSessionId);
  const binding = input.prNumber ? undefined : resolveBindingFromCache(sessionId);
  const prNumber = positiveInteger(input.prNumber ?? binding?.prNumber, 'prNumber');
  if (!prNumber) throw new Error('pack review runner could not resolve PR number');
  const sourceRepoRoot = resolve(trim(input.sourceRepoRoot || input.repoRoot) || trustedPackRoot);
  const fixtureCurrentHead = trim(input.fixtureCurrentPrHeadSha).toLowerCase();
  const harnessExplicit = process.env.OPK_VITEST_HARNESS === '1'
    && Boolean(input.prNumber && (input.headSha || fixtureCurrentHead));
  if (!harnessExplicit && !existsSync(join(sourceRepoRoot, '.git')) && !existsSync(join(sourceRepoRoot, 'HEAD'))) {
    throw new Error(`source repository root is not a git checkout: ${sourceRepoRoot}`);
  }
  const requestedHead = trim(input.headSha || binding?.headSha).toLowerCase();
  const repoSlug = harnessExplicit
    ? trim(input.fixtureRepoSlug) || trim(binding?.repoSlug) || 'fixture/orchestrator-pack'
    : trim(binding?.repoSlug) || await resolveRepositorySlug(sourceRepoRoot);
  if (harnessExplicit && trim(input.fixturePrState || 'OPEN').toUpperCase() !== 'OPEN') {
    throw new Error(`PR #${prNumber} is not open`);
  }
  const liveHead = harnessExplicit
    ? fixtureCurrentHead || requestedHead
    : await resolveCurrentPrHead(sourceRepoRoot, repoSlug, prNumber);
  if (!/^[0-9a-f]{40}$/.test(liveHead)) throw new Error(`review target head is not a full SHA for PR #${prNumber}`);
  if (requestedHead && requestedHead !== liveHead) {
    throw new Error(`review target head changed for PR #${prNumber}: requested ${requestedHead}, live ${liveHead}`);
  }
  return {
    prNumber,
    headSha: liveHead,
    sessionId,
    issueNumber: binding?.issueNumber ? Number(binding.issueNumber) : undefined,
    repoSlug,
    sourceRepoRoot,
  };
}

function parseReviewPayload(stdout: string): ReviewPayload {
  const candidates = stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
  for (const candidate of [stdout.trim(), ...candidates]) {
    try {
      const parsed = JSON.parse(candidate) as Partial<ReviewPayload>;
      if ((parsed.verdict === 'clean' || parsed.verdict === 'findings')
        && Number.isInteger(parsed.findingCount)
        && Array.isArray(parsed.findings)) {
        if (parsed.findingCount !== parsed.findings.length) throw new Error('findingCount does not match findings length');
        return parsed as ReviewPayload;
      }
    } catch {
      // Continue to the next candidate; final error is stable below.
    }
  }
  throw new Error('reviewer produced no valid terminal verdict payload');
}

export async function assertBoundHeadStillCurrent(options: {
  repoRoot: string;
  repoSlug: string;
  prNumber: number;
  boundHeadSha: string;
  fixturePostReviewHeadSha?: string;
}): Promise<void> {
  const current = options.fixturePostReviewHeadSha
    ?? await resolveCurrentPrHead(options.repoRoot, options.repoSlug, options.prNumber);
  if (current.toLowerCase() !== options.boundHeadSha.toLowerCase()) {
    throw new Error(
      `review target head changed after reviewer returned: bound ${options.boundHeadSha}, current ${current}`,
    );
  }
}

function asReviewPayloadFinding(value: unknown): ReviewPayloadFinding | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as ReviewPayloadFinding
    : null;
}

function selectGithubReviewEvent(_payload: ReviewPayload): 'COMMENT' {
  return 'COMMENT';
}

function formatGithubReviewBody(run: PackReviewRunRecord, payload: ReviewPayload): string {
  const lines = [
    `## Pack review — ${payload.verdict === 'clean' && payload.findingCount === 0 ? 'no findings' : 'findings'}`,
    '',
    `Run: \`${run.id}\``,
    `Head: \`${run.targetSha}\``,
    '',
  ];
  if (payload.findings.length === 0) {
    lines.push('No findings.', '');
  } else {
    payload.findings.forEach((value, index) => {
      const finding = asReviewPayloadFinding(value);
      if (!finding) {
        lines.push(`### Malformed finding payload at index ${index + 1}`, '');
        lines.push('The reviewer emitted a non-object finding; it was treated as blocking.', '');
        return;
      }
      lines.push(`### ${finding.title || `Finding ${index + 1}`}`, '');
      if (finding.body) lines.push(finding.body, '');
      if (finding.filePath) lines.push(`Path: \`${finding.filePath}\``, '');
    });
  }
  lines.push('---', '_Automated review by orchestrator-pack pack-owned runner_');
  return lines.join('\n');
}

async function postGithubReview(options: {
  repoRoot: string;
  repoSlug: string;
  prNumber: number;
  headSha: string;
  run: PackReviewRunRecord;
  payload: ReviewPayload;
  projectId: string;
  storeRoot: string;
  transport: GithubReviewTransport;
}): Promise<{
  id: number | string;
  url: string;
  event: 'COMMENT';
  dismissedReviewIds: Array<number | string>;
}> {
  const event = selectGithubReviewEvent(options.payload);
  const body = formatGithubReviewBody(options.run, options.payload);
  const reconciled = await reconcileGithubCommentReview({
    run: options.run,
    body,
    transport: options.transport,
    projectId: options.projectId,
    storeRoot: options.storeRoot,
  });
  writeGithubReviewCapture({
    repoSlug: options.repoSlug,
    prNumber: options.prNumber,
    commitId: options.headSha,
    event,
    body,
    dismissedReviewIds: reconciled.dismissedReviewIds,
    transport: options.transport,
  });
  return {
    id: reconciled.id,
    url: reconciled.url,
    event,
    dismissedReviewIds: reconciled.dismissedReviewIds,
  };
}

async function ensureCommitAvailable(repoRoot: string, headSha: string): Promise<void> {
  const probe = await runProcess({
    command: 'git',
    args: ['cat-file', '-e', `${headSha}^{commit}`],
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: true,
  });
  if (probe.ok) return;
  await runGit(repoRoot, ['fetch', '--no-tags', 'origin', headSha], `git fetch ${headSha}`);
  await runGit(repoRoot, ['cat-file', '-e', `${headSha}^{commit}`], `git cat-file ${headSha}`);
}

async function createReviewWorktree(repoRoot: string, storeRoot: string, runId: string, headSha: string): Promise<string> {
  const root = packReviewWorktreesDir(storeRoot);
  mkdirSync(root, { recursive: true });
  const target = join(root, runId);
  rmSync(target, { recursive: true, force: true });
  await ensureCommitAvailable(repoRoot, headSha);
  await runGit(repoRoot, ['worktree', 'add', '--detach', target, headSha], 'git worktree add');
  return target;
}

async function removeReviewWorktree(repoRoot: string, target: string): Promise<void> {
  if (!target) return;
  const result = await runProcess({
    command: 'git',
    args: ['worktree', 'remove', '--force', target],
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: true,
  });
  if (!result.ok) rmSync(target, { recursive: true, force: true });
}

function writeRunLogs(storeRoot: string, runId: string, stdout: string, stderr: string): void {
  const dir = packReviewLogsDir(storeRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.stdout.log`), stdout, 'utf8');
  writeFileSync(join(dir, `${runId}.stderr.log`), stderr, 'utf8');
}

async function acquireClaimLease(options: {
  trustedPackRoot: string;
  claimPath: string;
  projectId: string;
  storeRoot: string;
  prNumber: number;
  headSha: string;
  surface: string;
  startReason: string;
  resumeRunId?: string;
}): Promise<ClaimLease> {
  void options.trustedPackRoot;
  void options.claimPath;
  const visibleRuns = listPackReviewRuns({ projectId: options.projectId, storeRoot: options.storeRoot });
  const claimRuns = options.resumeRunId
    ? visibleRuns.map((candidate) => candidate.id === options.resumeRunId
      ? {
          ...candidate,
          status: 'failed' as const,
          latestRunStatus: 'failed' as const,
          failureReason: 'journaled_delivery_resume_candidate',
        }
      : candidate)
    : visibleRuns;
  const claim = acquireReviewStartClaim({
    prNumber: options.prNumber,
    headSha: options.headSha,
    surface: options.surface,
    reviewRuns: claimRuns,
    projectId: options.projectId,
    startReason: options.startReason,
  });
  if (!claim.acquired) {
    return {
      acquired: false,
      reason: trim(claim.reason) || 'claimed',
      directory: '',
      release: async () => undefined,
    };
  }
  return {
    acquired: true,
    reason: 'acquired',
    directory: '',
    release: async (action, reviewRuns, detail = '') => {
      const completion = action === 'run_started'
        ? completeAfterRunInvoke(claim as ClaimResult, reviewRuns)
        : releaseAfterRunFailure(claim as ClaimResult, reviewRuns, detail);
      if (completion.ok !== true) {
        throw new Error(`review claim completion failed: ${trim(completion.reason) || 'unknown'}`);
      }
    },
  };
}

function findJournaledDeliveryResumeCandidate(options: {
  projectId: string;
  storeRoot: string;
  prNumber: number;
  headSha: string;
}): PackReviewRunRecord | null {
  const candidates = listPackReviewRuns({ projectId: options.projectId, storeRoot: options.storeRoot })
    .filter((candidate) => candidate.prNumber === options.prNumber
      && candidate.targetSha === options.headSha
      && packReviewDeliveryNeedsResume(candidate));
  if (candidates.length > 1) {
    throw new Error(`ambiguous journaled pack review deliveries for PR #${options.prNumber} head ${options.headSha}`);
  }
  return candidates[0] ?? null;
}

async function invokeReviewer(options: {
  reviewerPath: string;
  trustedPackRoot: string;
  reviewTargetRoot: string;
  baseRef: string;
  prNumber: number;
  issueNumber?: number;
  sessionId: string;
  budgetLedger: ReviewerBudgetLedger;
  runId: string;
  projectId: string;
  storeRoot: string;
  fixtureReviewStdout?: string;
  fixtureReviewExitCode?: number;
  fixtureReviewTimedOut?: boolean;
  headSha: string;
  fixtureReviewerLayerOverrides?: PackReviewerLayerOverrides;
  fixtureEmulateWin32Selector?: boolean;
  carryoverBundlePath?: string;
}): Promise<{ result: ProcessResult; resolvedReviewer: PackReviewer | null }> {
  const resolvedReviewer = resolvePackReviewerFromEnv(process.env, {
    layerOverrides: options.fixtureReviewerLayerOverrides,
    emulateWin32: options.fixtureEmulateWin32Selector,
  });
  const reviewerArgs = [
    '-NoProfile',
    '-File', options.reviewerPath,
    '--repo-root', options.reviewTargetRoot,
    '--base', options.baseRef,
    '--pr-number', String(options.prNumber),
  ];
  if (options.issueNumber) reviewerArgs.push('--issue', String(options.issueNumber));

  const invocationLog = trim(process.env.PACK_REVIEW_RUNNER_INVOCATION_LOG);
  if (process.env.OPK_VITEST_HARNESS === '1' && invocationLog) {
    appendFileSync(invocationLog, `${JSON.stringify({
      reviewer: resolvedReviewer,
      command: 'pwsh',
      args: reviewerArgs,
    })}\n`);
  }

  const engagementFile = trim(process.env.PACK_REVIEW_RUNNER_GPT_ENGAGEMENT_FILE);
  if (process.env.OPK_VITEST_HARNESS === '1' && engagementFile && resolvedReviewer === 'gpt') {
    appendFileSync(engagementFile, `${JSON.stringify({ runId: options.runId, prNumber: options.prNumber, headSha: options.headSha })}\n`);
  }

  if (process.env.OPK_VITEST_HARNESS === '1' && options.fixtureReviewTimedOut) {
    return {
      resolvedReviewer,
      result: { outcome: 'timeout', ok: false, exitCode: null, signal: null, stdout: '', stderr: '', timedOut: true, cancelled: false },
    };
  }

  if (process.env.OPK_VITEST_HARNESS === '1' && options.fixtureReviewStdout !== undefined) {
    const exitCode = options.fixtureReviewExitCode ?? 0;
    return {
      resolvedReviewer,
      result: {
        outcome: 'exit',
        ok: exitCode === 0,
        exitCode,
        signal: null,
        stdout: options.fixtureReviewStdout,
        stderr: '',
        timedOut: false,
        cancelled: false,
      },
    };
  }

  const args = reviewerArgs;
  const env: NodeJS.ProcessEnv = {
    ...buildReviewerBudgetSpawnEnv(options.budgetLedger, {}),
    AO_PR_NUMBER: String(options.prNumber),
    GITHUB_PR_NUMBER: String(options.prNumber),
    AO_REVIEW_RUN_ID: options.runId,
    PACK_REVIEW_RUN_ID: options.runId,
    PACK_REVIEW_TARGET_HEAD_SHA: options.headSha,
  };
  if (resolvedReviewer) {
    env.PACK_REVIEWER = resolvedReviewer;
    env[PACK_REVIEW_BOUND_REVIEWER_ENV] = resolvedReviewer;
  }
  if (options.sessionId) {
    env.AO_SESSION_ID = options.sessionId;
    env.AO_WORKER_SESSION_ID = options.sessionId;
  }
  if (options.carryoverBundlePath) {
    env.PACK_REVIEW_CARRYOVER_BUNDLE_PATH = options.carryoverBundlePath;
  } else {
    delete env.PACK_REVIEW_CARRYOVER_BUNDLE_PATH;
  }

  const result = await runProcess({
    command: 'pwsh',
    args,
    cwd: options.trustedPackRoot,
    inheritParentEnv: true,
    env,
    allowEmptyStdout: true,
    timeoutMs: options.budgetLedger.runnerTimeoutMs,
    onSpawn: (pid) => {
      updatePackReviewRun(options.runId, {
        runnerPid: process.pid,
        status: 'running',
        latestRunStatus: 'running',
        reviewTargetRoot: options.reviewTargetRoot,
      }, { projectId: options.projectId, storeRoot: options.storeRoot });
      void pid;
    },
  });
  return { result, resolvedReviewer };
}

async function resolvePackReviewRunCanonicalRepository(
  run: PackReviewRunRecord,
  resolveSlug: (repoRoot: string) => Promise<string>,
): Promise<{ ok: true; slug: string } | { ok: false; reason: string }> {
  if (trim(run.canonicalRepository)) {
    return { ok: true, slug: trim(run.canonicalRepository) };
  }
  if (!trim(run.sourceRepoRoot)) {
    return { ok: false, reason: 'legacy_repository_unresolved' };
  }
  try {
    const slug = await resolveSlug(run.sourceRepoRoot);
    if (!/^[^/\s]+\/[^/\s]+$/.test(slug)) {
      return { ok: false, reason: 'legacy_repository_ambiguous' };
    }
    return { ok: true, slug };
  } catch {
    return { ok: false, reason: 'legacy_repository_unresolved' };
  }
}

export async function reconcileStalePackReviewRuns(
  input: ReconcileStalePackReviewRunsInput,
): Promise<{ ok: true; results: Array<Record<string, unknown>> }> {
  const projectId = trim(input.projectId) || DEFAULT_PROJECT_ID;
  const storeRoot = resolvePackReviewRunStoreRoot({ projectId, storeRoot: input.storeRoot });
  const repoSlug = trim(input.repoSlug);
  if (!repoSlug) throw new Error('pack review stale reconciliation requires a canonical repository slug');
  const resolveSlug = input.resolveRepositorySlug ?? resolveRepositorySlug;
  const records = listPackReviewRunRecordsRaw({ projectId, storeRoot });
  const results: Array<Record<string, unknown>> = [];

  for (const candidate of records) {
    const activeStale = isPackReviewRunStale(candidate);
    const unfinishedTerminal = isPackReviewUnfinishedTerminalRun(candidate);
    if (!activeStale && !unfinishedTerminal) continue;

    const identity = await resolvePackReviewRunCanonicalRepository(candidate, resolveSlug);
    if (!identity.ok || identity.slug !== repoSlug) {
      results.push({
        runId: candidate.id,
        terminalized: false,
        statusReconciled: false,
        reason: identity.ok ? 'repository_mismatch' : identity.reason,
      });
      continue;
    }

    const initialOrder = resolvePackReviewRunOrder(records, candidate);
    if (initialOrder.kind === 'ambiguous') {
      results.push({
        runId: candidate.id,
        terminalized: false,
        statusReconciled: false,
        reason: initialOrder.reason,
      });
      continue;
    }

    let terminalized = false;
    let run = candidate;
    const statusWriter = input.fixtureRequiredStatusWriter
      ?? ((request) => publishPackReviewRequiredStatus({
        repoRoot: input.sourceRepoRoot,
        repoSlug,
        headSha: run.targetSha,
        request,
      }));
    if (activeStale) {
      const terminal = terminalizePackReviewStaleRun(run.id, { projectId, storeRoot });
      terminalized = terminal.changed;
      run = getPackReviewRun(run.id, { projectId, storeRoot }) ?? terminal.run;
    }

    if (!isPackReviewUnfinishedTerminalRun(run)) continue;

    const currentOrder = resolvePackReviewRunOrder(records, run);
    if (currentOrder.kind === 'ambiguous') {
      results.push({
        runId: run.id,
        terminalized,
        statusReconciled: false,
        reason: currentOrder.reason,
      });
      continue;
    }
    if (currentOrder.kind === 'newer') {
      await restorePackReviewAuthoritativeRequiredStatus({
        run: currentOrder.run,
        projectId,
        storeRoot,
        writeRequiredStatus: statusWriter,
        pauseAfterPendingWrite: input.fixturePauseAfterPendingRestoreWrite,
      });
      results.push({
        runId: run.id,
        terminalized,
        statusReconciled: true,
        reason: 'newer_run_authoritative',
      });
      continue;
    }

    if (!packReviewRequiredStatusNeedsStaleReconciliation(run)) {
      results.push({
        runId: run.id,
        terminalized,
        statusReconciled: false,
        reason: 'status_already_reconciled',
      });
      continue;
    }

    const beforeWrite = input.beforeStaleStatusWrite;
    if (beforeWrite) await beforeWrite(run);

    const recordsBeforeStaleStatusWrite = listPackReviewRunRecordsRaw({ projectId, storeRoot });
    const orderBeforeStaleStatusWrite = resolvePackReviewRunOrder(recordsBeforeStaleStatusWrite, run);
    if (orderBeforeStaleStatusWrite.kind === 'ambiguous') {
      results.push({
        runId: run.id,
        terminalized,
        statusReconciled: false,
        reason: orderBeforeStaleStatusWrite.reason,
      });
      continue;
    }
    if (orderBeforeStaleStatusWrite.kind === 'newer') {
      await restorePackReviewAuthoritativeRequiredStatus({
        run: orderBeforeStaleStatusWrite.run,
        projectId,
        storeRoot,
        writeRequiredStatus: statusWriter,
        pauseAfterPendingWrite: input.fixturePauseAfterPendingRestoreWrite,
      });
      results.push({
        runId: run.id,
        terminalized,
        statusReconciled: true,
        reason: 'newer_run_authoritative',
      });
      continue;
    }

    const authorizeStaleWrite = () => {
      const order = resolvePackReviewRunOrder(listPackReviewRunRecordsRaw({ projectId, storeRoot }), run);
      return order.kind === 'none';
    };
    const repairSupersededStaleWrite = async () => {
      const order = resolvePackReviewRunOrder(listPackReviewRunRecordsRaw({ projectId, storeRoot }), run);
      if (order.kind !== 'newer') return;
      await restorePackReviewAuthoritativeRequiredStatus({
        run: order.run,
        projectId,
        storeRoot,
        writeRequiredStatus: statusWriter,
        pauseAfterPendingWrite: input.fixturePauseAfterPendingRestoreWrite,
      });
    };

    const outcome = await recordPackReviewStaleRequiredStatus({
      run,
      projectId,
      storeRoot,
      writeRequiredStatus: statusWriter,
      authorizeWrite: authorizeStaleWrite,
      repairSupersededWrite: repairSupersededStaleWrite,
      pauseBeforeWrite: input.fixturePauseBeforeStaleStatusWrite,
      pauseAfterWrite: input.fixturePauseAfterStaleStatusWrite,
    });

    results.push({
      runId: run.id,
      terminalized,
      statusReconciled: outcome.state === 'succeeded',
      reason: outcome.reason,
    });
  }

  return { ok: true, results };
}

function legacyCapStatePath(projectId: string): string {
  const root = trim(process.env.ORCHESTRATOR_PACK_REVIEW_CYCLE_CAP_STATE)
    || join(homedir(), '.local', 'state', 'orchestrator-pack-review-cycle-cap');
  return join(root, `${projectId}.json`);
}

function readRetainedLegacyOpenCycle(projectId: string, prNumber: number): unknown | undefined {
  const path = legacyCapStatePath(projectId);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`legacy cap state corrupt at ${path}: ${describeError(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`legacy cap state corrupt at ${path}: expected object`);
  }
  const state = (parsed as Record<string, unknown>)[String(prNumber)];
  if (!state || typeof state !== 'object' || Array.isArray(state)) return undefined;
  const row = state as Record<string, unknown>;
  if (!trim(row.cycleOpenedAtUtc)) return undefined;
  const consumed = Array.isArray(row.distinctHeadsReviewed) ? row.distinctHeadsReviewed : [];
  const frozenTier = String(row.tier ?? '').toUpperCase() as PackReviewTier;
  const frozenCap = Number(row.cap);
  const cycleId = trim(row.cycleId) || `legacy-${prNumber}-${sha256Bytes(stableJson({
    cycleOpenedAtUtc: row.cycleOpenedAtUtc,
    tier: frozenTier,
    cap: frozenCap,
    consumed,
  })).slice(0, 16)}`;
  const atCap = row.terminal === 'at_cap_open_findings'
    || (Number.isInteger(frozenCap) && consumed.length >= frozenCap && Boolean(row.atCapRecord));
  return {
    cycleId,
    state: atCap ? 'at_cap_open_findings' : 'open',
    frozenTier,
    frozenCap,
    openedAtUtc: String(row.cycleOpenedAtUtc),
    consumedHeadShas: consumed,
    ...(atCap ? {
      atCapHash: sha256Bytes(stableJson({ cycleId, frozenCap, consumedHeadShas: consumed })),
    } : {}),
  };
}

async function resolveCarryoverReplay(input: {
  input: StartInput;
  target: { prNumber: number; headSha: string; sourceRepoRoot: string };
  projectId: string;
  storeRoot: string;
  baseRef: string;
  priorAuthority?: PackReviewAuthorityDocument;
}): Promise<{ replay: CarryoverReplayResult; sourceCleanRunId: string } | null> {
  if (input.input.fixtureCarryoverReplay) {
    return {
      replay: input.input.fixtureCarryoverReplay,
      sourceCleanRunId: input.input.fixtureCarryoverSourceCleanRunId || 'fixture-source-clean',
    };
  }
  if (process.env.OPK_VITEST_HARNESS === '1') return null;

  try {
    const parents = (await runGit(input.target.sourceRepoRoot, ['rev-list', '--parents', '-n', '1', input.target.headSha], 'merge parents'))
      .split(/\s+/).slice(1);
    if (parents.length !== 2) return null;
    const sourceHeadSha = parents[0]!;
    const configuredBaseSha = await runGit(
      input.target.sourceRepoRoot,
      ['rev-parse', `${input.baseRef}^{commit}`],
      'configured review base',
    );
    // A merge's second parent is usable only when it is exactly the configured base.
    if (parents[1]!.toLowerCase() !== configuredBaseSha.toLowerCase()) return null;

    const priorTerminal = input.priorAuthority?.terminal;
    const authorityAuthorizesSource = priorTerminal?.targetSha.toLowerCase() === sourceHeadSha.toLowerCase()
      && input.priorAuthority?.currentHeadSha.toLowerCase() === sourceHeadSha.toLowerCase()
      && priorTerminal.reviewVerdict === 'clean';
    if (!authorityAuthorizesSource) return null;

    const sourceRun = listPackReviewRuns({ projectId: input.projectId, storeRoot: input.storeRoot })
      .find((candidate) => candidate.id === priorTerminal.runId
        && candidate.prNumber === input.target.prNumber
        && candidate.targetSha === sourceHeadSha
        && candidate.reviewVerdict === 'clean'
        && candidate.findingCount === 0);
    if (!sourceRun) return null;

    let replay: CarryoverReplayResult;
    try {
      replay = replayMergeForCarryover({
        repoRoot: input.target.sourceRepoRoot,
        sourceHeadSha,
        mainSha: configuredBaseSha,
        targetHeadSha: input.target.headSha,
      });
    } catch {
      // Replay rejection is a carry-over rejection, not a failed full-head review.
      return null;
    }
    return { replay, sourceCleanRunId: sourceRun.id };
  } catch {
    // Missing git/base/authority evidence must fall back to ordinary review.
    return null;
  }
}

async function commitAtCapTriage(input: {
  start: StartInput;
  target: { prNumber: number; headSha: string; repoSlug: string; sourceRepoRoot: string; issueNumber?: number };
  projectId: string;
  baseRef: string;
  trustedPackRoot: string;
  storeRoot: string;
  authority: PackReviewAuthorityDocument;
  payload: ReviewPayload;
}): Promise<PackReviewAuthorityDocument> {
  const cycle = input.authority.cycle;
  if (!cycle || !['at_cap_open_findings', 'at_cap_continuation_required'].includes(cycle.state)) {
    return input.authority;
  }
  const findingSnapshotDigest = sha256Bytes(stableJson(input.payload.findings));
  let tuple: ReturnType<typeof deriveMergeTriageEvidenceTuple> | null = null;
  let selection: ReturnType<typeof selectMergeTriageEvidence> = {
    kind: 'missing',
    verdict: 'PENDING_OPERATOR',
    reason: 'evidence_unavailable',
  };
  try {
    let issueBody = input.start.fixtureIssueBody;
    let boundIssueSnapshotBytes = input.start.fixtureBoundIssueSnapshotBytes;
    if (issueBody === undefined) {
      const snapshotPath = trim(process.env.OPK_BOUND_ISSUE_SNAPSHOT_PATH);
      if (!snapshotPath || !existsSync(snapshotPath) || !input.target.issueNumber) {
        throw new Error('bound issue snapshot unavailable');
      }
      const snapshot = loadValidatedBoundSnapshotBody({
        projectId: input.projectId,
        prNumber: input.target.prNumber,
        prHeadSha: input.target.headSha,
        issueNumber: input.target.issueNumber,
        snapshotFilePath: snapshotPath,
        storeDirOverride: process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR,
      });
      issueBody = snapshot.body;
      boundIssueSnapshotBytes = snapshot.body;
    }
    if (boundIssueSnapshotBytes === undefined) boundIssueSnapshotBytes = issueBody;
    if (issueBody === undefined || boundIssueSnapshotBytes === undefined) throw new Error('bound issue snapshot unavailable');
    const changedPaths = input.start.fixtureChangedPaths ?? (await runGit(
      input.target.sourceRepoRoot,
      ['diff', '--name-only', `${input.baseRef}...${input.target.headSha}`],
      'changed path capture',
    )).split(/\r?\n/).map((path) => path.trim()).filter(Boolean);
    tuple = deriveMergeTriageEvidenceTuple({
      repository: input.target.repoSlug,
      prNumber: input.target.prNumber,
      cycleId: cycle.cycleId,
      currentHeadSha: input.authority.currentHeadSha,
      atCapHash: cycle.atCapHash!,
      producerExecutableBytes: readFileSync(join(input.trustedPackRoot, 'scripts', 'merge-triage-evidence.ts')),
      boundIssueSnapshotBytes,
      changedPathCaptureBytes: changedPaths.join('\n'),
      input: { baseRef: input.baseRef, issueNumber: input.target.issueNumber ?? null },
    });
    produceMergeTriageEvidence({
      tuple,
      changedPaths,
      issueBody,
      options: { storeRoot: input.storeRoot },
    });
    selection = selectMergeTriageEvidence({ tuple, options: { storeRoot: input.storeRoot } });
  } catch {
    // Missing or malformed trusted inputs remain an audited pending-operator result.
  }

  if (selection.evidence && tuple) {
    selectPackReviewEvidence({
      prNumber: input.target.prNumber,
      expectedTransitionSeq: input.authority.transitionSeq,
      expectedEvidenceKey: selection.evidence.expectedEvidenceKey,
      selectedEvidenceId: selection.evidence.evidenceId,
      selectedEvidenceDigest: selection.evidenceDigest!,
      options: { storeRoot: input.storeRoot },
    });
    input.authority = readPackReviewAuthority(input.target.prNumber, { storeRoot: input.storeRoot })!;
  }
  const current = readPackReviewAuthority(input.target.prNumber, { storeRoot: input.storeRoot })!;
  return commitPackReviewTriage({
    prNumber: input.target.prNumber,
    expectedTransitionSeq: current.transitionSeq,
    triage: {
      verdict: selection.verdict,
      source: 'automatic',
      findingSnapshotDigest,
      committedAtUtc: new Date().toISOString(),
    },
    options: { storeRoot: input.storeRoot },
  });
}

export async function startPackReview(input: StartInput): Promise<Record<string, unknown>> {
  const fixtureShortTimeout = process.env.OPK_VITEST_HARNESS === '1'
    && (input.fixtureReviewStdout !== undefined || input.fixtureReviewTimedOut === true);
  const budgetLedger = createReviewerBudgetLedger(
    process.env,
    Date.now(),
    input.timeoutSeconds,
    { allowShortTimeout: fixtureShortTimeout },
  );
  const timeoutSeconds = budgetLedger.runnerTimeoutSeconds;
  const trusted = resolveTrustedRunnerPaths();
  const projectId = trim(input.projectId) || DEFAULT_PROJECT_ID;
  const baseRef = trim(input.baseRef) || DEFAULT_BASE_REF;
  const target = await resolveTarget(input, trusted.trustedPackRoot);
  const storeRoot = resolvePackReviewRunStoreRoot({ projectId, storeRoot: input.storeRoot });
  const authorityOptions: PackReviewAuthorityOptions = { storeRoot };
  const retainedOpenCycle = readRetainedLegacyOpenCycle(projectId, target.prNumber);
  let authority = initializePackReviewAuthority({
    prNumber: target.prNumber,
    headSha: target.headSha,
    tier: input.tier ?? 'T3',
    retainedOpenCycle,
    options: authorityOptions,
  });
  // Preserve the H0 authority record before observing H1; carry-over may use only
  // this exact authoritative terminal, never an older clean run selected by history.
  const priorAuthority = authority.currentHeadSha === target.headSha ? undefined : authority;
  if (authority.currentHeadSha !== target.headSha) {
    authority = observePackReviewHead({
      prNumber: target.prNumber,
      expectedTransitionSeq: authority.transitionSeq,
      headSha: target.headSha,
      options: authorityOptions,
    });
  }
  if (authority.cycle
      && ['at_cap_open_findings', 'at_cap_continuation_required'].includes(authority.cycle.state)) {
    return {
      ok: false,
      created: false,
      reused: false,
      reason: 'at_cap_continuation_required',
      prNumber: target.prNumber,
      headSha: target.headSha,
      cycleId: authority.cycle.cycleId,
      httpStatus: 409,
    };
  }
  await reconcileStalePackReviewRuns({
    repoSlug: target.repoSlug,
    sourceRepoRoot: target.sourceRepoRoot,
    projectId,
    storeRoot,
    beforeStaleStatusWrite: input.fixtureBeforeStaleStatusWrite,
  });
  const claimMode = input.claimMode ?? 'acquire';
  const resumeCandidate = findJournaledDeliveryResumeCandidate({
    projectId,
    storeRoot,
    prNumber: target.prNumber,
    headSha: target.headSha,
  });
  const githubReviewTransport = createGithubReviewTransport({
    repoRoot: target.sourceRepoRoot,
    repoSlug: target.repoSlug,
    prNumber: target.prNumber,
    fixtureReviewId: input.fixtureGithubReviewId,
    fixtureTransport: input.fixtureGithubReviewTransport,
  });
  let claimLease: ClaimLease | null = null;
  let run: PackReviewRunRecord | null = null;
  let worktree = '';
  let terminal = false;
  let retainClaimDirectory = false;
  let carryover: { replay: CarryoverReplayResult; sourceCleanRunId: string } | null = null;
  let carryoverBundlePath = '';

  if (claimMode === 'acquire') {
    claimLease = await acquireClaimLease({
      trustedPackRoot: trusted.trustedPackRoot,
      claimPath: trusted.claimPath,
      projectId,
      storeRoot,
      prNumber: target.prNumber,
      headSha: target.headSha,
      surface: trim(input.surface) || 'pack-review-runner-manual',
      startReason: trim(input.startReason) || 'manual',
      resumeRunId: resumeCandidate?.id,
    });
    if (!claimLease.acquired) {
      return {
        ok: false,
        created: false,
        reused: true,
        reason: claimLease.reason,
        prNumber: target.prNumber,
        headSha: target.headSha,
        httpStatus: 200,
      };
    }
  }

  authority = advancePackReviewAuthority(
    authority,
    'claim_acquired',
    target.prNumber,
    authorityOptions,
  );

  try {
    if (resumeCandidate) {
      const resumePayload = packReviewJournaledPayload(resumeCandidate);
      if (!resumePayload) {
        throw new Error(`pack review run ${resumeCandidate.id} lost its persisted verdict before recovery`);
      }
      const typedResumePayload = resumePayload as ReviewPayload;
      if (!authority.terminal) {
        if (!(process.env.OPK_VITEST_HARNESS === '1' && input.fixturePostReviewHeadSha === undefined)) {
          await assertBoundHeadStillCurrent({
            repoRoot: target.sourceRepoRoot,
            repoSlug: target.repoSlug,
            prNumber: target.prNumber,
            boundHeadSha: target.headSha,
            fixturePostReviewHeadSha: input.fixturePostReviewHeadSha,
          });
        }
        authority = advancePackReviewAuthority(
          authority,
          'review_or_bundle_staged',
          target.prNumber,
          authorityOptions,
        );
        authority = commitPackReviewTerminal({
          prNumber: target.prNumber,
          expectedTransitionSeq: authority.transitionSeq,
          terminal: terminalV2FromPayload({
            runId: resumeCandidate.id,
            targetSha: target.headSha,
            verdict: typedResumePayload.verdict,
            findingCount: typedResumePayload.findingCount,
            findings: typedResumePayload.findings,
          }),
          status: typedResumePayload.verdict === 'clean' && typedResumePayload.findingCount === 0 ? 'clean' : 'changes_requested',
          findingCount: typedResumePayload.findingCount,
          options: authorityOptions,
        });
        authority = await commitAtCapTriage({
          start: input,
          target,
          projectId,
          baseRef,
          trustedPackRoot: trusted.trustedPackRoot,
          storeRoot,
          authority,
          payload: typedResumePayload,
        });
      }
      if (!(process.env.OPK_VITEST_HARNESS === '1' && input.fixturePostReviewHeadSha === undefined)) {
        await assertBoundHeadStillCurrent({
          repoRoot: target.sourceRepoRoot,
          repoSlug: target.repoSlug,
          prNumber: target.prNumber,
          boundHeadSha: target.headSha,
          fixturePostReviewHeadSha: input.fixturePostReviewHeadSha,
        });
      }
      const resumed = await resumePackReviewVerdictDelivery({
        run: resumeCandidate,
        projectId,
        storeRoot,
        postGithubComment: async () => {
          const posted = await postGithubReview({
            repoRoot: target.sourceRepoRoot,
            repoSlug: target.repoSlug,
            prNumber: target.prNumber,
            headSha: target.headSha,
            run: resumeCandidate,
            payload: resumePayload as ReviewPayload,
            projectId,
            storeRoot,
            transport: githubReviewTransport,
          });
          return { id: posted.id, url: posted.url, event: 'COMMENT' };
        },
        writeRequiredStatus: input.fixtureRequiredStatusWriter ?? ((request) => publishPackReviewRequiredStatus({
          repoRoot: target.sourceRepoRoot,
          repoSlug: target.repoSlug,
          headSha: target.headSha,
          request,
        })),
        notifyWorker: input.fixtureWorkerNotifier ?? ((request) => sendPackReviewWorkerNotification({
          trustedPackRoot: trusted.trustedPackRoot,
          sessionId: target.sessionId || resumeCandidate.linkedSessionId,
          request,
        })),
      });
      const resumedAuthority = readPackReviewAuthority(target.prNumber, authorityOptions);
      if (!resumedAuthority || resumedAuthority.terminal?.runId !== resumeCandidate.id) {
        throw new Error('pack review authority changed before resumed publication');
      }
      const resumedPublicationStatus = resumed.reason === 'completed' ? 'succeeded' : 'failed';
      recordPackReviewPublication({
        prNumber: target.prNumber,
        expectedTransitionSeq: resumedAuthority.transitionSeq,
        nextPhase: resumedPublicationStatus === 'succeeded' ? 'external_published' : resumedAuthority.phase,
        publication: {
          headSha: target.headSha,
          terminalRunId: resumeCandidate.id,
          status: resumedPublicationStatus,
          publicationDigest: sha256Bytes(JSON.stringify({ status: resumed.status, deliveryReason: resumed.reason })),
          recordedAtUtc: new Date().toISOString(),
        },
        options: authorityOptions,
      });
      terminal = true;
      const runs = listPackReviewRuns({ projectId, storeRoot });
      if (claimLease) await claimLease.release('run_started', runs);
      return {
        ok: true,
        created: false,
        reused: true,
        recovered: true,
        reason: 'resumed_journaled_delivery',
        deliveryReason: resumed.reason,
        prNumber: target.prNumber,
        headSha: target.headSha,
        runId: resumeCandidate.id,
        status: resumed.status,
        httpStatus: 200,
        ...(resumed.githubReviewId !== undefined ? { githubReviewId: resumed.githubReviewId } : {}),
        ...(resumed.githubReviewUrl ? { githubReviewUrl: resumed.githubReviewUrl } : {}),
      };
    }

    const created = createPackReviewRun({
      projectId,
      storeRoot,
      prNumber: target.prNumber,
      headSha: target.headSha,
      linkedSessionId: target.sessionId,
      startReason: trim(input.startReason) || (claimMode === 'preacquired' ? 'automatic' : 'manual'),
      surface: trim(input.surface) || 'pack-review-runner',
      trustedPackRoot: trusted.trustedPackRoot,
      sourceRepoRoot: target.sourceRepoRoot,
      canonicalRepository: target.repoSlug,
    });
    run = created.run;
    authority = advancePackReviewAuthority(
      authority,
      'review_or_bundle_staged',
      target.prNumber,
      authorityOptions,
    );
    if (created.reused) {
      if (claimLease) await claimLease.release('run_started', listPackReviewRuns({ projectId, storeRoot }));
      return {
        ok: true,
        created: false,
        reused: true,
        reason: created.reason,
        prNumber: target.prNumber,
        headSha: target.headSha,
        runId: run.id,
        httpStatus: 200,
        status: run.status,
      };
    }

    await recordPackReviewPendingStatus({
      run,
      projectId,
      storeRoot,
      writeRequiredStatus: input.fixtureRequiredStatusWriter ?? ((request) => publishPackReviewRequiredStatus({
        repoRoot: target.sourceRepoRoot,
        repoSlug: target.repoSlug,
        headSha: target.headSha,
        request,
      })),
    });

    updatePackReviewRun(run.id, {
      status: 'preparing',
      latestRunStatus: 'preparing',
      runnerPid: process.pid,
    }, { projectId, storeRoot });

    if (process.env.OPK_VITEST_HARNESS === '1' && (input.fixtureReviewStdout !== undefined || input.fixtureReviewTimedOut === true)) {
      worktree = join(packReviewWorktreesDir(storeRoot), run.id);
      mkdirSync(worktree, { recursive: true });
    } else {
      worktree = await createReviewWorktree(target.sourceRepoRoot, storeRoot, run.id, target.headSha);
    }
    updatePackReviewRun(run.id, { reviewTargetRoot: worktree }, { projectId, storeRoot });
    carryover = await resolveCarryoverReplay({ input, target, projectId, storeRoot, baseRef, priorAuthority });
    if (carryover?.replay.kind === 'merge_composite' && carryover.replay.bundle) {
      carryoverBundlePath = join(worktree, 'pack-review-carryover-bundle.json');
      writeFileSync(carryoverBundlePath, `${JSON.stringify(carryover.replay.bundle)}\n`, { encoding: 'utf8', mode: 0o600 });
    }

    if (input.onRunStarted) {
      await input.onRunStarted({
        prNumber: target.prNumber,
        headSha: target.headSha,
        runId: run.id,
        timeoutSeconds,
      });
    }

    const heartbeat = setInterval(() => {
      try { heartbeatPackReviewRun(run!.id, { projectId, storeRoot }); } catch { /* fail closed at terminal write */ }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    let result: ProcessResult;
    let resolvedReviewer: PackReviewer | null = null;
    try {
      const invocation = carryover?.replay.kind === 'conflict_free_carryover'
        ? {
            resolvedReviewer: null,
            result: {
              outcome: 'exit' as const,
              ok: true,
              exitCode: 0,
              signal: null,
              stdout: JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] }),
              stderr: '',
              timedOut: false,
              cancelled: false,
            },
          }
        : await invokeReviewer({
            reviewerPath: trusted.reviewerPath,
            trustedPackRoot: trusted.trustedPackRoot,
            reviewTargetRoot: worktree,
            baseRef,
            prNumber: target.prNumber,
            issueNumber: target.issueNumber,
            sessionId: target.sessionId,
            budgetLedger,
            runId: run.id,
            projectId,
            storeRoot,
            fixtureReviewStdout: input.fixtureReviewStdout,
            fixtureReviewExitCode: input.fixtureReviewExitCode,
            fixtureReviewTimedOut: input.fixtureReviewTimedOut,
            fixtureReviewerLayerOverrides: input.fixtureReviewerLayerOverrides,
            fixtureEmulateWin32Selector: input.fixtureEmulateWin32Selector,
            carryoverBundlePath,
            headSha: target.headSha,
          });
      result = invocation.result;
      resolvedReviewer = invocation.resolvedReviewer;
    } finally {
      clearInterval(heartbeat);
    }
    writeRunLogs(storeRoot, run.id, result.stdout, result.stderr);

    if (result.timedOut) {
      await recordPackReviewUnfinishedTerminalStatus({
        run,
        status: 'timed_out',
        failureReason: classifyPackReviewFailureReason('reviewer_process_timeout'),
        exitCode: result.exitCode,
        projectId,
        storeRoot,
        writeRequiredStatus: input.fixtureRequiredStatusWriter ?? ((request) => publishPackReviewRequiredStatus({
          repoRoot: target.sourceRepoRoot,
          repoSlug: target.repoSlug,
          headSha: target.headSha,
          request,
        })),
      });
      terminal = true;
      throw new Error('reviewer process timed out');
    }
    if (!result.ok) {
      await recordPackReviewUnfinishedTerminalStatus({
        run,
        status: 'failed',
        failureReason: classifyPackReviewFailureReason('reviewer_process_failed'),
        exitCode: result.exitCode,
        projectId,
        storeRoot,
        writeRequiredStatus: input.fixtureRequiredStatusWriter ?? ((request) => publishPackReviewRequiredStatus({
          repoRoot: target.sourceRepoRoot,
          repoSlug: target.repoSlug,
          headSha: target.headSha,
          request,
        })),
      });
      terminal = true;
      throw new Error(`reviewer process failed (exit ${String(result.exitCode)})`);
    }

    let payload: ReviewPayload;
    try {
      payload = parseReviewPayload(result.stdout);
    } catch (error) {
      const malformed = await recordMalformedPackReviewStatus({
        run,
        failureReason: describeError(error),
        projectId,
        storeRoot,
        writeRequiredStatus: input.fixtureRequiredStatusWriter ?? ((request) => publishPackReviewRequiredStatus({
          repoRoot: target.sourceRepoRoot,
          repoSlug: target.repoSlug,
          headSha: target.headSha,
          request,
        })),
      });
      terminal = true;
      const runs = listPackReviewRuns({ projectId, storeRoot });
      if (claimLease) await claimLease.release('run_started', runs);
      return {
        ok: false,
        created: true,
        reused: false,
        reason: malformed.reason,
        runId: run.id,
        status: malformed.status,
        httpStatus: 422,
      };
    }

    if (carryover?.replay.kind === 'merge_composite' && carryover.replay.bundle) {
      try {
        validateFocusedResolutionReview({
          replay: carryover.replay,
          reviewedTargetHeadSha: target.headSha,
          reviewedBundleDigest: payload.bundleDigest
            || (process.env.OPK_VITEST_HARNESS === '1'
              ? input.fixtureFocusedResolutionBundleDigest
              : undefined)
            || '',

          verdict: payload.verdict,
          findingCount: payload.findingCount,
        });
      } catch {
        // A rejected focused replay must fall back to the normal full-head reviewer.
        // Do not turn a carry-over-specific rejection into a failed review run.
        carryover = null;
        carryoverBundlePath = '';
        const fallback = await invokeReviewer({
          reviewerPath: trusted.reviewerPath,
          trustedPackRoot: trusted.trustedPackRoot,
          reviewTargetRoot: worktree,
          baseRef,
          prNumber: target.prNumber,
          issueNumber: target.issueNumber,
          sessionId: target.sessionId,
          budgetLedger,
          runId: run.id,
          projectId,
          storeRoot,
          fixtureReviewStdout: input.fixtureReviewStdout,
          fixtureReviewExitCode: input.fixtureReviewExitCode,
          fixtureReviewTimedOut: input.fixtureReviewTimedOut,
          fixtureReviewerLayerOverrides: input.fixtureReviewerLayerOverrides,
          fixtureEmulateWin32Selector: input.fixtureEmulateWin32Selector,
          headSha: target.headSha,
        });
        result = fallback.result;
        resolvedReviewer = fallback.resolvedReviewer;
        writeRunLogs(storeRoot, run.id, result.stdout, result.stderr);
        if (result.timedOut || !result.ok) {
          throw new Error(`normal reviewer fallback failed (exit ${String(result.exitCode)})`);
        }
        payload = parseReviewPayload(result.stdout);
      }
    }

    // The reviewer result is untrusted until the live head is checked immediately
    // before any terminal/cap authority write.
    try {
      if (!(process.env.OPK_VITEST_HARNESS === '1' && input.fixturePostReviewHeadSha === undefined)) {
        await assertBoundHeadStillCurrent({
          repoRoot: target.sourceRepoRoot,
          repoSlug: target.repoSlug,
          prNumber: target.prNumber,
          boundHeadSha: target.headSha,
          fixturePostReviewHeadSha: input.fixturePostReviewHeadSha,
        });
      }
    } catch (error) {
      await recordPackReviewUnfinishedTerminalStatus({
        run,
        status: 'failed',
        failureReason: 'stale_head_before_terminal',
        projectId,
        storeRoot,
        writeRequiredStatus: input.fixtureRequiredStatusWriter ?? ((request) => publishPackReviewRequiredStatus({
          repoRoot: target.sourceRepoRoot,
          repoSlug: target.repoSlug,
          headSha: target.headSha,
          request,
        })),
      });
      terminal = true;
      const runs = listPackReviewRuns({ projectId, storeRoot });
      if (claimLease) await claimLease.release('run_started', runs);
      return {
        ok: false,
        created: true,
        reused: false,
        reason: describeError(error),
        runId: run.id,
        status: 'failed',
        httpStatus: 409,
      };
    }

    authority = commitPackReviewTerminal({
      prNumber: target.prNumber,
      expectedTransitionSeq: authority.transitionSeq,
      terminal: terminalV2FromPayload({
        runId: run.id,
        targetSha: target.headSha,
        verdict: payload.verdict,
        findingCount: payload.findingCount,
        findings: payload.findings,
        carryover: carryover ? {
          replay: carryover.replay,
          sourceCleanRunId: carryover.sourceCleanRunId,
          focusedResolutionRunId: carryover.replay.kind === 'merge_composite' ? run.id : undefined,
        } : undefined,
      }),
      status: payload.verdict === 'clean' && payload.findingCount === 0 ? 'clean' : 'changes_requested',
      findingCount: payload.findingCount,
      options: authorityOptions,
    });
    authority = await commitAtCapTriage({
      start: input,
      target,
      projectId,
      baseRef,
      trustedPackRoot: trusted.trustedPackRoot,
      storeRoot,
      authority,
      payload,
    });

    const deliveryRun = run;
    if (!(process.env.OPK_VITEST_HARNESS === '1' && input.fixturePostReviewHeadSha === undefined)) {
      await assertBoundHeadStillCurrent({
        repoRoot: target.sourceRepoRoot,
        repoSlug: target.repoSlug,
        prNumber: target.prNumber,
        boundHeadSha: target.headSha,
        fixturePostReviewHeadSha: input.fixturePostReviewHeadSha,
      });
    }
    const delivered = await deliverPackReviewVerdict({
      run: deliveryRun,
      payload,
      projectId,
      storeRoot,
      journalWriter: input.fixtureJournalWriter,
      postGithubComment: async () => {
        const posted = await postGithubReview({
          repoRoot: target.sourceRepoRoot,
          repoSlug: target.repoSlug,
          prNumber: target.prNumber,
          headSha: target.headSha,
          run: deliveryRun,
          payload,
          projectId,
          storeRoot,
          transport: githubReviewTransport,
        });
        return { id: posted.id, url: posted.url, event: 'COMMENT' };
      },
      writeRequiredStatus: input.fixtureRequiredStatusWriter ?? ((request) => publishPackReviewRequiredStatus({
        repoRoot: target.sourceRepoRoot,
        repoSlug: target.repoSlug,
        headSha: target.headSha,
        request,
      })),
      notifyWorker: input.fixtureWorkerNotifier ?? ((request) => sendPackReviewWorkerNotification({
        trustedPackRoot: trusted.trustedPackRoot,
        sessionId: target.sessionId,
        request,
      })),
    });
    const currentAuthority = readPackReviewAuthority(target.prNumber, authorityOptions);
    if (!currentAuthority
        || currentAuthority.currentHeadSha !== target.headSha
        || currentAuthority.terminal?.runId !== run.id) {
      throw new Error('pack review authority changed before publication');
    }
    const publicationStatus = delivered.reason === 'completed' ? 'succeeded' : 'failed';
    authority = recordPackReviewPublication({
      prNumber: target.prNumber,
      expectedTransitionSeq: currentAuthority.transitionSeq,
      nextPhase: publicationStatus === 'succeeded' ? 'external_published' : currentAuthority.phase,
      publication: {
        headSha: target.headSha,
        terminalRunId: run.id,
        status: publicationStatus,
        publicationDigest: sha256Bytes(JSON.stringify({
          status: delivered.status,
          deliveryReason: delivered.reason,
          githubReviewId: delivered.githubReviewId,
          githubReviewUrl: delivered.githubReviewUrl,
        })),
        recordedAtUtc: new Date().toISOString(),
      },
      options: authorityOptions,
    });
    terminal = true;
    const runs = listPackReviewRuns({ projectId, storeRoot });
    if (claimLease) await claimLease.release('run_started', runs);
    return {
      ok: true,
      created: true,
      reused: false,
      reason: delivered.reason,
      runId: run.id,
      status: delivered.status,
      httpStatus: 201,
      ...(delivered.githubReviewId !== undefined ? { githubReviewId: delivered.githubReviewId } : {}),
      ...(delivered.githubReviewUrl ? { githubReviewUrl: delivered.githubReviewUrl } : {}),
    };
  } catch (error) {
    if (run && !terminal) {
      try {
        const persisted = getPackReviewRun(run.id, { projectId, storeRoot });
        if (!persisted
          || (!hasPersistedPackReviewVerdict(persisted) && !isPackReviewUnfinishedTerminalRun(persisted))) {
          await recordPackReviewUnfinishedTerminalStatus({
            run: persisted ?? run,
            status: 'failed',
            failureReason: classifyPackReviewFailureReason('runner_internal_failure'),
            projectId,
            storeRoot,
            writeRequiredStatus: input.fixtureRequiredStatusWriter ?? ((request) => publishPackReviewRequiredStatus({
              repoRoot: target.sourceRepoRoot,
              repoSlug: target.repoSlug,
              headSha: target.headSha,
              request,
            })),
          });
          terminal = true;
        }
      } catch (terminalError) {
        if (isTerminalPersistenceFailure(terminalError)) retainClaimDirectory = true;
        // Preserve the primary failure; store corruption remains fail-closed on next read.
      }
    }
    if (claimLease?.acquired && !retainClaimDirectory) {
      try {
        await claimLease.release('failure', listPackReviewRuns({ projectId, storeRoot }), describeError(error));
      } catch {
        // Primary runner failure is more actionable; the stale claim path remains recoverable.
      }
    }
    return {
      ok: false,
      created: Boolean(run),
      reused: false,
      reason: describeError(error),
      runId: run?.id ?? '',
      status: run ? getPackReviewRun(run.id, { projectId, storeRoot })?.status : undefined,
      httpStatus: 500,
    };
  } finally {
    if (worktree) await removeReviewWorktree(target.sourceRepoRoot, worktree);
    if (claimLease?.directory && !retainClaimDirectory) {
      rmSync(claimLease.directory, { recursive: true, force: true });
    }
  }
}

async function resetPackReview(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const trusted = resolveTrustedRunnerPaths();
  const projectId = trim(input.projectId) || DEFAULT_PROJECT_ID;
  const target = await resolveTarget(input as StartInput, trusted.trustedPackRoot);
  const storeRoot = resolvePackReviewRunStoreRoot({ projectId, storeRoot: trim(input.storeRoot) || undefined });
  const authority = readPackReviewAuthority(target.prNumber, { storeRoot });
  if (!authority?.cycle?.atCapHash) throw new Error('reset requires an at-cap authority record');
  const actor = trim(input.actor);
  const reason = trim(input.reason);
  const nonce = trim(input.nonce);
  if (!actor || !reason || !nonce) throw new Error('reset requires --actor, --reason, and --nonce');
  const reset = acknowledgePackReviewReset({
    prNumber: target.prNumber,
    expectedTransitionSeq: authority.transitionSeq,
    headSha: target.headSha,
    tier: (trim(input.tier) || 'T3').toUpperCase() as PackReviewTier,
    provenance: {
      priorCycleId: trim(input.priorCycleId) || authority.cycle.cycleId,
      priorAtCapHash: trim(input.priorAtCapHash) || authority.cycle.atCapHash,
      actor,
      reason,
      timestampUtc: trim(input.timestampUtc) || new Date().toISOString(),
      nonce,
    },
    options: { storeRoot },
  });
  return { ok: true, prNumber: target.prNumber, headSha: target.headSha, cycleId: reset.cycle?.cycleId };
}

function usage(): string {
  return [
    'Pack-owned review runner (Issue #839)',
    '',
    'Manual trigger:',
    '  node --experimental-strip-types scripts/pack-review-runner.ts start --pr-number <n>',
    '  node --experimental-strip-types scripts/pack-review-runner.ts start --pr-number <n> --head-sha <40-hex>',
    '  node --experimental-strip-types scripts/pack-review-runner.ts start --session-id <worker-session-id>',
    '',
    'Status:',
    '  node --experimental-strip-types scripts/pack-review-runner.ts list [--project-id orchestrator-pack]',
    '',
    'Stale reconciliation:',
    '  node --experimental-strip-types scripts/pack-review-runner.ts reconcile --source-repo-root <path> --repo-slug owner/name',
    '',
    'Audited cap reset:',
    '  node --experimental-strip-types scripts/pack-review-runner.ts reset --pr-number <n> --actor <id> --reason <text> --nonce <value>',
    '',
    'The runner/store/reviewer scripts resolve from the trusted pack checkout, never from the reviewed PR worktree.',
  ].join('\n');
}

function parseArgs(argv: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const keyByFlag: Record<string, string> = {
    '--project-id': 'projectId',
    '--session-id': 'sessionId',
    '--pr-number': 'prNumber',
    '--head-sha': 'headSha',
    '--repo-root': 'repoRoot',
    '--source-repo-root': 'sourceRepoRoot',
    '--base': 'baseRef',
    '--start-reason': 'startReason',
    '--surface': 'surface',
    '--store-root': 'storeRoot',
    '--timeout-seconds': 'timeoutSeconds',
    '--claim-mode': 'claimMode',
    '--repo-slug': 'fixtureRepoSlug',
    '--tier': 'tier',
    '--actor': 'actor',
    '--reason': 'reason',
    '--nonce': 'nonce',
    '--prior-cycle-id': 'priorCycleId',
    '--prior-at-cap-hash': 'priorAtCapHash',
    '--timestamp-utc': 'timestampUtc',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === '--help' || flag === '-h') {
      result.help = true;
      continue;
    }
    const key = keyByFlag[flag];
    if (!key) throw new Error(`unknown argument '${flag}'\n${usage()}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    result[key] = key === 'prNumber' ? Number(value) : value;
  }
  return result;
}

function readStdinPayload(): Record<string, unknown> {
  if (process.stdin.isTTY) return {};
  const text = readFileSync(0, 'utf8').trim();
  if (!text) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('runner stdin payload must be a JSON object');
  return parsed as Record<string, unknown>;
}

async function main(): Promise<void> {
  const [subcommand = 'help', ...argv] = process.argv.slice(2);
  if (subcommand === 'help' || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const input = { ...readStdinPayload(), ...parseArgs(argv) };
  if (subcommand === 'list') {
    const options = input as ListInput;
    process.stdout.write(`${JSON.stringify({ runs: listPackReviewRuns({ projectId: options.projectId, storeRoot: options.storeRoot }) })}\n`);
    return;
  }
  if (subcommand === 'status') {
    const runId = trim(input.runId);
    if (!runId) throw new Error('status requires runId in JSON payload');
    process.stdout.write(`${JSON.stringify({ run: getPackReviewRun(runId, input as ListInput) })}\n`);
    return;
  }
  if (subcommand === 'reset') {
    process.stdout.write(`${JSON.stringify(await resetPackReview(input))}\n`);
    return;
  }
  if (subcommand === 'reconcile') {
    const trusted = resolveTrustedRunnerPaths();
    const projectId = trim(input.projectId) || DEFAULT_PROJECT_ID;
    const sourceRepoRoot = resolve(trim(input.sourceRepoRoot || input.repoRoot) || trusted.trustedPackRoot);
    const harnessExplicit = process.env.OPK_VITEST_HARNESS === '1' && Boolean(trim(input.fixtureRepoSlug));
    const repoSlug = harnessExplicit
      ? trim(input.fixtureRepoSlug)
      : trim(input.fixtureRepoSlug) || await resolveRepositorySlug(sourceRepoRoot);
    const result = await reconcileStalePackReviewRuns({
      repoSlug,
      sourceRepoRoot,
      projectId,
      storeRoot: trim(input.storeRoot) || undefined,
      fixtureRequiredStatusWriter: (input as StartInput).fixtureRequiredStatusWriter,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (subcommand === 'start') {
    const result = await startPackReview(input as StartInput);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error(`unknown subcommand '${subcommand}'\n${usage()}`);
}

const direct = process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false;
if (direct) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = 1;
  }
}
