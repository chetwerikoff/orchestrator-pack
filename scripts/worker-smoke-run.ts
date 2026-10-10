#!/usr/bin/env -S node --experimental-strip-types

import './toolchain/native-entrypoint-preflight.ts';
import { runProcessSync } from './kernel/subprocess.ts';
import { resolveTargetContext, type TargetContext } from './lib/target-context.ts';
import {
  requiredStatusChecksEndpoint,
  resolveRequiredCi,
  reviewIndependentRequiredCiContexts,
  type RequiredCiProtectionRead,
  type RequiredCiResult,
} from './lib/required-ci.ts';
export { reviewIndependentRequiredCiContexts } from './lib/required-ci.ts';
import { resolveTrackedGhWrapper } from './lib/gh-resolve-real-binary.mjs';
import { ISSUE_LINK_PATTERN, prBodyScannableForIssueLinks } from './pr-scope-contract.ts';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildSmokeGhChildEnv,
  checkSmokeTestPlan,
  classifyDeclaredScenarioNonPassCause,
  formatSmokeReportComment,
  hasPreexistingTrackedDirtiness,
  isSmokeNonPassCause,
  isWorkerSmokeScenarioCauseFamily,
  normalizeSmokeReport,
  parseSmokeAgentReport,
  parseSealedSmokeAgentReport,
  resolveSmokeRequirement,
  scrubForwardedGhSecrets,
  scrubSmokeOutput,
  smokeResultForWorkerSmokeCauseFamily,
  SMOKE_REPORT_PRODUCER,
  trackedPorcelainPaths,
  type SmokeReport,
  type SmokeTestPlan,
  type WorkerSmokeCommentRecord,
} from './lib/worker-smoke-core.ts';
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

import {
  packReviewFindingsSatisfiedByStrictDescendant,
  PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
  readPackReviewAuthority,
  settleLogicalPackReviewFindingsByStrictDescendant,
} from './pack-review-state.ts';
import {
  resolvePackReviewRunStoreRoot,
} from './lib/pack-review-run-store.ts';
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
} from './pr2-foundation/terminalized/worker-report-store.ts';
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
import type { RuntimeAdapter } from './runtime/contracts.ts';

export interface CliOptions {
  command: string;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  issueBodyFile: string;
  repoRoot: string;
  cwd: string;
  dryRun: boolean;
  json: boolean;
  reviewId: string;
  reviewHeadSha: string;
  reportFile: string;
}

export interface ResolvedSmokeTarget {
  projectId: string;
  repositorySlug: string;
  defaultBranch: string;
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
    command: '', issueNumber: 0, prNumber: 0, headSha: '', issueBodyFile: '',
    repoRoot: process.cwd(), cwd: process.cwd(), dryRun: false, json: false, reviewId: '', reviewHeadSha: '', reportFile: '',
  };
  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) options.command = args.shift() ?? '';
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case '--issue': options.issueNumber = Number.parseInt(args[++index] ?? '', 10); break;
      case '--pr': options.prNumber = Number.parseInt(args[++index] ?? '', 10); break;
      case '--head-sha': options.headSha = args[++index] ?? ''; break;
      case '--issue-body-file': options.issueBodyFile = args[++index] ?? ''; break;
      case '--repo-root': options.repoRoot = args[++index] ?? options.repoRoot; break;
      case '--cwd': options.cwd = args[++index] ?? options.cwd; break;
      case '--dry-run': options.dryRun = true; break;
      case '--json': options.json = true; break;
      case '--review-id': options.reviewId = args[++index] ?? ''; break;
      case '--review-head-sha': options.reviewHeadSha = args[++index] ?? ''; break;
      case '--report-file': options.reportFile = args[++index] ?? ''; break;
      default: throw new Error(`unknown argument: ${args[index]}`);
    }
  }
  if (options.command === 'publish' && options.headSha) throw new Error('publish does not accept --head-sha');
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

function requireProcessOutput(
  label: string,
  result: ReturnType<typeof runProcessSync>,
  acceptedExitCodes: readonly number[] = [0],
): string {
  const accepted = result.ok
    || (result.outcome === 'exit' && acceptedExitCodes.includes(result.exitCode ?? -1));
  if (!accepted) {
    const detail = scrubSmokeOutput(scrubForwardedGhSecrets(
      result.stderr || result.error || 'non-zero exit',
      buildSmokeGhChildEnv(),
    ));
    throw new Error(`${label}: ${detail}`);
  }
  return result.stdout;
}

