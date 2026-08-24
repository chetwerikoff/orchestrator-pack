import './toolchain/native-entrypoint-preflight.ts';
import { randomUUID } from 'node:crypto';
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
} from '../plugins/codex-pr-reviewer/lib/reviewer_budget.ts';
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
  PACK_REVIEW_GPT_SOURCE_ADMISSION_INTERVAL_MS,
  acknowledgePackReviewReset,
  assertPackReviewSmokeAdmission,
  commitPackReviewAuthorityTransition,
  commitPackReviewTerminal,
  commitPackReviewTriage,
  initializePackReviewAuthority,
  observePackReviewHead,
  readPackReviewAuthority,
  recordPackReviewPublication,
  selectPackReviewEvidence,
  selectPackReviewGptSourceCardinality,
  smokeOrderingRequired,
  reconcilePackReviewTier,
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
  PACK_REVIEW_ACTIVE_STATUSES,
  createPackReviewRun,
  getPackReviewRun,
  hasPersistedPackReviewVerdict,
  heartbeatPackReviewRun,
  isPackReviewRunStale,
  isPackReviewUnfinishedTerminalRun,
  listPackReviewRunRecordsRaw,
  listPackReviewRuns,
  packReviewLogsDir,
  packReviewRunStaleMinutes,
  packReviewWorktreesDir,
  resolvePackReviewRunOrder,
  resolvePackReviewRunStoreRoot,
  setPackReviewRunTerminal,
  terminalizePackReviewStaleRun,
  updatePackReviewRun,
  validatePersistedPackReviewGptAggregate,
  type PackReviewGptRoundRecord,
  type PackReviewRunRecord,
  type PackReviewRunStatus,
  type PackReviewSourceSlotRecord,
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
  classifyPackReviewPayload,
  deliverPackReviewVerdict,
  packReviewDeliveryNeedsResume,
  packReviewJournaledPayload,
  packReviewRequiredStatusNeedsStaleReconciliation,
  packReviewRequiredStatusProjectionKey,
  publishPackReviewRequiredStatus,
  recordMalformedPackReviewStatus,
  recordPackReviewNewerAuthorityReconciliation,
  recordPackReviewPendingStatus,
  recordPackReviewStaleRequiredStatus,
  recordPackReviewUnfinishedTerminalStatus,
  restorePackReviewAuthoritativeRequiredStatus,
  resumePackReviewVerdictDelivery,
  sendPackReviewWorkerNotification,
  type PackReviewJournalWriter,
  type PackReviewRequiredStatusWriter,
  type PackReviewWorkerNotifier,
} from './lib/pack-review-delivery.ts';
import {
  PACK_REVIEW_BOUND_REVIEWER_ENV,
  packReviewEntrypointRelativePath,
  resolvePackReviewerFromEnv,
  type PackReviewer,
  type PackReviewerLayerOverrides,
} from './lib/resolve-pack-reviewer.ts';
import { resolveRepositorySlug } from './lib/pack-gpt-reviewer.ts';
import {
  createPackGptSourceCommentTransport,
  resolvePackGptSourceComment,
  type PackGptSourceCommentResolution,
  type PackGptSourceCommentTransport,
} from './lib/pack-gpt-source-comment.ts';
import type { PackGptSourceIdentity } from './lib/pack-gpt-source-comment-contract.ts';
import {
  captureBoundIssueSnapshot,
  computeBoundIssueSnapshotHash,
  loadValidatedBoundSnapshotBody,
  resolveBoundIssueSnapshot,
} from './lib/reverify-bound-issue-snapshot.ts';
import { extractClosingIssueNumber } from './pr-scope-contract.ts';
import { parseComplexityTierFromIssueBody } from '../docs/review-cycle-cap.mjs';
import { parseIssueBody } from '@orchestrator-pack/shared/lib/issue_parser.js';
import type { ResolvedScopeContext } from '../plugins/codex-pr-reviewer/lib/scope_context.ts';
export { resolveRepositorySlug };

interface FixtureReviewOutcome {
  stdout?: string;
  exitCode?: number;
  timedOut?: boolean;
}

type FixtureReviewBySourceSlot = Partial<Record<string, readonly FixtureReviewOutcome[]>>;

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
  fixturePrBody?: string;
  fixturePrBodyAfterClaim?: string;
  fixturePostReviewPrBody?: string;
  fixtureReviewStdout?: string;
  fixtureReviewExitCode?: number;
  fixtureReviewTimedOut?: boolean;
  fixtureReviewBySourceSlot?: FixtureReviewBySourceSlot;
  fixtureGptSourceCommentTransport?: PackGptSourceCommentTransport;
  fixtureAfterGptInvocationBound?: (event: {
    slotId: string;
    attemptOrdinal: number;
    invocationId: string;
    round: PackReviewGptRoundRecord;
  }) => void | Promise<void>;
  fixtureBeforeGptSourceCommentCensus?: (event: {
    slotId: string;
    attemptOrdinal: number;
    invocationId: string;
    identity: PackGptSourceIdentity;
  }) => void | Promise<void>;
  fixtureCrashAfterGptSourceCredentialedCount?: number;
  fixtureAfterGptSourceSlotTerminal?: (event: {
    slotId: string;
    round: PackReviewGptRoundRecord;
  }) => void | Promise<void>;
  fixtureBeforeGptAggregateSettlement?: (event: {
    runId: string;
    payload: ReviewPayload;
  }) => void | Promise<void>;
  fixtureFallbackReviewStdout?: string;
  fixtureFallbackReviewExitCode?: number;
  fixtureFallbackReviewTimedOut?: boolean;
  fixtureReviewerLayerOverrides?: PackReviewerLayerOverrides;
  fixtureEmulateWin32Selector?: boolean;
  fixturePostReviewHeadSha?: string;
  fixtureGithubReviewId?: number;
  fixtureRepoSlug?: string;
  fixtureResolveRepositorySlug?: (repoRoot: string) => Promise<string>;
  fixtureGithubReviewTransport?: GithubReviewTransport;
  fixtureRequiredStatusWriter?: PackReviewRequiredStatusWriter;
  fixtureWorkerNotifier?: PackReviewWorkerNotifier;
  fixtureJournalWriter?: PackReviewJournalWriter;
  fixtureBeforeStaleStatusWrite?: (run: PackReviewRunRecord) => void | Promise<void>;
  fixtureCarryoverReplay?: CarryoverReplayResult;
  fixtureCarryoverSourceCleanRunId?: string;
  fixtureFocusedResolutionBundleDigest?: string;
  fixtureIssueBody?: string;
  fixtureIssueNumber?: number;
  fixtureChangedPaths?: string[];
  fixtureBoundIssueSnapshotBytes?: string;
}

interface DirectCliStartInput extends StartInput {
  operatorRepository?: string;
  operatorIssueNumber?: number;
  operatorBoundSnapshot?: string;
  operatorReason?: string;
}

