#!/usr/bin/env -S node --experimental-strip-types

import './toolchain/native-entrypoint-preflight.ts';
import { classifyRequiredCiLevel } from '../docs/review-ready-stuck-guard.mjs';
import { runProcess, runProcessSync } from './kernel/subprocess.ts';
import { overlayExecutorProfileEnv } from './executor-profile-store.ts';
import { resolveTrackedGhWrapper } from './lib/gh-resolve-real-binary.mjs';
import { ISSUE_LINK_PATTERN, prBodyScannableForIssueLinks } from './pr-scope-contract.ts';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildExecutorCommand,
  buildOpenCodeAgentOverlay,
  openCodeAgentSemantics,
  openCodeConfigPaths,
  CURSOR_SMOKE_CAPABILITY,
  evaluateExecutorRouteAdmission,
  evaluateExecutorSpawnApplicability,
  EXECUTOR_FAMILY_DESCRIPTORS,
  executorCatalogContains,
  OPENCODE_PACK_AGENT,
  openCodeEdgeCapabilities,
  profileNamesForSmoke,
  resolveSemanticExecutorProfile,
  type ExecutorFamily,
  type SemanticExecutorProfile,
} from './executor-profile-policy.ts';
import {
  buildSmokeAgentPrompt,
  buildSmokeGhChildEnv,
  checkSmokeTestPlan,
  createSmokeCompletionObservationState,
  createSmokeRunIdentity,
  detectTrackedImplementationMutation,
  ensureSmokeRunArtifactDir,
  evaluateWorkerSmokeCoverage,
  evaluateWorkerSmokeGate,
  formatSmokeReportComment,
  hasPreexistingTrackedDirtiness,
  inspectSmokeProgress,
  isProvenCarryOnlySmokeReport,
  isWorkerSmokeScenarioCauseFamily,
  normalizeSmokeReport,
  observeSmokeCancellationAcknowledgement,
  observeSmokeCompletionEvidence,
  observeSmokeDeliveryEstablished,
  parseSmokeAgentReport,
  planWorkerSmokeSelectiveRetry,
  projectWorkerSmokeSelectiveReport,
  resolveSmokeRequirement,
  resolveSmokeRunArtifactDir,
  scrubForwardedGhSecrets,
  scrubSmokeOutput,
  smokeReportHasPackProducer,
  smokeResultForWorkerSmokeCauseFamily,
  SMOKE_REPORT_PRODUCER,
  trackedPorcelainPaths,
  verifySmokeHeadBinding,
  workerSmokeCauseFamilyForHarnessReason,
  writeSmokeCancelRequest,
  type SmokeReport,
  type SmokeRunBinding,
  type SmokeTestPlan,
  type WorkerSmokeCauseFamily,
  type WorkerSmokeCommentRecord,
  type WorkerSmokeSelectiveRetryPlan,
  type WorkerSmokeTrustedTarget,
} from './lib/worker-smoke-core.ts';
import {
  bindSmokeTerminalHandle,
  cleanupSmokeLifecycle,
  createSmokeLifecycleReservation,
  createSmokeNoExecutionLifecycle,
  evaluateSmokeLifecycleCleanliness,
  hasValidSmokeCloseReceipt,
  markSmokeCreateAmbiguous,
  markSmokeCreateInProgress,
  markSmokeLauncherTerminalized,
  preflightSmokeLifecycle,
  readSmokeLifecycleRegistry,
  releaseSmokeAdmission,
  SMOKE_ABSOLUTE_CEILING_MS,
  SMOKE_CREATE_TIMEOUT_MS,
  SMOKE_DELIVERY_TIMEOUT_MS,
  SMOKE_LIFECYCLE_POLL_MS,
  SMOKE_ORCA_OPERATION_TIMEOUT_MS,
  SMOKE_PROGRESS_STALL_MS,
  SMOKE_SHUTDOWN_TIMEOUT_MS,
  smokeCancelAcknowledgementPath,
  smokeCancelRequestPath,
  smokeProgressPath,
} from './lib/worker-smoke-lifecycle.ts';
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

import { markTrackedSmokeWorkerDeliveryConfirmed } from './lib/worker-smoke-bounded-create.ts';
import {
  evaluateSameHeadBlockedRetryAdmission,
  listWorkerSmokeReceipts,
  readWorkerSmokeRunFinalEvidence,
  smokeRunFinalEvidencePath,
  validateWorkerSmokeOperatorOverrideReason,
  verifySmokeReportReceiptProvenance,
  verifySmokeRunReceipt,
  writeWorkerSmokeReceipt,
  writeWorkerSmokeRunFinalEvidence,
  type WorkerSmokeAttemptObservation,
  type WorkerSmokeExecutionMode,
} from './lib/worker-smoke-receipt.ts';
import {
  commitSmokeOrderingTransition,
  initializePackReviewAuthority,
  observePackReviewHead,
  packReviewFindingsSatisfiedByStrictDescendant,
  PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
  readPackReviewAuthority,
  settleLogicalPackReviewFindingsByStrictDescendant,
  smokeOrderingRequired,
  type PackReviewAuthorityOptions,
  type PackReviewTier,
  type SmokeOrderingActor,
  type SmokeOrderingOwnerEvidence,
} from './pack-review-state.ts';
import {
  listPackReviewRuns,
  resolvePackReviewRunStoreRoot,
} from './lib/pack-review-run-store.ts';
import { parseComplexityTierFence } from './lib/tier-gate-core.ts';
import { resolveTierAndCap } from '../docs/review-cycle-cap.mjs';
import { selectRuntimeAdapter } from './runtime/registry.ts';
import {
  currentWorkerAssignment,
  resolveWorkerAssignmentStorePath,
  sameDelegatedIntegrationMarker,
} from './lib/worker-assignment-store.ts';
import { resolveCurrentWorkerAssignmentBindings } from './lib/worker-assignment-runtime.ts';
import {
  evictWorkerReportRecords,
  listWorkerReportRecordsForAssignment,
  readWorkerReportStoreFile,
  resolveWorkerReportStorePath,
} from '../docs/worker-report-store.mjs';
import {
  evaluateWorkerStatusKillSwitch,
  readWorkerStatusStoreFile,
  resolveWorkerStatusStorePath,
  testSiblingReadiness,
} from './lib/worker-status-store.mjs';
import {
  assignmentsToStatusSessions,
  buildWorkerStatusReport,
} from './json-producers/worker-status-report.ts';
import {
  evaluateReadiness,
  selectAcceptedCurrentWorkerReport,
  type ReadinessResult,
} from './pr2-foundation/readiness-evaluator.ts';
import {
  createGithubReviewTransport,
  parseDirectPackReviewEvidence,
  projectDirectPackReviewState,
  type DirectPackReviewProjection,
  type GithubReviewSummary,
} from './lib/github-review-reconciliation.ts';
import {
  PACK_REVIEW_REQUIRED_STATUS_CONTEXT,
  projectPackReviewSemanticStatus,
  projectRunnerPackReviewStatusFromCombined,
  publishPackReviewRequiredStatus,
  semanticPackReviewRequiredStatusRequest,
  type PackReviewSemanticSourceState,
  type PackReviewSemanticProjection,
} from './lib/pack-review-delivery.ts';
import type {
  RuntimeAdapter,
  RuntimeObservationToken,
  RuntimeOperationFailure,
  RuntimeWorkerIdentity,
} from './runtime/contracts.ts';

export interface CliOptions {
  command: string;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  issueBodyFile: string;
  smokeComplexity: SmokeComplexity | '';
  smokeActor?: SmokeOrderingActor;
  operatorSmokeOnly?: boolean;
  operatorOverrideReason?: string;
  repoRoot: string;
  cwd: string;
  dryRun: boolean;
  json: boolean;
  reviewId: string;
  reviewHeadSha: string;
  detach?: boolean;
  detachedOwner?: boolean;
  runId?: string;
}

export type SmokeComplexity = 'routine' | 'complex';

export interface SmokeExecutorProfile {
  readonly complexity: SmokeComplexity;
  readonly family: ExecutorFamily;
  readonly agent: string;
  readonly command: string;
  readonly names: readonly [string, string, string];
}

export type SmokeStartFenceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string; readonly actionEntered: boolean };

export interface SmokeAttemptDependencies {
  readonly adapter?: RuntimeAdapter;
  readonly startFence?: <T>(action: () => T | Promise<T>) => Promise<SmokeStartFenceResult<T>>;
  readonly resolveProfile?: (
    complexity: SmokeComplexity | string,
    env: Readonly<NodeJS.ProcessEnv>,
  ) => SmokeExecutorProfile;
  readonly resolveIssueBody?: (options: CliOptions, suppliedIssueBody: string) => string;
  readonly resolveTarget?: (options: CliOptions, suppliedIssueBody: string) => ResolvedSmokeTarget;
  readonly fetchHistoryComments?: (
    prNumber: number,
    repositorySlug: string,
    repoRoot: string,
  ) => WorkerSmokeCommentRecord[];
  readonly isHistoryAncestor?: (
    ancestorSha: string,
    descendantSha: string,
    target: ResolvedSmokeTarget,
    options: CliOptions,
  ) => boolean;
  readonly publishComment?: (prNumber: number, body: string, repoRoot: string) => void;
}

interface SmokeChildResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr?: string;
}

type SmokeChildExecutor = (args: readonly string[], env?: Readonly<NodeJS.ProcessEnv>) => SmokeChildResult;

function smokeSemanticProfile(
  complexity: SmokeComplexity | string,
  env: Readonly<NodeJS.ProcessEnv>,
): SemanticExecutorProfile {
  if (complexity !== 'routine' && complexity !== 'complex') throw new Error('smoke_complexity_unsupported');
  const names = profileNamesForSmoke(complexity);
  const resolved = resolveSemanticExecutorProfile({ surface: 'smoke', names, env });
  if (resolved.ok) return resolved.profile;
  if (resolved.code === 'executor_profile_missing') throw new Error(`smoke_profile_missing:${resolved.variables.join(',')}`);
  if (resolved.code === 'executor_profile_malformed') throw new Error(`smoke_profile_malformed:${resolved.variables.join(',')}`);
  throw new Error(`smoke_profile_unsupported_agent:${resolved.variables[0]}`);
}

function smokeProfileFromSemantic(
  complexity: SmokeComplexity,
  profile: SemanticExecutorProfile,
): SmokeExecutorProfile {
  const invocation = buildExecutorCommand(profile);
  return {
    complexity,
    family: profile.family,
    agent: invocation.executable,
    command: invocation.command,
    names: profile.names,
  };
}

export function resolveSmokeExecutorProfile(
  complexity: SmokeComplexity | string,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): SmokeExecutorProfile {
  const profile = smokeSemanticProfile(complexity, env);
  const capability = profile.family === 'cursor'
    ? CURSOR_SMOKE_CAPABILITY
    : { available: false, supportsModel: false, supportsEffort: false };
  const verdict = evaluateExecutorSpawnApplicability(capability);
  if (!verdict.ok) throw new Error(verdict.refusal);
  return smokeProfileFromSemantic(complexity as SmokeComplexity, profile);
}

export function resolveLiveSmokeExecutorProfile(
  complexity: SmokeComplexity | string,
  env: Readonly<NodeJS.ProcessEnv>,
  execute: SmokeChildExecutor,
  cwd = process.cwd(),
  proveNoWrite?: OpenCodeNoWriteProof,
): SmokeExecutorProfile {
  const profile = smokeSemanticProfile(complexity, env);
  const descriptor = EXECUTOR_FAMILY_DESCRIPTORS[profile.family];
  const catalog = execute(descriptor.catalogCommand);
  if (!catalog.ok) throw new Error('executor_profile_applicability_unproven');
  if (!executorCatalogContains(profile, catalog.stdout)) throw new Error('executor_profile_model_unavailable');

  let capability = CURSOR_SMOKE_CAPABILITY;
  if (profile.family === 'opencode') {
    const observations: string[] = [];
    const inlineConfig = JSON.stringify({ agent: { [OPENCODE_PACK_AGENT]: { model: profile.model, variant: profile.effort } } });
    for (const probe of descriptor.capabilityProbeCommands) {
      const isDebugProbe = probe[0] === 'opencode' && probe[1] === 'debug';
      const result = isDebugProbe ? execute(probe, { OPENCODE_CONFIG_CONTENT: inlineConfig }) : execute(probe);
      if (!result.ok) throw new Error('executor_route_unavailable');
      observations.push(`${result.stdout}\n${result.stderr ?? ''}`);
    }
    const edgeCapabilities = openCodeEdgeCapabilities(observations, profile);
    const routeVerdict = evaluateExecutorRouteAdmission({
      profile,
      startMode: 'exact_terminal_worktree',
      edgeCapabilities,
    });
    if (!routeVerdict.ok) throw new Error(routeVerdict.refusal);
    capability = edgeCapabilities.exactTerminal;
  }
  const verdict = evaluateExecutorSpawnApplicability(capability);
  if (!verdict.ok) throw new Error(verdict.refusal);

  let finalProfile = profile;
  let finalCommand: string | undefined;
  if (profile.family === 'opencode') {
    const finalized = smokeFinalizeOpenCode(profile, cwd, execute, proveNoWrite);
    finalProfile = finalized.profile;
    finalCommand = finalized.command;
  }

  const inherited = execute([
    process.execPath,
    '--input-type=module',
    '-e',
    'const n=process.argv.slice(1);process.exit(n.every((k)=>typeof process.env[k]==="string"&&process.env[k].trim())?0:1)',
    ...profile.names,
  ]);
  if (!inherited.ok) throw new Error('executor_profile_child_inheritance_unproven');
  const smokeProfile = smokeProfileFromSemantic(complexity as SmokeComplexity, finalProfile);
  return finalCommand ? { ...smokeProfile, command: finalCommand } : smokeProfile;
}

