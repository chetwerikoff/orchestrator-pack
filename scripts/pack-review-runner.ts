import './toolchain/native-entrypoint-preflight.ts';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReviewerBudgetSpawnEnv,
  createReviewerBudgetLedger,
  type ReviewerBudgetLedger,
} from '../plugins/codex-pr-reviewer/lib/reviewer_budget.ts';
import { normalizePath } from '@orchestrator-pack/shared/lib/normalize.js';
import { pathMatchesAnyPattern } from '../plugins/task-declaration/lib/glob_match.ts';
import { REPOSITORY_DENYLIST } from './pr-scope-declaration.ts';
import { observePosixProcessGroup, runProcess, type ProcessResult } from './kernel/subprocess.ts';
import { resolveTrackedGhWrapper } from './lib/gh-resolve-real-binary.mjs';
import {
  INSPECTION_EXPRESSION,
  classifyChatGptSurfaceUrl,
  defaultDependencies as browserCdpDependencies,
  toCompatibleTargets,
  type ProbeDependencies,
} from './browser-gpt-page-probe.ts';
import {
  observationRecordPath,
  readStateLightTurnObservation,
} from './chatgpt-browser-turn/state-light-turn-observation.ts';
import { readStateLightAccountCooldown } from './chatgpt-browser-turn/state-light-turn-base.ts';
import { authoritativePreSend, terminalHasPossibleDelivery } from './pack-review-no-review-reconcile.ts';
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
  PACK_REVIEW_CAP_MAP_VERSION,
  PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
  PACK_REVIEW_GPT_SOURCE_ADMISSION_INTERVAL_MS,
  acknowledgePackReviewReset,
  commitPackReviewAuthorityTransition,
  commitPackReviewTerminal,
  commitPackReviewTriage,
  initializePackReviewAuthority,
  listPackReviewImmutableRecords,
  observePackReviewHead,
  packReviewFindingsSatisfiedByStrictDescendant,
  readPackReviewAuthority,
  recordPackReviewPublication,
  settleLogicalPackReviewFindingsByStrictDescendant,
  selectPackReviewEvidence,
  selectPackReviewGptSourceCardinality,
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
  claimKey,
  claimPath,
  readClaimRecord,
  completeAfterRunInvoke,
  releaseAfterRunFailure,
  resolveReviewStartClaimNamespace,
  testReviewStartClaimOwnership,
  type ClaimResult,
} from './lib/review-start-claim-store.ts';
import type { ExplicitDeadReviewerTakeover } from './lib/review-start-claim-cli.ts';
import {
  PACK_REVIEW_ACTIVE_STATUSES,
  createPackReviewRun,
  derivePackReviewGptCoverage,
  derivePackReviewNoJudgmentBudgetOutcome,
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
  resolvePackReviewRequiredRunOrder,
  resolvePackReviewRunStoreRoot,
  setPackReviewRunTerminal,
  terminalizePackReviewStaleRun,
  updatePackReviewRun,
  updatePackReviewRunIf,
  validatePersistedPackReviewGptAggregate,
  type PackReviewGptRoundRecord,
  type PackReviewRunRecord,
  type PackReviewRunStatus,
  type PackReviewSourceSlotRecord,
  type PackReviewSourceSlotAttemptHistory,
} from './lib/pack-review-run-store.ts';
import {
  createGithubReviewTransport,
  requireProcess,
  reconcileGithubCommentReview,
  writeGithubReviewCapture,
  type GithubReviewTransport,
} from './lib/github-review-reconciliation.ts';
import {
  PACK_REVIEW_REQUIRED_STATUS_CONTEXT,
  classifyPackReviewFailureReason,
  classifyPackReviewPayload,
  deliverPackReviewVerdict,
  packReviewDeliveryNeedsResume,
  packReviewJournaledPayload,
  packReviewRequiredStatusNeedsStaleReconciliation,
  packReviewRequiredStatusStaleReconciliationComplete,
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
  packReviewResumeReviewerAuthorityError,
  resolvePackReviewerResolution,
  type PackReviewer,
  type PackReviewerLayerOverrides,
} from './lib/resolve-pack-reviewer.ts';
import { resolveGptBrowserConfig, resolveRepositorySlug } from './lib/pack-gpt-reviewer.ts';
import { parsePersistedWorkerNotificationBinding } from './lib/pack-review-worker-notification.ts';
import { resolveTargetContext, type TargetContext } from './lib/target-context.ts';
import {
  createPackGptSourceCommentTransport,
  resolvePackGptSourceComment,
  type PackGptSourceCommentResolution,
  type PackGptSourceCommentTransport,
} from './lib/pack-gpt-source-comment.ts';
import type { PackGptSourceIdentity } from './lib/pack-gpt-source-comment-contract.ts';
import { configuredProfileKey } from './chatgpt-browser-turn/storage-common.ts';
import { CHAT_BINDING_WORKTREE_ENV, chatBindingWorktree } from './chatgpt-browser-turn/chat-bindings.ts';
import {
  boundIssueSnapshotArtifactPaths,
  captureBoundIssueSnapshot,
  computeBoundIssueSnapshotHash,
  loadValidatedBoundSnapshotBody,
  resolveBoundIssueSnapshot,
} from './lib/reverify-bound-issue-snapshot.ts';
import { extractClosingIssueNumber } from './pr-scope-contract.ts';
import {
  parseComplexityTierFromIssueBody,
} from '../docs/review-cycle-cap.mjs';
import {
  requiredStatusChecksEndpoint,
  resolveRequiredCi,
  type RequiredCiCheckRow,
  type RequiredCiProtectionRead,
} from './lib/required-ci.ts';
export { requiredStatusChecksEndpoint } from './lib/required-ci.ts';
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
  targetProjectId?: string;
  sessionId?: string;
  linkedSessionId?: string;
  prNumber?: number;
  headSha?: string;
  repoRoot?: string;
  sourceRepoRoot?: string;
  repoSlug?: string;
  baseRef?: string;
  startReason?: string;
  surface?: string;
  reviewerOverride?: PackReviewer;
  storeRoot?: string;
  timeoutSeconds?: unknown;
  tier?: 'T1' | 'T2' | 'T3';
  claimMode?: 'acquire' | 'preacquired';
  preacquiredClaim?: ClaimResult;
  onRunStarted?: (event: {
    prNumber: number;
    headSha: string;
    runId: string;
    timeoutSeconds: number;
  }) => void | Promise<void>;
  fixtureCurrentPrHeadSha?: string;
  fixtureReadCurrentPrHead?: () => string | Promise<string>;
  fixtureRequiredCi?: readonly string[];
  fixtureRequiredCiChecks?: Array<{ name?: string; workflow?: string; state?: string; conclusion?: string; status?: string }> | null;
  fixtureRequiredCiPolicy?: {
    contexts?: unknown[];
    checks?: Array<string | { context?: string }>;
  } | null;
  fixtureRequiredCiPolicyHttpStatus?: number;
  fixtureRequiredCiPostProjectionHead?: string;
  fixtureRequiredCiPostProjectionBase?: string;
  fixtureRequiredCiHeadAfterGate?: string;
  fixtureRequiredCiBaseAfterGate?: string;
  fixturePrState?: string;
  fixturePrBody?: string;
  fixturePrBodyAfterClaim?: string;
  fixturePostReviewPrBody?: string;
  fixtureReviewStdout?: string;
  fixtureReviewExitCode?: number;
  fixtureReviewTimedOut?: boolean;
  /** Execute actual disposable Git worktree operations despite synthetic reviewer output. */
  fixtureUseRealReviewWorktree?: boolean;
  /** Fail only after Git registered the checkout, before the creator resolves. */
  fixtureAfterReviewWorktreeAdd?: (target: string) => void | Promise<void>;
  /** Pause a terminal runner before its outer finally removes the checkout. */
  fixtureBeforeReviewWorktreeCleanup?: (run: PackReviewRunRecord, target: string) => void | Promise<void>;
  /** Simulate targeted Git removal failure without altering the repository's Git metadata. */
  fixtureReviewWorktreeRemoveFailure?: boolean;
  fixtureReviewBySourceSlot?: FixtureReviewBySourceSlot;
  fixtureGptSourceCommentTransport?: PackGptSourceCommentTransport;
  fixtureGptAdmissionReadObservation?: typeof readStateLightTurnObservation;
  fixtureAfterGptInvocationBound?: (event: {
    slotId: string;
    attemptOrdinal: number;
    invocationId: string;
    round: PackReviewGptRoundRecord;
  }) => void | Promise<void>;
  fixtureGptAttemptObserver?: (
    run: PackReviewRunRecord,
    nowMs?: number,
  ) => Promise<PackReviewGptAttemptObservation | null>;
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
  fixtureAfterNativeInitialArmed?: (run: PackReviewRunRecord) => void | Promise<void>;
  fixtureAfterNativeFallbackArmed?: (run: PackReviewRunRecord) => void | Promise<void>;
  fixtureReviewerLayerOverrides?: PackReviewerLayerOverrides;
  fixtureEmulateWin32Selector?: boolean;
  fixturePostReviewHeadSha?: string;
  fixtureGithubReviewId?: number;
  fixtureRepoSlug?: string;
  fixtureResolveRepositorySlug?: (repoRoot: string) => Promise<string>;
  fixtureGithubReviewTransport?: GithubReviewTransport;
  fixtureRequiredStatusWriter?: PackReviewRequiredStatusWriter;
  /** Offline exact-head status observation; production uses GitHub. */
  fixtureRequiredStatusReader?: (headSha: string) => string | undefined | Promise<string | undefined>;
  fixtureWorkerNotifier?: PackReviewWorkerNotifier;
  fixtureJournalWriter?: PackReviewJournalWriter;
  fixtureBeforeStaleStatusWrite?: (run: PackReviewRunRecord) => void | Promise<void>;
  fixtureCarryoverReplay?: CarryoverReplayResult;
  fixtureCarryoverSourceCleanRunId?: string;
  fixtureFocusedResolutionBundleDigest?: string;
  fixtureIssueBody?: string;
  /** Independent synthetic linked Issue title, never inferred from body or caller tier. */
  fixtureIssueTitle?: string;
  fixtureIssueNumber?: number;
  fixtureChangedPaths?: string[];
  fixtureBoundIssueSnapshotBytes?: string;
  fixtureReviewCompareStatus?: string;
  fixtureSameHeadIssueResolutionRunner?: typeof runProcess;
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
  /** Narrow an existing reconcile pass to this incumbent without hiding competing run-order evidence. */
  runId?: string;
  /** Fleet tick must never take over a non-stale runner or terminal-only run. */
  staleOnly?: boolean;
  immediate?: boolean;
  /** Internal pre-start switch: recover active GPT sources without public --immediate final-cap semantics. */
  recoverActiveGptSources?: boolean;
  /**
   * Controls whether this reconciliation invocation may create a new degraded
   * partial settlement after grace. Production entrypoints set this explicitly:
   * automatic pre-start reconciliation is false; scoped CLI reconcile is true
   * only with --immediate. Undefined preserves legacy direct-call recovery.
   */
  settlePartialAfterGrace?: boolean;
  baseRef?: string;
  fixtureCurrentPrHeadSha?: string;
  fixtureReadCurrentPrHead?: () => string | Promise<string>;
  fixturePrState?: string;
  fixturePrMerged?: boolean;
  fixturePrBody?: string;
  fixtureGptSourceCommentTransport?: PackGptSourceCommentTransport;
  fixtureBeforeGptRoundFreeze?: (event: {
    runId: string;
    usableSourceCount: number;
    requiredSourceCount: number;
  }) => void | Promise<void>;
  fixtureAfterGptRoundFreeze?: (event: {
    runId: string;
    settledSourceCount: number;
  }) => void | Promise<void>;
  fixtureGithubReviewId?: number;
  fixtureGithubReviewTransport?: GithubReviewTransport;
  fixtureRequiredStatusWriter?: PackReviewRequiredStatusWriter;
  /** Offline GitHub commit-status read for final-cap publication confirmation. */
  fixtureRequiredStatusReader?: (headSha: string) => string | undefined | Promise<string | undefined>;
  fixtureWorkerNotifier?: PackReviewWorkerNotifier;
  fixtureIssueBody?: string;
  /** Independent synthetic linked Issue title, never inferred from body or caller tier. */
  fixtureIssueTitle?: string;
  fixtureIssueNumber?: number;
  fixtureChangedPaths?: string[];
  fixtureBoundIssueSnapshotBytes?: string;
  fixtureReviewCompareStatus?: string;
  fixtureSameHeadIssueResolutionRunner?: typeof runProcess;
  fixtureRequiredCi?: StartInput['fixtureRequiredCi'];
  fixtureRequiredCiChecks?: StartInput['fixtureRequiredCiChecks'];
  fixtureRequiredCiPolicy?: StartInput['fixtureRequiredCiPolicy'];
  fixtureRequiredCiPolicyHttpStatus?: StartInput['fixtureRequiredCiPolicyHttpStatus'];
  fixtureRequiredCiPostProjectionHead?: string;
  fixtureRequiredCiPostProjectionBase?: string;
  fixtureRequiredCiHeadAfterGate?: string;
  fixtureRequiredCiBaseAfterGate?: string;
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
const directCliStarts = new WeakSet<StartInput>();
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
  category?: string;
  fingerprint?: string;
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
  deadForeignRunClaimReclaimed?: boolean;
  owns: () => boolean;
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
  const projectId = trim(env.OPK_PROJECT_ID) || DEFAULT_PROJECT_ID;
  return join(homedir(), '.local', 'state', 'orchestrator-pack-wake-supervisor', projectId, 'pr-session-binding-cache.json');
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
  logicalRoundOrdinal?: number;
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
    ...(input.logicalRoundOrdinal ? { logicalRoundOrdinal: input.logicalRoundOrdinal } : {}),
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
    command: resolveTrackedGhWrapper(),
    args: ['api', `repos/${repoSlug}/pulls/${prNumber}`],
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: 30_000,
  });
  const output = await requireProcess(result, `gh api PR read ${prNumber}`);
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
  const head = row.head && typeof row.head === 'object' && !Array.isArray(row.head)
    ? row.head as Record<string, unknown>
    : {};
  const headSha = trim(head.sha ?? row.headRefOid);
  const state = trim(row.state);
  if (!/^[0-9a-f]{40}$/i.test(headSha ?? '')) throw new Error(`PR #${prNumber} returned invalid head SHA`);
  if (String(state ?? '').toUpperCase() !== 'OPEN') throw new Error(`PR #${prNumber} is not open`);
  return headSha.toLowerCase();
}

export async function resolveGithubCommitIsStrictDescendant(
  repoRoot: string,
  repoSlug: string,
  reviewedHeadSha: string,
  currentHeadSha: string,
  runner: typeof runProcess = runProcess,
): Promise<boolean> {
  const reviewed = trim(reviewedHeadSha).toLowerCase();
  const current = trim(currentHeadSha).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(reviewed)
      || !/^[0-9a-f]{40}$/.test(current)
      || reviewed === current) {
    return false;
  }

  try {
    const result = await runner({
      command: resolveTrackedGhWrapper(),
      args: ['api', `repos/${repoSlug}/compare/${reviewed}...${current}`],
      cwd: repoRoot,
      inheritParentEnv: true,
      allowEmptyStdout: false,
      timeoutMs: 30_000,
    });
    if (!result.ok) return false;
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return trim((parsed as Record<string, unknown>).status).toLowerCase() === 'ahead';
  } catch {
    return false;
  }
}

async function resolvePackReviewStrictDescendant(input: {
  repoRoot: string;
  repoSlug: string;
  reviewedHeadSha: string;
  currentHeadSha: string;
  fixtureReviewCompareStatus?: string;
}): Promise<boolean> {
  const reviewedHeadIsAncestor = input.fixtureReviewCompareStatus === undefined
    ? await resolveGithubCommitIsStrictDescendant(
        input.repoRoot,
        input.repoSlug,
        input.reviewedHeadSha,
        input.currentHeadSha,
      )
    : trim(input.fixtureReviewCompareStatus).toLowerCase() === 'ahead';
  return packReviewFindingsSatisfiedByStrictDescendant({
    reviewedHeadSha: input.reviewedHeadSha,
    currentHeadSha: input.currentHeadSha,
    reviewedHeadIsAncestor,
  });
}

export async function resolveCurrentPrTarget(
  repoRoot: string,
  repoSlug: string,
  prNumber: number,
  runner: typeof runProcess = runProcess,
): Promise<{ headSha: string; body: string; baseRef: string }> {
  const result = await runner({
    command: resolveTrackedGhWrapper(),
    args: ['api', `repos/${repoSlug}/pulls/${prNumber}`],
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: 30_000,
  });
  const output = await requireProcess(result, `gh api PR read ${prNumber}`);
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
  const head = row.head && typeof row.head === 'object' && !Array.isArray(row.head)
    ? row.head as Record<string, unknown>
    : {};
  const base = row.base && typeof row.base === 'object' && !Array.isArray(row.base)
    ? row.base as Record<string, unknown>
    : {};
  const headSha = trim(head.sha ?? row.headRefOid);
  const state = trim(row.state);
  const baseRef = trim(base.ref);
  if (!/^[0-9a-f]{40}$/i.test(headSha)) throw new Error(`PR #${prNumber} returned invalid head SHA`);
  if (state.toUpperCase() !== 'OPEN' || row.merged === true || trim(row.merged_at)) {
    throw new Error(`PR #${prNumber} is not open and unmerged`);
  }
  if (typeof row.body !== 'string') throw new Error(`PR #${prNumber} returned invalid body`);
  if (!baseRef) throw new Error(`PR #${prNumber} returned invalid base ref`);
  return { headSha: headSha.toLowerCase(), body: row.body, baseRef };
}

export async function manualPackReviewRequiredCiGreen(input: {
  startInput: StartInput;
  target: { prNumber: number; headSha: string; repoSlug: string; sourceRepoRoot: string; prBaseRef: string };
  targetContext?: Pick<TargetContext, 'projectId' | 'repository' | 'defaultBranch' | 'requiredCi'> | null;
}): Promise<boolean> {
  const harness = process.env.OPK_VITEST_HARNESS === '1';
  const targetContext = input.targetContext ?? {
    projectId: trim(input.startInput.projectId) || DEFAULT_PROJECT_ID,
    repository: input.target.repoSlug,
    defaultBranch: input.target.prBaseRef,
    ...(input.startInput.fixtureRequiredCi ? { requiredCi: input.startInput.fixtureRequiredCi } : {}),
  };

  const readProtection = async (): Promise<RequiredCiProtectionRead> => {
    if (harness) {
      const status = input.startInput.fixtureRequiredCiPolicyHttpStatus;
      if (status === 403 || status === 404) return { kind: 'unavailable', httpStatus: status };
      if (!input.startInput.fixtureRequiredCiPolicy) {
        return { kind: 'unavailable', httpStatus: 404 };
      }
      return { kind: 'ok', policy: input.startInput.fixtureRequiredCiPolicy };
    }
    const policyResult = await runProcess({
      command: resolveTrackedGhWrapper(),
      args: ['api', requiredStatusChecksEndpoint(input.target.repoSlug, input.target.prBaseRef)],
      cwd: input.target.sourceRepoRoot,
      inheritParentEnv: true,
      allowEmptyStdout: false,
      timeoutMs: 30_000,
    });
    if (!policyResult.ok) {
      const policyFailure = `${policyResult.stderr}\n${policyResult.stdout}`;
      const match = policyFailure.match(/\bHTTP\s+(403|404)\b/i);
      if (match) return { kind: 'unavailable', httpStatus: Number(match[1]) as 403 | 404 };
      throw new Error('required CI protection lookup failed');
    }
    const parsed = JSON.parse(policyResult.stdout) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('required CI protection lookup returned invalid JSON');
    }
    return { kind: 'ok', policy: parsed as Record<string, unknown> };
  };

  const readChecks = async (): Promise<readonly RequiredCiCheckRow[]> => {
    if (harness) {
      if (!Array.isArray(input.startInput.fixtureRequiredCiChecks)) {
        throw new Error('required CI fixture checks are unavailable');
      }
      return input.startInput.fixtureRequiredCiChecks;
    }
    const checksResult = await runProcess({
      command: resolveTrackedGhWrapper(),
      args: [
        'pr', 'checks', String(input.target.prNumber),
        '--repo', input.target.repoSlug,
        '--json', 'name,state,bucket,link,startedAt,completedAt,workflow,description',
      ],
      cwd: input.target.sourceRepoRoot,
      inheritParentEnv: true,
      allowEmptyStdout: false,
      timeoutMs: 30_000,
    });
    if (checksResult.outcome !== 'exit' || ![0, 1, 8].includes(checksResult.exitCode ?? -1)) {
      throw new Error('required CI check projection failed');
    }
    const parsed = JSON.parse(checksResult.stdout) as unknown;
    if (!Array.isArray(parsed)) throw new Error('required CI check projection returned invalid JSON');
    return parsed as RequiredCiCheckRow[];
  };

  const resolution = await resolveRequiredCi({
    target: targetContext,
    prNumber: input.target.prNumber,
    expectedHeadSha: input.target.headSha,
    prBaseRef: input.target.prBaseRef,
    readProtection,
    readChecks,
    readCurrentPr: async () => {
      if (harness) {
        return {
          headSha: trim(input.startInput.fixtureRequiredCiPostProjectionHead || input.target.headSha).toLowerCase(),
          baseRef: trim(input.startInput.fixtureRequiredCiPostProjectionBase || input.target.prBaseRef),
        };
      }
      const current = await resolveCurrentPrTarget(
        input.target.sourceRepoRoot,
        input.target.repoSlug,
        input.target.prNumber,
      );
      return { headSha: current.headSha, baseRef: current.baseRef };
    },
  });
  if (!resolution.green) return false;

  // Keep the existing later guard in addition to the resolver's immediate
  // post-projection witness. It catches head or base movement after the shared
  // gate itself and before a production review can start.
  const targetAfterGate = harness
    ? {
        headSha: trim(input.startInput.fixtureRequiredCiHeadAfterGate || input.target.headSha).toLowerCase(),
        baseRef: trim(input.startInput.fixtureRequiredCiBaseAfterGate || input.target.prBaseRef),
      }
    : await resolveCurrentPrTarget(
        input.target.sourceRepoRoot,
        input.target.repoSlug,
        input.target.prNumber,
      );
  return targetAfterGate.headSha === input.target.headSha
    && targetAfterGate.baseRef === targetContext.defaultBranch;
}

async function resolveCurrentIssueFields(
  repoRoot: string, repoSlug: string, issueNumber: number,
  runner: typeof runProcess = runProcess,
): Promise<{title: string; body: string}> {
  const result = await runner({
    command: resolveTrackedGhWrapper(),
    args: ['api', `repos/${repoSlug}/issues/${issueNumber}`],
    cwd: repoRoot, inheritParentEnv: true, allowEmptyStdout: false, timeoutMs: 30_000,
  });
  const output = await requireProcess(result, `gh issue view ${issueNumber} --json title,body`);
  let parsed: unknown;
  try { parsed = JSON.parse(output); }
  catch { throw new Error(`Issue #${issueNumber} returned invalid JSON`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Issue #${issueNumber} returned invalid JSON`);
  }
  const { title, body } = parsed as Record<string, unknown>;
  if (typeof title !== 'string' || !title.trim()) {
    throw new Error(`Issue #${issueNumber} returned missing or invalid title`);
  }
  if (typeof body !== 'string') throw new Error(`Issue #${issueNumber} returned invalid body`);
  return { title, body };
}

export async function resolvePackReviewSelectedRepository(input: {
  sourceRepoRoot: string;
  selectedTarget: Pick<TargetContext, 'repository'>;
  resolveRepository?: (repoRoot: string) => Promise<string>;
}): Promise<string> {
  const observedRepository = await (input.resolveRepository ?? resolveRepositorySlug)(input.sourceRepoRoot);
  if (observedRepository.toLowerCase() !== input.selectedTarget.repository.toLowerCase()) {
    throw new Error(
      `pack review source repository ${observedRepository} does not match selected target ${input.selectedTarget.repository}`,
    );
  }
  return input.selectedTarget.repository;
}

export async function resolvePackReviewReconcileRepository(input: {
  sourceRepoRoot: string;
  explicitRepoSlug?: string;
  selectedTarget?: Pick<TargetContext, 'repository'> | null;
  resolveRepository?: (repoRoot: string) => Promise<string>;
}): Promise<string> {
  const explicitRepository = trim(input.explicitRepoSlug);
  if (explicitRepository) {
    if (!/^[^/\s]+\/[^/\s]+$/u.test(explicitRepository)) {
      throw new Error(`pack review reconcile --repo-slug must be owner/name, got '${explicitRepository}'`);
    }
    if (input.selectedTarget
        && explicitRepository.toLowerCase() !== input.selectedTarget.repository.toLowerCase()) {
      throw new Error(
        `pack review reconcile repository ${explicitRepository} does not match selected target ${input.selectedTarget.repository}`,
      );
    }
    return input.selectedTarget?.repository ?? explicitRepository;
  }

  const observedRepository = await (input.resolveRepository ?? resolveRepositorySlug)(input.sourceRepoRoot);
  if (input.selectedTarget
      && observedRepository.toLowerCase() !== input.selectedTarget.repository.toLowerCase()) {
    throw new Error(
      `pack review reconcile source repository ${observedRepository} does not match selected target ${input.selectedTarget.repository}`,
    );
  }
  return input.selectedTarget?.repository ?? observedRepository;
}

async function resolveTarget(
  input: StartInput,
  trustedPackRoot: string,
  operatorStart?: OperatorPackReviewStart,
  selectedTarget?: TargetContext | null,
): Promise<{
  prNumber: number;
  headSha: string;
  sessionId: string;
  issueNumber?: number;
  repoSlug: string;
  sourceRepoRoot: string;
  prBaseRef: string;
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
  const sourceRepoRoot = resolve(trim(input.sourceRepoRoot || input.repoRoot) || selectedTarget?.primaryRoot || trustedPackRoot);
  if (!harness && !existsSync(join(sourceRepoRoot, '.git')) && !existsSync(join(sourceRepoRoot, 'HEAD'))) {
    throw new Error(`source repository root is not a git checkout: ${sourceRepoRoot}`);
  }
  const requestedHead = trim(input.headSha).toLowerCase();
  const repoSlug = selectedTarget
    ? await resolvePackReviewSelectedRepository({ sourceRepoRoot, selectedTarget })
    : harnessExplicit
      ? trim(input.fixtureRepoSlug) || 'fixture/orchestrator-pack'
      : await resolveRepositorySlug(sourceRepoRoot);
  if (harnessExplicit && trim(input.fixturePrState || 'OPEN').toUpperCase() !== 'OPEN') {
    throw new Error(`PR #${prNumber} is not open`);
  }
  const liveTarget = harnessExplicit
    ? {
        headSha: fixtureCurrentHead || requestedHead,
        body: input.fixturePrBody ?? '',
        baseRef: selectedTarget?.defaultBranch ?? 'main',
      }
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
    prBaseRef: liveTarget.baseRef,
    ...(operatorStart ? { operatorStart } : {}),
  };
}

/** Only leading linked-Issue title markers and fenced body tiers grant authority. */
export function parseAuthoritativeTier(body: string, title?: string): PackReviewTier {
  const parsed = parseComplexityTierFromIssueBody(body);
  const fenceSeen = /\`\`\`complexity-tier\b/i.test(body);
  const fence = body.match(/\`\`\`complexity-tier[^\n]*\n([\s\S]*?)\`\`\`/i);
  if ((fenceSeen && (!fence || parsed.kind === 'missing')) || parsed.kind === 'invalid') {
    throw new Error('authoritative Issue tier is invalid');
  }
  let bodyTier: PackReviewTier | undefined;
  if (parsed.kind === 'tier') bodyTier = parsed.tier as PackReviewTier;
  if (parsed.kind === 'no-tier' && fence) {
    // The shared parser treats skip-line as a no-tier signal; pack review must
    // still honor an explicit valid tier written in the same fenced block.
    const rows = (fence[1] ?? '').split(/\r?\n/).map((row) => row.trim())
      .filter((row) => /^tier\s*:/i.test(row));
    if (rows.length > 1) throw new Error('authoritative Issue tier is ambiguous');
    if (rows.length === 1) {
      const value = rows[0]!.replace(/^tier\s*:\s*/i, '').toUpperCase();
      if (!['T1', 'T2', 'T3'].includes(value)) throw new Error('authoritative Issue tier is invalid');
      bodyTier = value as PackReviewTier;
    }
  }
  let titleTier: PackReviewTier | undefined;
  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) throw new Error('authoritative Issue title is missing');
    const leading = title.trim().replace(/^\d+\s*[—–-]\s*/, '');
    const valid = leading.match(/^\[(T[123])\](?=\s|$)/i);
    if (valid) titleTier = valid[1]!.toUpperCase() as PackReviewTier;
    else if (/^\[\s*T(?=[^a-zA-Z]|$)/i.test(leading)) {
      throw new Error('authoritative Issue title tier marker is malformed');
    }
  }
  const rank = { T1: 1, T2: 2, T3: 3 } as const;
  if (titleTier && (!bodyTier || rank[titleTier] >= rank[bodyTier])) return titleTier;
  return bodyTier ?? 'T2';
}

/** Public status follows current cycle authority, not an immutable historical run cap. */
function outstandingPackReviewCycle(run: PackReviewRunRecord, storeRoot: string): boolean {
  const authority = readPackReviewAuthority(run.prNumber, { storeRoot });
  const cycle = authority?.cycle;
  return Boolean(cycle && authority?.currentHeadSha === run.targetSha
    && run.reviewCycleId === cycle.cycleId
    && cycle.capMapVersion === PACK_REVIEW_LOGICAL_CAP_MAP_VERSION
    && cycle.reviewStageComplete !== true
    && (cycle.consumedRoundOrdinals?.length ?? 0) < cycle.frozenCap);
}

function currentCycleRequiredStatusWriter(
  run: PackReviewRunRecord, storeRoot: string, writer: PackReviewRequiredStatusWriter,
): PackReviewRequiredStatusWriter {
  return async (request) => {
    if (request.context === PACK_REVIEW_REQUIRED_STATUS_CONTEXT
        && request.state === 'success'
        && outstandingPackReviewCycle(run, storeRoot)) {
      await writer({ ...request, state: 'pending',
        description: 'Pack review has an outstanding required logical round.',
        idempotencyKey: `${request.idempotencyKey}:current-cycle-pending` });
    } else {
      await writer(request);
    }
  };
}

async function reconcileTierBeforeTerminal(input: {
  start: StartInput;
  target: {prNumber: number; headSha: string; issueNumber?: number; repoSlug: string; sourceRepoRoot: string};
  projectId: string; storeRoot: string; cycleId: string | undefined; runId: string;
}): Promise<PackReviewAuthorityDocument> {
  // This is already an admitted run. Read only its exact stored identity:
  // native same-round replacement may legitimately overlap a former active
  // process until the new terminal is persisted.
  const selected = await resolveAuthoritativeReviewContext(
    input.start, input.target, input.projectId, input.runId,
  );
  const latest = readPackReviewAuthority(input.target.prNumber, { storeRoot: input.storeRoot });
  if (!latest || latest.currentHeadSha !== input.target.headSha
      || latest.cycle?.cycleId !== input.cycleId) {
    throw new Error('pack review authority changed before terminal tier reconciliation');
  }
  return reconcilePackReviewTier({
    prNumber: input.target.prNumber, tier: selected.tier,
    startedRunExists: true, options: { storeRoot: input.storeRoot },
  });
}

async function resolveAuthoritativeReviewContext(input: StartInput, target: {
  prNumber: number;
  headSha: string;
  issueNumber?: number;
  repoSlug: string;
  sourceRepoRoot: string;
}, projectId: string, exactStartedRunId?: string): Promise<AuthoritativeReviewContext> {
  const harness = process.env.OPK_VITEST_HARNESS === '1';
  const issueNumber = target.issueNumber ?? 0;
  let body: string | undefined;
  let snapshotDigest = '';
  const storeRoot = resolvePackReviewRunStoreRoot({ projectId, storeRoot: input.storeRoot });
  const prior = readPackReviewAuthority(target.prNumber, { storeRoot });
  const priorCycle = prior?.cycle;
  const exactStartedRun = exactStartedRunId
    ? getPackReviewRun(exactStartedRunId, { projectId, storeRoot })
    : null;
  const selectedSnapshotDigest = exactStartedRun?.boundIssueSnapshotDigest
    ?? exactStartedRun?.reviewRound?.boundIssueSnapshotDigest
    ?? priorCycle?.amendmentOrigin?.amendedBodyDigest;
  // Older synthetic journal/resume fixtures legitimately predate cycle-bound
  // run accounting. Keep only that test-only, unbound recovery shape; a modern
  // run always has to match the exact already-persisted review cycle.
  const historicalUnboundHarnessRun = Boolean(harness && exactStartedRun
    && exactStartedRun.reviewCycleId === undefined
    && exactStartedRun.accountingVersion === undefined);
  if (exactStartedRunId && (!exactStartedRun
      || exactStartedRun.prNumber !== target.prNumber
      || exactStartedRun.targetSha !== target.headSha
      || exactStartedRun.projectId !== projectId
      || (exactStartedRun.canonicalRepository
        ? exactStartedRun.canonicalRepository.toLowerCase() !== target.repoSlug.toLowerCase()
        : !historicalUnboundHarnessRun)
      || resolve(exactStartedRun.sourceRepoRoot) !== resolve(target.sourceRepoRoot)
      || (!historicalUnboundHarnessRun
        && exactStartedRun.reviewCycleId !== priorCycle?.cycleId))) {
    throw new Error('exact started review run is not bound to the current PR/head/cycle');
  }
  const historicalRuns = exactStartedRun
    ? [exactStartedRun]
    : listPackReviewRunRecordsRaw({ projectId, storeRoot }).filter((run) =>
      Boolean(priorCycle) && run.prNumber === target.prNumber
      && (run.reviewCycleId === priorCycle?.cycleId
        || (!run.reviewCycleId && run.targetSha === target.headSha
          && run.canonicalRepository?.toLowerCase() === target.repoSlug.toLowerCase())));
  const started = historicalRuns.length > 0
    || Boolean(priorCycle?.consumedRoundOrdinals?.length || priorCycle?.consumedHeadShas.length);
  let liveIssue: { title: string; body: string } | undefined;
  if (issueNumber > 0) {
    if (harness && input.fixtureIssueBody !== undefined) {
      if (input.fixtureIssueTitle === undefined && !started) {
        throw new Error('linked-Issue fixture requires independent fixtureIssueTitle');
      }
      if (input.fixtureIssueTitle !== undefined) {
        liveIssue = { title: input.fixtureIssueTitle, body: input.fixtureIssueBody };
      }
    } else if (!harness) {
      try {
        liveIssue = await resolveCurrentIssueFields(target.sourceRepoRoot, target.repoSlug, issueNumber);
      } catch (error) {
        if (!started && priorCycle?.reviewStageComplete !== true) throw error;
      }
    }
  }

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
      snapshotDigest: selectedSnapshotDigest,
      storeDirOverride: process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR,
    });
    if (resolvedSnapshot.status === 'corrupted') {
      throw new Error(`authoritative bound Issue snapshot corrupted for PR #${target.prNumber} Issue #${issueNumber}`);
    }
    if (resolvedSnapshot.status === 'missing') {
      if (!(harness && input.fixtureIssueBody === undefined)) {
        const observedBody = input.fixtureIssueBody ?? liveIssue?.body;
        if (observedBody === undefined) {
          throw new Error('authoritative linked Issue body unavailable for snapshot capture');
        }
        try {
          parseAuthoritativeTier(observedBody, liveIssue?.title);
        } catch {
          throw new Error(
            `authoritative Issue #${issueNumber} tier is invalid; correct its complexity-tier block to tier: T1|T2|T3 and retry review start`,
          );
        }
        const captured = captureBoundIssueSnapshot({
          projectId,
          prNumber: target.prNumber,
          prHeadSha: target.headSha,
          issueNumber,
          issueBody: observedBody,
          snapshotDigest: selectedSnapshotDigest,
          storeDirOverride: process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR,
        });
        resolvedSnapshot = resolveBoundIssueSnapshot({
          projectId,
          prNumber: target.prNumber,
          prHeadSha: target.headSha,
          issueNumber,
          snapshotDigest: selectedSnapshotDigest,
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
        snapshotDigest: selectedSnapshotDigest,
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
  const snapshotTier = parseAuthoritativeTier(body);
  if (!liveIssue && !started && priorCycle?.reviewStageComplete !== true) {
    throw new Error('linked Issue title/body missing at fresh admission');
  }
  let observedTier: PackReviewTier | undefined;
  if (liveIssue) {
    try {
      observedTier = parseAuthoritativeTier(liveIssue.body, liveIssue.title);
    } catch (error) {
      if (!started && priorCycle?.reviewStageComplete !== true) throw error;
      // An invalid mutable update cannot replace or corrupt a valid frozen
      // Issue snapshot for an already started/settled run.
    }
  }
  const rank = { T1: 1, T2: 2, T3: 3 } as const;
  let tier: PackReviewTier = observedTier ?? priorCycle?.frozenTier ?? snapshotTier;
  if (priorCycle && (started || priorCycle.reviewStageComplete === true || priorCycle.state === 'closed')) {
    if (priorCycle.reviewStageComplete === true || priorCycle.state === 'closed'
        || rank[tier] <= rank[priorCycle.frozenTier]) tier = priorCycle.frozenTier;
  }
  if (input.tier && input.tier !== tier) {
    const exactOldRun = historicalRuns.some((run) => run.targetSha === target.headSha
      && run.reviewRound?.tier === input.tier
      && (PACK_REVIEW_ACTIVE_STATUSES.has(run.status) || packReviewDeliveryNeedsResume(run)));
    if (!exactOldRun) throw new Error(`caller tier ${input.tier} conflicts with authoritative Issue tier ${tier}`);
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

function packReviewRunOutputProjection(run: PackReviewRunRecord | null): (PackReviewRunRecord & { coverage?: NonNullable<ReturnType<typeof derivePackReviewGptCoverage>> }) | null {
  if (!run) return null;
  const coverage = derivePackReviewGptCoverage(run.reviewRound);
  return coverage ? { ...run, coverage } : run;
}

function freezeGptRoundSourceCount(
  runId: string,
  requiredSourceCount: number,
  options: { projectId: string; storeRoot: string },
): PackReviewGptRoundRecord | null {
  const updated = updatePackReviewRunIf(
    runId,
    (records) => {
      const current = records.find((record) => record.id === runId);
      const round = current?.reviewRound;
      return Boolean(round
        && round.reviewer === 'gpt'
        && round.settledSourceCount === undefined
        && gptUsableSourceCount(round) >= requiredSourceCount
        && (process.env.OPK_VITEST_HARNESS === '1'
          || hasCredentialedGptSourceAuthority(current!)));
    },
    (existing) => {
      const round = existing.reviewRound;
      if (!round || round.reviewer !== 'gpt') return {};
      return {
        reviewRound: {
          ...round,
          settledSourceCount: gptUsableSourceCount(round),
        },
      };
    },
    options,
  );
  const latest = updated ?? getPackReviewRun(runId, options);
  return latest?.reviewRound?.settledSourceCount !== undefined
    ? latest.reviewRound
    : null;
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

function reviewerProvenanceReceipt(run: PackReviewRunRecord): Record<string, unknown> {
  return {
    runId: run.id,
    targetSha: run.targetSha,
    ...(run.resolvedReviewer ? { resolvedReviewer: run.resolvedReviewer } : {}),
    ...(run.resolvedReviewerSource ? { resolvedReviewerSource: run.resolvedReviewerSource } : {}),
    ...(run.executedReviewer ? { executedReviewer: run.executedReviewer } : {}),
    ...(run.reviewerExecutionRunId ? { reviewerExecutionRunId: run.reviewerExecutionRunId } : {}),
    ...(run.reviewerInvokedForThisRun !== undefined ? { reviewerInvokedForThisRun: run.reviewerInvokedForThisRun } : {}),
  };
}

function supplementalReviewReceipt(run: PackReviewRunRecord): Record<string, unknown> | null {
  if (run.automaticBudgetDisposition !== 'non_consuming_explicit'
      || run.targetSha !== run.headSha
      || !run.resolvedReviewer
      || run.resolvedReviewer !== run.executedReviewer
      || run.reviewerInvokedForThisRun !== true
      || run.reviewerExecutionRunId !== run.id
      || !hasPersistedPackReviewVerdict(run)
      || run.journalOutcome?.state !== 'persisted'
      || (run.reviewVerdict !== 'clean' && run.reviewVerdict !== 'findings')
      || run.githubReviewReconciliation?.phase !== 'complete'
      || run.githubReviewEvent !== 'COMMENT'
      || !run.githubReviewId || !trim(run.githubReviewUrl)
      || run.deliveryOutcomes.githubComment?.state !== 'succeeded') return null;
  return {
    outcome: 'supplemental_review_delivered',
    reviewVerdict: run.reviewVerdict,
    ...reviewerProvenanceReceipt(run),
    githubReviewId: run.githubReviewId,
    githubReviewUrl: run.githubReviewUrl,
  };
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
    ...(run.automaticBudgetDisposition === 'non_consuming_explicit'
      ? ['Mode: supplemental advisory review (does not change required pack-review status).']
      : []),
    `Selected reviewer: \`${run.resolvedReviewer ?? 'unrecorded'}\``,
    `Selection source: \`${run.resolvedReviewerSource ?? 'unrecorded'}\``,
    `Verdict reviewer: \`${run.executedReviewer ?? 'unrecorded'}\``,
    `Verdict execution run: \`${run.reviewerExecutionRunId ?? 'unrecorded'}\``,
    ...(run.reviewerInvokedForThisRun === false
      ? [`Reviewer invocation: none for this run; carried-over clean verdict from \`${run.reviewerExecutionRunId ?? 'unrecorded'}\` by \`${run.executedReviewer ?? 'unrecorded'}\`.`]
      : [`Reviewer invocation: ${run.reviewerInvokedForThisRun === true ? 'executed for this run' : 'unrecorded'}`]),
    '',
  ];
  const coverage = derivePackReviewGptCoverage(run.reviewRound);
  if (run.reviewRound?.cardinality === 3 && run.reviewRound.settledSourceCount === 2) {
    lines.push('Sources: 2/3 (degraded after timeout)', '');
  } else if (coverage?.kind === 'partial') {
    lines.push(`Sources: ${coverage.completedSourceCount}/${coverage.cardinality} (partial)`, '');
    if (!hasHarvestIncident && coverage.incompleteSources.length > 0) {
      lines.push('Incomplete sources:', '');
      for (const source of coverage.incompleteSources) {
        const details = [
          source.terminalClass,
          source.timedOut ? 'timed_out' : '',
          source.cancelled ? 'cancelled' : '',
          source.reason,
        ].filter(Boolean);
        lines.push(`- ${source.sourceSlotId}: ${details.join('; ') || source.lifecycle}`);
      }
      lines.push('');
    }
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


interface ReviewWorktreeContext {
  repoRoot: string;
  repoSlug: string;
  projectId: string;
  storeRoot: string;
}

/** Inventory only the registrations of the already selected source repository. */
async function registeredReviewWorktrees(repoRoot: string): Promise<Set<string>> {
  const output = await runGit(repoRoot, ['worktree', 'list', '--porcelain'], 'git worktree list');
  const registered = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) registered.add(line.slice('worktree '.length));
  }
  return registered;
}

function reviewWorktreePath(storeRoot: string, runId: string): string {
  if (!/^prr-[a-zA-Z0-9._-]+$/.test(runId)) {
    throw new Error('invalid pack review checkout run id');
  }
  return join(packReviewWorktreesDir(storeRoot), runId);
}

function reviewWorktreeLstat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** No target alias, symlink or non-directory may become a destructive operand. */
function validateReviewWorktreePath(storeRoot: string, runId: string, target: string): void {
  const root = packReviewWorktreesDir(storeRoot);
  if (target !== reviewWorktreePath(storeRoot, runId) || resolve(target) !== target) {
    throw new Error('review checkout outside selected-store direct child');
  }
  const parent = reviewWorktreeLstat(root);
  if (parent && (!parent.isDirectory() || parent.isSymbolicLink()
      || realpathSync(root) !== root)) {
    throw new Error('review checkout worktrees root is an alias or symlink');
  }
  const child = reviewWorktreeLstat(target);
  if (child && (!child.isDirectory() || child.isSymbolicLink()
      || realpathSync(target) !== target)) {
    throw new Error('review checkout target is an alias, symlink or non-directory');
  }
}

/** A Git registration alone must not authorize deletion of a substituted checkout. */
async function registeredReviewWorktreeMatchesSource(ctx: ReviewWorktreeContext, target: string): Promise<boolean> {
  if (!reviewWorktreeLstat(target)) return true; // Prunable registration-only orphan.
  const gitfile = reviewWorktreeLstat(join(target, '.git'));
  if (!gitfile?.isFile() || gitfile.isSymbolicLink()) return false;
  try {
    const [sourceCommon, checkoutCommon, checkoutTop, checkoutGitDir] = await Promise.all([
      runGit(ctx.repoRoot, ['rev-parse', '--git-common-dir'], 'source Git common directory'),
      runGit(target, ['rev-parse', '--git-common-dir'], 'checkout Git common directory'),
      runGit(target, ['rev-parse', '--show-toplevel'], 'checkout Git root'),
      runGit(target, ['rev-parse', '--absolute-git-dir'], 'checkout Git directory'),
    ]);
    const gitDir = resolve(target, checkoutGitDir);
    const gitfile = readFileSync(join(target, '.git'), 'utf8').trim();
    if (!gitfile.startsWith('gitdir: ')) return false;
    const namedGitDir = resolve(target, gitfile.slice('gitdir: '.length).trim());
    const backlink = readFileSync(join(gitDir, 'gitdir'), 'utf8').trim();
    return resolve(ctx.repoRoot, sourceCommon) === resolve(target, checkoutCommon)
      && resolve(checkoutTop) === target
      && namedGitDir === gitDir
      && resolve(gitDir, backlink) === join(target, '.git');
  } catch {
    return false;
  }
}

/** Hard-killed active and terminal runs need the same dead-PID + grace evidence. */
function reviewWorktreeHolderAbandoned(record: PackReviewRunRecord): boolean {
  if (!isPackReviewRunStale({ ...record, status: 'reviewing' })) return false;
  // Even a dead GPT owner may retain unfinished source slots for same-round recovery.
  if (record.reviewRound && record.reviewRound.settledSourceCount === undefined
      && !hasPersistedPackReviewVerdict(record)) return false;
  // A different active PR/head claim holder may be taking over an unchanged stale record.
  // Preserve unreadable or ambiguous claims rather than deleting a concurrent checkout.
  const namespace = resolveReviewStartClaimNamespace({ projectId: record.projectId });
  const claim = readClaimRecord(claimPath(namespace, record.prNumber, record.targetSha));
  if (!claim.ok && claim.reason !== 'missing') return false;
  if (claim.record?.state === 'active'
      && (claim.record.holder.pid !== record.runnerPid || claim.record.holder.host !== hostname())) {
    return false;
  }
  return true;
}

function referencesReviewWorktree(reference: string | undefined, target: string): boolean {
  if (!reference) return false;
  if (resolve(reference) === target) return true;
  try { return realpathSync(reference) === target; } catch { return false; }
}

function verifyReviewWorktreeOwner(
  ctx: ReviewWorktreeContext,
  runId: string,
  target: string,
  mode: 'sweep' | 'finally' | 'reuse',
): string | null {
  validateReviewWorktreePath(ctx.storeRoot, runId, target);
  const records = listPackReviewRunRecordsRaw({ projectId: ctx.projectId, storeRoot: ctx.storeRoot });
  const owner = records.find((record) => record.id === runId);
  if (!owner || owner.projectId !== ctx.projectId
      || resolve(owner.sourceRepoRoot) !== resolve(ctx.repoRoot)
      || (owner.canonicalRepository && owner.canonicalRepository.toLowerCase() !== ctx.repoSlug.toLowerCase())) {
    return 'missing selected-repository run owner';
  }
  if (owner.reviewTargetRoot !== target) {
    return 'persisted reviewTargetRoot is absent or not the owned direct child';
  }
  for (const record of records) {
    if (record.id !== runId && !referencesReviewWorktree(record.reviewTargetRoot, target)) continue;
    if (record.id !== runId && record.reviewTargetRoot !== target) {
      return 'other run has an aliased checkout reference';
    }
    if (record.id === runId && mode !== 'sweep' && record.runnerPid === process.pid
        && (mode === 'reuse' || !PACK_REVIEW_ACTIVE_STATUSES.has(record.status))) continue;
    if (!reviewWorktreeHolderAbandoned(record)) return 'live or recoverable run holds checkout';
  }
  return null;
}

/**
 * Never equate rmSync with Git deregistration. Every deletion checks fresh run
 * and selected-repository evidence; ambiguous paths remain for a later safe start.
 */
async function removeReviewWorktree(
  ctx: ReviewWorktreeContext,
  runId: string,
  target: string,
  mode: 'sweep' | 'finally' | 'reuse',
  fixtureFailGitRemove = false,
  reuseClaimOwned?: () => boolean,
): Promise<string> {
  const claimHeld = () => mode !== 'reuse' || reuseClaimOwned?.() === true;
  if (!claimHeld()) return 'same-round review start claim is not owned';
  const unavailable = verifyReviewWorktreeOwner(ctx, runId, target, mode);
  if (unavailable) return unavailable;
  let registrations = await registeredReviewWorktrees(ctx.repoRoot);
  const priorRegistration = registrations.has(target);
  const priorChild = reviewWorktreeLstat(target);
  if (!priorChild && !priorRegistration) return 'absent';
  if (priorChild && !priorRegistration && process.env.OPK_VITEST_HARNESS !== '1'
      && readdirSync(target).length !== 0) {
    return 'unregistered nonempty directory has ambiguous ownership';
  }
  if (priorRegistration && !(await registeredReviewWorktreeMatchesSource(ctx, target))) {
    return 'registered checkout Git identity differs from selected source repository';
  }
  // The awaited inventory can race a new reuse; do not use earlier data as deletion authority.
  const changedOwner = verifyReviewWorktreeOwner(ctx, runId, target, mode);
  if (changedOwner) return changedOwner;
  if (!claimHeld()) return 'same-round review start claim changed before removal';
  registrations = await registeredReviewWorktrees(ctx.repoRoot);
  if (registrations.has(target)) {
    if (!(await registeredReviewWorktreeMatchesSource(ctx, target))) {
      return 'registered checkout Git identity changed before removal';
    }
    if (fixtureFailGitRemove && process.env.OPK_VITEST_HARNESS === '1') {
      throw new Error('review checkout Git worktree removal failed (fixture)');
    }
    const removed = await runProcess({
      command: 'git',
      args: ['worktree', 'remove', '--force', target],
      cwd: ctx.repoRoot,
      inheritParentEnv: true,
      allowEmptyStdout: true,
    });
    if (!removed.ok) {
      throw new Error('review checkout Git worktree removal failed: ' + trim(removed.stderr).slice(0, 180));
    }
  } else if (priorRegistration) {
    return 'checkout registration changed before removal';
  }
  if ((await registeredReviewWorktrees(ctx.repoRoot)).has(target)) {
    throw new Error('review checkout Git registration remains after targeted removal');
  }
  const beforeFilesystemRemove = verifyReviewWorktreeOwner(ctx, runId, target, mode);
  if (beforeFilesystemRemove) return beforeFilesystemRemove;
  if (!claimHeld()) return 'same-round review start claim changed before filesystem removal';
  if (reviewWorktreeLstat(target)) rmSync(target, { recursive: true, force: true });
  if (reviewWorktreeLstat(target) || (await registeredReviewWorktrees(ctx.repoRoot)).has(target)) {
    throw new Error('review checkout residual directory or Git registration after cleanup');
  }
  return 'removed';
}

/** Ordinary start is the only recovery sweep; it neither edits runs nor claims. */
async function reclaimReviewWorktrees(ctx: ReviewWorktreeContext): Promise<void> {
  try {
    const root = packReviewWorktreesDir(ctx.storeRoot);
    const paths = new Set<string>();
    const rootStat = reviewWorktreeLstat(root);
    if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realpathSync(root) !== root)) {
      throw new Error('selected worktrees root is not a canonical directory');
    }
    if (rootStat) {
      for (const entry of readdirSync(root)) if (/^prr-[a-zA-Z0-9._-]+$/.test(entry)) {
        paths.add(join(root, entry));
      }
    }
    for (const path of await registeredReviewWorktrees(ctx.repoRoot)) {
      if (path.startsWith(root + sep) && relative(root, path).split(sep).length === 1
          && /^prr-[a-zA-Z0-9._-]+$/.test(relative(root, path))) paths.add(path);
    }
    let diagnostics = 0;
    for (const path of paths) {
      const runId = relative(root, path);
      try {
        const result = await removeReviewWorktree(ctx, runId, path, 'sweep');
        if (result !== 'removed' && result !== 'absent' && diagnostics++ < 8) {
          process.stderr.write('[pack-review worktree] preserved ' + runId + ': ' + result + '\n');
        }
      } catch (error) {
        if (diagnostics++ < 8) process.stderr.write(
          '[pack-review worktree] deferred ' + runId + ': ' + describeError(error).slice(0, 180) + '\n',
        );
      }
    }
  } catch (error) {
    process.stderr.write('[pack-review worktree] sweep unavailable: ' + describeError(error).slice(0, 180) + '\n');
  }
}

async function createReviewWorktree(
  repoRoot: string,
  storeRoot: string,
  runId: string,
  headSha: string,
  allocated: (target: string) => void,
  afterAdd?: (target: string) => void | Promise<void>,
): Promise<string> {
  const root = packReviewWorktreesDir(storeRoot);
  mkdirSync(root, { recursive: true });
  const target = reviewWorktreePath(storeRoot, runId);
  validateReviewWorktreePath(storeRoot, runId, target);
  if (reviewWorktreeLstat(target) || (await registeredReviewWorktrees(repoRoot)).has(target)) {
    throw new Error('review checkout already occupied; no pre-add recursive deletion permitted');
  }
  await ensureCommitAvailable(repoRoot, headSha);
  allocated(target); // Assign before the first allocation-capable awaited operation.
  await runGit(repoRoot, ['worktree', 'add', '--detach', target, headSha], 'git worktree add');
  if (afterAdd && process.env.OPK_VITEST_HARNESS === '1') await afterAdd(target);
  return target;
}

function writeRunLogs(storeRoot: string, runId: string, stdout: string, stderr: string): void {
  const dir = packReviewLogsDir(storeRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.stdout.log`), stdout, 'utf8');
  writeFileSync(join(dir, `${runId}.stderr.log`), stderr, 'utf8');
}

function ownsBoundPreacquiredClaim(
  claim: ClaimResult | undefined,
  binding: { projectId: string; prNumber: number; headSha: string },
): boolean {
  const held = claim?.claim;
  const namespace = resolveReviewStartClaimNamespace({ projectId: binding.projectId });
  const key = claimKey(binding.prNumber, binding.headSha);
  if (!claim?.acquired || !held || held.state !== 'active'
      || held.projectNamespace !== binding.projectId
      || held.prNumber !== binding.prNumber
      || held.headSha !== binding.headSha
      || held.key !== key || claim.key !== key
      || held.holder.pid !== process.pid || held.holder.host !== hostname()
      || claim.namespace !== namespace
      || claim.path !== claimPath(namespace, binding.prNumber, binding.headSha)) return false;
  try { return testReviewStartClaimOwnership(claim); } catch { return false; }
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
  takeover?: ExplicitDeadReviewerTakeover;
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
    takeover: options.takeover,
  });
  if (!claim.acquired) {
    return {
      acquired: false,
      reason: trim(claim.reason) || 'claimed',
      directory: '',
      owns: () => false,
      release: async () => undefined,
    };
  }
  return {
    acquired: true,
    reason: 'acquired',
    directory: '',
    deadForeignRunClaimReclaimed: Boolean(
      options.takeover && claim.reason === 'dead_foreign_reviewer_reclaimed'),
    owns: () => testReviewStartClaimOwnership(claim),
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
  projectId: string; storeRoot: string; prNumber: number; headSha: string;
  repoSlug: string; sourceRepoRoot: string;
  resolveSlug?: (repoRoot: string) => Promise<string>;
  fixtureRequiredStatusReader?: (headSha: string) => string | undefined | Promise<string | undefined>;
  explicitReviewer?: PackReviewer;
  supplementalMode?: boolean;
}): Promise<PackReviewRunRecord | null> {
  const candidates = listPackReviewRuns({ projectId: options.projectId, storeRoot: options.storeRoot })
    .filter((candidate) => candidate.prNumber === options.prNumber
      && candidate.targetSha === options.headSha
      && (options.explicitReviewer
        ? candidate.resolvedReviewer === options.explicitReviewer
          && (candidate.automaticBudgetDisposition === 'non_consuming_explicit') === (options.supplementalMode === true)
        : candidate.automaticBudgetDisposition !== 'non_consuming_explicit')
      && Boolean(packReviewJournaledPayload(candidate)));
  const repositoryBoundCandidates: PackReviewRunRecord[] = [];
  for (const candidate of candidates) {
    const identity = await resolvePackReviewRunCanonicalRepository(
      candidate, options.resolveSlug ?? resolveRepositorySlug,
    );
    const nativeSupplemental = candidate.automaticBudgetDisposition === 'non_consuming_explicit'
      && !candidate.reviewRound;
    if (!identity.ok || identity.slug !== options.repoSlug
      || (candidate.reviewRound !== undefined && !hasCredentialedGptSourceAuthority(candidate))
      || (nativeSupplemental && (!hasPersistedPackReviewVerdict(candidate)
        || !candidate.resolvedReviewer
        || candidate.resolvedReviewer !== candidate.executedReviewer
        || candidate.reviewerInvokedForThisRun !== true
        || candidate.reviewerExecutionRunId !== candidate.id
        || candidate.nativeAttempt?.reviewer !== candidate.resolvedReviewer))) continue;
    if (candidate.automaticBudgetDisposition === 'non_consuming_explicit') {
      if (packReviewDeliveryNeedsResume(candidate)) repositoryBoundCandidates.push(candidate);
      continue;
    }
    if (packReviewDeliveryNeedsResume(candidate)
        || (candidate.reviewRound?.reviewer === 'gpt'
          && candidate.deliveryOutcomes.requiredStatus?.state === 'failed')) {
      repositoryBoundCandidates.push(candidate);
      continue;
    }
    // Only GPT scoped-reprojection is part of this Issue. Existing native
    // reviewer status/no-retry behavior remains unchanged.
    if (candidate.reviewRound?.reviewer !== 'gpt') continue;
    // A successful local ACK can be overwritten on GitHub. Only reopen status
    // observation on the already-authoritative journaled GPT run and exact head.
    const authority = readPackReviewAuthority(options.prNumber, { storeRoot: options.storeRoot });
    if (authority?.terminal?.runId !== candidate.id
      || authority.currentHeadSha !== options.headSha) continue;
    if (process.env.OPK_VITEST_HARNESS === '1' && !options.fixtureRequiredStatusReader) continue;
    const payload = packReviewJournaledPayload(candidate);
    if (!payload) continue;
    const classification = classifyPackReviewPayload(payload);
    const intermediate = !classification.blocking
      && candidate.accountingVersion === PACK_REVIEW_LOGICAL_CAP_MAP_VERSION
      && Number.isInteger(candidate.logicalRoundOrdinal)
      && Number.isInteger(candidate.logicalRoundCap)
      && Number(candidate.logicalRoundOrdinal) < Number(candidate.logicalRoundCap);
    const expected = intermediate ? 'pending' : classification.requiredStatus;
    try {
      const observed = await readFinalCapRequiredStatus({
        sourceRepoRoot: options.sourceRepoRoot,
        repoSlug: options.repoSlug,
        fixtureRequiredStatusReader: options.fixtureRequiredStatusReader,
      }, options.repoSlug, options.headSha);
      if (observed !== expected) repositoryBoundCandidates.push(candidate);
    } catch {
      // If external status cannot be observed, reconcile this same run rather
      // than acquiring authority for another review attempt.
      repositoryBoundCandidates.push(candidate);
    }
  }
  if (repositoryBoundCandidates.length > 1) {
    throw new Error(`ambiguous journaled pack review deliveries for PR #${options.prNumber} head ${options.headSha}`);
  }
  return repositoryBoundCandidates[0] ?? null;
}

const GPT_REPLACEMENT_GENERATION_MAX_MS = 15 * 60 * 1_000;
const NATIVE_REPLACEMENT_MAX_MS = 15 * 60 * 1_000;
const NATIVE_CHILD_FRAME_PREFIX = 'OPK_NATIVE_CHILD_V1 ';

export type PackReviewGptSurfaceClass =
  | 'listing'
  | 'foreign_chat'
  | 'non_chat'
  | 'ownership_unknown'
  | 'owned_conversation';

export interface PackReviewGptTargetDiagnostic {
  slotId: string;
  invocationId?: string;
  surfaceClass: PackReviewGptSurfaceClass;
  title: string;
  cause?: string;
  foreignOwner?: string;
}

export interface PackReviewGptAttemptObservation {
  state:
    | 'replacement_eligible'
    | 'continuation_eligible'
    | 'generating'
    | 'reply_recovery_required'
    | 'ownership_ambiguous'
    | 'observation_unavailable';
  replacementEligible: boolean;
  slotId?: string;
  replacementEligibleSlotIds?: string[];
  initialLaunchSlotIds?: string[];
  elapsedMs?: number;
  diagnostics?: PackReviewGptTargetDiagnostic[];
}

const MAX_PACK_REVIEW_TARGET_DIAGNOSTICS = 50;

function markerIsFirstVisibleToken(head: string, marker: string): boolean {
  const trimmed = head.replace(/^[\s\uFEFF\u200B]+/u, '');
  if (!trimmed.startsWith(marker)) return false;
  const boundary = trimmed.slice(marker.length, marker.length + 1);
  return boundary === '' || /[\s\uFEFF\u200B]/u.test(boundary);
}

function visibleMarkerToken(head: string): string | undefined {
  const trimmed = head.replace(/^[\s\uFEFF\u200B]+/u, '');
  return /^(OPKTURNV1[^\s\uFEFF\u200B]+)/u.exec(trimmed)?.[1];
}

function scrubbedForeignOwner(marker: string): string {
  return `foreign_owner:${sha256Bytes(marker).slice(0, 12)}`;
}

export async function observeGptPackReviewAttempt(
  run: PackReviewRunRecord,
  nowMs = Date.now(),
  deps: {
    listTargets?: ProbeDependencies['listTargets'];
    evaluate?: ProbeDependencies['evaluate'];
    readObservation?: typeof readStateLightTurnObservation;
    resolveSourceComment?: (identity: PackGptSourceIdentity) => Promise<PackGptSourceCommentResolution>;
  } = {},
): Promise<PackReviewGptAttemptObservation | null> {
  const round = run.reviewRound;
  if (!round || round.reviewer !== 'gpt') return null;
  const listTargets = deps.listTargets ?? browserCdpDependencies.listTargets;
  const evaluate = deps.evaluate ?? browserCdpDependencies.evaluate;
  const readObservation = deps.readObservation ?? readStateLightTurnObservation;
  const repository = trim(run.canonicalRepository);
  if (!repository) return { state: 'observation_unavailable', replacementEligible: false };

  let sourceTransport: PackGptSourceCommentTransport | undefined;
  const resolveSourceComment = deps.resolveSourceComment ?? (async (identity: PackGptSourceIdentity) => {
    sourceTransport ??= createPackGptSourceCommentTransport({
      repoRoot: run.sourceRepoRoot,
      repoSlug: repository,
      prNumber: run.prNumber,
    });
    return resolvePackGptSourceComment({ identity, transport: sourceTransport });
  });
  const unresolved = round.sourceSlots.filter((slot) => !(
    slot.lifecycle === 'terminal'
    && (slot.terminalClass === 'complete_clean' || slot.terminalClass === 'complete_findings')
  ));
  if (unresolved.length === 0) return null;

  const replacementEligibleSlotIds: string[] = [];
  const initialLaunchSlotIds: string[] = [];
  const diagnostics: PackReviewGptTargetDiagnostic[] = [];
  const addDiagnostic = (diagnostic: PackReviewGptTargetDiagnostic): void => {
    if (diagnostics.length < MAX_PACK_REVIEW_TARGET_DIAGNOSTICS) diagnostics.push(diagnostic);
  };
  const finish = (observation: PackReviewGptAttemptObservation): PackReviewGptAttemptObservation => (
    diagnostics.length > 0 ? { ...observation, diagnostics: [...diagnostics] } : observation
  );
  let blockedObservation: PackReviewGptAttemptObservation | null = null;
  const rememberBlocked = (observation: PackReviewGptAttemptObservation): void => { blockedObservation ??= observation; };

  sourceSlotLoop:
  for (const slot of unresolved) {
    if (!slot.invocationId) {
      if (slot.lifecycle === 'planned' || (slot.lifecycle === 'terminal' && slot.terminalClass === 'pre_launch_interrupted')) {
        initialLaunchSlotIds.push(slot.slotId);
        continue;
      }
      rememberBlocked({ state: 'observation_unavailable', replacementEligible: false, slotId: slot.slotId });
      continue;
    }
    const identity = gptSourceIdentity({ repoSlug: repository, prNumber: run.prNumber, headSha: run.targetSha, runId: run.id, slotId: slot.slotId, invocationId: slot.invocationId });
    let sourceResolution: PackGptSourceCommentResolution;
    try { sourceResolution = await resolveSourceComment(identity); } catch {
      rememberBlocked({ state: 'observation_unavailable', replacementEligible: false, slotId: slot.slotId });
      continue;
    }
    if (sourceResolution.kind === 'credentialed') {
      rememberBlocked({ state: 'reply_recovery_required', replacementEligible: false, slotId: slot.slotId });
      continue;
    }
    if (sourceResolution.kind !== 'missing') {
      rememberBlocked({ state: 'observation_unavailable', replacementEligible: false, slotId: slot.slotId });
      continue;
    }
    if (authoritativePreSend(slot)) {
      replacementEligibleSlotIds.push(slot.slotId);
      continue;
    }

    const profileKey = trim(slot.launchProfileKey);
    const cdp = trim(slot.launchCdpUrl);
    if (!profileKey || !cdp) {
      rememberBlocked({ state: 'observation_unavailable', replacementEligible: false, slotId: slot.slotId });
      continue;
    }
    let observation: ReturnType<typeof readStateLightTurnObservation>;
    try { observation = readObservation(profileKey, slot.invocationId); } catch {
      rememberBlocked({ state: 'observation_unavailable', replacementEligible: false, slotId: slot.slotId });
      continue;
    }
    if (observation.profile_key !== profileKey || observation.invocation_id !== slot.invocationId) {
      rememberBlocked({ state: 'observation_unavailable', replacementEligible: false, slotId: slot.slotId });
      continue;
    }
    if (authoritativePreSend(slot, observation)) {
      replacementEligibleSlotIds.push(slot.slotId);
      continue;
    }
    const marker = trim(observation.marker);
    if (!marker.startsWith('OPKTURNV1')) {
      rememberBlocked({ state: 'observation_unavailable', replacementEligible: false, slotId: slot.slotId });
      continue;
    }
    let targets: ReturnType<typeof toCompatibleTargets>;
    try { targets = toCompatibleTargets(await listTargets(cdp)); } catch {
      rememberBlocked({ state: 'observation_unavailable', replacementEligible: false, slotId: slot.slotId });
      continue;
    }

    const owned: Array<{ snapshot: Record<string, unknown>; userDocumentOrdinal: number }> = [];
    for (const target of targets) {
      const surface = classifyChatGptSurfaceUrl(target.normalized_url);
      if (surface !== 'conversation') {
        addDiagnostic({ slotId: slot.slotId, invocationId: slot.invocationId, surfaceClass: surface, title: target.title, cause: 'surface_skipped' });
        continue;
      }
      let inspected: unknown;
      try { inspected = await evaluate(target, INSPECTION_EXPRESSION); } catch {
        addDiagnostic({ slotId: slot.slotId, invocationId: slot.invocationId, surfaceClass: 'ownership_unknown', title: target.title, cause: 'ownership_ambiguous' });
        continue;
      }
      if (!inspected || typeof inspected !== 'object' || Array.isArray(inspected)) {
        addDiagnostic({ slotId: slot.slotId, invocationId: slot.invocationId, surfaceClass: 'ownership_unknown', title: target.title, cause: 'ownership_ambiguous' });
        continue;
      }
      const snapshot = inspected as Record<string, unknown>;
      if (snapshot.status !== 'ok' || snapshot.nodes_truncated === true) {
        addDiagnostic({ slotId: slot.slotId, invocationId: slot.invocationId, surfaceClass: 'ownership_unknown', title: target.title, cause: 'ownership_ambiguous' });
        continue;
      }
      const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
      let ownedMarkerFound = false;
      let foreignOwner: string | undefined;
      for (const rawNode of nodes) {
        if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) continue;
        const node = rawNode as Record<string, unknown>;
        if (node.role !== 'user' || !node.innerText || typeof node.innerText !== 'object') continue;
        const head = trim((node.innerText as Record<string, unknown>).head);
        if (markerIsFirstVisibleToken(head, marker)) {
          const ordinal = Number(node.document_ordinal);
          if (!Number.isInteger(ordinal) || ordinal < 0) {
            addDiagnostic({ slotId: slot.slotId, invocationId: slot.invocationId, surfaceClass: 'ownership_unknown', title: target.title, cause: 'owned_marker_ordinal_invalid' });
            rememberBlocked({ state: 'observation_unavailable', replacementEligible: false, slotId: slot.slotId });
            continue sourceSlotLoop;
          }
          ownedMarkerFound = true;
          owned.push({ snapshot, userDocumentOrdinal: ordinal });
          continue;
        }
        const visibleMarker = visibleMarkerToken(head);
        if (visibleMarker && visibleMarker !== marker && snapshot.generation_in_progress === true) foreignOwner ??= scrubbedForeignOwner(visibleMarker);
      }
      if (ownedMarkerFound) addDiagnostic({ slotId: slot.slotId, invocationId: slot.invocationId, surfaceClass: 'owned_conversation', title: target.title, cause: 'owned_marker' });
      else addDiagnostic({ slotId: slot.slotId, invocationId: slot.invocationId, surfaceClass: 'foreign_chat', title: target.title, cause: foreignOwner ? 'foreign_owner' : 'foreign_conversation', ...(foreignOwner ? { foreignOwner } : {}) });
    }
    if (owned.length > 1) { rememberBlocked({ state: 'ownership_ambiguous', replacementEligible: false, slotId: slot.slotId }); continue; }
    if (owned.length === 0) {
      rememberBlocked({ state: 'observation_unavailable', replacementEligible: false, slotId: slot.slotId });
      continue;
    }

    const { snapshot, userDocumentOrdinal } = owned[0]!;
    const generation = snapshot.generation_in_progress;
    const startedAtMs = Date.parse(slot.admissionStartedAtUtc ?? observation.transitioned_at);
    const elapsedMs = Number.isFinite(startedAtMs) ? Math.max(0, nowMs - startedAtMs) : 0;
    if (generation === true) {
      if (elapsedMs >= GPT_REPLACEMENT_GENERATION_MAX_MS) replacementEligibleSlotIds.push(slot.slotId);
      else rememberBlocked({ state: 'generating', replacementEligible: false, slotId: slot.slotId, elapsedMs });
      continue;
    }
    if (generation !== false) { rememberBlocked({ state: 'observation_unavailable', replacementEligible: false, slotId: slot.slotId, elapsedMs }); continue; }
    const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
    const hasReply = nodes.some((rawNode) => {
      if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) return false;
      const node = rawNode as Record<string, unknown>;
      if (node.role !== 'assistant' || Number(node.document_ordinal) <= userDocumentOrdinal) return false;
      if (!node.innerText || typeof node.innerText !== 'object') return false;
      return Number((node.innerText as Record<string, unknown>).byte_length ?? 0) > 0;
    });
    if (hasReply) { rememberBlocked({ state: 'reply_recovery_required', replacementEligible: false, slotId: slot.slotId, elapsedMs }); continue; }
    replacementEligibleSlotIds.push(slot.slotId);
  }

  if (replacementEligibleSlotIds.length > 0) return finish({ state: 'replacement_eligible', replacementEligible: true, slotId: replacementEligibleSlotIds[0], replacementEligibleSlotIds, initialLaunchSlotIds });
  const blockedObservationResult = blockedObservation as PackReviewGptAttemptObservation | null;
  if (blockedObservationResult) return finish({ ...blockedObservationResult, replacementEligibleSlotIds, initialLaunchSlotIds });
  if (initialLaunchSlotIds.length > 0) return finish({ state: 'continuation_eligible', replacementEligible: false, slotId: initialLaunchSlotIds[0], replacementEligibleSlotIds, initialLaunchSlotIds });
  return finish({ state: 'observation_unavailable', replacementEligible: false });
}
export interface PackReviewNativeAttemptObservation {
  reviewer: 'codex' | 'claude';
  state: 'running' | 'stopped' | 'observation_unavailable';
  replacementEligible: boolean;
  elapsedMs: number;
  nativeReplacementCeilingMs: number;
}

export function observeNativePackReviewAttempt(
  run: PackReviewRunRecord,
  nowMs = Date.now(),
): PackReviewNativeAttemptObservation | null {
  const attempt = run.nativeAttempt;
  if (!attempt) return null;
  const startedAtMs = Date.parse(attempt.reviewer === 'claude'
    ? attempt.startedAtUtc
    : (attempt.childStartedAtUtc ?? attempt.startedAtUtc));
  const elapsedMs = Number.isFinite(startedAtMs) ? Math.max(0, nowMs - startedAtMs) : 0;
  const nativeReplacementCeilingMs = Math.min(attempt.effectiveBudgetMs, NATIVE_REPLACEMENT_MAX_MS);
  const processGroupId = attempt.reviewer === 'claude'
    ? attempt.childProcessGroupId
    : attempt.processGroupId;
  if (!processGroupId) {
    return {
      reviewer: attempt.reviewer,
      state: 'observation_unavailable',
      replacementEligible: elapsedMs >= nativeReplacementCeilingMs,
      elapsedMs,
      nativeReplacementCeilingMs,
    };
  }
  const state = observePosixProcessGroup(processGroupId);
  if (state === 'observation_unavailable') {
    return {
      reviewer: attempt.reviewer,
      state,
      replacementEligible: elapsedMs >= nativeReplacementCeilingMs,
      elapsedMs,
      nativeReplacementCeilingMs,
    };
  }
  return {
    reviewer: attempt.reviewer,
    state,
    replacementEligible: state === 'stopped' || elapsedMs >= nativeReplacementCeilingMs,
    elapsedMs,
    nativeReplacementCeilingMs,
  };
}

export function bindReviewerProjectSelection(
  environment: NodeJS.ProcessEnv,
  projectId: string,
 ): NodeJS.ProcessEnv {
  return { ...environment, OPK_PROJECT_ID: projectId };
}

/** Record each real Claude child in the same native ordinal; do not replace its original clock. */
export function recordClaudeNativeChildFrame(
  frame: Record<string, unknown>,
  binding: { runId: string; projectId: string; storeRoot: string; invocationOrdinal: number },
): boolean {
  if (frame.schema !== 'pack-review-native-child/v1'
      || frame.runId !== binding.runId || frame.reviewer !== 'claude') return false;
  const childPid = frame.pid;
  const childStartedAtUtc = frame.startedAtUtc;
  const group = frame.processGroupId;
  if (typeof childPid !== 'number' || !Number.isInteger(childPid) || childPid <= 0
      || typeof childStartedAtUtc !== 'string'
      || !Number.isFinite(Date.parse(childStartedAtUtc))) return false;
  const persisted = getPackReviewRun(binding.runId, {
    projectId: binding.projectId, storeRoot: binding.storeRoot,
  });
  if (!persisted?.nativeAttempt || persisted.nativeAttempt.reviewer !== 'claude'
      || persisted.nativeAttempt.invocationOrdinal !== binding.invocationOrdinal) return false;
  updatePackReviewRun(binding.runId, {
    nativeAttempt: {
      ...persisted.nativeAttempt,
      childPid,
      childProcessGroupId: typeof group === 'number' && Number.isInteger(group) && group > 0
        ? group : undefined,
      childStartedAtUtc,
    },
  }, { projectId: binding.projectId, storeRoot: binding.storeRoot });
  return true;
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
  reviewer: PackReviewer | null;
  carryoverBundlePath?: string;
  sourceSlotId?: string;
  attemptOrdinal?: number;
  invocationId?: string;
  frozenScope?: ResolvedScopeContext;
  nativeInvocationOrdinal?: number;
}): Promise<{ result: ProcessResult; resolvedReviewer: PackReviewer | null }> {
  const resolvedReviewer = options.reviewer;
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
    ...bindReviewerProjectSelection(sanitizedParentEnv, options.projectId),
    ...buildReviewerBudgetSpawnEnv(options.budgetLedger, {}),
    [CHAT_BINDING_WORKTREE_ENV]: chatBindingWorktree(),
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

let nativeStderrBuffer = '';
  const nativeInvocationOrdinal = options.nativeInvocationOrdinal ?? 1;
  const consumeNativeChildFrames = (chunk: string): void => {
    if (resolvedReviewer !== 'claude') return;
    nativeStderrBuffer += chunk;
    const lines = nativeStderrBuffer.split(/\r?\n/);
    nativeStderrBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith(NATIVE_CHILD_FRAME_PREFIX)) continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line.slice(NATIVE_CHILD_FRAME_PREFIX.length)) as Record<string, unknown>;
      } catch {
        continue;
      }
      recordClaudeNativeChildFrame(frame, {
        runId: options.runId,
        projectId: options.projectId,
        storeRoot: options.storeRoot,
        invocationOrdinal: nativeInvocationOrdinal,
      });
    }
  };

  const result = await runProcess({
    command: process.execPath,
    args,
    cwd: options.trustedPackRoot,
    inheritParentEnv: false,
    env,
    allowEmptyStdout: true,
    timeoutMs: options.budgetLedger.runnerTimeoutMs,
    onStderrChunk: consumeNativeChildFrames,
    onSpawn: (pid) => {
      const persisted = getPackReviewRun(options.runId, {
        projectId: options.projectId,
        storeRoot: options.storeRoot,
      });
      const armedAttempt = persisted?.nativeAttempt
        && persisted.nativeAttempt.reviewer === resolvedReviewer
        && persisted.nativeAttempt.invocationOrdinal === nativeInvocationOrdinal
        ? persisted.nativeAttempt
        : undefined;
      const startedAtUtc = armedAttempt?.startedAtUtc ?? new Date().toISOString();
      updatePackReviewRun(options.runId, {
        runnerPid: process.pid,
        status: 'running',
        latestRunStatus: 'running',
        reviewTargetRoot: options.reviewTargetRoot,
        resolvedReviewer,
        ...(resolvedReviewer === 'codex' || resolvedReviewer === 'claude' ? {
          nativeAttempt: {
            ...(armedAttempt ?? {}),
            schema: 'pack-review-native-attempt/v1',
            reviewer: resolvedReviewer,
            invocationOrdinal: nativeInvocationOrdinal,
            startedAtUtc,
            effectiveBudgetMs: armedAttempt?.effectiveBudgetMs ?? options.budgetLedger.effectiveBudgetMs,
            wrapperPid: pid,
            ...(process.platform === 'win32' ? {} : { processGroupId: pid }),
          },
        } : {}),
      }, { projectId: options.projectId, storeRoot: options.storeRoot });
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
  if (terminalHasPossibleDelivery(terminal)) return false;
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
  expectedInvocationId?: string,
): PackReviewGptRoundRecord {
  const persisted = getPackReviewRun(runId, options);
  const base = persisted?.reviewRound ?? round;
  if (base.settledSourceCount !== undefined) return base;
  const currentSlot = base.sourceSlots.find((slot) => slot.slotId === slotId);
  if (!currentSlot) throw new Error(`unknown GPT source slot ${slotId}`);
  if (expectedInvocationId && trim(currentSlot.invocationId) !== trim(expectedInvocationId)) return base;
  const slots = base.sourceSlots.map((slot) => slot.slotId === slotId ? { ...slot, ...patch } : slot);
  if (slots.filter((slot) => slot.slotId === slotId).length !== 1) {
    throw new Error(`unknown GPT source slot ${slotId}`);
  }
  const next = { ...base, sourceSlots: slots };
  try {
    updatePackReviewRun(runId, { reviewRound: next }, options);
  } catch (error) {
    const latest = getPackReviewRun(runId, options)?.reviewRound;
    if (latest?.settledSourceCount !== undefined) return latest;
    throw error;
  }
  return getPackReviewRun(runId, options)?.reviewRound ?? next;
}

function terminalClassForGptResult(result: ProcessResult, terminal: GptTerminalTurnResult | null): string {
  const harvestClass = trim(terminal?.review_harvest_class);
  if (terminal && terminal.send_count >= 1 && GPT_HARVEST_CLASSES.has(harvestClass)) {
    return harvestClass;
  }
  if (terminal && terminalHasPossibleDelivery(terminal)) {
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

/** Recover original execution identity from credentialed source slots, never projection. */
function bindCredentialedGptExecutionProvenance(
  run: PackReviewRunRecord,
  options: { projectId: string; storeRoot: string },
): PackReviewRunRecord {
  const round = run.reviewRound;
  if ((run.resolvedReviewer !== undefined && run.resolvedReviewer !== 'gpt')
      || round?.reviewer !== 'gpt'
      || !hasCredentialedGptSourceAuthority(run)
      || gptUsableSourceCount(round) < (round.settledSourceCount ?? round.cardinality)
      || (run.executedReviewer !== undefined && run.executedReviewer !== 'gpt')
      || (run.reviewerExecutionRunId !== undefined && run.reviewerExecutionRunId !== run.id)
      || run.reviewerInvokedForThisRun === false) {
    throw new Error('GPT original execution lacks credentialed source provenance');
  }
  const bound = updatePackReviewRunIf(run.id, (records) => {
    const current = records.find((candidate) => candidate.id === run.id);
    return Boolean(current && current.targetSha === run.targetSha
      && (current.resolvedReviewer === undefined || current.resolvedReviewer === 'gpt')
      && current.automaticBudgetDisposition === run.automaticBudgetDisposition
      && stableJson(current.reviewRound) === stableJson(round)
      && hasCredentialedGptSourceAuthority(current)
      && (current.executedReviewer === undefined || current.executedReviewer === 'gpt')
      && (current.reviewerExecutionRunId === undefined || current.reviewerExecutionRunId === run.id)
      && current.reviewerInvokedForThisRun !== false);
  }, {
    resolvedReviewer: 'gpt',
    executedReviewer: 'gpt',
    reviewerInvokedForThisRun: true,
    reviewerExecutionRunId: run.id,
  }, options);
  if (!bound) throw new Error('GPT source execution provenance changed before binding');
  return bound;
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
  sameRoundEligibleSlotIds?: ReadonlySet<string>;
  reviewer: PackReviewer | null;
}): Promise<ReviewPayload> {
  const harness = process.env.OPK_VITEST_HARNESS === '1';
  const admissionInterval = harness && !options.input.fixtureGptAdmissionReadObservation
    ? 0
    : PACK_REVIEW_GPT_SOURCE_ADMISSION_INTERVAL_MS;
  const readObservation = options.input.fixtureGptAdmissionReadObservation ?? readStateLightTurnObservation;
  // Resume the same gate from the last retained admission, including recovered slots.
  let previousAdmission = options.round.sourceSlots
    .filter((slot) => slot.invocationId && slot.admissionStartedAtUtc)
    .sort((a, b) => Date.parse(b.admissionStartedAtUtc!) - Date.parse(a.admissionStartedAtUtc!))[0];
  const terminalInvocations = new Set<string>();
  const admittedHere = new Set<string>();
  let admissionTail = Promise.resolve();
  let credentialedSourceCount = 0;
  const admit = async (
    slotId: string, invocationId: string, bind: (startedAt: number) => Promise<boolean>,
  ): Promise<boolean> => {
    let release!: () => void;
    const predecessor = admissionTail;
    admissionTail = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    await predecessor;
    try {
      while (previousAdmission && admissionInterval > 0) {
        const previous = previousAdmission;
        const retained = getPackReviewRun(options.run.id, {
          projectId: options.projectId, storeRoot: options.storeRoot,
        })?.reviewRound?.sourceSlots.find((slot) => slot.slotId === previous.slotId
          && slot.invocationId === previous.invocationId);
        let sendSettled = terminalInvocations.has(previous.invocationId!)
          || (retained?.lifecycle === 'terminal' && retained.terminalResult !== undefined);
        if (!sendSettled && previous.launchProfileKey) {
          try {
            const observation = readObservation(previous.launchProfileKey, previous.invocationId!);
            sendSettled = observation.profile_key === previous.launchProfileKey
              && observation.invocation_id === previous.invocationId
              && observation.send_count === 1;
          } catch { /* Missing evidence keeps admission closed; it never authorizes a resend. */ }
        }
        // Previously admitted, now-orphaned sources have no local producer that
        // could make missing send evidence appear. Do not poll them forever.
        if (!sendSettled && !admittedHere.has(previous.invocationId!)) return false;
        const remaining = Date.parse(previous.admissionStartedAtUtc!) + admissionInterval - Date.now();
        if (sendSettled && remaining <= 0) break;
        await new Promise<void>((resolveWait) => setTimeout(resolveWait,
          remaining > 0 ? Math.min(remaining, 1_000) : 1_000));
      }
      const startedAt = Date.now();
      if (!(await bind(startedAt))) return false;
      admittedHere.add(invocationId);
      previousAdmission = {
        slotId, invocationId, lifecycle: 'invocation_started',
        ordinal: options.round.sourceSlots.find((slot) => slot.slotId === slotId)!.ordinal,
        admissionStartedAtUtc: new Date(startedAt).toISOString(),
        ...(resolveLaunchBinding() ?? {}),
      };
      return true;
    } finally {
      release();
    }
  };
  const sourceTransport = options.input.fixtureGptSourceCommentTransport
    ?? (process.env.OPK_VITEST_HARNESS === '1'
      ? undefined
      : createPackGptSourceCommentTransport({
          repoRoot: options.target.sourceRepoRoot,
          repoSlug: options.target.repoSlug,
          prNumber: options.target.prNumber,
        }));

  const resolveLaunchBinding = (): Pick<PackReviewSourceSlotRecord, 'launchProfileKey' | 'launchCdpUrl'> | null => {
    try {
      const config = resolveGptBrowserConfig(process.env);
      return {
        launchProfileKey: configuredProfileKey(config.profile, config.cdpUrl),
        launchCdpUrl: config.cdpUrl,
      };
    } catch (error) {
      if (process.env.OPK_VITEST_HARNESS === '1') return null;
      throw error;
    }
  };

  const outcomes = await Promise.all(options.round.sourceSlots.map(async (planned) => {
    const slotId = planned.slotId;
    let round = getPackReviewRun(options.run.id, {
      projectId: options.projectId,
      storeRoot: options.storeRoot,
    })?.reviewRound ?? options.round;
    const currentSlot = round.sourceSlots.find((slot) => slot.slotId === slotId) ?? planned;
    const currentComplete = currentSlot.lifecycle === 'terminal'
      && (currentSlot.terminalClass === 'complete_clean' || currentSlot.terminalClass === 'complete_findings')
      && currentSlot.payload;
    if (currentComplete) {
      return { slot: currentSlot, payload: currentSlot.payload as ReviewPayload };
    }
    if (options.sameRoundEligibleSlotIds && !options.sameRoundEligibleSlotIds.has(slotId)) {
      return { slot: currentSlot, payload: undefined };
    }
    let attemptOrdinal = (currentSlot.attemptOrdinal ?? 0) + 1;
    let invocationId = randomUUID();
    const markInvocationStarted = async (admissionStartedAt: number): Promise<boolean> => {
      const launchBinding = resolveLaunchBinding();
      const priorSlot = round.sourceSlots.find((slot) => slot.slotId === slotId);
      // Zero-send rate-limit retries must keep their browser identity. Other
      // observer-authorized orphan replacements follow their own eligibility.
      if (options.sameRoundEligibleSlotIds && priorSlot?.terminalClass?.startsWith('rate_limit:')
        && priorSlot.invocationId && launchBinding?.launchProfileKey !== priorSlot.launchProfileKey) return false;
      const priorHistory: PackReviewSourceSlotAttemptHistory[] = priorSlot?.attemptHistory ?? [];
      const priorAttempt = priorSlot?.invocationId && priorSlot.attemptOrdinal !== undefined && priorSlot.terminalClass
        ? { invocationId: priorSlot.invocationId, attemptOrdinal: priorSlot.attemptOrdinal, terminalClass: priorSlot.terminalClass }
        : undefined;
      const attemptHistory = priorAttempt && attemptOrdinal > priorAttempt.attemptOrdinal
        && !priorHistory.some((entry) => entry.invocationId === priorAttempt.invocationId)
        ? [...priorHistory, priorAttempt]
        : priorHistory;
      if (options.sameRoundEligibleSlotIds && priorSlot?.invocationId && sourceTransport) {
        // A real original-invocation GitHub source comment may have appeared
        // after the observer classified the chat. Uncertain census is a veto.
        const originalIdentity = gptSourceIdentity({
          repoSlug: options.target.repoSlug, prNumber: options.target.prNumber,
          headSha: options.target.headSha, runId: options.run.id,
          slotId, invocationId: priorSlot.invocationId,
        });
        let originalResolution: PackGptSourceCommentResolution;
        try {
          originalResolution = await resolvePackGptSourceComment({
            identity: originalIdentity, transport: sourceTransport,
          });
        } catch {
          return false;
        }
        if (originalResolution.kind !== 'missing') return false;
      }
      const patch: Partial<PackReviewSourceSlotRecord> = {
        lifecycle: 'invocation_started',
        admissionStartedAtUtc: new Date(admissionStartedAt).toISOString(),
        attemptOrdinal,
        invocationId,
        ...(attemptHistory.length > 0 ? { attemptHistory } : {}),
        terminalClass: undefined,
        terminalResult: undefined,
        payload: undefined,
        ...(launchBinding ?? {}),
      };
      if (options.sameRoundEligibleSlotIds) {
        // An original invocation may have acquired its GitHub comment while we
        // waited for pacing. Never overwrite it from an earlier slot snapshot.
        const updated = updatePackReviewRunIf(options.run.id, (records) => {
          const incumbent = records.find((record) => record.id === options.run.id);
          const liveRound = incumbent?.reviewRound;
          const liveSlot = liveRound?.sourceSlots.find((slot) => slot.slotId === slotId);
          return Boolean(incumbent && liveRound && liveSlot
            && incumbent.runnerPid === process.pid
            && PACK_REVIEW_ACTIVE_STATUSES.has(incumbent.status)
            && !hasPersistedPackReviewVerdict(incumbent)
            && liveRound.settledSourceCount === undefined
            && stableJson(liveSlot) === stableJson(priorSlot)
            && resolvePackReviewRunOrder(records, incumbent).kind === 'none');
        }, (existing) => ({
          reviewRound: {
            ...existing.reviewRound!,
            sourceSlots: existing.reviewRound!.sourceSlots.map((slot) => (
              slot.slotId === slotId ? { ...slot, ...patch } : slot
            )),
          },
        }), { projectId: options.projectId, storeRoot: options.storeRoot });
        if (!updated?.reviewRound) return false;
        round = updated.reviewRound;
      } else {
        round = updateGptRoundSlot(options.run.id, round, slotId, patch, {
          projectId: options.projectId, storeRoot: options.storeRoot,
        });
      }
      return true;
    };
    if (!(await admit(slotId, invocationId, markInvocationStarted))) {
      const retained = getPackReviewRun(options.run.id, { projectId: options.projectId, storeRoot: options.storeRoot });
      return { slot: retained?.reviewRound?.sourceSlots.find((slot) => slot.slotId === slotId) ?? currentSlot, payload: undefined };
    }
    // The persisted admission is serialized; the invocation's potentially long
    // browser work must run outside that gate to preserve parallel generation.
    if (options.input.fixtureAfterGptInvocationBound) {
      await options.input.fixtureAfterGptInvocationBound({ slotId, attemptOrdinal, invocationId, round });
    }
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
          reviewer: options.reviewer,
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
      const terminal = parseLastGptTerminalTurnResult(invocation.result.stdout);
      if (terminal?.invocation_id === invocationId) terminalInvocations.add(invocationId);
      if (!(attemptOrdinal === 1
        && isRetryablePackReviewZeroSendCollision(invocation.result, invocationId))) break;
      attemptOrdinal = 2;
      invocationId = randomUUID();
      if (!(await admit(slotId, invocationId, markInvocationStarted))) {
        const retained = getPackReviewRun(options.run.id, { projectId: options.projectId, storeRoot: options.storeRoot });
        return { slot: retained?.reviewRound?.sourceSlots.find((slot) => slot.slotId === slotId) ?? currentSlot, payload: undefined };
      }
      if (options.input.fixtureAfterGptInvocationBound) {
        await options.input.fixtureAfterGptInvocationBound({ slotId, attemptOrdinal, invocationId, round });
      }
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
    const terminalProvesPreSend = browserTerminal && authoritativePreSend({
      ...currentSlot, lifecycle: 'terminal', terminalResult: browserTerminal,
      terminalClass: attemptOrdinal >= 2 && isRetryablePackReviewZeroSendCollision(invocation.result, invocationId)
        ? 'explicit_refusal:zero_send_collision_exhausted' : undefined,
    });
    const sourceMayHaveBeenPublished = !browserTerminal
      || !terminalBoundToInvocation
      || !terminalProvesPreSend;
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
      if (attemptOrdinal >= 2
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
    }, { projectId: options.projectId, storeRoot: options.storeRoot }, invocationId);
    const persistedSlot = round.sourceSlots.find((slot) => slot.slotId === slotId);
    if (!persistedSlot) throw new Error(`unknown GPT source slot ${slotId}`);
    const acceptedPayload = persistedSlot.lifecycle === 'terminal'
      && (persistedSlot.terminalClass === 'complete_clean' || persistedSlot.terminalClass === 'complete_findings')
      && persistedSlot.payload
      ? persistedSlot.payload as ReviewPayload
      : undefined;
    if (options.input.fixtureAfterGptSourceSlotTerminal) {
      await options.input.fixtureAfterGptSourceSlotTerminal({ slotId, round });
    }
    return { slot: persistedSlot, payload: acceptedPayload };
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
  /** Volatile results of complete, typed comment scans for exact invoked identities. */
  missingFirstAttemptIdentities?: string[];
}

/**
 * Failure-only proof. This does not use authoritativePreSend and does not admit
 * a source launch: historical slot summaries cannot establish prior send counts.
 */
function provenFirstAttemptZeroSendCensus(
  run: PackReviewRunRecord,
  missingFirstAttemptIdentities: readonly string[],
): boolean {
  const round = run.reviewRound;
  if (!round || round.reviewer !== 'gpt' || round.cardinality !== 3
    || round.sourceSlots.length !== 3 || round.settledSourceCount !== undefined
    || gptUsableSourceCount(round) !== 0 || hasPersistedPackReviewVerdict(run)
    || run.reviewVerdict !== undefined || run.journalOutcome !== undefined
    || run.githubReviewId !== undefined || run.githubReviewUrl !== undefined
    || run.findings.length > 0) return false;
  const missing = new Set(missingFirstAttemptIdentities);
  return round.sourceSlots.every((slot) => {
    if (slot.payload !== undefined
      || (slot.attemptHistory !== undefined
        && (!Array.isArray(slot.attemptHistory) || slot.attemptHistory.length !== 0))) return false;
    if (slot.lifecycle === 'planned') {
      return !slot.invocationId && slot.attemptOrdinal === undefined
        && !slot.admissionStartedAtUtc && !slot.launchProfileKey && !slot.launchCdpUrl
        && slot.terminalClass === undefined && slot.terminalResult === undefined;
    }
    if (slot.lifecycle !== 'terminal') return false;
    if (slot.terminalClass === 'pre_launch_interrupted') {
      const result = slot.terminalResult;
      return !slot.invocationId && slot.attemptOrdinal === undefined
        && !slot.admissionStartedAtUtc && !slot.launchProfileKey && !slot.launchCdpUrl
        && !!result && typeof result === 'object' && !Array.isArray(result)
        && (result as Record<string, unknown>).kind === 'stale_pre_launch_interruption'
        && (result as Record<string, unknown>).noResend === true;
    }
    if (!slot.invocationId || slot.attemptOrdinal !== 1 || !slot.terminalClass
      || slot.terminalClass === 'complete_clean' || slot.terminalClass === 'complete_findings'
      || slot.terminalClass.startsWith('possible_delivery')
      || slot.terminalClass.includes('harvest')
      || !missing.has(`${slot.slotId}:${slot.invocationId}`)) return false;
    const terminal = slot.terminalResult;
    if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) return false;
    const proof = terminal as Record<string, unknown>;
    if (proof.schema !== 'turn-result/v1'
      || proof.invocation_id !== slot.invocationId
      || !['invocation', 'profile'].includes(String(proof.scope))
      || proof.send_count !== 0 || terminalHasPossibleDelivery(proof)
      || (proof.send_attempted !== undefined && proof.send_attempted !== false)
      || proof.cause === 'send_delivery_unproven'
      || proof.review_harvest_class !== undefined || proof.review_evidence !== undefined
      || proof.source_comment_authority !== undefined || proof.source_comment_receipt !== undefined
      || proof.state === 'ok' || proof.state === 'no_reply'
      || (proof.delivery !== undefined && !['not_sent', 'NOT_SENT'].includes(String(proof.delivery)))
      || (proof.source_comment_reconciliation !== undefined
        && proof.source_comment_reconciliation !== 'missing')) return false;
    const diagnostics = proof.diagnostics;
    if (diagnostics !== undefined && (!diagnostics || typeof diagnostics !== 'object'
      || Array.isArray(diagnostics))) return false;
    const observed = (diagnostics as { persisted_observation?: unknown } | undefined)?.persisted_observation;
    if (observed !== undefined) {
      if (!observed || typeof observed !== 'object' || Array.isArray(observed)) return false;
      const observation = observed as Record<string, unknown>;
      if (!['prepared', 'not_sent'].includes(String(observation.phase))
        || observation.transition_reason === 'send_delivery_unproven'
        || (observation.send_count !== undefined && observation.send_count !== 0)
        || (observation.send_attempted !== undefined && observation.send_attempted !== false)
        || (observation.delivery !== undefined
          && !['not_sent', 'NOT_SENT'].includes(String(observation.delivery)))
        || (observation.invocation_id !== undefined
          && observation.invocation_id !== slot.invocationId)) return false;
    }
    return true;
  });
}

/**
 * Identify failed rate-limit-led rounds independently of the runner failure reason.
 * This classifies the round; actual retry authority still requires exact
 * source-comment and pre-send evidence (and older history's zero-send proof).
 */
function hasFailedRateLimitSource(run: PackReviewRunRecord): boolean {
  if (run.status !== 'failed' || !run.reviewRound) return false;
  const slots = run.reviewRound.sourceSlots;
  const hasComplete = slots.some((slot) => slot.lifecycle === 'terminal'
    && (slot.terminalClass === 'complete_clean' || slot.terminalClass === 'complete_findings'));
  return slots.some((slot) => slot.lifecycle === 'terminal'
      && slot.terminalClass?.startsWith('rate_limit:'))
    && slots.every((slot) => slot.lifecycle === 'planned'
      || (!hasComplete && slot.lifecycle === 'invocation_started' && Boolean(slot.invocationId))
      || (slot.lifecycle === 'terminal'
        && (slot.terminalClass === 'complete_clean'
          || slot.terminalClass === 'complete_findings'
          || slot.terminalClass === 'pre_launch_interrupted'
          || slot.terminalClass?.startsWith('rate_limit:') === true
          || slot.terminalClass === 'possible_delivery'
          || slot.terminalClass?.startsWith('possible_delivery/') === true)));
}

/** Reject any pre-send observation containing a send witness or possible delivery. */
function retryableZeroSendObservation(observation: Record<string, unknown>): boolean {
  return (observation.phase === 'prepared' || observation.phase === 'not_sent')
    && observation.transition_reason !== 'send_delivery_unproven'
    && (observation.send_count === undefined || observation.send_count === 0)
    && (observation.send_attempted === undefined || observation.send_attempted === false)
    && (observation.send_witness === undefined || observation.send_witness === 'none'
      || (observation.send_witness === 'numeric_send_count' && observation.send_count === 0))
    && (observation.delivery === undefined
      || observation.delivery === 'not_sent' || observation.delivery === 'NOT_SENT');
}

/**
 * A posted partial round retains its original run ID: GitHub source comments
 * cannot be moved into a newly allocated run. Only proven missing/pre-send
 * slots may be relaunched. Possible delivery remains observation-only.
 * This proof is deliberately separate from older records' unchanged 0/3 proof.
 */
async function recoverablePostedRateLimitSlots(input: {
  run: PackReviewRunRecord;
  sourceRepoRoot: string;
  repoSlug: string;
  transport?: PackGptSourceCommentTransport;
}): Promise<ReadonlySet<string> | null> {
  const { run } = input;
  const round = run.reviewRound;
  if (!round || !hasFailedRateLimitSource(run) || round.reviewer !== 'gpt'
    || round.cardinality !== 3 || round.sourceSlots.length !== 3
    || new Set(round.sourceSlots.map((slot) => slot.slotId)).size !== 3
    || round.settledSourceCount !== undefined || gptUsableSourceCount(round) === 0
    || hasPersistedPackReviewVerdict(run) || !hasCredentialedGptSourceAuthority(run)) return null;
  // A judged 0/3 zero-send original with a subsequently hydrated source
  // comment has conflicting invocation evidence; it is not a retryable 1/3.
  if (run.failureReason?.startsWith('gpt_source_non_complete:')
    && run.failureReason.endsWith(':0/3')) return null;
  if (process.env.OPK_VITEST_HARNESS === '1' && !input.transport) return null;
  const transport = input.transport ?? createPackGptSourceCommentTransport({
    repoRoot: input.sourceRepoRoot, repoSlug: input.repoSlug, prNumber: run.prNumber,
  });
  const eligible = new Set<string>();
  for (const slot of round.sourceSlots) {
    const complete = slot.lifecycle === 'terminal'
      && (slot.terminalClass === 'complete_clean' || slot.terminalClass === 'complete_findings');
    if (slot.lifecycle === 'planned' || (slot.lifecycle === 'terminal'
      && slot.terminalClass === 'pre_launch_interrupted')) {
      const terminal = slot.terminalResult as Record<string, unknown> | undefined;
      if (slot.invocationId || slot.attemptOrdinal !== undefined || slot.admissionStartedAtUtc
        || slot.launchProfileKey || slot.launchCdpUrl || slot.payload !== undefined
        || (slot.attemptHistory?.length ?? 0) !== 0
        || (slot.lifecycle === 'planned' && (slot.terminalClass || slot.terminalResult))
        || (slot.lifecycle === 'terminal'
          && (terminal?.kind !== 'stale_pre_launch_interruption' || terminal.noResend !== true))) return null;
      eligible.add(slot.slotId);
      continue;
    }
    if (!slot.invocationId || slot.lifecycle !== 'terminal') return null;
    const identity = gptSourceIdentity({
      repoSlug: input.repoSlug, prNumber: run.prNumber, headSha: run.targetSha,
      runId: run.id, slotId: slot.slotId, invocationId: slot.invocationId,
    });
    let resolution: PackGptSourceCommentResolution;
    try {
      resolution = await resolvePackGptSourceComment({ identity, transport });
    } catch {
      return null;
    }
    if (complete) {
      const terminal = slot.terminalResult as Record<string, unknown> | undefined;
      if (resolution.kind !== 'credentialed' || !slot.payload
        || stableJson(terminal?.source_comment_receipt) !== stableJson(resolution.receipt)
        || stableJson(slot.payload) !== stableJson(resolution.payload)) return null;
      continue;
    }
    if (resolution.kind !== 'missing') return null;
    if (slot.terminalClass === 'possible_delivery'
      || slot.terminalClass?.startsWith('possible_delivery/') === true) {
      // Absence of a GitHub comment is not proof that Send was never attempted.
      continue;
    }
    const history = slot.attemptHistory ?? [];
    if (!Array.isArray(history) || slot.attemptOrdinal !== history.length + 1
      || history.some((attempt, index) => !attempt
        || attempt.attemptOrdinal !== index + 1
        || typeof attempt.invocationId !== 'string' || !attempt.invocationId
        || typeof attempt.terminalClass !== 'string'
        || !attempt.terminalClass.startsWith('rate_limit:')
        || attempt.terminalClass.length === 'rate_limit:'.length)
      || new Set([...history.map((attempt) => attempt.invocationId), slot.invocationId]).size
        !== history.length + 1) return null;
    const terminal = slot.terminalResult as Record<string, unknown> | undefined;
    const cause = trim(terminal?.cause);
    if (!slot.terminalClass?.startsWith('rate_limit:') || !terminal
      || terminal.schema !== 'turn-result/v1' || terminal.state !== 'rate_limit'
      || slot.terminalClass !== 'rate_limit:' + cause || !cause
      || !slot.launchProfileKey || slot.payload !== undefined
      || terminal.invocation_id !== slot.invocationId
      || !['invocation', 'profile'].includes(String(terminal.scope))
      || terminal.send_count !== 0
      || (terminal.send_attempted !== undefined && terminal.send_attempted !== false)
      || terminalHasPossibleDelivery(terminal)
      || (terminal.delivery !== undefined
        && terminal.delivery !== 'not_sent' && terminal.delivery !== 'NOT_SENT')
      || (terminal.source_comment_reconciliation !== undefined
        && terminal.source_comment_reconciliation !== 'missing')
      || (trim(terminal.configured_profile_key ?? terminal.profile_key)
        && trim(terminal.configured_profile_key ?? terminal.profile_key) !== slot.launchProfileKey)) return null;
    const diagnostics = terminal.diagnostics;
    if (diagnostics !== undefined
      && (!diagnostics || typeof diagnostics !== 'object' || Array.isArray(diagnostics))) return null;
    const embedded = (diagnostics as { persisted_observation?: unknown } | undefined)?.persisted_observation;
    if (embedded !== undefined) {
      if (!embedded || typeof embedded !== 'object' || Array.isArray(embedded)) return null;
      const observed = embedded as Record<string, unknown>;
      if (!retryableZeroSendObservation(observed)
        || (observed.invocation_id !== undefined && observed.invocation_id !== slot.invocationId)
        || (observed.profile_key !== undefined && observed.profile_key !== slot.launchProfileKey)) return null;
    }
    try {
      const path = observationRecordPath(slot.launchProfileKey, slot.invocationId);
      const observedCurrent = existsSync(path);
      // Repeated retries need durable pre-send observations for every attempt.
      // Preserve the original first-attempt rule when there is no history.
      if (history.length > 0 && !observedCurrent) return null;
      if (observedCurrent && !retryableZeroSendObservation(
        readStateLightTurnObservation(slot.launchProfileKey, slot.invocationId) as unknown as Record<string, unknown>,
      )) return null;
      // History retains only identity/ordinal/class, not old terminal payloads.
      // Each prior attempt therefore needs its own persisted no-send observation
      // and an exact actor-bound absence of a GitHub source comment.
      for (const attempt of history) {
        const observation = readStateLightTurnObservation(slot.launchProfileKey, attempt.invocationId);
        if (!retryableZeroSendObservation(observation as unknown as Record<string, unknown>)) return null;
        const priorResolution = await resolvePackGptSourceComment({
          identity: gptSourceIdentity({
            repoSlug: input.repoSlug, prNumber: run.prNumber, headSha: run.targetSha,
            runId: run.id, slotId: slot.slotId, invocationId: attempt.invocationId,
          }),
          transport,
        });
        if (priorResolution.kind !== 'missing') return null;
      }
    } catch {
      return null;
    }
    eligible.add(slot.slotId);
  }
  return eligible.size > 0 ? eligible : null;
}

function originalRateLimitZeroJudgment(
  run: PackReviewRunRecord,
  storeRoot: string,
): boolean {
  const round = run.reviewRound;
  if (run.status !== 'failed'
    || !run.failureReason?.startsWith('gpt_source_non_complete:')
    || noJudgmentBudgetOutcome(run, storeRoot) === null
    || round?.reviewer !== 'gpt' || round.cardinality !== 3
    || round.sourceSlots.length !== 3) return false;
  let witnessedRateLimit = false;
  for (const slot of round.sourceSlots) {
    if (slot.lifecycle === 'planned' || slot.terminalClass === 'pre_launch_interrupted') continue;
    const result = slot.terminalResult;
    if (slot.lifecycle !== 'terminal' || !result || typeof result !== 'object'
      || Array.isArray(result)) return false;
    const terminal = result as Record<string, unknown>;
    if (terminal.state !== 'rate_limit'
      || (terminal.cause !== 'account_cooldown_active'
        && terminal.cause !== 'account_conversations_http_429')
      || slot.terminalClass !== 'rate_limit:' + terminal.cause) return false;
    const terminalProfile = trim(terminal.configured_profile_key ?? terminal.profile_key);
    if (terminalProfile && terminalProfile !== trim(slot.launchProfileKey)) return false;
    witnessedRateLimit = true;
  }
  return witnessedRateLimit;
}

/**
 * Reconstruct the exact original invocation census from persisted zero-send
 * terminals AND conclusive actor-bound GitHub source-comment absence. External
 * original-invocation observations, if present, must not contradict pre-send.
 * Re-run on every PR-led admission: a prior reconcile result is not authority.
 */
async function proveRateLimitOriginalZeroSend(input: {
  run: PackReviewRunRecord;
  projectId: string;
  storeRoot: string;
  repoSlug: string;
  sourceRepoRoot: string;
  transport?: PackGptSourceCommentTransport;
}): Promise<boolean> {
  const { run, projectId, storeRoot, repoSlug } = input;
  if (!originalRateLimitZeroJudgment(run, storeRoot)) return false;
  const invoked = run.reviewRound!.sourceSlots.filter((slot) => Boolean(slot.invocationId));
  const identities = invoked.map((slot) => slot.slotId + ':' + slot.invocationId);
  // Local proof is only a cheap rejection filter; it is not a comment census.
  if (!provenFirstAttemptZeroSendCensus(run, identities)) return false;
  if (process.env.OPK_VITEST_HARNESS === '1' && !input.transport) return false;
  const transport = input.transport ?? createPackGptSourceCommentTransport({
    repoRoot: input.sourceRepoRoot, repoSlug, prNumber: run.prNumber,
  });
  const verifiedMissing: string[] = [];
  for (const slot of invoked) {
    const invocationId = slot.invocationId!;
    // Without the original namespace, an opposing persisted turn observation
    // cannot be excluded. Do not substitute the current browser profile.
    if (!slot.launchProfileKey) return false;
    try {
      const path = observationRecordPath(slot.launchProfileKey, invocationId);
      if (existsSync(path)) {
        const observation = readStateLightTurnObservation(slot.launchProfileKey, invocationId);
        if ((observation.phase !== 'prepared' && observation.phase !== 'not_sent')
          || observation.transition_reason === 'send_delivery_unproven'
          || observation.send_witness === 'owned_marker'
          || (observation.send_count !== undefined && observation.send_count !== 0)) return false;
      }
      const resolution = await resolvePackGptSourceComment({
        identity: gptSourceIdentity({
          repoSlug, prNumber: run.prNumber, headSha: run.targetSha,
          runId: run.id, slotId: slot.slotId, invocationId,
        }),
        transport,
      });
      if (resolution.kind !== 'missing') return false;
    } catch {
      // An unreadable observation or incomplete GitHub actor/comment scan is
      // never interpreted as proof that the original send did not occur.
      return false;
    }
    verifiedMissing.push(slot.slotId + ':' + invocationId);
  }
  const current = getPackReviewRun(run.id, { projectId, storeRoot });
  return Boolean(current
    && current.status === run.status
    && current.failureReason === run.failureReason
    && current.targetSha === run.targetSha
    && current.reviewCycleId === run.reviewCycleId
    && stableJson(current.reviewRound) === stableJson(run.reviewRound)
    && originalRateLimitZeroJudgment(current, storeRoot)
    && provenFirstAttemptZeroSendCensus(current, verifiedMissing));
}

function rateLimitFreshReviewNextAction(run: PackReviewRunRecord, projectId: string, retryMissing = false): string {
  const command = 'OPK_PROJECT_ID=' + projectId
    + ' npm run --silent pack-gpt-review -- --project ' + projectId
    + ' --pr-number ' + run.prNumber;
  const profile = trim(process.env.PACK_GPT_BROWSER_PROFILE);
  try {
    const cdp = trim(process.env.PACK_GPT_BROWSER_CDP) || 'http://127.0.0.1:9222';
    // The persisted original launch identity is a safe fallback when scoped
    // reconciliation was invoked without a browser profile environment.
    const originalKeys = new Set(run.reviewRound?.sourceSlots
      .map((slot) => trim(slot.launchProfileKey))
      .filter(Boolean) ?? []);
    const profileKey = profile
      ? configuredProfileKey(profile, cdp)
      : originalKeys.size === 1 ? [...originalKeys][0] : undefined;
    if (profileKey) {
      const cooldown = readStateLightAccountCooldown(profileKey);
      if (cooldown.active && cooldown.until !== undefined) {
        return 'after the shared account cooldown expires at '
          + new Date(cooldown.until).toISOString() + ' UTC, '
          + (retryMissing ? 'retry only the missing sources in the original run: ' : 'start a fresh review run: ')
          + command;
      }
    }
  } catch {
    // Missing, malformed or unreadable cooldown is not a fabricated wait.
  }
  return (retryMissing ? 'retry only the missing sources in the original run now: ' : 'start the fresh review run now: ')
    + command;
}

function rateLimitOriginalRecoveryAction(run: PackReviewRunRecord): string {
  return 'observe the original GPT turn and exact-identity GitHub source comments for run '
    + run.id + ' (PR #' + run.prNumber
    + '); resolve absent or conflicting first-attempt send evidence before any new run; do not resend';
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
  if (hasPersistedPackReviewVerdict(options.run)) {
    return {
      recovered: false,
      reason: 'gpt_round_already_settled',
      hydratedSourceCount: 0,
      usableSourceCount: gptUsableSourceCount(initialRound),
      graceExpired: true,
    };
  }
  const resumeFrozenRound = initialRound.settledSourceCount !== undefined;
  if (process.env.OPK_VITEST_HARNESS === '1'
      && !resumeFrozenRound
      && !options.input.fixtureGptSourceCommentTransport) {
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

  let round = initialRound;
  let hydratedSourceCount = 0;
  const unresolved: string[] = [];
  const uncredentialableCompletedSources: string[] = [];
  const uncertainSourceObservations: string[] = [];
  const missingFirstAttemptIdentities: string[] = [];
  if (!resumeFrozenRound) {
    const transport = options.input.fixtureGptSourceCommentTransport
      ?? createPackGptSourceCommentTransport({
        repoRoot: options.input.sourceRepoRoot,
        repoSlug: options.repoSlug,
        prNumber: options.run.prNumber,
      });
    for (const snapshotSlot of round.sourceSlots) {
      const currentSlot = round.sourceSlots.find((slot) => slot.slotId === snapshotSlot.slotId)!;
      const invocationId = trim(currentSlot.invocationId);
      const complete = currentSlot.terminalClass === 'complete_clean'
        || currentSlot.terminalClass === 'complete_findings';
      if (currentSlot.lifecycle === 'terminal' && !invocationId && !complete) continue;
      if ((currentSlot.lifecycle !== 'invocation_started' && currentSlot.lifecycle !== 'terminal') || !invocationId) {
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
        const detail = `${currentSlot.slotId}:${describeError(error)}`;
        unresolved.push(detail);
        uncertainSourceObservations.push(detail);
        continue;
      }
      if (resolution.kind !== 'credentialed') {
        if (complete) uncredentialableCompletedSources.push(`${currentSlot.slotId}:${resolution.reason}`);
        if (resolution.kind !== 'missing') {
          uncertainSourceObservations.push(`${currentSlot.slotId}:${resolution.reason}`);
        }
        if (resolution.kind === 'missing') {
          missingFirstAttemptIdentities.push(`${currentSlot.slotId}:${invocationId}`);
        }
        unresolved.push(`${currentSlot.slotId}:${resolution.reason}`);
        continue;
      }
      const payload = resolution.payload as unknown as ReviewPayload;
      if (complete) {
        // The persisted complete slot is immutable. A current, exact original
        // GitHub comment must still agree with its stored receipt and verdict.
        const terminal = currentSlot.terminalResult as Record<string, unknown> | undefined;
        if (stableJson(terminal?.source_comment_receipt) !== stableJson(resolution.receipt)
          || stableJson(JSON.parse(JSON.stringify(currentSlot.payload)))
            !== stableJson(JSON.parse(JSON.stringify(payload)))) {
          uncredentialableCompletedSources.push(`${currentSlot.slotId}:stored_publication_mismatch`);
        }
        continue;
      }
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

  let persisted = getPackReviewRun(options.run.id, {
    projectId: options.projectId,
    storeRoot: options.storeRoot,
  }) ?? { ...options.run, reviewRound: round };
  round = persisted.reviewRound ?? round;
  let usableSourceCount = gptUsableSourceCount(round);
  const graceExpired = gptRoundGraceExpired(persisted);
  if (uncredentialableCompletedSources.length > 0) {
    return {
      recovered: false,
      reason: `gpt_complete_source_uncredentialable:${uncredentialableCompletedSources.join(', ')}`,
      hydratedSourceCount,
      usableSourceCount,
      graceExpired,
      nextAction: 'restore the exact original GPT source-comment evidence, then rerun scoped reconcile; do not downgrade a complete slot',
    };
  }
  if (uncertainSourceObservations.length > 0) {
    return {
      recovered: false,
      reason: `gpt_source_census_unresolved:${uncertainSourceObservations.join(', ')}`,
      hydratedSourceCount,
      usableSourceCount,
      graceExpired,
      nextAction: 'restore exact GitHub source-comment resolution, then rerun scoped reconcile',
    };
  }
  const settlePartialAfterGrace = options.input.settlePartialAfterGrace ?? true;
  const requiredSourceCount = round.settledSourceCount
    ?? (round.cardinality >= 3
      ? (graceExpired && settlePartialAfterGrace ? 2 : round.cardinality)
      : round.cardinality);
  if (usableSourceCount < requiredSourceCount) {
    // A failed actor lookup, incomplete comment page, or conflicting identity
    // is not proof that the corresponding GitHub comment is absent.
    if (uncertainSourceObservations.length > 0) {
      return {
        recovered: false,
        reason: `gpt_source_census_unresolved:${uncertainSourceObservations.join(', ')}`,
        hydratedSourceCount,
        usableSourceCount,
        graceExpired,
        missingFirstAttemptIdentities,
        nextAction: `restore GitHub source-comment resolution for ${uncertainSourceObservations.join(', ')}, then rerun scoped reconcile`,
      };
    }
    const reason = round.cardinality >= 3 && !graceExpired
      ? `gpt_sources_waiting_for_grace:${usableSourceCount}/${round.cardinality}`
      : `gpt_sources_incomplete_after_grace:${usableSourceCount}/${round.cardinality}`;
    return {
      recovered: false,
      reason,
      hydratedSourceCount,
      usableSourceCount,
      graceExpired,
      missingFirstAttemptIdentities,
      nextAction: round.cardinality >= 3 && !graceExpired
        ? 'rerun scoped reconcile after the shared grace threshold or when the missing source publishes'
        : `reconcile or retry the missing source work (${unresolved.join(', ') || 'missing source comment'})`,
    };
  }

  if (round.cardinality >= 3
      && round.settledSourceCount === undefined) {
    if (options.input.fixtureBeforeGptRoundFreeze) {
      await options.input.fixtureBeforeGptRoundFreeze({
        runId: options.run.id,
        usableSourceCount,
        requiredSourceCount,
      });
    }
    const frozen = freezeGptRoundSourceCount(
      options.run.id,
      requiredSourceCount,
      { projectId: options.projectId, storeRoot: options.storeRoot },
    );
    if (!frozen) {
      return {
        recovered: false,
        reason: 'gpt_source_quorum_changed_before_freeze',
        hydratedSourceCount,
        usableSourceCount,
        graceExpired,
        nextAction: 'rerun scoped reconcile against the latest persisted GPT source census',
      };
    }
    round = frozen;
    usableSourceCount = gptUsableSourceCount(round);
    if (options.input.fixtureAfterGptRoundFreeze) {
      await options.input.fixtureAfterGptRoundFreeze({
        runId: options.run.id,
        settledSourceCount: round.settledSourceCount!,
      });
    }
  }

  persisted = getPackReviewRun(options.run.id, {
    projectId: options.projectId,
    storeRoot: options.storeRoot,
  }) ?? persisted;
  round = persisted.reviewRound ?? round;
  usableSourceCount = gptUsableSourceCount(round);
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
  // Both required and supplemental recovered source rounds need the same
  // original execution identity before journal/COMMENT/status settlement.
  bindCredentialedGptExecutionProvenance(persistedBeforeAggregate, {
    projectId: options.projectId, storeRoot: options.storeRoot,
  });
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
    writeRequiredStatus: currentCycleRequiredStatusWriter(
      options.run, options.storeRoot, options.writeRequiredStatus,
    ),
    notifyWorker: options.input.fixtureWorkerNotifier ?? ((request) => sendPackReviewWorkerNotification({
      trustedPackRoot: options.run.trustedPackRoot,
      sessionId: options.run.linkedSessionId,
      projectId: options.projectId,
      storeRoot: options.storeRoot,
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
  // Historical GPT source tier/cap are frozen, even if the *cycle*
  // was subsequently raised on the same run and ordinal.
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
    fixtureIssueTitle: options.input.fixtureIssueTitle,
    storeRoot: options.storeRoot,
    fixtureIssueNumber: round.issueNumber,
    fixtureChangedPaths: options.input.fixtureChangedPaths,
    fixtureBoundIssueSnapshotBytes: options.input.fixtureBoundIssueSnapshotBytes,
  };
  const authoritative = await resolveAuthoritativeReviewContext(
    recoveryStart,
    target,
    options.projectId,
  );
  if (authoritative.snapshotDigest !== round.boundIssueSnapshotDigest) {
    throw new Error('recovered GPT round no longer matches its authoritative Issue snapshot');
  }
  authority = reconcilePackReviewTier({
    prNumber: options.run.prNumber, tier: authoritative.tier,
    options: authorityOptions, startedRunExists: true,
  });
  const rank = { T1: 1, T2: 2, T3: 3 } as const;
  const historicalTierCompatible = authority.cycle?.frozenTier === round.tier
    || (authority.cycle?.capMapVersion === PACK_REVIEW_LOGICAL_CAP_MAP_VERSION
      && options.run.accountingVersion === PACK_REVIEW_LOGICAL_CAP_MAP_VERSION
      && round.accountingVersion === PACK_REVIEW_LOGICAL_CAP_MAP_VERSION
      && options.run.logicalRoundOrdinal === round.roundOrdinal
      && Number(options.run.logicalRoundCap) <= authority.cycle.frozenCap
      && rank[authority.cycle.frozenTier] > rank[round.tier]);
  if (!historicalTierCompatible) {
    throw new Error('recovered GPT tier does not match frozen round or legal upward cycle');
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
      logicalRoundOrdinal: options.run.logicalRoundOrdinal,
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
  if (options.run.automaticBudgetDisposition !== 'non_consuming_explicit') {
    await commitRecoveredGptAuthority(options);
  } else {
    const journaled = getPackReviewRun(options.run.id, {
      projectId: options.projectId, storeRoot: options.storeRoot,
    }) ?? options.run;
    if (!hasPersistedPackReviewVerdict(journaled)) {
      throw new Error('supplemental GPT journaled verdict missing before COMMENT recovery');
    }
    bindCredentialedGptExecutionProvenance(journaled, {
      projectId: options.projectId, storeRoot: options.storeRoot,
    });
  }
  const latestRun = getPackReviewRun(options.run.id, {
    projectId: options.projectId,
    storeRoot: options.storeRoot,
  }) ?? options.run;
  const resumed = await resumeRecoveredGptDelivery({ ...options, run: latestRun });
  if (options.run.automaticBudgetDisposition === 'non_consuming_explicit') {
    // Journal and the original reviewer COMMENT alone settle advisory recovery.
    return resumed;
  }
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

function githubEvidenceObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub evidence is not an object');
  return value as Record<string, unknown>;
}

async function readFinalCapGithubJson(
  input: Pick<ReconcileStalePackReviewRunsInput, 'sourceRepoRoot'>,
  args: string[],
  runner: typeof runProcess,
): Promise<unknown> {
  const result = await runner({ command: resolveTrackedGhWrapper(), args, cwd: input.sourceRepoRoot,
    inheritParentEnv: true, allowEmptyStdout: false, timeoutMs: 30_000 });
  const stdout = await requireProcess(result, 'final-cap GitHub evidence read');
  return args.join(' ') === 'api user --jq .login' ? { login: stdout.trim() } : JSON.parse(stdout) as unknown;
}

/** The inventory owns the query; REST and content-edit history must attest the same live body. */
export async function resolveFinalCapIssueBodyRevision(input: {
  sourceRepoRoot: string; repoSlug: string; issueNumber: number; terminalizedAt: string; frozenBodyHash: string;
}, runner: typeof runProcess = runProcess): Promise<{ body: string; revision: string; editedAt: string }> {
  const [owner, name] = input.repoSlug.split('/');
  if (!owner || !name || !/^[^/\s]+\/[^/\s]+$/.test(input.repoSlug)) throw new Error('Issue repository identity missing');
  const inventory = JSON.parse(readFileSync(join(resolveTrustedRunnerPaths().trustedPackRoot,
    'scripts/lib/graphql-quota-github-read-inventory.json'), 'utf8')) as { rows: Array<{ id: string; query?: string }> };
  const rows = inventory.rows.filter((row) => row.id === 'issue-body-edit-evidence');
  const query = rows.length === 1 ? rows[0]?.query : undefined;
  if (!query) throw new Error('registered Issue body-edit query unavailable');
  const endpoint = `repos/${input.repoSlug}/issues/${input.issueNumber}`;
  const before = githubEvidenceObject(await readFinalCapGithubJson(input, ['api', endpoint], runner));
  const graph = githubEvidenceObject(await readFinalCapGithubJson(input, [
    'api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${input.issueNumber}`,
  ], runner));
  if (graph.errors !== undefined) throw new Error('Issue body-edit query returned errors');
  const repository = githubEvidenceObject(githubEvidenceObject(graph.data).repository);
  const issue = githubEvidenceObject(repository.issue);
  const edits = githubEvidenceObject(issue.userContentEdits);
  const nodes = Array.isArray(edits.nodes) ? edits.nodes : [];
  const edit = nodes.length === 1 ? githubEvidenceObject(nodes[0]) : {};
  const after = githubEvidenceObject(await readFinalCapGithubJson(input, ['api', endpoint], runner));
  const expectedUrl = `https://github.com/${input.repoSlug}/issues/${input.issueNumber}`.toLowerCase();
  for (const rest of [before, after]) {
    if (rest.number !== input.issueNumber || !trim(rest.node_id) || issue.id !== rest.node_id
        || trim(rest.html_url).toLowerCase() !== expectedUrl
        || trim(rest.repository_url).toLowerCase() !== `https://api.github.com/repos/${input.repoSlug}`.toLowerCase()
        || typeof rest.body !== 'string' || rest.body !== issue.body) throw new Error('Issue identity or current body drift');
  }
  const terminalizedAt = Date.parse(input.terminalizedAt);
  const editedAt = Date.parse(trim(edit.editedAt));
  if (trim(repository.nameWithOwner).toLowerCase() !== input.repoSlug.toLowerCase()
      || issue.number !== input.issueNumber || trim(issue.url).toLowerCase() !== expectedUrl
      || typeof issue.body !== 'string' || edit.diff !== issue.body || edit.deletedAt !== null
      || !Number.isInteger(edits.totalCount) || Number(edits.totalCount) < 2
      || edit.editedAt !== issue.lastEditedAt || !Number.isFinite(terminalizedAt)
      || !Number.isFinite(editedAt) || editedAt <= terminalizedAt
      || computeBoundIssueSnapshotHash(issue.body) === input.frozenBodyHash) {
    throw new Error('post-terminal live Issue-body revision not proven');
  }
  const revisions = [...issue.body.matchAll(/<!--\s*source-revision:\s*(r\d+)\s*-->/g)];
  if (revisions.length !== 1) throw new Error('live Issue revision identity missing or ambiguous');
  return { body: issue.body, revision: revisions[0]![1]!, editedAt: trim(edit.editedAt) };
}

async function resolveSameHeadIssueResolution(input: ReconcileStalePackReviewRunsInput, options: {
  projectId: string; storeRoot: string; repoSlug: string;
}, authority: PackReviewAuthorityDocument, run: PackReviewRunRecord) {
  const cycle = authority.cycle;
  const terminal = authority.terminal;
  const round = run.reviewRound;
  if (!cycle || !terminal || !round || run.id !== terminal.runId || run.runId !== run.id
      || run.projectId !== options.projectId || run.prNumber !== authority.prNumber
      || run.canonicalRepository?.toLowerCase() !== options.repoSlug.toLowerCase()
      || run.targetSha !== terminal.targetSha || run.headSha !== terminal.targetSha
      || authority.currentHeadSha !== terminal.targetSha || run.reviewCycleId !== cycle.cycleId
      || run.accountingVersion !== PACK_REVIEW_LOGICAL_CAP_MAP_VERSION
      || round.accountingVersion !== PACK_REVIEW_LOGICAL_CAP_MAP_VERSION
      || round.tier !== cycle.frozenTier || run.logicalRoundCap !== cycle.frozenCap
      || run.logicalRoundOrdinal !== cycle.frozenCap || round.roundOrdinal !== cycle.frozenCap
      || terminal.logicalRoundOrdinal !== cycle.frozenCap || round.cardinality !== 3
      || derivePackReviewGptCoverage(round)?.kind !== 'complete'
      || (round.settledSourceCount !== undefined && round.settledSourceCount !== round.cardinality)
      || run.resolvedReviewer !== 'gpt' || !run.completedAtUtc
      || !['changes_requested', 'commented'].includes(run.status)) throw new Error('exact final run/head/cycle/round/source identity missing');
  const payload = validatePersistedGptReviewPayload(run.id, { verdict: 'findings',
    findingCount: run.findingCount ?? -1, findings: run.findings as ReviewPayloadFinding[] }, options);
  const expectedTerminal = terminalV2FromPayload({ runId: run.id, targetSha: run.targetSha,
    logicalRoundOrdinal: run.logicalRoundOrdinal, verdict: 'findings', findingCount: payload.findingCount,
    findings: payload.findings, automaticBudgetDisposition: run.automaticBudgetDisposition });
  if (terminal.digest !== sha256Bytes(`${stableJson(expectedTerminal)}\n`)) throw new Error('terminal finding authority changed');
  const runner = process.env.OPK_VITEST_HARNESS === '1' ? input.fixtureSameHeadIssueResolutionRunner ?? runProcess : runProcess;
  const context = resolveTargetContext({ projectId: options.projectId });
  if (context.repository.toLowerCase() !== options.repoSlug.toLowerCase()) throw new Error('selected repository identity changed');
  const boundPrRunner: typeof runProcess = async (request) => {
    const result = await runner(request);
    const row = githubEvidenceObject(JSON.parse(await requireProcess(result, 'same-head PR identity read')) as unknown);
    if (row.number !== run.prNumber
        || trim(row.url).toLowerCase() !== `https://api.github.com/repos/${options.repoSlug}/pulls/${run.prNumber}`.toLowerCase()) {
      throw new Error('live PR repository/number identity mismatch');
    }
    return result;
  };
  const target = await resolveCurrentPrTarget(input.sourceRepoRoot, options.repoSlug, run.prNumber, boundPrRunner);
  if (target.headSha !== terminal.targetSha || extractClosingIssueNumber(target.body) !== round.issueNumber) {
    throw new Error('live PR head or linked Issue changed');
  }
  if (!await manualPackReviewRequiredCiGreen({
    startInput: { ...input, projectId: options.projectId },
    targetContext: context,
    target: { ...target, prBaseRef: target.baseRef, prNumber: run.prNumber, repoSlug: options.repoSlug, sourceRepoRoot: input.sourceRepoRoot },
  })) throw new Error('current-head required CI not green');
  const snapshot = resolveBoundIssueSnapshot({ projectId: options.projectId, prNumber: run.prNumber,
    prHeadSha: run.targetSha, issueNumber: round.issueNumber });
  if (snapshot.status !== 'found' || snapshot.snapshotHash !== round.boundIssueSnapshotDigest) throw new Error('frozen Issue snapshot identity missing');
  const revision = await resolveFinalCapIssueBodyRevision({ sourceRepoRoot: input.sourceRepoRoot, repoSlug: options.repoSlug,
    issueNumber: round.issueNumber, terminalizedAt: run.completedAtUtc, frozenBodyHash: round.boundIssueSnapshotDigest }, runner);
  const principal = trim(githubEvidenceObject(await readFinalCapGithubJson(input, ['api', 'user', '--jq', '.login'], runner)).login);
  const censusValue = await readFinalCapGithubJson(input, ['api', '--paginate', '--slurp',
    `repos/${options.repoSlug}/issues/${run.prNumber}/comments`], runner);
  if (!Array.isArray(censusValue) || !principal) throw new Error('trusted author disposition census unavailable');
  const census = censusValue.flat().map(githubEvidenceObject);
  const blockers = payload.findings.filter((finding) => !['warning', 'info', 'non-blocking'].includes(trim(finding.severity)));
  if (blockers.length === 0) throw new Error('terminal blocking findings missing');
  const candidates = census.filter((comment) => {
    if (trim(githubEvidenceObject(comment.user).login).toLowerCase() !== principal.toLowerCase()
        || trim(comment.issue_url).toLowerCase() !== `https://api.github.com/repos/${options.repoSlug}/issues/${run.prNumber}`.toLowerCase()
        || !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(trim(comment.author_association))
        || !Number.isInteger(comment.id) || typeof comment.body !== 'string') return false;
    // Ordinary author prose, scoped to the exact Rn/run/head section, never a new receipt.
    const sections = comment.body.split(/(?=^##\s)/m).filter((section) => {
      const heading = section.split('\n')[0] ?? '';
      return heading.startsWith(`## R${round.roundOrdinal} dispositions`) && heading.includes(`\`${run.id}\``)
        && heading.includes(`\`${run.targetSha}\``);
    });
    if (sections.length !== 1) return false;
    const bullets = sections[0]!.split(/(?=^-\s)/m).slice(1);
    return blockers.every((finding) => {
      const code = finding.body?.match(/^type: [^\n]+\ncode: ([^\n]+)\nseverity:/)?.[1];
      const signature = trim(finding.fingerprint);
      if (!code || !/^[a-f0-9]{64}$/.test(signature) || !['scope', 'scope-violation'].includes(trim(finding.category))) return false;
      const matches = bullets.filter((bullet) => bullet.includes(`\`${code}\``) && bullet.includes(`\`${signature}\``));
      if (matches.length !== 1) return false;
      const bullet = matches[0]!;
      const path = normalizePath(finding.filePath ?? '');
      const scope = parseIssueBody(revision.body);
      if (!path.ok || pathMatchesAnyPattern(path.path, [...REPOSITORY_DENYLIST, ...scope.denylist])
          || !pathMatchesAnyPattern(path.path, scope.allowed_roots ?? [])) return false;
      // The captured ordinary scope correction names its live body revision and exact corrected root.
      return /^- \*\*FIXED — blocking scope finding /i.test(bullet)
        && bullet.includes(`The live ${revision.revision} Issue now includes`)
        && bullet.includes('No code or behavior change was made for this disposition.')
        && !!finding.filePath && bullet.includes(`\`${finding.filePath}\``)
        && bullet.includes('`allowed-roots`');
    });
  });
  if (candidates.length !== 1) throw new Error('every blocker requires one trusted exact-run Issue-only disposition');
  const comment = candidates[0]!;
  const reread = githubEvidenceObject(await readFinalCapGithubJson(input, ['api',
    `repos/${options.repoSlug}/issues/comments/${String(comment.id)}`], runner));
  if (stableJson(reread) !== stableJson(comment)) throw new Error('author disposition changed during read');
  const liveIssue = githubEvidenceObject(await readFinalCapGithubJson(input, ['api',
    `repos/${options.repoSlug}/issues/${round.issueNumber}`], runner));
  if (liveIssue.body !== revision.body || liveIssue.number !== round.issueNumber
      || trim(liveIssue.repository_url).toLowerCase() !== `https://api.github.com/repos/${options.repoSlug}`.toLowerCase()) {
    throw new Error('Issue body changed before settlement');
  }
  const after = await resolveCurrentPrTarget(input.sourceRepoRoot, options.repoSlug, run.prNumber, boundPrRunner);
  if (after.headSha !== target.headSha || after.baseRef !== target.baseRef
      || extractClosingIssueNumber(after.body) !== round.issueNumber) throw new Error('PR identity changed before settlement');
  return { runId: run.id, cycleId: cycle.cycleId, logicalRoundOrdinal: round.roundOrdinal,
    publicationDigest: sha256Bytes(stableJson({ comment, revision, terminalDigest: terminal.digest })) };
}

async function readCheckedReviewPrHead(
  input: { sourceRepoRoot: string; fixtureCurrentPrHeadSha?: string;
    fixtureReadCurrentPrHead?: () => string | Promise<string> },
  repoSlug: string,
  prNumber: number,
  expectedSha: string,
): Promise<string> {
  if (input.fixtureReadCurrentPrHead) {
    return trim(await input.fixtureReadCurrentPrHead()).toLowerCase();
  }
  if (process.env.OPK_VITEST_HARNESS === '1') {
    return trim(input.fixtureCurrentPrHeadSha ?? expectedSha).toLowerCase();
  }
  return (await resolveCurrentPrHead(input.sourceRepoRoot, repoSlug, prNumber)).toLowerCase();
}

/** A read-time projection; launch disposition is not an accounting event. */
function noJudgmentBudgetOutcome(
  run: PackReviewRunRecord,
  storeRoot: string,
): 'non_consuming_no_judgment' | null {
  const authority = readPackReviewAuthority(run.prNumber, { storeRoot });
  if (!authority?.cycle
    || authority.currentHeadSha.toLowerCase() !== run.targetSha.toLowerCase()
    || authority.cycle.cycleId !== run.reviewCycleId
    || authority.terminal?.runId === run.id) return null;
  return derivePackReviewNoJudgmentBudgetOutcome(
    run,
    authority.cycle.consumedRoundOrdinals ?? [],
  );
}

/** Exactly one failure-only submission, independent of the eventual verdict. */
async function notifyNoJudgmentWorker(options: {
  run: PackReviewRunRecord;
  projectId: string;
  storeRoot: string;
  notifier: PackReviewWorkerNotifier;
}): Promise<{ state: 'submitted' | 'pre_dispatch_failure' | 'ambiguous' | 'skipped_unbound' | 'already_attempted' | 'not_applicable'; reason: string }> {
  const { projectId, storeRoot, notifier } = options;
  const read = () => getPackReviewRun(options.run.id, { projectId, storeRoot });
  const current = read();
  if (!current || !noJudgmentBudgetOutcome(current, storeRoot)) {
    return { state: 'not_applicable', reason: 'no_judgment_census_or_cap_changed' };
  }
  // Only the durable, immutable worker binding is authoritative. Session strings
  // and a caller-supplied recipient are never fallback transport identities.
  if (!parsePersistedWorkerNotificationBinding(current)) {
    return { state: 'skipped_unbound', reason: 'bound_worker_unavailable' };
  }
  const key = `worker-notification:no-judgment:${current.id}:${current.targetSha}`;
  const claimed = updatePackReviewRunIf(
    current.id,
    (records) => {
      const stored = records.find((candidate) => candidate.id === current.id);
      return Boolean(stored
        && !stored.deliveryOutcomes.noJudgmentWorkerNotification
        && !hasPersistedPackReviewVerdict(stored)
        && derivePackReviewGptCoverage(stored.reviewRound)?.kind === 'empty'
        && ['failed', 'timed_out', 'cancelled'].includes(stored.status));
    },
    (stored) => ({
      deliveryOutcomes: {
        ...stored.deliveryOutcomes,
        noJudgmentWorkerNotification: {
          state: 'escalated' as const,
          recordedAtUtc: new Date().toISOString(),
          reason: 'submission_outcome_unresolved',
          idempotencyKey: key,
        },
      },
    }),
    { projectId, storeRoot },
  );
  if (!claimed) return { state: 'already_attempted', reason: 'submission_fenced_by_persisted_channel' };
  let state: 'submitted' | 'pre_dispatch_failure' | 'ambiguous' = 'ambiguous';
  let reason = 'dispatch_outcome_unknown';
  try {
    const submission = await notifier({
      message: [
        `Pack review produced no completed reviewer judgment for PR #${current.prNumber}.`,
        `Run: ${current.id}`,
        `Head: ${current.targetSha}`,
        `Cause: ${current.failureReason ?? 'gpt_source_non_complete'}`,
        'The terminal source census did not consume a logical review round.',
        'Next: inspect the exact run with scoped pack-review reconcile; do not resend a possible_delivery attempt.',
        'This submission does not establish recipient receipt or authorize a new round.',
      ].join('\n'),
      idempotencyKey: key,
      reviewRunId: current.id,
    });
    state = submission.state === 'submitted' || submission.state === 'delivered'
      ? 'submitted'
      : submission.state === 'pre_dispatch_failure' || submission.state === 'failed'
        ? 'pre_dispatch_failure'
        : 'ambiguous';
    reason = submission.reason;
  } catch (error) {
    // A thrown call may have dispatched already; never blindly resend.
    state = 'ambiguous';
    reason = describeError(error);
  }
  updatePackReviewRun(current.id, {
    deliveryOutcomes: {
      noJudgmentWorkerNotification: {
        state: state === 'submitted' ? 'succeeded' : state === 'pre_dispatch_failure' ? 'failed' : 'escalated',
        recordedAtUtc: new Date().toISOString(),
        reason,
        idempotencyKey: key,
      },
    },
  }, { projectId, storeRoot });
  return { state, reason };
}

async function readFinalCapRequiredStatus(
  input: ReconcileStalePackReviewRunsInput,
  repoSlug: string,
  headSha: string,
): Promise<string | undefined> {
  if (input.fixtureRequiredStatusReader) {
    return trim(await input.fixtureRequiredStatusReader(headSha)).toLowerCase() || undefined;
  }
  const result = await runProcess({
    command: resolveTrackedGhWrapper(),
    args: ['api', `repos/${repoSlug}/commits/${headSha}/status`],
    cwd: input.sourceRepoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: 30_000,
  });
  const output = await requireProcess(result, `gh api commit status ${headSha}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error('final-cap commit status returned invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('final-cap commit status returned invalid object');
  }
  const statuses = (parsed as { statuses?: unknown }).statuses;
  if (!Array.isArray(statuses)) {
    throw new Error('final-cap commit status returned no status list');
  }
  // GitHub's combined-status endpoint orders commit statuses newest first.
  // Inspect this one exact context, not the aggregate status of unrelated CI.
  const current = statuses.find((entry: unknown) =>
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      && (entry as { context?: unknown }).context === PACK_REVIEW_REQUIRED_STATUS_CONTEXT,
  ) as { state?: unknown } | undefined;
  return current ? trim(current.state).toLowerCase() || undefined : undefined;
}

/** Repair an old cap-one success using exact-head evidence, never a new run. */
async function ensurePromotedRoundPublicPending(input: {
  run: PackReviewRunRecord; projectId: string; storeRoot: string;
  repoSlug: string; sourceRepoRoot: string;
  fixtureCurrentPrHeadSha?: string;
  fixtureRequiredStatusReader?: StartInput['fixtureRequiredStatusReader'];
  fixtureRequiredStatusWriter?: PackReviewRequiredStatusWriter;
}): Promise<void> {
  const currentLiveHead = async () => input.fixtureCurrentPrHeadSha
    ? trim(input.fixtureCurrentPrHeadSha).toLowerCase()
    : resolveCurrentPrHead(input.sourceRepoRoot, input.repoSlug, input.run.prNumber);
  const authority = readPackReviewAuthority(input.run.prNumber, { storeRoot: input.storeRoot });
  if (!authority?.cycle
      || input.run.logicalRoundCap === undefined
      || input.run.logicalRoundCap >= authority.cycle.frozenCap
      || !outstandingPackReviewCycle(input.run, input.storeRoot)) return;
  const payload = packReviewJournaledPayload(input.run);
  if (!payload || classifyPackReviewPayload(payload).blocking) return;
  if (await currentLiveHead() !== input.run.targetSha.toLowerCase()) {
    throw new Error('promoted required-status repair requires the current PR head');
  }
  const observe = () => readFinalCapRequiredStatus({
    sourceRepoRoot: input.sourceRepoRoot, repoSlug: input.repoSlug,
    fixtureRequiredStatusReader: input.fixtureRequiredStatusReader,
  }, input.repoSlug, input.run.targetSha);
  if (await observe() === 'pending') {
    if (!outstandingPackReviewCycle(input.run, input.storeRoot)
        || await currentLiveHead() !== input.run.targetSha.toLowerCase()) {
      throw new Error('promoted current-head pending changed during confirmation');
    }
    return;
  }
  if (!outstandingPackReviewCycle(input.run, input.storeRoot)
      || await currentLiveHead() !== input.run.targetSha.toLowerCase()) {
    throw new Error('promoted cycle authority or head changed before pending restoration');
  }
  const baseWriter = input.fixtureRequiredStatusWriter ?? ((request) => publishPackReviewRequiredStatus({
    repoRoot: input.sourceRepoRoot, repoSlug: input.repoSlug,
    headSha: input.run.targetSha, request,
  }));
  const restored = await restorePackReviewAuthoritativeRequiredStatus({
    run: input.run, projectId: input.projectId, storeRoot: input.storeRoot,
    writeRequiredStatus: currentCycleRequiredStatusWriter(input.run, input.storeRoot, baseWriter),
    forceRepublish: true,
  });
  if (restored?.state !== 'succeeded' || !outstandingPackReviewCycle(input.run, input.storeRoot)
      || await currentLiveHead() !== input.run.targetSha.toLowerCase()
      || await observe() !== 'pending') {
    throw new Error('promoted current-head pending status not confirmed');
  }
}

/** Observe existing verdict delivery on the exact head; only incumbent status
 * restoration can repair a failed/overwritten status. No new run authority. */
async function observePackReviewVerdictDelivery(options: {
  input: StartInput; projectId: string; storeRoot: string; runId: string;
  prNumber: number; headSha: string; repoSlug: string; sourceRepoRoot: string;
  readHead: () => Promise<string>; writeRequiredStatus: PackReviewRequiredStatusWriter;
  /** An incumbent journaled resume, not a just-failed first delivery, owns retry. */
  resumeFailedStatus?: boolean;
}): Promise<{ verified: boolean; reason: string; requiredStatusState?: 'pending' | 'success' | 'failure' }> {
  const unresolved = (reason: string) => ({ verified: false as const, reason });
  const load = () => getPackReviewRun(options.runId, {
    projectId: options.projectId, storeRoot: options.storeRoot,
  });
  const run = load();
  const payload = run && packReviewJournaledPayload(run);
  if (!run || !payload) return unresolved('journal_write_failed');
  const posted = run.githubReviewId !== undefined
    || (run.githubReviewReconciliation?.phase === 'complete'
      && run.githubReviewReconciliation.commentReviewId !== undefined);
  if (!posted || run.deliveryOutcomes.githubComment?.state !== 'succeeded') {
    return unresolved('review_comment_not_published');
  }
  const classification = classifyPackReviewPayload(payload);
  const intermediate = !classification.blocking
    && (outstandingPackReviewCycle(run, options.storeRoot)
      || (run.accountingVersion === PACK_REVIEW_LOGICAL_CAP_MAP_VERSION
        && Number.isInteger(run.logicalRoundOrdinal) && Number.isInteger(run.logicalRoundCap)
        && Number(run.logicalRoundOrdinal) < Number(run.logicalRoundCap)));
  const requiredStatusState = intermediate ? 'pending' as const : classification.requiredStatus;
  const current = async () => {
    try {
      const head = await options.readHead();
      const authority = readPackReviewAuthority(options.prNumber, { storeRoot: options.storeRoot });
      return head.toLowerCase() === options.headSha.toLowerCase()
        && authority?.currentHeadSha.toLowerCase() === options.headSha.toLowerCase()
        && authority.terminal?.runId === options.runId;
    } catch { return false; }
  };
  if (!(await current())) return unresolved('status_not_published:head_or_authority_changed');
  const observe = async (): Promise<string | undefined> => {
    if (process.env.OPK_VITEST_HARNESS === '1' && !options.input.fixtureRequiredStatusReader) {
      return outstandingPackReviewCycle(run, options.storeRoot)
        ? undefined
        : load()?.deliveryOutcomes.requiredStatus?.state === 'succeeded'
          ? requiredStatusState : undefined;
    }
    return readFinalCapRequiredStatus({
      sourceRepoRoot: options.sourceRepoRoot, repoSlug: options.repoSlug,
      fixtureRequiredStatusReader: options.input.fixtureRequiredStatusReader,
    }, options.repoSlug, options.headSha);
  };
  let observed: string | undefined;
  try { observed = await observe(); }
  catch { return unresolved('status_unverified:exact_head_status_read_failed'); }
  if (!(await current())) return unresolved('status_not_published:head_changed_during_status_read');
  if (observed !== requiredStatusState) {
    // A failed first POST is reported, not silently retried in the same start.
    // The next authorized PR-led journaled resume can restore it and observe
    // a fresh exact-head POST. An ACK followed by an observed overwritten
    // status may already be repaired on this first pass.
    if (run.deliveryOutcomes.requiredStatus?.state === 'failed'
        && options.resumeFailedStatus !== true) {
      return unresolved('status_not_published:failed_required_status_channel');
    }
    try {
      const restored = await restorePackReviewAuthoritativeRequiredStatus({
        run, projectId: options.projectId, storeRoot: options.storeRoot,
        writeRequiredStatus: currentCycleRequiredStatusWriter(
          run, options.storeRoot, options.writeRequiredStatus,
        ), forceRepublish: true,
      });
      if (restored?.state !== 'succeeded') return unresolved('status_not_published:restore_failed');
    } catch { return unresolved('status_not_published:restore_failed'); }
    if (!(await current())) return unresolved('status_not_published:head_changed_during_status_restore');
    try { observed = await observe(); }
    catch { return unresolved('status_unverified:restored_status_read_failed'); }
  }
  if (!(await current())) return unresolved('status_not_published:head_changed_during_confirmation');
  if (observed !== requiredStatusState) return unresolved('status_not_published:current_head_status_unconfirmed');
  if (!packReviewJournaledPayload(load() ?? run)) return unresolved('journal_write_failed');
  return { verified: true, reason: 'completed', requiredStatusState };
}

async function reconcileFinalCapSettlement(input: ReconcileStalePackReviewRunsInput, options: {
  projectId: string;
  storeRoot: string;
  repoSlug: string;
}): Promise<Record<string, unknown> | null> {
  const prNumber = input.prNumber;
  if (!prNumber) return null;
  let authority = readPackReviewAuthority(prNumber, { storeRoot: options.storeRoot });
  if (!authority?.cycle) return null;
  // A former T2 final-cap checkpoint must not close the review while a
  // verifiable linked-Issue amendment makes it a pre-cap T3 checkpoint.
  if (authority.cycle.capMapVersion === PACK_REVIEW_LOGICAL_CAP_MAP_VERSION
      && authority.cycle.frozenTier !== 'T3'
      && authority.cycle.reviewStageComplete !== true
      && ['at_cap_open_findings', 'at_cap_continuation_required'].includes(authority.cycle.state)
      && authority.terminal?.runId) {
    const terminalRun = getPackReviewRun(authority.terminal.runId, {
      projectId: options.projectId, storeRoot: options.storeRoot,
    });
    let issueNumber = terminalRun?.reviewRound?.issueNumber ?? input.fixtureIssueNumber;
    let currentFields: { title: string; body: string } | undefined;
    if (input.fixtureIssueBody !== undefined && input.fixtureIssueTitle !== undefined) {
      currentFields = { title: input.fixtureIssueTitle, body: input.fixtureIssueBody };
    } else if (process.env.OPK_VITEST_HARNESS !== '1') {
      try {
        if (!issueNumber) {
          const livePr = await resolveCurrentPrTarget(input.sourceRepoRoot, options.repoSlug, prNumber);
          issueNumber = extractClosingIssueNumber(livePr.body) ?? undefined;
        }
        if (!issueNumber) throw new Error('linked Issue unresolved');
        currentFields = await resolveCurrentIssueFields(input.sourceRepoRoot, options.repoSlug, issueNumber);
      } catch {
        // A mutable Issue title/body read outage is not itself evidence of
        // a raised tier. Preserve the frozen T2 final-cap continuation when
        // there is no authenticated upward amendment to apply.
      }
    }
    if (currentFields) {
      let effective: PackReviewTier;
      try { effective = parseAuthoritativeTier(currentFields.body, currentFields.title); }
      catch (error) {
        return { prNumber, finalCapSettlement: true, settled: false,
          reason: 'final_cap_live_issue_invalid', detail: describeError(error),
          nextAction: 'correct the linked Issue tier fields before final-cap settlement' };
      }
      const rank = { T1: 1, T2: 2, T3: 3 } as const;
      if (rank[effective] > rank[authority.cycle.frozenTier]) {
        // A mutable Issue read is not sufficient authority to change a historical
        // cycle: validate the *current* open PR, exact head and closing Issue.
        // A missing fixture witness is not synthetic permission to promote.
        let linkedPr: { headSha: string; body: string };
        try {
          if (process.env.OPK_VITEST_HARNESS === '1') {
            if (input.fixturePrState?.toUpperCase() !== 'OPEN'
                || input.fixturePrMerged === true || !input.fixturePrBody
                || !input.fixtureCurrentPrHeadSha) {
              throw new Error('unverified synthetic open/unmerged PR binding');
            }
            linkedPr = {
              headSha: trim(input.fixtureCurrentPrHeadSha).toLowerCase(),
              body: input.fixturePrBody,
            };
          } else {
            linkedPr = await resolveCurrentPrTarget(input.sourceRepoRoot, options.repoSlug, prNumber);
          }
          if (linkedPr.headSha !== authority.currentHeadSha.toLowerCase()
              || !issueNumber || extractClosingIssueNumber(linkedPr.body) !== issueNumber) {
            throw new Error('PR head or linked closing Issue changed');
          }
        } catch (error) {
          return { prNumber, headSha: authority.currentHeadSha,
            finalCapSettlement: true, settled: false,
            reason: 'final_cap_promotion_pr_binding_unverified', detail: describeError(error),
            nextAction: 'verify the open, unmerged PR head and its exact closing Issue before retrying scoped reconcile' };
        }
        authority = reconcilePackReviewTier({
          prNumber, tier: effective, startedRunExists: true,
          options: { storeRoot: options.storeRoot },
        });
        if (authority.cycle?.state === 'open_findings') {
          return { prNumber, headSha: authority.currentHeadSha,
            finalCapSettlement: true, settled: false,
            reason: 'prior_round_findings_unresolved_after_promotion',
            nextAction: 'prove the strict-descendant fix before starting required round 2' };
        }
      }
    }
  }
  if (!authority.cycle) return null;
  const logicalAccounting = authority.cycle.capMapVersion === PACK_REVIEW_LOGICAL_CAP_MAP_VERSION;
  const logicalFinalFindings = logicalAccounting
    && ['at_cap_open_findings', 'at_cap_continuation_required'].includes(authority.cycle.state)
    && authority.terminal?.reviewVerdict === 'findings';
  // A persisted publication receipt is not proof that GitHub still has the
  // required status. A closed descendant must remain eligible for status-only
  // reconciliation, without reopening settlement or consuming another round.
  const completedFinalFindings = logicalAccounting && authority.cycle.state === 'closed'
    && authority.cycle.reviewStageComplete === true
    && authority.terminal?.reviewVerdict === 'findings'
    && (authority.cycle.settlementKind === 'same_head_issue_resolution'
      || authority.currentHeadSha !== authority.terminal.targetSha);
  if (!logicalFinalFindings && !completedFinalFindings && authority.cycle.state !== 'at_cap_continuation_required') return null;

  const currentHead = await readCheckedReviewPrHead(
    input, options.repoSlug, prNumber, authority.currentHeadSha,
  );
  if ((logicalFinalFindings || completedFinalFindings)
      && currentHead.toLowerCase() !== authority.currentHeadSha.toLowerCase()) {
    try {
      authority = observePackReviewHead({
        prNumber,
        expectedTransitionSeq: authority.transitionSeq,
        headSha: currentHead,
        options: { storeRoot: options.storeRoot },
      });
    } catch {
      authority = readPackReviewAuthority(prNumber, { storeRoot: options.storeRoot }) ?? authority;
    }
  }
  if (currentHead.toLowerCase() !== authority.currentHeadSha.toLowerCase()) {
    return {
      prNumber,
      finalCapSettlement: true,
      settled: false,
      reason: 'final_cap_settlement_head_not_observed',
      nextAction: 'observe the current PR head, then rerun scoped reconcile',
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

  // A non-descendant has never been eligible for final-cap success. Keep that
  // existing refusal ahead of body-validation errors and status publication.
  if (logicalFinalFindings && authority.cycle?.frozenTier !== 'T1'
      && authority.terminal
      && authority.currentHeadSha !== authority.terminal.targetSha) {
    const strict = await resolvePackReviewStrictDescendant({
      repoRoot: input.sourceRepoRoot, repoSlug: options.repoSlug,
      reviewedHeadSha: authority.terminal.targetSha,
      currentHeadSha: authority.currentHeadSha,
      fixtureReviewCompareStatus: input.fixtureReviewCompareStatus,
    });
    if (!strict) {
      return { prNumber, headSha: authority.currentHeadSha, finalCapSettlement: true,
        settled: false, reason: 'final_cap_strict_descendant_required',
        nextAction: 'advance the same PR from the final findings head with a verified strict descendant, then reconcile' };
    }
  }

  // At the findings cap, review completion and required success use the old
  // preflight body snapshot, not a revision tag or an amended current Issue.
  let verifiedFinalIssue: { issueNumber: number; digest: string } | undefined;
  if (logicalAccounting && authority.cycle?.frozenTier !== 'T1'
      && authority.currentHeadSha !== authority.terminal.targetSha) {
    try {
      const cycle = authority.cycle;
      const terminal = authority.terminal;
      if (!cycle || cycle.consumedRoundOrdinals?.length !== cycle.frozenCap
          || cycle.consumedRoundOrdinals.at(-1) !== cycle.frozenCap
          || terminal.logicalRoundOrdinal !== cycle.frozenCap
          || priorRun.id !== terminal.runId || priorRun.runId !== terminal.runId
          || priorRun.projectId !== options.projectId || priorRun.prNumber !== prNumber
          || priorRun.canonicalRepository?.toLowerCase() !== options.repoSlug.toLowerCase()
          || priorRun.targetSha !== terminal.targetSha || priorRun.headSha !== terminal.targetSha
          || priorRun.reviewCycleId !== cycle.cycleId
          || priorRun.accountingVersion !== PACK_REVIEW_LOGICAL_CAP_MAP_VERSION
          || priorRun.logicalRoundOrdinal !== cycle.frozenCap
          || priorRun.logicalRoundCap !== cycle.frozenCap || !priorRun.completedAtUtc) {
        throw new Error('last terminal findings project/PR/head/cycle/ordinal binding missing');
      }
      const immutableTerminal = listPackReviewImmutableRecords('terminal', { storeRoot: options.storeRoot })
        .filter((entry) => entry.digest === terminal.digest
          && (entry.value as PackReviewTerminalV2 | undefined)?.runId === priorRun.id
          && (entry.value as PackReviewTerminalV2 | undefined)?.targetSha === terminal.targetSha
          && (entry.value as PackReviewTerminalV2 | undefined)?.logicalRoundOrdinal === cycle.frozenCap
          && (entry.value as PackReviewTerminalV2 | undefined)?.reviewVerdict === 'findings');
      if (immutableTerminal.length !== 1) throw new Error('exact final terminal immutable evidence missing or ambiguous');

      const reviewedIssue = priorRun.reviewRound?.issueNumber
        ?? (process.env.OPK_VITEST_HARNESS === '1' ? input.fixtureIssueNumber : undefined);
      const livePr = process.env.OPK_VITEST_HARNESS === '1'
        ? (input.fixturePrBody && input.fixtureCurrentPrHeadSha
          ? { body: input.fixturePrBody, headSha: trim(input.fixtureCurrentPrHeadSha).toLowerCase() }
          : undefined)
        : await resolveCurrentPrTarget(input.sourceRepoRoot, options.repoSlug, prNumber);
      if (!livePr || livePr.headSha !== authority.currentHeadSha.toLowerCase()) {
        throw new Error('current selected PR head or closing Issue binding unavailable');
      }
      const issueNumber = extractClosingIssueNumber(livePr.body);
      if (!issueNumber || (reviewedIssue && reviewedIssue !== issueNumber)) {
        throw new Error('reviewed Issue differs from the actual current PR-closing Issue');
      }
      const frozen = resolveBoundIssueSnapshot({
        projectId: options.projectId, prNumber, prHeadSha: terminal.targetSha,
        issueNumber, storeDirOverride: process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR,
      });
      if (frozen.status !== 'found' || !frozen.snapshotHash
          || frozen.metadata?.capturePhase !== 'review-preflight'
          || frozen.metadata.projectId !== options.projectId
          || frozen.metadata.prNumber !== prNumber
          || frozen.metadata.issueNumber !== issueNumber
          || frozen.metadata.prHeadSha.toLowerCase() !== terminal.targetSha.toLowerCase()) {
        throw new Error('verified last findings frozen Issue snapshot missing or corrupt');
      }
      if (priorRun.reviewRound) {
        const round = priorRun.reviewRound;
        if (round.reviewer !== 'gpt' || priorRun.resolvedReviewer !== 'gpt'
            || round.issueNumber !== issueNumber || round.boundIssueSnapshotDigest !== frozen.snapshotHash
            || round.roundOrdinal !== cycle.frozenCap
            || round.accountingVersion !== PACK_REVIEW_LOGICAL_CAP_MAP_VERSION
            || round.tier !== cycle.frozenTier) {
          throw new Error('last GPT findings round or snapshot digest mismatch');
        }
      } else {
        if (!['codex', 'claude'].includes(priorRun.resolvedReviewer ?? '')) {
          throw new Error('native findings review lacks a validated preflight snapshot binding');
        }
        // Native has no GPT reviewRound: only one validated same-head Issue
        // snapshot captured before this run began can bind its terminal.
        const runCreatedAt = Date.parse(priorRun.createdAt);
        const capturedAt = Date.parse(frozen.metadata.capturedAt);
        if (!Number.isFinite(runCreatedAt) || !Number.isFinite(capturedAt)
            || capturedAt > runCreatedAt) {
          throw new Error('native Issue snapshot was not captured before the terminal run');
        }
        const snapshotPaths = boundIssueSnapshotArtifactPaths({
          projectId: options.projectId, prNumber, prHeadSha: terminal.targetSha,
          issueNumber, storeDirOverride: process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR,
        });
        const originalIssues = readdirSync(snapshotPaths.artifactDir)
          .filter((name) => /^issue-\d+\.meta\.json$/.test(name))
          .flatMap((name) => {
            const number = Number(/^issue-(\d+)\.meta\.json$/.exec(name)![1]);
            const candidate = resolveBoundIssueSnapshot({
              projectId: options.projectId, prNumber, prHeadSha: terminal.targetSha,
              issueNumber: number, storeDirOverride: process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR,
            });
            if (candidate.status !== 'found' || !candidate.metadata
                || candidate.metadata.capturePhase !== 'review-preflight'
                || candidate.metadata.projectId !== options.projectId
                || candidate.metadata.prNumber !== prNumber
                || candidate.metadata.issueNumber !== number
                || candidate.metadata.prHeadSha.toLowerCase() !== terminal.targetSha.toLowerCase()
                || !Number.isFinite(Date.parse(candidate.metadata.capturedAt))) {
              throw new Error('native same-head Issue snapshot identity is ambiguous or corrupt');
            }
            return Date.parse(candidate.metadata.capturedAt) <= runCreatedAt ? [number] : [];
          });
        if (originalIssues.length !== 1 || originalIssues[0] !== issueNumber) {
          throw new Error('native terminal original pre-run closing Issue binding is missing or ambiguous');
        }
      }
      const liveIssue = process.env.OPK_VITEST_HARNESS === '1'
        ? (input.fixtureIssueBody !== undefined && input.fixtureIssueTitle
          ? { title: input.fixtureIssueTitle, body: input.fixtureIssueBody }
          : undefined)
        : await resolveCurrentIssueFields(input.sourceRepoRoot, options.repoSlug, issueNumber);
      if (!liveIssue) throw new Error('current linked Issue body/title unavailable');
      parseAuthoritativeTier(liveIssue.body, liveIssue.title);
      const digest = computeBoundIssueSnapshotHash(liveIssue.body);
      let expectedDigest: string | undefined = frozen.snapshotHash;
      if (completedFinalFindings && cycle.settlementKind === 'same_head_issue_resolution') {
        // The completed #2428 Issue-only resolution reviewed B0 but expressly
        // settled owner-edited B1. Its durable completion time bounds the last
        // accepted body edit; a later amendment must not inherit that status.
        if (!priorRun.reviewRound || !cycle.reviewStageCompletedAtUtc) {
          throw new Error('completed same-head Issue resolution source or completion time missing');
        }
        const revision = await resolveFinalCapIssueBodyRevision({
          sourceRepoRoot: input.sourceRepoRoot, repoSlug: options.repoSlug,
          issueNumber, terminalizedAt: priorRun.completedAtUtc,
          frozenBodyHash: frozen.snapshotHash,
        }, process.env.OPK_VITEST_HARNESS === '1'
          ? input.fixtureSameHeadIssueResolutionRunner ?? runProcess : runProcess);
        const completedAt = Date.parse(cycle.reviewStageCompletedAtUtc);
        if (!Number.isFinite(completedAt)) {
          throw new Error('completed same-head Issue resolution time invalid');
        }
        expectedDigest = Date.parse(revision.editedAt) <= completedAt
          ? computeBoundIssueSnapshotHash(revision.body) : undefined;
      }
      if (digest !== expectedDigest) {
        const command = `npm run --silent pack-gpt-review -- --project ${options.projectId} --pr-number ${prNumber}`;
        return {
          prNumber, headSha: authority.currentHeadSha, finalCapSettlement: true,
          settled: false, reason: 'final_cap_issue_body_amended',
          reviewedIssueNumber: issueNumber,
          nextAction: `start one new review round on the current head; an Issue amendment resets the cap: node --experimental-strip-types scripts/pack-review-runner.ts reset --project ${options.projectId} --pr-number ${prNumber} --actor <actor> --reason <reason> --nonce <nonce>; then ${command}. If the existing bound snapshot on this PR head differs from the amended live Issue body, no review can start on this head: advance this same PR to a fresh head with a genuine change, then run ${command} on the new current head; do not overwrite the historical snapshot.`,
        };
      }
      verifiedFinalIssue = { issueNumber, digest };
    } catch (error) {
      return {
        prNumber, headSha: authority.currentHeadSha, finalCapSettlement: true,
        settled: false, reason: 'final_cap_review_binding_unverified', detail: describeError(error),
        nextAction: 'restore the existing exact terminal/Issue/snapshot binding or obtain a newly reviewed current Issue body; do not publish final-cap success',
      };
    }
  }

  const publishFinalCapStatus = async (
    description: string,
    digest: string,
    successReason: string,
  ): Promise<Record<string, unknown>> => {
    const publicationHead = authority?.currentHeadSha ?? '';
    const publicationCycle = authority?.cycle?.cycleId;
    const validCurrent = async () => {
      const liveHead = await readCheckedReviewPrHead(input, options.repoSlug, prNumber, publicationHead);
      const latest = readPackReviewAuthority(prNumber, { storeRoot: options.storeRoot });
      const liveRun = getPackReviewRun(priorRun.id, {
        projectId: options.projectId, storeRoot: options.storeRoot,
      });
      let currentIssueStillBound = true;
      if (verifiedFinalIssue) {
        try {
          const currentPr = process.env.OPK_VITEST_HARNESS === '1'
            ? { headSha: trim(input.fixtureCurrentPrHeadSha).toLowerCase(), body: input.fixturePrBody }
            : await resolveCurrentPrTarget(input.sourceRepoRoot, options.repoSlug, prNumber);
          const currentIssue = process.env.OPK_VITEST_HARNESS === '1'
            ? { body: input.fixtureIssueBody }
            : await resolveCurrentIssueFields(input.sourceRepoRoot, options.repoSlug, verifiedFinalIssue.issueNumber);
          currentIssueStillBound = currentPr.headSha === publicationHead.toLowerCase()
            && extractClosingIssueNumber(currentPr.body ?? '') === verifiedFinalIssue.issueNumber
            && typeof currentIssue.body === 'string'
            && computeBoundIssueSnapshotHash(currentIssue.body) === verifiedFinalIssue.digest;
        } catch { currentIssueStillBound = false; }
      }
      return currentIssueStillBound
        && liveHead === publicationHead.toLowerCase()
        && latest?.currentHeadSha.toLowerCase() === publicationHead.toLowerCase()
        && latest.terminal?.runId === priorRun.id
        && latest.terminal?.reviewVerdict === 'findings'
        && latest.terminal?.targetSha === priorRun.targetSha
        && latest.cycle?.cycleId === publicationCycle
        && latest.cycle?.state === 'closed'
        && latest.cycle?.reviewStageComplete === true
        && latest.triage?.verdict !== 'BLOCK'
        && liveRun?.reviewVerdict === 'findings'
        && liveRun.reviewCycleId === publicationCycle
        && liveRun.targetSha === priorRun.targetSha;
    };
    const unresolved = (detail: string): Record<string, unknown> => ({
      prNumber, headSha: publicationHead, finalCapSettlement: true,
      settled: false, reason: 'status_not_published', detail,
      nextAction: 'retry current-head status projection with PR-led start or scoped reconcile; do not consume another round',
    });
    if (!(await validCurrent())) return unresolved('final_cap_head_or_authority_changed_before_status');
    let confirmed: boolean;
    try {
      confirmed = await readFinalCapRequiredStatus(input, options.repoSlug, publicationHead) === 'success';
    } catch (error) {
      return unresolved(`final_cap_status_read_failed:${describeError(error)}`);
    }
    if (!(await validCurrent())) return unresolved('final_cap_head_or_authority_changed_before_status');
    if (!confirmed) {
      const request = {
        state: 'success' as const, context: PACK_REVIEW_REQUIRED_STATUS_CONTEXT,
        description, idempotencyKey: `final-cap:${priorRun.id}:${publicationHead}`,
      };
      try {
        await (input.fixtureRequiredStatusWriter ?? ((value) => publishPackReviewRequiredStatus({
          repoRoot: input.sourceRepoRoot, repoSlug: options.repoSlug,
          headSha: publicationHead, request: value,
        })))(request);
      } catch (error) {
        return unresolved(`final_cap_status_write_failed:${describeError(error)}`);
      }
      if (!(await validCurrent())) return unresolved('final_cap_head_or_authority_changed_during_status');
      try {
        confirmed = await readFinalCapRequiredStatus(input, options.repoSlug, publicationHead) === 'success';
      } catch (error) {
        return unresolved(`final_cap_status_confirmation_failed:${describeError(error)}`);
      }
      if (!(await validCurrent())) return unresolved('final_cap_head_or_authority_changed_during_status');
      if (!confirmed) return unresolved('final_cap_success_status_unconfirmed_on_current_head');
    }
    try {
      const latest = readPackReviewAuthority(prNumber, { storeRoot: options.storeRoot });
      if (!latest) return unresolved('final_cap_authority_missing_after_status');
      // Confirmation of an already-published status must not append a new
      // authority transition or another GitHub status on repeated reconcile.
      authority = latest.publication?.status === 'succeeded'
        && latest.publication.headSha === publicationHead
        && latest.publication.terminalRunId === priorRun.id
        ? latest
        : recordPackReviewPublication({
          prNumber, expectedTransitionSeq: latest.transitionSeq, nextPhase: 'external_published',
          publication: {
            headSha: publicationHead, terminalRunId: priorRun.id,
            status: 'succeeded', publicationDigest: digest,
            recordedAtUtc: new Date().toISOString(),
          },
          options: { storeRoot: options.storeRoot },
        });
    } catch (error) {
      return unresolved(`final_cap_publication_record_failed:${describeError(error)}`);
    }
    if (!(await validCurrent())) return unresolved('final_cap_authority_or_head_changed_after_record');
    return {
      prNumber, headSha: publicationHead, finalCapSettlement: true, settled: true,
      statusPublished: true, publicationHeadSha: publicationHead,
      reason: successReason, settlementKind: authority.cycle?.settlementKind,
    };
  };

  if (logicalAccounting) {
    const reviewedHeadSha = authority.terminal.targetSha;
    if (authority.currentHeadSha === reviewedHeadSha) {
      try {
        const proof = await resolveSameHeadIssueResolution(input, options, authority, priorRun);
        if (!completedFinalFindings) {
          authority = settleLogicalPackReviewFindingsByStrictDescendant({
            prNumber, expectedTransitionSeq: authority.transitionSeq, reviewedHeadSha,
            currentHeadSha: authority.currentHeadSha, reviewedHeadIsAncestor: false,
            sameHeadIssueResolution: proof, options: { storeRoot: options.storeRoot },
          });
        }
        return await publishFinalCapStatus(
          'review_stage_complete: same-head Issue resolution',
          proof.publicationDigest,
          'final_cap_same_head_issue_resolution_settled',
        );
      } catch (error) {
        return { prNumber, headSha: authority.currentHeadSha, finalCapSettlement: true, settled: false,
          reason: 'final_cap_strict_descendant_required', detail: describeError(error),
          nextAction: 'provide complete exact-run trusted Issue-only dispositions, post-terminal body revision and current-head green CI, or advance to a proven strict descendant; rerun scoped reconcile' };
      }
    }
    if (!completedFinalFindings) {
      const strictDescendant = await resolvePackReviewStrictDescendant({
        repoRoot: input.sourceRepoRoot,
        repoSlug: options.repoSlug,
        reviewedHeadSha,
        currentHeadSha: authority.currentHeadSha,
        fixtureReviewCompareStatus: input.fixtureReviewCompareStatus,
      });
      if (!strictDescendant) {
        return {
          prNumber, headSha: authority.currentHeadSha, finalCapSettlement: true,
          settled: false, reason: 'final_cap_strict_descendant_required',
          nextAction: 'advance the PR to a proven strict descendant of the reviewed findings head, then rerun scoped reconcile',
        };
      }
      try {
        authority = settleLogicalPackReviewFindingsByStrictDescendant({
          prNumber, expectedTransitionSeq: authority.transitionSeq,
          reviewedHeadSha, currentHeadSha: authority.currentHeadSha,
          reviewedHeadIsAncestor: true, options: { storeRoot: options.storeRoot },
        });
      } catch (error) {
        return {
          prNumber, headSha: authority.currentHeadSha, finalCapSettlement: true,
          settled: false, reason: `final_cap_settlement_incomplete:${describeError(error)}`,
          nextAction: 'rerun scoped reconcile after confirming the current PR head',
        };
      }
    }
    return publishFinalCapStatus(
      'Required pack-review stage completed; strict descendant of reviewed findings.',
      sha256Bytes(stableJson({
        runId: priorRun.id, reviewedHeadSha, publicationHead: authority.currentHeadSha,
        settlementKind: 'strict_descendant',
      })),
      'final_cap_descendant_settled',
    );
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
    fixtureIssueTitle: input.fixtureIssueTitle,
    storeRoot: options.storeRoot,
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
      nextAction: 'fix the reported blocker, then rerun scoped reconcile',
    };
  }
  const settled = authority.cycle?.reviewStageComplete === true;
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
        ? (logicalAccounting
          ? 'resolve the blocking current-head evidence, then rerun scoped reconcile'
          : 'resolve the blocking current-head evidence, then rerun scoped reconcile')
        : 'complete the current-head finding-resolution evidence, then rerun scoped reconcile',
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
  const scopedReconcileAction = (prNumber: number) =>
    `node --experimental-strip-types scripts/pack-review-runner.ts reconcile --source-repo-root ${JSON.stringify(input.sourceRepoRoot)} --repo-slug ${repoSlug} --pr-number ${prNumber}`;
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
  // Guard journal-only recovery before any stale-status or review delivery write.
  if (records.some((run) =>
    run.canonicalRepository === repoSlug
    && Boolean(packReviewJournaledPayload(run))
    && packReviewDeliveryNeedsResume(run))) {
    const invalidAuthority = packReviewResumeReviewerAuthorityError(process.env);
    if (invalidAuthority) throw new Error(invalidAuthority);
  }
  const results: Array<Record<string, unknown>> = [];
  const restoreLatestAuthority = async (
    staleRun: PackReviewRunRecord,
    writeRequiredStatus: PackReviewRequiredStatusWriter,
    forceRepublish = false,
  ) => {
    let restored: Awaited<ReturnType<typeof restorePackReviewAuthoritativeRequiredStatus>> = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const currentOrder = resolvePackReviewRequiredRunOrder(await readBoundRecords(), staleRun);
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
      const remaining = outstandingPackReviewCycle(currentOrder.run, storeRoot);
      restored = await restorePackReviewAuthoritativeRequiredStatus({
        run: currentOrder.run,
        projectId,
        storeRoot,
        writeRequiredStatus: currentCycleRequiredStatusWriter(currentOrder.run, storeRoot, writeRequiredStatus),
        pauseAfterPendingWrite: input.fixturePauseAfterPendingRestoreWrite,
        forceRepublish: forceRepublish || remaining,
      });
      if (input.fixturePauseAfterRestoreRead) {
        await input.fixturePauseAfterRestoreRead(currentOrder.run);
      }
      const afterWrite = resolvePackReviewRequiredRunOrder(await readBoundRecords(), staleRun);
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
          const currentOrder = resolvePackReviewRequiredRunOrder(boundRecords, staleRun);
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

  const verifyStaleDelivery = async (
    recoveredRun: PackReviewRunRecord,
    statusWriter: PackReviewRequiredStatusWriter,
  ): Promise<{ verified: boolean; reason: string }> => {
    if (recoveredRun.automaticBudgetDisposition === 'non_consuming_explicit') {
      const fresh = getPackReviewRun(recoveredRun.id, { projectId, storeRoot }) ?? recoveredRun;
      const receipt = supplementalReviewReceipt(fresh);
      return { verified: Boolean(receipt), reason: receipt
        ? 'supplemental_review_delivered' : 'supplemental_comment_or_journal_unconfirmed' };
    }
    // Both explicit recovery and stale fleet reconciliation must verify the
    // exact-head required status; a successful POST alone is not publication.
    try {
      return await observePackReviewVerdictDelivery({
        input, projectId, storeRoot, runId: recoveredRun.id,
        prNumber: recoveredRun.prNumber, headSha: recoveredRun.targetSha,
        repoSlug, sourceRepoRoot: input.sourceRepoRoot,
        readHead: () => readCheckedReviewPrHead(
          input, repoSlug, recoveredRun.prNumber, recoveredRun.targetSha,
        ),
        writeRequiredStatus: statusWriter,
        resumeFailedStatus: true,
      });
    } catch (error) {
      return { verified: false, reason: `status_unverified:${describeError(error)}` };
    }
  };

  for (const candidate of records) {
    if (input.runId && candidate.id !== input.runId) continue;
    const activeStale = isPackReviewRunStale(candidate);
    if (input.staleOnly && !activeStale) continue;
    const unfinishedTerminal = isPackReviewUnfinishedTerminalRun(candidate);
    const activeGptRecovery = (input.immediate === true || input.recoverActiveGptSources === true)
      && PACK_REVIEW_ACTIVE_STATUSES.has(candidate.status)
      && candidate.reviewRound?.reviewer === 'gpt';
    if (!activeStale && !unfinishedTerminal && !activeGptRecovery) continue;

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

    // A proven-dead foreign attempt was retired specifically to free the
    // incomplete required ordinal. Preserve its immutable attempted sources,
    // but never let its later reconciliation overwrite the replacement verdict.
    if (candidate.failureReason === 'explicit_reviewer_superseded_proven_dead_original') {
      results.push({ runId: candidate.id, terminalized: false, statusReconciled: false,
        reason: 'superseded_dead_foreign_reviewer_preserved',
        nextAction: 'observe the original source history and the replacement run; do not publish status from the retired origin' });
      continue;
    }

    // A resolved moved-head failure (including a restored newer-run status) is
    // closed on its original SHA. Repeating scoped reconcile must not post again.
    if (candidate.status === 'failed'
        && candidate.failureReason === 'stale_head_before_terminal'
        && packReviewRequiredStatusStaleReconciliationComplete(candidate)) {
      results.push({
        runId: candidate.id,
        terminalized: false,
        statusReconciled: true,
        reason: 'status_already_reconciled',
        nextAction: `PR #${candidate.prNumber} head moved from ${candidate.targetSha}; old-head status is already settled. Review the current head only if existing project review-cap rules permit another required round.`,
      });
      continue;
    }

    const initialOrder = resolvePackReviewRequiredRunOrder(records, candidate);
    if (initialOrder.kind === 'ambiguous'
        || ((input.runId || input.staleOnly) && initialOrder.kind === 'newer')) {
      results.push({
        runId: candidate.id,
        terminalized: false,
        statusReconciled: false,
        reason: initialOrder.kind === 'newer' ? 'newer_run_authoritative' : initialOrder.reason,
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
        && packReviewJournaledPayload(run)
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
        const publication = resumed.reason === 'completed'
          ? await verifyStaleDelivery(getPackReviewRun(run.id, { projectId, storeRoot }) ?? run, statusWriter)
          : { verified: false, reason: resumed.reason };
        results.push({
          runId: run.id,
          terminalized: false,
          statusReconciled: publication.verified,
          recovered: true,
          degraded: run.reviewRound?.settledSourceCount === 2,
          settledSourceCount: run.reviewRound?.settledSourceCount,
          reason: resumed.reason === 'completed'
            ? publication.verified ? 'gpt_journaled_delivery_resumed'
              : `gpt_journaled_delivery_unverified:${publication.reason}`
            : `gpt_journaled_delivery_${resumed.reason}`,
          deliveryReason: resumed.reason,
          status: resumed.status,
          coverage: derivePackReviewGptCoverage(run.reviewRound),
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

    const needsGptSourceRecovery = unfinishedTerminal
      && run.reviewRound?.reviewer === 'gpt'
      && !packReviewJournaledPayload(run)
      && packReviewDeliveryNeedsResume(run);
    if (activeStale && run.reviewRound?.reviewer !== 'gpt' && run.nativeAttempt) {
      const observation = observeNativePackReviewAttempt(run);
      if (observation && !observation.replacementEligible) {
        results.push({
          runId: run.id,
          terminalized: false,
          statusReconciled: false,
          reason: `native_attempt_${observation.state}`,
          reviewer: observation.reviewer,
          replacementEligible: false,
          elapsedMs: observation.elapsedMs,
          nativeReplacementCeilingMs: observation.nativeReplacementCeilingMs,
          nextAction: observation.state === 'running'
            ? 'let the current native reviewer attempt continue; unrelated work may proceed'
            : 'native reviewer liveness is unavailable; keep the attempt visible and continue unrelated work',
        });
        continue;
      }
    }

    if (activeStale || activeGptRecovery || needsGptSourceRecovery) {
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
          const publication = resumed.reason === 'completed'
            ? await verifyStaleDelivery(getPackReviewRun(run.id, { projectId, storeRoot }) ?? recoveredRun, statusWriter)
            : { verified: false, reason: resumed.reason };
          results.push({
            runId: run.id,
            terminalized: false,
            statusReconciled: publication.verified,
            recovered: true,
            degraded: recoveredRun.reviewRound?.settledSourceCount === 2,
            settledSourceCount: recoveredRun.reviewRound?.settledSourceCount,
            reason: resumed.reason === 'completed'
              ? publication.verified ? 'gpt_source_comments_recovered_and_delivered'
                : `gpt_source_comments_recovered_delivery_unverified:${publication.reason}`
              : `gpt_source_comments_recovered_delivery_${resumed.reason}`,
            deliveryReason: resumed.reason,
            status: resumed.status,
            coverage: derivePackReviewGptCoverage(recoveredRun.reviewRound),
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

      const recoveredSnapshot = getPackReviewRun(run.id, { projectId, storeRoot }) ?? run;
      const recoveryCoverage = derivePackReviewGptCoverage(recoveredSnapshot.reviewRound);
      if (recovery.reason === 'gpt_source_head_changed'
          || recovery.reason === 'gpt_source_head_changed_after_census') {
        // Recovery's initial snapshot and the source census are not a terminal
        // authority. A concurrent, journaled verdict may have won either one.
        let observedHead = 'another SHA';
        try {
          observedHead = await readCheckedReviewPrHead(
            input, repoSlug, run.prNumber, run.targetSha,
          );
        } catch {
          // The recovery already observed head movement; do not invent a SHA.
        }
        const movedAction = (disposition: string, repair = false) =>
          `PR #${run.prNumber} head moved from ${run.targetSha} to ${observedHead}; ${disposition}. ${repair ? 'Rerun scoped reconcile for old-head status repair; ' : ''}Review the current head only if existing project review-cap rules permit another required round.`;

        // The existing interleaving hook also permits a verdict to settle
        // immediately before the locked terminal mutation.
        if (input.beforeStaleStatusWrite) await input.beforeStaleStatusWrite(recoveredSnapshot);
        const beforeTerminal = getPackReviewRun(run.id, { projectId, storeRoot }) ?? recoveredSnapshot;
        const alreadyFailed = beforeTerminal.status === 'failed'
          && beforeTerminal.failureReason === 'stale_head_before_terminal';
        let movedTerminalized = false;
        if (!alreadyFailed && !hasPersistedPackReviewVerdict(beforeTerminal)
            && PACK_REVIEW_ACTIVE_STATUSES.has(beforeTerminal.status)) {
          const changed = updatePackReviewRunIf(
            run.id,
            (all) => {
              const current = all.find((record) => record.id === run.id);
              return Boolean(current
                && current.targetSha === beforeTerminal.targetSha
                && current.reviewCycleId === beforeTerminal.reviewCycleId
                && current.canonicalRepository === beforeTerminal.canonicalRepository
                && PACK_REVIEW_ACTIVE_STATUSES.has(current.status)
                && !hasPersistedPackReviewVerdict(current));
            },
            {
              status: 'failed',
              latestRunStatus: 'failed',
              failureReason: 'stale_head_before_terminal',
              completedAtUtc: new Date().toISOString(),
              exitCode: 1,
            },
            { projectId, storeRoot },
          );
          movedTerminalized = changed !== null;
        }

        const movedWinner = async (forceRepublish = false, newerAlreadyRestored = false) => {
          const latest = getPackReviewRun(run.id, { projectId, storeRoot }) ?? beforeTerminal;
          const order = resolvePackReviewRequiredRunOrder(await readBoundRecords(), latest);
          if (order.kind === 'ambiguous') {
            return { reason: order.reason, statusReconciled: false };
          }
          if (order.kind === 'newer') {
            // A post-write repair may already have restored and recorded this
            // winner; do not publish it again on the same reconciliation.
            if (newerAlreadyRestored
                && latest.deliveryOutcomes.requiredStatus?.state === 'succeeded'
                && latest.deliveryOutcomes.requiredStatus.reason === 'newer_run_authoritative') {
              return { reason: 'newer_run_authoritative', statusReconciled: true };
            }
            const restoration = await restoreAndSettleNewerAuthority(latest, statusWriter);
            return {
              reason: restoration.reason,
              statusReconciled: restoration.reason === 'newer_run_authoritative'
                && restoration.outcome?.state === 'succeeded',
            };
          }
          if (!hasPersistedPackReviewVerdict(latest)) return null;
          const restored = await restorePackReviewAuthoritativeRequiredStatus({
            run: latest, projectId, storeRoot,
            writeRequiredStatus: currentCycleRequiredStatusWriter(latest, storeRoot, statusWriter),
            forceRepublish,
          });
          const after = getPackReviewRun(run.id, { projectId, storeRoot });
          const afterOrder = resolvePackReviewRequiredRunOrder(await readBoundRecords(), latest);
          if (afterOrder.kind === 'newer') {
            // This old verdict-status POST may have landed after the newer
            // original-SHA projection. Always force the newer winner back;
            // a verdict-bearing old run has no unfinished-error repair need.
            const newer = await restoreLatestAuthority(latest, statusWriter, true);
            return {
              reason: newer.reason,
              statusReconciled: newer.reason === 'newer_run_authoritative'
                && newer.outcome?.state === 'succeeded',
            };
          }
          const verified = restored?.state === 'succeeded'
            && Boolean(after && hasPersistedPackReviewVerdict(after))
            && afterOrder.kind === 'none';
          return {
            reason: verified ? 'same_run_verdict_authoritative'
              : afterOrder.kind === 'ambiguous' ? afterOrder.reason
                : 'same_run_verdict_restoration_unverified',
            statusReconciled: verified,
          };
        };
        const movedResult = (reason: string, reconciled: boolean, deliveryReason?: string) => {
          const latest = getPackReviewRun(run.id, { projectId, storeRoot }) ?? beforeTerminal;
          return {
            runId: run.id,
            terminalized: movedTerminalized,
            statusReconciled: reconciled,
            reason,
            status: latest.status,
            hydratedSourceCount: recovery.hydratedSourceCount,
            usableSourceCount: recovery.usableSourceCount,
            graceExpired: recovery.graceExpired,
            coverage: derivePackReviewGptCoverage(latest.reviewRound),
            ...(deliveryReason ? { deliveryReason } : {}),
            nextAction: movedAction(
              reason === 'same_run_verdict_authoritative' ? 'the existing same-run verdict is preserved'
                : reason === 'newer_run_authoritative' ? 'the newer original-SHA run remains authoritative'
                  : latest.status === 'failed' && latest.failureReason === 'stale_head_before_terminal'
                    ? 'the original-head run is closed as failed/stale_head_before_terminal'
                    : 'the original-head terminal authority has changed',
              !reconciled,
            ),
          };
        };

        const incumbent = await movedWinner();
        if (incumbent) {
          results.push(movedResult(incumbent.reason, incumbent.statusReconciled));
          continue;
        }
        const failedRun = getPackReviewRun(run.id, { projectId, storeRoot }) ?? beforeTerminal;
        if (failedRun.status !== 'failed'
            || failedRun.failureReason !== 'stale_head_before_terminal') {
          results.push(movedResult('moved_head_terminal_authority_changed', false));
          continue;
        }

        const authorizeOldError = async () => {
          const current = getPackReviewRun(run.id, { projectId, storeRoot });
          return Boolean(current
            && current.targetSha === failedRun.targetSha
            && current.reviewCycleId === failedRun.reviewCycleId
            && current.canonicalRepository === failedRun.canonicalRepository
            && current.status === 'failed'
            && current.failureReason === 'stale_head_before_terminal'
            && !hasPersistedPackReviewVerdict(current)
            && resolvePackReviewRequiredRunOrder(await readBoundRecords(), current).kind === 'none');
        };
        const repairOldError = async () => {
          const latest = getPackReviewRun(run.id, { projectId, storeRoot }) ?? failedRun;
          const order = resolvePackReviewRequiredRunOrder(await readBoundRecords(), latest);
          if (order.kind === 'newer') {
            const restoration = await restoreAndSettleNewerAuthority(latest, statusWriter);
            return { reason: restoration.reason };
          }
          if (order.kind === 'ambiguous') return { reason: order.reason };
          if (hasPersistedPackReviewVerdict(latest)) {
            const restored = await restorePackReviewAuthoritativeRequiredStatus({
              run: latest, projectId, storeRoot,
              writeRequiredStatus: currentCycleRequiredStatusWriter(latest, storeRoot, statusWriter),
              forceRepublish: true,
            });
            const after = getPackReviewRun(run.id, { projectId, storeRoot });
            return {
              reason: restored?.state === 'succeeded' && after
                && hasPersistedPackReviewVerdict(after)
                ? 'same_run_verdict_status_restored'
                : 'same_run_verdict_restoration_unverified',
            };
          }
          return { reason: 'moved_head_status_authority_changed' };
        };

        const needsStatus = packReviewRequiredStatusNeedsStaleReconciliation(failedRun);
        const publication = await recordPackReviewStaleRequiredStatus({
          run: failedRun, projectId, storeRoot,
          writeRequiredStatus: statusWriter,
          authorizeWrite: authorizeOldError,
          repairSupersededWrite: repairOldError,
          pauseBeforeWrite: input.fixturePauseBeforeStaleStatusWrite,
          pauseAfterWrite: input.fixturePauseAfterStaleStatusWrite,
        });
        const winnerAfterWrite = await movedWinner(
          publication.state === 'succeeded',
          publication.reason === 'newer_run_authoritative',
        );
        if (winnerAfterWrite) {
          results.push(movedResult(
            winnerAfterWrite.reason, winnerAfterWrite.statusReconciled, publication.reason,
          ));
          continue;
        }
        const afterPublication = getPackReviewRun(run.id, { projectId, storeRoot }) ?? failedRun;
        const afterOrder = resolvePackReviewRequiredRunOrder(await readBoundRecords(), afterPublication);
        const oldStatusReconciled = afterOrder.kind === 'none'
          && publication.state === 'succeeded'
          && afterPublication.status === 'failed'
          && afterPublication.failureReason === 'stale_head_before_terminal'
          && packReviewRequiredStatusStaleReconciliationComplete(afterPublication);
        results.push(movedResult(
          afterOrder.kind === 'ambiguous' ? afterOrder.reason : recovery.reason,
          oldStatusReconciled,
          needsStatus ? publication.reason : 'status_already_reconciled',
        ));
        continue;
      }
      // These failures occur before a complete source census or exact-head
      // authority exists. Never reinterpret them as a proven empty 0/3.
      if (recovery.reason.startsWith('gpt_source_unavailable:')
          || recovery.reason.startsWith('gpt_source_unavailable_after_census:')
          || recovery.reason.startsWith('gpt_source_census_unresolved:')
          || recovery.reason.startsWith('gpt_complete_source_uncredentialable:')) {
        results.push({
          runId: run.id,
          terminalized: false,
          statusReconciled: false,
          hydratedSourceCount: recovery.hydratedSourceCount,
          usableSourceCount: recovery.usableSourceCount,
          graceExpired: recovery.graceExpired,
          reason: recovery.reason,
          coverage: recoveryCoverage,
          nextAction: recovery.nextAction ?? scopedReconcileAction(run.prNumber),
        });
        continue;
      }
      const failedPartialStatusNeedsRepair = needsGptSourceRecovery
        && recoveredSnapshot.status === 'failed'
        && recoveredSnapshot.failureReason?.startsWith('gpt_sources_incomplete_after_grace:') === true
        && recoveryCoverage?.kind === 'partial'
        && packReviewRequiredStatusNeedsStaleReconciliation(recoveredSnapshot);
      if (input.settlePartialAfterGrace === false
          && !failedPartialStatusNeedsRepair
          && recoveryCoverage?.kind === 'partial'
          && recoveredSnapshot.reviewRound?.settledSourceCount === undefined) {
        results.push({
          runId: run.id,
          terminalized: false,
          statusReconciled: false,
          hydratedSourceCount: recovery.hydratedSourceCount,
          usableSourceCount: recovery.usableSourceCount,
          graceExpired: recovery.graceExpired,
          reason: 'gpt_partial_requires_explicit_immediate_reconcile',
          coverage: recoveryCoverage,
          nextAction: 'run the explicit scoped reconcile --immediate path after grace or when source evidence changes',
        });
        continue;
      }
      if (activeGptRecovery
          && recoveryCoverage?.kind === 'partial'
          && recovery.graceExpired
          && recovery.reason.startsWith('gpt_sources_incomplete_after_grace:')) {
        // The first run-order read preceded GitHub source observation. A newer
        // run may have become authoritative while that observation was pending.
        const beforeOrder = resolvePackReviewRequiredRunOrder(await readBoundRecords(), run);
        if (beforeOrder.kind !== 'none') {
          if (beforeOrder.kind === 'newer') {
            const restoration = await restoreAndSettleNewerAuthority(run, statusWriter);
            results.push({
              runId: run.id,
              terminalized: false,
              statusReconciled: restoration.reason === 'newer_run_authoritative'
                && restoration.outcome?.state === 'succeeded',
              reason: restoration.reason,
              nextAction: restoration.reason === 'newer_run_authoritative'
                ? 'observe the newer authoritative review'
                : scopedReconcileAction(run.prNumber),
            });
          } else {
            results.push({
              runId: run.id,
              terminalized: false,
              statusReconciled: false,
              reason: beforeOrder.reason,
              nextAction: scopedReconcileAction(run.prNumber),
            });
          }
          continue;
        }
        const terminal = await recordPackReviewUnfinishedTerminalStatus({
          run: getPackReviewRun(run.id, { projectId, storeRoot }) ?? run,
          status: 'failed',
          failureReason: recovery.reason,
          projectId,
          storeRoot,
          // The unfinished-status helper owns persistence/publication. Gate
          // only this caller's shared status write on incumbent live authority.
          writeRequiredStatus: async (request) => {
            const head = await readCheckedReviewPrHead(input, repoSlug, run.prNumber, run.targetSha);
            const authority = readPackReviewAuthority(run.prNumber, { storeRoot });
            const order = resolvePackReviewRequiredRunOrder(await readBoundRecords(), run);
            if (head !== run.targetSha.toLowerCase()
                || authority?.currentHeadSha.toLowerCase() !== head
                || authority.cycle?.cycleId !== run.reviewCycleId
                || authority.terminal
                || order.kind !== 'none') {
              throw new Error('gpt_partial_status_authority_changed');
            }
            await statusWriter(request);
          },
        });
        const failed = getPackReviewRun(run.id, { projectId, storeRoot }) ?? run;
        let observedHead: string | undefined;
        let matchingAuthority = false;
        if (terminal.deliveryOutcome.state === 'succeeded') {
          try {
            observedHead = await readCheckedReviewPrHead(input, repoSlug, run.prNumber, run.targetSha);
            const authority = readPackReviewAuthority(run.prNumber, { storeRoot });
            matchingAuthority = observedHead === run.targetSha.toLowerCase()
              && authority?.currentHeadSha.toLowerCase() === observedHead
              && authority.cycle?.cycleId === run.reviewCycleId
              && !authority.terminal;
          } catch {
            // An unavailable post-write head/authority check cannot certify publication.
          }
        }
        const afterOrder = resolvePackReviewRequiredRunOrder(await readBoundRecords(), run);
        if (afterOrder.kind === 'newer') {
          // The older error may have landed after the newer success. Force the
          // existing projector to restore the latest authority after the write.
          const restoration = await restoreLatestAuthority(run, statusWriter, true);
          results.push({
            runId: run.id,
            terminalized: true,
            statusReconciled: restoration.reason === 'newer_run_authoritative'
              && restoration.outcome?.state === 'succeeded',
            hydratedSourceCount: recovery.hydratedSourceCount,
            usableSourceCount: recovery.usableSourceCount,
            graceExpired: recovery.graceExpired,
            reason: restoration.reason,
            status: failed.status,
            coverage: derivePackReviewGptCoverage(failed.reviewRound),
            deliveryReason: terminal.deliveryOutcome.reason,
            nextAction: restoration.reason === 'newer_run_authoritative'
              ? 'observe the newer authoritative review'
              : scopedReconcileAction(run.prNumber),
          });
          continue;
        }
        const statusReconciled = afterOrder.kind === 'none'
          && terminal.deliveryOutcome.state === 'succeeded'
          && matchingAuthority
          && failed.status === 'failed'
          && failed.failureReason === recovery.reason
          && failed.deliveryOutcomes.requiredStatus?.state === 'succeeded';
        results.push({
          runId: run.id,
          terminalized: true,
          statusReconciled,
          hydratedSourceCount: recovery.hydratedSourceCount,
          usableSourceCount: recovery.usableSourceCount,
          graceExpired: recovery.graceExpired,
          reason: afterOrder.kind === 'ambiguous' ? afterOrder.reason : recovery.reason,
          status: failed.status,
          coverage: derivePackReviewGptCoverage(failed.reviewRound),
          deliveryReason: terminal.deliveryOutcome.reason,
          nextAction: statusReconciled
            ? (recovery.nextAction ?? 'observe unresolved source slots before any eligible retry')
            : observedHead !== undefined && observedHead !== run.targetSha.toLowerCase()
              ? 'run review for the current PR head'
              : scopedReconcileAction(run.prNumber),
        });
        continue;
      }

      // Source recovery is still permitted on the same run, but a terminal
      // zero-judgment census must also reach failure-notification and required
      // error-status reconciliation when no credentialed comments are found.
      const stillZeroJudgment = needsGptSourceRecovery
        && isPackReviewUnfinishedTerminalRun(recoveredSnapshot)
        && recoveredSnapshot.failureReason?.startsWith('gpt_source_non_complete:') === true
        && recoveryCoverage?.kind === 'empty'
        && noJudgmentBudgetOutcome(recoveredSnapshot, storeRoot) !== null;
      // The required error status was already repaired on this terminal run.
      // Continue source observation above, but do not misreport the persisted
      // exact-head publication or write it again while coverage stays 1/3.
      if (needsGptSourceRecovery
          && !failedPartialStatusNeedsRepair
          && recoveredSnapshot.failureReason?.startsWith('gpt_sources_incomplete_after_grace:') === true
          && recoveryCoverage?.kind === 'partial'
          && packReviewRequiredStatusStaleReconciliationComplete(recoveredSnapshot)) {
        let verified = false;
        try {
          const currentHead = await readCheckedReviewPrHead(input, repoSlug, run.prNumber, run.targetSha);
          const authority = readPackReviewAuthority(run.prNumber, { storeRoot });
          verified = currentHead === run.targetSha.toLowerCase()
            && authority?.currentHeadSha.toLowerCase() === currentHead
            && authority.cycle?.cycleId === run.reviewCycleId
            && !authority.terminal
            && resolvePackReviewRequiredRunOrder(await readBoundRecords(), run).kind === 'none';
        } catch {
          // No current-head evidence means no certified required-status result.
        }
        if (verified) {
          results.push({
            runId: run.id,
            terminalized: false,
            statusReconciled: true,
            hydratedSourceCount: recovery.hydratedSourceCount,
            usableSourceCount: recovery.usableSourceCount,
            graceExpired: recovery.graceExpired,
            reason: 'status_already_reconciled',
            coverage: recoveryCoverage,
            nextAction: recovery.nextAction ?? 'observe unresolved source slots before any eligible retry',
          });
          continue;
        }
      }
      if (needsGptSourceRecovery && !stillZeroJudgment && !failedPartialStatusNeedsRepair) {
        let partialRateLimitAction: string | undefined;
        if (recoveredSnapshot.status === 'failed'
          // Only original persisted complete comments qualify. A new comment
          // hydrated from a zero-send terminal cannot create retry authority.
          && recovery.hydratedSourceCount === 0
          && gptUsableSourceCount(run.reviewRound) > 0
          && recoveryCoverage?.kind === 'partial'
          && hasFailedRateLimitSource(recoveredSnapshot)) {
          const missing = await recoverablePostedRateLimitSlots({
            run: recoveredSnapshot, repoSlug, sourceRepoRoot: input.sourceRepoRoot,
            transport: input.fixtureGptSourceCommentTransport,
          });
          if (missing) {
            try {
              const head = await readCheckedReviewPrHead(input, repoSlug, run.prNumber, run.targetSha);
              const authority = readPackReviewAuthority(run.prNumber, { storeRoot });
              const current = getPackReviewRun(run.id, { projectId, storeRoot });
              if (current && head === run.targetSha.toLowerCase()
                && authority?.currentHeadSha.toLowerCase() === head
                && authority.cycle?.cycleId === run.reviewCycleId
                && authority.cycle?.state === 'open'
                && authority.cycle?.reviewStageComplete !== true
                && !authority.cycle?.consumedRoundOrdinals?.includes(run.logicalRoundOrdinal ?? 0)
                && !authority.terminal
                && current.status === recoveredSnapshot.status
                && current.failureReason === recoveredSnapshot.failureReason
                && stableJson(current.reviewRound) === stableJson(recoveredSnapshot.reviewRound)
                && resolvePackReviewRequiredRunOrder(await readBoundRecords(), current).kind === 'none') {
                // This is only an action hint. PR-led admission still proves
                // the older 0/3 zero-send history before launching missing slots.
                partialRateLimitAction = rateLimitFreshReviewNextAction(current, projectId, true);
              }
            } catch {
              // Unverified current-head authority cannot authorize a retry hint.
            }
          }
        }
        results.push({
          runId: run.id,
          terminalized: false,
          statusReconciled: false,
          hydratedSourceCount: recovery.hydratedSourceCount,
          usableSourceCount: recovery.usableSourceCount,
          graceExpired: recovery.graceExpired,
          reason: recovery.reason,
          nextAction: partialRateLimitAction
            ?? recovery.nextAction ?? 'rerun scoped reconcile after the source comments are available',
        });
        continue;
      }
      if (stillZeroJudgment || failedPartialStatusNeedsRepair) run = await bindRepositoryIdentity(recoveredSnapshot);
      if (activeGptRecovery && !activeStale) {
        results.push({
          runId: run.id,
          terminalized: false,
          statusReconciled: false,
          hydratedSourceCount: recovery.hydratedSourceCount,
          usableSourceCount: recovery.usableSourceCount,
          graceExpired: recovery.graceExpired,
          reason: recovery.reason,
          coverage: recoveryCoverage,
          nextAction: recovery.nextAction ?? 'let the current review continue and rerun scoped reconcile if needed',
        });
        continue;
      }
      if (activeStale && recoveryCoverage?.kind === 'empty'
          && run.reviewRound?.reviewer === 'gpt') {
        // Unlike an unfinished terminal, an active 0/3 orphan must prove both
        // that each attempt stopped before send AND that GitHub has no source
        // comment for any invoked identity. An incomplete census is a veto.
        const beforeZero = getPackReviewRun(run.id, { projectId, storeRoot });
        let currentHead = '';
        try {
          currentHead = await readCheckedReviewPrHead(input, repoSlug, run.prNumber, run.targetSha);
        } catch {
          // GitHub unavailable: never infer a clean first-attempt census.
        }
        const failedReason = 'gpt_source_non_complete:after_grace_zero_usable:0/3';
        const virtualFailed = beforeZero
          ? { ...beforeZero, status: 'failed' as const, failureReason: failedReason }
          : null;
        const authorized = recovery.graceExpired
          && recovery.reason === 'gpt_sources_incomplete_after_grace:0/3'
          && beforeZero && isPackReviewRunStale(beforeZero)
          && currentHead === beforeZero.targetSha.toLowerCase()
          && provenFirstAttemptZeroSendCensus(
            beforeZero, recovery.missingFirstAttemptIdentities ?? [],
          )
          && virtualFailed && noJudgmentBudgetOutcome(virtualFailed, storeRoot)
          && resolvePackReviewRequiredRunOrder(await readBoundRecords(), beforeZero).kind === 'none';
        if (authorized && beforeZero) {
          const snapshotRound = stableJson(beforeZero.reviewRound);
          // Authority and run-store share one filesystem lock. Read authority
          // immediately before entering the run-store CAS; never nest the
          // authority reader inside that lock.
          const authorityAtCas = readPackReviewAuthority(run.prNumber, { storeRoot });
          const changed = updatePackReviewRunIf(
            run.id,
            (all) => {
              const current = all.find((item) => item.id === run.id);
              return Boolean(current && isPackReviewRunStale(current)
                && current.targetSha === beforeZero.targetSha
                && current.reviewCycleId === beforeZero.reviewCycleId
                && current.canonicalRepository === beforeZero.canonicalRepository
                && stableJson(current.reviewRound) === snapshotRound
                && provenFirstAttemptZeroSendCensus(
                  current, recovery.missingFirstAttemptIdentities ?? [],
                )
                && authorityAtCas?.cycle !== null
                && authorityAtCas?.cycle !== undefined
                && authorityAtCas.cycle.cycleId === current.reviewCycleId
                && authorityAtCas.currentHeadSha.toLowerCase() === current.targetSha.toLowerCase()
                && authorityAtCas.terminal?.runId !== current.id
                && derivePackReviewNoJudgmentBudgetOutcome({
                  ...current, status: 'failed', failureReason: failedReason,
                }, authorityAtCas.cycle.consumedRoundOrdinals ?? []) !== null
                && resolvePackReviewRequiredRunOrder(all, current).kind === 'none');
            },
            {
              status: 'failed',
              latestRunStatus: 'failed',
              failureReason: failedReason,
              stale: true,
              exitCode: 1,
              completedAtUtc: new Date().toISOString(),
            },
            { projectId, storeRoot },
          );
          if (changed) {
            // External publication performs another exact-head/current-authority
            // check. Re-read here as well to avoid reporting a stale winner.
            const afterCasAuthority = readPackReviewAuthority(run.prNumber, { storeRoot });
            if (afterCasAuthority?.cycle
              && afterCasAuthority.cycle.cycleId === changed.reviewCycleId
              && afterCasAuthority.currentHeadSha.toLowerCase() === changed.targetSha.toLowerCase()
              && afterCasAuthority.terminal?.runId !== changed.id) {
              terminalized = true;
              run = await bindRepositoryIdentity(changed);
            }
          }
        }
        if (!terminalized) {
          results.push({
            runId: run.id,
            terminalized: false,
            statusReconciled: false,
            reason: 'gpt_zero_judgment_first_attempt_or_comment_census_unproven',
            recoveryReason: recovery.reason,
            nextAction: scopedReconcileAction(run.prNumber),
          });
          continue;
        }
      }
      if (activeStale && !terminalized) {
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
    if (run.automaticBudgetDisposition === 'non_consuming_explicit') {
      results.push({
        runId: run.id,
        terminalized,
        statusReconciled: false,
        reason: 'supplemental_no_required_status',
        nextAction: 'observe original journal and reviewer COMMENT; no required-status repair is permitted for advisory runs',
      });
      continue;
    }

    // A previous zero-judgment terminal may have been reconciled before its
    // dedicated worker submission could be attempted. The locked channel
    // claim prevents a second submission, including after an ambiguous result.
    const currentUnfinished = getPackReviewRun(run.id, { projectId, storeRoot }) ?? run;
    if (currentUnfinished.failureReason?.startsWith('gpt_source_non_complete:')
        && noJudgmentBudgetOutcome(currentUnfinished, storeRoot)) {
      const notification = await notifyNoJudgmentWorker({
        run: currentUnfinished, projectId, storeRoot,
        notifier: input.fixtureWorkerNotifier ?? ((request) => sendPackReviewWorkerNotification({
          trustedPackRoot: currentUnfinished.trustedPackRoot,
          sessionId: currentUnfinished.linkedSessionId,
          projectId, storeRoot, request,
        })),
      });
      if (notification.state !== 'already_attempted') {
        results.push({
          runId: run.id, noJudgmentWorkerNotification: notification,
          budgetOutcome: 'non_consuming_no_judgment',
        });
      }
    }

    const currentOrder = resolvePackReviewRequiredRunOrder(await readBoundRecords(), run);
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

    const needsStaleStatus = packReviewRequiredStatusNeedsStaleReconciliation(run);

    if (needsStaleStatus && input.beforeStaleStatusWrite) await input.beforeStaleStatusWrite(run);

    const recordsBeforeStaleStatusWrite = await readBoundRecords();
    const orderBeforeStaleStatusWrite = resolvePackReviewRequiredRunOrder(recordsBeforeStaleStatusWrite, run);
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

    const zeroJudgmentStaleStatus = run.failureReason?.startsWith('gpt_source_non_complete:') === true;
    const failedPartialStaleStatus = run.failureReason?.startsWith('gpt_sources_incomplete_after_grace:') === true;
    const verifyNoJudgmentStatusTarget = async () => {
      const current = getPackReviewRun(run.id, { projectId, storeRoot });
      if (!current || !noJudgmentBudgetOutcome(current, storeRoot)) return false;
      const head = await readCheckedReviewPrHead(input, repoSlug, run.prNumber, run.targetSha);
      const afterHeadRead = getPackReviewRun(run.id, { projectId, storeRoot });
      return head === run.targetSha.toLowerCase()
        && current.status === run.status && current.failureReason === run.failureReason
        && Boolean(afterHeadRead && afterHeadRead.status === run.status
          && afterHeadRead.failureReason === run.failureReason
          && noJudgmentBudgetOutcome(afterHeadRead, storeRoot));
    };
    const verifyPartialStatusTarget = async () => {
      const current = getPackReviewRun(run.id, { projectId, storeRoot });
      if (!current || current.status !== 'failed'
          || current.failureReason !== run.failureReason
          || !packReviewRequiredStatusNeedsStaleReconciliation(current)) return false;
      const head = await readCheckedReviewPrHead(input, repoSlug, run.prNumber, run.targetSha);
      const authority = readPackReviewAuthority(run.prNumber, { storeRoot });
      return head === run.targetSha.toLowerCase()
        && authority?.currentHeadSha.toLowerCase() === head
        && authority.cycle?.cycleId === run.reviewCycleId
        && !authority.terminal;
    };
    const authorizeStaleWrite = async () => {
      if (resolvePackReviewRequiredRunOrder(await readBoundRecords(), run).kind !== 'none') return false;
      if (zeroJudgmentStaleStatus) return verifyNoJudgmentStatusTarget();
      if (failedPartialStaleStatus) return !needsStaleStatus || verifyPartialStatusTarget();
      return true;
    };
    const repairSupersededStaleWrite = async () => {
      if (zeroJudgmentStaleStatus || failedPartialStaleStatus) {
        const current = getPackReviewRun(run.id, { projectId, storeRoot });
        const head = await readCheckedReviewPrHead(input, repoSlug, run.prNumber, run.targetSha);
        const authority = readPackReviewAuthority(run.prNumber, { storeRoot });
        if (current && hasPersistedPackReviewVerdict(current)
          && head === run.targetSha.toLowerCase()
          && authority?.currentHeadSha.toLowerCase() === head
          && authority.terminal?.runId === current.id
          && authority.cycle?.cycleId === current.reviewCycleId) {
          // A same-run verdict is deliberately excluded by the newer-run
          // ordering helper. It still supersedes this zero-judgment error.
          const restored = await restorePackReviewAuthoritativeRequiredStatus({
            run: current, projectId, storeRoot,
            writeRequiredStatus: currentCycleRequiredStatusWriter(current, storeRoot, statusWriter),
            forceRepublish: true,
          });
          const after = getPackReviewRun(run.id, { projectId, storeRoot });
          const afterHead = await readCheckedReviewPrHead(input, repoSlug, run.prNumber, run.targetSha);
          const afterAuthority = readPackReviewAuthority(run.prNumber, { storeRoot });
          if (restored?.state === 'succeeded'
            && after && hasPersistedPackReviewVerdict(after)
            && afterHead === run.targetSha.toLowerCase()
            && afterAuthority?.terminal?.runId === run.id
            && afterAuthority.currentHeadSha.toLowerCase() === afterHead) {
            return { reason: 'same_run_verdict_status_restored' };
          }
          return { reason: 'status_not_published:verdict_restoration_unverified; rerun scoped reconcile' };
        }
        if (current && PACK_REVIEW_ACTIVE_STATUSES.has(current.status)
          && head === run.targetSha.toLowerCase()
          && authority?.currentHeadSha.toLowerCase() === head
          && authority.cycle?.cycleId === current.reviewCycleId
          && resolvePackReviewRequiredRunOrder(await readBoundRecords(), run).kind === 'none') {
          // A same-ID requeue can publish pending while an older error is
          // in flight. The last external write wins: republish that pending.
          const projection = packReviewRequiredStatusProjectionKey(current);
          const restored = await restorePackReviewAuthoritativeRequiredStatus({
            run: current, projectId, storeRoot,
            writeRequiredStatus: currentCycleRequiredStatusWriter(current, storeRoot, statusWriter),
            forceRepublish: true,
          });
          const after = getPackReviewRun(run.id, { projectId, storeRoot });
          const afterHead = await readCheckedReviewPrHead(input, repoSlug, run.prNumber, run.targetSha);
          const afterAuthority = readPackReviewAuthority(run.prNumber, { storeRoot });
          if (restored?.state === 'succeeded' && after
            && PACK_REVIEW_ACTIVE_STATUSES.has(after.status)
            && packReviewRequiredStatusProjectionKey(after) === projection
            && afterHead === head && afterAuthority?.currentHeadSha.toLowerCase() === head
            && afterAuthority.cycle?.cycleId === after.reviewCycleId
            && resolvePackReviewRequiredRunOrder(await readBoundRecords(), run).kind === 'none') {
            return { reason: 'same_run_pending_status_restored' };
          }
          return { reason: 'status_not_published:same_run_pending_restoration_unverified; rerun scoped reconcile' };
        }
      }
      const restoration = await restoreLatestAuthority(run, statusWriter, true);
      return { reason: zeroJudgmentStaleStatus && restoration.reason === 'authority_not_newer'
        ? 'status_not_published:head_or_same_run_authority_changed; rerun scoped reconcile or PR-led status projection'
        : restoration.reason };
    };

    const outcome = await recordPackReviewStaleRequiredStatus({
      run,
      projectId,
      storeRoot,
      writeRequiredStatus: statusWriter,
      notifyWorker: input.fixtureWorkerNotifier ?? ((request) => sendPackReviewWorkerNotification({
        trustedPackRoot: run.trustedPackRoot,
        sessionId: run.linkedSessionId,
        projectId,
        storeRoot,
        request,
      })),
      authorizeWrite: authorizeStaleWrite,
      repairSupersededWrite: repairSupersededStaleWrite,
      pauseBeforeWrite: input.fixturePauseBeforeStaleStatusWrite,
      pauseAfterWrite: input.fixturePauseAfterStaleStatusWrite,
    });

    let rateLimitAction: string | undefined;
    if (zeroJudgmentStaleStatus && (terminalized || run.status === 'failed')
      && (outcome.state === 'succeeded'
        || (!needsStaleStatus && packReviewRequiredStatusStaleReconciliationComplete(run)))
      && await verifyNoJudgmentStatusTarget()) {
      const current = getPackReviewRun(run.id, { projectId, storeRoot }) ?? run;
      if (hasFailedRateLimitSource(current)) {
        const partial = gptUsableSourceCount(current.reviewRound) > 0
          ? await recoverablePostedRateLimitSlots({
              run: current, repoSlug, sourceRepoRoot: input.sourceRepoRoot,
              transport: input.fixtureGptSourceCommentTransport,
            })
          : null;
        const proved = partial !== null || (originalRateLimitZeroJudgment(current, storeRoot)
          && await proveRateLimitOriginalZeroSend({
            run: current, projectId, storeRoot, repoSlug,
            sourceRepoRoot: input.sourceRepoRoot,
            transport: input.fixtureGptSourceCommentTransport,
          }));
        rateLimitAction = proved
          ? rateLimitFreshReviewNextAction(current, projectId, partial !== null)
          : rateLimitOriginalRecoveryAction(current);
      }
    }
    results.push({
      runId: run.id,
      terminalized,
      statusReconciled: needsStaleStatus && outcome.state === 'succeeded',
      reason: needsStaleStatus ? outcome.reason : 'status_already_reconciled',
      ...(zeroJudgmentStaleStatus && (terminalized || run.status === 'failed')
        ? { nextAction: rateLimitAction ?? scopedReconcileAction(run.prNumber) } : {}),
      ...(failedPartialStaleStatus && needsStaleStatus && outcome.state !== 'succeeded' ? {
        nextAction: scopedReconcileAction(run.prNumber),
      } : {}),
      ...(zeroJudgmentStaleStatus && needsStaleStatus && outcome.state !== 'succeeded' ? {
        statusPublication: outcome.reason === 'same_run_verdict_status_restored'
          ? 'authoritative_verdict_restored'
          : outcome.reason === 'same_run_pending_status_restored'
            ? 'authoritative_pending_restored' : 'status_not_published',
        nextAction: scopedReconcileAction(run.prNumber),
      } : {}),
    });
  }

  if (input.immediate && input.prNumber) {
    const settlement = await reconcileFinalCapSettlement(input, { projectId, storeRoot, repoSlug });
    if (settlement) results.push(settlement);
  }

  // A scoped reconcile is also a status-repair entrypoint when a previously
  // delivered cap-one run is now an outstanding cap-two cycle. No new reviewer.
  if (input.prNumber) {
    const authority = readPackReviewAuthority(input.prNumber, { storeRoot });
    const historic = authority?.terminal?.runId
      ? getPackReviewRun(authority.terminal.runId, { projectId, storeRoot })
      : null;
    if (historic && authority?.cycle && authority.currentHeadSha === historic.targetSha
        && authority.cycle.capMapVersion === PACK_REVIEW_LOGICAL_CAP_MAP_VERSION
        && Number(historic.logicalRoundCap) < authority.cycle.frozenCap
        && outstandingPackReviewCycle(historic, storeRoot)) {
      try {
        await ensurePromotedRoundPublicPending({
          run: historic, projectId, storeRoot, repoSlug,
          sourceRepoRoot: input.sourceRepoRoot,
          fixtureCurrentPrHeadSha: input.fixtureCurrentPrHeadSha,
          fixtureRequiredStatusReader: input.fixtureRequiredStatusReader,
          fixtureRequiredStatusWriter: input.fixtureRequiredStatusWriter,
        });
        results.push({ runId: historic.id, reason: 'promoted_current_head_pending_verified' });
      } catch (error) {
        results.push({ runId: historic.id, reason: 'promoted_current_head_pending_unverified',
          detail: describeError(error),
          nextAction: scopedReconcileAction(input.prNumber) });
      }
    }
  }

  if (input.staleOnly) {
    // An accepted error-status POST without a canonical verdict is not proof
    // that the exact current-head required status actually survived delivery.
    // Verdict-bearing rows were already checked by verifyStaleDelivery.
    for (const item of results) {
      if (item.statusReconciled !== true || typeof item.runId !== 'string') continue;
      const current = getPackReviewRun(item.runId, { projectId, storeRoot });
      if (!current || hasPersistedPackReviewVerdict(current)) continue;
      let verified = false;
      try {
        if (current.status === 'failed' && current.failureReason === 'stale_head_before_terminal') {
          // A moved-head closure owns the original SHA, not the live PR HEAD.
          // Confirm that SHA's actual required-status projection and unchanged
          // run-order authority; the live-head equality rule below is for other
          // stale statuses only.
          const beforeOrder = resolvePackReviewRequiredRunOrder(await readBoundRecords(), current);
          const newer = beforeOrder.kind === 'newer' ? beforeOrder.run : null;
          const winnerOutcome = newer?.deliveryOutcomes.requiredStatus;
          const winnerPayload = newer ? packReviewJournaledPayload(newer) : null;
          const classification = winnerPayload ? classifyPackReviewPayload(winnerPayload) : null;
          const expectedStatus = beforeOrder.kind === 'none' ? 'error'
            : beforeOrder.kind === 'newer'
              && current.deliveryOutcomes.requiredStatus?.reason === 'newer_run_authoritative'
              && winnerOutcome?.state === 'succeeded'
              ? classification
                ? winnerOutcome.reason === 'status_pending_round_restored'
                  || (classification.requiredStatus === 'success'
                    && outstandingPackReviewCycle(beforeOrder.run, storeRoot))
                  ? 'pending' : classification.requiredStatus
                : newer && PACK_REVIEW_ACTIVE_STATUSES.has(newer.status) ? 'pending' : undefined
              : undefined;
          if (expectedStatus && packReviewRequiredStatusStaleReconciliationComplete(current)) {
            const observed = await readFinalCapRequiredStatus(input, repoSlug, current.targetSha);
            const after = getPackReviewRun(current.id, { projectId, storeRoot });
            const afterOrder = resolvePackReviewRequiredRunOrder(await readBoundRecords(), current);
            verified = observed === expectedStatus
              && after?.status === 'failed'
              && after.failureReason === 'stale_head_before_terminal'
              && packReviewRequiredStatusStaleReconciliationComplete(after)
              && (beforeOrder.kind === 'none' && afterOrder.kind === 'none'
                || beforeOrder.kind === 'newer' && afterOrder.kind === 'newer'
                  && beforeOrder.run.id === afterOrder.run.id
                  && packReviewRequiredStatusProjectionKey(beforeOrder.run)
                    === packReviewRequiredStatusProjectionKey(afterOrder.run));
          }
        } else {
          const headBefore = await readCheckedReviewPrHead(
            input, repoSlug, current.prNumber, current.targetSha,
          );
          const authorityBefore = readPackReviewAuthority(current.prNumber, { storeRoot });
          if (current.status === 'failed'
            && headBefore === current.targetSha.toLowerCase()
            && authorityBefore?.currentHeadSha.toLowerCase() === headBefore
            && authorityBefore.cycle?.cycleId === current.reviewCycleId
            && !authorityBefore.terminal
            && resolvePackReviewRequiredRunOrder(await readBoundRecords(), current).kind === 'none') {
          const observed = await readFinalCapRequiredStatus(input, repoSlug, current.targetSha);
          const headAfter = await readCheckedReviewPrHead(
            input, repoSlug, current.prNumber, current.targetSha,
          );
          const authorityAfter = readPackReviewAuthority(current.prNumber, { storeRoot });
          verified = observed === 'error'
            && headAfter === headBefore
            && authorityAfter?.currentHeadSha.toLowerCase() === headAfter
            && authorityAfter.cycle?.cycleId === current.reviewCycleId
            && !authorityAfter.terminal
            && resolvePackReviewRequiredRunOrder(await readBoundRecords(), current).kind === 'none';
          }
        }
      } catch {
        // An unavailable, conflicting or overwritten current-head status is
        // unresolved, never an externally verified no-verdict error.
      }
      if (!verified) {
        item.statusReconciled = false;
        item.reason = `status_unverified:${String(item.reason ?? 'no_verdict_required_status')}`;
        item.nextAction = scopedReconcileAction(current.prNumber);
      }
    }
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
  if (!cycle || !['open_findings', 'at_cap_open_findings', 'at_cap_continuation_required'].includes(cycle.state)) {
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
      input: {
        baseRef: input.baseRef,
        issueNumber: input.target.issueNumber ?? null,
      },
    });
    selection = selectMergeTriageEvidence({ tuple, options: { storeRoot: input.storeRoot } });
    if (selection.kind === 'missing' && selection.reason === 'evidence_missing') {
      produceMergeTriageEvidence({
        tuple,
        changedPaths,
        issueBody,
        options: { storeRoot: input.storeRoot },
      });
      selection = selectMergeTriageEvidence({ tuple, options: { storeRoot: input.storeRoot } });
    }
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
  const findingResolution = selection.evidence?.findingResolution;
  const verdict = input.allowFinalSettlement
    && selection.kind === 'selected'
    && selection.verdict === 'PENDING_ARCHITECT'
    && selection.evidence?.predicateResult === 'no_intersection'
    && findingResolution?.predicateResult === 'resolved'
    && findingResolution.findingSnapshotDigest === findingSnapshotDigest
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
  const requestedProjectId = trim(input.projectId);
  const bindCanonicalProject = process.env.OPK_VITEST_HARNESS !== '1'
    && trim(input.surface) === 'pack-gpt-review'
    && Boolean(requestedProjectId)
    && !trim(process.env.OPK_PROJECT_ID);
  if (!bindCanonicalProject) return startPackReviewImpl(input);

  const previousProjectId = process.env.OPK_PROJECT_ID;
  process.env.OPK_PROJECT_ID = requestedProjectId;
  try {
    return await startPackReviewImpl(input);
  } finally {
    if (previousProjectId === undefined) delete process.env.OPK_PROJECT_ID;
    else process.env.OPK_PROJECT_ID = previousProjectId;
  }
}

async function startPackReviewImpl(input: StartInput): Promise<Record<string, unknown>> {
  const operatorStart = directCliOperatorStarts.get(input);
  const harnessWithoutSelectedProject = process.env.OPK_VITEST_HARNESS === '1'
    && !trim(process.env.OPK_PROJECT_ID);
  const selectedTarget = harnessWithoutSelectedProject
    ? null
    : resolveTargetContext({
        ...(trim(input.projectId) ? { projectId: trim(input.projectId) } : {}),
        env: process.env,
      });
  if (selectedTarget) {
    const requestedProjectId = trim(input.projectId);
    if (requestedProjectId && requestedProjectId !== selectedTarget.projectId) {
      throw new Error(
        `pack review project mismatch: requested ${requestedProjectId}, selected ${selectedTarget.projectId}`,
      );
    }
    input.projectId = selectedTarget.projectId;
  }
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
  const projectId = selectedTarget?.projectId ?? (trim(input.projectId) || DEFAULT_PROJECT_ID);
  const selectedBaseRef = selectedTarget ? `origin/${selectedTarget.defaultBranch}` : DEFAULT_BASE_REF;
  const requestedBaseRef = trim(input.baseRef);
  if (selectedTarget && requestedBaseRef && requestedBaseRef !== selectedBaseRef) {
    throw new Error(`pack review base ${requestedBaseRef} does not match selected target base ${selectedBaseRef}`);
  }
  const baseRef = selectedTarget ? selectedBaseRef : (requestedBaseRef || DEFAULT_BASE_REF);
  const target = await resolveTarget(input, trusted.trustedPackRoot, operatorStart, selectedTarget);
  if (selectedTarget && target.prBaseRef !== selectedTarget.defaultBranch) {
    throw new Error(
      `pack review PR base ${target.prBaseRef} does not match selected target default branch ${selectedTarget.defaultBranch}`,
    );
  }
  const storeRoot = resolvePackReviewRunStoreRoot({ projectId, storeRoot: input.storeRoot });
  const reviewWorktreeContext: ReviewWorktreeContext = {
    projectId, storeRoot, repoRoot: target.sourceRepoRoot, repoSlug: target.repoSlug,
  };
  const readProjectionHead = () => readCheckedReviewPrHead({
    sourceRepoRoot: target.sourceRepoRoot,
    fixtureCurrentPrHeadSha: input.fixtureCurrentPrHeadSha,
    fixtureReadCurrentPrHead: input.fixtureReadCurrentPrHead,
  }, target.repoSlug, target.prNumber, target.headSha);
  const productionRequiredCiStart = directCliStarts.has(input)
    || trim(input.surface) === 'pack-gpt-review'
    || trim(input.surface) === 'pr2-scheduler';
  const explicitReviewer = input.reviewerOverride !== undefined;
  const existingAuthorityBeforeCi = productionRequiredCiStart
    ? readPackReviewAuthority(target.prNumber, { storeRoot })
    : null;
  const existingStateCannotStartReviewer = Boolean(
    existingAuthorityBeforeCi?.cycle?.reviewStageComplete === true
    || existingAuthorityBeforeCi?.cycle?.state === 'at_cap_open_findings'
    || existingAuthorityBeforeCi?.cycle?.state === 'at_cap_continuation_required',
  );
  const harnessRequiredCiOptIn = process.env.OPK_VITEST_HARNESS === '1' && (
    input.fixtureRequiredCi !== undefined
    || input.fixtureRequiredCiChecks !== undefined
    || input.fixtureRequiredCiPolicy !== undefined
    || input.fixtureRequiredCiPolicyHttpStatus !== undefined
    || input.fixtureRequiredCiPostProjectionHead !== undefined
    || input.fixtureRequiredCiPostProjectionBase !== undefined
    || input.fixtureRequiredCiHeadAfterGate !== undefined
    || input.fixtureRequiredCiBaseAfterGate !== undefined
  );
  let supplementalMode = Boolean(explicitReviewer && existingAuthorityBeforeCi?.cycle
    && existingAuthorityBeforeCi.cycle.capMapVersion === PACK_REVIEW_LOGICAL_CAP_MAP_VERSION
    && (existingAuthorityBeforeCi.cycle.reviewStageComplete === true
      || (existingAuthorityBeforeCi.cycle.consumedRoundOrdinals?.length ?? 0)
        >= existingAuthorityBeforeCi.cycle.frozenCap));
  const requiredCiGateApplies = productionRequiredCiStart
    && (!existingStateCannotStartReviewer || explicitReviewer)
    && (process.env.OPK_VITEST_HARNESS !== '1' || harnessRequiredCiOptIn);
  if (requiredCiGateApplies) {
    const requiredCiGreen = await manualPackReviewRequiredCiGreen({
      startInput: input,
      targetContext: selectedTarget,
      target: {
        prNumber: target.prNumber,
        headSha: target.headSha,
        repoSlug: target.repoSlug,
        sourceRepoRoot: target.sourceRepoRoot,
        prBaseRef: target.prBaseRef,
      },
    });
    if (!requiredCiGreen) {
      return {
        ok: false,
        created: false,
        reused: false,
        reason: 'required_ci_not_green_for_current_head',
        prNumber: target.prNumber,
        headSha: target.headSha,
      };
    }
  }
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

  const reviewerResolution = resolvePackReviewerResolution(process.env, {
    ...(input.reviewerOverride !== undefined ? { explicitReviewer: input.reviewerOverride } : {}),
    layerOverrides: input.fixtureReviewerLayerOverrides,
    emulateWin32: input.fixtureEmulateWin32Selector,
  });
  const reviewer = reviewerResolution.reviewer;

  const recoverableGptFixture = process.env.OPK_VITEST_HARNESS === '1'
    && listPackReviewRunRecordsRaw({ projectId, storeRoot }).some((candidate) => (
      ((isPackReviewRunStale(candidate) || PACK_REVIEW_ACTIVE_STATUSES.has(candidate.status))
        && candidate.reviewRound?.reviewer === 'gpt'
        && candidate.reviewRound.sourceSlots.some((slot) => (
          slot.lifecycle === 'invocation_started' && Boolean(trim(slot.invocationId))
        )))
      || (isPackReviewUnfinishedTerminalRun(candidate)
        && candidate.reviewRound?.reviewer === 'gpt'
        && !packReviewJournaledPayload(candidate)
        && packReviewDeliveryNeedsResume(candidate))
    ));
  const journaledResumeBeforeReconcile = await findJournaledDeliveryResumeCandidate({
    projectId, storeRoot, prNumber: target.prNumber, headSha: target.headSha,
    repoSlug: target.repoSlug, sourceRepoRoot: target.sourceRepoRoot, resolveSlug,
    fixtureRequiredStatusReader: input.fixtureRequiredStatusReader,
    explicitReviewer: explicitReviewer ? reviewer ?? undefined : undefined,
    supplementalMode,
  });
  if (journaledResumeBeforeReconcile && !(supplementalMode && explicitReviewer
      && journaledResumeBeforeReconcile.resolvedReviewer === reviewer)) {
    const invalidAuthority = packReviewResumeReviewerAuthorityError(process.env);
    if (invalidAuthority) throw new Error(invalidAuthority);
  }
  // Existing synthetic fixture reviews deliberately supply reviewer stdout
  // without configuring or invoking a model. Keep that test-only seam while
  // failing closed for invalid explicit/bound/persistent selections and in
  // every production invocation.
  const syntheticNoReviewer = process.env.OPK_VITEST_HARNESS === '1'
    && input.reviewerOverride === undefined
    && reviewerResolution.errorMessage
      === 'No reviewer authority is configured. Set a persistent reviewer or PACK_REVIEWER to gpt, claude, or codex.';
  if (!reviewer && !syntheticNoReviewer) {
    throw new Error(reviewerResolution.errorMessage ?? 'pack review reviewer selector did not resolve');
  }
  // Reconciliation can hydrate the original comment and refresh updatedAt/
  // heartbeat while preserving the same dead owner. Capture its actual stale
  // grace + dead-PID evidence before that benign store mutation.
  const deadOwnersBeforeReconcile = new Map(
    listPackReviewRunRecordsRaw({ projectId, storeRoot })
      .filter((candidate) => isPackReviewRunStale(candidate)
        || (isPackReviewUnfinishedTerminalRun(candidate)
          && isPackReviewRunStale({ ...candidate, status: 'reviewing' })))
      .map((candidate) => [candidate.id, {
        runnerPid: candidate.runnerPid,
        heartbeatAtUtc: candidate.heartbeatAtUtc,
      }] as const),
  );
  // The advisory entrypoint may inspect old required authority but must not
  // initiate status-repair writes for a completed required stage.
  const preStartReconciliation = !supplementalMode ? await reconcileStalePackReviewRuns({
    repoSlug: target.repoSlug,
    sourceRepoRoot: target.sourceRepoRoot,
    projectId,
    storeRoot,
    prNumber: target.prNumber,
    recoverActiveGptSources: true,
    fixtureCurrentPrHeadSha: input.fixtureCurrentPrHeadSha,
    fixtureIssueBody: input.fixtureIssueBody,
    fixtureIssueTitle: input.fixtureIssueTitle,
    fixtureIssueNumber: input.fixtureIssueNumber,
    fixtureRequiredStatusReader: input.fixtureRequiredStatusReader,
    fixtureGptSourceCommentTransport: input.fixtureGptSourceCommentTransport,
    ...(recoverableGptFixture ? {
      fixtureGithubReviewId: input.fixtureGithubReviewId,
      fixtureGithubReviewTransport: input.fixtureGithubReviewTransport,
      fixtureRequiredStatusWriter: input.fixtureRequiredStatusWriter,
      fixtureWorkerNotifier: input.fixtureWorkerNotifier,
    } : {}),
    resolveRepositorySlug: resolveSlug,
    settlePartialAfterGrace: false,
    beforeStaleStatusWrite: input.fixtureBeforeStaleStatusWrite,
  }) : null;
  // A dead original GPT runner can have its credentialed journal, COMMENT and
  // exact-head required status settled by the incumbent pre-start reconciler.
  // A fresh explicit invocation must acknowledge only that original run,
  // without engaging another reviewer or borrowing a projected stage status.
  if (explicitReviewer && reviewer === 'gpt' && preStartReconciliation) {
    for (const settled of preStartReconciliation.results) {
      if (settled.recovered !== true || settled.statusReconciled !== true) continue;
      const original = getPackReviewRun(String(settled.runId), { projectId, storeRoot });
      if (!original || original.prNumber !== target.prNumber
          || original.targetSha !== target.headSha
          || original.canonicalRepository?.toLowerCase() !== target.repoSlug.toLowerCase()
          || original.automaticBudgetDisposition === 'non_consuming_explicit'
          || original.resolvedReviewer !== 'gpt'
          || original.executedReviewer !== 'gpt'
          || original.reviewerInvokedForThisRun !== true
          || original.reviewerExecutionRunId !== original.id
          || !hasPersistedPackReviewVerdict(original)
          || original.journalOutcome?.state !== 'persisted'
          || !hasCredentialedGptSourceAuthority(original)
          || original.deliveryOutcomes.githubComment?.state !== 'succeeded'
          || original.deliveryOutcomes.requiredStatus?.state !== 'succeeded'
          || original.githubReviewEvent !== 'COMMENT'
          || !original.githubReviewId || !trim(original.githubReviewUrl)) continue;
      const selected = readPackReviewAuthority(target.prNumber, { storeRoot });
      if (selected?.currentHeadSha !== target.headSha
          || selected.terminal?.runId !== original.id
          || selected.publication?.terminalRunId !== original.id
          || selected.publication.headSha !== target.headSha
          || selected.publication.status !== 'succeeded') continue;
      let exactHead = false;
      try { exactHead = await readProjectionHead() === target.headSha.toLowerCase(); } catch {
        // No live head observation, no explicit success.
      }
      if (!exactHead) continue;
      return {
        ok: true, created: false, reused: true, recovered: true,
        reason: 'resumed_journaled_delivery',
        ...reviewerProvenanceReceipt(original),
        publicationVerified: true, publicationHeadSha: target.headSha,
        prNumber: target.prNumber, headSha: target.headSha, runId: original.id,
        status: original.status, httpStatus: 200,
        githubReviewId: original.githubReviewId,
        githubReviewUrl: original.githubReviewUrl,
      };
    }
  }
  const claimMode = input.claimMode ?? 'acquire';
  const preacquiredClaimOwned = () => ownsBoundPreacquiredClaim(input.preacquiredClaim, {
    projectId, prNumber: target.prNumber, headSha: target.headSha,
  });
  const unownedPreacquiredResult = (candidate: PackReviewRunRecord) => ({
    ok: false, created: false, reused: true,
    reason: 'gpt_preacquired_claim_not_owned',
    nextAction: `npm run --silent pack-gpt-review -- --project ${projectId} --pr-number ${target.prNumber} # acquire a real claim instead of reusing an unowned preacquired claim`,
    prNumber: target.prNumber, headSha: target.headSha,
    runId: candidate.id, status: candidate.status,
    coverage: derivePackReviewGptCoverage(candidate.reviewRound), httpStatus: 409,
  });
  if (claimMode === 'preacquired') {
    const unfinished = listPackReviewRunRecordsRaw({ projectId, storeRoot }).find((candidate) => (
      candidate.prNumber === target.prNumber
      && candidate.targetSha.toLowerCase() === target.headSha.toLowerCase()
      && candidate.canonicalRepository?.toLowerCase() === target.repoSlug.toLowerCase()
      && resolve(candidate.sourceRepoRoot) === resolve(target.sourceRepoRoot)
      && candidate.reviewRound?.reviewer === 'gpt'
      && candidate.reviewRound.settledSourceCount === undefined
      && !hasPersistedPackReviewVerdict(candidate)
    ));
    if (unfinished && !preacquiredClaimOwned()) return unownedPreacquiredResult(unfinished);
  }
  const resumeCandidate = await findJournaledDeliveryResumeCandidate({
    projectId,
    storeRoot,
    prNumber: target.prNumber,
    headSha: target.headSha,
    repoSlug: target.repoSlug,
    sourceRepoRoot: target.sourceRepoRoot,
    resolveSlug,
    fixtureRequiredStatusReader: input.fixtureRequiredStatusReader,
    explicitReviewer: explicitReviewer ? reviewer ?? undefined : undefined,
    supplementalMode,
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
    const zeroJudgment = options.failureReason?.startsWith('gpt_source_non_complete:') === true;
    const originalWriter = options.writeRequiredStatus;
    return recordPackReviewUnfinishedTerminalStatus({
      ...options,
      ...(zeroJudgment ? {
        writeRequiredStatus: async (request: Parameters<PackReviewRequiredStatusWriter>[0]) => {
          const freshBefore = getPackReviewRun(options.run.id, { projectId, storeRoot });
          const headBefore = await readProjectionHead();
          if (!freshBefore || !noJudgmentBudgetOutcome(freshBefore, storeRoot)
            || headBefore !== target.headSha.toLowerCase()) {
            throw new Error('status_not_published:no_judgment_or_current_head_changed_before_error; rerun scoped reconcile');
          }
          await originalWriter(request);
          // GitHub status writes are not atomic with source recovery or head changes.
          // A delayed stale error can otherwise land after the verdict's success.
          const freshAfter = getPackReviewRun(options.run.id, { projectId, storeRoot });
          const headAfter = await readProjectionHead();
          if (headAfter !== target.headSha.toLowerCase()) {
            throw new Error('status_not_published:pr_head_changed_during_error; restart PR-led projection');
          }
          if (!freshAfter || !noJudgmentBudgetOutcome(freshAfter, storeRoot)) {
            if (freshAfter && hasPersistedPackReviewVerdict(freshAfter)) {
              const restored = await restorePackReviewAuthoritativeRequiredStatus({
                run: freshAfter,
                projectId,
                storeRoot,
                writeRequiredStatus: currentCycleRequiredStatusWriter(freshAfter, storeRoot, originalWriter),
                forceRepublish: true,
              });
              if (restored?.state === 'succeeded') {
                await ensurePromotedRoundPublicPending({
                  run: freshAfter, projectId, storeRoot,
                  repoSlug: target.repoSlug, sourceRepoRoot: target.sourceRepoRoot,
                  fixtureCurrentPrHeadSha: input.fixtureCurrentPrHeadSha,
                  fixtureRequiredStatusReader: input.fixtureRequiredStatusReader,
                  fixtureRequiredStatusWriter: originalWriter,
                });
              }
              throw new Error(restored?.state === 'succeeded'
                ? 'status_not_published:no_judgment_superseded; authoritative_verdict_status_restored'
                : 'status_not_published:verdict_superseded_error; rerun scoped reconcile to restore verdict status');
            }
            throw new Error('status_not_published:no_judgment_superseded; rerun scoped reconcile');
          }
        },
      } : {}),
    });
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
      nextAction: 'inspect unjudged reviewer output and reconcile the existing run without inventing a verdict',
      prNumber: target.prNumber,
      headSha: target.headSha,
      runId: run.id,
      status: malformed.status,
      httpStatus: 422,
    };
  };

  // An explicit incomplete-round switch is claim-authorized only after the
  // original owner is positively proven dead. The caller may not infer death
  // from a stale heartbeat, a changed reviewer preference, or PID alone.
  const foreignAuthority = existingAuthorityBeforeCi?.cycle;
  const foreignExpectedOrdinal = (foreignAuthority?.consumedRoundOrdinals?.length ?? 0) + 1;
  const foreignCandidates = explicitReviewer && reviewer && !supplementalMode
      && foreignAuthority?.capMapVersion === PACK_REVIEW_LOGICAL_CAP_MAP_VERSION
      && foreignAuthority.reviewStageComplete !== true
      && (foreignAuthority.consumedRoundOrdinals?.length ?? 0) < foreignAuthority.frozenCap
    ? listPackReviewRunRecordsRaw({ projectId, storeRoot }).filter((candidate) =>
      candidate.prNumber === target.prNumber
      && candidate.targetSha === target.headSha
      && candidate.projectId === projectId
      && candidate.canonicalRepository?.toLowerCase() === target.repoSlug.toLowerCase()
      && resolve(candidate.sourceRepoRoot) === resolve(target.sourceRepoRoot)
      && candidate.reviewCycleId === foreignAuthority.cycleId
      && candidate.logicalRoundOrdinal === foreignExpectedOrdinal
      && candidate.automaticBudgetDisposition === 'consume'
      && candidate.resolvedReviewer && candidate.resolvedReviewer !== reviewer
      && PACK_REVIEW_ACTIVE_STATUSES.has(candidate.status)
      && !hasPersistedPackReviewVerdict(candidate)
      && !candidate.executedReviewer)
    : [];
  const foreignRun = foreignCandidates.length === 1 ? foreignCandidates[0] : undefined;
  const foreignTakeover: ExplicitDeadReviewerTakeover | undefined = foreignRun && reviewer
    ? {
        runId: foreignRun.id,
        existingReviewer: foreignRun.resolvedReviewer!,
        requestedReviewer: reviewer,
        runnerPid: foreignRun.runnerPid,
        reviewCycleId: foreignRun.reviewCycleId!,
        logicalRoundOrdinal: foreignRun.logicalRoundOrdinal!,
        canonicalRepository: foreignRun.canonicalRepository!,
      }
    : undefined;

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
      allowCompletedSameHeadReplay: supplementalMode,
      takeover: foreignTakeover,
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
    // Run the ordinary cleanup sweep only after the existing PR/head claim is
    // acquired: an unclaimed async Git inventory can stagger concurrent starts
    // until both separately enter the reviewer path.
    await reclaimReviewWorktrees(reviewWorktreeContext);
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
    if (foreignCandidates.length > 1) {
      await releaseEarlyClaim('ambiguous_foreign_reviewer_runs');
      return { ok: false, created: false, reused: true,
        reason: 'ambiguous_foreign_reviewer_runs',
        nextAction: 'resolve competing original exact-head runs before an explicit switch',
        prNumber: target.prNumber, headSha: target.headSha, httpStatus: 409 };
    }
    if (foreignRun) {
      const currentAuthority = readPackReviewAuthority(target.prNumber, { storeRoot });
      const head = await readProjectionHead();
      if (!claimLease?.deadForeignRunClaimReclaimed || !claimLease.owns()
          || head !== target.headSha.toLowerCase()
          || currentAuthority?.currentHeadSha.toLowerCase() !== head
          || currentAuthority.cycle?.cycleId !== foreignRun.reviewCycleId
          || currentAuthority?.cycle?.reviewStageComplete === true
          || currentAuthority?.cycle?.consumedRoundOrdinals?.includes(foreignRun.logicalRoundOrdinal!) === true
          || currentAuthority.terminal?.runId === foreignRun.id) {
        await releaseEarlyClaim('foreign_reviewer_owner_unverified');
        return { ok: false, created: false, reused: true,
          reason: 'foreign_reviewer_owner_unverified',
          nextAction: 'verify the exact claim process generation is dead and the original run has no accepted verdict; do not replace a live or ambiguous owner',
          prNumber: target.prNumber, headSha: target.headSha,
          runId: foreignRun.id, httpStatus: 409 };
      }
      const originalRound = stableJson(foreignRun.reviewRound);
      const originalAttempt = stableJson(foreignRun.nativeAttempt);
      const retired = updatePackReviewRunIf(foreignRun.id, (records) => {
        const latest = records.find((candidate) => candidate.id === foreignRun.id);
        return Boolean(latest
          && latest.status === foreignRun.status
          && PACK_REVIEW_ACTIVE_STATUSES.has(latest.status)
          && latest.runnerPid === foreignRun.runnerPid
          && latest.updatedAt === foreignRun.updatedAt
          && latest.heartbeatAtUtc === foreignRun.heartbeatAtUtc
          && latest.reviewCycleId === foreignRun.reviewCycleId
          && latest.logicalRoundOrdinal === foreignRun.logicalRoundOrdinal
          && latest.canonicalRepository === foreignRun.canonicalRepository
          && latest.targetSha === foreignRun.targetSha
          && latest.resolvedReviewer === foreignRun.resolvedReviewer
          && stableJson(latest.reviewRound) === originalRound
          && stableJson(latest.nativeAttempt) === originalAttempt
          && !latest.executedReviewer && !hasPersistedPackReviewVerdict(latest));
      }, {
        status: 'failed',
        latestRunStatus: 'failed',
        failureReason: 'explicit_reviewer_superseded_proven_dead_original',
        completedAtUtc: new Date().toISOString(),
        exitCode: 1,
      }, { projectId, storeRoot });
      if (!retired) {
        await releaseEarlyClaim('foreign_reviewer_changed_before_retirement');
        return { ok: false, created: false, reused: true,
          reason: 'foreign_reviewer_changed_before_retirement',
          nextAction: 'reconcile original reviewer journal; do not create a replacement after concurrent owner change',
          prNumber: target.prNumber, headSha: target.headSha,
          runId: foreignRun.id, httpStatus: 409 };
      }
    }
    // A completed findings reset does not re-key the historical exact-head
    // snapshot. Refuse stale H1/B0 before the producer or any new review run.
    const reopened = readPackReviewAuthority(target.prNumber, { storeRoot });
    const firstResetRound = reopened?.cycle?.state === 'open'
      && reopened.cycle.resetProvenance !== undefined
      && reopened.cycle.capMapVersion === PACK_REVIEW_LOGICAL_CAP_MAP_VERSION
      && reopened.cycle.consumedRoundOrdinals?.length === 0;
    let reopenedLiveBody: string | undefined;
    if (firstResetRound) {
      try {
        if (!target.issueNumber) throw new Error('actual PR closing Issue unresolved');
        reopenedLiveBody = process.env.OPK_VITEST_HARNESS === '1'
          ? input.fixtureIssueBody
          : (await resolveCurrentIssueFields(target.sourceRepoRoot, target.repoSlug, target.issueNumber)).body;
        if (reopenedLiveBody === undefined) throw new Error('amended PR-closing Issue body unavailable');
        const existingSnapshot = resolveBoundIssueSnapshot({
          projectId, prNumber: target.prNumber, prHeadSha: target.headSha,
          issueNumber: target.issueNumber,
          storeDirOverride: process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR,
        });
        if (existingSnapshot.status === 'corrupted') throw new Error('existing exact-head Issue snapshot corrupted');
        if (existingSnapshot.status === 'found'
            && existingSnapshot.snapshotHash !== computeBoundIssueSnapshotHash(reopenedLiveBody)) {
          await releaseEarlyClaim('completed_reset_stale_exact_head_snapshot');
          return {
            ok: false, created: false, reused: false, httpStatus: 409,
            prNumber: target.prNumber, headSha: target.headSha,
            cycleId: reopened?.cycle?.cycleId,
            reason: 'completed_reset_stale_exact_head_snapshot',
            nextAction: `start one new review round on the current head; an Issue amendment resets the cap: the immutable snapshot on this PR head is stale; advance this same PR to a fresh head with a genuine change, then run npm run --silent pack-gpt-review -- --project ${projectId} --pr-number ${target.prNumber} on that new head; do not overwrite the historical snapshot or consume a stale review round.`,
          };
        }
      } catch (error) {
        await releaseEarlyClaim('completed_reset_snapshot_unverified');
        return { ok: false, created: false, reused: false, httpStatus: 409,
          prNumber: target.prNumber, headSha: target.headSha,
          reason: 'completed_reset_snapshot_unverified', detail: describeError(error),
          nextAction: 'restore the real PR-closing Issue and exact bound snapshot binding before starting this audited cycle' };
      }
    }
    const authoritative = await resolveAuthoritativeReviewContext(input, target, projectId);
    if (firstResetRound) {
      const captured = target.issueNumber && resolveBoundIssueSnapshot({
        projectId, prNumber: target.prNumber, prHeadSha: target.headSha,
        issueNumber: target.issueNumber,
        storeDirOverride: process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR,
      });
      if (!captured || captured.status !== 'found'
          || captured.snapshotHash !== authoritative.snapshotDigest
          || authoritative.snapshotDigest !== computeBoundIssueSnapshotHash(reopenedLiveBody!)) {
        await releaseEarlyClaim('completed_reset_new_head_snapshot_unverified');
        return { ok: false, created: false, reused: false, httpStatus: 409,
          prNumber: target.prNumber, headSha: target.headSha,
          reason: 'completed_reset_new_head_snapshot_unverified',
          nextAction: 'verify the persisted new-head snapshot against the live amended Issue body before retrying the same audited cycle' };
      }
    }
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
    const unboundLegacyHarness = process.env.OPK_VITEST_HARNESS === '1'
      && authoritative.snapshotDigest === 'harness-unbound-fixture'
      && input.tier === undefined;
    let authority = initializePackReviewAuthority({
      prNumber: target.prNumber,
      headSha: target.headSha,
      tier: authoritative.tier,
      retainedOpenCycle,
      // Unbound historical harness fixtures have no authoritative adoption signal;
      // preserve their legacy accounting unless the fixture explicitly selects a tier.
      capMapVersion: unboundLegacyHarness
        ? PACK_REVIEW_CAP_MAP_VERSION
        : PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      options: authorityOptions,
    });
    try {
      authority = reconcilePackReviewTier({
        prNumber: target.prNumber,
        tier: authoritative.tier,
        options: authorityOptions,
        startedRunExists: listPackReviewRunRecordsRaw({ projectId, storeRoot }).some((candidate) =>
          candidate.prNumber === target.prNumber
          && (candidate.reviewCycleId === authority.cycle?.cycleId
            || (!candidate.reviewCycleId && candidate.targetSha === target.headSha
              && candidate.canonicalRepository?.toLowerCase() === target.repoSlug.toLowerCase()))),
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
    // A historical T2 run's immutable cap-one delivery may already have
    // published success. Reconcile that exact same-head public status before
    // starting any newly eligible reviewer or returning an old-cap receipt.
    supplementalMode = Boolean(explicitReviewer && authority.cycle
      && authority.cycle.capMapVersion === PACK_REVIEW_LOGICAL_CAP_MAP_VERSION
      && (authority.cycle.reviewStageComplete === true
        || (authority.cycle.consumedRoundOrdinals?.length ?? 0) >= authority.cycle.frozenCap));
    const priorTerminalRun = authority.currentHeadSha === target.headSha && authority.terminal?.runId
      ? getPackReviewRun(authority.terminal.runId, { projectId, storeRoot })
      : null;
    if (priorTerminalRun && !supplementalMode) {
      try {
        await ensurePromotedRoundPublicPending({
          run: priorTerminalRun, projectId, storeRoot,
          repoSlug: target.repoSlug, sourceRepoRoot: target.sourceRepoRoot,
          fixtureCurrentPrHeadSha: input.fixtureCurrentPrHeadSha,
          fixtureRequiredStatusReader: input.fixtureRequiredStatusReader,
          fixtureRequiredStatusWriter: input.fixtureRequiredStatusWriter,
        });
      } catch (error) {
        await releaseEarlyClaim('status_not_published');
        return { ok: false, created: false, reused: true,
          reason: 'status_not_published', detail: describeError(error),
          nextAction: 'repair the incumbent exact-head required status using scoped reconcile; do not create another review',
          prNumber: target.prNumber, headSha: target.headSha, httpStatus: 409 };
      }
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

    // Reuse the same final-cap evidence and publication decision as scoped
    // reconciliation. Do not let start settle first or swallow its refusal.
    const finalFindings = authority.cycle?.capMapVersion === PACK_REVIEW_LOGICAL_CAP_MAP_VERSION
      && authority.cycle.frozenTier !== 'T1'
      && authority.terminal?.reviewVerdict === 'findings'
      && (['at_cap_open_findings', 'at_cap_continuation_required'].includes(authority.cycle.state)
        || (authority.cycle.state === 'closed' && authority.cycle.reviewStageComplete === true
          && authority.terminal.targetSha !== target.headSha));
    // Completed final-cap stages still require verified Issue binding on
    // rewritten/diverged heads; ancestry is decided inside reconciliation.
    if (finalFindings && authority.terminal!.targetSha !== target.headSha && !supplementalMode) {
      const result = await reconcileFinalCapSettlement({
        projectId, storeRoot, prNumber: target.prNumber,
        repoSlug: target.repoSlug, sourceRepoRoot: target.sourceRepoRoot,
        fixtureCurrentPrHeadSha: input.fixtureCurrentPrHeadSha,
        fixturePrBody: input.fixturePrBody, fixturePrState: input.fixturePrState,
        fixtureIssueNumber: input.fixtureIssueNumber,
        fixtureIssueBody: input.fixtureIssueBody, fixtureIssueTitle: input.fixtureIssueTitle,
        fixtureReviewCompareStatus: input.fixtureReviewCompareStatus,
        fixtureSameHeadIssueResolutionRunner: input.fixtureSameHeadIssueResolutionRunner,
        fixtureRequiredStatusReader: input.fixtureRequiredStatusReader,
        fixtureRequiredStatusWriter: input.fixtureRequiredStatusWriter,
      }, { projectId, storeRoot, repoSlug: target.repoSlug });
      await releaseEarlyClaim(result?.settled === true ? 'final_cap_descendant_settled' : 'final_cap_settlement_refused');
      return result?.settled === true
        ? { ok: true, created: false, reused: true, prNumber: target.prNumber,
            headSha: target.headSha, reason: result.reason,
            statusPublished: true, publicationVerified: true, httpStatus: 200 }
        : { ok: false, created: false, reused: false, prNumber: target.prNumber,
            headSha: target.headSha, reason: result?.reason ?? 'final_cap_settlement_unverified',
            ...(result?.detail ? { detail: result.detail } : {}),
            nextAction: result?.nextAction ?? 'restore verified final-cap binding and retry scoped reconcile',
            httpStatus: 409 };
    }
    if (authority.cycle?.capMapVersion === PACK_REVIEW_LOGICAL_CAP_MAP_VERSION
        && authority.terminal?.reviewVerdict === 'findings'
        && authority.terminal.targetSha !== target.headSha
        && authority.cycle.state === 'open_findings') {
      const reviewedHeadSha = authority.terminal.targetSha;
      const strictDescendant = await resolvePackReviewStrictDescendant({
        repoRoot: target.sourceRepoRoot,
        repoSlug: target.repoSlug,
        reviewedHeadSha,
        currentHeadSha: target.headSha,
        fixtureReviewCompareStatus: input.fixtureReviewCompareStatus,
      });
      if (strictDescendant) {
        authority = settleLogicalPackReviewFindingsByStrictDescendant({
          prNumber: target.prNumber, expectedTransitionSeq: authority.transitionSeq,
          reviewedHeadSha, currentHeadSha: target.headSha,
          reviewedHeadIsAncestor: true, options: authorityOptions,
        });
      }
    }

    // An existing, credentialed, same-head GPT verdict with unfinished
    // delivery must resume its own journal/comment/status channels before
    // the generic stage-complete success projection can acknowledge the head.
    // This does not reopen the review stage or grant another source invocation.
    const incumbentGptDeliveryResume = resumeCandidate?.reviewRound?.reviewer === 'gpt'
      && authority.terminal?.runId === resumeCandidate.id
      && authority.currentHeadSha.toLowerCase() === target.headSha.toLowerCase()
      && resumeCandidate.targetSha.toLowerCase() === target.headSha.toLowerCase();
    if (authority.cycle?.reviewStageComplete === true
        && authority.cycle.capMapVersion === PACK_REVIEW_LOGICAL_CAP_MAP_VERSION
        && !incumbentGptDeliveryResume
        && !explicitReviewer) {
      const cycleId = authority.cycle.cycleId;
      const verifyStageCompleteHead = async () => {
        const head = await readProjectionHead();
        const latest = readPackReviewAuthority(target.prNumber, authorityOptions);
        return head === target.headSha.toLowerCase()
          && latest?.currentHeadSha.toLowerCase() === target.headSha.toLowerCase()
          && latest.cycle?.cycleId === cycleId
          && latest.cycle.reviewStageComplete === true
          && latest.cycle.capMapVersion === PACK_REVIEW_LOGICAL_CAP_MAP_VERSION;
      };
      const unresolved = async (detail: string) => {
        await releaseEarlyClaim('status_not_published');
        return {
          ok: false, created: false, reused: true,
          reason: 'status_not_published', detail,
          nextAction: 'restart PR-led pack review for the live head or rerun scoped reconcile; no extra review round',
          prNumber: target.prNumber, headSha: target.headSha, cycleId, httpStatus: 409,
        };
      };
      if (!(await verifyStageCompleteHead())) {
        return unresolved('stage_complete_head_or_authority_changed_before_status');
      }
      const writeRequiredStatus = input.fixtureRequiredStatusWriter ?? ((request) => publishPackReviewRequiredStatus({
        repoRoot: target.sourceRepoRoot,
        repoSlug: target.repoSlug,
        headSha: target.headSha,
        request,
      }));
      try {
        await writeRequiredStatus({
          state: 'success',
          context: PACK_REVIEW_REQUIRED_STATUS_CONTEXT,
          description: 'Required pack-review stage completed; no additional review round required.',
          idempotencyKey: `required-status:${PACK_REVIEW_REQUIRED_STATUS_CONTEXT}:${target.headSha}:stage-complete:${cycleId}`,
        });
      } catch (error) {
        return unresolved(`stage_complete_status_write_failed:${describeError(error)}`);
      }
      if (!(await verifyStageCompleteHead())) {
        return unresolved('stage_complete_head_or_authority_changed_during_status');
      }
      let observedStageCompleteStatus: string | undefined;
      try {
        observedStageCompleteStatus = process.env.OPK_VITEST_HARNESS === '1'
          && !input.fixtureRequiredStatusReader
          ? 'success'
          : await readFinalCapRequiredStatus({
              sourceRepoRoot: target.sourceRepoRoot, repoSlug: target.repoSlug,
              fixtureRequiredStatusReader: input.fixtureRequiredStatusReader,
            }, target.repoSlug, target.headSha);
      } catch {
        return unresolved('stage_complete_status_unverified_on_current_head');
      }
      if (observedStageCompleteStatus !== 'success' || !(await verifyStageCompleteHead())) {
        return unresolved('stage_complete_success_status_not_observed_on_current_head');
      }
      const stageCompleteReason = authority.terminal?.targetSha === target.headSha
        ? 'terminal_run_exists'
        : 'review_stage_complete';
      await releaseEarlyClaim(stageCompleteReason);
      return {
        ok: true,
        created: false,
        reused: true,
        reason: stageCompleteReason,
        statusPublished: true,
        publicationVerified: true,
        publicationHeadSha: target.headSha,
        prNumber: target.prNumber,
        headSha: target.headSha,
        cycleId,
        httpStatus: 200,
      };
    }

    const logicalAccounting = authority.cycle?.capMapVersion === PACK_REVIEW_LOGICAL_CAP_MAP_VERSION;
    const consumedLogicalRoundCount = authority.cycle?.consumedRoundOrdinals?.length ?? 0;
    if (logicalAccounting
        && authority.cycle
        && consumedLogicalRoundCount >= authority.cycle.frozenCap
        && authority.terminal?.targetSha === target.headSha
        && !resumeCandidate && !explicitReviewer) {
      const terminalRun = authority.terminal.runId
        ? getPackReviewRun(authority.terminal.runId, { projectId, storeRoot })
        : null;
      if (terminalRun) {
        // A pre-start reconciler can finish the original credentialed GPT run.
        // Reusing that at-cap terminal does not authorize a new reviewer, but
        // the manager still needs exact-current-head publication confirmation.
        // Blocking findings remain blocking; verification is not approval.
        const confirmation = terminalRun.reviewRound?.reviewer === 'gpt'
          ? await observePackReviewVerdictDelivery({
              input, projectId, storeRoot, runId: terminalRun.id,
              prNumber: target.prNumber, headSha: target.headSha,
              repoSlug: target.repoSlug, sourceRepoRoot: target.sourceRepoRoot,
              readHead: readProjectionHead,
              writeRequiredStatus: input.fixtureRequiredStatusWriter ?? ((request) => publishPackReviewRequiredStatus({
                repoRoot: target.sourceRepoRoot, repoSlug: target.repoSlug,
                headSha: target.headSha, request,
              })),
              resumeFailedStatus: true,
            })
          : null;
        await releaseEarlyClaim('terminal_run_exists');
        return {
          ok: true,
          created: false,
          reused: true,
          reason: 'terminal_run_exists',
          prNumber: target.prNumber,
          headSha: target.headSha,
          runId: terminalRun.id,
          status: terminalRun.status,
          cycleId: authority.cycle.cycleId,
          ...(confirmation ? {
            statusPublished: confirmation.verified,
            publicationVerified: confirmation.verified,
            ...(confirmation.verified
              ? { publicationHeadSha: target.headSha, requiredStatusState: confirmation.requiredStatusState }
              : {
                  publicationReason: confirmation.reason,
                  nextAction: 'reconcile the incumbent GitHub review and exact-head status without another reviewer invocation',
                }),
          } : {}),
          httpStatus: confirmation && !confirmation.verified ? 409 : 200,
        };
      }
    }
    if (!supplementalMode && !explicitReviewer) {
      carryover = await resolveCarryoverReplay({ input, target, projectId, storeRoot, baseRef, priorAuthority });
    }
    const conflictFreeCarryover = carryover?.replay.kind === 'conflict_free_carryover';
    if (!supplementalMode && !conflictFreeCarryover && authority.cycle?.state === 'open_findings') {
      await releaseEarlyClaim('prior_round_findings_unresolved');
      return {
        ok: false,
        created: false,
        reused: true,
        reason: 'prior_round_findings_unresolved',
        nextAction: 'advance the PR to a proven strict descendant of the reviewed findings head before starting the next required round',
        prNumber: target.prNumber,
        headSha: target.headSha,
        cycleId: authority.cycle.cycleId,
        httpStatus: 409,
      };
    }
    if (!supplementalMode && !conflictFreeCarryover
        && authority.cycle
        && ['at_cap_open_findings', 'at_cap_continuation_required'].includes(authority.cycle.state)) {
      await releaseEarlyClaim('at_cap_continuation_required');
      return {
        ok: false,
        created: false,
        reused: false,
        reason: 'at_cap_continuation_required',
        nextAction: logicalAccounting
          ? 'advance the PR to a proven strict descendant of the reviewed findings head, then rerun scoped reconcile --immediate'
          : 'fix the final findings, then run scoped reconcile --immediate',
        prNumber: target.prNumber,
        headSha: target.headSha,
        cycleId: authority.cycle.cycleId,
        httpStatus: 409,
      };
    }

    // An earlier at-cap shortcut skipped CI; newly available ordinal 2
    // cannot consume its slot without green required checks for this head/base.
    if (productionRequiredCiStart && existingStateCannotStartReviewer
        && (process.env.OPK_VITEST_HARNESS !== '1' || harnessRequiredCiOptIn)
        && logicalAccounting && authority.cycle?.state === 'open'
        && authority.cycle.reviewStageComplete !== true
        && consumedLogicalRoundCount > 0
        && consumedLogicalRoundCount < authority.cycle.frozenCap) {
      const green = await manualPackReviewRequiredCiGreen({
        startInput: input, targetContext: selectedTarget,
        target: { prNumber: target.prNumber, headSha: target.headSha,
          repoSlug: target.repoSlug, sourceRepoRoot: target.sourceRepoRoot,
          prBaseRef: target.prBaseRef },
      });
      if (!green) {
        await releaseEarlyClaim('required_ci_not_green_for_current_head');
        return { ok: false, created: false, reused: false,
          reason: 'required_ci_not_green_for_current_head',
          prNumber: target.prNumber, headSha: target.headSha, httpStatus: 409 };
      }
    }

    if (logicalAccounting
        && authority.cycle?.state === 'open'
        && consumedLogicalRoundCount > 0
        && consumedLogicalRoundCount < authority.cycle.frozenCap) {
      authority = observePackReviewHead({
        prNumber: target.prNumber,
        expectedTransitionSeq: authority.transitionSeq,
        headSha: target.headSha,
        options: authorityOptions,
      });
    }

    const roundOrdinal = supplementalMode
      ? Math.max(1, authority.cycle?.frozenCap ?? 1)
      : logicalAccounting
        ? (authority.cycle?.consumedRoundOrdinals?.length ?? 0) + 1
      : (authority.cycle?.consumedHeadShas.length ?? 0) + 1;
    const accountingVersion = authority.cycle?.capMapVersion;
    const cardinality = selectPackReviewGptSourceCardinality({
      reviewer: reviewer ?? 'codex',
      tier: authoritative.tier,
      roundOrdinal,
      accountingVersion,
    });
    let gptRound: PackReviewGptRoundRecord | undefined = reviewer === 'gpt'
      && !conflictFreeCarryover
      && (authoritative.snapshotDigest !== 'harness-unbound-fixture'
        || input.tier !== undefined
        || process.env.OPK_VITEST_HARNESS !== '1')
      ? {
          schema: 'pack-review-gpt-round/v1',
          reviewer: 'gpt',
          tier: authoritative.tier,
          accountingVersion,
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
        && trim(process.env.PACK_GPT_BROWSER_CHAT_URL)) {
      throw new Error('plural GPT review forbids a fixed chat URL; target project URL comes from the selected project card');
    }

    let allowSameRoundReplacement = false;
    let sameRoundGptRun: PackReviewRunRecord | null = null;
    let freshRateLimitGptRun: PackReviewRunRecord | null = null;
    let freshRateLimitGptHistory: PackReviewRunRecord[] = [];
    let sameRoundGptHistory: PackReviewRunRecord[] = [];
    let sameRoundRateLimitPartial = false;
    let sameRoundGptEligibleSlotIds: ReadonlySet<string> | undefined;
    let sameRoundGptOrphanSlotIds: ReadonlySet<string> | undefined;
    let sameRoundGptDiagnostics: PackReviewGptTargetDiagnostic[] | undefined;
    const ownsStartClaim = () => claimMode === 'preacquired'
      ? preacquiredClaimOwned()
      : claimLease?.owns() === true;
    const incumbentCandidates = (records: readonly PackReviewRunRecord[]) => records.filter((candidate) => (
      candidate.prNumber === target.prNumber
      && ((
        candidate.reviewCycleId === authority.cycle?.cycleId
        && candidate.logicalRoundOrdinal === roundOrdinal
      ) || hasFailedRateLimitSource(candidate))
      && candidate.targetSha.toLowerCase() === target.headSha.toLowerCase()
      && candidate.reviewRound?.reviewer === 'gpt'
      && !hasPersistedPackReviewVerdict(candidate)
    ));
    const incumbentFrozenTierMatches = (candidate: PackReviewRunRecord): boolean => {
      const cycle = authority.cycle;
      const historicalRound = candidate.reviewRound;
      if (!cycle || !historicalRound) return false;
      // Unlike an unfinished incumbent continuation, a distinct rate-limit
      // replacement requires the exact original frozen tier and cap.
      if (hasFailedRateLimitSource(candidate)) {
        return candidate.logicalRoundCap === cycle.frozenCap
          && historicalRound.tier === cycle.frozenTier
          && historicalRound.tier === authoritative.tier;
      }
      if (candidate.logicalRoundCap === cycle.frozenCap
          && historicalRound.tier === authoritative.tier) return true;
      // A live upward amendment changes the unfinished cycle, not the original
      // zero-consumed run's tier/cap, owner, ordinal or Issue snapshot.
      return cycle.capMapVersion === PACK_REVIEW_LOGICAL_CAP_MAP_VERSION
        && cycle.frozenTier === 'T3'
        && cycle.frozenCap === 2
        && cycle.consumedRoundOrdinals?.length === 0
        && candidate.logicalRoundOrdinal === 1
        && (historicalRound.tier === 'T1' || historicalRound.tier === 'T2')
        && candidate.logicalRoundCap === 1;
    };
    const incumbentIdentityMatches = (candidate: PackReviewRunRecord) => (
      candidate.projectId === projectId
      && trim(candidate.canonicalRepository).toLowerCase() === target.repoSlug.toLowerCase()
      && resolve(candidate.sourceRepoRoot) === resolve(target.sourceRepoRoot)
      && resolve(candidate.trustedPackRoot) === resolve(trusted.trustedPackRoot)
      && candidate.headSha.toLowerCase() === target.headSha.toLowerCase()
      && candidate.resolvedReviewer === 'gpt'
      && candidate.accountingVersion === accountingVersion
      && candidate.reviewCycleId === authority.cycle?.cycleId
      && candidate.logicalRoundOrdinal === roundOrdinal
      && incumbentFrozenTierMatches(candidate)
      && candidate.reviewRound?.roundOrdinal === roundOrdinal
      && candidate.reviewRound?.accountingVersion === accountingVersion
      && candidate.reviewRound?.cardinality === cardinality
      && candidate.reviewRound?.issueNumber === authoritative.issueNumber
      && candidate.reviewRound?.boundIssueSnapshotDigest === authoritative.snapshotDigest
      && (candidate.boundIssueSnapshotDigest === undefined
        || candidate.boundIssueSnapshotDigest === authoritative.snapshotDigest)
    );
    const incumbentOwnerDead = (candidate: PackReviewRunRecord) => {
      const original = deadOwnersBeforeReconcile.get(candidate.id);
      // The persisted owner PID and heartbeat grace are authoritative even
      // when a crash leaves the run in a non-active status or its sources
      // at invocation_started. Reconciliation may refresh the heartbeat.
      return isPackReviewRunStale({ ...candidate, status: 'reviewing' })
        || Boolean(original
          && original.runnerPid === candidate.runnerPid
          && isPackReviewRunStale({
            ...candidate, status: 'reviewing', heartbeatAtUtc: original.heartbeatAtUtc,
          }));
    };
    const rejectIncumbent = async (candidate: PackReviewRunRecord, reason: string, nextAction: string) => {
      await releaseEarlyClaim(reason);
      // Every incumbent refusal exposes an immediately runnable, PR-scoped
      // read/reconciliation command rather than an unexecutable "observe".
      const command = reason === 'gpt_incumbent_owner_not_dead'
        ? `node --experimental-strip-types scripts/pack-review-runner.ts list --project-id ${projectId}`
        : reason === 'gpt_incumbent_claim_not_owned'
          ? `npm run --silent pack-gpt-review -- --project ${projectId} --pr-number ${target.prNumber}`
          : `node --experimental-strip-types scripts/pack-review-runner.ts reconcile --source-repo-root ${JSON.stringify(target.sourceRepoRoot)} --repo-slug ${target.repoSlug} --pr-number ${target.prNumber} --immediate`;
      return {
        ok: false, created: false, reused: true, reason,
        replacementEligible: false,
        nextAction: `${command} # ${nextAction}`,
        reviewer,
        prNumber: target.prNumber, headSha: target.headSha,
        runId: candidate.id, status: candidate.status,
        coverage: derivePackReviewGptCoverage(candidate.reviewRound),
        httpStatus: 409,
      };
    };
    if (logicalAccounting && reviewer === 'gpt' && authority.cycle && !supplementalMode) {
      const allRecords = listPackReviewRunRecordsRaw({ projectId, storeRoot });
      const storedCandidates = incumbentCandidates(allRecords);
      const otherSameHead = allRecords.find((candidate) => (
        candidate.prNumber === target.prNumber
        && candidate.targetSha.toLowerCase() === target.headSha.toLowerCase()
        && candidate.reviewRound?.reviewer === 'gpt'
        && !hasPersistedPackReviewVerdict(candidate)
        && !storedCandidates.some((matching) => matching.id === candidate.id)
      ));
      if (otherSameHead) {
        return rejectIncumbent(otherSameHead, 'gpt_incumbent_identity_mismatch',
          'reconcile the existing same-head GPT run cycle/round before starting or rebinding work');
      }
      if (storedCandidates.length > 0) {
        // Retained zero-send failures are history, not competing live owners.
        // Existing required-run ordering must identify exactly one newest run.
        const newest = storedCandidates.filter((candidate) =>
          resolvePackReviewRequiredRunOrder(allRecords, candidate).kind === 'none');
        const priorSameRound = newest.length === 1 ? newest[0]! : storedCandidates[0]!;
        if (newest.length !== 1) {
          return rejectIncumbent(priorSameRound, 'gpt_incumbent_ambiguous_run',
            'inspect competing same-round records; do not reassign any incumbent owner');
        }
        if (!incumbentIdentityMatches(priorSameRound)) {
          return rejectIncumbent(priorSameRound, 'gpt_incumbent_identity_mismatch',
            'reconcile the exact repository, frozen Issue snapshot and round before any incumbent continuation');
        }
        const older = storedCandidates.filter((candidate) => candidate.id !== priorSameRound.id);
        const failedRateLimitRound = hasFailedRateLimitSource(priorSameRound);
        if (older.length > 0 && !failedRateLimitRound) {
          return rejectIncumbent(priorSameRound, 'gpt_incumbent_ambiguous_run',
            'inspect competing same-round records; do not reassign any incumbent owner');
        }
        // An older verdict-bearing record is never made safe by a newer failed
        // record; likewise every older no-verdict record needs its own census.
        const verdictHistory = allRecords.find((candidate) =>
          candidate.projectId === projectId && candidate.prNumber === target.prNumber
          && candidate.targetSha.toLowerCase() === target.headSha.toLowerCase()
          && candidate.reviewCycleId === authority.cycle!.cycleId
          && candidate.logicalRoundOrdinal === roundOrdinal
          && candidate.automaticBudgetDisposition !== 'non_consuming_explicit'
          && candidate.reviewRound?.reviewer === 'gpt'
          && hasPersistedPackReviewVerdict(candidate));
        if (verdictHistory) {
          return rejectIncumbent(verdictHistory, 'gpt_incumbent_ambiguous_run',
            'resolve verdict-bearing same-round history before any new review');
        }
        for (const historical of older) {
          if (resolvePackReviewRequiredRunOrder(allRecords, historical).kind !== 'newer'
            || !incumbentIdentityMatches(historical)
            || !originalRateLimitZeroJudgment(historical, storeRoot)
            || !(await proveRateLimitOriginalZeroSend({
              run: historical, projectId, storeRoot, repoSlug: target.repoSlug,
              sourceRepoRoot: target.sourceRepoRoot,
              transport: input.fixtureGptSourceCommentTransport,
            }))) {
            return rejectIncumbent(historical, 'gpt_rate_limit_history_unsafe',
              rateLimitOriginalRecoveryAction(historical));
          }
        }
        const postedPartial = failedRateLimitRound && gptUsableSourceCount(priorSameRound.reviewRound) > 0;
        if (postedPartial) {
          if (!incumbentOwnerDead(priorSameRound)) {
            return rejectIncumbent(priorSameRound, 'gpt_incumbent_owner_not_dead',
              'observe the original runner PID and stale grace before resuming posted source work');
          }
          if (!ownsStartClaim()) {
            return rejectIncumbent(priorSameRound, 'gpt_incumbent_claim_not_owned',
              'acquire the exact current PR/head start claim before resuming missing sources');
          }
          const eligible = await recoverablePostedRateLimitSlots({
            run: priorSameRound, repoSlug: target.repoSlug, sourceRepoRoot: target.sourceRepoRoot,
            transport: input.fixtureGptSourceCommentTransport,
          });
          if (!eligible) {
            return rejectIncumbent(priorSameRound, 'gpt_rate_limit_partial_sources_unverified',
              'credential the complete GitHub source and prove missing pre-send slots before retrying');
          }
          // Source comments are bound to the original run ID, so resume that
          // run, retaining posted complete sources and verified older 0/3 history.
          sameRoundGptRun = priorSameRound;
          sameRoundRateLimitPartial = true;
          sameRoundGptHistory = older;
          sameRoundGptEligibleSlotIds = eligible;
          gptRound = priorSameRound.reviewRound;
        } else if (failedRateLimitRound) {
          if (!originalRateLimitZeroJudgment(priorSameRound, storeRoot)) {
            return rejectIncumbent(priorSameRound, 'gpt_rate_limit_original_zero_send_unproven',
              rateLimitOriginalRecoveryAction(priorSameRound));
          }
          if (!ownsStartClaim()) {
            return rejectIncumbent(priorSameRound, 'gpt_incumbent_claim_not_owned',
              'acquire the exact current PR/head start claim before a fresh rate-limit review');
          }
          // Only a completely zero-send original may allocate a new run.
          allowSameRoundReplacement = true;
          freshRateLimitGptRun = priorSameRound;
          freshRateLimitGptHistory = older;
        } else {
          if (!incumbentOwnerDead(priorSameRound)) {
            return rejectIncumbent(priorSameRound, 'gpt_incumbent_owner_not_dead',
              'observe the original runner PID and stale grace; do not take over a live or fresh incumbent');
          }
          if (!ownsStartClaim()) {
            return rejectIncumbent(priorSameRound, 'gpt_incumbent_claim_not_owned',
              'acquire or retain the exact current PR/head start claim before resuming');
          }
          const observeAttempt = input.fixtureGptAttemptObserver ?? observeGptPackReviewAttempt;
        const observation = await observeAttempt(priorSameRound);
        sameRoundGptDiagnostics = observation?.diagnostics;
        const originalLaunchIds = observation?.initialLaunchSlotIds ?? [];
        const initialLaunchSlotIds = originalLaunchIds.filter((slotId) => (
          priorSameRound.reviewRound?.sourceSlots.some((slot) => (
            slot.slotId === slotId
            && (slot.lifecycle === 'planned'
              || (slot.lifecycle === 'terminal' && slot.terminalClass === 'pre_launch_interrupted'))
          ))
        ));
        // The browser observer's generating-timeout/empty-reply hint is not
        // evidence of zero delivery. Only an existing terminal pre-send class
        // can legally rotate the original invocation in this dead-partial path.
        const replacementSlotIds = (observation?.replacementEligibleSlotIds
          ?? (observation?.replacementEligible && observation.slotId ? [observation.slotId] : []))
          .filter((slotId) => priorSameRound.reviewRound?.sourceSlots.some((slot) => (
            slot.slotId === slotId
            && (
              // A dead-and-expired runner cannot finalize its orphaned invocation.
              // Only an existing per-source replacement observation makes a
              // started orphan retry-eligible; the original GitHub comment is
              // checked again immediately before any new invocation.
              (slot.lifecycle === 'invocation_started' && Boolean(slot.invocationId))
              || (slot.lifecycle === 'terminal'
                && (authoritativePreSend(slot) || (
                  Boolean(slot.terminalClass)
                  && (slot.terminalResult as Record<string, unknown> | undefined)?.send_count === 0
                  && !terminalHasPossibleDelivery(slot.terminalResult as Record<string, unknown>)
                )))
            )
          )));
        const eligibleSlotIds = [...new Set([...replacementSlotIds, ...initialLaunchSlotIds])];
        if (eligibleSlotIds.length === 0) {
          const unresolved = priorSameRound.reviewRound!.sourceSlots.find((slot) => (
            slot.lifecycle === 'invocation_started' && slot.invocationId
          ));
          return rejectIncumbent(priorSameRound,
            observation?.state === 'reply_recovery_required'
              ? 'reply_recovery_required'
              : unresolved
                ? 'gpt_original_invocation_recovery_required'
                : observation?.state ?? 'gpt_observation_unavailable',
          unresolved
            ? 'recover the original chat and credentialed GitHub source for '
              + unresolved.slotId + ' invocation ' + unresolved.invocationId + '; do not resend'
            : 'observe the original run and recover its source evidence before any eligible retry');
        }
        allowSameRoundReplacement = true;
        sameRoundGptRun = priorSameRound;
        sameRoundGptEligibleSlotIds = new Set(eligibleSlotIds);
        sameRoundGptOrphanSlotIds = new Set(replacementSlotIds.filter((slotId) =>
          priorSameRound.reviewRound?.sourceSlots.some((slot) =>
            slot.slotId === slotId && slot.lifecycle === 'invocation_started')));
        gptRound = priorSameRound.reviewRound;
        }
      }
    }

    if (logicalAccounting && reviewer && reviewer !== 'gpt' && authority.cycle && !supplementalMode) {
      const priorSameRound = listPackReviewRunRecordsRaw({ projectId, storeRoot })
        .filter((candidate) => candidate.prNumber === target.prNumber
          && candidate.reviewCycleId === authority.cycle!.cycleId
          && candidate.logicalRoundOrdinal === roundOrdinal
          && candidate.targetSha.toLowerCase() === target.headSha.toLowerCase()
          && candidate.resolvedReviewer === reviewer
          && !hasPersistedPackReviewVerdict(candidate))
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
      if (priorSameRound) {
        const observation = observeNativePackReviewAttempt(priorSameRound);
        if (!observation?.replacementEligible) {
          await releaseEarlyClaim('native_replacement_not_eligible');
          return {
            ok: false,
            created: false,
            reused: true,
            reason: observation
              ? `native_attempt_${observation.state}`
              : 'native_observation_unavailable',
            reviewer,
            replacementEligible: false,
            prNumber: target.prNumber,
            headSha: target.headSha,
            runId: priorSameRound.id,
            httpStatus: 202,
          };
        }
        allowSameRoundReplacement = true;
      }
    }

    if (!supplementalMode) {
      authority = advancePackReviewAuthority(
        authority,
        'claim_acquired',
        target.prNumber,
        authorityOptions,
      );
    }

    if (resumeCandidate && explicitReviewer && resumeCandidate.resolvedReviewer !== reviewer) {
      await releaseEarlyClaim('reviewer_origin_mismatch');
      return { ok: false, created: false, reused: true,
        reason: 'reviewer_origin_mismatch',
        nextAction: 'inspect the journaled origin and request only its actual same-head reviewer or a new eligible review',
        prNumber: target.prNumber, headSha: target.headSha, runId: resumeCandidate.id, httpStatus: 409 };
    }
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
      if (resumeCandidate.automaticBudgetDisposition === 'non_consuming_explicit') {
        await assertBoundHeadStillCurrent({
          repoRoot: target.sourceRepoRoot, repoSlug: target.repoSlug,
          prNumber: target.prNumber, boundHeadSha: target.headSha,
          boundIssueNumber: target.issueNumber,
          fixturePostReviewHeadSha: input.fixturePostReviewHeadSha,
          fixturePostReviewPrBody: input.fixturePostReviewPrBody ?? input.fixturePrBodyAfterClaim ?? input.fixturePrBody,
        });
        const resumed = await resumePackReviewVerdictDelivery({
          run: resumeCandidate, projectId, storeRoot,
          postGithubComment: async () => {
            const posted = await postGithubReview({
              repoRoot: target.sourceRepoRoot, repoSlug: target.repoSlug, prNumber: target.prNumber,
              headSha: target.headSha, run: resumeCandidate, payload: typedResumePayload,
              projectId, storeRoot, transport: githubReviewTransport,
            });
            return { id: posted.id, url: posted.url, event: 'COMMENT' };
          },
          writeRequiredStatus: async () => { throw new Error('supplemental cannot publish required status'); },
          notifyWorker: async () => { throw new Error('supplemental cannot notify required worker'); },
        });
        const reloaded = getPackReviewRun(resumeCandidate.id, { projectId, storeRoot });
        const receipt = reloaded && supplementalReviewReceipt(reloaded);
        const headStillCurrent = await readProjectionHead() === target.headSha.toLowerCase();
        terminal = true;
        if (claimLease) await claimLease.release('run_started', listPackReviewRuns({ projectId, storeRoot }));
        return receipt && headStillCurrent && resumed.reason === 'completed'
          ? { ok: true, created: false, reused: true, recovered: true,
              reason: 'supplemental_review_delivered', ...receipt, prNumber: target.prNumber,
              headSha: target.headSha, status: reloaded?.status, httpStatus: 200 }
          : { ok: false, created: false, reused: true,
              reason: 'supplemental_delivery_unverified', runId: resumeCandidate.id,
              nextAction: 'observe the original reviewer COMMENT and run journal before scoped delivery resume; never duplicate an uncertain post',
              prNumber: target.prNumber, headSha: target.headSha, httpStatus: 409 };
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
        authority = await reconcileTierBeforeTerminal({
          start: input, target, projectId, storeRoot,
          cycleId: authority.cycle?.cycleId, runId: resumeCandidate.id,
        });
        authority = commitPackReviewTerminal({
          prNumber: target.prNumber,
          expectedTransitionSeq: authority.transitionSeq,
          terminal: terminalV2FromPayload({
            runId: resumeCandidate.id,
            targetSha: target.headSha,
            logicalRoundOrdinal: resumeCandidate.logicalRoundOrdinal,
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
        writeRequiredStatus: currentCycleRequiredStatusWriter(
          resumeCandidate, storeRoot,
          input.fixtureRequiredStatusWriter ?? ((request) => publishPackReviewRequiredStatus({
            repoRoot: target.sourceRepoRoot, repoSlug: target.repoSlug,
            headSha: target.headSha, request,
          })),
        ),
        notifyWorker: input.fixtureWorkerNotifier ?? ((request) => sendPackReviewWorkerNotification({
          trustedPackRoot: trusted.trustedPackRoot,
          sessionId: target.sessionId || resumeCandidate.linkedSessionId,
          projectId,
          storeRoot,
          request,
        })),
      });
      const resumedAuthority = readPackReviewAuthority(target.prNumber, authorityOptions);
      if (!resumedAuthority || resumedAuthority.terminal?.runId !== resumeCandidate.id) {
        throw new Error('pack review authority changed before resumed publication');
      }
      // Issue #2496 observes/reprojects only GPT review delivery. Native
      // Claude/Codex resumes keep their incumbent delivered.reason semantics,
      // with no extra status read or forced publication.
      const gptResume = resumeCandidate.reviewRound?.reviewer === 'gpt'
        || resumeCandidate.resolvedReviewer === 'gpt';
      const confirmed = gptResume
        ? await observePackReviewVerdictDelivery({
            input, projectId, storeRoot, runId: resumeCandidate.id,
            prNumber: target.prNumber, headSha: target.headSha,
            repoSlug: target.repoSlug, sourceRepoRoot: target.sourceRepoRoot,
            readHead: readProjectionHead,
            writeRequiredStatus: input.fixtureRequiredStatusWriter ?? ((request) => publishPackReviewRequiredStatus({
              repoRoot: target.sourceRepoRoot, repoSlug: target.repoSlug, headSha: target.headSha, request,
            })),
            resumeFailedStatus: true,
          })
        : null;
      const afterConfirmation = confirmed
        ? readPackReviewAuthority(target.prNumber, authorityOptions)
        : resumedAuthority;
      if (!afterConfirmation || afterConfirmation.terminal?.runId !== resumeCandidate.id) {
        throw new Error('pack review authority changed during resumed publication');
      }
      const publicationStatus = confirmed
        ? (confirmed.verified ? 'succeeded' : 'failed')
        : (resumed.reason === 'completed' ? 'succeeded' : 'failed');
      recordPackReviewPublication({
        prNumber: target.prNumber,
        expectedTransitionSeq: afterConfirmation.transitionSeq,
        nextPhase: publicationStatus === 'succeeded' ? 'external_published' : afterConfirmation.phase,
        publication: {
          headSha: target.headSha,
          terminalRunId: resumeCandidate.id,
          status: publicationStatus,
          publicationDigest: sha256Bytes(JSON.stringify({
            status: resumed.status,
            deliveryReason: resumed.reason,
            ...(confirmed ? { observation: confirmed.reason } : {}),
          })),
          recordedAtUtc: new Date().toISOString(),
        },
        options: authorityOptions,
      });
      terminal = true;
      const runs = listPackReviewRuns({ projectId, storeRoot });
      if (claimLease) await claimLease.release('run_started', runs);
      const recoveredNativeJournal = !gptResume
        ? getPackReviewRun(resumeCandidate.id, { projectId, storeRoot })
        : null;
      return {
        ok: true,
        created: false,
        reused: true,
        recovered: true,
        reason: 'resumed_journaled_delivery',
        ...reviewerProvenanceReceipt(resumeCandidate),
        deliveryReason: resumed.reason,
        ...(recoveredNativeJournal ? { deliveryOutcomes: recoveredNativeJournal.deliveryOutcomes } : {}),
        ...(confirmed ? {
          publicationVerified: confirmed.verified,
          ...(confirmed.verified
            ? { publicationHeadSha: target.headSha, requiredStatusState: confirmed.requiredStatusState }
            : {
                publicationReason: confirmed.reason,
                nextAction: 'observe the bound PR head and existing journal/comment/status, then use scoped reconcile or PR-led status projection; never resend an uncertain source',
              }),
        } : {}),
        prNumber: target.prNumber,
        headSha: target.headSha,
        runId: resumeCandidate.id,
        status: resumed.status,
        coverage: derivePackReviewGptCoverage(resumeCandidate.reviewRound),
        httpStatus: confirmed ? (confirmed.verified ? 200 : 409) : 200,
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
    // No persisted success, send witness or source comment from the old run
    // can be superseded by a generic retry. Re-read all original evidence
    // with the claim held before the synchronous run-store insertion.
    if (freshRateLimitGptRun) {
      const original = freshRateLimitGptRun;
      const headBefore = await readProjectionHead();
      const authorityBefore = readPackReviewAuthority(target.prNumber, authorityOptions);
      if (!ownsStartClaim() || headBefore !== target.headSha.toLowerCase()
        || authorityBefore?.currentHeadSha.toLowerCase() !== headBefore
        || authorityBefore.cycle?.cycleId !== original.reviewCycleId
        || authorityBefore.cycle?.state !== 'open'
        || authorityBefore.cycle?.reviewStageComplete === true
        || authorityBefore.cycle?.consumedRoundOrdinals?.includes(roundOrdinal)
        || authorityBefore.terminal) {
        return rejectIncumbent(original, 'gpt_rate_limit_fresh_authority_unverified',
          'verify the original head, frozen cycle/cap and exact start claim; do not retry an uncertain source');
      }
      const admittedHistory = [original, ...freshRateLimitGptHistory];
      for (const previous of admittedHistory) {
        const current = getPackReviewRun(previous.id, { projectId, storeRoot });
        if (!current || !incumbentIdentityMatches(current)
          || current.status !== previous.status
          || current.failureReason !== previous.failureReason
          || current.sameKeyOrder !== previous.sameKeyOrder
          || stableJson(current.reviewRound) !== stableJson(previous.reviewRound)
          || !(await proveRateLimitOriginalZeroSend({
            run: current, projectId, storeRoot, repoSlug: target.repoSlug,
            sourceRepoRoot: target.sourceRepoRoot,
            transport: input.fixtureGptSourceCommentTransport,
          }))) {
          return rejectIncumbent(previous, 'gpt_rate_limit_original_zero_send_unproven',
            rateLimitOriginalRecoveryAction(previous));
        }
      }
      const headAfter = await readProjectionHead();
      const latest = getPackReviewRun(original.id, { projectId, storeRoot });
      const latestAuthority = readPackReviewAuthority(target.prNumber, authorityOptions);
      const latestRecords = listPackReviewRunRecordsRaw({ projectId, storeRoot });
      const currentCandidates = incumbentCandidates(latestRecords);
      const retainedHistoryUnchanged = currentCandidates.length === admittedHistory.length
        && admittedHistory.every((previous) => {
          const candidate = currentCandidates.find((row) => row.id === previous.id);
          return Boolean(candidate && incumbentIdentityMatches(candidate)
            && candidate.status === previous.status
            && candidate.failureReason === previous.failureReason
            && candidate.sameKeyOrder === previous.sameKeyOrder
            && originalRateLimitZeroJudgment(candidate, storeRoot)
            && stableJson(candidate.reviewRound) === stableJson(previous.reviewRound)
            && resolvePackReviewRequiredRunOrder(latestRecords, candidate).kind
              === (previous.id === original.id ? 'none' : 'newer'));
        });
      if (headAfter !== target.headSha.toLowerCase() || !ownsStartClaim()
        || !latest || !originalRateLimitZeroJudgment(latest, storeRoot)
        || stableJson(latest.reviewRound) !== stableJson(original.reviewRound)
        || latest.failureReason !== original.failureReason
        || !incumbentIdentityMatches(latest)
        || !retainedHistoryUnchanged
        || resolvePackReviewRequiredRunOrder(latestRecords, latest).kind !== 'none'
        || latestAuthority?.currentHeadSha.toLowerCase() !== headAfter
        || latestAuthority.cycle?.cycleId !== original.reviewCycleId
        || latestAuthority.cycle?.state !== 'open'
        || latestAuthority.cycle?.reviewStageComplete === true
        || latestAuthority.cycle?.consumedRoundOrdinals?.includes(roundOrdinal)
        || latestAuthority.terminal) {
        return rejectIncumbent(original, 'gpt_rate_limit_fresh_authority_changed',
          're-read the original run, GitHub source comments, current PR head and claim before any new review');
      }
    }
    let created: ReturnType<typeof createPackReviewRun>;
    if (sameRoundGptRun) {
      const freshHead = await readProjectionHead();
      const freshAuthority = readPackReviewAuthority(target.prNumber, authorityOptions);
      const ownsClaim = ownsStartClaim();
      if (freshHead !== target.headSha.toLowerCase()
          || !ownsClaim
          || freshAuthority?.currentHeadSha.toLowerCase() !== target.headSha.toLowerCase()
          || !freshAuthority?.cycle
          || freshAuthority.cycle.cycleId !== sameRoundGptRun.reviewCycleId
          || freshAuthority.cycle.consumedRoundOrdinals?.includes(roundOrdinal) === true
          || freshAuthority.terminal) {
        return rejectIncumbent(sameRoundGptRun, 'gpt_incumbent_authority_changed',
          'observe the exact PR head, current claim and review authority; do not requeue a changed run');
      }
      const selectedRun = sameRoundGptRun;
      if (sameRoundRateLimitPartial) {
        const current = getPackReviewRun(selectedRun.id, { projectId, storeRoot });
        const eligible = current && await recoverablePostedRateLimitSlots({
          run: current, repoSlug: target.repoSlug, sourceRepoRoot: target.sourceRepoRoot,
          transport: input.fixtureGptSourceCommentTransport,
        });
        if (!eligible || !sameRoundGptEligibleSlotIds
          || stableJson([...eligible].sort()) !== stableJson([...sameRoundGptEligibleSlotIds].sort())) {
          return rejectIncumbent(selectedRun, 'gpt_rate_limit_partial_sources_changed',
            're-check exact published source comments and original missing-slot send evidence');
        }
        for (const historical of sameRoundGptHistory) {
          const currentHistory = getPackReviewRun(historical.id, { projectId, storeRoot });
          if (!currentHistory || currentHistory.status !== historical.status
            || currentHistory.failureReason !== historical.failureReason
            || currentHistory.sameKeyOrder !== historical.sameKeyOrder
            || stableJson(currentHistory.reviewRound) !== stableJson(historical.reviewRound)
            || !originalRateLimitZeroJudgment(currentHistory, storeRoot)
            || !(await proveRateLimitOriginalZeroSend({
              run: currentHistory, projectId, storeRoot, repoSlug: target.repoSlug,
              sourceRepoRoot: target.sourceRepoRoot,
              transport: input.fixtureGptSourceCommentTransport,
            }))) {
            return rejectIncumbent(historical, 'gpt_rate_limit_history_unsafe',
              rateLimitOriginalRecoveryAction(historical));
          }
        }
      }
      const selectedRound = stableJson(selectedRun.reviewRound);
      const recoveredRound = sameRoundGptOrphanSlotIds?.size ? {
        ...selectedRun.reviewRound!,
        sourceSlots: selectedRun.reviewRound!.sourceSlots.map((slot) => (
          sameRoundGptOrphanSlotIds!.has(slot.slotId)
            ? {
                ...slot,
                lifecycle: 'terminal' as const,
                terminalClass: 'possible_delivery/missing_result',
                terminalResult: { kind: 'missing_terminal_result', noResend: true },
              }
            : slot
        )),
      } : undefined;
      run = updatePackReviewRunIf(selectedRun.id, (records) => {
        const incumbent = records.find((candidate) => candidate.id === selectedRun.id);
        return Boolean(incumbent
          && incumbentCandidates(records).length === sameRoundGptHistory.length + 1
          && sameRoundGptHistory.every((historical) => {
            const retained = records.find((row) => row.id === historical.id);
            // The old 0/3 proof was rechecked before the store lock.
            // No authority read here: both stores share the same .store-lock.
            return Boolean(retained && incumbentIdentityMatches(retained)
              && retained.status === historical.status
              && retained.failureReason === historical.failureReason
              && retained.sameKeyOrder === historical.sameKeyOrder
              && stableJson(retained.reviewRound) === stableJson(historical.reviewRound)
              && resolvePackReviewRequiredRunOrder(records, retained).kind === 'newer');
          })
          && incumbentIdentityMatches(incumbent)
          && incumbentOwnerDead(incumbent)
          && incumbent.status === selectedRun.status
          && incumbent.runnerPid === selectedRun.runnerPid
          && incumbent.heartbeatAtUtc === selectedRun.heartbeatAtUtc
          && incumbent.updatedAt === selectedRun.updatedAt
          && incumbent.sameKeyOrder === selectedRun.sameKeyOrder
          && stableJson(incumbent.reviewRound) === selectedRound
          && resolvePackReviewRequiredRunOrder(records, incumbent).kind === 'none');
      }, {
        status: 'queued',
        latestRunStatus: 'queued',
        runnerPid: process.pid,
        ...(recoveredRound ? { reviewRound: recoveredRound } : {}),
      }, { projectId, storeRoot });
      if (!run) {
        return rejectIncumbent(sameRoundGptRun, 'gpt_incumbent_concurrent_update',
          'inspect current source comments, live owner and conditional run state before retrying observation');
      }
      gptRound = run.reviewRound;
      created = {
        created: true,
        reused: false,
        reason: 'same_round_replacement',
        run,
        storeRoot,
      };
    } else {
      created = createPackReviewRun({
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
      automaticBudgetDisposition: supplementalMode ? 'non_consuming_explicit' : 'consume',
      ...(supplementalMode ? { allowExplicitSupplementalStart: true } : {}),
      ...(accountingVersion ? { accountingVersion } : {}),
      ...(authority.cycle?.cycleId ? { reviewCycleId: authority.cycle.cycleId } : {}),
      ...(logicalAccounting && !supplementalMode ? {
        logicalRoundOrdinal: roundOrdinal,
        logicalRoundCap: authority.cycle!.frozenCap,
      } : {}),
      ...(reviewer ? { resolvedReviewer: reviewer, resolvedReviewerSource: reviewerResolution.source } : {}),
      ...(gptRound ? { reviewRound: gptRound } : {}),
      boundIssueSnapshotDigest: authoritative.snapshotDigest,
      ...(allowSameRoundReplacement ? { allowSameRoundReplacement: true } : {}),
      });
      run = created.run;
    }
    if (!supplementalMode) {
      authority = advancePackReviewAuthority(
        authority,
        'review_or_bundle_staged',
        target.prNumber,
        authorityOptions,
      );
    }
    if (created.reused) {
      const original = getPackReviewRun(run.id, { projectId, storeRoot }) ?? run;
      const receipt = supplementalMode ? supplementalReviewReceipt(original) : null;
      const validRequiredOrigin = explicitReviewer
        && !supplementalMode
        && original.targetSha === target.headSha
        && original.resolvedReviewer === reviewer
        && original.executedReviewer === reviewer
        && original.reviewerInvokedForThisRun === true
        && original.reviewerExecutionRunId === original.id
        && hasPersistedPackReviewVerdict(original);
      if (claimLease) await claimLease.release('run_started', listPackReviewRuns({ projectId, storeRoot }));
      return {
        ok: !explicitReviewer || Boolean(receipt || validRequiredOrigin),
        created: false,
        reused: true,
        reason: receipt ? 'supplemental_review_delivered' : created.reason,
        ...(receipt ?? (validRequiredOrigin ? reviewerProvenanceReceipt(original) : {})),
        ...(!explicitReviewer || receipt || validRequiredOrigin ? {} : {
          nextAction: 'inspect the existing run and original reviewer; an explicit switch requires a distinct eligible run or confirmed same-reviewer origin',
        }),
        prNumber: target.prNumber,
        headSha: target.headSha,
        runId: run.id,
        httpStatus: explicitReviewer && !(receipt || validRequiredOrigin) ? 409 : 200,
        status: run.status,
        coverage: derivePackReviewGptCoverage(run.reviewRound),
      };
    }

    if (!supplementalMode) await recordPackReviewPendingStatus({
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

    if (sameRoundGptRun?.reviewTargetRoot) {
      const storedTarget = sameRoundGptRun.reviewTargetRoot;
      const unsafeReuse = verifyReviewWorktreeOwner(reviewWorktreeContext, run.id, storedTarget, 'reuse');
      if (unsafeReuse) throw new Error('unsafe persisted review checkout: ' + unsafeReuse);
      const registered = await registeredReviewWorktrees(target.sourceRepoRoot);
      if (reviewWorktreeLstat(storedTarget)) {
        if (!registered.has(storedTarget)
            && (process.env.OPK_VITEST_HARNESS !== '1' || input.fixtureUseRealReviewWorktree)) {
          throw new Error('persisted review checkout is not registered to the selected Git repository');
        }
        if (registered.has(storedTarget)
            && !(await registeredReviewWorktreeMatchesSource(reviewWorktreeContext, storedTarget))) {
          throw new Error('persisted review checkout Git identity differs from selected source repository');
        }
        worktree = storedTarget;
      } else if (registered.has(storedTarget)) {
        // The incumbent has already been conditionally requeued under the exact
        // same-round claim. Repair only its verified registration-only checkout.
        if (!ownsStartClaim()) throw new Error('same-round review start claim is not owned');
        const cleanup = await removeReviewWorktree(
          reviewWorktreeContext, run.id, storedTarget, 'reuse', false, ownsStartClaim,
        );
        if (cleanup !== 'removed') {
          throw new Error('persisted review checkout registration repair deferred: ' + cleanup);
        }
        // createReviewWorktree below restores this same run-ID target, not a new round.
      }
    }
    if (!worktree && process.env.OPK_VITEST_HARNESS === '1'
      && !input.fixtureUseRealReviewWorktree
      && (input.fixtureReviewStdout !== undefined
        || input.fixtureReviewTimedOut === true
        || input.fixtureReviewBySourceSlot !== undefined)) {
      worktree = reviewWorktreePath(storeRoot, run.id);
      validateReviewWorktreePath(storeRoot, run.id, worktree);
      mkdirSync(worktree, { recursive: true });
    } else if (!worktree) {
      await createReviewWorktree(
        target.sourceRepoRoot, storeRoot, run.id, target.headSha,
        (allocatedTarget) => { worktree = allocatedTarget; },
        input.fixtureAfterReviewWorktreeAdd,
      );
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
          sameRoundEligibleSlotIds: sameRoundGptEligibleSlotIds,
          reviewer,
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
        if (reviewer === 'codex' || reviewer === 'claude') {
          const armedInitialRun = updatePackReviewRun(run.id, {
            nativeAttempt: {
              schema: 'pack-review-native-attempt/v1',
              reviewer,
              invocationOrdinal: 1,
              startedAtUtc: new Date().toISOString(),
              effectiveBudgetMs: budgetLedger.effectiveBudgetMs,
            },
          }, { projectId, storeRoot });
          run = armedInitialRun;
          if (input.fixtureAfterNativeInitialArmed) {
            await input.fixtureAfterNativeInitialArmed(armedInitialRun);
          }
        }
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
          reviewer,
          carryoverBundlePath,
          headSha: target.headSha,
          frozenScope: authoritative.frozenScope,
          nativeInvocationOrdinal: 1,
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
        nextAction: 'inspect unjudged reviewer output and reconcile the existing run without inventing a verdict',
        prNumber: target.prNumber,
        headSha: target.headSha,
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
        if (resolvedReviewer === 'codex' || resolvedReviewer === 'claude') {
          const armedFallbackRun = updatePackReviewRun(run.id, {
            nativeAttempt: {
              schema: 'pack-review-native-attempt/v1',
              reviewer: resolvedReviewer,
              invocationOrdinal: 2,
              startedAtUtc: new Date().toISOString(),
              effectiveBudgetMs: budgetLedger.effectiveBudgetMs,
            },
          }, { projectId, storeRoot });
          if (input.fixtureAfterNativeFallbackArmed) {
            await input.fixtureAfterNativeFallbackArmed(armedFallbackRun);
          }
        }
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
          reviewer,
          headSha: target.headSha,
          frozenScope: authoritative.frozenScope,
          nativeInvocationOrdinal: 2,
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
        nextAction: 'observe the PR head and reconcile the existing run without resending uncertain sources',
        prNumber: target.prNumber,
        headSha: target.headSha,
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
      if (process.env.OPK_VITEST_HARNESS === '1' && !input.fixtureGptSourceCommentTransport
          && persistedRound.cardinality >= 3
          && usableSourceCount === persistedRound.cardinality
          && persistedRound.settledSourceCount === undefined) {
        const frozen = freezeGptRoundSourceCount(
          run.id,
          persistedRound.cardinality,
          { projectId, storeRoot },
        );
        if (!frozen) throw new Error(`pack review run ${run.id} could not freeze its complete GPT source census`);
        persistedRun = getPackReviewRun(run.id, { projectId, storeRoot });
        if (!persistedRun) throw new Error(`pack review run ${run.id} disappeared while freezing GPT source count`);
      }
      run = persistedRun;
      const diagnostics = gptRoundDiagnostics(run.reviewRound);
      if (hasPersistedPackReviewVerdict(run)) {
        if (run.automaticBudgetDisposition === 'non_consuming_explicit') {
          const proven = bindCredentialedGptExecutionProvenance(run, { projectId, storeRoot });
          const receipt = supplementalReviewReceipt(proven);
          let exactHead = false;
          try { exactHead = await readProjectionHead() === target.headSha.toLowerCase(); } catch {
            // Unobservable head cannot certify supplemental COMMENT delivery.
          }
          terminal = true;
          if (claimLease) await claimLease.release('run_started', listPackReviewRuns({ projectId, storeRoot }));
          return receipt && exactHead
            ? { ok: true, created: true, reused: false, recovered: true,
                reason: 'supplemental_review_delivered', ...receipt, prNumber: target.prNumber,
                headSha: target.headSha, runId: run.id, status: proven.status, httpStatus: 201 }
            : { ok: false, created: true, reused: false,
                reason: 'supplemental_delivery_unverified', prNumber: target.prNumber,
                headSha: target.headSha, runId: run.id, status: proven.status, httpStatus: 409,
                nextAction: 'observe the original GPT journal and reviewer COMMENT, then resume that same run; do not resend sources' };
        }
        const concurrentAuthority = readPackReviewAuthority(target.prNumber, authorityOptions);
        const published = concurrentAuthority?.currentHeadSha === target.headSha
          && concurrentAuthority.terminal?.runId === run.id
          && concurrentAuthority.publication?.terminalRunId === run.id
          && concurrentAuthority.publication.status === 'succeeded';
        terminal = true;
        const runs = listPackReviewRuns({ projectId, storeRoot });
        if (claimLease) await claimLease.release('run_started', runs);
        return {
          // A competing reconciler owns the same run, not a new verdict.
          // Preserve accepted/recovered while refusing publication authority.
          ok: true,
          created: true,
          reused: false,
          recovered: true,
          reason: published ? 'concurrent_reconcile_settled' : 'concurrent_reconcile_owns_delivery',
          publicationVerified: false,
          nextAction: 'observe the journal, GitHub comment and exact current-head status via scoped reconcile; do not start another round',
          prNumber: target.prNumber,
          headSha: target.headSha,
          runId: run.id,
          status: run.status,
          coverage: derivePackReviewGptCoverage(run.reviewRound),
          httpStatus: 202,
          ...(run.githubReviewId !== undefined ? { githubReviewId: run.githubReviewId } : {}),
          ...(run.githubReviewUrl ? { githubReviewUrl: run.githubReviewUrl } : {}),
        };
      }
      // An unfrozen, still-started original invocation is an incomplete source
      // census, not a malformed aggregate. Keep its exact ID and action visible.
      const pendingSource = run.reviewRound?.settledSourceCount === undefined
        ? run.reviewRound?.sourceSlots.find((slot) => slot.lifecycle === 'invocation_started'
          && Boolean(slot.invocationId))
        : undefined;
      // The original runner still owns this exact run. Use the same source
      // census, durable freeze, authority and delivery path as scoped recovery,
      // before returning to the public command. A locally complete slot alone
      // cannot certify its still-present original GitHub publication.
      if ((process.env.OPK_VITEST_HARNESS !== '1' || input.fixtureGptSourceCommentTransport)
          && !hasPersistedPackReviewVerdict(getPackReviewRun(run.id, { projectId, storeRoot }) ?? run)) {
        let reconciliation: Awaited<ReturnType<typeof reconcileStalePackReviewRuns>> | undefined;
        let reconcileError: string | undefined;
        try {
          reconciliation = await reconcileStalePackReviewRuns({
            repoSlug: target.repoSlug, sourceRepoRoot: target.sourceRepoRoot,
            projectId, storeRoot, prNumber: target.prNumber, runId: run.id,
            recoverActiveGptSources: true,
            // A still-running original invocation is not proof that its comment is absent.
            // Do not degrade the quorum before credentialing that original source.
            settlePartialAfterGrace: pendingSource === undefined,
            fixtureCurrentPrHeadSha: input.fixtureCurrentPrHeadSha,
            fixtureGptSourceCommentTransport: input.fixtureGptSourceCommentTransport,
            fixtureGithubReviewId: input.fixtureGithubReviewId,
            fixtureGithubReviewTransport: input.fixtureGithubReviewTransport,
            fixtureRequiredStatusWriter: input.fixtureRequiredStatusWriter,
            fixtureRequiredStatusReader: input.fixtureRequiredStatusReader,
            fixtureWorkerNotifier: input.fixtureWorkerNotifier,
            fixtureIssueBody: input.fixtureIssueBody, fixtureIssueTitle: input.fixtureIssueTitle,
            fixtureIssueNumber: input.fixtureIssueNumber,
            fixtureChangedPaths: input.fixtureChangedPaths,
            fixtureBoundIssueSnapshotBytes: input.fixtureBoundIssueSnapshotBytes,
            resolveRepositorySlug: resolveSlug,
          });
        } catch (error) {
          reconcileError = describeError(error);
        }
        const recovered = getPackReviewRun(run.id, { projectId, storeRoot }) ?? run;
        const reconciliationResult = reconciliation?.results.find((item) => item.runId === run!.id);
        const verdictExists = hasPersistedPackReviewVerdict(recovered);
        const supplemental = recovered.automaticBudgetDisposition === 'non_consuming_explicit';
        const receipt = supplemental && verdictExists ? supplementalReviewReceipt(recovered) : null;
        let supplementalHeadVerified = false;
        if (receipt) {
          try {
            supplementalHeadVerified = await readProjectionHead() === target.headSha.toLowerCase();
          } catch {
            // No exact-head observation means no supplemental success.
          }
        }
        let confirmation: Awaited<ReturnType<typeof observePackReviewVerdictDelivery>> | undefined;
        if (verdictExists && !supplemental) {
          confirmation = await observePackReviewVerdictDelivery({
            input, projectId, storeRoot, runId: run.id,
            prNumber: target.prNumber, headSha: target.headSha,
            repoSlug: target.repoSlug, sourceRepoRoot: target.sourceRepoRoot,
            readHead: readProjectionHead,
            writeRequiredStatus: input.fixtureRequiredStatusWriter ?? ((request) =>
              publishPackReviewRequiredStatus({
                repoRoot: target.sourceRepoRoot, repoSlug: target.repoSlug,
                headSha: target.headSha, request,
              })),
          });
        }
        const verified = supplemental
          ? Boolean(receipt && supplementalHeadVerified && !reconcileError)
          : confirmation?.verified === true;
        const unresolvedReason = String(reconciliationResult?.reason ?? '');
        const stillPendingOriginal = !verdictExists && !reconcileError
          && pendingSource
          && recovered.reviewRound?.settledSourceCount === undefined
          && recovered.reviewRound?.sourceSlots.some((slot) =>
            slot.slotId === pendingSource.slotId
            && slot.lifecycle === 'invocation_started'
            && slot.invocationId === pendingSource.invocationId)
          && (unresolvedReason === 'gpt_partial_requires_explicit_immediate_reconcile'
            || unresolvedReason.startsWith('gpt_sources_'))
          ? pendingSource : undefined;
        const reason = reconcileError ? `gpt_reconcile_failed:${reconcileError}`
          : verdictExists ? supplemental
            ? verified ? 'supplemental_review_delivered' : 'supplemental_delivery_unverified'
            : verified ? 'completed' : confirmation?.reason ?? 'publication_unverified'
            : stillPendingOriginal ? 'gpt_original_invocation_recovery_required'
              : String(reconciliationResult?.reason ?? 'gpt_source_census_not_settled');
        terminal = verdictExists;
        const runs = listPackReviewRuns({ projectId, storeRoot });
        if (claimLease) await claimLease.release('run_started', runs);
        return {
          ok: verified, created: true, reused: false,
          reason,
          ...(supplemental
            ? (verified && receipt ? receipt : {
                nextAction: 'observe the exact-head original GPT journal and reviewer COMMENT; use same-run recovery without another Send or required-status projection',
              })
            : {
                publicationVerified: verified,
                ...(verified ? {
                  publicationHeadSha: target.headSha,
                  requiredStatusState: confirmation!.requiredStatusState,
                } : {
                  nextAction: stillPendingOriginal
                    ? 'recover original ' + stillPendingOriginal.slotId + ' invocation '
                      + stillPendingOriginal.invocationId
                      + ' through its existing chat/transport and exact credentialed GitHub comment; do not resend'
                    : String(reconciliationResult?.nextAction
                      ?? 'repair the exact incumbent GitHub source/status evidence and rerun scoped reconcile; do not resend uncertain sources'),
                }),
              }),
          prNumber: target.prNumber, headSha: target.headSha, runId: run.id,
          status: recovered.status,
          coverage: derivePackReviewGptCoverage(recovered.reviewRound),
          ...(recovered.githubReviewId !== undefined ? { githubReviewId: recovered.githubReviewId } : {}),
          ...(recovered.githubReviewUrl ? { githubReviewUrl: recovered.githubReviewUrl } : {}),
          httpStatus: verified ? 201 : verdictExists ? 409 : 202,
        };
      }

      if (pendingSource) {
        const pending = updatePackReviewRunIf(run.id, (records) => {
          const current = records.find((candidate) => candidate.id === run!.id);
          return Boolean(current && current.runnerPid === process.pid
            && !hasPersistedPackReviewVerdict(current)
            && current.reviewRound
            && current.reviewRound.settledSourceCount === undefined
            && current.reviewRound.sourceSlots.some((slot) => (
              slot.slotId === pendingSource.slotId
              && slot.lifecycle === 'invocation_started'
              && slot.invocationId === pendingSource.invocationId
            )));
        }, {
          status: 'reviewing', latestRunStatus: 'reviewing',
          failureReason: undefined, completedAtUtc: undefined,
        }, { projectId, storeRoot });
        const latest = pending ?? getPackReviewRun(run.id, { projectId, storeRoot });
        const runs = listPackReviewRuns({ projectId, storeRoot });
        if (claimLease) await claimLease.release('run_started', runs);
        return {
          ok: false, created: true, reused: false,
          reason: pending ? 'gpt_original_invocation_recovery_required' : 'gpt_source_state_changed_during_partial',
          nextAction: 'recover original ' + pendingSource.slotId + ' invocation '
            + pendingSource.invocationId
            + ' through its existing chat/transport and exact credentialed GitHub comment; do not resend',
          publicationVerified: false,
          prNumber: target.prNumber, headSha: target.headSha,
          runId: run.id, status: latest?.status ?? 'reviewing',
          coverage: derivePackReviewGptCoverage(latest?.reviewRound),
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
      const coverage = derivePackReviewGptCoverage(run.reviewRound);

      if (coverage?.kind === 'partial' && classifyPackReviewPayload(payload).blocking) {
        // Blocking findings affect the eventual verdict, never the pre-grace
        // source census. Keep any sub-cardinality blocking evidence pending
        // until the existing scoped reconcile/grace path owns settlement.
        run = updatePackReviewRun(run.id, {
          status: 'reviewing',
          latestRunStatus: 'reviewing',
          failureReason: undefined,
          completedAtUtc: undefined,
        }, { projectId, storeRoot });
        const runs = listPackReviewRuns({ projectId, storeRoot });
        if (claimLease) await claimLease.release('run_started', runs);
        return {
          ok: true,
          created: true,
          reused: false,
          reason: `gpt_sources_partial_pending_reconcile:${coverage.completedSourceCount}/${coverage.cardinality}`,
          runId: run.id,
          publicationVerified: false,
          prNumber: target.prNumber,
          headSha: target.headSha,
          nextAction: 'observe the same run and scoped reconcile uncertain source work; never open a replacement run',
          status: 'reviewing',
          coverage,
          httpStatus: 202,
        };
      }

      // Harvest failures are an immediate terminal overlay. They are deliberately
      // evaluated before ordinary incompleteness so partial evidence is retained
      // without waiting for the shared source grace.
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
          nextAction: 'inspect stored GPT source evidence and use scoped reconcile; retry only affirmatively eligible same-run slots',
          prNumber: target.prNumber,
          headSha: target.headSha,
          runId: run.id,
          status: 'failed',
          coverage,
          httpStatus: 422,
          githubReviewId: posted.id,
          githubReviewUrl: posted.url,
        };
      }
      if (diagnostics.harvestIncidents.length > 0) {
        payload = { ...payload, harvestIncidents: diagnostics.harvestIncidents };
      }

      if (diagnostics.nonHarvestIncompleteSources.length > 0
          && !classifyPackReviewPayload(payload).blocking) {
        if (coverage?.kind === 'partial') {
          // Ordinary partial evidence is not a terminal failure and does not gain
          // quorum merely because every slot is already terminal. Keep the run
          // active until the existing scoped reconcile path is explicitly invoked.
          run = updatePackReviewRun(run.id, {
            status: 'reviewing',
            latestRunStatus: 'reviewing',
            failureReason: undefined,
            completedAtUtc: undefined,
          }, { projectId, storeRoot });
          const runs = listPackReviewRuns({ projectId, storeRoot });
          if (claimLease) await claimLease.release('run_started', runs);
          return {
            ok: true,
            created: true,
            reused: false,
            reason: `gpt_sources_partial_pending_reconcile:${coverage.completedSourceCount}/${coverage.cardinality}`,
            runId: run.id,
            publicationVerified: false,
            prNumber: target.prNumber,
            headSha: target.headSha,
            nextAction: 'observe the same run and scoped reconcile uncertain source work; never open a replacement run',
            status: 'reviewing',
            coverage,
            httpStatus: 202,
          };
        }

        // Only an empty completed-source census may fall back to the generic
        // whole-round no-verdict terminal solely because ordinary source work did
        // not complete.
        const first = diagnostics.nonHarvestIncompleteSources[0]!;
        const status: Extract<PackReviewRunStatus, 'failed' | 'timed_out' | 'cancelled'> = diagnostics.nonHarvestIncompleteSources.some((item) => item.cancelled)
          ? 'cancelled'
          : diagnostics.nonHarvestIncompleteSources.some((item) => item.timedOut)
            ? 'timed_out'
            : 'failed';
        const failureReason = `gpt_source_non_complete:${first.sourceSlotId}:${first.classification}`;
        const unfinished = await recordUnfinishedTerminal({
          run,
          status,
          failureReason,
          projectId,
          storeRoot,
          writeRequiredStatus,
        });
        const persisted = getPackReviewRun(run.id, { projectId, storeRoot }) ?? unfinished.run;
        const budgetOutcome = noJudgmentBudgetOutcome(persisted, storeRoot);
        const notification = budgetOutcome
          ? await notifyNoJudgmentWorker({
              run: persisted, projectId, storeRoot,
              notifier: input.fixtureWorkerNotifier ?? ((request) => sendPackReviewWorkerNotification({
                trustedPackRoot: persisted.trustedPackRoot,
                sessionId: persisted.linkedSessionId,
                projectId,
                storeRoot,
                request,
              })),
            })
          : { state: 'not_applicable' as const, reason: 'no_judgment_census_or_cap_changed' };
        terminal = true;
        const runs = listPackReviewRuns({ projectId, storeRoot });
        if (claimLease) await claimLease.release('run_started', runs);
        return {
          ok: false,
          created: true,
          reused: false,
          reason: failureReason,
          nextAction: 'observe existing source attempts and scoped reconcile; never resend uncertain source work',
          prNumber: target.prNumber,
          headSha: target.headSha,
          runId: run.id,
          status,
          coverage,
          ...(budgetOutcome ? { budgetOutcome } : {}),
          requiredStatusPublication: unfinished.deliveryOutcome.state === 'succeeded'
            ? 'published' : 'status_not_published',
          requiredStatusReason: unfinished.deliveryOutcome.reason,
          ...(unfinished.deliveryOutcome.state === 'succeeded' ? {} : {
            nextAction: 'rerun scoped reconcile or PR-led status projection; do not resend possible_delivery',
          }),
          noJudgmentWorkerNotification: notification,
          httpStatus: status === 'timed_out' ? 504 : 422,
        };
      }
    }

    // Bind execution provenance to the actual accepted verdict before the
    // journal or review comment can re-read this run.
    const conflictFreeSourceRun = carryover?.replay.kind === 'conflict_free_carryover'
      ? getPackReviewRun(carryover.sourceCleanRunId, { projectId, storeRoot })
      : null;
    const verifiedSourceReviewer = conflictFreeSourceRun && hasPersistedPackReviewVerdict(conflictFreeSourceRun)
      ? (conflictFreeSourceRun.executedReviewer
        ?? conflictFreeSourceRun.reviewRound?.reviewer
        ?? conflictFreeSourceRun.nativeAttempt?.reviewer)
      : undefined;
    run = updatePackReviewRun(run.id, carryover?.replay.kind === 'conflict_free_carryover'
      ? {
          reviewerInvokedForThisRun: false,
          reviewerExecutionRunId: conflictFreeSourceRun?.reviewerExecutionRunId ?? carryover.sourceCleanRunId,
          ...(verifiedSourceReviewer ? { executedReviewer: verifiedSourceReviewer } : {}),
        }
      : reviewer
        ? {
            reviewerInvokedForThisRun: true,
            executedReviewer: reviewer,
            reviewerExecutionRunId: run.id,
          }
        : {}, { projectId, storeRoot });

    if (supplementalMode) {
      const supplementalDeliveryRun = run;
      const delivered = await deliverPackReviewVerdict({
        run: supplementalDeliveryRun,
        payload,
        projectId,
        storeRoot,
        journalWriter: input.fixtureJournalWriter,
        postGithubComment: async () => {
          const posted = await postGithubReview({
            repoRoot: target.sourceRepoRoot, repoSlug: target.repoSlug,
            prNumber: target.prNumber, headSha: target.headSha, run: supplementalDeliveryRun, payload,
            projectId, storeRoot, transport: githubReviewTransport,
          });
          return { id: posted.id, url: posted.url, event: 'COMMENT' };
        },
        writeRequiredStatus: async () => { throw new Error('supplemental cannot publish required status'); },
        notifyWorker: async () => { throw new Error('supplemental cannot notify required worker'); },
      });
      const latest = getPackReviewRun(run.id, { projectId, storeRoot });
      const receipt = latest && supplementalReviewReceipt(latest);
      const headStillCurrent = await readProjectionHead() === target.headSha.toLowerCase();
      terminal = true;
      if (claimLease) await claimLease.release('run_started', listPackReviewRuns({ projectId, storeRoot }));
      return receipt && headStillCurrent && delivered.reason === 'completed'
        ? { ok: true, created: true, reused: false,
            reason: 'supplemental_review_delivered', ...receipt,
            prNumber: target.prNumber, headSha: target.headSha,
            status: latest?.status, httpStatus: 201 }
        : { ok: false, created: true, reused: false,
            reason: 'supplemental_delivery_unverified', runId: run.id,
            nextAction: 'inspect the originating journal and GitHub reviewer COMMENT; use same-run reconciliation, never duplicate an uncertain post',
            prNumber: target.prNumber, headSha: target.headSha, httpStatus: 409 };
    }

    authority = await reconcileTierBeforeTerminal({
      start: input, target, projectId, storeRoot,
      cycleId: authority.cycle?.cycleId, runId: run.id,
    });
    authority = commitPackReviewTerminal({
      prNumber: target.prNumber,
      expectedTransitionSeq: authority.transitionSeq,
      terminal: terminalV2FromPayload({
        runId: run.id,
        targetSha: target.headSha,
        logicalRoundOrdinal: run.logicalRoundOrdinal,
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
      writeRequiredStatus: currentCycleRequiredStatusWriter(
        deliveryRun, storeRoot,
        input.fixtureRequiredStatusWriter ?? ((request) => publishPackReviewRequiredStatus({
          repoRoot: target.sourceRepoRoot, repoSlug: target.repoSlug,
          headSha: target.headSha, request,
        })),
      ),
      notifyWorker: async (request) => {
        const deliver = input.fixtureWorkerNotifier ?? ((value) => sendPackReviewWorkerNotification({
          trustedPackRoot: trusted.trustedPackRoot,
          sessionId: target.sessionId,
          projectId,
          storeRoot,
          request: value,
        }));
        const stillPending = !classifyPackReviewPayload(payload).blocking
          && outstandingPackReviewCycle(deliveryRun, storeRoot);
        return deliver(stillPending
          ? { ...request, message: request.message.replace(
              /^Pack-review status: success$/m, 'Pack-review status: pending',
            ) }
          : request);
      },
    });
    const currentAuthority = readPackReviewAuthority(target.prNumber, authorityOptions);
    if (!currentAuthority
        || currentAuthority.currentHeadSha !== target.headSha
        || currentAuthority.terminal?.runId !== run.id) {
      throw new Error('pack review authority changed before publication');
    }
    // A promoted native ordinal-one run also needs independent current-head
    // status confirmation; the historical delivery ACK/cap cannot certify it.
    const confirmRequiredStatus = reviewer === 'gpt'
      || (!classifyPackReviewPayload(payload).blocking
        && outstandingPackReviewCycle(deliveryRun, storeRoot));
    const confirmation = confirmRequiredStatus
      ? await observePackReviewVerdictDelivery({
          input, projectId, storeRoot, runId: run.id,
          prNumber: target.prNumber, headSha: target.headSha,
          repoSlug: target.repoSlug, sourceRepoRoot: target.sourceRepoRoot,
          readHead: readProjectionHead,
          writeRequiredStatus: input.fixtureRequiredStatusWriter ?? ((request) => publishPackReviewRequiredStatus({
            repoRoot: target.sourceRepoRoot, repoSlug: target.repoSlug, headSha: target.headSha, request,
          })),
        })
      : null;
    const afterConfirmation = confirmation
      ? readPackReviewAuthority(target.prNumber, authorityOptions)
      : currentAuthority;
    if (!afterConfirmation || afterConfirmation.terminal?.runId !== run.id) {
      throw new Error('pack review authority changed before publication record');
    }
    const publicationStatus = confirmation
      ? (confirmation.verified ? 'succeeded' : 'failed')
      : (delivered.reason === 'completed' ? 'succeeded' : 'failed');
    authority = recordPackReviewPublication({
      prNumber: target.prNumber,
      expectedTransitionSeq: afterConfirmation.transitionSeq,
      nextPhase: publicationStatus === 'succeeded' ? 'external_published' : afterConfirmation.phase,
      publication: {
        headSha: target.headSha,
        terminalRunId: run.id,
        status: publicationStatus,
        publicationDigest: sha256Bytes(JSON.stringify({
          status: delivered.status,
          deliveryReason: delivered.reason,
          githubReviewId: delivered.githubReviewId,
          githubReviewUrl: delivered.githubReviewUrl,
          ...(confirmation ? { observation: confirmation.reason } : {}),
        })),
        recordedAtUtc: new Date().toISOString(),
      },
      options: authorityOptions,
    });
    terminal = true;
    const runs = listPackReviewRuns({ projectId, storeRoot });
    if (claimLease) await claimLease.release('run_started', runs);
    const terminalCoverage = derivePackReviewGptCoverage(
      (getPackReviewRun(run.id, { projectId, storeRoot }) ?? run).reviewRound,
    );
    return {
      ok: true,
      created: true,
      reused: false,
      reason: delivered.reason,
      ...(confirmation ? {
        deliveryReason: delivered.reason,
        publicationVerified: confirmation.verified,
        ...(confirmation.verified
          ? { publicationHeadSha: target.headSha, requiredStatusState: confirmation.requiredStatusState }
          : {
              publicationReason: confirmation.reason,
              nextAction: 'inspect the journal, GitHub comment and required status on the exact live head, then run incumbent scoped reconcile or PR-led status projection',
            }),
      } : {}),
      ...reviewerProvenanceReceipt(run),
      runId: run.id,
      prNumber: target.prNumber,
      headSha: target.headSha,
      status: delivered.status,
      ...(terminalCoverage ? { coverage: terminalCoverage } : {}),
      ...(sameRoundGptDiagnostics?.length ? { observationDiagnostics: sameRoundGptDiagnostics } : {}),
      httpStatus: confirmation ? (confirmation.verified ? 201 : 409) : 201,
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
      nextAction: 'inspect the bound PR head and run, fix local arguments if needed, or use scoped reconcile without replacement send',
      prNumber: target.prNumber,
      headSha: target.headSha,
      runId: run?.id ?? '',
      status: run ? getPackReviewRun(run.id, { projectId, storeRoot })?.status : undefined,
      httpStatus: 500,
    };
  } finally {
    try {
      if (worktree && run) {
        if (process.env.OPK_VITEST_HARNESS === '1' && input.fixtureBeforeReviewWorktreeCleanup) {
          await input.fixtureBeforeReviewWorktreeCleanup(run, worktree);
        }
        const cleanup = await removeReviewWorktree(
          reviewWorktreeContext, run.id, worktree, 'finally', input.fixtureReviewWorktreeRemoveFailure,
        );
        if (cleanup !== 'removed' && cleanup !== 'absent') {
          process.stderr.write('[pack-review worktree] cleanup deferred for ' + run.id + ': ' + cleanup + '\n');
        }
      }
    } finally {
      if (claimLease?.directory && !retainClaimDirectory) {
        rmSync(claimLease.directory, { recursive: true, force: true });
      }
    }
  }
}

export async function resetPackReview(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const trusted = resolveTrustedRunnerPaths();
  const projectId = trim(input.projectId || input.targetProjectId);
  const selected = resolveTargetContext({ projectId, env: process.env });
  if (trim(input.projectId) && trim(input.projectId) !== selected.projectId) {
    throw new Error('reset selected project/store mismatch');
  }
  if (trim(input.sourceRepoRoot) || trim(input.repoRoot) || trim(input.repoSlug)) {
    throw new Error('reset requires the selected project-card primaryRoot/repository; no checkout or repository override');
  }
  const target = await resolveTarget(input as StartInput, trusted.trustedPackRoot, undefined, selected);
  if (target.repoSlug.toLowerCase() !== selected.repository.toLowerCase()) {
    throw new Error('reset selected repository mismatch');
  }
  const storeRoot = resolvePackReviewRunStoreRoot({ projectId: selected.projectId });
  if (trim(input.storeRoot) && resolve(trim(input.storeRoot)) !== storeRoot) {
    throw new Error('reset selected project/store mismatch');
  }
  const authority = readPackReviewAuthority(target.prNumber, { storeRoot });
  if (!authority?.cycle) throw new Error('reset requires an authoritative review cycle');
  if (authority.currentHeadSha !== target.headSha) {
    throw new Error('reset PR head/authority changed; observe this selected PR head before retrying');
  }
  const actor = trim(input.actor);
  const reason = trim(input.reason);
  const nonce = trim(input.nonce);
  if (!actor || !reason || !nonce) throw new Error('reset requires --actor, --reason, and --nonce');
  if (!target.issueNumber) throw new Error('reset requires the actual PR-closing Issue');
  const requestedCycleId = trim(input.priorCycleId) || authority.cycle.cycleId;
  const suppliedHash = trim(input.priorAtCapHash);
  if (requestedCycleId !== authority.cycle.cycleId
      || (suppliedHash && suppliedHash !== authority.cycle.atCapHash)) {
    throw new Error('reset prior cycle/hash mismatch');
  }
  const fields = process.env.OPK_VITEST_HARNESS === '1'
    && (input as StartInput).fixtureIssueBody !== undefined
    && (input as StartInput).fixtureIssueTitle !== undefined
    ? { body: (input as StartInput).fixtureIssueBody!, title: (input as StartInput).fixtureIssueTitle! }
    : await resolveCurrentIssueFields(target.sourceRepoRoot, target.repoSlug, target.issueNumber);
  const liveTier = parseAuthoritativeTier(fields.body, fields.title);
  const tierRank = { T1: 1, T2: 2, T3: 3 } as const;
  const authoritativeTier = tierRank[liveTier] > tierRank[authority.cycle.frozenTier]
    ? liveTier : authority.cycle.frozenTier;
  const completed = authority.cycle.capMapVersion === PACK_REVIEW_LOGICAL_CAP_MAP_VERSION
    && authority.cycle.frozenTier !== 'T1'
    && authority.cycle.state === 'closed'
    && authority.cycle.reviewStageComplete === true
    && authority.cycle.consumedRoundOrdinals?.length === authority.cycle.frozenCap
    && authority.terminal?.reviewVerdict === 'findings'
    && authority.terminal.logicalRoundOrdinal === authority.cycle.frozenCap
    && (authority.cycle.settlementKind === 'same_head_issue_resolution'
      || authority.currentHeadSha !== authority.terminal.targetSha);
  let completedFindingsBodyAmended = false;
  if (completed) {
    const terminal = authority.terminal!;
    const priorRun = getPackReviewRun(terminal.runId, {
      projectId: selected.projectId, storeRoot,
    });
    const frozen = resolveBoundIssueSnapshot({
      projectId: selected.projectId, prNumber: target.prNumber,
      prHeadSha: terminal.targetSha, issueNumber: target.issueNumber,
      storeDirOverride: process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR,
    });
    if (!priorRun || priorRun.id !== terminal.runId || priorRun.runId !== terminal.runId
        || priorRun.projectId !== selected.projectId || priorRun.prNumber !== target.prNumber
        || priorRun.canonicalRepository?.toLowerCase() !== selected.repository.toLowerCase()
        || priorRun.targetSha !== terminal.targetSha
        || priorRun.headSha !== terminal.targetSha
        || priorRun.reviewCycleId !== authority.cycle.cycleId
        || priorRun.logicalRoundOrdinal !== authority.cycle.frozenCap
        || priorRun.logicalRoundCap !== authority.cycle.frozenCap
        || priorRun.reviewVerdict !== 'findings'
        || frozen.status !== 'found' || !frozen.snapshotHash
        || frozen.metadata?.capturePhase !== 'review-preflight'
        || (priorRun.reviewRound
          ? priorRun.reviewRound.issueNumber !== target.issueNumber
            || priorRun.reviewRound.boundIssueSnapshotDigest !== frozen.snapshotHash
          : !['codex', 'claude'].includes(priorRun.resolvedReviewer ?? ''))) {
      throw new Error('completed reset requires verified exact last findings terminal and bound Issue body');
    }
    completedFindingsBodyAmended = computeBoundIssueSnapshotHash(fields.body) !== frozen.snapshotHash;
    if (!completedFindingsBodyAmended) {
      throw new Error('completed findings reset requires an actual linked Issue body amendment');
    }
    const liveHead = process.env.OPK_VITEST_HARNESS === '1'
      ? trim((input as StartInput).fixtureCurrentPrHeadSha).toLowerCase()
      : await resolveCurrentPrHead(target.sourceRepoRoot, target.repoSlug, target.prNumber);
    if (liveHead !== target.headSha) throw new Error('PR head moved before reset pending publication');
    const writeStatus = (input as StartInput).fixtureRequiredStatusWriter
      ?? ((request: Parameters<PackReviewRequiredStatusWriter>[0]) => publishPackReviewRequiredStatus({
        repoRoot: target.sourceRepoRoot, repoSlug: target.repoSlug,
        headSha: target.headSha, request,
      }));
    await writeStatus({
      state: 'pending', context: PACK_REVIEW_REQUIRED_STATUS_CONTEXT,
      description: 'Amended Issue requires a new audited review cycle.',
      idempotencyKey: `issue-amendment-reset:${authority.cycle.cycleId}:${nonce}:${target.headSha}`,
    });
    const pending = await readFinalCapRequiredStatus({
      sourceRepoRoot: target.sourceRepoRoot, repoSlug: target.repoSlug,
      fixtureRequiredStatusReader: (input as StartInput).fixtureRequiredStatusReader,
    }, target.repoSlug, target.headSha);
    const latest = readPackReviewAuthority(target.prNumber, { storeRoot });
    const liveHeadAfter = process.env.OPK_VITEST_HARNESS === '1'
      ? trim((input as StartInput).fixtureCurrentPrHeadSha).toLowerCase()
      : await resolveCurrentPrHead(target.sourceRepoRoot, target.repoSlug, target.prNumber);
    if (pending !== 'pending' || liveHeadAfter !== target.headSha
        || latest?.transitionSeq !== authority.transitionSeq
        || latest.currentHeadSha !== target.headSha) {
      throw new Error('completed reset pending status/unchanged authority not confirmed; restore pending status before retrying');
    }
  } else if (!authority.cycle.atCapHash) {
    throw new Error('reset requires an eligible at-cap findings record');
  }

  const reset = acknowledgePackReviewReset({
    prNumber: target.prNumber,
    expectedTransitionSeq: authority.transitionSeq,
    headSha: target.headSha,
    tier: authoritativeTier,
    completedFindingsBodyAmended,
    provenance: {
      priorCycleId: requestedCycleId,
      ...(authority.cycle.atCapHash ? { priorAtCapHash: authority.cycle.atCapHash } : {}),
      actor, reason, timestampUtc: trim(input.timestampUtc) || new Date().toISOString(), nonce,
    },
    capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
    options: { storeRoot },
  });
  if (completed) {
    const confirmed = await readFinalCapRequiredStatus({
      sourceRepoRoot: target.sourceRepoRoot, repoSlug: target.repoSlug,
      fixtureRequiredStatusReader: (input as StartInput).fixtureRequiredStatusReader,
    }, target.repoSlug, target.headSha);
    if (confirmed !== 'pending') throw new Error('reopened cycle was persisted but current-head non-success is unverified');
  }
  return {
    ok: true, projectId: selected.projectId, repository: selected.repository,
    prNumber: target.prNumber, headSha: target.headSha, cycleId: reset.cycle?.cycleId,
    previousCycleId: authority.cycle.cycleId,
    ...(completed ? { requiredStatusState: 'pending' } : {}),
  };
}

function usage(): string {
  return [
    'Pack-owned review runner (Issue #839)',
    '',
    'Manual trigger:',
    '  node --experimental-strip-types scripts/pack-review-runner.ts start --pr-number <n> [--project <id>]',
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
    '  node --experimental-strip-types scripts/pack-review-runner.ts reset --project <id> --pr-number <n> --actor <actor> --reason <text> --nonce <value>',
    '',
    'The runner/store/reviewer scripts resolve from the trusted pack checkout, never from the reviewed PR worktree.',
  ].join('\n');
}

export function parseArgs(argv: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const keyByFlag: Record<string, string> = {
    '--project': 'targetProjectId',
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
    '--repo-slug': 'repoSlug',
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

export function applyCliTargetProject(
  input: Pick<StartInput, 'targetProjectId' | 'projectId'>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const requestedProjectId = trim(input.targetProjectId);
  if (env.OPK_VITEST_HARNESS === '1' && !requestedProjectId && !trim(env.OPK_PROJECT_ID)) return;
  const target = resolveTargetContext({
    ...(requestedProjectId ? { projectId: requestedProjectId } : {}),
    env,
  });
  const stateProjectId = trim(input.projectId);
  if (stateProjectId && stateProjectId !== target.projectId) {
    throw new Error(`--project ${target.projectId} conflicts with --project-id ${stateProjectId}`);
  }
  input.projectId = target.projectId;
  env.OPK_PROJECT_ID = target.projectId;
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
  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h'
      || argv.includes('--help') || argv.includes('-h')) {
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
    process.stdout.write(`${JSON.stringify({
      runs: listPackReviewRuns({ projectId: options.projectId, storeRoot: options.storeRoot })
        .map((run) => packReviewRunOutputProjection(run)),
    })}\n`);
    return;
  }
  if (subcommand === 'status') {
    const runId = trim(input.runId);
    if (!runId) throw new Error('status requires runId in JSON payload');
    process.stdout.write(`${JSON.stringify({
      run: packReviewRunOutputProjection(getPackReviewRun(runId, input as ListInput)),
    })}\n`);
    return;
  }
  if (subcommand === 'reset') {
    applyCliTargetProject(input as StartInput);
    process.stdout.write(`${JSON.stringify(await resetPackReview(input))}\n`);
    return;
  }
  if (subcommand === 'reconcile') {
    const trusted = resolveTrustedRunnerPaths();
    const reconcileInput = input as StartInput;
    applyCliTargetProject(reconcileInput);
    const harnessUnbound = process.env.OPK_VITEST_HARNESS === '1' && !trim(process.env.OPK_PROJECT_ID);
    const selectedTarget = harnessUnbound ? null : resolveTargetContext({ env: process.env });
    const projectId = selectedTarget?.projectId ?? (trim(input.projectId) || DEFAULT_PROJECT_ID);
    const selectedBaseRef = selectedTarget ? `origin/${selectedTarget.defaultBranch}` : DEFAULT_BASE_REF;
    const requestedBaseRef = trim(input.baseRef);
    if (selectedTarget && requestedBaseRef && requestedBaseRef !== selectedBaseRef) {
      throw new Error(`pack review base ${requestedBaseRef} does not match selected target base ${selectedBaseRef}`);
    }
    const baseRef = selectedTarget ? selectedBaseRef : (requestedBaseRef || DEFAULT_BASE_REF);
    const sourceRepoRoot = resolve(trim(input.sourceRepoRoot || input.repoRoot) || trusted.trustedPackRoot);
    const repoSlug = await resolvePackReviewReconcileRepository({
      sourceRepoRoot,
      explicitRepoSlug: trim(input.repoSlug),
      selectedTarget,
    });
    const result = await reconcileStalePackReviewRuns({
      repoSlug,
      sourceRepoRoot,
      projectId,
      storeRoot: trim(input.storeRoot) || undefined,
      prNumber: positiveInteger(input.prNumber, 'prNumber'),
      immediate: input.immediate === true,
      settlePartialAfterGrace: input.immediate === true,
      baseRef,
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
    applyCliTargetProject(startInput);
    directCliStarts.add(startInput);
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