const SMOKE_GH_TIMEOUT_MS = 60_000;
const SMOKE_GH_RETRY_COUNT = 1;

export function runSmokeGhProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<NodeJS.ProcessEnv>,
  timeoutMs = SMOKE_GH_TIMEOUT_MS,
  acceptedExitCodes: readonly number[] = [0],
): ReturnType<typeof runProcessSync> {
  let result: ReturnType<typeof runProcessSync> | undefined;
  for (let attempt = 0; attempt <= SMOKE_GH_RETRY_COUNT; attempt += 1) {
    result = runProcessSync({ command, args: [...args], cwd, env, timeoutMs });
    if (result.ok || (result.outcome === 'exit' && acceptedExitCodes.includes(result.exitCode ?? -1))) {
      return result;
    }
  }
  return result!;
}

export function runSmokeGhSync(
  args: readonly string[],
  cwd: string,
  extraEnv: Readonly<NodeJS.ProcessEnv> = {},
  acceptedExitCodes: readonly number[] = [0],
): ReturnType<typeof runProcessSync> {
  return runSmokeGhProcess(
    resolveTrackedGhWrapper(),
    args,
    cwd,
    { ...buildSmokeGhChildEnv(), ...extraEnv },
    SMOKE_GH_TIMEOUT_MS,
    acceptedExitCodes,
  );
}

function gitPorcelain(cwd: string): string[] {
  return requireProcessOutput('git status --porcelain', runProcessSync({ command: 'git', args: ['status', '--porcelain'], cwd }))
    .split(/\r?\n/u).filter(Boolean);
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

function positiveInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function canonicalRepositorySlug(value: unknown): string {
  const slug = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(slug)) throw new Error('trusted_target: canonical repository slug missing or invalid');
  return slug;
}

function selectedSmokeProject(): Pick<TargetContext, 'projectId' | 'repository' | 'defaultBranch' | 'requiredCi'> {
  if (process.env.VITEST && !String(process.env.OPK_PROJECT_ID ?? '').trim()) {
    return { projectId: 'orchestrator-pack', repository: 'chetwerikoff/orchestrator-pack', defaultBranch: 'main' };
  }
  return resolveTargetContext({ env: process.env });
}

function selectedSmokeRepositorySlug(): string {
  return canonicalRepositorySlug(selectedSmokeProject().repository);
}

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
  const selected = selectedSmokeProject();
  const repositorySlug = canonicalRepositorySlug(selected.repository);
  const originSlug = gitOriginRepositorySlug(options.repoRoot);
  if (originSlug.toLowerCase() !== repositorySlug.toLowerCase()) throw new Error('trusted_target: selected repository and origin mismatch');

  const principal = githubApiObject('authenticated-principal', 'user', options.repoRoot);
  const trustedPublisherLogin = String(principal.login ?? '').trim();
  if (!trustedPublisherLogin) throw new Error('trusted_target: authenticated publication principal unresolved');

  const issue = githubApiObject('issue-view', `repos/${repositorySlug}/issues/${options.issueNumber}`, options.repoRoot);
  const pr = githubApiObject('pr-view-binding', `repos/${repositorySlug}/pulls/${options.prNumber}`, options.repoRoot);
  const repository = githubApiObject('repository-view-binding', `repos/${repositorySlug}`, options.repoRoot);
  const targetFact = projectExpectedPrTarget(pr, repository);
  if (targetFact.expectedTargetRef !== selected.defaultBranch) {
    throw new Error(`trusted_target: repository default branch ${targetFact.expectedTargetRef || '<empty>'} does not match selected target ${selected.defaultBranch}`);
  }

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
    projectId: selected.projectId,
    repositorySlug,
    defaultBranch: selected.defaultBranch,
    issueNumber, prNumber, headSha, issueBody, prBody,
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