function smokeConfigState(cwd: string, env: Readonly<NodeJS.ProcessEnv> = process.env): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  const roots = openCodeConfigPaths(cwd, configHome, env);
  const rows: string[] = [];
  const visit = (path: string): void => {
    if (!existsSync(path)) { rows.push(`${path}:absent`); return; }
    const stat = statSync(path);
    if (stat.isDirectory()) { rows.push(`${path}:directory`); for (const child of readdirSync(path).sort()) visit(join(path, child)); }
    else rows.push(`${path}:${stat.size}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
  };
  for (const root of roots) visit(root);
  return rows.join('\n');
}

function proveOpenCodeNoWrite(cwd: string): boolean {
  const before = smokeConfigState(cwd);
  return before === smokeConfigState(cwd);
}

type OpenCodeNoWriteProof = (cwd: string) => boolean;

function smokeFinalizeOpenCode(profile: SemanticExecutorProfile, cwd: string, execute: SmokeChildExecutor, proveNoWrite?: OpenCodeNoWriteProof): { profile: SemanticExecutorProfile; command: string } {
  if (!proveNoWrite || !proveNoWrite(cwd)) throw new Error('executor_effort_channel_unavailable');
  const before = smokeConfigState(cwd);
  const stateRoot = join(tmpdir(), `opk-opencode-state-${randomUUID()}`);
  const isolatedEnv = { XDG_STATE_HOME: stateRoot };
  const config = execute(['opencode', 'debug', 'config'], isolatedEnv);
  if (!config.ok || before !== smokeConfigState(cwd)) throw new Error('executor_effort_channel_unavailable');
  let parsed: Record<string, unknown>;
  try { const value: unknown = JSON.parse(config.stdout); if (!record(value)) throw new Error(); parsed = value; } catch { throw new Error('executor_effort_channel_unavailable'); }
  const defaultAgent = typeof parsed.default_agent === 'string' ? parsed.default_agent.trim() : '';
  if (!defaultAgent) throw new Error('executor_effort_channel_unavailable');
  const baseline = execute(['opencode', 'debug', 'agent', defaultAgent], isolatedEnv);
  if (!baseline.ok || before !== smokeConfigState(cwd)) throw new Error('executor_effort_channel_unavailable');
  let baselineValue: Record<string, unknown>;
  try { const value: unknown = JSON.parse(baseline.stdout); if (!record(value)) throw new Error(); baselineValue = value; } catch { throw new Error('executor_effort_channel_unavailable'); }
  const model = profile.model;
  const effort = profile.effort;
  if (!model || !effort) throw new Error('executor_effort_channel_unavailable');
  const agentName = `pack-opk-${randomUUID().replaceAll('-', '')}`;
  const overlay = buildOpenCodeAgentOverlay({ agentName, baseline: baselineValue, model, effort, stateRoot });
  const resolved = execute(['opencode', 'debug', 'agent', agentName], { ...isolatedEnv, OPENCODE_CONFIG_CONTENT: overlay.inlineConfigJson! });
  if (!resolved.ok || before !== smokeConfigState(cwd)) throw new Error('executor_effort_channel_unavailable');
  let resolvedValue: Record<string, unknown>;
  try { const value: unknown = JSON.parse(resolved.stdout); if (!record(value)) throw new Error(); resolvedValue = value; } catch { throw new Error('executor_effort_channel_unavailable'); }
  const resolvedModel = record(resolvedValue.model) ? resolvedValue.model : null;
  if (!resolvedModel || resolvedModel.modelID !== model.split('/').at(-1) || resolvedValue.variant !== effort
    || openCodeAgentSemantics(baselineValue) !== openCodeAgentSemantics(resolvedValue)) throw new Error('executor_effort_channel_unavailable');
  const paths = execute(['opencode', 'debug', 'paths'], isolatedEnv);
  if (!paths.ok || !paths.stdout.includes(stateRoot)) throw new Error('executor_effort_channel_unavailable');
  return { profile: { ...profile, model, effort }, command: overlay.command };
}

function runSmokeProfileChild(
  args: readonly string[],
  cwd: string,
  env: Readonly<NodeJS.ProcessEnv>,
  extraEnv?: Readonly<NodeJS.ProcessEnv>,
): SmokeChildResult {
  const result = runProcessSync({
    command: args[0]!,
    args: args.slice(1),
    cwd,
    env: extraEnv ? { ...env, ...extraEnv } : { ...env },
    inheritParentEnv: true,
  });
  return { ok: result.ok, stdout: result.stdout, stderr: result.stderr ?? '' };
}

export interface ResolvedSmokeTarget {
  repositorySlug: string;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  issueBody: string;
  prBody: string;
  issueBodyMatchesTarget: boolean;
  trustedPublisherLogin: string;
  prOpen: boolean;
  baseRef: string;
  expectedTargetRef: string;
  expectedTarget: boolean;
}

export function projectExpectedPrTarget(
  pr: Record<string, unknown>,
  repository: Record<string, unknown>,
): Pick<ResolvedSmokeTarget, 'prOpen' | 'baseRef' | 'expectedTargetRef' | 'expectedTarget'> {
  const base = pr.base && typeof pr.base === 'object' && !Array.isArray(pr.base)
    ? pr.base as Record<string, unknown>
    : {};
  const prOpen = String(pr.state ?? '').trim().toLowerCase() === 'open';
  const baseRef = String(base.ref ?? '').trim();
  const expectedTargetRef = String(repository.default_branch ?? '').trim();
  return {
    prOpen,
    baseRef,
    expectedTargetRef,
    expectedTarget: Boolean(prOpen && baseRef && expectedTargetRef && baseRef === expectedTargetRef),
  };
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    command: '', issueNumber: 0, prNumber: 0, headSha: '', issueBodyFile: '', smokeComplexity: '', smokeActor: 'worker-owned', operatorSmokeOnly: false,
    repoRoot: process.cwd(), cwd: process.cwd(), dryRun: false, json: false, reviewId: '', reviewHeadSha: '', detach: false, detachedOwner: false, runId: '',
  };
  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) options.command = args.shift() ?? '';
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case '--issue': options.issueNumber = Number.parseInt(args[++index] ?? '', 10); break;
      case '--pr': options.prNumber = Number.parseInt(args[++index] ?? '', 10); break;
      case '--head-sha': options.headSha = args[++index] ?? ''; break;
      case '--issue-body-file': options.issueBodyFile = args[++index] ?? ''; break;
      case '--smoke-complexity': options.smokeComplexity = (args[++index] ?? '') as SmokeComplexity; break;
      case '--smoke-actor': options.smokeActor = (args[++index] ?? '') as SmokeOrderingActor; break;
      case '--operator-smoke-only': options.operatorSmokeOnly = true; break;
      case '--operator-override': options.operatorOverrideReason = args[++index] ?? ''; break;
      case '--repo-root': options.repoRoot = args[++index] ?? options.repoRoot; break;
      case '--cwd': options.cwd = args[++index] ?? options.cwd; break;
      case '--dry-run': options.dryRun = true; break;
      case '--json': options.json = true; break;
      case '--review-id': options.reviewId = args[++index] ?? ''; break;
      case '--review-head-sha': options.reviewHeadSha = args[++index] ?? ''; break;
      case '--detach': options.detach = true; break;
      case '--detached-owner': options.detachedOwner = true; break;
      case '--run': options.runId = args[++index] ?? ''; break;
      default: throw new Error(`unknown argument: ${args[index]}`);
    }
  }
  return options;
}

export function emit(value: unknown, json: boolean): void {
  const output = json || (typeof value === 'object' && value !== null) ? JSON.stringify(value) : String(value);
  process.stdout.write(`${output}\n`);
}

function readIssueBody(path: string): string {
  if (!path) throw new Error('--issue-body-file is required');
  return readFileSync(path, 'utf8');
}

function sleep(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function sleepAsync(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolveYield) => setImmediate(resolveYield));
}

function requireProcessOutput(label: string, result: ReturnType<typeof runProcessSync>): string {
  if (!result.ok) {
    const detail = scrubSmokeOutput(scrubForwardedGhSecrets(
      result.stderr || result.error || 'non-zero exit',
      buildSmokeGhChildEnv(),
    ));
    throw new Error(`${label}: ${detail}`);
  }
  return result.stdout;
}

export function runSmokeGhSync(
  args: readonly string[],
  cwd: string,
  extraEnv: Readonly<NodeJS.ProcessEnv> = {},
): ReturnType<typeof runProcessSync> {
  return runProcessSync({ command: resolveTrackedGhWrapper(), args: [...args], cwd, env: { ...buildSmokeGhChildEnv(), ...extraEnv } });
}

function runSmokeGhWriteSync(
  args: readonly string[],
  cwd: string,
  extraEnv: Readonly<NodeJS.ProcessEnv> = {},
): ReturnType<typeof runProcessSync> {
  return runProcessSync({ command: 'gh', args: [...args], cwd, env: { ...buildSmokeGhChildEnv(), ...extraEnv } });
}

function gitPorcelain(cwd: string): string[] {
  return requireProcessOutput('git status --porcelain', runProcessSync({ command: 'git', args: ['status', '--porcelain'], cwd }))
    .split(/\r?\n/u).filter(Boolean);
}

export function gitTrackedSmokeRuntimePaths(cwd: string): string[] {
  return requireProcessOutput(
    'git ls-files .orca-worker-smoke',
    runProcessSync({ command: 'git', args: ['ls-files', '--cached', '--', '.orca-worker-smoke'], cwd }),
  )
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line === '.orca-worker-smoke' || line.startsWith('.orca-worker-smoke/'));
}

function gitHead(cwd: string): string {
  return requireProcessOutput('git rev-parse HEAD', runProcessSync({ command: 'git', args: ['rev-parse', 'HEAD'], cwd })).trim().toLowerCase();
}

function gitOriginRepositorySlug(cwd: string): string {
  const remote = requireProcessOutput('git remote get-url origin', runProcessSync({ command: 'git', args: ['remote', 'get-url', 'origin'], cwd })).trim();
  const match = remote.match(/(?:github\.com[/:])([^/]+)\/([^/]+?)(?:\.git)?$/iu);
  if (!match) throw new Error('trusted_target: origin repository slug unresolved');
  return `${match[1]}/${match[2]}`;
}

function hashTrackedPaths(cwd: string, paths: readonly string[]): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const path of paths) {
    const result = runProcessSync({ command: 'git', args: ['hash-object', path], cwd });
    if (result.ok) hashes[path] = result.stdout.trim();
  }
  return hashes;
}

function positiveInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function canonicalRepositorySlug(value: unknown): string {
  const slug = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(slug)) throw new Error('trusted_target: canonical repository slug missing or invalid');
  return slug;
}

const TRUSTED_REPOSITORY_SLUG = 'chetwerikoff/orchestrator-pack';

function repositoryFromGithubUrl(value: unknown): string {
  const match = String(value ?? '').trim().match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/\d+(?:$|[?#])/iu);
  return match ? `${match[1]}/${match[2]}` : '';
}

function smokeGhApiJson(label: string, endpoint: string, cwd: string): unknown {
  const output = requireProcessOutput(label, runSmokeGhSync(['api', endpoint], cwd));
  try { return JSON.parse(output) as unknown; } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: tracked gh returned invalid JSON: ${detail}`);
  }
}

function githubApiObject(label: string, endpoint: string, cwd: string): Record<string, unknown> {
  const value = smokeGhApiJson(label, endpoint, cwd);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected one JSON object`);
  return value as Record<string, unknown>;
}

function githubApiPaginatedArray(label: string, endpoint: string, cwd: string): readonly unknown[] {
  const output = requireProcessOutput(label, runSmokeGhSync(['api', '--paginate', '--slurp', endpoint], cwd));
  let parsed: unknown;
  try { parsed = JSON.parse(output) as unknown; } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: tracked gh returned invalid paginated JSON: ${detail}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${label}: expected one slurped page array`);
  return parsed.flatMap((page) => Array.isArray(page) ? page : [page]);
}

export function exactClosingIssue(body: string): number | undefined {
  const scannable = prBodyScannableForIssueLinks(body);
  const pattern = new RegExp(ISSUE_LINK_PATTERN.source, ISSUE_LINK_PATTERN.flags);
  const matches = [...scannable.matchAll(pattern)];
  if (matches.length !== 1) return undefined;
  const issueNumber = Number(matches[0]?.[1]);
  return Number.isSafeInteger(issueNumber) && issueNumber > 0 ? issueNumber : undefined;
}

function suppliedIssueBodyMatches(fetched: string, supplied: string): boolean {
  return supplied === fetched || supplied === `${fetched}\n` || supplied === `${fetched}\r\n`;
}

export function resolveSmokeTarget(options: CliOptions, suppliedIssueBody: string): ResolvedSmokeTarget {
  const repositorySlug = canonicalRepositorySlug(TRUSTED_REPOSITORY_SLUG);
  const originSlug = gitOriginRepositorySlug(options.repoRoot);
  if (originSlug.toLowerCase() !== repositorySlug.toLowerCase()) throw new Error('trusted_target: trusted repository and origin mismatch');

  const principal = githubApiObject('authenticated-principal', 'user', options.repoRoot);
  const trustedPublisherLogin = String(principal.login ?? '').trim();
  if (!trustedPublisherLogin) throw new Error('trusted_target: authenticated publication principal unresolved');

  const issue = githubApiObject('issue-view', `repos/${repositorySlug}/issues/${options.issueNumber}`, options.repoRoot);
  const pr = githubApiObject('pr-view-binding', `repos/${repositorySlug}/pulls/${options.prNumber}`, options.repoRoot);
  const repository = githubApiObject('repository-view-binding', `repos/${repositorySlug}`, options.repoRoot);
  const targetFact = projectExpectedPrTarget(pr, repository);

  const issueNumber = positiveInteger(issue.number);
  const prNumber = positiveInteger(pr.number);
  const head = pr.head && typeof pr.head === 'object' && !Array.isArray(pr.head) ? pr.head as Record<string, unknown> : {};
  const headSha = String(head.sha ?? '').trim().toLowerCase();
  const issueRepository = repositoryFromGithubUrl(issue.html_url);
  const prRepository = repositoryFromGithubUrl(pr.html_url);
  if (issueNumber !== options.issueNumber || prNumber !== options.prNumber) throw new Error('trusted_target: resolved Issue or PR number mismatch');
  if (issueRepository.toLowerCase() !== repositorySlug.toLowerCase() || prRepository.toLowerCase() !== repositorySlug.toLowerCase()) {
    throw new Error('trusted_target: resolved repository mismatch');
  }
  if (String(issue.state ?? '').toLowerCase() !== 'open' || String(pr.state ?? '').toLowerCase() !== 'open') {
    throw new Error('trusted_target: Issue or PR is not open');
  }
  if (!/^[0-9a-f]{40}$/u.test(options.headSha.trim().toLowerCase()) || headSha !== options.headSha.trim().toLowerCase()) {
    throw new Error('trusted_target_head_mismatch: exact PR head mismatch');
  }
  const issueBody = String(issue.body ?? '');
  const prBody = String(pr.body ?? '');
  if (!suppliedIssueBodyMatches(issueBody, suppliedIssueBody)) throw new Error('trusted_target: Issue body file does not match the fetched Issue body');
  if (exactClosingIssue(prBody) !== issueNumber) throw new Error('trusted_target: PR-to-Issue resolution is missing, multiple, or mismatched');

  return {
    repositorySlug, issueNumber, prNumber, headSha, issueBody, prBody,
    issueBodyMatchesTarget: true, trustedPublisherLogin, ...targetFact,
  };
}

export function parsePaginatedSmokeComments(text: string): WorkerSmokeCommentRecord[] {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed) || (parsed as unknown[]).some((page) => !Array.isArray(page))) {
    throw new Error('comment_census: paginated output was not one slurped page array');
  }
  const comments = (parsed as unknown[][]).flat();
  const ids = new Set<number>();
  const normalized: WorkerSmokeCommentRecord[] = [];
  for (const raw of comments) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('comment_census: comment record was not an object');
    const comment = raw as WorkerSmokeCommentRecord;
    const id = positiveInteger(comment.id);
    if (!id) throw new Error('comment_census: comment id missing or invalid');
    if (ids.has(id)) throw new Error('comment_census: duplicate comment id');
    ids.add(id);
    if (typeof comment.body !== 'string'
      || !String(comment.created_at ?? comment.createdAt ?? '').trim()
      || !String(comment.updated_at ?? comment.updatedAt ?? '').trim()) {
      throw new Error('comment_census: comment body or timestamp metadata missing');
    }
    normalized.push(comment);
  }
  return normalized;
}

export function fetchPrComments(prNumber: number, repositorySlug: string, repoRoot: string): WorkerSmokeCommentRecord[] {
  const pages: unknown[][] = [];
  const perPage = 100;
  for (let page = 1; page <= 100; page += 1) {
    const batch = smokeGhApiJson('comment-census', `repos/${repositorySlug}/issues/${prNumber}/comments?per_page=${perPage}&page=${page}`, repoRoot);
    if (!Array.isArray(batch)) throw new Error('comment_census: comment page was not an array');
    pages.push(batch);
    if (batch.length < perPage) return parsePaginatedSmokeComments(JSON.stringify(pages));
  }
  throw new Error('comment_census: pagination completeness unprovable');
}

export function smokeCommentSnapshotDigest(comments: readonly WorkerSmokeCommentRecord[]): string {
  const canonical = comments.map((comment) => ({
    id: positiveInteger(comment.id),
    createdAt: String(comment.created_at ?? comment.createdAt ?? ''),
    updatedAt: String(comment.updated_at ?? comment.updatedAt ?? ''),
    actor: typeof comment.actor === 'string' ? comment.actor : String(comment.user?.login ?? comment.actor?.login ?? ''),
    body: String(comment.body ?? ''),
  })).sort((left, right) => left.id - right.id);
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

export function stabilizeSmokeCommentCensus(fetchCensus: () => WorkerSmokeCommentRecord[], maxTransitions = 3): WorkerSmokeCommentRecord[] {
  let previous = fetchCensus();
  let previousDigest = smokeCommentSnapshotDigest(previous);
  for (let transition = 0; transition < maxTransitions; transition += 1) {
    const next = fetchCensus();
    const nextDigest = smokeCommentSnapshotDigest(next);
    if (nextDigest === previousDigest) return next;
    previous = next;
    previousDigest = nextDigest;
  }
  throw new Error('comment_snapshot: failed to stabilize within bounded attempts');
}

export function fetchLivePrHead(prNumber: number, repositorySlug: string, repoRoot: string): string {
  const pr = githubApiObject('pr-view-head', `repos/${repositorySlug}/pulls/${prNumber}`, repoRoot);
  const head = pr.head && typeof pr.head === 'object' && !Array.isArray(pr.head) ? pr.head as Record<string, unknown> : {};
  if (positiveInteger(pr.number) !== prNumber || String(pr.state ?? '').toLowerCase() !== 'open') throw new Error('trusted_target: live PR binding changed');
  return String(head.sha ?? '').trim().toLowerCase();
}

export function publishPrComment(prNumber: number, body: string, repoRoot: string): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'worker-smoke-comment-'));
  const bodyFile = join(tempDir, 'body.md');
  try {
    writeFileSync(bodyFile, JSON.stringify({ body }), 'utf8');
    requireProcessOutput('gh api issue comment', runSmokeGhWriteSync(
      ['api', `repos/${TRUSTED_REPOSITORY_SLUG}/issues/${String(prNumber)}/comments`, '--method', 'POST', '--input', bodyFile], repoRoot,
    ));
  } finally { rmSync(tempDir, { recursive: true, force: true }); }
}

export function reviewIndependentRequiredCiContexts(contexts: readonly unknown[]): string[] {
  const reviewContext = PACK_REVIEW_REQUIRED_STATUS_CONTEXT.toLowerCase();
  return contexts.map((value) => String(value ?? '').trim()).filter((value) => Boolean(value) && value.toLowerCase() !== reviewContext);
}

export function resolveCiGreen(prNumber: number, headSha: string, repositorySlug: string, repoRoot: string): boolean {
  const pr = githubApiObject('pr-view-head-base', `repos/${repositorySlug}/pulls/${prNumber}`, repoRoot);
  const head = pr.head && typeof pr.head === 'object' && !Array.isArray(pr.head) ? pr.head as Record<string, unknown> : {};
  const base = pr.base && typeof pr.base === 'object' && !Array.isArray(pr.base) ? pr.base as Record<string, unknown> : {};
  if (positiveInteger(pr.number) !== prNumber || String(pr.state ?? '').toLowerCase() !== 'open'
    || String(head.sha ?? '').trim().toLowerCase() !== headSha.trim().toLowerCase()) return false;
  const checks = JSON.parse(requireProcessOutput('required-ci-checks', runSmokeGhSync(
    ['pr', 'checks', String(prNumber), '--repo', repositorySlug, '--json', 'name,state,bucket,link,startedAt,completedAt,workflow,description'], repoRoot,
  ))) as { name?: string; state?: string; bucket?: string }[];
  const baseRef = String(base.ref ?? 'main').trim() || 'main';
  let requiredCheckNames: string[] = [];
  let requiredCheckLookupFailed = false;
  try {
    const protection = githubApiObject('required-status-checks', `repos/${repositorySlug}/branches/${baseRef}/protection/required_status_checks`, repoRoot);
    requiredCheckNames = reviewIndependentRequiredCiContexts(Array.isArray(protection.contexts) ? protection.contexts : []);
  } catch { requiredCheckLookupFailed = true; }
  return classifyRequiredCiLevel(checks, { requiredCheckNames, requiredCheckLookupFailed }) === 'green';
}