export interface ReconcileStalePackReviewRunsInput {
  repoSlug: string;
  sourceRepoRoot: string;
  projectId?: string;
  storeRoot?: string;
  prNumber?: number;
  immediate?: boolean;
  baseRef?: string;
  fixtureCurrentPrHeadSha?: string;
  fixtureGptSourceCommentTransport?: PackGptSourceCommentTransport;
  fixtureGithubReviewId?: number;
  fixtureGithubReviewTransport?: GithubReviewTransport;
  fixtureRequiredStatusWriter?: PackReviewRequiredStatusWriter;
  fixtureWorkerNotifier?: PackReviewWorkerNotifier;
  fixtureIssueBody?: string;
  fixtureIssueNumber?: number;
  fixtureChangedPaths?: string[];
  fixtureBoundIssueSnapshotBytes?: string;
  resolveRepositorySlug?: (repoRoot: string) => Promise<string>;
  beforeStaleStatusWrite?: (run: PackReviewRunRecord) => void | Promise<void>;
  fixturePauseBeforeStaleStatusWrite?: () => void | Promise<void>;
  fixturePauseAfterStaleStatusWrite?: () => void | Promise<void>;
  fixturePauseAfterPendingRestoreWrite?: () => void | Promise<void>;
  fixturePauseAfterRestoreRead?: (run: PackReviewRunRecord) => void | Promise<void>;
  fixturePauseBeforeAuthoritySettlement?: () => void | Promise<void>;
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

interface OperatorPackReviewStart {
  repository?: string;
  issueNumber?: number;
  boundSnapshot?: string;
  reason: string;
}

const directCliOperatorStarts = new WeakMap<StartInput, OperatorPackReviewStart>();
const OPERATOR_START_FIELDS = [
  'operatorRepository',
  'operatorIssueNumber',
  'operatorBoundSnapshot',
  'operatorReason',
] as const;

interface ReviewPayloadFinding {
  title?: string;
  body?: string;
  severity?: string;
  filePath?: string;
  sourceSlotId?: string;
}

interface GptHarvestIncident {
  sourceSlotId: string;
  classification: 'harvest_failed' | 'no_reply' | 'forbidden_verdict_envelope';
  evidencePaths: Record<string, string>;
}

interface GptIncompleteSource {
  sourceSlotId: string;
  classification: string;
  timedOut: boolean;
  cancelled: boolean;
}

interface ReviewPayload {
  verdict: 'clean' | 'findings';
  findingCount: number;
  findings: ReviewPayloadFinding[];
  bundleDigest?: string;
  harvestIncidents?: GptHarvestIncident[];
}

interface ClaimLease {
  acquired: boolean;
  reason: string;
  directory: string;
  release: (action: 'run_started' | 'failure', reviewRuns: PackReviewRunRecord[], detail?: string) => Promise<void>;
}

interface AuthoritativeReviewContext {
  tier: PackReviewTier;
  issueNumber: number;
  snapshotDigest: string;
  issueBody?: string;
  frozenScope: ResolvedScopeContext;
}

const RUNNER_RELATIVE_PATH = 'scripts/pack-review-runner.ts';
const REVIEWER_RELATIVE_PATH = 'scripts/lib/Invoke-TypeScriptCli.ts';
const CLAIM_RELATIVE_PATH = 'scripts/lib/review-start-claim-store.ts';
const DEFAULT_PROJECT_ID = 'orchestrator-pack';
const DEFAULT_BASE_REF = 'origin/main';
const HEARTBEAT_INTERVAL_MS = 30_000;
const GPT_HARVEST_CLASSES = new Set(['harvest_failed', 'no_reply', 'forbidden_verdict_envelope']);
const GPT_SOURCE_FIXTURE_CRASH_REASON = 'fixture_crash_after_gpt_source_comment_credentialed';

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
  const configured = trim(env.OPK_TRUSTED_PACK_ROOT || env.OPK_TRUSTED_PACK_ROOT);
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
  const explicit = trim(env.OPK_PR_SESSION_BINDING_CACHE);
  if (explicit) return resolve(explicit);
  const seed = trim(env.OPK_REPORT_STATE_SEED_STATE);
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

function resolveOperatorPackReviewStart(input: DirectCliStartInput): OperatorPackReviewStart | undefined {
  const raw = [
    input.operatorRepository,
    input.operatorIssueNumber,
    input.operatorBoundSnapshot,
    input.operatorReason,
  ];
  if (raw.every((value) => value === undefined || value === null || value === '')) return undefined;
  const reason = trim(input.operatorReason);
  if (!reason) {
    throw new Error('explicit operator pack-review start requires --operator-reason <text>');
  }
  const repository = trim(input.operatorRepository);
  if (repository && !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error('operator pack-review repository must be owner/name');
  }
  const issueNumber = input.operatorIssueNumber === undefined
    ? undefined
    : positiveInteger(input.operatorIssueNumber, 'operatorIssueNumber');
  const boundSnapshot = trim(input.operatorBoundSnapshot).toLowerCase();
  if (boundSnapshot && !/^sha256:[0-9a-f]{64}$/.test(boundSnapshot)) {
    throw new Error('operatorBoundSnapshot must be sha256:<64-hex> when supplied');
  }
  return {
    ...(repository ? { repository } : {}),
    ...(issueNumber ? { issueNumber } : {}),
    ...(boundSnapshot ? { boundSnapshot } : {}),
    reason,
  };
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
  automaticBudgetDisposition?: PackReviewTerminalV2['automaticBudgetDisposition'];
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
    ...(input.automaticBudgetDisposition ? {
      automaticBudgetDisposition: input.automaticBudgetDisposition,
    } : {}),
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

export async function resolveCurrentPrHead(
  repoRoot: string,
  repoSlug: string,
  prNumber: number,
  runner: typeof runProcess = runProcess,
): Promise<string> {
  const result = await runner({
    command: 'gh',
    args: ['pr', 'view', String(prNumber), '--repo', repoSlug, '--json', 'headRefOid,state'],
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: 30_000,
  });
  const output = await requireProcess(result, `gh pr view ${prNumber}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`PR #${prNumber} returned invalid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`PR #${prNumber} returned invalid JSON`);
  }
  const row = parsed as Record<string, unknown>;
  const headSha = trim(row.headRefOid);
  const state = trim(row.state);
  if (!/^[0-9a-f]{40}$/i.test(headSha ?? '')) throw new Error(`PR #${prNumber} returned invalid head SHA`);
  if (String(state ?? '').toUpperCase() !== 'OPEN') throw new Error(`PR #${prNumber} is not open`);
  return headSha.toLowerCase();
}

export async function resolveCurrentPrTarget(
  repoRoot: string,
  repoSlug: string,
  prNumber: number,
  runner: typeof runProcess = runProcess,
): Promise<{ headSha: string; body: string }> {
  const result = await runner({
    command: 'gh',
    args: ['pr', 'view', String(prNumber), '--repo', repoSlug, '--json', 'headRefOid,state,body'],
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: 30_000,
  });
  const output = await requireProcess(result, `gh pr view ${prNumber}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`PR #${prNumber} returned invalid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`PR #${prNumber} returned invalid JSON`);
  }
  const row = parsed as Record<string, unknown>;
  const headSha = trim(row.headRefOid);
  const state = trim(row.state);
  if (!/^[0-9a-f]{40}$/i.test(headSha)) throw new Error(`PR #${prNumber} returned invalid head SHA`);
  if (state.toUpperCase() !== 'OPEN') throw new Error(`PR #${prNumber} is not open`);
  if (typeof row.body !== 'string') throw new Error(`PR #${prNumber} returned invalid body`);
  return { headSha: headSha.toLowerCase(), body: row.body };
}

async function resolveCurrentIssueBody(
  repoRoot: string,
  repoSlug: string,
  issueNumber: number,
  runner: typeof runProcess = runProcess,
): Promise<string> {
  const result = await runner({
    command: 'gh',
    args: ['issue', 'view', String(issueNumber), '--repo', repoSlug, '--json', 'body'],
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: 30_000,
  });
  const output = await requireProcess(result, `gh issue view ${issueNumber} --json body`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`Issue #${issueNumber} returned invalid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Issue #${issueNumber} returned invalid JSON`);
  }
  const body = (parsed as Record<string, unknown>).body;
  if (typeof body !== 'string') throw new Error(`Issue #${issueNumber} returned invalid body`);
  return body;
}

async function resolveTarget(
  input: StartInput,
  trustedPackRoot: string,
  operatorStart?: OperatorPackReviewStart,
): Promise<{
  prNumber: number;
  headSha: string;
  sessionId: string;
  issueNumber?: number;
  repoSlug: string;
  sourceRepoRoot: string;
  operatorStart?: OperatorPackReviewStart;
}> {
  const sessionId = trim(input.sessionId || input.linkedSessionId);
  const fixtureCurrentHead = trim(input.fixtureCurrentPrHeadSha).toLowerCase();
  const harness = process.env.OPK_VITEST_HARNESS === '1';
  const fixtureIssueNumber = harness ? positiveInteger(input.fixtureIssueNumber, 'fixtureIssueNumber') : undefined;
  const harnessExplicit = harness && Boolean(input.prNumber && (input.headSha || fixtureCurrentHead));
  let binding: BindingRecord | undefined;
  if (sessionId) {
    try {
      binding = resolveBindingFromCache(sessionId);
    } catch {
      // Session binding is advisory only. Missing/corrupt/ambiguous cache state cannot veto explicit PR authority.
    }
  }
  const requestedPr = positiveInteger(input.prNumber, 'prNumber');
  if (!requestedPr) {
    throw new Error(
      'pack review start requires --pr-number <n>; obtain it for the current branch with: gh pr view --json number --jq .number',
    );
  }
  const prNumber = requestedPr;
  const sourceRepoRoot = resolve(trim(input.sourceRepoRoot || input.repoRoot) || trustedPackRoot);
  if (!harness && !existsSync(join(sourceRepoRoot, '.git')) && !existsSync(join(sourceRepoRoot, 'HEAD'))) {
    throw new Error(`source repository root is not a git checkout: ${sourceRepoRoot}`);
  }
  const requestedHead = trim(input.headSha).toLowerCase();
  const repoSlug = harnessExplicit
    ? trim(input.fixtureRepoSlug) || 'fixture/orchestrator-pack'
    : await resolveRepositorySlug(sourceRepoRoot);
  if (harnessExplicit && trim(input.fixturePrState || 'OPEN').toUpperCase() !== 'OPEN') {
    throw new Error(`PR #${prNumber} is not open`);
  }
  const liveTarget = harnessExplicit
    ? { headSha: fixtureCurrentHead || requestedHead, body: input.fixturePrBody ?? '' }
    : await resolveCurrentPrTarget(sourceRepoRoot, repoSlug, prNumber);
  const liveHead = liveTarget.headSha;
  if (!/^[0-9a-f]{40}$/.test(liveHead)) throw new Error(`review target head is not a full SHA for PR #${prNumber}`);
  if (operatorStart?.repository && operatorStart.repository.toLowerCase() !== repoSlug.toLowerCase()) {
    throw new Error(
      `pack review repository does not match operator target: requested ${operatorStart.repository}, live ${repoSlug}; omit --operator-repository or set it to ${repoSlug}`,
    );
  }
  if (requestedHead && requestedHead !== liveHead) {
    throw new Error(
      `review target head changed for PR #${prNumber}: requested ${requestedHead}, live ${liveHead}; rerun with --head-sha ${liveHead} or omit --head-sha`,
    );
  }

  let issueNumber: number | undefined;
  if (harness) {
    const linkedIssue = input.fixturePrBody !== undefined
      ? extractClosingIssueNumber(input.fixturePrBody)
      : null;
    issueNumber = linkedIssue ?? fixtureIssueNumber;
    if (input.fixturePrBody !== undefined && !issueNumber) {
      throw new Error(`PR #${prNumber} has no resolvable closing Issue; add 'Closes #<issue>' to the PR body and retry`);
    }
  } else {
    issueNumber = extractClosingIssueNumber(liveTarget.body) ?? undefined;
    if (!issueNumber) {
      throw new Error(`PR #${prNumber} has no resolvable closing Issue; add 'Closes #<issue>' to the PR body and retry`);
    }
  }
  if (operatorStart?.issueNumber && issueNumber && operatorStart.issueNumber !== issueNumber) {
    throw new Error(
      `pack review Issue mismatch: requested #${operatorStart.issueNumber}, PR #${prNumber} closes #${issueNumber}; use --operator-issue-number ${issueNumber} or omit it`,
    );
  }
  if (binding) {
    const mismatches: string[] = [];
    if (binding.prNumber !== prNumber) mismatches.push(`PR cache=#${binding.prNumber} requested=#${prNumber}`);
    if (binding.headSha && binding.headSha.toLowerCase() !== liveHead.toLowerCase()) {
      mismatches.push(`head cache=${binding.headSha} live=${liveHead}`);
    }
    if (binding.repoSlug && binding.repoSlug.toLowerCase() !== repoSlug.toLowerCase()) {
      mismatches.push(`repository cache=${binding.repoSlug} live=${repoSlug}`);
    }
    if (binding.issueNumber && issueNumber && binding.issueNumber !== issueNumber) {
      mismatches.push(`Issue cache=#${binding.issueNumber} PR-linked=#${issueNumber}`);
    }
    if (mismatches.length > 0) {
      process.stderr.write(
        `[pack-review diagnostic] session binding advisory mismatch for ${sessionId}: ${mismatches.join('; ')}\n`,
      );
    }
  }
  return {
    prNumber,
    headSha: liveHead,
    sessionId,
    issueNumber,
    repoSlug,
    sourceRepoRoot,
    ...(operatorStart ? { operatorStart } : {}),
  };
}

function parseAuthoritativeTier(body: string): PackReviewTier {
  const parsed = parseComplexityTierFromIssueBody(body);
  const tier = String(parsed.kind === 'tier' ? parsed.tier : '').toUpperCase();
  if (parsed.kind !== 'tier' || !['T1', 'T2', 'T3'].includes(tier)) {
    throw new Error(`authoritative Issue tier is ${parsed.kind === 'invalid' ? 'invalid' : 'missing'}`);
  }
  return tier as PackReviewTier;
}

async function resolveAuthoritativeReviewContext(input: StartInput, target: {
  prNumber: number;
  headSha: string;
  issueNumber?: number;
  repoSlug: string;
  sourceRepoRoot: string;
}, projectId: string): Promise<AuthoritativeReviewContext> {
  const harness = process.env.OPK_VITEST_HARNESS === '1';
  const issueNumber = target.issueNumber ?? 0;
  let body: string | undefined;
  let snapshotDigest = '';

  const configuredSnapshotPath = trim(process.env.OPK_BOUND_ISSUE_SNAPSHOT_PATH);
  const configuredSnapshotStore = trim(process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR);
  const legacyHarnessDirectBody = harness
    && input.fixtureIssueBody !== undefined
    && !configuredSnapshotPath
    && !configuredSnapshotStore;

  if (legacyHarnessDirectBody) {
    body = input.fixtureIssueBody!;
    snapshotDigest = computeBoundIssueSnapshotHash(body);
  } else if (issueNumber > 0) {
    let resolvedSnapshot = resolveBoundIssueSnapshot({
      projectId,
      prNumber: target.prNumber,
      prHeadSha: target.headSha,
      issueNumber,
      storeDirOverride: process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR,
    });
    if (resolvedSnapshot.status === 'corrupted') {
      throw new Error(`authoritative bound Issue snapshot corrupted for PR #${target.prNumber} Issue #${issueNumber}`);
    }
    if (resolvedSnapshot.status === 'missing') {
      if (!(harness && input.fixtureIssueBody === undefined)) {
        const observedBody = input.fixtureIssueBody
          ?? await resolveCurrentIssueBody(target.sourceRepoRoot, target.repoSlug, issueNumber);
        const captured = captureBoundIssueSnapshot({
          projectId,
          prNumber: target.prNumber,
          prHeadSha: target.headSha,
          issueNumber,
          issueBody: observedBody,
          storeDirOverride: process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR,
        });
        resolvedSnapshot = resolveBoundIssueSnapshot({
          projectId,
          prNumber: target.prNumber,
          prHeadSha: target.headSha,
          issueNumber,
          storeDirOverride: process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR,
        });
        if (resolvedSnapshot.status !== 'found' || !resolvedSnapshot.snapshotPath) {
          throw new Error(
            `bound Issue snapshot producer failed after capture; rerun: gh issue view ${issueNumber} --repo ${target.repoSlug} --json body`,
          );
        }
        if (resolve(captured.snapshotPath) !== resolve(resolvedSnapshot.snapshotPath)) {
          throw new Error('bound Issue snapshot producer/resolver path mismatch');
        }
      }
    }
    if (resolvedSnapshot.status === 'found' && resolvedSnapshot.snapshotPath) {
      if (configuredSnapshotPath && resolve(configuredSnapshotPath) !== resolve(resolvedSnapshot.snapshotPath)) {
        throw new Error(
          `configured bound Issue snapshot path mismatch: requested ${configuredSnapshotPath}, authoritative ${resolvedSnapshot.snapshotPath}; unset OPK_BOUND_ISSUE_SNAPSHOT_PATH or point it at the authoritative artifact`,
        );
      }
      const snapshot = loadValidatedBoundSnapshotBody({
        projectId,
        prNumber: target.prNumber,
        prHeadSha: target.headSha,
        issueNumber,
        snapshotFilePath: configuredSnapshotPath || resolvedSnapshot.snapshotPath,
        storeDirOverride: process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR,
      });
      body = snapshot.body;
      snapshotDigest = snapshot.snapshotHash;
    }
  }

  if (body === undefined) {
    if (!harness) {
      throw new Error(
        `authoritative bound Issue snapshot unavailable; produce it from: gh issue view ${issueNumber} --repo ${target.repoSlug} --json body`,
      );
    }
    const fixtureTier = String(input.tier ?? 'T3').toUpperCase();
    if (!['T1', 'T2', 'T3'].includes(fixtureTier)) throw new Error('invalid fixture tier');
    return {
      tier: fixtureTier as PackReviewTier,
      issueNumber: issueNumber > 0 ? issueNumber : 0,
      snapshotDigest: 'harness-unbound-fixture',
      frozenScope: {
        issueNumber: issueNumber > 0 ? issueNumber : null,
        hasScope: false,
        issueConstraints: null,
        declaredPaths: [],
        declaredGlobs: [],
        unverifiedIssueConstraints: true,
      },
    };
  }

  if (issueNumber <= 0) throw new Error('authoritative bound Issue number unavailable');
  const tier = parseAuthoritativeTier(body);
  if (input.tier && input.tier !== tier) {
    throw new Error(`caller tier ${input.tier} conflicts with authoritative Issue tier ${tier}`);
  }
  let frozenScope: ResolvedScopeContext;
  try {
    const issueConstraints = parseIssueBody(body);
    frozenScope = {
      issueNumber,
      hasScope: true,
      issueConstraints,
      declaredPaths: [],
      declaredGlobs: [],
      unverifiedIssueConstraints: false,
    };
  } catch {
    frozenScope = {
      issueNumber,
      hasScope: false,
      issueConstraints: null,
      declaredPaths: [],
      declaredGlobs: [],
      unverifiedIssueConstraints: true,
    };
  }
  return { tier, issueNumber, snapshotDigest, issueBody: body, frozenScope };
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

function gptRoundDiagnostics(round: PackReviewGptRoundRecord | undefined): {
  harvestIncidents: GptHarvestIncident[];
  nonHarvestIncompleteSources: GptIncompleteSource[];
} {
  const harvestIncidents: GptHarvestIncident[] = [];
  const nonHarvestIncompleteSources: GptIncompleteSource[] = [];
  for (const slot of round?.sourceSlots ?? []) {
    const classification = trim(slot.terminalClass);
    if (!classification || classification === 'complete_clean' || classification === 'complete_findings') continue;
    const terminal = slot.terminalResult && typeof slot.terminalResult === 'object' && !Array.isArray(slot.terminalResult)
      ? slot.terminalResult as Record<string, unknown>
      : {};
    if (GPT_HARVEST_CLASSES.has(classification)) {
      const rawEvidence = terminal.review_evidence && typeof terminal.review_evidence === 'object'
        && !Array.isArray(terminal.review_evidence)
        ? terminal.review_evidence as Record<string, unknown>
        : {};
      const evidencePaths = Object.fromEntries(
        Object.entries(rawEvidence)
          .filter(([, value]) => typeof value === 'string' && value.trim())
          .map(([key, value]) => [key, String(value)]),
      );
      harvestIncidents.push({
        sourceSlotId: slot.slotId,
        classification: classification as GptHarvestIncident['classification'],
        evidencePaths,
      });
      continue;
    }
    nonHarvestIncompleteSources.push({
      sourceSlotId: slot.slotId,
      classification,
      timedOut: terminal.process_timed_out === true || terminal.process_exit_code === 124,
      cancelled: terminal.process_cancelled === true,
    });
  }
  return { harvestIncidents, nonHarvestIncompleteSources };
}

function gptUsableSourceCount(round: PackReviewGptRoundRecord | undefined): number {
  return round?.sourceSlots.filter((slot) => (
    slot.lifecycle === 'terminal'
    && (slot.terminalClass === 'complete_clean' || slot.terminalClass === 'complete_findings')
  )).length ?? 0;
}

function gptRoundGraceExpired(run: PackReviewRunRecord, now = Date.now()): boolean {
  const round = run.reviewRound;
  if (!round || round.cardinality < 3) return true;
  const admissions = round.sourceSlots
    .map((slot) => Date.parse(trim(slot.admissionStartedAtUtc)))
    .filter((value) => Number.isFinite(value));
  const createdAt = Date.parse(run.createdAt);
  const anchor = admissions.length > 0
    ? Math.min(...admissions)
    : createdAt;
  if (!Number.isFinite(anchor)) return false;
  return now - anchor >= packReviewRunStaleMinutes() * 60_000;
}

function validatePersistedGptReviewPayload(
  runId: string,
  payload: ReviewPayload,
  options: { projectId: string; storeRoot: string },
): ReviewPayload {
  const persisted = getPackReviewRun(runId, options);
  if (!persisted) throw new Error(`pack review run ${runId} is unavailable for GPT source authority validation`);
  assertCredentialedGptSourceAuthority(persisted);
  const aggregate = validatePersistedPackReviewGptAggregate(runId, {
    reviewVerdict: payload.verdict,
    findingCount: payload.findingCount,
    findings: payload.findings,
  }, options);
  const diagnostics = gptRoundDiagnostics(persisted.reviewRound);
  return {
    verdict: aggregate.reviewVerdict,
    findingCount: aggregate.findingCount,
    findings: aggregate.findings as ReviewPayloadFinding[],
    ...(diagnostics.harvestIncidents.length > 0 ? { harvestIncidents: diagnostics.harvestIncidents } : {}),
  };
}

export async function assertBoundHeadStillCurrent(options: {
  repoRoot: string;
  repoSlug: string;
  prNumber: number;
  boundHeadSha: string;
  boundIssueNumber?: number;
  fixturePostReviewHeadSha?: string;
  fixturePostReviewPrBody?: string;
}): Promise<void> {
  let current: string;
  let currentBody: string | undefined;
  if (options.fixturePostReviewHeadSha !== undefined || options.fixturePostReviewPrBody !== undefined) {
    current = options.fixturePostReviewHeadSha ?? options.boundHeadSha;
    currentBody = options.fixturePostReviewPrBody;
  } else if (options.boundIssueNumber) {
    const target = await resolveCurrentPrTarget(options.repoRoot, options.repoSlug, options.prNumber);
    current = target.headSha;
    currentBody = target.body;
  } else {
    current = await resolveCurrentPrHead(options.repoRoot, options.repoSlug, options.prNumber);
  }
  if (current.toLowerCase() !== options.boundHeadSha.toLowerCase()) {
    throw new Error(
      `review target head changed after reviewer returned: bound ${options.boundHeadSha}, current ${current}; rerun with --head-sha ${current} or omit --head-sha`,
    );
  }
  if (options.boundIssueNumber && currentBody !== undefined) {
    const currentIssueNumber = extractClosingIssueNumber(currentBody) ?? undefined;
    if (currentIssueNumber !== options.boundIssueNumber) {
      throw new Error(
        `review target Issue changed for PR #${options.prNumber}: bound #${options.boundIssueNumber}, current ${currentIssueNumber ? `#${currentIssueNumber}` : 'unresolved'}; restore the PR closing reference to #${options.boundIssueNumber} or restart against the current PR-linked Issue`,
      );
    }
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
  const hasHarvestIncident = (payload.harvestIncidents?.length ?? 0) > 0;
  const lines = [
    `## Pack review — ${hasHarvestIncident && payload.findingCount === 0
      ? 'review harvest failed'
      : payload.verdict === 'clean' && payload.findingCount === 0 ? 'no findings' : 'findings'}`,
    '',
    `Run: \`${run.id}\``,
    `Head: \`${run.targetSha}\``,
    '',
  ];
  if (run.reviewRound?.cardinality === 3 && run.reviewRound.settledSourceCount === 2) {
    lines.push('Sources: 2/3 (degraded after timeout)', '');
  }
  if (payload.findings.length === 0) {
    lines.push(hasHarvestIncident ? 'No accepted review findings.' : 'No findings.', '');
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
  if (hasHarvestIncident) {
    lines.push('## Review harvest incidents', '');
    for (const incident of payload.harvestIncidents ?? []) {
      lines.push(`### ${incident.sourceSlotId}: ${incident.classification}`, '');
      for (const [label, path] of Object.entries(incident.evidencePaths)) {
        lines.push(`${label}: \`${path}\``);
      }
      lines.push('');
    }
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
  allowCompletedSameHeadReplay?: boolean;
}): Promise<ClaimLease> {
  void options.trustedPackRoot;
  void options.claimPath;
  const visibleRuns = listPackReviewRuns({ projectId: options.projectId, storeRoot: options.storeRoot });
  const replayVisibleRuns = options.allowCompletedSameHeadReplay
    ? visibleRuns.filter((candidate) => !(
        candidate.prNumber === options.prNumber
        && candidate.targetSha === options.headSha
        && hasPersistedPackReviewVerdict(candidate)
      ))
    : visibleRuns;
  const claimRuns = options.resumeRunId
    ? replayVisibleRuns.map((candidate) => candidate.id === options.resumeRunId
      ? {
          ...candidate,
          status: 'failed' as const,
          latestRunStatus: 'failed' as const,
          failureReason: 'journaled_delivery_resume_candidate',
        }
      : candidate)
    : replayVisibleRuns;
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

async function findJournaledDeliveryResumeCandidate(options: {
  projectId: string;
  storeRoot: string;
  prNumber: number;
  headSha: string;
  repoSlug: string;
  sourceRepoRoot: string;
  resolveSlug?: (repoRoot: string) => Promise<string>;
}): Promise<PackReviewRunRecord | null> {
  const candidates = listPackReviewRuns({ projectId: options.projectId, storeRoot: options.storeRoot })
    .filter((candidate) => candidate.prNumber === options.prNumber
      && candidate.targetSha === options.headSha
      && packReviewDeliveryNeedsResume(candidate));
  const repositoryBoundCandidates: PackReviewRunRecord[] = [];
  for (const candidate of candidates) {
    const identity = await resolvePackReviewRunCanonicalRepository(
      candidate,
      options.resolveSlug ?? resolveRepositorySlug,
    );
    if (identity.ok
      && identity.slug === options.repoSlug
      && hasCredentialedGptSourceAuthority(candidate)) {
      repositoryBoundCandidates.push(candidate);
    }
  }
  if (repositoryBoundCandidates.length > 1) {
    throw new Error(`ambiguous journaled pack review deliveries for PR #${options.prNumber} head ${options.headSha}`);
  }
  return repositoryBoundCandidates[0] ?? null;
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
  sourceSlotId?: string;
  attemptOrdinal?: number;
  invocationId?: string;
  frozenScope?: ResolvedScopeContext;
}): Promise<{ result: ProcessResult; resolvedReviewer: PackReviewer | null }> {
  const resolvedReviewer = resolvePackReviewerFromEnv(process.env, {
    layerOverrides: options.fixtureReviewerLayerOverrides,
    emulateWin32: options.fixtureEmulateWin32Selector,
  });
  const adapterArgs = [
    '--repo-root', options.reviewTargetRoot,
    '--base', options.baseRef,
    '--pr-number', String(options.prNumber),
  ];
  if (options.issueNumber) adapterArgs.push('--issue', String(options.issueNumber));

  const reviewerEntrypoint = resolvedReviewer
    ? resolve(options.trustedPackRoot, packReviewEntrypointRelativePath(resolvedReviewer))
    : '';
  if (resolvedReviewer
      && (!pathInside(reviewerEntrypoint, options.trustedPackRoot) || !existsSync(reviewerEntrypoint))) {
    throw new Error(`trusted reviewer entrypoint unavailable at ${reviewerEntrypoint}`);
  }
  const reviewerArgs = resolvedReviewer
    ? [
        '--experimental-strip-types',
        options.reviewerPath,
        '--repo-root', options.trustedPackRoot,
        '--script', reviewerEntrypoint,
        '--',
        ...adapterArgs,
      ]
    : [];

  const invocationLog = trim(process.env.PACK_REVIEW_RUNNER_INVOCATION_LOG);
  if (process.env.OPK_VITEST_HARNESS === '1' && invocationLog) {
    appendFileSync(invocationLog, `${JSON.stringify({
      reviewer: resolvedReviewer,
      command: process.execPath,
      args: reviewerArgs,
      ...(options.invocationId ? { invocationId: options.invocationId } : {}),
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

  if (!resolvedReviewer) throw new Error('pack review reviewer selector did not resolve');

  const args = reviewerArgs;
  const retiredRuntimePrefixes = [
    ['A', 'O', '_'].join(''),
    ['O', 'R', 'C', 'A', '_'].join(''),
  ];
  const sanitizedParentEnv = Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => !retiredRuntimePrefixes.some((prefix) => key.startsWith(prefix))),
  ) as NodeJS.ProcessEnv;
  const env: NodeJS.ProcessEnv = {
    ...sanitizedParentEnv,
    ...buildReviewerBudgetSpawnEnv(options.budgetLedger, {}),
    OPK_REVIEW_RUN_ID: options.runId,
    PACK_REVIEW_RUN_ID: options.runId,
    PACK_REVIEW_PROJECT_ID: options.projectId,
    PACK_REVIEW_RUN_STORE_ROOT: options.storeRoot,
    PACK_REVIEW_TARGET_HEAD_SHA: options.headSha,
    ...(options.frozenScope ? { PACK_REVIEW_FROZEN_SCOPE_JSON: JSON.stringify(options.frozenScope) } : {}),
    ...(options.sourceSlotId ? { PACK_REVIEW_GPT_SOURCE_SLOT: options.sourceSlotId } : {}),
    ...(options.attemptOrdinal ? { PACK_REVIEW_GPT_ATTEMPT_ORDINAL: String(options.attemptOrdinal) } : {}),
    ...(options.invocationId ? { PACK_REVIEW_GPT_INVOCATION_ID: options.invocationId } : {}),
  };
  env.PACK_REVIEWER = resolvedReviewer;
  env[PACK_REVIEW_BOUND_REVIEWER_ENV] = resolvedReviewer;
  if (options.carryoverBundlePath) {
    env.PACK_REVIEW_CARRYOVER_BUNDLE_PATH = options.carryoverBundlePath;
  } else {
    delete env.PACK_REVIEW_CARRYOVER_BUNDLE_PATH;
  }

  const result = await runProcess({
    command: process.execPath,
    args,
    cwd: options.trustedPackRoot,
    inheritParentEnv: false,
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

interface GptTerminalTurnResult {
  schema: 'turn-result/v1';
  state: string;
  scope: string;
  cause: string;
  invocation_id: string;
  send_count: number;
  [key: string]: unknown;
}

function parseLastGptTerminalTurnResult(stdout: string): GptTerminalTurnResult | null {
  for (const line of stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).reverse()) {
    try {
      const parsed = JSON.parse(line) as Partial<GptTerminalTurnResult>;
      if (parsed.schema === 'turn-result/v1'
        && typeof parsed.state === 'string'
        && typeof parsed.scope === 'string'
        && typeof parsed.cause === 'string'
        && typeof parsed.invocation_id === 'string'
        && Number.isInteger(parsed.send_count)) {
        return parsed as GptTerminalTurnResult;
      }
    } catch {
      // The adapter may also emit heartbeat or diagnostic lines.
    }
  }
  return null;
}

function bindHarnessFixtureTerminalInvocation(
  result: ProcessResult,
  invocationId: string,
): ProcessResult {
  if (process.env.OPK_VITEST_HARNESS !== '1' || !result.stdout) return result;
  const stdout = result.stdout.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.schema === 'turn-result/v1' && typeof parsed.invocation_id === 'string') {
        parsed.invocation_id = invocationId;
        return JSON.stringify(parsed);
      }
    } catch {
      // Preserve non-terminal fixture lines unchanged.
    }
    return line;
  }).join('\n');
  return { ...result, stdout };
}

export function isRetryablePackReviewZeroSendCollision(
  result: ProcessResult,
  expectedInvocationId?: string,
): boolean {
  const terminal = parseLastGptTerminalTurnResult(result.stdout);
  if (result.ok || terminal?.send_count !== 0) return false;
  if (expectedInvocationId && trim(terminal.invocation_id) !== trim(expectedInvocationId)) return false;
  return (terminal.state === 'driver_error'
      && terminal.cause === 'state_light_new_chat_send_slot_timeout')
    || (terminal.state === 'profile_busy'
      && terminal.cause === 'profile_busy')
    || (terminal.state === 'ui_contract_mismatch'
      && terminal.cause === 'composer_unavailable');
}

function updateGptRoundSlot(
  runId: string,
  round: PackReviewGptRoundRecord,
  slotId: string,
  patch: Partial<PackReviewSourceSlotRecord>,
  options: { projectId: string; storeRoot: string },
): PackReviewGptRoundRecord {
  const persisted = getPackReviewRun(runId, options);
  const base = persisted?.reviewRound ?? round;
  const slots = base.sourceSlots.map((slot) => slot.slotId === slotId ? { ...slot, ...patch } : slot);
  if (slots.filter((slot) => slot.slotId === slotId).length !== 1) {
    throw new Error(`unknown GPT source slot ${slotId}`);
  }
  const next = { ...base, sourceSlots: slots };
  updatePackReviewRun(runId, { reviewRound: next }, options);
  return getPackReviewRun(runId, options)?.reviewRound ?? next;
}

function terminalClassForGptResult(result: ProcessResult, terminal: GptTerminalTurnResult | null): string {
  const harvestClass = trim(terminal?.review_harvest_class);
  if (terminal && terminal.send_count >= 1 && GPT_HARVEST_CLASSES.has(harvestClass)) {
    return harvestClass;
  }
  if (terminal?.send_count !== undefined && terminal.send_count >= 1) {
    return terminal.state === 'ok' ? 'reviewer_output_malformed' : 'possible_delivery';
  }
  if (terminal) return `${terminal.state}:${terminal.cause}`;
  if (result.ok) return 'reviewer_output_malformed';
  return 'possible_delivery/missing_result';
}

function gptSourceIdentity(options: {
  repoSlug: string;
  prNumber: number;
  headSha: string;
  runId: string;
  slotId: string;
  invocationId: string;
}): PackGptSourceIdentity {
  return {
    repository: options.repoSlug,
    prNumber: options.prNumber,
    headSha: options.headSha,
    runId: options.runId,
    slotId: options.slotId,
    invocationId: options.invocationId,
  };
}

function credentialedSourceTerminal(options: {
  identity: PackGptSourceIdentity;
  resolution: Extract<PackGptSourceCommentResolution, { kind: 'credentialed' }>;
  browserTerminal?: GptTerminalTurnResult | null;
  result?: ProcessResult;
  authority?: 'credentialed_github' | 'harness_fixture';
}): GptTerminalTurnResult {
  return {
    schema: 'turn-result/v1',
    state: 'ok',
    scope: 'none',
    cause: 'github_source_comment_credentialed',
    invocation_id: options.identity.invocationId,
    send_count: Math.max(1, Number(options.browserTerminal?.send_count ?? 1)),
    source_comment_authority: options.authority ?? 'credentialed_github',
    source_comment_receipt: options.resolution.receipt,
    ...(options.browserTerminal ? { browser_terminal: options.browserTerminal } : {}),
    ...(options.result ? {
      process_exit_code: options.result.exitCode,
      process_timed_out: options.result.timedOut,
      process_cancelled: options.result.cancelled,
    } : {}),
  };
}

function hasCredentialedGptSourceAuthority(run: PackReviewRunRecord): boolean {
  const round = run.reviewRound;
  if (!round || round.reviewer !== 'gpt') return true;
  const repository = trim(run.canonicalRepository);
  if (!repository) return false;
  for (const slot of round.sourceSlots) {
    if (slot.terminalClass !== 'complete_clean' && slot.terminalClass !== 'complete_findings') continue;
    const invocationId = trim(slot.invocationId);
    const terminal = slot.terminalResult && typeof slot.terminalResult === 'object' && !Array.isArray(slot.terminalResult)
      ? slot.terminalResult as Record<string, unknown>
      : null;
    if (!terminal || !invocationId || trim(terminal.invocation_id) !== invocationId) return false;
    const authority = trim(terminal.source_comment_authority);
    const acceptedAuthority = authority === 'credentialed_github'
      || (process.env.OPK_VITEST_HARNESS === '1' && authority === 'harness_fixture');
    if (!acceptedAuthority) return false;
    const receipt = terminal.source_comment_receipt
      && typeof terminal.source_comment_receipt === 'object'
      && !Array.isArray(terminal.source_comment_receipt)
      ? terminal.source_comment_receipt as Record<string, unknown>
      : null;
    if (!receipt) return false;
    const commentId = receipt.commentId;
    const validCommentId = (typeof commentId === 'number' && Number.isInteger(commentId) && commentId > 0)
      || (typeof commentId === 'string' && Boolean(commentId.trim()));
    if (!validCommentId
      || trim(receipt.repository).toLowerCase() !== repository.toLowerCase()
      || Number(receipt.prNumber) !== run.prNumber
      || trim(receipt.headSha).toLowerCase() !== run.targetSha.toLowerCase()
      || trim(receipt.runId) !== run.id
      || trim(receipt.slotId) !== slot.slotId
      || trim(receipt.invocationId) !== invocationId
      || !trim(receipt.commentUrl)
      || !trim(receipt.actorLogin)
      || !trim(receipt.createdAt)
      || trim(receipt.createdAt) !== trim(receipt.updatedAt)
      || !/^[0-9a-f]{64}$/i.test(trim(receipt.bodySha256))) {
      return false;
    }
  }
  return true;
}

function assertCredentialedGptSourceAuthority(run: PackReviewRunRecord): void {
  if (!hasCredentialedGptSourceAuthority(run)) {
    throw new Error(`gpt_source_authority_missing_or_invalid:${run.id}`);
  }
}

function failedSourceCommentTerminal(options: {
  resolution: Exclude<PackGptSourceCommentResolution, { kind: 'credentialed' }>;
  browserTerminal?: GptTerminalTurnResult | null;
  result: ProcessResult;
}): Record<string, unknown> {
  const reconciliation = {
    source_comment_reconciliation: options.resolution.kind,
    source_comment_reason: options.resolution.reason,
    process_exit_code: options.result.exitCode,
    process_timed_out: options.result.timedOut,
    process_cancelled: options.result.cancelled,
  };
  return options.browserTerminal
    ? { ...options.browserTerminal, ...reconciliation }
    : {
        exitCode: options.result.exitCode,
        stderr: options.result.stderr,
        ...reconciliation,
      };
}

function harnessSourceResolution(
  identity: PackGptSourceIdentity,
  stdout: string,
  browserTerminal: GptTerminalTurnResult | null,
): PackGptSourceCommentResolution {
  if (!browserTerminal || browserTerminal.state !== 'ok' || browserTerminal.send_count < 1) {
    return { kind: 'missing', reason: 'harness_source_comment_missing' };
  }
  try {
    const payload = parseReviewPayload(stdout);
    const timestamp = new Date().toISOString();
    return {
      kind: 'credentialed',
      payload: payload as unknown as Extract<PackGptSourceCommentResolution, { kind: 'credentialed' }>['payload'],
      receipt: {
        ...identity,
        commentId: `fixture-${identity.slotId}-${identity.invocationId}`,
        commentUrl: `https://example.invalid/${identity.repository}/pull/${identity.prNumber}#fixture-${identity.slotId}`,
        actorLogin: 'fixture-browser-gpt',
        createdAt: timestamp,
        updatedAt: timestamp,
        bodySha256: '0'.repeat(64),
      },
    };
  } catch {
    return { kind: 'missing', reason: 'harness_source_comment_missing' };
  }
}

async function runGptSourceBatch(options: {
  run: PackReviewRunRecord;
  round: PackReviewGptRoundRecord;
  reviewerPath: string;
  trustedPackRoot: string;
  reviewTargetRoot: string;
  baseRef: string;
  target: {
    prNumber: number;
    headSha: string;
    issueNumber?: number;
    sessionId: string;
    repoSlug: string;
    sourceRepoRoot: string;
  };
  budgetLedger: ReviewerBudgetLedger;
  projectId: string;
  storeRoot: string;
  input: StartInput;
  carryoverBundlePath: string;
  frozenScope: ResolvedScopeContext;
}): Promise<ReviewPayload> {
  const admissionInterval = process.env.OPK_VITEST_HARNESS === '1'
    ? 0
    : PACK_REVIEW_GPT_SOURCE_ADMISSION_INTERVAL_MS;
  let nextAdmissionAt = 0;
  let admissionTail = Promise.resolve();
  let credentialedSourceCount = 0;
  const admit = async (): Promise<number> => {
    let release!: () => void;
    const predecessor = admissionTail;
    admissionTail = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    await predecessor;
    const remaining = nextAdmissionAt - Date.now();
    if (remaining > 0) await new Promise<void>((resolveWait) => setTimeout(resolveWait, remaining));
    const startedAt = Date.now();
    nextAdmissionAt = startedAt + admissionInterval;
    release();
    return startedAt;
  };
  const sourceTransport = options.input.fixtureGptSourceCommentTransport
    ?? (process.env.OPK_VITEST_HARNESS === '1'
      ? undefined
      : createPackGptSourceCommentTransport({
          repoRoot: options.target.sourceRepoRoot,
          repoSlug: options.target.repoSlug,
          prNumber: options.target.prNumber,
        }));

  const outcomes = await Promise.all(options.round.sourceSlots.map(async (planned) => {
    const slotId = planned.slotId;
    let round = options.round;
    let attemptOrdinal = 1;
    let invocationId = randomUUID();
    const markInvocationStarted = async (admissionStartedAt: number): Promise<void> => {
      round = updateGptRoundSlot(options.run.id, round, slotId, {
        lifecycle: 'invocation_started',
        admissionStartedAtUtc: new Date(admissionStartedAt).toISOString(),
        attemptOrdinal,
        invocationId,
      }, { projectId: options.projectId, storeRoot: options.storeRoot });
      if (options.input.fixtureAfterGptInvocationBound) {
        await options.input.fixtureAfterGptInvocationBound({ slotId, attemptOrdinal, invocationId, round });
      }
    };
    await markInvocationStarted(await admit());
    let invocation: { result: ProcessResult; resolvedReviewer: PackReviewer | null };
    while (true) {
      try {
        const fixtureAttempts = options.input.fixtureReviewBySourceSlot?.[slotId];
        const fixtureAttempt = fixtureAttempts?.[attemptOrdinal - 1] ?? fixtureAttempts?.at(-1);
        invocation = await invokeReviewer({
          reviewerPath: options.reviewerPath,
          trustedPackRoot: options.trustedPackRoot,
          reviewTargetRoot: options.reviewTargetRoot,
          baseRef: options.baseRef,
          prNumber: options.target.prNumber,
          issueNumber: options.target.issueNumber,
          sessionId: options.target.sessionId,
          budgetLedger: options.budgetLedger,
          runId: options.run.id,
          projectId: options.projectId,
          storeRoot: options.storeRoot,
          fixtureReviewStdout: fixtureAttempt?.stdout ?? options.input.fixtureReviewStdout,
          fixtureReviewExitCode: fixtureAttempt?.exitCode ?? options.input.fixtureReviewExitCode,
          fixtureReviewTimedOut: fixtureAttempt?.timedOut ?? options.input.fixtureReviewTimedOut,
          fixtureReviewerLayerOverrides: options.input.fixtureReviewerLayerOverrides,
          fixtureEmulateWin32Selector: options.input.fixtureEmulateWin32Selector,
          carryoverBundlePath: options.carryoverBundlePath,
          headSha: options.target.headSha,
          sourceSlotId: slotId,
          attemptOrdinal,
          invocationId,
          frozenScope: options.frozenScope,
        });
      } catch (error) {
        invocation = {
          resolvedReviewer: 'gpt',
          result: {
            outcome: 'exit' as const,
            ok: false,
            exitCode: null,
            signal: null,
            stdout: '',
            stderr: describeError(error),
            timedOut: false,
            cancelled: false,
          },
        };
        break;
      }
      if (process.env.OPK_VITEST_HARNESS === '1' && !sourceTransport) {
        invocation = {
          ...invocation,
          result: bindHarnessFixtureTerminalInvocation(invocation.result, invocationId),
        };
      }
      if (!(attemptOrdinal === 1
        && isRetryablePackReviewZeroSendCollision(invocation.result, invocationId))) break;
      attemptOrdinal = 2;
      invocationId = randomUUID();
      await markInvocationStarted(await admit());
    }

    const browserTerminal = parseLastGptTerminalTurnResult(invocation.result.stdout);
    const identity = gptSourceIdentity({
      repoSlug: options.target.repoSlug,
      prNumber: options.target.prNumber,
      headSha: options.target.headSha,
      runId: options.run.id,
      slotId,
      invocationId,
    });

    let payload: ReviewPayload | undefined;
    let terminalClass: string;
    let terminalResult: Record<string, unknown>;
    const terminalBoundToInvocation = browserTerminal?.invocation_id === invocationId;
    const sourceMayHaveBeenPublished = !browserTerminal
      || !terminalBoundToInvocation
      || browserTerminal.send_count >= 1;
    if (sourceMayHaveBeenPublished) {
      let resolution: PackGptSourceCommentResolution;
      try {
        if (options.input.fixtureBeforeGptSourceCommentCensus) {
          await options.input.fixtureBeforeGptSourceCommentCensus({
            slotId,
            attemptOrdinal,
            invocationId,
            identity,
          });
        }
        if (!(process.env.OPK_VITEST_HARNESS === '1' && !sourceTransport)) {
          await assertBoundHeadStillCurrent({
            repoRoot: options.target.sourceRepoRoot,
            repoSlug: options.target.repoSlug,
            prNumber: options.target.prNumber,
            boundHeadSha: options.target.headSha,
            boundIssueNumber: options.target.issueNumber,
            fixturePostReviewHeadSha: options.input.fixturePostReviewHeadSha ?? options.input.fixtureCurrentPrHeadSha,
            fixturePostReviewPrBody: options.input.fixturePostReviewPrBody
              ?? options.input.fixturePrBodyAfterClaim
              ?? options.input.fixturePrBody,
          });
        }
        resolution = sourceTransport
          ? await resolvePackGptSourceComment({ identity, transport: sourceTransport })
          : harnessSourceResolution(identity, invocation.result.stdout, browserTerminal);
      } catch (error) {
        resolution = { kind: 'conflict', reason: `source_comment_head_or_census_failed:${describeError(error)}` };
      }
      if (resolution.kind === 'credentialed') {
        payload = resolution.payload as unknown as ReviewPayload;
        terminalClass = payload.verdict === 'clean' && payload.findingCount === 0
          ? 'complete_clean'
          : 'complete_findings';
        terminalResult = credentialedSourceTerminal({
          identity,
          resolution,
          browserTerminal,
          result: invocation.result,
          authority: sourceTransport ? 'credentialed_github' : 'harness_fixture',
        });
        credentialedSourceCount += 1;
        if (process.env.OPK_VITEST_HARNESS === '1'
          && options.input.fixtureCrashAfterGptSourceCredentialedCount === credentialedSourceCount) {
          throw new Error(GPT_SOURCE_FIXTURE_CRASH_REASON);
        }
      } else {
        terminalClass = terminalClassForGptResult(invocation.result, browserTerminal);
        terminalResult = failedSourceCommentTerminal({
          resolution,
          browserTerminal,
          result: invocation.result,
        });
      }
    } else {
      terminalClass = terminalClassForGptResult(invocation.result, browserTerminal);
      if (attemptOrdinal === 2
        && isRetryablePackReviewZeroSendCollision(invocation.result, invocationId)) {
        terminalClass = 'explicit_refusal:zero_send_collision_exhausted';
      }
      terminalResult = browserTerminal
        ? {
            ...browserTerminal,
            process_exit_code: invocation.result.exitCode,
            process_timed_out: invocation.result.timedOut,
            process_cancelled: invocation.result.cancelled,
          }
        : {
            exitCode: invocation.result.exitCode,
            stderr: invocation.result.stderr,
            process_exit_code: invocation.result.exitCode,
            process_timed_out: invocation.result.timedOut,
            process_cancelled: invocation.result.cancelled,
          };
    }

    round = updateGptRoundSlot(options.run.id, round, slotId, {
      lifecycle: 'terminal',
      attemptOrdinal,
      invocationId,
      terminalClass,
      terminalResult,
      ...(payload ? { payload } : {}),
    }, { projectId: options.projectId, storeRoot: options.storeRoot });
    if (options.input.fixtureAfterGptSourceSlotTerminal) {
      await options.input.fixtureAfterGptSourceSlotTerminal({ slotId, round });
    }
    return { slot: round.sourceSlots.find((slot) => slot.slotId === slotId)!, payload };
  }));

  const findings: ReviewPayloadFinding[] = [];
  for (const outcome of outcomes) {
    if (!outcome.payload) continue;
    findings.push(...outcome.payload.findings.map((finding) => ({
      ...finding,
      sourceSlotId: outcome.slot.slotId,
    })));
  }
  return {
    verdict: findings.length > 0 ? 'findings' : 'clean',
    findingCount: findings.length,
    findings,
  };
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

async function findUnresolvedSameHeadRepositoryIdentity(options: {
  projectId: string;
  storeRoot: string;
  prNumber: number;
  headSha: string;
  resolveSlug: (repoRoot: string) => Promise<string>;
}): Promise<{ reason: 'repository_identity_unresolved' | 'repository_identity_ambiguous'; runId: string } | null> {
  const records = listPackReviewRunRecordsRaw({
    projectId: options.projectId,
    storeRoot: options.storeRoot,
  }).filter((record) => record.prNumber === options.prNumber && record.targetSha === options.headSha);
  for (const record of records) {
    const identity = await resolvePackReviewRunCanonicalRepository(record, options.resolveSlug);
    if (!identity.ok) {
      return {
        reason: identity.reason === 'legacy_repository_ambiguous'
          ? 'repository_identity_ambiguous'
          : 'repository_identity_unresolved',
        runId: record.id,
      };
    }
  }
  return null;
}

interface GptSourceRecoveryResult {
  recovered: boolean;
  reason: string;
  hydratedSourceCount: number;
  usableSourceCount: number;
  graceExpired: boolean;
  nextAction?: string;
}

async function recoverStaleGptSourceComments(options: {
  run: PackReviewRunRecord;
  input: ReconcileStalePackReviewRunsInput;
  projectId: string;
  storeRoot: string;
  repoSlug: string;
}): Promise<GptSourceRecoveryResult> {
  const initialRound = options.run.reviewRound;
  if (!initialRound || initialRound.reviewer !== 'gpt') {
    return {
      recovered: false,
      reason: 'not_gpt_round',
      hydratedSourceCount: 0,
      usableSourceCount: 0,
      graceExpired: true,
    };
  }
  if (initialRound.settledSourceCount !== undefined || hasPersistedPackReviewVerdict(options.run)) {
    return {
      recovered: false,
      reason: 'gpt_round_already_settled',
      hydratedSourceCount: 0,
      usableSourceCount: gptUsableSourceCount(initialRound),
      graceExpired: true,
    };
  }
  if (process.env.OPK_VITEST_HARNESS === '1' && !options.input.fixtureGptSourceCommentTransport) {
    return {
      recovered: false,
      reason: 'fixture_source_transport_missing',
      hydratedSourceCount: 0,
      usableSourceCount: gptUsableSourceCount(initialRound),
      graceExpired: gptRoundGraceExpired(options.run),
    };
  }

  let currentHead: string;
  try {
    currentHead = options.input.fixtureCurrentPrHeadSha
      ?? await resolveCurrentPrHead(options.input.sourceRepoRoot, options.repoSlug, options.run.prNumber);
  } catch (error) {
    return {
      recovered: false,
      reason: `gpt_source_unavailable:${describeError(error)}`,
      hydratedSourceCount: 0,
      usableSourceCount: gptUsableSourceCount(initialRound),
      graceExpired: gptRoundGraceExpired(options.run),
      nextAction: 'rerun scoped reconcile when GitHub is reachable',
    };
  }
  if (currentHead.toLowerCase() !== options.run.targetSha.toLowerCase()) {
    return {
      recovered: false,
      reason: 'gpt_source_head_changed',
      hydratedSourceCount: 0,
      usableSourceCount: gptUsableSourceCount(initialRound),
      graceExpired: gptRoundGraceExpired(options.run),
      nextAction: 'run review for the current PR head',
    };
  }
  const transport = options.input.fixtureGptSourceCommentTransport
    ?? createPackGptSourceCommentTransport({
      repoRoot: options.input.sourceRepoRoot,
      repoSlug: options.repoSlug,
      prNumber: options.run.prNumber,
    });
  let round = initialRound;
  let hydratedSourceCount = 0;
  const unresolved: string[] = [];
  for (const snapshotSlot of round.sourceSlots) {
    const currentSlot = round.sourceSlots.find((slot) => slot.slotId === snapshotSlot.slotId)!;
    if (currentSlot.lifecycle === 'terminal') continue;
    const invocationId = trim(currentSlot.invocationId);
    if (currentSlot.lifecycle !== 'invocation_started' || !invocationId) {
      unresolved.push(`${currentSlot.slotId}:not_started`);
      continue;
    }
    const identity = gptSourceIdentity({
      repoSlug: options.repoSlug,
      prNumber: options.run.prNumber,
      headSha: options.run.targetSha,
      runId: options.run.id,
      slotId: currentSlot.slotId,
      invocationId,
    });
    let resolution: PackGptSourceCommentResolution;
    try {
      resolution = await resolvePackGptSourceComment({ identity, transport });
    } catch (error) {
      unresolved.push(`${currentSlot.slotId}:${describeError(error)}`);
      continue;
    }
    if (resolution.kind !== 'credentialed') {
      unresolved.push(`${currentSlot.slotId}:${resolution.reason}`);
      continue;
    }
    const payload = resolution.payload as unknown as ReviewPayload;
    round = updateGptRoundSlot(options.run.id, round, currentSlot.slotId, {
      lifecycle: 'terminal',
      terminalClass: payload.verdict === 'clean' && payload.findingCount === 0
        ? 'complete_clean'
        : 'complete_findings',
      terminalResult: credentialedSourceTerminal({ identity, resolution }),
      payload,
    }, { projectId: options.projectId, storeRoot: options.storeRoot });
    hydratedSourceCount += 1;
  }

  let finalHead: string;
  try {
    finalHead = options.input.fixtureCurrentPrHeadSha
      ?? await resolveCurrentPrHead(options.input.sourceRepoRoot, options.repoSlug, options.run.prNumber);
  } catch (error) {
    return {
      recovered: false,
      reason: `gpt_source_unavailable_after_census:${describeError(error)}`,
      hydratedSourceCount,
      usableSourceCount: gptUsableSourceCount(round),
      graceExpired: gptRoundGraceExpired({ ...options.run, reviewRound: round }),
      nextAction: 'rerun scoped reconcile when GitHub is reachable',
    };
  }
  if (finalHead.toLowerCase() !== options.run.targetSha.toLowerCase()) {
    return {
      recovered: false,
      reason: 'gpt_source_head_changed_after_census',
      hydratedSourceCount,
      usableSourceCount: gptUsableSourceCount(round),
      graceExpired: gptRoundGraceExpired({ ...options.run, reviewRound: round }),
      nextAction: 'run review for the current PR head',
    };
  }

  const persisted = getPackReviewRun(options.run.id, {
    projectId: options.projectId,
    storeRoot: options.storeRoot,
  }) ?? { ...options.run, reviewRound: round };
  round = persisted.reviewRound ?? round;
  const usableSourceCount = gptUsableSourceCount(round);
  const graceExpired = gptRoundGraceExpired(persisted);
  const requiredSourceCount = round.cardinality >= 3
    ? (graceExpired ? 2 : round.cardinality)
    : round.cardinality;
  if (usableSourceCount < requiredSourceCount) {
    const reason = round.cardinality >= 3 && !graceExpired
      ? `gpt_sources_waiting_for_grace:${usableSourceCount}/${round.cardinality}`
      : `gpt_sources_incomplete_after_grace:${usableSourceCount}/${round.cardinality}`;
    return {
      recovered: false,
      reason,
      hydratedSourceCount,
      usableSourceCount,
      graceExpired,
      nextAction: round.cardinality >= 3 && !graceExpired
        ? 'rerun scoped reconcile after the shared grace threshold or when the missing source publishes'
        : `reconcile or retry the missing source work (${unresolved.join(', ') || 'missing source comment'})`,
    };
  }

  if (round.cardinality >= 3) {
    round = {
      ...round,
      settledSourceCount: usableSourceCount,
    };
    updatePackReviewRun(options.run.id, { reviewRound: round }, {
      projectId: options.projectId,
      storeRoot: options.storeRoot,
    });
    round = getPackReviewRun(options.run.id, {
      projectId: options.projectId,
      storeRoot: options.storeRoot,
    })?.reviewRound ?? round;
  }

  const findings: ReviewPayloadFinding[] = [];
  for (const slot of round.sourceSlots) {
    if (slot.lifecycle !== 'terminal'
      || (slot.terminalClass !== 'complete_clean' && slot.terminalClass !== 'complete_findings')) continue;
    const payload = slot.payload as ReviewPayload;
    findings.push(...payload.findings.map((finding) => ({ ...finding, sourceSlotId: slot.slotId })));
  }
  const aggregate: ReviewPayload = {
    verdict: findings.length > 0 ? 'findings' : 'clean',
    findingCount: findings.length,
    findings,
  };
  const persistedBeforeAggregate = getPackReviewRun(options.run.id, {
    projectId: options.projectId,
    storeRoot: options.storeRoot,
  });
  if (!persistedBeforeAggregate) {
    return {
      recovered: false,
      reason: 'recovered_run_missing_before_aggregate',
      hydratedSourceCount,
      usableSourceCount,
      graceExpired,
      nextAction: 'rerun scoped reconcile',
    };
  }
  assertCredentialedGptSourceAuthority(persistedBeforeAggregate);
  validatePersistedPackReviewGptAggregate(options.run.id, {
    reviewVerdict: aggregate.verdict,
    findingCount: aggregate.findingCount,
    findings: aggregate.findings,
  }, { projectId: options.projectId, storeRoot: options.storeRoot });
  const classification = classifyPackReviewPayload(aggregate);
  setPackReviewRunTerminal(options.run.id, classification.terminalStatus, {
    reviewVerdict: aggregate.verdict,
    findingCount: aggregate.findingCount,
    findings: aggregate.findings,
    reviewRound: round,
    journalOutcome: {
      state: 'persisted',
      recordedAtUtc: new Date().toISOString(),
      reason: usableSourceCount < round.cardinality
        ? 'gpt_source_comments_recovered_degraded'
        : 'gpt_source_comments_recovered',
      idempotencyKey: `verdict:${options.run.id}:${options.run.targetSha}`,
      attempts: 1,
    },
  }, { projectId: options.projectId, storeRoot: options.storeRoot });
  return {
    recovered: true,
    reason: usableSourceCount < round.cardinality
      ? 'gpt_source_comments_recovered_degraded_for_resume'
      : 'gpt_source_comments_recovered_for_resume',
    hydratedSourceCount,
    usableSourceCount,
    graceExpired,
  };
}

async function resumeRecoveredGptDelivery(options: {
  run: PackReviewRunRecord;
  input: ReconcileStalePackReviewRunsInput;
  projectId: string;
  storeRoot: string;
  repoSlug: string;
  writeRequiredStatus: PackReviewRequiredStatusWriter;
}): Promise<Awaited<ReturnType<typeof resumePackReviewVerdictDelivery>>> {
  const payload = packReviewJournaledPayload(options.run);
  if (!payload) throw new Error(`recovered pack review run ${options.run.id} has no journaled payload`);
  const typedPayload = validatePersistedGptReviewPayload(
    options.run.id,
    payload as ReviewPayload,
    { projectId: options.projectId, storeRoot: options.storeRoot },
  );
  const currentHead = options.input.fixtureCurrentPrHeadSha
    ?? await resolveCurrentPrHead(options.input.sourceRepoRoot, options.repoSlug, options.run.prNumber);
  if (currentHead.toLowerCase() !== options.run.targetSha.toLowerCase()) {
    throw new Error('recovered GPT source head changed before final delivery');
  }
  const reviewTransport = createGithubReviewTransport({
    repoRoot: options.input.sourceRepoRoot,
    repoSlug: options.repoSlug,
    prNumber: options.run.prNumber,
    fixtureReviewId: options.input.fixtureGithubReviewId,
    fixtureTransport: options.input.fixtureGithubReviewTransport,
  });
  return resumePackReviewVerdictDelivery({
    run: options.run,
    projectId: options.projectId,
    storeRoot: options.storeRoot,
    postGithubComment: async () => {
      const posted = await postGithubReview({
        repoRoot: options.input.sourceRepoRoot,
        repoSlug: options.repoSlug,
        prNumber: options.run.prNumber,
        headSha: options.run.targetSha,
        run: options.run,
        payload: typedPayload,
        projectId: options.projectId,
        storeRoot: options.storeRoot,
        transport: reviewTransport,
      });
      return { id: posted.id, url: posted.url, event: 'COMMENT' };
    },
    writeRequiredStatus: options.writeRequiredStatus,
    notifyWorker: options.input.fixtureWorkerNotifier ?? ((request) => sendPackReviewWorkerNotification({
      trustedPackRoot: options.run.trustedPackRoot,
      sessionId: options.run.linkedSessionId,
      request,
    })),
  });
}

async function commitRecoveredGptAuthority(options: {
  run: PackReviewRunRecord;
  input: ReconcileStalePackReviewRunsInput;
  projectId: string;
  storeRoot: string;
  repoSlug: string;
}): Promise<PackReviewAuthorityDocument> {
  const round = options.run.reviewRound;
  if (!round || round.reviewer !== 'gpt') {
    throw new Error(`recovered pack review run ${options.run.id} has no GPT round`);
  }
  if (options.run.automaticBudgetDisposition !== 'consume') {
    throw new Error('legacy non-consuming GPT recovery cannot create new review authority');
  }
  const journaled = packReviewJournaledPayload(options.run);
  if (!journaled) throw new Error(`recovered pack review run ${options.run.id} has no journaled payload`);
  const payload = validatePersistedGptReviewPayload(
    options.run.id,
    journaled as ReviewPayload,
    { projectId: options.projectId, storeRoot: options.storeRoot },
  );
  const authorityOptions: PackReviewAuthorityOptions = { storeRoot: options.storeRoot };
  let authority = readPackReviewAuthority(options.run.prNumber, authorityOptions);
  if (!authority) throw new Error(`recovered pack review authority missing for PR #${options.run.prNumber}`);
  if (authority.currentHeadSha !== options.run.targetSha) {
    throw new Error('recovered pack review authority head does not match the recovered run');
  }
  if (authority.cycle?.frozenTier !== round.tier) {
    throw new Error('recovered pack review tier does not match frozen authority');
  }

  const target = {
    prNumber: options.run.prNumber,
    headSha: options.run.targetSha,
    issueNumber: round.issueNumber,
    repoSlug: options.repoSlug,
    sourceRepoRoot: options.input.sourceRepoRoot,
  };
  const recoveryStart: StartInput = {
    projectId: options.projectId,
    prNumber: options.run.prNumber,
    headSha: options.run.targetSha,
    sourceRepoRoot: options.input.sourceRepoRoot,
    baseRef: options.input.baseRef ?? DEFAULT_BASE_REF,
    fixtureCurrentPrHeadSha: options.input.fixtureCurrentPrHeadSha,
    fixtureIssueBody: options.input.fixtureIssueBody,
    fixtureIssueNumber: round.issueNumber,
    fixtureChangedPaths: options.input.fixtureChangedPaths,
    fixtureBoundIssueSnapshotBytes: options.input.fixtureBoundIssueSnapshotBytes,
  };
  const authoritative = await resolveAuthoritativeReviewContext(
    recoveryStart,
    target,
    options.projectId,
  );
  if (authoritative.tier !== round.tier
      || authoritative.snapshotDigest !== round.boundIssueSnapshotDigest) {
    throw new Error('recovered GPT round no longer matches its authoritative Issue snapshot');
  }

  const existingTerminal = authority.terminal;
  if (existingTerminal?.targetSha === options.run.targetSha
      && existingTerminal.runId !== options.run.id) {
    throw new Error('another same-head pack review terminal is already authoritative');
  }
  if (existingTerminal?.runId === options.run.id) return authority;

  authority = advancePackReviewAuthority(
    authority,
    'review_or_bundle_staged',
    options.run.prNumber,
    authorityOptions,
  );
  authority = commitPackReviewTerminal({
    prNumber: options.run.prNumber,
    expectedTransitionSeq: authority.transitionSeq,
    terminal: terminalV2FromPayload({
      runId: options.run.id,
      targetSha: options.run.targetSha,
      verdict: payload.verdict,
      findingCount: payload.findingCount,
      findings: payload.findings,
      automaticBudgetDisposition: options.run.automaticBudgetDisposition,
    }),
    status: classifyPackReviewPayload(payload).terminalStatus,
    findingCount: payload.findingCount,
    options: authorityOptions,
  });
  const trusted = resolveTrustedRunnerPaths();
  return commitAtCapTriage({
    start: recoveryStart,
    target,
    projectId: options.projectId,
    baseRef: options.input.baseRef ?? DEFAULT_BASE_REF,
    trustedPackRoot: trusted.trustedPackRoot,
    storeRoot: options.storeRoot,
    authority,
    payload,
  });
}

async function settleRecoveredGptDelivery(options: {
  run: PackReviewRunRecord;
  input: ReconcileStalePackReviewRunsInput;
  projectId: string;
  storeRoot: string;
  repoSlug: string;
  writeRequiredStatus: PackReviewRequiredStatusWriter;
}): Promise<Awaited<ReturnType<typeof resumePackReviewVerdictDelivery>>> {
  await commitRecoveredGptAuthority(options);
  const latestRun = getPackReviewRun(options.run.id, {
    projectId: options.projectId,
    storeRoot: options.storeRoot,
  }) ?? options.run;
  const resumed = await resumeRecoveredGptDelivery({ ...options, run: latestRun });
  const authorityOptions: PackReviewAuthorityOptions = { storeRoot: options.storeRoot };
  const currentAuthority = readPackReviewAuthority(options.run.prNumber, authorityOptions);
  if (!currentAuthority
      || currentAuthority.currentHeadSha !== options.run.targetSha
      || currentAuthority.terminal?.runId !== options.run.id) {
    throw new Error('pack review authority changed before recovered publication');
  }
  const publicationStatus = resumed.reason === 'completed' ? 'succeeded' : 'failed';
  const publicationDigest = sha256Bytes(JSON.stringify({
    status: resumed.status,
    deliveryReason: resumed.reason,
    githubReviewId: resumed.githubReviewId,
    githubReviewUrl: resumed.githubReviewUrl,
  }));
  const existing = currentAuthority.publication;
  if (!(existing?.headSha === options.run.targetSha
      && existing.terminalRunId === options.run.id
      && existing.status === publicationStatus
      && existing.publicationDigest === publicationDigest)) {
    recordPackReviewPublication({
      prNumber: options.run.prNumber,
      expectedTransitionSeq: currentAuthority.transitionSeq,
      nextPhase: publicationStatus === 'succeeded' ? 'external_published' : currentAuthority.phase,
      publication: {
        headSha: options.run.targetSha,
        terminalRunId: options.run.id,
        status: publicationStatus,
        publicationDigest,
        recordedAtUtc: new Date().toISOString(),
      },
      options: authorityOptions,
    });
  }
  return resumed;
}

async function reconcileFinalCapSettlement(input: ReconcileStalePackReviewRunsInput, options: {
  projectId: string;
  storeRoot: string;
  repoSlug: string;
}): Promise<Record<string, unknown> | null> {
  const prNumber = input.prNumber;
  if (!prNumber) return null;
  let authority = readPackReviewAuthority(prNumber, { storeRoot: options.storeRoot });
  if (!authority?.cycle || authority.cycle.state !== 'at_cap_continuation_required') return null;
  const currentHead = input.fixtureCurrentPrHeadSha
    ?? await resolveCurrentPrHead(input.sourceRepoRoot, options.repoSlug, prNumber);
  if (currentHead.toLowerCase() !== authority.currentHeadSha.toLowerCase()) {
    return {
      prNumber,
      finalCapSettlement: true,
      settled: false,
      reason: 'final_cap_settlement_head_not_observed',
      nextAction: 'observe the current PR head, then rerun scoped reconcile',
    };
  }
  const workerOwned = authority.smokeOrdering?.workerOwned;
  if (workerOwned?.headSha !== authority.currentHeadSha || workerOwned.status !== 'passed') {
    return {
      prNumber,
      headSha: authority.currentHeadSha,
      finalCapSettlement: true,
      settled: false,
      reason: 'final_cap_settlement_worker_smoke_required',
      nextAction: 'run worker-owned smoke on the exact current head, then rerun scoped reconcile',
    };
  }
  const priorRun = authority.terminal?.runId
    ? getPackReviewRun(authority.terminal.runId, { projectId: options.projectId, storeRoot: options.storeRoot })
    : null;
  if (!priorRun || priorRun.reviewVerdict !== 'findings' || !authority.terminal) {
    return {
      prNumber,
      headSha: authority.currentHeadSha,
      finalCapSettlement: true,
      settled: false,
      reason: 'final_cap_settlement_prior_findings_missing',
      nextAction: 'rerun or reconcile the final capped review before settling the fix head',
    };
  }

  let issueNumber = input.fixtureIssueNumber;
  let fixturePrBody: string | undefined;
  if (!issueNumber) {
    const target = await resolveCurrentPrTarget(input.sourceRepoRoot, options.repoSlug, prNumber);
    if (target.headSha !== authority.currentHeadSha) {
      return {
        prNumber,
        finalCapSettlement: true,
        settled: false,
        reason: 'final_cap_settlement_head_changed',
        nextAction: 'observe the current PR head and rerun scoped reconcile',
      };
    }
    fixturePrBody = target.body;
    issueNumber = extractClosingIssueNumber(target.body) ?? undefined;
  }
  if (!issueNumber) {
    return {
      prNumber,
      headSha: authority.currentHeadSha,
      finalCapSettlement: true,
      settled: false,
      reason: 'final_cap_settlement_issue_unresolved',
      nextAction: 'restore the PR closing Issue reference and rerun scoped reconcile',
    };
  }
  const settlementStart: StartInput = {
    projectId: options.projectId,
    prNumber,
    headSha: authority.currentHeadSha,
    sourceRepoRoot: input.sourceRepoRoot,
    baseRef: input.baseRef ?? DEFAULT_BASE_REF,
    fixtureCurrentPrHeadSha: input.fixtureCurrentPrHeadSha,
    fixtureIssueBody: input.fixtureIssueBody,
    fixtureIssueNumber: issueNumber,
    fixtureChangedPaths: input.fixtureChangedPaths,
    fixtureBoundIssueSnapshotBytes: input.fixtureBoundIssueSnapshotBytes,
    ...(fixturePrBody ? { fixturePrBody } : {}),
  };
  const target = {
    prNumber,
    headSha: authority.currentHeadSha,
    issueNumber,
    repoSlug: options.repoSlug,
    sourceRepoRoot: input.sourceRepoRoot,
  };
  try {
    await resolveAuthoritativeReviewContext(settlementStart, target, options.projectId);
    const trusted = resolveTrustedRunnerPaths();
    authority = await commitAtCapTriage({
      start: settlementStart,
      target,
      projectId: options.projectId,
      baseRef: input.baseRef ?? DEFAULT_BASE_REF,
      trustedPackRoot: trusted.trustedPackRoot,
      storeRoot: options.storeRoot,
      authority,
      payload: {
        verdict: 'findings',
        findingCount: priorRun.findingCount ?? priorRun.findings.length,
        findings: priorRun.findings as ReviewPayloadFinding[],
      },
      allowFinalSettlement: true,
    });
  } catch (error) {
    return {
      prNumber,
      headSha: authority.currentHeadSha,
      finalCapSettlement: true,
      settled: false,
      reason: `final_cap_settlement_incomplete:${describeError(error)}`,
      nextAction: 'fix the reported blocker, rerun worker-owned smoke if the head changed, then rerun scoped reconcile',
    };
  }
  const settled = authority.smokeOrdering?.reviewSettledHeadSha === authority.currentHeadSha;
  return {
    prNumber,
    headSha: authority.currentHeadSha,
    finalCapSettlement: true,
    settled,
    reason: settled
      ? 'final_cap_fix_settled'
      : authority.triage?.verdict === 'BLOCK'
        ? 'final_cap_settlement_blocked'
        : 'final_cap_settlement_incomplete',
    ...(settled ? {} : {
      nextAction: authority.triage?.verdict === 'BLOCK'
        ? 'resolve the blocking current-head evidence, rerun worker-owned smoke, then rerun scoped reconcile'
        : 'complete the current-head evidence requirements, then rerun scoped reconcile',
    }),
  };
}

export async function reconcileStalePackReviewRuns(
  input: ReconcileStalePackReviewRunsInput,
): Promise<{ ok: true; results: Array<Record<string, unknown>> }> {
  const projectId = trim(input.projectId) || DEFAULT_PROJECT_ID;
  const storeRoot = resolvePackReviewRunStoreRoot({ projectId, storeRoot: input.storeRoot });
  const repoSlug = trim(input.repoSlug);
  if (!repoSlug) throw new Error('pack review stale reconciliation requires a canonical repository slug');
  const resolveSlug = input.resolveRepositorySlug ?? resolveRepositorySlug;
  const bindRepositoryIdentity = async (record: PackReviewRunRecord): Promise<PackReviewRunRecord> => {
    if (record.canonicalRepository) return record;
    const identity = await resolvePackReviewRunCanonicalRepository(record, resolveSlug);
    return identity.ok ? { ...record, canonicalRepository: identity.slug } : record;
  };
  const readBoundRecords = async (): Promise<PackReviewRunRecord[]> => Promise.all(
    listPackReviewRunRecordsRaw({ projectId, storeRoot })
      .filter((record) => !input.prNumber || record.prNumber === input.prNumber)
      .map(bindRepositoryIdentity),
  );
  const records = await readBoundRecords();
  const results: Array<Record<string, unknown>> = [];
  const restoreLatestAuthority = async (
    staleRun: PackReviewRunRecord,
    writeRequiredStatus: PackReviewRequiredStatusWriter,
    forceRepublish = false,
  ) => {
    let restored: Awaited<ReturnType<typeof restorePackReviewAuthoritativeRequiredStatus>> = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const currentOrder = resolvePackReviewRunOrder(await readBoundRecords(), staleRun);
      if (currentOrder.kind !== 'newer') {
        return {
          outcome: restored,
          authorityId: undefined,
          authorityProjection: undefined,
          reason: currentOrder.kind === 'ambiguous' ? currentOrder.reason : 'authority_not_newer',
        };
      }
      const selectedId = currentOrder.run.id;
      const selectedProjection = packReviewRequiredStatusProjectionKey(currentOrder.run);
      restored = await restorePackReviewAuthoritativeRequiredStatus({
        run: currentOrder.run,
        projectId,
        storeRoot,
        writeRequiredStatus,
        pauseAfterPendingWrite: input.fixturePauseAfterPendingRestoreWrite,
        forceRepublish,
      });
      if (input.fixturePauseAfterRestoreRead) {
        await input.fixturePauseAfterRestoreRead(currentOrder.run);
      }
      const afterWrite = resolvePackReviewRunOrder(await readBoundRecords(), staleRun);
      if (afterWrite.kind === 'newer') {
        const afterProjection = packReviewRequiredStatusProjectionKey(afterWrite.run);
        if (afterWrite.run.id !== selectedId || afterProjection !== selectedProjection) continue;
      }
      return {
        outcome: restored,
        authorityId: selectedId,
        authorityProjection: selectedProjection,
        reason: afterWrite.kind === 'ambiguous'
          ? afterWrite.reason
          : restored?.state === 'succeeded'
            ? 'newer_run_authoritative'
            : restored
              ? 'newer_run_restore_failed'
              : 'newer_authority_malformed',
      };
    }
    return {
      outcome: null,
      authorityId: undefined,
      authorityProjection: undefined,
      reason: 'newer_run_authority_race',
    };
  };
  const restoreAndSettleNewerAuthority = async (
    staleRun: PackReviewRunRecord,
    writeRequiredStatus: PackReviewRequiredStatusWriter,
  ) => {
    const needsSettlement = packReviewRequiredStatusNeedsStaleReconciliation(staleRun);
    const restoration = await restoreLatestAuthority(staleRun, writeRequiredStatus, needsSettlement);
    if (!needsSettlement
      || restoration.reason !== 'newer_run_authoritative'
      || restoration.outcome?.state !== 'succeeded') {
      return restoration;
    }
    if (input.fixturePauseBeforeAuthoritySettlement) {
      await input.fixturePauseBeforeAuthoritySettlement();
    }
    try {
      const marker = recordPackReviewNewerAuthorityReconciliation({
        projectId,
        storeRoot,
        run: staleRun,
        authorityGuard: (boundRecords) => {
          if (!restoration.authorityId || !restoration.authorityProjection) return false;
          const currentOrder = resolvePackReviewRunOrder(boundRecords, staleRun);
          return currentOrder.kind === 'newer'
            && currentOrder.run.id === restoration.authorityId
            && packReviewRequiredStatusProjectionKey(currentOrder.run)
              === restoration.authorityProjection;
        },
      });
      return { outcome: marker, reason: marker.reason };
    } catch (error) {
      return {
        outcome: null,
        reason: error instanceof Error && error.message === 'newer_run_authority_race'
          ? 'newer_run_authority_race'
          : 'newer_authority_settlement_persist_failed',
      };
    }
  };

  for (const candidate of records) {
    const activeStale = isPackReviewRunStale(candidate);
    const unfinishedTerminal = isPackReviewUnfinishedTerminalRun(candidate);
    const immediateActive = input.immediate === true
      && PACK_REVIEW_ACTIVE_STATUSES.has(candidate.status)
      && candidate.reviewRound?.reviewer === 'gpt';
    if (!activeStale && !unfinishedTerminal && !immediateActive) continue;

    const unresolvedIdentity = await findUnresolvedSameHeadRepositoryIdentity({
      projectId,
      storeRoot,
      prNumber: candidate.prNumber,
      headSha: candidate.targetSha,
      resolveSlug,
    });
    if (unresolvedIdentity) {
      results.push({
        runId: candidate.id,
        terminalized: false,
        statusReconciled: false,
        reason: unresolvedIdentity.reason,
      });
      continue;
    }

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

    if (unfinishedTerminal
        && run.reviewRound?.reviewer === 'gpt'
        && packReviewDeliveryNeedsResume(run)) {
      try {
        const resumed = await settleRecoveredGptDelivery({
          run,
          input,
          projectId,
          storeRoot,
          repoSlug,
          writeRequiredStatus: statusWriter,
        });
        results.push({
          runId: run.id,
          terminalized: false,
          statusReconciled: resumed.reason === 'completed',
          recovered: true,
          degraded: run.reviewRound?.settledSourceCount === 2,
          settledSourceCount: run.reviewRound?.settledSourceCount,
          reason: resumed.reason === 'completed'
            ? 'gpt_journaled_delivery_resumed'
            : `gpt_journaled_delivery_${resumed.reason}`,
          deliveryReason: resumed.reason,
          status: resumed.status,
          ...(resumed.githubReviewId !== undefined ? { githubReviewId: resumed.githubReviewId } : {}),
          ...(resumed.githubReviewUrl ? { githubReviewUrl: resumed.githubReviewUrl } : {}),
        });
      } catch (error) {
        results.push({
          runId: run.id,
          terminalized: false,
          statusReconciled: false,
          recovered: true,
          reason: `gpt_journaled_delivery_resume_failed:${describeError(error)}`,
          nextAction: 'fix the reported authority or delivery blocker, then rerun scoped reconcile',
        });
      }
      continue;
    }

    if (activeStale || immediateActive) {
      const recovery = await recoverStaleGptSourceComments({
        run,
        input,
        projectId,
        storeRoot,
        repoSlug,
      });
      if (recovery.recovered) {
        const recoveredRun = await bindRepositoryIdentity(
          getPackReviewRun(run.id, { projectId, storeRoot }) ?? run,
        );
        try {
          const resumed = await settleRecoveredGptDelivery({
            run: recoveredRun,
            input,
            projectId,
            storeRoot,
            repoSlug,
            writeRequiredStatus: statusWriter,
          });
          results.push({
            runId: run.id,
            terminalized: false,
            statusReconciled: resumed.reason === 'completed',
            recovered: true,
            degraded: recoveredRun.reviewRound?.settledSourceCount === 2,
            settledSourceCount: recoveredRun.reviewRound?.settledSourceCount,
            reason: resumed.reason === 'completed'
              ? 'gpt_source_comments_recovered_and_delivered'
              : `gpt_source_comments_recovered_delivery_${resumed.reason}`,
            deliveryReason: resumed.reason,
            status: resumed.status,
            ...(resumed.githubReviewId !== undefined ? { githubReviewId: resumed.githubReviewId } : {}),
            ...(resumed.githubReviewUrl ? { githubReviewUrl: resumed.githubReviewUrl } : {}),
          });
        } catch (error) {
          results.push({
            runId: run.id,
            terminalized: false,
            statusReconciled: false,
            recovered: true,
            reason: `gpt_source_comments_recovered_delivery_failed:${describeError(error)}`,
            nextAction: 'rerun scoped reconcile to resume final delivery',
          });
        }
        continue;
      }
      if (immediateActive && !activeStale) {
        results.push({
          runId: run.id,
          terminalized: false,
          statusReconciled: false,
          hydratedSourceCount: recovery.hydratedSourceCount,
          usableSourceCount: recovery.usableSourceCount,
          graceExpired: recovery.graceExpired,
          reason: recovery.reason,
          nextAction: recovery.nextAction ?? 'let the current review continue and rerun scoped reconcile if needed',
        });
        continue;
      }
      if (activeStale) {
        const terminalizationResult = terminalizePackReviewStaleRun(run.id, { projectId, storeRoot });
        terminalized = terminalizationResult.changed;
        run = await bindRepositoryIdentity(
          getPackReviewRun(run.id, { projectId, storeRoot }) ?? terminalizationResult.run,
        );
        if (recovery.nextAction) {
          results.push({
            runId: run.id,
            terminalized,
            statusReconciled: false,
            recoveryReason: recovery.reason,
            nextAction: recovery.nextAction,
          });
        }
      }
    }

    if (!isPackReviewUnfinishedTerminalRun(run)) continue;

    const currentOrder = resolvePackReviewRunOrder(await readBoundRecords(), run);
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
      const restoration = await restoreAndSettleNewerAuthority(run, statusWriter);
      results.push({
        runId: run.id,
        terminalized,
        statusReconciled: restoration.outcome?.state === 'succeeded',
        reason: restoration.reason,
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

    if (input.beforeStaleStatusWrite) await input.beforeStaleStatusWrite(run);

    const recordsBeforeStaleStatusWrite = await readBoundRecords();
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
      const restoration = await restoreAndSettleNewerAuthority(run, statusWriter);
      results.push({
        runId: run.id,
        terminalized,
        statusReconciled: restoration.outcome?.state === 'succeeded',
        reason: restoration.reason,
      });
      continue;
    }

    const authorizeStaleWrite = () => readBoundRecords().then((freshRecords) => (
      resolvePackReviewRunOrder(freshRecords, run).kind === 'none'
    ));
    const repairSupersededStaleWrite = async () => {
      const restoration = await restoreLatestAuthority(run, statusWriter, true);
      return { reason: restoration.reason };
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

  if (input.immediate && input.prNumber) {
    const settlement = await reconcileFinalCapSettlement(input, { projectId, storeRoot, repoSlug });
    if (settlement) results.push(settlement);
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
      return null;
    }
    return { replay, sourceCleanRunId: sourceRun.id };
  } catch {
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
  allowFinalSettlement?: boolean;
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
      if (!input.target.issueNumber) throw new Error('bound issue snapshot unavailable');
      const configuredSnapshotPath = trim(process.env.OPK_BOUND_ISSUE_SNAPSHOT_PATH);
      const resolvedSnapshot = resolveBoundIssueSnapshot({
        projectId: input.projectId,
        prNumber: input.target.prNumber,
        prHeadSha: input.target.headSha,
        issueNumber: input.target.issueNumber,
        storeDirOverride: process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR,
      });
      if (resolvedSnapshot.status !== 'found' || !resolvedSnapshot.snapshotPath) {
        throw new Error('bound issue snapshot unavailable');
      }
      if (configuredSnapshotPath
          && resolve(configuredSnapshotPath) !== resolve(resolvedSnapshot.snapshotPath)) {
        throw new Error('configured bound issue snapshot does not match authoritative artifact');
      }
      const snapshot = loadValidatedBoundSnapshotBody({
        projectId: input.projectId,
        prNumber: input.target.prNumber,
        prHeadSha: input.target.headSha,
        issueNumber: input.target.issueNumber,
        snapshotFilePath: configuredSnapshotPath || resolvedSnapshot.snapshotPath,
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
  const verdict = input.allowFinalSettlement
    && selection.kind === 'selected'
    && selection.verdict === 'PENDING_ARCHITECT'
    && selection.evidence?.predicateResult === 'no_intersection'
    ? 'DEFER'
    : selection.verdict;
  return commitPackReviewTriage({
    prNumber: input.target.prNumber,
    expectedTransitionSeq: current.transitionSeq,
    triage: {
      verdict,
      source: 'automatic',
      findingSnapshotDigest,
      committedAtUtc: new Date().toISOString(),
    },
    options: { storeRoot: input.storeRoot },
  });
}

export async function startPackReview(input: StartInput): Promise<Record<string, unknown>> {
  const operatorStart = directCliOperatorStarts.get(input);
  if (!operatorStart && OPERATOR_START_FIELDS.some((field) => (
    Object.prototype.hasOwnProperty.call(input as Record<string, unknown>, field)
  ))) {
    throw new Error('operator pack-review start inputs are accepted only from direct CLI arguments');
  }
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
  const target = await resolveTarget(input, trusted.trustedPackRoot, operatorStart);
  const storeRoot = resolvePackReviewRunStoreRoot({ projectId, storeRoot: input.storeRoot });
  const resolveSlug = input.fixtureResolveRepositorySlug
    ?? (process.env.OPK_VITEST_HARNESS === '1'
      ? async () => target.repoSlug
      : resolveRepositorySlug);
  const unresolvedIdentity = await findUnresolvedSameHeadRepositoryIdentity({
    projectId,
    storeRoot,
    prNumber: target.prNumber,
    headSha: target.headSha,
    resolveSlug,
  });
  if (unresolvedIdentity) {
    return {
      ok: false,
      created: false,
      reused: false,
      reason: unresolvedIdentity.reason,
      runId: unresolvedIdentity.runId,
      prNumber: target.prNumber,
      headSha: target.headSha,
      httpStatus: 409,
    };
  }

  const reviewer = resolvePackReviewerFromEnv(process.env, {
    layerOverrides: input.fixtureReviewerLayerOverrides,
    emulateWin32: input.fixtureEmulateWin32Selector,
  });
  if (!reviewer && process.env.OPK_VITEST_HARNESS !== '1') {
    throw new Error('pack review reviewer selector did not resolve');
  }

  const recoverableStaleGptFixture = process.env.OPK_VITEST_HARNESS === '1'
    && listPackReviewRunRecordsRaw({ projectId, storeRoot }).some((candidate) => (
      isPackReviewRunStale(candidate)
      && candidate.reviewRound?.reviewer === 'gpt'
      && candidate.reviewRound.sourceSlots.some((slot) => (
        slot.lifecycle === 'invocation_started' && Boolean(trim(slot.invocationId))
      ))
    ));
  await reconcileStalePackReviewRuns({
    repoSlug: target.repoSlug,
    sourceRepoRoot: target.sourceRepoRoot,
    projectId,
    storeRoot,
    prNumber: target.prNumber,
    fixtureCurrentPrHeadSha: input.fixtureCurrentPrHeadSha,
    fixtureGptSourceCommentTransport: input.fixtureGptSourceCommentTransport,
    ...(recoverableStaleGptFixture ? {
      fixtureGithubReviewId: input.fixtureGithubReviewId,
      fixtureGithubReviewTransport: input.fixtureGithubReviewTransport,
      fixtureRequiredStatusWriter: input.fixtureRequiredStatusWriter,
      fixtureWorkerNotifier: input.fixtureWorkerNotifier,
    } : {}),
    resolveRepositorySlug: resolveSlug,
    beforeStaleStatusWrite: input.fixtureBeforeStaleStatusWrite,
  });
  const claimMode = input.claimMode ?? 'acquire';
  const resumeCandidate = await findJournaledDeliveryResumeCandidate({
    projectId,
    storeRoot,
    prNumber: target.prNumber,
    headSha: target.headSha,
    repoSlug: target.repoSlug,
    sourceRepoRoot: target.sourceRepoRoot,
    resolveSlug,
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
  let terminalPersistenceAttempted = false;
  let carryover: { replay: CarryoverReplayResult; sourceCleanRunId: string } | null = null;
  let carryoverBundlePath = '';
  const recordUnfinishedTerminal = async (
    options: Parameters<typeof recordPackReviewUnfinishedTerminalStatus>[0],
  ) => {
    terminalPersistenceAttempted = true;
    await recordPackReviewUnfinishedTerminalStatus(options);
  };
  const recordFallbackProcessFailure = async (fallbackResult: ProcessResult): Promise<never> => {
    if (!run) throw new Error('fallback reviewer failure occurred before run creation');
    const writeRequiredStatus = input.fixtureRequiredStatusWriter ?? ((request) => publishPackReviewRequiredStatus({
      repoRoot: target.sourceRepoRoot,
      repoSlug: target.repoSlug,
      headSha: target.headSha,
      request,
    }));
    const timedOut = fallbackResult.timedOut;
    await recordUnfinishedTerminal({
      run,
      status: timedOut ? 'timed_out' : 'failed',
      failureReason: classifyPackReviewFailureReason(
        timedOut ? 'reviewer_process_timeout' : 'reviewer_process_failed',
      ),
      exitCode: fallbackResult.exitCode,
      projectId,
      storeRoot,
      writeRequiredStatus,
    });
    terminal = true;
    throw new Error(timedOut
      ? 'reviewer process timed out'
      : `reviewer process failed (exit ${String(fallbackResult.exitCode)})`);
  };
  const returnFallbackMalformed = async (error: unknown): Promise<Record<string, unknown>> => {
    if (!run) throw new Error('fallback reviewer malformed output occurred before run creation');
    const writeRequiredStatus = input.fixtureRequiredStatusWriter ?? ((request) => publishPackReviewRequiredStatus({
      repoRoot: target.sourceRepoRoot,
      repoSlug: target.repoSlug,
      headSha: target.headSha,
      request,
    }));
    const malformed = await recordMalformedPackReviewStatus({
      run,
      failureReason: describeError(error),
      projectId,
      storeRoot,
      writeRequiredStatus,
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
  };

  const claimSurface = target.operatorStart
    ? `operator_adjudicated;session-binding=advisory;issue=${target.issueNumber ?? 'unresolved'}`
    : (trim(input.surface) || 'pack-review-runner-manual');
  if (claimMode === 'acquire') {
    claimLease = await acquireClaimLease({
      trustedPackRoot: trusted.trustedPackRoot,
      claimPath: trusted.claimPath,
      projectId,
      storeRoot,
      prNumber: target.prNumber,
      headSha: target.headSha,
      surface: claimSurface,
      startReason: target.operatorStart?.reason ?? (trim(input.startReason) || 'manual'),
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

  const releaseEarlyClaim = async (reason: string): Promise<void> => {
    if (claimLease?.acquired) {
      await claimLease.release('failure', listPackReviewRuns({ projectId, storeRoot }), reason);
    }
  };

  try {
    try {
      await assertBoundHeadStillCurrent({
        repoRoot: target.sourceRepoRoot,
        repoSlug: target.repoSlug,
        prNumber: target.prNumber,
        boundHeadSha: target.headSha,
        boundIssueNumber: target.issueNumber,
        fixturePostReviewHeadSha: process.env.OPK_VITEST_HARNESS === '1'
          ? (input.fixtureCurrentPrHeadSha ?? target.headSha)
          : undefined,
        fixturePostReviewPrBody: process.env.OPK_VITEST_HARNESS === '1'
          ? (input.fixturePrBodyAfterClaim ?? input.fixturePrBody)
          : undefined,
      });
    } catch (error) {
      await releaseEarlyClaim(describeError(error));
      return {
        ok: false,
        created: false,
        reused: false,
        reason: describeError(error),
        prNumber: target.prNumber,
        headSha: target.headSha,
        httpStatus: 409,
      };
    }
    const authoritative = await resolveAuthoritativeReviewContext(input, target, projectId);
    if (target.operatorStart?.boundSnapshot
        && authoritative.snapshotDigest !== target.operatorStart.boundSnapshot) {
      throw new Error(
        `operator bound snapshot mismatch: requested ${target.operatorStart.boundSnapshot}, authoritative ${authoritative.snapshotDigest}; omit --operator-bound-snapshot or set it to ${authoritative.snapshotDigest} after verifying the authoritative Issue snapshot`,
      );
    }
    const operatorSurface = target.operatorStart
      ? `operator_adjudicated;session-binding=advisory;issue=${authoritative.issueNumber};bound-snapshot=${authoritative.snapshotDigest}`
      : undefined;
    const authorityOptions: PackReviewAuthorityOptions = { storeRoot };
    const retainedOpenCycle = readRetainedLegacyOpenCycle(projectId, target.prNumber);
    let authority = initializePackReviewAuthority({
      prNumber: target.prNumber,
      headSha: target.headSha,
      tier: authoritative.tier,
      retainedOpenCycle,
      options: authorityOptions,
    });
    try {
      authority = reconcilePackReviewTier({
        prNumber: target.prNumber,
        tier: authoritative.tier,
        options: authorityOptions,
      });
    } catch (error) {
      await releaseEarlyClaim(describeError(error));
      return {
        ok: false,
        created: false,
        reused: false,
        reason: error instanceof Error ? error.message : String(error),
        prNumber: target.prNumber,
        headSha: target.headSha,
        httpStatus: 409,
      };
    }
    const priorAuthority = authority.currentHeadSha === target.headSha ? undefined : authority;
    if (authority.currentHeadSha !== target.headSha) {
      authority = observePackReviewHead({
        prNumber: target.prNumber,
        expectedTransitionSeq: authority.transitionSeq,
        headSha: target.headSha,
        options: authorityOptions,
      });
    }

    const legacyHarnessFixtureWithoutSmokePlan = process.env.OPK_VITEST_HARNESS === '1'
      && authoritative.issueBody !== undefined
      && !authoritative.issueBody.includes('```smoke-test-plan');
    if (authoritative.issueBody !== undefined
        && smokeOrderingRequired(authoritative.issueBody)
        && !legacyHarnessFixtureWithoutSmokePlan) {
      try {
        assertPackReviewSmokeAdmission({ authority, headSha: target.headSha });
      } catch (error) {
        await releaseEarlyClaim(describeError(error));
        return {
          ok: false,
          created: false,
          reused: false,
          reason: error instanceof Error ? error.message : String(error),
          prNumber: target.prNumber,
          headSha: target.headSha,
          httpStatus: 409,
        };
      }
    }

    carryover = await resolveCarryoverReplay({ input, target, projectId, storeRoot, baseRef, priorAuthority });
    const conflictFreeCarryover = carryover?.replay.kind === 'conflict_free_carryover';
    if (!conflictFreeCarryover
        && authority.cycle
        && ['at_cap_open_findings', 'at_cap_continuation_required'].includes(authority.cycle.state)) {
      await releaseEarlyClaim('at_cap_continuation_required');
      return {
        ok: false,
        created: false,
        reused: false,
        reason: 'at_cap_continuation_required',
        nextAction: 'fix the final findings, run worker-owned smoke on the exact current head, then run scoped reconcile --immediate',
        prNumber: target.prNumber,
        headSha: target.headSha,
        cycleId: authority.cycle.cycleId,
        httpStatus: 409,
      };
    }

    const roundOrdinal = (authority.cycle?.consumedHeadShas.length ?? 0) + 1;
    const cardinality = selectPackReviewGptSourceCardinality({
      reviewer: reviewer ?? 'codex',
      tier: authoritative.tier,
      roundOrdinal,
    });
    const gptRound: PackReviewGptRoundRecord | undefined = reviewer === 'gpt'
      && !conflictFreeCarryover
      && (authoritative.snapshotDigest !== 'harness-unbound-fixture'
        || input.tier !== undefined
        || process.env.OPK_VITEST_HARNESS !== '1')
      ? {
          schema: 'pack-review-gpt-round/v1',
          reviewer: 'gpt',
          tier: authoritative.tier,
          roundOrdinal,
          cardinality,
          issueNumber: authoritative.issueNumber,
          boundIssueSnapshotDigest: authoritative.snapshotDigest,
          sourceSlots: Array.from({ length: cardinality }, (_, index) => ({
            slotId: `source-${String(index + 1).padStart(2, '0')}`,
            ordinal: index + 1,
            lifecycle: 'planned' as const,
          })),
        }
      : undefined;
    if (gptRound
        && gptRound.cardinality > 1
        && (trim(process.env.PACK_GPT_BROWSER_CHAT_URL) || !trim(process.env.PACK_GPT_BROWSER_PROJECT_URL))) {
      throw new Error('plural GPT review requires PACK_GPT_BROWSER_PROJECT_URL and no fixed chat URL');
    }

    authority = advancePackReviewAuthority(
      authority,
      'claim_acquired',
      target.prNumber,
      authorityOptions,
    );

    if (resumeCandidate) {
      const resumePayload = packReviewJournaledPayload(resumeCandidate);
      if (!resumePayload) {
        throw new Error(`pack review run ${resumeCandidate.id} lost its persisted verdict before recovery`);
      }
      let typedResumePayload = resumePayload as ReviewPayload;
      if (resumeCandidate.reviewRound) {
        typedResumePayload = validatePersistedGptReviewPayload(
          resumeCandidate.id,
          typedResumePayload,
          { projectId, storeRoot },
        );
      }
      if (!authority.terminal) {
        if (!(process.env.OPK_VITEST_HARNESS === '1' && input.fixturePostReviewHeadSha === undefined)) {
          await assertBoundHeadStillCurrent({
            repoRoot: target.sourceRepoRoot,
            repoSlug: target.repoSlug,
            prNumber: target.prNumber,
            boundHeadSha: target.headSha,
            boundIssueNumber: target.issueNumber,
            fixturePostReviewHeadSha: input.fixturePostReviewHeadSha,
            fixturePostReviewPrBody: input.fixturePostReviewPrBody
              ?? input.fixturePrBodyAfterClaim
              ?? input.fixturePrBody,
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
            automaticBudgetDisposition: resumeCandidate.automaticBudgetDisposition,
          }),
          status: classifyPackReviewPayload(typedResumePayload).terminalStatus,
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
          boundIssueNumber: target.issueNumber,
          fixturePostReviewHeadSha: input.fixturePostReviewHeadSha,
          fixturePostReviewPrBody: input.fixturePostReviewPrBody
            ?? input.fixturePrBodyAfterClaim
            ?? input.fixturePrBody,
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
            payload: typedResumePayload,
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

    const legacyRepositoryBySourceRoot: Record<string, string> = {};
    for (const record of listPackReviewRunRecordsRaw({ projectId, storeRoot })) {
      if (record.canonicalRepository || !record.sourceRepoRoot) continue;
      const identity = await resolvePackReviewRunCanonicalRepository(record, resolveSlug);
      if (identity.ok) legacyRepositoryBySourceRoot[resolve(record.sourceRepoRoot)] = identity.slug;
    }
    const created = createPackReviewRun({
      projectId,
      storeRoot,
      prNumber: target.prNumber,
      headSha: target.headSha,
      linkedSessionId: target.sessionId,
      startReason: target.operatorStart?.reason
        ?? (trim(input.startReason) || (claimMode === 'preacquired' ? 'automatic' : 'manual')),
      surface: operatorSurface ?? (trim(input.surface) || 'pack-review-runner'),
      trustedPackRoot: trusted.trustedPackRoot,
      sourceRepoRoot: target.sourceRepoRoot,
      canonicalRepository: target.repoSlug,
      legacyRepositoryBySourceRoot,
      automaticBudgetDisposition: 'consume',
      ...(gptRound ? { reviewRound: gptRound } : {}),
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

    if (process.env.OPK_VITEST_HARNESS === '1'
      && (input.fixtureReviewStdout !== undefined
        || input.fixtureReviewTimedOut === true
        || input.fixtureReviewBySourceSlot !== undefined)) {
      worktree = join(packReviewWorktreesDir(storeRoot), run.id);
      mkdirSync(worktree, { recursive: true });
    } else {
      worktree = await createReviewWorktree(target.sourceRepoRoot, storeRoot, run.id, target.headSha);
    }
    updatePackReviewRun(run.id, { reviewTargetRoot: worktree }, { projectId, storeRoot });
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
    let resolvedReviewer: PackReviewer | null = reviewer;
    let payload: ReviewPayload;
    try {
      if (carryover?.replay.kind === 'conflict_free_carryover') {
        result = {
          outcome: 'exit' as const,
          ok: true,
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] }),
          stderr: '',
          timedOut: false,
          cancelled: false,
        };
        payload = parseReviewPayload(result.stdout);
      } else if (gptRound) {
        payload = await runGptSourceBatch({
          run,
          round: gptRound,
          reviewerPath: trusted.reviewerPath,
          trustedPackRoot: trusted.trustedPackRoot,
          reviewTargetRoot: worktree,
          baseRef,
          target,
          budgetLedger,
          projectId,
          storeRoot,
          input,
          carryoverBundlePath,
          frozenScope: authoritative.frozenScope,
        });
        result = {
          outcome: 'exit' as const,
          ok: true,
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify(payload),
          stderr: '',
          timedOut: false,
          cancelled: false,
        };
      } else {
        const invocation = await invokeReviewer({
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
          frozenScope: authoritative.frozenScope,
        });
        result = invocation.result;
        resolvedReviewer = invocation.resolvedReviewer;
      }
    } finally {
      clearInterval(heartbeat);
    }
    void resolvedReviewer;
    writeRunLogs(storeRoot, run.id, result.stdout, result.stderr);

    if (result.timedOut) {
      await recordUnfinishedTerminal({
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
      await recordUnfinishedTerminal({
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
          fixtureReviewStdout: input.fixtureFallbackReviewStdout ?? input.fixtureReviewStdout,
          fixtureReviewExitCode: input.fixtureFallbackReviewExitCode ?? input.fixtureReviewExitCode,
          fixtureReviewTimedOut: input.fixtureFallbackReviewTimedOut ?? input.fixtureReviewTimedOut,
          fixtureReviewerLayerOverrides: input.fixtureReviewerLayerOverrides,
          fixtureEmulateWin32Selector: input.fixtureEmulateWin32Selector,
          headSha: target.headSha,
          frozenScope: authoritative.frozenScope,
        });
        result = fallback.result;
        resolvedReviewer = fallback.resolvedReviewer;
        void resolvedReviewer;
        writeRunLogs(storeRoot, run.id, result.stdout, result.stderr);
        if (result.timedOut || !result.ok) {
          await recordFallbackProcessFailure(result);
        }
        try {
          payload = parseReviewPayload(result.stdout);
        } catch (error) {
          return returnFallbackMalformed(error);
        }
      }
    }

    try {
      if (!(process.env.OPK_VITEST_HARNESS === '1' && input.fixturePostReviewHeadSha === undefined)) {
        await assertBoundHeadStillCurrent({
          repoRoot: target.sourceRepoRoot,
          repoSlug: target.repoSlug,
          prNumber: target.prNumber,
          boundHeadSha: target.headSha,
          boundIssueNumber: target.issueNumber,
          fixturePostReviewHeadSha: input.fixturePostReviewHeadSha,
          fixturePostReviewPrBody: input.fixturePostReviewPrBody
            ?? input.fixturePrBodyAfterClaim
            ?? input.fixturePrBody,
        });
      }
    } catch (error) {
      await recordUnfinishedTerminal({
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

    if (gptRound) {
      if (input.fixtureBeforeGptAggregateSettlement) {
        await input.fixtureBeforeGptAggregateSettlement({ runId: run.id, payload });
      }
      let persistedRun = getPackReviewRun(run.id, { projectId, storeRoot });
      if (!persistedRun) throw new Error(`pack review run ${run.id} disappeared before GPT settlement`);
      const persistedRound = persistedRun.reviewRound;
      if (!persistedRound) throw new Error(`pack review run ${run.id} lost its GPT round before settlement`);
      const usableSourceCount = gptUsableSourceCount(persistedRound);
      if (persistedRound.cardinality >= 3
          && usableSourceCount === persistedRound.cardinality
          && persistedRound.settledSourceCount === undefined) {
        updatePackReviewRun(run.id, {
          reviewRound: { ...persistedRound, settledSourceCount: usableSourceCount },
        }, { projectId, storeRoot });
        persistedRun = getPackReviewRun(run.id, { projectId, storeRoot });
        if (!persistedRun) throw new Error(`pack review run ${run.id} disappeared while freezing GPT source count`);
      }
      run = persistedRun;
      const diagnostics = gptRoundDiagnostics(run.reviewRound);
      const incompletePluralRound = (run.reviewRound?.cardinality ?? 0) >= 3
        && gptUsableSourceCount(run.reviewRound) < (run.reviewRound?.cardinality ?? 0);
      if (incompletePluralRound) {
        run = updatePackReviewRun(run.id, {
          status: 'reviewing',
          latestRunStatus: 'reviewing',
          failureReason: undefined,
        }, { projectId, storeRoot });
        const runs = listPackReviewRuns({ projectId, storeRoot });
        if (claimLease) await claimLease.release('run_started', runs);
        return {
          ok: false,
          created: true,
          reused: false,
          reason: `gpt_sources_waiting_for_grace:${gptUsableSourceCount(run.reviewRound)}/${run.reviewRound?.cardinality}; next_action=run scoped reconcile now or after grace`,
          nextAction: 'run scoped reconcile --pr-number for this PR; 2/3 settlement becomes eligible only after the shared grace threshold',
          runId: run.id,
          status: run.status,
          httpStatus: 202,
        };
      }
      payload = validatePersistedGptReviewPayload(run.id, payload, { projectId, storeRoot });
      const writeRequiredStatus = input.fixtureRequiredStatusWriter ?? ((request) => publishPackReviewRequiredStatus({
        repoRoot: target.sourceRepoRoot,
        repoSlug: target.repoSlug,
        headSha: target.headSha,
        request,
      }));
      if (diagnostics.nonHarvestIncompleteSources.length > 0) {
        const first = diagnostics.nonHarvestIncompleteSources[0]!;
        const status: Extract<PackReviewRunStatus, 'failed' | 'timed_out' | 'cancelled'> = diagnostics.nonHarvestIncompleteSources.some((item) => item.cancelled)
          ? 'cancelled'
          : diagnostics.nonHarvestIncompleteSources.some((item) => item.timedOut)
            ? 'timed_out'
            : 'failed';
        const failureReason = `gpt_source_non_complete:${first.sourceSlotId}:${first.classification}`;
        await recordUnfinishedTerminal({
          run,
          status,
          failureReason,
          projectId,
          storeRoot,
          writeRequiredStatus,
        });
        terminal = true;
        const runs = listPackReviewRuns({ projectId, storeRoot });
        if (claimLease) await claimLease.release('run_started', runs);
        return {
          ok: false,
          created: true,
          reused: false,
          reason: failureReason,
          runId: run.id,
          status,
          httpStatus: status === 'timed_out' ? 504 : 422,
        };
      }

      if (diagnostics.harvestIncidents.length > 0 && !classifyPackReviewPayload(payload).blocking) {
        payload = { ...payload, harvestIncidents: diagnostics.harvestIncidents };
        const posted = await postGithubReview({
          repoRoot: target.sourceRepoRoot,
          repoSlug: target.repoSlug,
          prNumber: target.prNumber,
          headSha: target.headSha,
          run,
          payload,
          projectId,
          storeRoot,
          transport: githubReviewTransport,
        });
        run = updatePackReviewRun(run.id, {
          githubReviewId: posted.id,
          githubReviewUrl: posted.url,
          githubReviewEvent: 'COMMENT',
        }, { projectId, storeRoot });
        await recordUnfinishedTerminal({
          run,
          status: 'failed',
          failureReason: 'harvest_failed',
          projectId,
          storeRoot,
          writeRequiredStatus,
        });
        terminal = true;
        const runs = listPackReviewRuns({ projectId, storeRoot });
        if (claimLease) await claimLease.release('run_started', runs);
        return {
          ok: false,
          created: true,
          reused: false,
          reason: 'harvest_failed',
          runId: run.id,
          status: 'failed',
          httpStatus: 422,
          githubReviewId: posted.id,
          githubReviewUrl: posted.url,
        };
      }
      if (diagnostics.harvestIncidents.length > 0) {
        payload = { ...payload, harvestIncidents: diagnostics.harvestIncidents };
      }
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
        automaticBudgetDisposition: run.automaticBudgetDisposition,
        carryover: carryover ? {
          replay: carryover.replay,
          sourceCleanRunId: carryover.sourceCleanRunId,
          focusedResolutionRunId: carryover.replay.kind === 'merge_composite' ? run.id : undefined,
        } : undefined,
      }),
      status: classifyPackReviewPayload(payload).terminalStatus,
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
        boundIssueNumber: target.issueNumber,
        fixturePostReviewHeadSha: input.fixturePostReviewHeadSha,
        fixturePostReviewPrBody: input.fixturePostReviewPrBody
          ?? input.fixturePrBodyAfterClaim
          ?? input.fixturePrBody,
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
    const fixtureCrash = process.env.OPK_VITEST_HARNESS === '1'
      && describeError(error) === GPT_SOURCE_FIXTURE_CRASH_REASON;
    if (fixtureCrash) retainClaimDirectory = true;
    if (run && !terminal && !fixtureCrash) {
      try {
        const persisted = getPackReviewRun(run.id, { projectId, storeRoot });
        if (persisted
          && isPackReviewUnfinishedTerminalRun(persisted)
          && packReviewRequiredStatusNeedsStaleReconciliation(persisted)) {
          retainClaimDirectory = true;
        } else if (terminalPersistenceAttempted) {
          retainClaimDirectory = true;
        } else if (!terminalPersistenceAttempted && (!persisted
          || (!hasPersistedPackReviewVerdict(persisted) && !isPackReviewUnfinishedTerminalRun(persisted)))) {
          await recordUnfinishedTerminal({
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
        if (terminalPersistenceAttempted || isTerminalPersistenceFailure(terminalError)) {
          retainClaimDirectory = true;
        }
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
    '  node --experimental-strip-types scripts/pack-review-runner.ts start --pr-number <n> --session-id <worker-session-id>',
    '  node --experimental-strip-types scripts/pack-review-runner.ts start --pr-number <n> --head-sha <40-hex>',
    '  node --experimental-strip-types scripts/pack-review-runner.ts start --pr-number <n> --operator-reason <text> [--operator-issue-number <n>] [--operator-repository <owner/name>] [--operator-bound-snapshot <sha256:64-hex>]',
    '',
    'Status:',
    '  node --experimental-strip-types scripts/pack-review-runner.ts list [--project-id orchestrator-pack]',
    '',
    'Recovery / settlement:',
    '  node --experimental-strip-types scripts/pack-review-runner.ts reconcile --source-repo-root <path> --repo-slug owner/name [--pr-number <n>] [--immediate]',
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
    '--operator-repository': 'operatorRepository',
    '--operator-issue-number': 'operatorIssueNumber',
    '--operator-bound-snapshot': 'operatorBoundSnapshot',
    '--operator-reason': 'operatorReason',
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
    if (flag === '--immediate') {
      result.immediate = true;
      continue;
    }
    const key = keyByFlag[flag];
    if (!key) throw new Error(`unknown argument '${flag}'\n${usage()}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    result[key] = key === 'prNumber' || key === 'operatorIssueNumber' ? Number(value) : value;
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
  const stdinPayload = readStdinPayload();
  if (OPERATOR_START_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(stdinPayload, field))) {
    throw new Error('operator pack-review start inputs are accepted only from direct CLI arguments');
  }
  const cliArgs = parseArgs(argv);
  const input = { ...stdinPayload, ...cliArgs };
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
      prNumber: positiveInteger(input.prNumber, 'prNumber'),
      immediate: input.immediate === true,
      baseRef: trim(input.baseRef) || DEFAULT_BASE_REF,
      fixtureCurrentPrHeadSha: (input as StartInput).fixtureCurrentPrHeadSha,
      fixtureGptSourceCommentTransport: (input as StartInput).fixtureGptSourceCommentTransport,
      fixtureGithubReviewId: (input as StartInput).fixtureGithubReviewId,
      fixtureGithubReviewTransport: (input as StartInput).fixtureGithubReviewTransport,
      fixtureRequiredStatusWriter: (input as StartInput).fixtureRequiredStatusWriter,
      fixtureWorkerNotifier: (input as StartInput).fixtureWorkerNotifier,
      fixtureIssueBody: (input as StartInput).fixtureIssueBody,
      fixtureIssueNumber: (input as StartInput).fixtureIssueNumber,
      fixtureChangedPaths: (input as StartInput).fixtureChangedPaths,
      fixtureBoundIssueSnapshotBytes: (input as StartInput).fixtureBoundIssueSnapshotBytes,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (subcommand === 'start') {
    const startInput = input as DirectCliStartInput;
    const operatorStart = resolveOperatorPackReviewStart(startInput);
    if (operatorStart) directCliOperatorStarts.set(startInput, operatorStart);
    const result = await startPackReview(startInput);
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