export function fetchLivePrBinding(
  prNumber: number,
  repositorySlug: string,
  repoRoot: string,
): { headSha: string; baseRef: string } {
  const pr = githubApiObject('pr-view-head-base', `repos/${repositorySlug}/pulls/${prNumber}`, repoRoot);
  const head = pr.head && typeof pr.head === 'object' && !Array.isArray(pr.head) ? pr.head as Record<string, unknown> : {};
  const base = pr.base && typeof pr.base === 'object' && !Array.isArray(pr.base) ? pr.base as Record<string, unknown> : {};
  if (positiveInteger(pr.number) !== prNumber || String(pr.state ?? '').toLowerCase() !== 'open') throw new Error('trusted_target: live PR binding changed');
  return {
    headSha: String(head.sha ?? '').trim().toLowerCase(),
    baseRef: String(base.ref ?? '').trim(),
  };
}

export function fetchLivePrHead(prNumber: number, repositorySlug: string, repoRoot: string): string {
  return fetchLivePrBinding(prNumber, repositorySlug, repoRoot).headSha;
}

export function publishPrComment(
  prNumber: number,
  body: string,
  repoRoot: string,
  timeoutMs = SMOKE_GH_TIMEOUT_MS,
  runner: typeof runProcessSync = runProcessSync,
): string {
  const tempDir = mkdtempSync(join(tmpdir(), 'worker-smoke-comment-'));
  const bodyFile = join(tempDir, 'body.md');
  try {
    writeFileSync(bodyFile, JSON.stringify({ body }), 'utf8');
    let result: ReturnType<typeof runProcessSync>;
    try {
      result = runner({
        command: resolveTrackedGhWrapper(),
        args: ['api', `repos/${selectedSmokeRepositorySlug()}/issues/${String(prNumber)}/comments`, '--method', 'POST', '--input', bodyFile],
        cwd: repoRoot,
        env: buildSmokeGhChildEnv(),
        timeoutMs,
      });
    } catch (error) {
      const detail = scrubSmokeOutput(scrubForwardedGhSecrets(error instanceof Error ? error.message : String(error), buildSmokeGhChildEnv()));
      throw new Error(`comment_publish_failed: ${detail}`);
    }
    if (!result.ok) {
      const detail = scrubSmokeOutput(scrubForwardedGhSecrets(result.stderr || result.error || 'non-zero exit', buildSmokeGhChildEnv()));
      throw new Error(`comment_publish_failed: ${detail}`);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); }
    catch { throw new Error('comment_publish_unconfirmed: tracked gh returned invalid JSON'); }
    const url = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? String((parsed as Record<string, unknown>).html_url ?? '').trim()
      : '';
    if (!/^https:\/\/github\.com\//u.test(url)) throw new Error('comment_publish_unconfirmed: response URL missing');
    return url;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function resolveRequiredCiForCurrentHead(
  prNumber: number,
  headSha: string,
  repositorySlug: string,
  repoRoot: string,
): Promise<RequiredCiResult> {
  const pr = githubApiObject('pr-view-head-base', `repos/${repositorySlug}/pulls/${prNumber}`, repoRoot);
  const base = pr.base && typeof pr.base === 'object' && !Array.isArray(pr.base) ? pr.base as Record<string, unknown> : {};
  if (positiveInteger(pr.number) !== prNumber || String(pr.state ?? '').toLowerCase() !== 'open') {
    throw new Error('required_ci_target_unavailable');
  }
  const baseRef = String(base.ref ?? '').trim();
  const selected = selectedSmokeProject();
  if (selected.repository.toLowerCase() !== repositorySlug.toLowerCase()) {
    throw new Error('required_ci_repository_binding_mismatch');
  }

  const readProtection = async (): Promise<RequiredCiProtectionRead> => {
    const response = runSmokeGhSync(['api', requiredStatusChecksEndpoint(repositorySlug, baseRef)], repoRoot);
    if (!response.ok) {
      const match = `${response.stderr}\n${response.stdout}`.match(/\bHTTP\s+(403|404)\b/iu);
      if (match) return { kind: 'unavailable', httpStatus: Number(match[1]) as 403 | 404 };
      throw new Error('required_ci_protection_lookup_failed');
    }
    const parsed = JSON.parse(response.stdout) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('required_ci_protection_lookup_invalid');
    }
    return { kind: 'ok', policy: parsed as Record<string, unknown> };
  };

  return resolveRequiredCi({
    target: selected,
    prNumber,
    expectedHeadSha: headSha,
    prBaseRef: baseRef,
    readProtection,
    readChecks: async () => JSON.parse(requireProcessOutput(
      'required-ci-checks',
      runSmokeGhSync(
        ['pr', 'checks', String(prNumber), '--json', 'name,state,bucket,link,startedAt,completedAt,workflow,description'],
        repoRoot,
        {},
        [0, 1, 8],
      ),
      [0, 1, 8],
    )) as Array<{ name?: string; workflow?: string; state?: string; conclusion?: string; status?: string; bucket?: string }>,
    readCurrentPr: async () => fetchLivePrBinding(prNumber, repositorySlug, repoRoot),
  });
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

function currentAtCapFacts(prNumber: number, projectId: string): Pick<Parameters<typeof evaluateReadiness>[0]['review'], 'atCapOpenFindings' | 'atCapContinuationRequired'> {
  try {
    const storeRoot = resolvePackReviewRunStoreRoot({ projectId, storeRoot: process.env.PACK_REVIEW_RUN_STORE_ROOT });
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
  projectId: string,
  isAncestor: (ancestorSha: string, descendantSha: string) => boolean,
): PostSmokePackReviewAuthorityCycle | null {
  try {
    const storeRoot = resolvePackReviewRunStoreRoot({ projectId, storeRoot: process.env.PACK_REVIEW_RUN_STORE_ROOT });
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
  readonly resolveRequiredCi?: typeof resolveRequiredCiForCurrentHead;
  /** Legacy/test fixture seam only; production leaves this unset. */
  readonly resolveCiGreen?: (prNumber: number, headSha: string, repositorySlug: string, repoRoot: string) => boolean;
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
  const assignmentFile = resolveWorkerAssignmentStorePath(target.projectId, process.env);
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
        project: target.projectId,
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
  let smokeWitnessHead = '';
  let smokePassObserved = false;
  let smokeObservationAvailable = true;
  try {
    initialSmokeHead = fetchCurrentHead(target.prNumber, target.repositorySlug, options.repoRoot);
    // The PR's own PASS comments suffice independently of publisher or smoke head.
    const comments = fetchSmokeComments(target.prNumber, target.repositorySlug, options.repoRoot);
    const newestPass = [...comments]
      .sort((left, right) => Number(right.id ?? 0) - Number(left.id ?? 0))
      .find((comment) => {
        const body = String(comment.body ?? '');
        return body.includes('<!-- pack-worker-smoke-report/v1 -->')
          && Number(body.match(/^\s*-\s*pr:\s*#(\d+)/imu)?.[1] ?? 0) === target.prNumber
          && parseSmokeAgentReport(body)?.result === 'PASS';
      });
    if (newestPass) {
      smokePassObserved = true;
      smokeWitnessHead = String(newestPass.body ?? '').match(/^\s*-\s*head-sha:\s*`?([0-9a-f]{40})`?/imu)?.[1] ?? '';
    }
  } catch {
    smokeObservationAvailable = false;
  }

  const ciGreen = dependencies.resolveCiGreen
    ? dependencies.resolveCiGreen(target.prNumber, target.headSha, target.repositorySlug, options.repoRoot)
    : (await (dependencies.resolveRequiredCi ?? resolveRequiredCiForCurrentHead)(
        target.prNumber,
        target.headSha,
        target.repositorySlug,
        options.repoRoot,
      )).green;
  const acceptedReport = selectAcceptedCurrentWorkerReport(workerReports, readinessTarget);
  const lifecycle = String(acceptedReport?.reportState ?? '').trim().toLowerCase();
  const transport = createGithubReviewTransport({ repoRoot: options.repoRoot, repoSlug: target.repositorySlug, prNumber: target.prNumber });
  const reviews = dependencies.listDirectReviews
    ? await dependencies.listDirectReviews(options.repoRoot, target.repositorySlug, target.prNumber)
    : await transport.listReviews();
  const initialSmokePassed = smokePassObserved;
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
    authorityCycle: currentPackReviewCompletionCycle(target.prNumber, target.headSha, target.projectId, (ancestorSha, descendantSha) =>
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
  const atCap = currentAtCapFacts(target.prNumber, target.projectId);
  const smokeEvidenceState: PostSmokeReadinessResult['smokeEvidence']['state'] = !smokeObservationAvailable
    ? 'unavailable'
    : initialSmokeHead !== target.headSha ? 'changed' : smokePassObserved ? 'verified' : 'missing';
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
      headSha: smokeWitnessHead || target.headSha,
      state: smokeEvidenceState === 'verified' ? 'pass' : smokeEvidenceState === 'unavailable' ? 'unknown' : 'missing',
    },
  });
  return { readiness, reviewProjection, smokeEvidence: { state: smokeEvidenceState, headSha: smokeWitnessHead || target.headSha } };
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

  const assignmentFile = resolveWorkerAssignmentStorePath(target.projectId, process.env);
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
  const currentHead = fetchLivePrHead(options.prNumber, selectedSmokeRepositorySlug(), options.repoRoot);
  const eventHead = options.headSha.trim().toLowerCase();
  const reviewHead = options.reviewHeadSha.trim().toLowerCase();
  if (currentHead !== eventHead || reviewHead !== eventHead) {
    emit({ ok: true, skipped: true, reason: 'direct_review_stale_publication_head', reviewHead, eventHead, currentHead }, options.json); return 0;
  }
  const transport = createGithubReviewTransport({ repoRoot: options.repoRoot, repoSlug: selectedSmokeRepositorySlug(), prNumber: options.prNumber });
  const reviews = await transport.listReviews();
  const submitted = reviews.find((review) => sameReviewIdentifier(review.id, options.reviewId));
  const owner = selectedSmokeRepositorySlug().split('/')[0] ?? '';
  if (!submitted || !parseDirectPackReviewEvidence(submitted, owner)) {
    emit({ ok: true, skipped: true, reason: 'review_not_canonical_direct_pack_review' }, options.json); return 0;
  }
  const direct = projectDirectPackReviewState({
    reviews, repositoryOwnerLogin: owner, currentHeadSha: currentHead, workerLifecycle: '', requiredCiGreen: false,
    exactHeadSmokePassed: false,
    isAncestor: (ancestorSha, descendantSha) => githubCommitIsAncestor(selectedSmokeRepositorySlug(), ancestorSha, descendantSha, options.repoRoot),
  });
  const projection = projectPackReviewSemanticStatus({
    runner: currentPackReviewStatusFact(selectedSmokeRepositorySlug(), currentHead, options.repoRoot),
    direct: { hasLegitimateReview: direct.hasLegitimateReview, unresolvedBlockingFinding: direct.state === 'blocked' },
  });
  if (!options.dryRun) await publishPackReviewRequiredStatus({
    repoRoot: options.repoRoot, repoSlug: selectedSmokeRepositorySlug(), headSha: currentHead,
    request: semanticPackReviewRequiredStatusRequest({ headSha: currentHead, projection }),
  });
  emit({ ok: true, projection, direct }, options.json); return 0;
}


function runValidatePlan(options: CliOptions): number {
  const result = checkSmokeTestPlan(readIssueBody(options.issueBodyFile));
  if (!result.ok) {
    for (const error of result.errors) process.stderr.write(`worker-smoke-run: ${error}\n`);
    return 1;
  }
  emit({ ok: true, plan: result.plan }, options.json);
  return 0;
}

export interface PublishSmokeDependencies {
  publishComment?: (prNumber: number, body: string, repoRoot: string) => string;
  resolveTarget?: (options: CliOptions) => PublishSmokeTarget;
  readReportFile?: (path: string) => string;
  gitStatus?: (repoRoot: string) => string[];
  gitHead?: (repoRoot: string) => string;
}

export interface PublishSmokeTarget {
  repositorySlug: string;
  issueNumber: number;
  prNumber: number;
  issueBody: string;
}

export function resolvePublishSmokeTarget(options: CliOptions): PublishSmokeTarget {
  if (!Number.isSafeInteger(options.issueNumber) || options.issueNumber < 1) throw new Error('--issue must be a positive integer');
  if (!Number.isSafeInteger(options.prNumber) || options.prNumber < 1) throw new Error('--pr must be a positive integer');
  const repositorySlug = canonicalRepositorySlug(selectedSmokeRepositorySlug());
  const originSlug = gitOriginRepositorySlug(options.repoRoot);
  if (originSlug.toLowerCase() !== repositorySlug.toLowerCase()) {
    throw new Error('trusted_target: trusted repository and origin mismatch');
  }
  const issue = githubApiObject('issue-view', `repos/${repositorySlug}/issues/${options.issueNumber}`, options.repoRoot);
  const pr = githubApiObject('pr-view-binding', `repos/${repositorySlug}/pulls/${options.prNumber}`, options.repoRoot);
  if (positiveInteger(issue.number) !== options.issueNumber || positiveInteger(pr.number) !== options.prNumber) {
    throw new Error('trusted_target: resolved Issue or PR number mismatch');
  }
  if (repositoryFromGithubUrl(issue.html_url).toLowerCase() !== repositorySlug.toLowerCase()
      || repositoryFromGithubUrl(pr.html_url).toLowerCase() !== repositorySlug.toLowerCase()) {
    throw new Error('trusted_target: resolved repository mismatch');
  }
  const issueBody = String(issue.body ?? '');
  if (exactClosingIssue(String(pr.body ?? '')) !== options.issueNumber) {
    throw new Error('trusted_target: PR-to-Issue resolution is missing, multiple, or mismatched');
  }
  return { repositorySlug, issueNumber: options.issueNumber, prNumber: options.prNumber, issueBody };
}

function inspectRawSealedNonPassCause(text: string): { present: boolean; error?: string } {
  let present = false;
  for (const line of text.split(/\r?\n/u)) {
    // Inspect original sealed bytes: the generic parser otherwise drops unknown
    // values and silently keeps the last duplicate key.
    if (!/^\s*(?:-\s+)?non[-_ ]?pass[-_ ]?cause\b/iu.test(line)) continue;
    const match = line.match(/^\s*non-pass-cause\s*:\s*([a-z][a-z0-9_]*)\s*$/iu);
    if (!match || !isSmokeNonPassCause(match[1]!)) {
      return { present: true, error: 'non_pass_cause_explicit_invalid' };
    }
    if (present) return { present: true, error: 'non_pass_cause_duplicate' };
    present = true;
  }
  return { present };
}

function reportCorrespondenceReason(partial: Partial<SmokeReport>, plan: SmokeTestPlan): string | null {
  const rows = partial.scenarios ?? [];
  if (rows.length === 0) return 'report_scenarios_missing';
  const result = partial.result;
  if (result !== 'PASS' && result !== 'FAIL' && result !== 'BLOCKED') return 'report_result_invalid';
  const expectedLength = result === 'PASS' ? plan.scenarios.length : rows.length;
  if (result === 'PASS' && rows.length !== plan.scenarios.length) return 'pass_scenario_count_mismatch';
  if (result !== 'PASS' && rows.length > plan.scenarios.length) return 'non_pass_scenario_count_exceeds_plan';
  for (let index = 0; index < expectedLength; index += 1) {
    const declared = plan.scenarios[index];
    const observed = rows[index];
    if (!declared || !observed
        || observed.action !== declared.action
        || observed.expected !== declared.expected) {
      return `scenario_${index + 1}_identity_mismatch`;
    }
    if (!observed.observed?.trim()) return `scenario_${index + 1}_observed_missing`;
    if (result === 'PASS' && observed.outcome !== 'pass') return `scenario_${index + 1}_pass_outcome_invalid`;
    if (result !== 'PASS' && index < rows.length - 1 && observed.outcome !== 'pass') {
      return `scenario_${index + 1}_prefix_outcome_invalid`;
    }
  }
  if (result !== 'PASS') {
    const terminal = rows.at(-1);
    if (!terminal || (terminal.outcome !== 'fail' && terminal.outcome !== 'blocked')) {
      return 'non_pass_terminal_row_missing';
    }
    if (!isWorkerSmokeScenarioCauseFamily(terminal.causeFamily)) return 'non_pass_terminal_cause_family_invalid';
    if ((result === 'FAIL' && terminal.outcome !== 'fail')
        || (result === 'BLOCKED' && terminal.outcome !== 'blocked')
        || smokeResultForWorkerSmokeCauseFamily(terminal.causeFamily) !== result) {
      return 'non_pass_result_terminal_mismatch';
    }
    if (terminal.causeFamily === 'scenario_precondition_unavailable'
        && partial.nonPassCause !== 'scenario_precondition_unavailable') {
      return 'precondition_non_pass_cause_mismatch';
    }
    if (!partial.nonPassCause) return 'non_pass_cause_missing_or_invalid';
  }
  return null;
}

function scrubNormalizedReport(report: SmokeReport): SmokeReport {
  const childEnv = buildSmokeGhChildEnv();
  const serialized = JSON.stringify(report);
  const scrubbed = scrubSmokeOutput(scrubForwardedGhSecrets(serialized, childEnv));
  return JSON.parse(scrubbed) as SmokeReport;
}

function canonicalPublishRecord(report: SmokeReport, commentUrl: string): Record<string, unknown> {
  return {
    schema: 'pack-worker-smoke-report/v1',
    producer: SMOKE_REPORT_PRODUCER,
    issueNumber: report.issueNumber,
    prNumber: report.prNumber,
    headSha: report.headSha,
    result: report.result,
    scenarios: report.scenarios,
    trackedFilesUnmodified: report.trackedFilesUnmodified,
    ...(report.causeFamily ? { causeFamily: report.causeFamily } : {}),
    ...(report.nonPassCause ? { nonPassCause: report.nonPassCause } : {}),
    ...(report.environmentNotes.length > 0 ? { environmentNotes: report.environmentNotes } : {}),
    ...(report.limitations.length > 0 ? { limitations: report.limitations } : {}),
    commentUrl,
  };
}

export async function runPublishSmoke(
  options: CliOptions,
  dependencies: PublishSmokeDependencies = {},
): Promise<number> {
  if (!options.reportFile) throw new Error('--report-file is required');
  if (options.dryRun) throw new Error('publish does not support --dry-run');
  const target = (dependencies.resolveTarget ?? resolvePublishSmokeTarget)(options);
  const plan = resolveSmokeRequirement(target.issueBody);
  if (plan.requirement !== 'required' || plan.scenarios.length === 0) {
    throw new Error('publish requires a required scenario-bearing smoke-test-plan');
  }
  const readReportFile = dependencies.readReportFile ?? ((path: string) => readFileSync(resolve(path), 'utf8'));
  const rawReport = readReportFile(options.reportFile);
  const rawCause = inspectRawSealedNonPassCause(rawReport);
  if (rawCause.error) throw new Error('report_file_invalid: ' + rawCause.error);
  const partial = parseSealedSmokeAgentReport(rawReport);
  if (!partial) throw new Error('report_file_invalid: worker-smoke-report grammar not found');
  if (!rawCause.present && partial.result === 'BLOCKED') {
    const derived = classifyDeclaredScenarioNonPassCause({
      partial,
      agentActivityObserved: false,
    });
    if (derived === 'scenario_precondition_unavailable') partial.nonPassCause = derived;
  }
  const correspondence = reportCorrespondenceReason(partial, plan);
  if (correspondence) throw new Error(`report_plan_mismatch: ${correspondence}`);
  const status = (dependencies.gitStatus ?? gitPorcelain)(options.repoRoot);
  if (hasPreexistingTrackedDirtiness(status)) {
    throw new Error(`tracked_worktree_dirty: ${trackedPorcelainPaths(status).join(', ')}`);
  }
  const headSha = (dependencies.gitHead ?? gitHead)(options.repoRoot);
  const normalized = normalizeSmokeReport({
    ...partial,
    producer: SMOKE_REPORT_PRODUCER,
    trackedFilesUnmodified: true,
  }, {
    issueNumber: options.issueNumber,
    prNumber: options.prNumber,
    headSha,
  });
  if (!normalized.ok) throw new Error(`report_normalization_failed: ${normalized.reason}`);
  const report = scrubNormalizedReport(normalized.report);
  const commentBody = scrubSmokeOutput(formatSmokeReportComment(report));
  const publishComment = dependencies.publishComment ?? publishPrComment;
  const commentUrl = publishComment(options.prNumber, commentBody, options.repoRoot);
  const record = canonicalPublishRecord(report, commentUrl);
  emit(record, true);
  return 0;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  switch (options.command) {
    case 'validate-plan': return runValidatePlan(options);
    case 'publish': return runPublishSmoke(options);
    case 'reconcile-direct-review': return runDirectReviewReconciliation(options);
    case 'delegated-readiness': return runDelegatedReadiness(options);
    default: throw new Error('usage: worker-smoke-run.ts <validate-plan|publish|reconcile-direct-review|delegated-readiness> [options]');
  }
}

const direct = import.meta.url === new URL(process.argv[1] ?? '', 'file:').href;
if (direct) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`worker-smoke-run: ${scrubSmokeOutput(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  });
}