function sameReviewIdentifier(left: unknown, right: unknown): boolean {
  return String(left ?? '').trim() !== '' && String(left ?? '').trim() === String(right ?? '').trim();
}

function githubCommitIsAncestor(repositorySlug: string, ancestorSha: string, descendantSha: string, repoRoot: string): boolean {
  if (ancestorSha === descendantSha) return true;
  const comparison = githubApiObject('direct-review-lineage', `repos/${repositorySlug}/compare/${ancestorSha}...${descendantSha}`, repoRoot);
  return String(comparison.status ?? '').trim().toLowerCase() === 'ahead';
}

export function currentPackReviewStatusFact(repositorySlug: string, headSha: string, repoRoot: string): PackReviewSemanticSourceState {
  return projectRunnerPackReviewStatusFromCombined(githubApiPaginatedArray(
    'pack-review-status-history', `repos/${repositorySlug}/commits/${headSha}/statuses?per_page=100`, repoRoot,
  ));
}

function currentAtCapFacts(prNumber: number): Pick<Parameters<typeof evaluateReadiness>[0]['review'], 'atCapOpenFindings' | 'atCapContinuationRequired'> {
  try {
    const storeRoot = resolvePackReviewRunStoreRoot({ projectId: 'orchestrator-pack', storeRoot: process.env.PACK_REVIEW_RUN_STORE_ROOT });
    const authority = readPackReviewAuthority(prNumber, { storeRoot });
    return {
      atCapOpenFindings: authority?.cycle?.state === 'at_cap_open_findings',
      atCapContinuationRequired: authority?.cycle?.state === 'at_cap_continuation_required',
    };
  } catch { return { atCapOpenFindings: 'unknown', atCapContinuationRequired: 'unknown' }; }
}

interface PostSmokePackReviewAuthorityCycle {
  readonly cycleId: string;
  readonly capMapVersion: string;
  readonly reviewStageComplete?: boolean;
}

function currentPackReviewCompletionCycle(
  prNumber: number,
  currentHeadSha: string,
  isAncestor: (ancestorSha: string, descendantSha: string) => boolean,
): PostSmokePackReviewAuthorityCycle | null {
  try {
    const storeRoot = resolvePackReviewRunStoreRoot({ projectId: 'orchestrator-pack', storeRoot: process.env.PACK_REVIEW_RUN_STORE_ROOT });
    let authority = readPackReviewAuthority(prNumber, { storeRoot });
    if (!authority?.cycle) return null;
    const reviewedHeadSha = authority.terminal?.reviewVerdict === 'findings' ? authority.terminal.targetSha : '';
    if (authority.cycle.capMapVersion === PACK_REVIEW_LOGICAL_CAP_MAP_VERSION
        && authority.cycle.reviewStageComplete !== true
        && authority.currentHeadSha === currentHeadSha.toLowerCase()
        && reviewedHeadSha
        && ['open_findings', 'at_cap_open_findings', 'at_cap_continuation_required'].includes(authority.cycle.state)) {
      let reviewedHeadIsAncestor = false;
      try { reviewedHeadIsAncestor = isAncestor(reviewedHeadSha, currentHeadSha); } catch { reviewedHeadIsAncestor = false; }
      if (packReviewFindingsSatisfiedByStrictDescendant({ reviewedHeadSha, currentHeadSha, reviewedHeadIsAncestor })) {
        authority = settleLogicalPackReviewFindingsByStrictDescendant({
          prNumber, expectedTransitionSeq: authority.transitionSeq, reviewedHeadSha, currentHeadSha,
          reviewedHeadIsAncestor: true, options: { storeRoot },
        });
      }
    }
    const cycle = authority.cycle;
    if (!cycle) return null;
    return { cycleId: cycle.cycleId, capMapVersion: cycle.capMapVersion, reviewStageComplete: cycle.reviewStageComplete };
  } catch { return null; }
}

export interface PostSmokePackReviewResolution {
  readonly reviewProjection: PackReviewSemanticProjection;
  readonly unresolvedRequiredFinding: boolean;
  readonly completedLogicalCycleId: string | null;
}

export function projectPostSmokePackReview(input: {
  readonly runner: PackReviewSemanticSourceState;
  readonly direct: Pick<DirectPackReviewProjection, 'hasLegitimateReview' | 'state' | 'unresolvedBlockingReviewIds' | 'unresolvedCurrentHeadBlockingReviewIds' | 'unresolvedAncestorBlockingReviewIds'>;
  readonly authorityCycle: PostSmokePackReviewAuthorityCycle | null;
}): PostSmokePackReviewResolution {
  const completedLogicalStage = input.authorityCycle?.capMapVersion === PACK_REVIEW_LOGICAL_CAP_MAP_VERSION
    && input.authorityCycle.reviewStageComplete === true;
  if (!completedLogicalStage) {
    const reviewProjection = projectPackReviewSemanticStatus({
      runner: input.runner,
      direct: { hasLegitimateReview: input.direct.hasLegitimateReview, unresolvedBlockingFinding: input.direct.state === 'blocked' },
    });
    return { reviewProjection, unresolvedRequiredFinding: reviewProjection.reason === 'unresolved-blocker', completedLogicalCycleId: null };
  }
  const staleAncestorIds = new Set(input.direct.unresolvedAncestorBlockingReviewIds.map((reviewId) => String(reviewId).trim()));
  const unresolvedRequiredFinding = input.direct.unresolvedBlockingReviewIds.some((reviewId) => !staleAncestorIds.has(String(reviewId).trim()));
  return {
    reviewProjection: { state: 'success', description: 'Required pack-review stage completed; no additional review round required.', reason: 'clear' },
    unresolvedRequiredFinding,
    completedLogicalCycleId: input.authorityCycle!.cycleId,
  };
}

export interface PostSmokeReadinessResult {
  readonly readiness: ReadinessResult;
  readonly reviewProjection: PackReviewSemanticProjection;
  readonly smokeEvidence: { readonly state: 'verified' | 'missing' | 'unavailable' | 'changed'; readonly headSha: string };
}
export interface PostSmokeReadinessDependencies {
  readonly resolveCiGreen?: typeof resolveCiGreen;
  readonly currentPackReviewStatusFact?: typeof currentPackReviewStatusFact;
  readonly isAncestor?: typeof githubCommitIsAncestor;
  readonly fetchSmokeComments?: typeof fetchPrComments;
  readonly fetchCurrentHead?: typeof fetchLivePrHead;
  readonly listDirectReviews?: (repoRoot: string, repositorySlug: string, prNumber: number) => Promise<GithubReviewSummary[]>;
}

export async function evaluatePostSmokeReadiness(
  options: CliOptions,
  target: ResolvedSmokeTarget,
  adapter: RuntimeAdapter,
  dependencies: PostSmokeReadinessDependencies = {},
): Promise<PostSmokeReadinessResult> {
  const assignmentFile = resolveWorkerAssignmentStorePath('orchestrator-pack', process.env);
  const assignment = currentWorkerAssignment(assignmentFile, target.issueNumber);
  const readinessTarget = {
    repository: target.repositorySlug, issueNumber: target.issueNumber, taskId: assignment?.taskId ?? '',
    assignmentId: assignment?.assignmentId ?? '', assignmentGeneration: assignment?.generation ?? 0,
    prNumber: target.prNumber, headSha: target.headSha,
  };
  const reportStore = readWorkerReportStoreFile(resolveWorkerReportStorePath(process.env));
  const reportRepoKey = target.repositorySlug.trim().toLowerCase();
  const reportPrKey = `${reportRepoKey}|${target.prNumber}`;
  evictWorkerReportRecords({
    store: reportStore,
    openPrs: [{ number: target.prNumber, state: target.prOpen ? 'open' : 'closed', repoSlug: target.repositorySlug }],
    currentHeadByPr: { [reportPrKey]: target.headSha }, nowMs: Date.now(), repoSlug: target.repositorySlug,
  });
  const workerReports = assignment ? listWorkerReportRecordsForAssignment(reportStore, target.repositorySlug, {
    assignmentId: assignment.assignmentId, generation: assignment.generation, taskId: assignment.taskId,
  }) : [];

  let workerStatuses: ReturnType<typeof buildWorkerStatusReport>['workers'] = [];
  if (assignment) {
    const resolved = resolveCurrentWorkerAssignmentBindings({ file: assignmentFile, repository: target.repositorySlug, adapter });
    if (resolved.status === 'ok') {
      const sessions = assignmentsToStatusSessions({
        assignments: [assignment],
        bindings: resolved.bindings.filter((binding) => binding.assignment.assignmentId === assignment.assignmentId),
        reconciliations: resolved.reconciliations.filter((row) => row.assignment.assignmentId === assignment.assignmentId),
        project: 'orchestrator-pack',
      });
      const killSwitch = evaluateWorkerStatusKillSwitch(process.env);
      const sibling = testSiblingReadiness(process.env);
      workerStatuses = buildWorkerStatusReport(
        sessions,
        readWorkerStatusStoreFile(resolveWorkerStatusStorePath(process.env)),
        Date.now(), { killSwitchActive: killSwitch.disabled, siblingReady: sibling.ready },
      ).workers;
    }
  }

  const fetchSmokeComments = dependencies.fetchSmokeComments ?? fetchPrComments;
  const fetchCurrentHead = dependencies.fetchCurrentHead ?? fetchLivePrHead;
  let initialSmokeHead = '';
  let initialSmokeComments: WorkerSmokeCommentRecord[] = [];
  let smokeWitness: SmokeReport | undefined;
  let smokeObservationAvailable = true;
  try {
    initialSmokeHead = fetchCurrentHead(target.prNumber, target.repositorySlug, options.repoRoot);
    initialSmokeComments = stabilizeSmokeCommentCensus(() =>
      fetchSmokeComments(target.prNumber, target.repositorySlug, options.repoRoot));
    if (initialSmokeHead === target.headSha) {
      const initialSmokeCoverage = evaluateWorkerSmokeCoverage({
        issueBody: target.issueBody,
        comments: initialSmokeComments,
        target: coverageTarget(target, initialSmokeHead),
      });
      const clearingPass = initialSmokeCoverage.latestClearingPass;
      if (initialSmokeCoverage.accepting && clearingPass?.result === 'PASS' && verifyPublishedSmokeProvenance(clearingPass)) {
        smokeWitness = clearingPass;
      }
    }
  } catch {
    smokeObservationAvailable = false;
  }

  const ciGreen = (dependencies.resolveCiGreen ?? resolveCiGreen)(target.prNumber, target.headSha, target.repositorySlug, options.repoRoot);
  const acceptedReport = selectAcceptedCurrentWorkerReport(workerReports, readinessTarget);
  const lifecycle = String(acceptedReport?.reportState ?? '').trim().toLowerCase();
  const transport = createGithubReviewTransport({ repoRoot: options.repoRoot, repoSlug: target.repositorySlug, prNumber: target.prNumber });
  const reviews = dependencies.listDirectReviews
    ? await dependencies.listDirectReviews(options.repoRoot, target.repositorySlug, target.prNumber)
    : await transport.listReviews();
  const initialSmokePassed = initialSmokeHead === target.headSha && Boolean(smokeWitness);
  const direct = projectDirectPackReviewState({
    reviews, repositoryOwnerLogin: target.repositorySlug.split('/')[0] ?? '',
    currentHeadSha: target.headSha, workerLifecycle: lifecycle, requiredCiGreen: ciGreen, exactHeadSmokePassed: initialSmokePassed,
    isAncestor: (ancestorSha, descendantSha) => (dependencies.isAncestor ?? githubCommitIsAncestor)(
      target.repositorySlug, ancestorSha, descendantSha, options.repoRoot,
    ),
  });
  const runner = (dependencies.currentPackReviewStatusFact ?? currentPackReviewStatusFact)(target.repositorySlug, target.headSha, options.repoRoot);
  const postSmokeReview = projectPostSmokePackReview({
    runner, direct,
    authorityCycle: currentPackReviewCompletionCycle(target.prNumber, target.headSha, (ancestorSha, descendantSha) =>
      (dependencies.isAncestor ?? githubCommitIsAncestor)(target.repositorySlug, ancestorSha, descendantSha, options.repoRoot)),
  });
  const reviewProjection = postSmokeReview.reviewProjection;
  const directOwnsSemanticProjection = postSmokeReview.completedLogicalCycleId !== null || direct.hasLegitimateReview || direct.state === 'blocked';
  if (!options.dryRun && (directOwnsSemanticProjection || (!runner.hasLegitimateReview && runner.activeAttempt !== true))) {
    await publishPackReviewRequiredStatus({
      repoRoot: options.repoRoot, repoSlug: target.repositorySlug, headSha: target.headSha,
      request: postSmokeReview.completedLogicalCycleId ? {
        state: 'success', context: PACK_REVIEW_REQUIRED_STATUS_CONTEXT, description: reviewProjection.description,
        idempotencyKey: `required-status:${PACK_REVIEW_REQUIRED_STATUS_CONTEXT}:${target.headSha}:stage-complete:${postSmokeReview.completedLogicalCycleId}`,
      } : semanticPackReviewRequiredStatusRequest({ headSha: target.headSha, projection: reviewProjection }),
    });
  }
  const atCap = currentAtCapFacts(target.prNumber);
  let smokeEvidenceState: PostSmokeReadinessResult['smokeEvidence']['state'] = smokeObservationAvailable ? 'missing' : 'unavailable';
  if (smokeObservationAvailable && smokeWitness) {
    try {
      const finalHead = fetchCurrentHead(target.prNumber, target.repositorySlug, options.repoRoot);
      const finalComments = stabilizeSmokeCommentCensus(() =>
        fetchSmokeComments(target.prNumber, target.repositorySlug, options.repoRoot));
      smokeEvidenceState = finalHead === target.headSha
        && finalSmokeCommentSnapshotMatches(initialSmokeComments, finalComments)
        ? 'verified'
        : 'changed';
    } catch {
      smokeEvidenceState = 'unavailable';
    }
  }
  const readiness = evaluateReadiness({
    target: readinessTarget,
    pr: { open: target.prOpen, expectedTarget: target.expectedTarget, prNumber: target.prNumber, headSha: target.headSha },
    workerReports, workerStatuses,
    requiredCi: { headSha: target.headSha, state: ciGreen ? 'success' : 'failure' },
    review: {
      obligation: reviewProjection.state === 'success' ? 'complete' : reviewProjection.reason === 'unresolved-blocker' ? 'blocked' : 'missing',
      unresolvedRequiredFinding: postSmokeReview.unresolvedRequiredFinding, ...atCap,
    },
    smoke: {
      headSha: target.headSha,
      state: smokeEvidenceState === 'verified' ? 'pass' : smokeEvidenceState === 'unavailable' ? 'unknown' : 'missing',
    },
  });
  return { readiness, reviewProjection, smokeEvidence: { state: smokeEvidenceState, headSha: target.headSha } };
}

export interface DelegatedReadinessDependencies {
  readonly resolveTarget?: typeof resolveSmokeTarget;
  readonly fetchCurrentHead?: typeof fetchLivePrHead;
  readonly readAssignment?: typeof currentWorkerAssignment;
  readonly selectAdapter?: (cwd: string) => Promise<RuntimeAdapter>;
  readonly evaluatePostSmokeReadiness?: typeof evaluatePostSmokeReadiness;
  readonly readiness?: PostSmokeReadinessDependencies;
}

export async function runDelegatedReadiness(
  options: CliOptions,
  dependencies: DelegatedReadinessDependencies = {},
): Promise<number> {
  const report = (reason: string, readiness?: PostSmokeReadinessResult) => {
    emit({ ok: false, reason, ...(readiness ? { readiness: readiness.readiness, smokeEvidence: readiness.smokeEvidence } : {}) }, options.json);
    return 1;
  };
  if (!Number.isInteger(options.issueNumber) || options.issueNumber <= 0
    || !Number.isInteger(options.prNumber) || options.prNumber <= 0
    || !/^[0-9a-f]{40}$/u.test(options.headSha.trim().toLowerCase())
    || !options.issueBodyFile) return report('delegated_readiness_binding_invalid');

  let target: ResolvedSmokeTarget;
  try {
    target = (dependencies.resolveTarget ?? resolveSmokeTarget)(options, readIssueBody(options.issueBodyFile));
  } catch (error) {
    return report(`delegated_readiness_target_unavailable:${scrubSmokeOutput(error instanceof Error ? error.message : String(error))}`);
  }
  const expectedHead = options.headSha.trim().toLowerCase();
  if (target.issueNumber !== options.issueNumber || target.prNumber !== options.prNumber
    || target.headSha !== expectedHead || !target.prOpen || !target.expectedTarget) {
    return report('delegated_readiness_target_mismatch');
  }

  const assignmentFile = resolveWorkerAssignmentStorePath('orchestrator-pack', process.env);
  const readAssignment = dependencies.readAssignment ?? currentWorkerAssignment;
  const assignment = readAssignment(assignmentFile, target.issueNumber);
  const marker = assignment?.delegatedIntegration;
  if (!assignment || assignment.repository !== target.repositorySlug.toLowerCase()
    || assignment.role !== 'worker' || !marker
    || marker.prNumber !== target.prNumber || marker.expectedHeadSha !== target.headSha) {
    return report('delegated_readiness_current_assignment_marker_mismatch');
  }

  let adapter: RuntimeAdapter;
  try {
    adapter = await (dependencies.selectAdapter ?? (async (cwd) => selectRuntimeAdapter({}, { cwd })))(options.cwd);
  } catch (error) {
    return report(`delegated_readiness_runtime_unavailable:${scrubSmokeOutput(error instanceof Error ? error.message : String(error))}`);
  }
  const evaluate = dependencies.evaluatePostSmokeReadiness ?? evaluatePostSmokeReadiness;
  const readiness = await evaluate({ ...options, dryRun: true }, target, adapter, dependencies.readiness);
  const current = readAssignment(assignmentFile, target.issueNumber);
  let finalHead = '';
  try {
    finalHead = (dependencies.fetchCurrentHead ?? fetchLivePrHead)(target.prNumber, target.repositorySlug, options.repoRoot);
  } catch {
    return report('delegated_readiness_final_binding_unavailable', readiness);
  }
  if (!current || current.assignmentId !== assignment.assignmentId || current.generation !== assignment.generation
    || current.taskId !== assignment.taskId || current.repository !== assignment.repository
    || !sameDelegatedIntegrationMarker(current.delegatedIntegration, marker) || finalHead !== target.headSha) {
    return report('delegated_readiness_binding_changed', readiness);
  }
  emit({
    ok: readiness.readiness.state === 'READY_TO_MERGE' && readiness.smokeEvidence.state === 'verified',
    readiness: readiness.readiness,
    reviewProjection: readiness.reviewProjection,
    smokeEvidence: readiness.smokeEvidence,
    assignment: { assignmentId: assignment.assignmentId, generation: assignment.generation, taskId: assignment.taskId },
  }, options.json);
  return readiness.readiness.state === 'READY_TO_MERGE' && readiness.smokeEvidence.state === 'verified' ? 0 : 1;
}

export async function runDirectReviewReconciliation(options: CliOptions): Promise<number> {
  if (!Number.isInteger(options.prNumber) || options.prNumber <= 0
      || !/^[0-9a-f]{40}$/u.test(options.headSha.trim().toLowerCase())
      || !options.reviewId || !/^[0-9a-f]{40}$/u.test(options.reviewHeadSha.trim().toLowerCase())) {
    emit({ ok: false, reason: 'direct_review_binding_invalid' }, options.json); return 1;
  }
  const currentHead = fetchLivePrHead(options.prNumber, TRUSTED_REPOSITORY_SLUG, options.repoRoot);
  const eventHead = options.headSha.trim().toLowerCase();
  const reviewHead = options.reviewHeadSha.trim().toLowerCase();
  if (currentHead !== eventHead || reviewHead !== eventHead) {
    emit({ ok: true, skipped: true, reason: 'direct_review_stale_publication_head', reviewHead, eventHead, currentHead }, options.json); return 0;
  }
  const transport = createGithubReviewTransport({ repoRoot: options.repoRoot, repoSlug: TRUSTED_REPOSITORY_SLUG, prNumber: options.prNumber });
  const reviews = await transport.listReviews();
  const submitted = reviews.find((review) => sameReviewIdentifier(review.id, options.reviewId));
  const owner = TRUSTED_REPOSITORY_SLUG.split('/')[0] ?? '';
  if (!submitted || !parseDirectPackReviewEvidence(submitted, owner)) {
    emit({ ok: true, skipped: true, reason: 'review_not_canonical_direct_pack_review' }, options.json); return 0;
  }
  const direct = projectDirectPackReviewState({
    reviews, repositoryOwnerLogin: owner, currentHeadSha: currentHead, workerLifecycle: '', requiredCiGreen: false,
    exactHeadSmokePassed: false,
    isAncestor: (ancestorSha, descendantSha) => githubCommitIsAncestor(TRUSTED_REPOSITORY_SLUG, ancestorSha, descendantSha, options.repoRoot),
  });
  const projection = projectPackReviewSemanticStatus({
    runner: currentPackReviewStatusFact(TRUSTED_REPOSITORY_SLUG, currentHead, options.repoRoot),
    direct: { hasLegitimateReview: direct.hasLegitimateReview, unresolvedBlockingFinding: direct.state === 'blocked' },
  });
  if (!options.dryRun) await publishPackReviewRequiredStatus({
    repoRoot: options.repoRoot, repoSlug: TRUSTED_REPOSITORY_SLUG, headSha: currentHead,
    request: semanticPackReviewRequiredStatusRequest({ headSha: currentHead, projection }),
  });
  emit({ ok: true, projection, direct }, options.json); return 0;
}

function failureReason(failure: RuntimeOperationFailure): string {
  return `${failure.operation}:${failure.status}:${failure.reason}`;
}

function operationalReport(
  causeFamily: WorkerSmokeCauseFamily | 'pass', options: CliOptions,
  input: { action: string; expected: string; observed: string; terminalCleanup?: string; limitations?: string[]; environmentNotes?: string[]; worker?: RuntimeWorkerIdentity; adapterId?: string },
): SmokeReport {
  const result = causeFamily === 'pass' ? 'PASS' : smokeResultForWorkerSmokeCauseFamily(causeFamily);
  const scenarioCauseFamily = causeFamily !== 'pass' && isWorkerSmokeScenarioCauseFamily(causeFamily)
    ? causeFamily
    : undefined;
  return {
    result, issueNumber: options.issueNumber, prNumber: options.prNumber, headSha: options.headSha,
    scenarios: [{
      action: input.action,
      expected: input.expected,
      observed: input.observed,
      outcome: result === 'PASS' ? 'pass' : result === 'BLOCKED' ? 'blocked' : 'fail',
      ...(scenarioCauseFamily ? { causeFamily: scenarioCauseFamily } : {}),
    }],
    limitations: input.limitations ?? [], trackedFilesUnmodified: true,
    terminalCleanup: input.terminalCleanup ?? 'not_started', environmentNotes: input.environmentNotes ?? [],
    producer: SMOKE_REPORT_PRODUCER, orcaExecutable: input.adapterId ?? 'runtime-adapter', terminalHandle: input.worker?.id,
    ...(causeFamily === 'pass' ? {} : { causeFamily }),
  };
}

interface SmokePublicationBinding {
  attemptId: string;
  runId?: string;
  executionMode: WorkerSmokeExecutionMode;
  attemptObservations?: readonly WorkerSmokeAttemptObservation[];
  operatorOverrideReason?: string;
}

function publishSmokeReport(
  report: SmokeReport,
  options: CliOptions,
  binding?: SmokePublicationBinding,
  publishComment: (prNumber: number, body: string, repoRoot: string) => void = publishPrComment,
  afterComment?: () => void,
): boolean {
  if (options.dryRun) return false;
  publishComment(options.prNumber, formatSmokeReportComment(report), options.repoRoot);
  afterComment?.();
  if (binding) writeWorkerSmokeReceipt(report, binding);
  return true;
}

function attemptObservationsFromScenarios(
  scenarios: readonly SmokeReport['scenarios'][number][] | undefined,
): WorkerSmokeAttemptObservation[] {
  return (scenarios ?? []).flatMap((scenario) => {
    if (!scenario.outcome || scenario.outcome === 'skipped') return [];
    const action = scenario.action.trim();
    const expected = scenario.expected.trim();
    if (!action || !expected) return [];
    const causeFamily = scenario.outcome === 'pass'
      ? undefined
      : isWorkerSmokeScenarioCauseFamily(scenario.causeFamily)
        ? scenario.causeFamily
        : 'unknown' as const;
    return [{ action, expected, outcome: scenario.outcome, ...(causeFamily ? { causeFamily } : {}) }];
  });
}

export function bindSmokeReportToPlan(partial: Partial<SmokeReport>, plan: Pick<SmokeTestPlan, 'scenarios'>): Partial<SmokeReport> {
  const childRows = partial.scenarios ?? [];
  const childRowsComplete = childRows.length === plan.scenarios.length
    && childRows.every((row) => Boolean(row.observed?.trim()) && Boolean(row.outcome));
  return {
    ...partial,
    result: partial.result === 'PASS' && !childRowsComplete ? 'FAIL' : partial.result,
    scenarios: plan.scenarios.map((declared, index) => {
      const child = childRows[index];
      return {
        action: declared.action, expected: declared.expected,
        ...(child?.observed !== undefined ? { observed: child.observed } : {}),
        ...(child?.outcome !== undefined ? { outcome: child.outcome } : {}),
        ...(child?.skipReason !== undefined ? { skipReason: child.skipReason } : {}),
        ...(child?.causeFamily !== undefined ? { causeFamily: child.causeFamily } : {}),
      };
    }),
  };
}

type RuntimeFailureWithNativeError = RuntimeOperationFailure & { readonly nativeError?: Readonly<{ code: string; message: string }> };

export function runtimeClose(adapter: RuntimeAdapter, worker: RuntimeWorkerIdentity, options: Pick<CliOptions, 'cwd'>): string {
  const result = adapter.stopWorker(worker, { cwd: options.cwd });
  if (result.status === 'ok') return 'closed_owned_handle';
  const presence = adapter.findWorker(worker, { cwd: options.cwd });
  if (presence.status === 'ok' && presence.value === null) return 'closed_owned_handle_already_absent';
  const nativeError = (result as RuntimeFailureWithNativeError).nativeError;
  const runtimeError = nativeError ? `;runtime_error=${JSON.stringify(nativeError)}` : '';
  if (presence.status === 'ok') return `close_failed:${result.reason}${runtimeError};presence=present;runtime=${worker.runtime};handle=${worker.id};generation=${worker.generation}`;
  return `close_failed:${result.reason}${runtimeError};presence=unproven;presence_error=${failureReason(presence)}`;
}

export function runtimeCloseBoundHandle(adapter: RuntimeAdapter, handle: string, options: Pick<CliOptions, 'cwd'>): string {
  const resolved = adapter.findWorkerById(handle, { cwd: options.cwd });
  if (resolved.status !== 'ok') return `close_failed:${resolved.reason};presence=unproven;presence_error=${failureReason(resolved)}`;
  if (resolved.value === null) return 'close_failed:worker_not_found;presence=unproven';
  const workspacePath = resolved.value.workspacePath;
  if (resolve(workspacePath) !== resolve(options.cwd)) return 'close_failed:worker_workspace_mismatch;presence=unproven';
  return runtimeClose(adapter, resolved.value.identity, options);
}

function buildLifecyclePrompt(basePrompt: string, binding: SmokeRunBinding, scenarioCount: number): string {
  const prompt = scenarioCount === 0
    ? basePrompt.replace(
        '(none — report BLOCKED with concrete reason)',
        '(none — execute no smoke scenarios; emit PASS using the carry-only bookkeeping row required below)',
      )
    : basePrompt;
  const progressPath = smokeProgressPath(binding.artifactDir);
  const progressPathToken = Buffer.from(progressPath, 'utf8').toString('base64');
  const runIdToken = Buffer.from(binding.runId, 'utf8').toString('base64');
  const writer = [
    'node -e',
    "'const fs=require(\"node:fs\");const [p64,r64,ordinal,phase,outcome]=process.argv.slice(1);const event={runId:Buffer.from(r64,\"base64\").toString(\"utf8\"),scenarioOrdinal:Number(ordinal),phase};if(outcome)event.outcome=outcome;fs.appendFileSync(Buffer.from(p64,\"base64\").toString(\"utf8\"),JSON.stringify(event)+\"\\n\",\"utf8\")'",
  ].join(' ');
  const progressEventProtocol = [
    'Canonical progress serialization (mandatory):',
    ...(scenarioCount === 0
      ? ['- Do not write progress events when this attempt has no selected scenarios.']
      : [
        `- Before scenario 1, run exactly: ${writer} ${progressPathToken} ${runIdToken} 1 started`,
        `- The first non-empty progress line must parse exactly as: ${JSON.stringify({ runId: binding.runId, scenarioOrdinal: 1, phase: 'started' })}`,
        '- For later started events, reuse the command with the declared ordinal and phase started, omitting outcome.',
        '- For terminal events, reuse the command with the same ordinal, phase terminal, and one outcome: pass|fail|blocked|skipped.',
        '- Never append a terminal event before its matching started event.',
      ]),
  ];
  return [
    prompt,
    '',
    'Lifecycle protocol (child-produced evidence only):',
    `- Progress file: ${progressPath}`,
    `- Cancel request: ${smokeCancelRequestPath(binding.artifactDir)}`,
    `- Cancel acknowledgement: ${smokeCancelAcknowledgementPath(binding.artifactDir)}`,
    `- Declared scenario count: ${scenarioCount}`,
    ...progressEventProtocol,
    ...(scenarioCount === 0 ? [
      '- Zero selected scenarios means all current tuples were safely carried. Execute no smoke scenario and write no progress event.',
      '- Emit PASS with one bookkeeping row: action: record empty attempt-local execution set | expected: no selected smoke scenario executes | observed: no attempt-local scenarios selected | outcome: pass.',
    ] : []),
    '- Emit each declared progress event exactly once; never repeat a started or terminal event.',
    '- For PR scope accounting, compare HEAD to the verified PR base merge-base (git diff "$(git merge-base HEAD origin/main)" HEAD), never to a local branch named main.',
    '- Use declared order only and check cancel-request.json before each new scenario.',
    '- For each scenario N, append and durably flush N started, execute only N, then append and durably flush N terminal before doing any work or writing progress for N+1.',
    '- Never run scenarios in parallel, start a later ordinal early, or skip an ordinal, and after fail/blocked/skipped terminal stop without starting another scenario.',
  ].join('\n');
}

export interface RuntimeSmokeDeliveryResult { ok: boolean; reason?: string; observationToken?: RuntimeObservationToken; submitCount: number; }

export function establishRuntimeSmokeDelivery(input: {
  adapter: RuntimeAdapter; worker: RuntimeWorkerIdentity; prompt: string; binding: SmokeRunBinding; cwd: string; deadlineMs: number;
  now?: () => number; sleepMs?: (milliseconds: number) => void;
}): RuntimeSmokeDeliveryResult {
  const now = input.now ?? (() => Date.now());
  const sleepMs = input.sleepMs ?? sleep;
  const deadline = now() + input.deadlineMs;
  const openCodeHttp = input.adapter.composerControl?.(input.worker)?.kind === 'opencode-http';
  let baselineScreen: readonly string[] | undefined;
  if (openCodeHttp) {
    let baselineObservationFailure: string | undefined;
    while (baselineScreen === undefined) {
      const remaining = deadline - now();
      if (remaining <= 0) return { ok: false, reason: baselineObservationFailure ?? 'runtime_timeout', submitCount: 0 };
      const baseline = input.adapter.readBoundedOutput({ worker: input.worker, limit: 200, screen: true }, { cwd: input.cwd, timeoutMs: Math.max(1, remaining) });
      if (baseline.status === 'ok') { baselineScreen = baseline.value.lines; break; }
      const observationFailure = `opencode_panel_observation_failed:${failureReason(baseline)}`;
      if (baseline.reason !== 'runtime_output_source_unobservable') return { ok: false, reason: observationFailure, submitCount: 0 };
      baselineObservationFailure = observationFailure;
      if (deadline - now() <= 0) return { ok: false, reason: baselineObservationFailure, submitCount: 0 };
      sleepMs(SMOKE_LIFECYCLE_POLL_MS);
    }
  }
  const dispatchRemaining = deadline - now();
  if (dispatchRemaining <= 0) return { ok: false, reason: 'runtime_timeout', submitCount: 0 };
  const dispatched = input.adapter.dispatchInput({ worker: input.worker, text: input.prompt }, { cwd: input.cwd, timeoutMs: Math.max(1, dispatchRemaining) });
  if (dispatched.status === 'send_failed') return { ok: false, reason: `send_failed:${dispatched.reason}`, submitCount: 0 };

  let token: RuntimeObservationToken | undefined;
  const submitCount = 0;
  let panelLeftIdleSplash = !openCodeHttp;
  let openCodeObservationFailure: string | undefined;
  while (now() < deadline) {
    if (dispatched.status === 'dispatched' && openCodeHttp) {
      const remaining = deadline - now(); if (remaining <= 0) break;
      const read = input.adapter.readBoundedOutput({ worker: input.worker, limit: 200, screen: true }, { cwd: input.cwd, timeoutMs: Math.max(1, remaining) });
      if (read.status !== 'ok') {
        const observationFailure = `opencode_panel_observation_failed:${failureReason(read)}`;
        if (read.reason !== 'runtime_output_source_unobservable') return { ok: false, reason: observationFailure, submitCount };
        openCodeObservationFailure = observationFailure;
        if (deadline - now() <= 0) break;
        sleepMs(SMOKE_LIFECYCLE_POLL_MS); continue;
      }
      openCodeObservationFailure = undefined;
      panelLeftIdleSplash = JSON.stringify(read.value.lines) !== JSON.stringify(baselineScreen);
    }
    if (observeSmokeDeliveryEstablished(input.binding) && panelLeftIdleSplash) {
      markTrackedSmokeWorkerDeliveryConfirmed(input.worker);
      return { ok: true, observationToken: token, submitCount };
    }
    if (dispatched.status === 'dispatched' && !openCodeHttp) {
      const read = input.adapter.readBoundedOutput({ worker: input.worker, previousToken: token, limit: 200 }, { cwd: input.cwd, timeoutMs: Math.max(1, deadline - now()) });
      if (read.status !== 'ok') return { ok: false, reason: failureReason(read), submitCount };
      token = read.value.observationToken;
    }
    const remainingMs = deadline - now(); if (remainingMs <= 0) break;
    sleepMs(Math.min(SMOKE_LIFECYCLE_POLL_MS, Math.max(1, remainingMs)));
  }
  const reason = dispatched.status === 'dispatch_unknown' ? `dispatch_unknown:${dispatched.reason}`
    : openCodeObservationFailure ? openCodeObservationFailure : openCodeHttp && !panelLeftIdleSplash ? 'opencode_panel_idle_splash' : 'prompt_delivery_unconfirmed';
  return { ok: false, reason, ...(token ? { observationToken: token } : {}), submitCount };
}

type SmokeCompletionObservation = ReturnType<typeof observeSmokeCompletionEvidence>['observation'];
type SmokeProgress = ReturnType<typeof inspectSmokeProgress>;

function missingCompletionEvidence(observation: SmokeCompletionObservation): string {
  if (observation.wrongRunBinding) return 'sealed_report_for_expected_run';
  switch (observation.publicationState) {
    case 'partial': return 'completion_body_or_seal_incomplete';
    case 'publish_complete_duplicate': return 'exactly_one_sealed_report';
    case 'publish_complete_unfenced': return 'valid_worker_smoke_report';
    case 'publish_complete_single': return observation.partial ? 'none' : 'valid_worker_smoke_report';
    case 'none': default: return 'completion_sealed_report';
  }
}

function completionFailureReason(cause: string, observation: SmokeCompletionObservation, progress: SmokeProgress, detail?: string): string {
  return [cause, detail, `publication_state=${observation.publicationState}`, `missing=${missingCompletionEvidence(observation)}`,
    `plan_complete=${progress.planComplete}`, observation.wrongRunBinding ? 'wrong_run_binding=true' : ''].filter(Boolean).join(';');
}

export interface RuntimeSmokeCompletionResult {
  ok: boolean;
  partial?: Partial<SmokeReport> | null;
  reason?: string;
  progress?: SmokeProgress;
  observationFailures?: readonly string[];
}

interface RuntimeSmokeCompletionInput {
  adapter: RuntimeAdapter; worker: RuntimeWorkerIdentity; binding: SmokeRunBinding; scenarioCount: number; cwd: string;
  startedAtMs: number; previousToken?: RuntimeObservationToken; abortReason: () => string | undefined;
  now?: () => number; sleepMs?: (milliseconds: number) => void; absoluteCeilingMs?: number; progressStallMs?: number;
}

type DeterministicRuntimeSmokeCompletionInput = RuntimeSmokeCompletionInput & {
  now: () => number;
  sleepMs: (milliseconds: number) => void;
};

function recoverableCompletionObservation(reason: string): boolean {
  return reason === 'runtime_timeout' || reason.startsWith('runtime_cli_interrupted:');
}

function boundedObservationTimeout(remainingMs: number): number {
  return Math.max(1, Math.min(remainingMs, SMOKE_ORCA_OPERATION_TIMEOUT_MS));
}

function completionWithFailures(
  result: Omit<RuntimeSmokeCompletionResult, 'observationFailures'>,
  failures: readonly string[],
): RuntimeSmokeCompletionResult {
  return failures.length > 0 ? { ...result, observationFailures: [...failures] } : result;
}

function finalFailureDetail(base: string, failures: readonly string[]): string {
  const last = failures.at(-1);
  return last ? `${base};last_observation_failure=${last}` : base;
}

function waitForRuntimeSmokeCompletionDeterministic(
  input: DeterministicRuntimeSmokeCompletionInput,
): RuntimeSmokeCompletionResult {
  const now = input.now;
  const sleepMs = input.sleepMs;
  const absoluteDeadline = input.startedAtMs + (input.absoluteCeilingMs ?? SMOKE_ABSOLUTE_CEILING_MS);
  const progressStallMs = input.progressStallMs ?? SMOKE_PROGRESS_STALL_MS;
  let lastProgressAt = now(); let acceptedProgress = 0; let postPlanPollMs = SMOKE_LIFECYCLE_POLL_MS;
  let previousPublicationState: SmokeCompletionObservation['publicationState'] | undefined;
  let token = input.previousToken; let completionState = createSmokeCompletionObservationState();
  let lastObservation: SmokeCompletionObservation | undefined; let lastProgress: SmokeProgress | undefined;
  const observationFailures: string[] = [];

  while (now() < absoluteDeadline) {
    const aborted = input.abortReason(); if (aborted) return completionWithFailures({ ok: false, reason: `operator_cancelled:${aborted}` }, observationFailures);
    const progress = inspectSmokeProgress({ artifactDir: input.binding.artifactDir, runId: input.binding.runId, scenarioCount: input.scenarioCount });
    lastProgress = progress;
    const progressIncreased = progress.acceptedCount > acceptedProgress;
    if (progressIncreased) { acceptedProgress = progress.acceptedCount; lastProgressAt = now(); }
    const observed = observeSmokeCompletionEvidence(input.binding, completionState);
    completionState = observed.state; lastObservation = observed.observation;
    const publicationStateChanged = previousPublicationState !== undefined && previousPublicationState !== observed.observation.publicationState;
    previousPublicationState = observed.observation.publicationState;
    if (observed.observation.publicationState === 'publish_complete_single' && observed.observation.partial) return completionWithFailures({ ok: true, partial: observed.observation.partial, progress }, observationFailures);
    if (observed.observation.publicationState === 'publish_complete_duplicate') return completionWithFailures({ ok: false, reason: completionFailureReason('agent_report_duplicate', observed.observation, progress), progress }, observationFailures);
    if (observed.observation.publicationState === 'publish_complete_unfenced') return completionWithFailures({ ok: false, reason: completionFailureReason('agent_report_unfenced', observed.observation, progress), progress }, observationFailures);
    if (observed.observation.wrongRunBinding && (observed.observation.publicationState === 'none' || observed.observation.publicationState === 'partial')) {
      return completionWithFailures({ ok: false, reason: completionFailureReason('agent_idle_without_report', observed.observation, progress), progress }, observationFailures);
    }
    const readDeadline = Math.min(absoluteDeadline, lastProgressAt + progressStallMs);
    const remainingReadMs = readDeadline - now();
    if (remainingReadMs <= 0) return completionWithFailures({ ok: false, reason: completionFailureReason('agent_report_timeout', observed.observation, progress, finalFailureDetail('reason=progress_stall', observationFailures)), progress }, observationFailures);
    const read = input.adapter.readBoundedOutput(
      { worker: input.worker, previousToken: token, limit: 200 },
      { cwd: input.cwd, timeoutMs: boundedObservationTimeout(remainingReadMs) },
    );
    if (read.status !== 'ok') {
      if (!recoverableCompletionObservation(read.reason)) return completionWithFailures({ ok: false, reason: completionFailureReason(failureReason(read), observed.observation, progress), progress }, observationFailures);
      if (observationFailures.length < 16) observationFailures.push(read.reason);
      const interruptedAbort = read.reason.startsWith('runtime_cli_interrupted:') ? input.abortReason() : undefined;
      if (interruptedAbort) return completionWithFailures({ ok: false, reason: `operator_cancelled:${interruptedAbort}`, progress }, observationFailures);
      const remainingAfterRead = readDeadline - now();
      if (remainingAfterRead > 0) sleepMs(Math.min(SMOKE_LIFECYCLE_POLL_MS, Math.max(1, remainingAfterRead)));
      continue;
    }
    token = read.value.observationToken;
    const liveness = input.adapter.liveness({ worker: input.worker, observationWindowMs: SMOKE_LIFECYCLE_POLL_MS }, { cwd: input.cwd });
    if (read.value.terminalState === 'exited' || liveness.status === 'gone') {
      const finalObservation = observeSmokeCompletionEvidence(input.binding, completionState); completionState = finalObservation.state;
      if (finalObservation.observation.publicationState === 'publish_complete_single' && finalObservation.observation.partial) return completionWithFailures({ ok: true, partial: finalObservation.observation.partial, progress }, observationFailures);
      return completionWithFailures({ ok: false, reason: completionFailureReason('agent_exited_without_report', finalObservation.observation, progress), progress }, observationFailures);
    }
    if (now() - lastProgressAt >= progressStallMs) return completionWithFailures({ ok: false, reason: completionFailureReason('agent_report_timeout', observed.observation, progress, finalFailureDetail('reason=progress_stall', observationFailures)), progress }, observationFailures);
    const pendingPublication = observed.observation.publicationState === 'none' || observed.observation.publicationState === 'partial';
    const postPlanPending = progress.planComplete && pendingPublication;
    if (progressIncreased || publicationStateChanged || !postPlanPending) postPlanPollMs = SMOKE_LIFECYCLE_POLL_MS;
    sleepMs(Math.min(postPlanPollMs, Math.max(1, readDeadline - now())));
    if (postPlanPending && !progressIncreased && !publicationStateChanged) postPlanPollMs *= 2; else postPlanPollMs = SMOKE_LIFECYCLE_POLL_MS;
  }
  const progress = lastProgress ?? inspectSmokeProgress({ artifactDir: input.binding.artifactDir, runId: input.binding.runId, scenarioCount: input.scenarioCount });
  const finalObservation = observeSmokeCompletionEvidence(input.binding, completionState);
  if (finalObservation.observation.publicationState === 'publish_complete_single' && finalObservation.observation.partial) return completionWithFailures({ ok: true, partial: finalObservation.observation.partial, progress }, observationFailures);
  return completionWithFailures({ ok: false, reason: completionFailureReason('agent_report_timeout', finalObservation.observation ?? lastObservation!, progress, finalFailureDetail('reason=absolute_safety_ceiling', observationFailures)), progress }, observationFailures);
}

async function waitForRuntimeSmokeCompletionInterruptSafe(
  input: RuntimeSmokeCompletionInput,
): Promise<RuntimeSmokeCompletionResult> {
  const now = () => Date.now();
  const absoluteDeadline = input.startedAtMs + (input.absoluteCeilingMs ?? SMOKE_ABSOLUTE_CEILING_MS);
  const progressStallMs = input.progressStallMs ?? SMOKE_PROGRESS_STALL_MS;
  let lastProgressAt = now(); let acceptedProgress = 0; let postPlanPollMs = SMOKE_LIFECYCLE_POLL_MS;
  let previousPublicationState: SmokeCompletionObservation['publicationState'] | undefined;
  let token = input.previousToken; let completionState = createSmokeCompletionObservationState();
  let lastObservation: SmokeCompletionObservation | undefined; let lastProgress: SmokeProgress | undefined;
  const observationFailures: string[] = [];

  while (now() < absoluteDeadline) {
    const aborted = input.abortReason(); if (aborted) return completionWithFailures({ ok: false, reason: `operator_cancelled:${aborted}` }, observationFailures);
    const progress = inspectSmokeProgress({ artifactDir: input.binding.artifactDir, runId: input.binding.runId, scenarioCount: input.scenarioCount });
    lastProgress = progress;
    const progressIncreased = progress.acceptedCount > acceptedProgress;
    if (progressIncreased) { acceptedProgress = progress.acceptedCount; lastProgressAt = now(); }
    const observed = observeSmokeCompletionEvidence(input.binding, completionState);
    completionState = observed.state; lastObservation = observed.observation;
    const publicationStateChanged = previousPublicationState !== undefined && previousPublicationState !== observed.observation.publicationState;
    previousPublicationState = observed.observation.publicationState;
    if (observed.observation.publicationState === 'publish_complete_single' && observed.observation.partial) return completionWithFailures({ ok: true, partial: observed.observation.partial, progress }, observationFailures);
    if (observed.observation.publicationState === 'publish_complete_duplicate') return completionWithFailures({ ok: false, reason: completionFailureReason('agent_report_duplicate', observed.observation, progress), progress }, observationFailures);
    if (observed.observation.publicationState === 'publish_complete_unfenced') return completionWithFailures({ ok: false, reason: completionFailureReason('agent_report_unfenced', observed.observation, progress), progress }, observationFailures);
    if (observed.observation.wrongRunBinding && (observed.observation.publicationState === 'none' || observed.observation.publicationState === 'partial')) {
      return completionWithFailures({ ok: false, reason: completionFailureReason('agent_idle_without_report', observed.observation, progress), progress }, observationFailures);
    }
    const readDeadline = Math.min(absoluteDeadline, lastProgressAt + progressStallMs);
    const remainingReadMs = readDeadline - now();
    if (remainingReadMs <= 0) return completionWithFailures({ ok: false, reason: completionFailureReason('agent_report_timeout', observed.observation, progress, finalFailureDetail('reason=progress_stall', observationFailures)), progress }, observationFailures);
    const readInput = { worker: input.worker, previousToken: token, limit: 200 };
    const read = input.adapter.readBoundedOutputAsync
      ? await input.adapter.readBoundedOutputAsync(readInput, { cwd: input.cwd, timeoutMs: boundedObservationTimeout(remainingReadMs) })
      : input.adapter.readBoundedOutput(readInput, { cwd: input.cwd, timeoutMs: boundedObservationTimeout(remainingReadMs) });
    await yieldEventLoop();
    const postReadAbort = input.abortReason();
    if (postReadAbort) return completionWithFailures({ ok: false, reason: `operator_cancelled:${postReadAbort}`, progress }, observationFailures);
    if (read.status !== 'ok') {
      if (!recoverableCompletionObservation(read.reason)) return completionWithFailures({ ok: false, reason: completionFailureReason(failureReason(read), observed.observation, progress), progress }, observationFailures);
      if (observationFailures.length < 16) observationFailures.push(read.reason);
      const remainingAfterRead = readDeadline - now();
      if (remainingAfterRead > 0) await sleepAsync(Math.min(SMOKE_LIFECYCLE_POLL_MS, Math.max(1, remainingAfterRead)));
      continue;
    }
    token = read.value.observationToken;
    const liveness = input.adapter.liveness({ worker: input.worker, observationWindowMs: SMOKE_LIFECYCLE_POLL_MS }, { cwd: input.cwd });
    await yieldEventLoop();
    const postLivenessAbort = input.abortReason();
    if (postLivenessAbort) return completionWithFailures({ ok: false, reason: `operator_cancelled:${postLivenessAbort}`, progress }, observationFailures);
    if (read.value.terminalState === 'exited' || liveness.status === 'gone') {
      const finalObservation = observeSmokeCompletionEvidence(input.binding, completionState); completionState = finalObservation.state;
      if (finalObservation.observation.publicationState === 'publish_complete_single' && finalObservation.observation.partial) return completionWithFailures({ ok: true, partial: finalObservation.observation.partial, progress }, observationFailures);
      return completionWithFailures({ ok: false, reason: completionFailureReason('agent_exited_without_report', finalObservation.observation, progress), progress }, observationFailures);
    }
    if (now() - lastProgressAt >= progressStallMs) return completionWithFailures({ ok: false, reason: completionFailureReason('agent_report_timeout', observed.observation, progress, finalFailureDetail('reason=progress_stall', observationFailures)), progress }, observationFailures);
    const pendingPublication = observed.observation.publicationState === 'none' || observed.observation.publicationState === 'partial';
    const postPlanPending = progress.planComplete && pendingPublication;
    if (progressIncreased || publicationStateChanged || !postPlanPending) postPlanPollMs = SMOKE_LIFECYCLE_POLL_MS;
    const remainingAfterObservation = readDeadline - now();
    if (remainingAfterObservation > 0) await sleepAsync(Math.min(postPlanPollMs, Math.max(1, remainingAfterObservation)));
    else await yieldEventLoop();
    if (postPlanPending && !progressIncreased && !publicationStateChanged) postPlanPollMs *= 2; else postPlanPollMs = SMOKE_LIFECYCLE_POLL_MS;
  }
  const progress = lastProgress ?? inspectSmokeProgress({ artifactDir: input.binding.artifactDir, runId: input.binding.runId, scenarioCount: input.scenarioCount });
  const finalObservation = observeSmokeCompletionEvidence(input.binding, completionState);
  if (finalObservation.observation.publicationState === 'publish_complete_single' && finalObservation.observation.partial) return completionWithFailures({ ok: true, partial: finalObservation.observation.partial, progress }, observationFailures);
  return completionWithFailures({ ok: false, reason: completionFailureReason('agent_report_timeout', finalObservation.observation ?? lastObservation!, progress, finalFailureDetail('reason=absolute_safety_ceiling', observationFailures)), progress }, observationFailures);
}

export function waitForRuntimeSmokeCompletion(input: DeterministicRuntimeSmokeCompletionInput): RuntimeSmokeCompletionResult;
export function waitForRuntimeSmokeCompletion(input: RuntimeSmokeCompletionInput): Promise<RuntimeSmokeCompletionResult>;
export function waitForRuntimeSmokeCompletion(
  input: RuntimeSmokeCompletionInput,
): RuntimeSmokeCompletionResult | Promise<RuntimeSmokeCompletionResult> {
  if (input.now && input.sleepMs) return waitForRuntimeSmokeCompletionDeterministic(input as DeterministicRuntimeSmokeCompletionInput);
  return waitForRuntimeSmokeCompletionInterruptSafe(input);
}

function waitForCooperativeShutdown(input: { adapter: RuntimeAdapter; worker: RuntimeWorkerIdentity; binding: SmokeRunBinding; cwd: string }): boolean {
  const deadline = Date.now() + SMOKE_SHUTDOWN_TIMEOUT_MS;
  let completionState = createSmokeCompletionObservationState();
  while (Date.now() < deadline) {
    if (observeSmokeCancellationAcknowledgement(input.binding.artifactDir, input.binding.runId)) return true;
    const observed = observeSmokeCompletionEvidence(input.binding, completionState); completionState = observed.state;
    if (observed.observation.publicationState === 'publish_complete_single') return true;
    input.adapter.readBoundedOutput({ worker: input.worker, limit: 0 }, { cwd: input.cwd, timeoutMs: Math.max(1, deadline - Date.now()) });
    sleep(SMOKE_LIFECYCLE_POLL_MS);
  }
  return false;
}

function verifyPublishedSmokeProvenance(report: SmokeReport): boolean {
  return smokeReportHasPackProducer(report) && verifySmokeReportReceiptProvenance(report);
}

function coverageTarget(target: ResolvedSmokeTarget, liveHeadSha: string): WorkerSmokeTrustedTarget {
  return {
    repositorySlug: target.repositorySlug, issueNumber: target.issueNumber, prNumber: target.prNumber, headSha: target.headSha,
    resolvedIssueNumber: target.issueNumber, resolvedPrNumber: target.prNumber, liveHeadSha,
    issueBodyMatchesTarget: target.issueBodyMatchesTarget, trustedPublisherLogin: target.trustedPublisherLogin,
    commentCensusComplete: true, commentSnapshotStable: true,
  };
}

function ordinaryFullAttemptSelection(plan: SmokeTestPlan): WorkerSmokeSelectiveRetryPlan {
  return {
    fullPlan: plan,
    attemptPlan: { ...plan, scenarios: [...plan.scenarios] },
    carried: [], affectedTupleKeys: [], affectedDiagnostics: [], tupleDiagnostics: [],
  };
}

function selectSmokeAttempt(
  options: CliOptions,
  issueBody: string,
  target: ResolvedSmokeTarget | undefined,
  dependencies: SmokeAttemptDependencies,
): WorkerSmokeSelectiveRetryPlan {
  const fullPlan = resolveSmokeRequirement(issueBody);
  if (!target || fullPlan.requirement !== 'required' || fullPlan.scenarios.length === 0) return ordinaryFullAttemptSelection(fullPlan);
  const fetchHistory = dependencies.fetchHistoryComments ?? fetchPrComments;
  let comments: WorkerSmokeCommentRecord[] = [];
  let historyReadable = true;
  try {
    comments = stabilizeSmokeCommentCensus(() => fetchHistory(target.prNumber, target.repositorySlug, options.repoRoot));
  } catch {
    historyReadable = false;
  }
  const isAncestor = (ancestorSha: string, descendantSha: string): boolean =>
    dependencies.isHistoryAncestor
      ? dependencies.isHistoryAncestor(ancestorSha, descendantSha, target, options)
      : githubCommitIsAncestor(target.repositorySlug, ancestorSha, descendantSha, options.repoRoot);
  return planWorkerSmokeSelectiveRetry({
    issueBody,
    prBody: target.prBody,
    comments,
    target: coverageTarget(target, target.headSha),
    isAncestor,
    historyReadable,
  });
}

export function findVerifiedSmokeReceiptWitness(input: { issueBody: string; comments: readonly WorkerSmokeCommentRecord[]; target: WorkerSmokeTrustedTarget }): SmokeReport | undefined {
  for (const comment of input.comments) {
    const contribution = evaluateWorkerSmokeCoverage({ issueBody: input.issueBody, comments: [comment], target: input.target });
    let candidate = contribution.latestClearingPass;
    const commentId = positiveInteger(comment.id);
    const globalBlock = contribution.diagnostics.globalBlock;
    if (!candidate && commentId > 0 && globalBlock.blocked && globalBlock.commentId === commentId && (globalBlock.kind === 'FAIL' || globalBlock.kind === 'BLOCKED')) {
      const partial = parseSmokeAgentReport(String(comment.body ?? ''));
      if (partial) {
        const normalized = normalizeSmokeReport(partial, { issueNumber: input.target.issueNumber, prNumber: input.target.prNumber, headSha: input.target.headSha });
        if (normalized.ok) candidate = normalized.report;
      }
    }
    if (candidate && verifyPublishedSmokeProvenance(candidate)) return candidate;
  }
  return undefined;
}

export function finalSmokeCommentSnapshotMatches(stabilized: readonly WorkerSmokeCommentRecord[], finalCensus: readonly WorkerSmokeCommentRecord[]): boolean {
  return smokeCommentSnapshotDigest(stabilized) === smokeCommentSnapshotDigest(finalCensus);
}

function runValidatePlan(options: CliOptions): number {
  const result = checkSmokeTestPlan(readIssueBody(options.issueBodyFile));
  if (!result.ok) { for (const error of result.errors) process.stderr.write(`worker-smoke-run: ${error}\n`); return 1; }
  emit({ ok: true, plan: result.plan }, options.json); return 0;
}

export interface GateCheckDependencies {
  evaluateLifecycle: (cwd: string) => ReturnType<typeof evaluateSmokeLifecycleCleanliness>;
  resolveTarget: (options: CliOptions, suppliedIssueBody: string) => ResolvedSmokeTarget;
  fetchComments: (prNumber: number, repositorySlug: string, repoRoot: string) => WorkerSmokeCommentRecord[];
  fetchHead: (prNumber: number, repositorySlug: string, repoRoot: string) => string;
  selectAdapter: (cwd: string) => Promise<RuntimeAdapter>;
  ciGreen: (prNumber: number, headSha: string, repositorySlug: string, repoRoot: string) => boolean;
}

const DEFAULT_GATE_DEPENDENCIES: GateCheckDependencies = {
  evaluateLifecycle: evaluateSmokeLifecycleCleanliness, resolveTarget: resolveSmokeTarget, fetchComments: fetchPrComments,
  fetchHead: fetchLivePrHead, selectAdapter: async (cwd) => selectRuntimeAdapter({}, { cwd }), ciGreen: resolveCiGreen,
};

export async function runGateCheck(options: CliOptions, dependencies: GateCheckDependencies = DEFAULT_GATE_DEPENDENCIES): Promise<number> {
  const lifecycle = dependencies.evaluateLifecycle(options.cwd);
  if (!lifecycle.clean) { emit({ ok: false, allowed: false, reason: `smoke_lifecycle_unclean:${lifecycle.reasons[0]}`, lifecycle }, options.json); return 1; }
  try {
    const suppliedIssueBody = readIssueBody(options.issueBodyFile);
    const target = dependencies.resolveTarget(options, suppliedIssueBody);
    const issueBody = target.issueBody;
    const comments = stabilizeSmokeCommentCensus(() => dependencies.fetchComments(options.prNumber, target.repositorySlug, options.repoRoot));
    const liveHeadSha = dependencies.fetchHead(options.prNumber, target.repositorySlug, options.repoRoot);
    const trustedTarget = coverageTarget(target, liveHeadSha);
    const receiptWitness = findVerifiedSmokeReceiptWitness({ issueBody, comments, target: trustedTarget });
    const adapter = await dependencies.selectAdapter(options.cwd);
    const readiness = adapter.readiness({ cwd: options.cwd });
    let decision = evaluateWorkerSmokeGate({
      issueBody, issueNumber: target.issueNumber, prNumber: target.prNumber, headSha: target.headSha, prComments: comments,
      ciGreen: dependencies.ciGreen(options.prNumber, options.headSha, target.repositorySlug, options.repoRoot),
      orcaWorktreeOk: readiness.status === 'ok', ownedTerminalClosed: Boolean(receiptWitness), terminalProvenanceOk: Boolean(receiptWitness),
      repositorySlug: target.repositorySlug, resolvedIssueNumber: target.issueNumber, resolvedPrNumber: target.prNumber, liveHeadSha,
      issueBodyMatchesTarget: target.issueBodyMatchesTarget, trustedPublisherLogin: target.trustedPublisherLogin,
      commentCensusComplete: true, commentSnapshotStable: true,
    });
    if (decision.allowed) {
      const finalHeadSha = dependencies.fetchHead(options.prNumber, target.repositorySlug, options.repoRoot);
      if (finalHeadSha !== target.headSha) {
        decision = { allowed: false, reason: 'live_pr_head_changed_during_evaluation', smokeRequired: true, diagnostics: decision.diagnostics };
      } else {
        const finalComments = dependencies.fetchComments(options.prNumber, target.repositorySlug, options.repoRoot);
        if (!finalSmokeCommentSnapshotMatches(comments, finalComments)) {
          decision = { allowed: false, reason: 'comment_snapshot_changed_before_allow', smokeRequired: true, diagnostics: decision.diagnostics };
        }
      }
    }
    emit({ ok: decision.allowed, ...decision, lifecycle }, options.json); return decision.allowed ? 0 : 1;
  } catch (error) {
    const reason = scrubSmokeOutput(error instanceof Error ? error.message : String(error));
    emit({ ok: false, allowed: false, reason, smokeRequired: true, lifecycle }, options.json); return 1;
  }
}

interface SmokeOrderingAttemptOwner {
  attemptId: string;
  supervisorPid: number;
  runId?: string;
}

interface SmokeOrderingBinding extends SmokeOrderingAttemptOwner {
  actor: SmokeOrderingActor;
  prNumber: number;
  headSha: string;
  options: PackReviewAuthorityOptions;
}
type SmokeOrderingFailureKind = 'finding' | 'retryable';

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = error instanceof Error && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : '';
    return code === 'EPERM';
  }
  return true;
}

function zeroExecutionCarryOnlyPass(report: SmokeReport, headSha: string): boolean {
  return (report.environmentNotes ?? []).includes('smoke-execution=carry-only')
    || isProvenCarryOnlySmokeReport(report, headSha);
}

function orderingOwnerEvidence(
  marker: { attemptId?: string; supervisorPid?: number; runId?: string } | undefined,
  options: CliOptions,
): SmokeOrderingOwnerEvidence | undefined {
  const attemptId = marker?.attemptId?.trim();
  const supervisorPid = Number(marker?.supervisorPid);
  if (!attemptId || !Number.isInteger(supervisorPid) || supervisorPid <= 0) return undefined;
  const runId = marker?.runId?.trim() || undefined;
  let authoritativeResult: SmokeReport['result'] | undefined;
  let executionMode: 'executed' | 'carry-only' | undefined;
  let cleanupSafe: boolean | undefined;
  if (runId) {
    const artifactDir = resolveSmokeRunArtifactDir(options.cwd, runId);
    const runtime = readWorkerSmokeRunFinalEvidence({
      artifactDir, runId, issueNumber: options.issueNumber, prNumber: options.prNumber, headSha: options.headSha, mode: 'runtime',
    });
    const noExecution = runtime ? null : readWorkerSmokeRunFinalEvidence({
      artifactDir, runId, issueNumber: options.issueNumber, prNumber: options.prNumber, headSha: options.headSha, mode: 'no_execution',
    });
    const selected = runtime ?? noExecution;
    authoritativeResult = selected?.result;
    if (selected?.result === 'PASS' && selected.mode === 'no_execution' && zeroExecutionCarryOnlyPass(selected.report, options.headSha)) {
      executionMode = 'carry-only';
    } else if (runtime?.result === 'PASS') {
      executionMode = 'executed';
    }
    const registry = readSmokeLifecycleRegistry(artifactDir);
    cleanupSafe = Boolean(
      registry
      && registry.runId === runId
      && (
        !registry.terminalHandle
        || (registry.spawnState === 'clean' && hasValidSmokeCloseReceipt(artifactDir))
      )
    );
  }
  return {
    attemptId,
    supervisorPid,
    ...(runId ? { runId } : {}),
    supervisorAlive: processIsAlive(supervisorPid),
    ...(cleanupSafe !== undefined ? { cleanupSafe } : {}),
    ...(authoritativeResult ? { authoritativeResult } : {}),
    ...(executionMode ? { executionMode } : {}),
  };
}

export function beginSmokeOrdering(
  options: CliOptions,
  issueBody: string,
  owner: SmokeOrderingAttemptOwner,
): SmokeOrderingBinding | null {
  const actor = options.smokeActor ?? 'worker-owned';
  if (actor !== 'worker-owned' && actor !== 'independent') throw new Error('smoke_actor_unsupported');
  const required = smokeOrderingRequired(issueBody);
  const plan = resolveSmokeRequirement(issueBody);
  if (!required && (actor !== 'worker-owned' || plan.requirement !== 'not-applicable')) return null;
  const fence = parseComplexityTierFence(issueBody);
  if (fence.kind !== 'tier-fence') {
    if (actor === 'worker-owned' && plan.requirement !== 'not-applicable') return null;
    if (actor !== 'worker-owned') throw new Error('smoke_ordering_tier_missing');
  }
  const projectId = 'orchestrator-pack';
  const storeRoot = resolvePackReviewRunStoreRoot({ projectId, storeRoot: process.env.PACK_REVIEW_RUN_STORE_ROOT });
  const authorityOptions: PackReviewAuthorityOptions = { storeRoot };
  const reviewRuns = listPackReviewRuns({ projectId, storeRoot });
  let authority = initializePackReviewAuthority({
    prNumber: options.prNumber, headSha: options.headSha,
    tier: (fence.kind === 'tier-fence' ? fence.tier : resolveTierAndCap({ issueBody }).tier) as PackReviewTier,
    options: authorityOptions,
  });
  if (actor === 'worker-owned' && authority.currentHeadSha !== options.headSha.toLowerCase()) {
    authority = observePackReviewHead({ prNumber: options.prNumber, expectedTransitionSeq: authority.transitionSeq, headSha: options.headSha, options: authorityOptions, reviewRuns });
  }
  const existingOwner = actor === 'worker-owned'
    ? authority.smokeOrdering?.workerOwned
    : authority.smokeOrdering?.independent;
  commitSmokeOrderingTransition({
    prNumber: options.prNumber, expectedTransitionSeq: authority.transitionSeq, actor, headSha: options.headSha, status: 'started',
    ...owner,
    ...(existingOwner?.status === 'started'
      ? { ownerStateEvidence: orderingOwnerEvidence(existingOwner, options) }
      : {}),
    ...(actor === 'independent' ? { reviewRuns, operatorSmokeOnly: options.operatorSmokeOnly } : {}), options: authorityOptions,
  });
  return { actor, prNumber: options.prNumber, headSha: options.headSha, options: authorityOptions, ...owner };
}

function finishSmokeOrdering(binding: SmokeOrderingBinding | null, status: 'passed' | 'failed', failureKind: SmokeOrderingFailureKind = 'retryable'): void {
  if (!binding) return;
  const authority = readPackReviewAuthority(binding.prNumber, binding.options);
  if (!authority) throw new Error('smoke_ordering_authority_missing_at_terminal');
  commitSmokeOrderingTransition({
    prNumber: binding.prNumber, expectedTransitionSeq: authority.transitionSeq, actor: binding.actor,
    headSha: binding.headSha, status, attemptId: binding.attemptId, supervisorPid: binding.supervisorPid,
    ...(binding.runId ? { runId: binding.runId } : {}),
    ...(status === 'failed' ? { failureKind } : {}), options: binding.options,
  });
}

export function finishSmokeOrderingBeforeDetachedTerminalization(
  finishOrdering: () => void,
  terminalizeDetached?: () => void,
): void {
  finishOrdering();
  terminalizeDetached?.();
}

async function directSmokeStartFence<T>(action: () => T | Promise<T>): Promise<SmokeStartFenceResult<T>> { return { ok: true, value: await action() }; }

function terminalizeDetachedRun(options: CliOptions, runId: string, artifactDir: string, mode: 'runtime' | 'no_execution', report: SmokeReport): void {
  if (!options.detachedOwner) return;
  const final = writeWorkerSmokeRunFinalEvidence({ artifactDir, runId, mode, report });
  markSmokeLauncherTerminalized({
    artifactDir,
    runId,
    finalEvidencePath: smokeRunFinalEvidencePath(artifactDir),
    nowMs: final.recordedAtMs,
  });
}

interface DetachedTerminalizationRequest {
  readonly runId: string;
  readonly artifactDir: string;
  readonly mode: 'runtime' | 'no_execution';
  readonly report: SmokeReport;
}

function completionObservationNotes(completion: RuntimeSmokeCompletionResult): string[] {
  return (completion.observationFailures ?? []).map((reason) => `smoke-observation=${reason}`);
}

function preAttemptPublication(
  attemptId: string,
  operatorOverrideReason: string | undefined,
  overrides: Partial<SmokePublicationBinding> = {},
): SmokePublicationBinding {
  return {
    attemptId,
    executionMode: 'carry-only',
    attemptObservations: [],
    ...(operatorOverrideReason ? { operatorOverrideReason } : {}),
    ...overrides,
  };
}

export async function runSmokeAttempt(options: CliOptions, dependencies: SmokeAttemptDependencies = {}): Promise<number> {
  const publishComment = dependencies.publishComment ?? publishPrComment;
  const suppliedIssueBody = readIssueBody(options.issueBodyFile);
  let issueBody = suppliedIssueBody;
  let resolvedTarget: ResolvedSmokeTarget | undefined;
  let trustedTargetHeadMismatch: string | undefined;
  const suppliedPlan = resolveSmokeRequirement(suppliedIssueBody);
  const requiredPlan = suppliedPlan.requirement === 'required';
  const workerOwnedNotApplicable = (options.smokeActor ?? 'worker-owned') === 'worker-owned' && suppliedPlan.requirement === 'not-applicable';
  if (requiredPlan || workerOwnedNotApplicable) {
    try {
      if (dependencies.resolveTarget) {
        resolvedTarget = dependencies.resolveTarget(options, suppliedIssueBody);
        issueBody = resolvedTarget.issueBody;
      } else if (dependencies.resolveIssueBody) {
        issueBody = dependencies.resolveIssueBody(options, suppliedIssueBody);
      } else {
        resolvedTarget = resolveSmokeTarget(options, suppliedIssueBody);
        issueBody = resolvedTarget.issueBody;
      }
      if (typeof issueBody !== 'string') throw new Error('trusted_target: Issue body resolver returned a non-string value');
    } catch (error) {
      const observed = scrubSmokeOutput(error instanceof Error ? error.message : String(error));
      if (observed.startsWith('trusted_target_head_mismatch:')) {
        trustedTargetHeadMismatch = observed;
      } else {
        const report = operationalReport('harness_admission_refused', options, {
          action: 'bind smoke to trusted live Issue and PR', expected: 'supplied body, open Issue/PR, and exact live PR head match',
          observed,
        });
        publishSmokeReport(report, options, undefined, publishComment); emit({ ok: false, report }, options.json); return 1;
      }
    }
  }
  const plan = resolveSmokeRequirement(issueBody);
  if (plan.requirement !== 'required') {
    if (plan.requirement === 'not-applicable' && (options.smokeActor ?? 'worker-owned') === 'worker-owned') {
      const attemptId = options.detachedOwner && (options.runId ?? '').trim() ? (options.runId ?? '').trim() : createSmokeRunIdentity();
      const orderingBinding = beginSmokeOrdering(options, issueBody, { attemptId, supervisorPid: process.pid });
      finishSmokeOrdering(orderingBinding, 'passed');
    }
    emit({ ok: true, skipped: true, reason: plan.requirement }, options.json); return 0;
  }
  if (plan.scenarios.length === 0) {
    const report = operationalReport('unknown', options, { action: 'parse smoke-test-plan', expected: 'at least one scenario', observed: 'zero_parsed_scenarios' });
    publishSmokeReport(report, options, undefined, publishComment); emit({ ok: false, report }, options.json); return 1;
  }

  const selection = selectSmokeAttempt(options, issueBody, resolvedTarget, dependencies);
  const attemptPlan = selection.attemptPlan;
  let overrideReason: string | undefined;
  try {
    overrideReason = validateWorkerSmokeOperatorOverrideReason(options.operatorOverrideReason);
  } catch (error) {
    emit({ ok: false, reason: scrubSmokeOutput(error instanceof Error ? error.message : String(error)) }, options.json);
    return 1;
  }
  const retryAdmission = evaluateSameHeadBlockedRetryAdmission({
    receipts: listWorkerSmokeReceipts(options.prNumber, options.headSha),
    selectedScenarios: attemptPlan.scenarios,
    ...(overrideReason ? { operatorOverrideReason: overrideReason } : {}),
  });
  if (!retryAdmission.allowed) {
    emit({ ok: false, attempted: false, reason: 'smoke_blocked_precondition_unchanged', blockedTuples: retryAdmission.blockedTuples }, options.json);
    return 1;
  }
  const appliedOverrideReason = retryAdmission.blockedTuples.length > 0 ? overrideReason : undefined;
  const attemptId = options.detachedOwner && (options.runId ?? '').trim()
    ? (options.runId ?? '').trim()
    : createSmokeRunIdentity();
  const preAttempt = preAttemptPublication(attemptId, appliedOverrideReason);

  if (trustedTargetHeadMismatch) {
    const report = operationalReport(workerSmokeCauseFamilyForHarnessReason(trustedTargetHeadMismatch), options, {
      action: 'bind smoke to trusted live Issue and PR',
      expected: 'supplied body, open Issue/PR, and exact live PR head match',
      observed: trustedTargetHeadMismatch,
    });
    publishSmokeReport(report, options, preAttempt, publishComment);
    emit({ ok: false, report, attemptId }, options.json);
    return 1;
  }

  let trackedSmokeRuntimePaths: string[];
  try {
    trackedSmokeRuntimePaths = gitTrackedSmokeRuntimePaths(options.cwd);
  } catch (error) {
    const report = operationalReport('harness_admission_refused', options, {
      action: 'verify worker-smoke harness tracking state',
      expected: 'git index is readable before smoke execution',
      observed: scrubSmokeOutput(error instanceof Error ? error.message : String(error)),
    });
    publishSmokeReport(report, options, preAttempt, publishComment); emit({ ok: false, report, attemptId }, options.json); return 1;
  }
  if (trackedSmokeRuntimePaths.length > 0) {
    const report = operationalReport('harness_dirty_worktree', options, {
      action: 'verify worker-smoke harness runtime state is untracked',
      expected: 'no .orca-worker-smoke/** path is tracked or staged',
      observed: trackedSmokeRuntimePaths.join(', '),
    });
    publishSmokeReport(report, options, preAttempt, publishComment); emit({ ok: false, report, attemptId }, options.json); return 1;
  }

  let smokeProfile: SmokeExecutorProfile;
  let profileEnv: Readonly<NodeJS.ProcessEnv> = process.env;
  try {
    profileEnv = overlayExecutorProfileEnv(process.env);
    const injectedDryRunHarness = options.dryRun && dependencies.adapter !== undefined;
    smokeProfile = dependencies.resolveProfile ? dependencies.resolveProfile(options.smokeComplexity, profileEnv)
      : injectedDryRunHarness ? resolveSmokeExecutorProfile(options.smokeComplexity, profileEnv)
      : resolveLiveSmokeExecutorProfile(options.smokeComplexity, profileEnv,
        (args, env) => runSmokeProfileChild(args, options.cwd, profileEnv, env), options.cwd, proveOpenCodeNoWrite);
  } catch (error) {
    const report = operationalReport('harness_admission_refused', options, {
      action: 'resolve smoke executor profile', expected: 'one supported smoke profile applied before child creation',
      observed: scrubSmokeOutput(error instanceof Error ? error.message : String(error)),
    });
    publishSmokeReport(report, options, preAttempt, publishComment); emit({ ok: false, report }, options.json); return 1;
  }

  const adapter = dependencies.adapter ?? await selectRuntimeAdapter({}, { cwd: options.cwd, transport: { env: { ...profileEnv } } });
  const readiness = adapter.readiness({ cwd: options.cwd });
  if (readiness.status !== 'ok') {
    const report = operationalReport('harness_admission_refused', options, { action: 'resolve runtime worktree', expected: 'current worktree is runtime-managed', observed: failureReason(readiness), adapterId: adapter.id });
    publishSmokeReport(report, options, preAttempt, publishComment); emit({ ok: false, report }, options.json); return 1;
  }
  const headBinding = verifySmokeHeadBinding({ requestedHeadSha: options.headSha, orcaHeadSha: readiness.value.headSha, gitHeadSha: gitHead(options.cwd) });
  if (!headBinding.ok) {
    const report = operationalReport('harness_head_mismatch', options, { action: 'bind smoke to current head', expected: options.headSha, observed: `${headBinding.reason}:${headBinding.observed}`, adapterId: adapter.id });
    publishSmokeReport(report, options, preAttempt, publishComment); emit({ ok: false, report }, options.json); return 1;
  }

  let orderingBinding: SmokeOrderingBinding | null = null;
  let orderingOutcome: 'passed' | 'failed' = 'failed';
  let orderingFailureKind: SmokeOrderingFailureKind = 'retryable';
  let publishedPassRecorded = false;
  const recordPublishedOrdering = (report: SmokeReport, published: boolean): void => {
    if (!published || publishedPassRecorded) return;
    orderingOutcome = report.result === 'PASS' ? 'passed' : 'failed';
    orderingFailureKind = report.result === 'FAIL' ? 'finding' : 'retryable';
    if (report.result === 'PASS') publishedPassRecorded = true;
  };
  let pendingDetachedTerminalization: DetachedTerminalizationRequest | undefined;
  const deferDetachedTerminalization = (
    runId: string,
    artifactDir: string,
    mode: DetachedTerminalizationRequest['mode'],
    report: SmokeReport,
  ): void => {
    if (!options.detachedOwner) return;
    pendingDetachedTerminalization = { runId, artifactDir, mode, report };
  };
  const settleSmokeOrderingAndDetachedTerminalization = (): void => {
    const pending = pendingDetachedTerminalization;
    finishSmokeOrderingBeforeDetachedTerminalization(
      () => finishSmokeOrdering(orderingBinding, orderingOutcome, orderingFailureKind),
      pending ? () => terminalizeDetachedRun(options, pending.runId, pending.artifactDir, pending.mode, pending.report) : undefined,
    );
    pendingDetachedTerminalization = undefined;
  };
  const beforeStatus = gitPorcelain(options.cwd);
  if (hasPreexistingTrackedDirtiness(beforeStatus)) {
    const report = operationalReport('harness_dirty_worktree', options, {
      action: 'verify clean tracked worktree', expected: 'no tracked modifications', observed: trackedPorcelainPaths(beforeStatus).join(', '), adapterId: adapter.id,
    });
    publishSmokeReport(report, options, preAttempt, publishComment); emit({ ok: false, report }, options.json); return 1;
  }
  const beforeHashes = hashTrackedPaths(options.cwd, trackedPorcelainPaths(beforeStatus));

  if (attemptPlan.scenarios.length === 0 && !selection.fallbackReason) {
    const lifecycle = evaluateSmokeLifecycleCleanliness(options.cwd);
    const detachedRunId = options.detachedOwner ? (options.runId ?? '').trim() : '';
    const detachedArtifactDir = detachedRunId ? resolveSmokeRunArtifactDir(options.cwd, detachedRunId) : '';
    if (detachedRunId) {
      createSmokeNoExecutionLifecycle({
        runId: detachedRunId,
        artifactDir: detachedArtifactDir,
        issueNumber: options.issueNumber,
        prNumber: options.prNumber,
        headSha: options.headSha,
      });
    }
    const carryPublication = preAttemptPublication(attemptId, appliedOverrideReason, {
      ...(detachedRunId ? { runId: detachedRunId } : {}),
      executionMode: 'carry-only',
    });
    if (!lifecycle.clean) {
      const report = operationalReport('harness_admission_refused', options, {
        action: 'verify carry-only smoke lifecycle cleanliness', expected: 'no unresolved prior smoke lifecycle before carry-only publication',
        observed: `smoke_lifecycle_unclean:${lifecycle.reasons[0] ?? 'unknown'}`, terminalCleanup: 'not_started_no_execution', adapterId: adapter.id,
      });
      publishSmokeReport(report, options, carryPublication, publishComment);
      if (detachedRunId) terminalizeDetachedRun(options, detachedRunId, detachedArtifactDir, 'no_execution', report);
      emit({ ok: false, report, lifecycle }, options.json); return 1;
    }
    try {
      orderingBinding = beginSmokeOrdering(options, issueBody, {
        attemptId,
        supervisorPid: process.pid,
        ...(detachedRunId ? { runId: detachedRunId } : {}),
      });
      const projected = projectWorkerSmokeSelectiveReport({
        partial: {
          result: 'PASS', scenarios: [], limitations: [], trackedFilesUnmodified: true,
          terminalCleanup: 'not_started_no_execution',
          environmentNotes: [
            'smoke-execution=carry-only',
            `smoke-attempt-scenarios=0/${plan.scenarios.length}`,
          ],
          producer: SMOKE_REPORT_PRODUCER, orcaExecutable: adapter.id,
        },
        selection,
      });
      const normalized = normalizeSmokeReport({
        ...projected,
        result: projected.result ?? 'FAIL',
        scenarios: projected.scenarios ?? [],
        limitations: projected.limitations ?? [],
        trackedFilesUnmodified: projected.trackedFilesUnmodified ?? true,
        terminalCleanup: 'not_started_no_execution',
        environmentNotes: projected.environmentNotes ?? [],
        producer: SMOKE_REPORT_PRODUCER, orcaExecutable: adapter.id,
      }, { issueNumber: options.issueNumber, prNumber: options.prNumber, headSha: options.headSha }, { executionMode: 'carry-only' });
      const report = normalized.report;
      const workerOwnedCarryOnlyPass = report.result === 'PASS'
        && (options.smokeActor ?? 'worker-owned') === 'worker-owned';
      if (workerOwnedCarryOnlyPass) {
        orderingOutcome = 'failed';
        orderingFailureKind = 'retryable';
      }
      publishSmokeReport(
        report,
        options,
        carryPublication,
        publishComment,
        workerOwnedCarryOnlyPass ? undefined : () => { recordPublishedOrdering(report, true); },
      );
      let postSmoke: PostSmokeReadinessResult | undefined;
      if (report.result === 'PASS' && !options.dryRun) {
        try {
          const target = resolveSmokeTarget(options, issueBody);
          postSmoke = await evaluatePostSmokeReadiness(options, target, adapter);
        } catch (error) {
          postSmoke = {
            readiness: { state: 'NOT_READY', ready: false, failedPredicates: [`post_smoke_readiness_unavailable:${scrubSmokeOutput(error instanceof Error ? error.message : String(error))}`] },
            reviewProjection: { state: 'error', description: 'post-smoke review reconciliation unavailable', reason: 'missing-review' },
            smokeEvidence: { state: 'unavailable', headSha: options.headSha },
          };
        }
      }
      if (detachedRunId) deferDetachedTerminalization(detachedRunId, detachedArtifactDir, 'no_execution', report);
      emit({ ok: report.result === 'PASS', report, lifecycle, attemptId, selection: {
        attempted: 0, carried: selection.carried.length, fallbackReason: selection.fallbackReason,
        affectedDiagnostics: selection.affectedDiagnostics.length, tupleDiagnostics: selection.tupleDiagnostics.length,
      }, ...(postSmoke ? { postSmoke } : {}) }, options.json);
      return report.result === 'PASS' ? 0 : 1;
    } catch (error) {
      const observed = scrubSmokeOutput(error instanceof Error ? error.message : String(error));
      const report = operationalReport(workerSmokeCauseFamilyForHarnessReason(observed), options, {
        action: 'publish carry-only selective smoke', expected: 'fresh current-head report without runtime lifecycle',
        observed,
        terminalCleanup: 'not_started_no_execution', adapterId: adapter.id,
      });
      publishSmokeReport(report, options, carryPublication, publishComment, () => { recordPublishedOrdering(report, true); });
      if (detachedRunId) deferDetachedTerminalization(detachedRunId, detachedArtifactDir, 'no_execution', report);
      emit({ ok: false, report, lifecycle, attemptId }, options.json); return 1;
    } finally {
      try { settleSmokeOrderingAndDetachedTerminalization(); } catch { /* missing ordering/final evidence remains fail-closed */ }
    }
  }

  const runId = attemptId;
  const artifactDir = resolveSmokeRunArtifactDir(options.cwd, runId);
  const runPublication: SmokePublicationBinding = {
    attemptId,
    runId,
    executionMode: 'executed',
    attemptObservations: [],
    ...(appliedOverrideReason ? { operatorOverrideReason: appliedOverrideReason } : {}),
  };
  let startedAtMs = 0; let worker: RuntimeWorkerIdentity | undefined; let terminalCleanup = 'pending'; let cleanupFinished = false; let signalReason: string | undefined;
  const onSigint = (): void => { signalReason = 'SIGINT'; };
  const onSigterm = (): void => { signalReason = 'SIGTERM'; };
  process.once('SIGINT', onSigint); process.once('SIGTERM', onSigterm);

  const cleanup = (reason: string, requestCancellation: boolean) => {
    let acknowledged = false;
    if (worker && requestCancellation) {
      if (writeSmokeCancelRequest({ artifactDir, runId, reason })) acknowledged = waitForCooperativeShutdown({ adapter, worker, binding: { runId, artifactDir }, cwd: options.cwd });
    }
    const result = cleanupSmokeLifecycle({
      artifactDir, runId, reason, requestCancellation, cooperativeAcknowledgementObserved: acknowledged,
      closeBoundHandle: (handle) => {
        if (!worker || handle !== worker.id) return 'close_failed:identity_binding_mismatch';
        return runtimeClose(adapter, worker, options);
      },
    });
    terminalCleanup = result.closeOutcome; cleanupFinished = true; releaseSmokeAdmission(options.cwd, runId); return result;
  };

  try {
    const admission = preflightSmokeLifecycle({ repoRoot: options.cwd, runId, closeBoundHandle: (handle) => runtimeCloseBoundHandle(adapter, handle, options) });
    if (!admission.admitted) {
      const report = operationalReport('harness_admission_refused', options, { action: 'acquire smoke spawn admission', expected: 'exclusive admission before spawn', observed: admission.reason ?? 'admission_refused', adapterId: adapter.id });
      publishSmokeReport(report, options, preAttempt, publishComment); emit({ ok: false, report, lifecycle: admission, attemptId }, options.json); return 1;
    }

    const startFence = dependencies.startFence ?? directSmokeStartFence;
    const start = await startFence(async () => {
      startedAtMs = Date.now(); ensureSmokeRunArtifactDir(artifactDir);
      createSmokeLifecycleReservation({
        runId, artifactDir, issueNumber: options.issueNumber, prNumber: options.prNumber, headSha: options.headSha,
        nowMs: startedAtMs, createTimeoutMs: SMOKE_CREATE_TIMEOUT_MS, scenarioCount: attemptPlan.scenarios.length,
      });
      markSmokeCreateInProgress(artifactDir);
      orderingBinding = beginSmokeOrdering(options, issueBody, { attemptId, supervisorPid: process.pid, runId });
      const spawned = adapter.spawnWorker({ title: `smoke-${options.issueNumber}`, command: smokeProfile.command, workspace: 'active' }, { cwd: options.cwd, timeoutMs: SMOKE_CREATE_TIMEOUT_MS });
      if (spawned.status !== 'ok') {
        const reason = failureReason(spawned); markSmokeCreateAmbiguous(artifactDir, reason); releaseSmokeAdmission(options.cwd, runId);
        return { kind: 'spawn_failed' as const, reason };
      }
      worker = spawned.value.identity; bindSmokeTerminalHandle(artifactDir, worker.id); return { kind: 'started' as const };
    });

    if (!start.ok) {
      if (!start.actionEntered) { releaseSmokeAdmission(options.cwd, runId); emit({ ok: true, skipped: true, attempted: false, reason: start.reason }, options.json); return 0; }
      throw new Error(`smoke_start_fence_post_entry:${start.reason}`);
    }
    if (start.value.kind === 'spawn_failed') {
      const report = operationalReport('harness_observation_interrupted', options, { action: 'spawn runtime smoke worker', expected: 'composite worker identity', observed: start.value.reason, terminalCleanup: 'ambiguous_unbound', adapterId: adapter.id });
      publishSmokeReport(report, options, runPublication, publishComment, () => { recordPublishedOrdering(report, true); });
      deferDetachedTerminalization(runId, artifactDir, 'runtime', report);
      emit({ ok: false, report, attemptId }, options.json); return 1;
    }
    if (!worker || startedAtMs <= 0) throw new Error('smoke_start_prefix_incomplete');

    const binding = { runId, artifactDir };
    const prompt = buildLifecyclePrompt(buildSmokeAgentPrompt({
      issueNumber: options.issueNumber, issueBody, prNumber: options.prNumber, headSha: options.headSha, plan: attemptPlan, runBinding: binding,
    }), binding, attemptPlan.scenarios.length);
    const delivery = establishRuntimeSmokeDelivery({ adapter, worker, prompt, binding, cwd: options.cwd, deadlineMs: SMOKE_DELIVERY_TIMEOUT_MS });
    if (!delivery.ok) {
      const lifecycleCleanup = cleanup(delivery.reason ?? 'prompt_delivery_unconfirmed', true);
      const family = lifecycleCleanup.clean
        ? workerSmokeCauseFamilyForHarnessReason(delivery.reason ?? 'prompt_delivery_unconfirmed')
        : 'lifecycle_cleanup_failed';
      const report = operationalReport(family, options, {
        action: 'dispatch smoke prompt once', expected: 'one dispatch attempt plus child-sealed delivery evidence', observed: delivery.reason ?? 'prompt_delivery_unconfirmed',
        terminalCleanup, environmentNotes: [`submit-count=${delivery.submitCount}`, `lifecycle-clean=${lifecycleCleanup.clean}`], worker, adapterId: adapter.id,
      });
      publishSmokeReport(report, options, runPublication, publishComment, () => { recordPublishedOrdering(report, true); });
      deferDetachedTerminalization(runId, artifactDir, 'runtime', report);
      emit({ ok: false, report, lifecycleCleanup, attemptId }, options.json); return 1;
    }

    const completion = await waitForRuntimeSmokeCompletion({
      adapter, worker, binding, scenarioCount: attemptPlan.scenarios.length, cwd: options.cwd, startedAtMs,
      previousToken: delivery.observationToken, abortReason: () => signalReason,
    });
    if (!completion.ok || !completion.partial) {
      const lifecycleCleanup = cleanup(completion.reason ?? 'agent_report_timeout', true);
      const family = lifecycleCleanup.clean
        ? workerSmokeCauseFamilyForHarnessReason(completion.reason ?? 'agent_report_timeout')
        : 'lifecycle_cleanup_failed';
      const report = operationalReport(family, options, {
        action: 'wait for sealed smoke completion', expected: 'legal progress and one sealed report', observed: completion.reason ?? 'agent_report_timeout',
        terminalCleanup, limitations: completion.progress?.invalidEvents.slice(0, 10),
        environmentNotes: [`lifecycle-clean=${lifecycleCleanup.clean}`, ...completionObservationNotes(completion)], worker, adapterId: adapter.id,
      });
      publishSmokeReport(report, options, runPublication, publishComment, () => { recordPublishedOrdering(report, true); });
      deferDetachedTerminalization(runId, artifactDir, 'runtime', report);
      emit({ ok: false, report, lifecycleCleanup, attemptId }, options.json); return 1;
    }

    const afterStatus = gitPorcelain(options.cwd);
    const afterHashes = hashTrackedPaths(options.cwd, trackedPorcelainPaths(afterStatus));
    const mutated = detectTrackedImplementationMutation(beforeStatus, afterStatus, beforeHashes, afterHashes);
    const attemptBound = attemptPlan.scenarios.length === 0
      ? completion.partial
      : bindSmokeReportToPlan(completion.partial, attemptPlan);
    const freshAttemptObservations = attemptObservationsFromScenarios(attemptBound.scenarios);
    const projected = projectWorkerSmokeSelectiveReport({ partial: attemptBound, selection });
    const selectiveNotes = [
      ...(projected.environmentNotes ?? []),
      ...completionObservationNotes(completion),
      `smoke-attempt-scenarios=${attemptPlan.scenarios.length}/${plan.scenarios.length}`,
      ...(selection.fallbackReason ? [`smoke-selective-fallback=${selection.fallbackReason}`] : []),
      ...(selection.affectedDiagnostics.length > 0 ? [`smoke-affected-diagnostics=${selection.affectedDiagnostics.length}`] : []),
      ...(selection.tupleDiagnostics.length > 0 ? [`smoke-rerun-diagnostics=${selection.tupleDiagnostics.length}`] : []),
    ];
    const normalized = normalizeSmokeReport({
      ...projected,
      result: mutated ? 'FAIL' : projected.result ?? 'FAIL',
      scenarios: projected.scenarios ?? [],
      limitations: projected.limitations ?? [],
      trackedFilesUnmodified: !mutated && (projected.trackedFilesUnmodified ?? true),
      terminalCleanup: 'pending', environmentNotes: selectiveNotes,
      producer: SMOKE_REPORT_PRODUCER, orcaExecutable: adapter.id, terminalHandle: worker.id,
      ...(mutated ? { causeFamily: 'harness_dirty_worktree' as const } : {}),
    }, { issueNumber: options.issueNumber, prNumber: options.prNumber, headSha: options.headSha });
    const lifecycleCleanup = cleanup('completed', false);
    const report = normalized.report;
    report.terminalCleanup = terminalCleanup;
    if (!lifecycleCleanup.clean && report.result === 'PASS') report.result = 'FAIL';
    if (!lifecycleCleanup.clean) report.causeFamily = 'lifecycle_cleanup_failed';
    publishSmokeReport(report, options, { ...runPublication, attemptObservations: freshAttemptObservations }, publishComment, () => { recordPublishedOrdering(report, true); });
    let postSmoke: PostSmokeReadinessResult | undefined;
    if (report.result === 'PASS' && !options.dryRun) {
      try {
        const target = resolveSmokeTarget(options, issueBody);
        postSmoke = await evaluatePostSmokeReadiness(options, target, adapter);
      } catch (error) {
        postSmoke = {
          readiness: { state: 'NOT_READY', ready: false, failedPredicates: [`post_smoke_readiness_unavailable:${scrubSmokeOutput(error instanceof Error ? error.message : String(error))}`] },
          reviewProjection: { state: 'error', description: 'post-smoke review reconciliation unavailable', reason: 'missing-review' },
          smokeEvidence: { state: 'unavailable', headSha: options.headSha },
        };
      }
    }
    deferDetachedTerminalization(runId, artifactDir, 'runtime', report);
    emit({ ok: report.result === 'PASS', report, lifecycleCleanup, attemptId, runId, selection: {
      attempted: attemptPlan.scenarios.length, carried: selection.carried.length, fallbackReason: selection.fallbackReason,
      affectedDiagnostics: selection.affectedDiagnostics.length, tupleDiagnostics: selection.tupleDiagnostics.length,
    }, ...(postSmoke ? { postSmoke } : {}) }, options.json);
    return report.result === 'PASS' ? 0 : 1;
  } catch (error) {
    const observed = scrubSmokeOutput(error instanceof Error ? error.message : 'handled_exception');
    if (worker && !cleanupFinished) cleanup('handled_exception', true);
    else if (!worker && startedAtMs > 0) { try { markSmokeCreateAmbiguous(artifactDir, observed); } catch { /* fail closed */ } releaseSmokeAdmission(options.cwd, runId); }
    const family: WorkerSmokeCauseFamily = cleanupFinished && terminalCleanup.startsWith('close_failed')
      ? 'lifecycle_cleanup_failed'
      : workerSmokeCauseFamilyForHarnessReason(observed);
    const report = operationalReport(family, options, {
      action: 'run runtime-neutral worker smoke', expected: 'bounded terminal lifecycle', observed,
      terminalCleanup: worker ? terminalCleanup : startedAtMs > 0 ? 'ambiguous_unbound' : 'not_started', worker, adapterId: adapter.id,
    });
    const publication = startedAtMs > 0 ? runPublication : preAttempt;
    publishSmokeReport(report, options, publication, publishComment, () => { recordPublishedOrdering(report, true); });
    if (options.detachedOwner && cleanupFinished) deferDetachedTerminalization(runId, artifactDir, 'runtime', report);
    emit({ ok: false, report, attemptId }, options.json); return 1;
  } finally {
    try { settleSmokeOrderingAndDetachedTerminalization(); } catch { /* missing ordering/final evidence remains fail-closed */ }
    process.off('SIGINT', onSigint); process.off('SIGTERM', onSigterm);
    if (worker && !cleanupFinished) { try { cleanup('finally_cleanup', true); } catch { /* lifecycle remains blocking */ } }
    releaseSmokeAdmission(options.cwd, runId);
  }
}

function detachedChildIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function runDetachedBootstrap(argv: readonly string[], options: CliOptions): Promise<number> {
  if (options.detachedOwner || options.runId) throw new Error('detached bootstrap may not supply --detached-owner or --run');
  const runId = createSmokeRunIdentity();
  const childArgs = argv.filter((value) => value !== '--detach');
  childArgs.push('--detached-owner', '--run', runId);
  const env = { ...process.env };
  delete env.WORKER_SMOKE_WRAPPER_STATE_FILE;
  const entrypoint = fileURLToPath(import.meta.url);
  const detachHelper = [
    'import { spawn } from "node:child_process";',
    'const [entrypoint,...args]=process.argv.slice(1);',
    'const child=spawn(process.execPath,["--experimental-strip-types",entrypoint,...args],{cwd:process.cwd(),env:process.env,detached:true,stdio:"ignore",windowsHide:true});',
    'child.once("error",()=>process.exit(2));',
    'child.once("spawn",()=>{if(!Number.isInteger(child.pid)||child.pid<=0)process.exit(3);child.unref();process.stdout.write(String(child.pid));});',
  ].join('');
  const detached = await runProcess({
    command: process.execPath,
    args: ['--input-type=module', '-e', detachHelper, entrypoint, ...childArgs],
    cwd: options.cwd,
    env,
    inheritParentEnv: false,
    allowEmptyStdout: false,
    timeoutMs: 10_000,
  });
  if (!detached.ok || !/^\d+$/u.test(detached.stdout.trim())) {
    process.stderr.write('worker_smoke_detach_spawn_failed\n');
    return 1;
  }
  const childPid = Number(detached.stdout.trim());

  const artifactDir = resolveSmokeRunArtifactDir(options.cwd, runId);
  const deadline = Date.now() + SMOKE_CREATE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const lifecycle = readSmokeLifecycleRegistry(artifactDir);
    if (lifecycle?.runId === runId) {
      process.stdout.write(`${runId}\n`);
      return 0;
    }
    if (!detachedChildIsAlive(childPid)) {
      process.stderr.write('worker_smoke_detach_child_exited_before_lifecycle\n');
      return 1;
    }
    await sleepAsync(SMOKE_LIFECYCLE_POLL_MS);
  }
  process.stderr.write('worker_smoke_detach_lifecycle_timeout\n');
  return 1;
}

export async function runSmokeWait(options: CliOptions): Promise<number> {
  const runId = (options.runId ?? '').trim();
  if (!runId) throw new Error('wait requires --run <id>');
  const artifactDir = resolveSmokeRunArtifactDir(options.cwd, runId);
  const deadline = Date.now() + SMOKE_ABSOLUTE_CEILING_MS + SMOKE_SHUTDOWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const lifecycle = readSmokeLifecycleRegistry(artifactDir);
    if (lifecycle) {
      if (lifecycle.runId !== runId) {
        process.stderr.write('worker_smoke_wait_run_mismatch\n');
        return 1;
      }
      if (
        (lifecycle.spawnState === 'ambiguous_unbound' || lifecycle.spawnState === 'abandoned_unbound')
        && Date.now() > lifecycle.createDeadlineMs
        && !processIsAlive(lifecycle.supervisorPid)
      ) {
        const createDiagnostic = lifecycle.createDiagnostic ?? 'smoke_create_unbound_expired';
        emit({ ok: false, runId, result: 'FAIL', reason: createDiagnostic, createDiagnostic }, options.json);
        return 1;
      }
      if (lifecycle.launcherTerminalizedAtMs !== undefined && lifecycle.finalEvidencePath) {
        const mode = lifecycle.mode === 'no_execution' ? 'no_execution' : 'runtime';
        const expectedTerminalState = mode === 'no_execution'
          ? lifecycle.spawnState === 'no_execution_terminal'
          : lifecycle.spawnState === 'clean' || lifecycle.spawnState === 'cleanup_failed';
        if (!expectedTerminalState || resolve(lifecycle.finalEvidencePath) !== resolve(smokeRunFinalEvidencePath(artifactDir))) {
          process.stderr.write('worker_smoke_wait_terminal_state_invalid\n');
          return 1;
        }
        const evidence = readWorkerSmokeRunFinalEvidence({
          artifactDir,
          runId,
          issueNumber: lifecycle.issueNumber,
          prNumber: lifecycle.prNumber,
          headSha: lifecycle.headSha,
          mode,
        });
        if (!evidence || evidence.report.result !== evidence.result || !verifySmokeRunReceipt(evidence.report, runId, runId)) {
          if (options.json) emit({ ok: false, runId, reason: 'terminal_evidence_invalid' }, true);
          else process.stderr.write('worker_smoke_wait_final_evidence_invalid\n');
          return 1;
        }
        emit({ ok: evidence.result === 'PASS', runId, result: evidence.result, report: evidence.report }, options.json);
        return evidence.result === 'PASS' ? 0 : 1;
      }
    }
    await sleepAsync(SMOKE_LIFECYCLE_POLL_MS);
  }
  process.stderr.write('worker_smoke_wait_timeout\n');
  return 1;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  switch (options.command) {
    case 'validate-plan': return runValidatePlan(options);
    case 'gate-check': return runGateCheck(options);
    case 'run':
      if (options.detach) return runDetachedBootstrap(argv, options);
      if (options.detachedOwner && !(options.runId ?? '').trim()) throw new Error('detached owner requires --run <id>');
      if (!options.detachedOwner && (options.runId ?? '').trim()) throw new Error('--run is reserved for detached ownership or wait');
      return runSmokeAttempt(options);
    case 'wait':
      if (options.detach || options.detachedOwner) throw new Error('wait is read-only and does not accept detach ownership flags');
      return runSmokeWait(options);
    case 'reconcile-direct-review': return runDirectReviewReconciliation(options);
    case 'delegated-readiness': return runDelegatedReadiness(options);
    default: throw new Error('usage: worker-smoke-run.ts <validate-plan|gate-check|run|wait|reconcile-direct-review|delegated-readiness> [options] (run accepts --detach, --operator-override <reason>, and --smoke-actor worker-owned|independent; wait requires --run <id>)');
  }
}

const direct = import.meta.url === new URL(process.argv[1] ?? '', 'file:').href;
if (direct) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`worker-smoke-run: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
