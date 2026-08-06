#!/usr/bin/env -S node --experimental-strip-types

import './toolchain/native-entrypoint-preflight.ts';
import { classifyRequiredCiLevel } from '../docs/review-ready-stuck-guard.mjs';
import { runProcessSync } from './kernel/subprocess.ts';
import { ghApiJson } from './lib/gh-repo-resolve.mjs';
import { ISSUE_LINK_PATTERN, prBodyScannableForIssueLinks } from './pr-scope-contract.ts';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  normalizeSmokeReport,
  observeSmokeCancellationAcknowledgement,
  observeSmokeCompletionEvidence,
  observeSmokeDeliveryEstablished,
  parseSmokeAgentReport,
  resolveSmokeRequirement,
  resolveSmokeRunArtifactDir,
  scrubForwardedGhSecrets,
  scrubSmokeOutput,
  smokeReportHasPackProducer,
  SMOKE_REPORT_PRODUCER,
  trackedPorcelainPaths,
  verifySmokeHeadBinding,
  writeSmokeCancelRequest,
  type SmokeReport,
  type SmokeRunBinding,
  type WorkerSmokeCommentRecord,
  type WorkerSmokeTrustedTarget,
} from './lib/worker-smoke-core.ts';
import {
  bindSmokeTerminalHandle,
  cleanupSmokeLifecycle,
  createSmokeLifecycleReservation,
  evaluateSmokeLifecycleCleanliness,
  markSmokeCreateAmbiguous,
  markSmokeCreateInProgress,
  preflightSmokeLifecycle,
  releaseSmokeAdmission,
  SMOKE_ABSOLUTE_CEILING_MS,
  SMOKE_CREATE_TIMEOUT_MS,
  SMOKE_DELIVERY_TIMEOUT_MS,
  SMOKE_LIFECYCLE_POLL_MS,
  SMOKE_PROGRESS_STALL_MS,
  SMOKE_SHUTDOWN_TIMEOUT_MS,
  smokeCancelAcknowledgementPath,
  smokeCancelRequestPath,
  smokeProgressPath,
} from './lib/worker-smoke-lifecycle.ts';
import { verifySmokeRunReceipt, writeWorkerSmokeReceipt } from './lib/worker-smoke-receipt.ts';
import { selectRuntimeAdapter } from './runtime/registry.ts';
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
  repoRoot: string;
  cwd: string;
  dryRun: boolean;
  json: boolean;
}

export interface ResolvedSmokeTarget {
  repositorySlug: string;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  issueBody: string;
  issueBodyMatchesTarget: boolean;
  trustedPublisherLogin: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    command: '',
    issueNumber: 0,
    prNumber: 0,
    headSha: '',
    issueBodyFile: '',
    repoRoot: process.cwd(),
    cwd: process.cwd(),
    dryRun: false,
    json: false,
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
      default: throw new Error(`unknown argument: ${args[index]}`);
    }
  }
  return options;
}

function emit(value: unknown, json: boolean): void {
  process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${String(value)}\n`);
}

function readIssueBody(path: string): string {
  if (!path) throw new Error('--issue-body-file is required');
  return readFileSync(path, 'utf8');
}

function sleep(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
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
  return runProcessSync({
    command: 'gh',
    args: [...args],
    cwd,
    env: { ...buildSmokeGhChildEnv(), ...extraEnv },
  });
}

function gitPorcelain(cwd: string): string[] {
  return requireProcessOutput('git status --porcelain', runProcessSync({
    command: 'git', args: ['status', '--porcelain'], cwd,
  })).split(/\r?\n/u).filter(Boolean);
}

function gitHead(cwd: string): string {
  return requireProcessOutput('git rev-parse HEAD', runProcessSync({
    command: 'git', args: ['rev-parse', 'HEAD'], cwd,
  })).trim().toLowerCase();
}

function gitOriginRepositorySlug(cwd: string): string {
  const remote = requireProcessOutput('git remote get-url origin', runProcessSync({
    command: 'git', args: ['remote', 'get-url', 'origin'], cwd,
  })).trim();
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
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(slug)) {
    throw new Error('trusted_target: canonical repository slug missing or invalid');
  }
  return slug;
}

const TRUSTED_REPOSITORY_SLUG = 'chetwerikoff/orchestrator-pack';

function repositoryFromGithubUrl(value: unknown): string {
  const match = String(value ?? '').trim().match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/\d+(?:$|[?#])/iu);
  return match ? `${match[1]}/${match[2]}` : '';
}

function githubApiObject(label: string, endpoint: string, cwd: string): Record<string, unknown> {
  const value = ghApiJson('gh', endpoint, { cwd }) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}: expected one JSON object`);
  }
  return value as Record<string, unknown>;
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
  if (originSlug.toLowerCase() !== repositorySlug.toLowerCase()) {
    throw new Error('trusted_target: trusted repository and origin mismatch');
  }

  const principal = githubApiObject('authenticated-principal', 'user', options.repoRoot);
  const trustedPublisherLogin = String(principal.login ?? '').trim();
  if (!trustedPublisherLogin) throw new Error('trusted_target: authenticated publication principal unresolved');

  const issue = githubApiObject(
    'issue-view',
    `repos/${repositorySlug}/issues/${options.issueNumber}`,
    options.repoRoot,
  );
  const pr = githubApiObject(
    'pr-view-binding',
    `repos/${repositorySlug}/pulls/${options.prNumber}`,
    options.repoRoot,
  );

  const issueNumber = positiveInteger(issue.number);
  const prNumber = positiveInteger(pr.number);
  const head = pr.head && typeof pr.head === 'object' && !Array.isArray(pr.head)
    ? pr.head as Record<string, unknown>
    : {};
  const headSha = String(head.sha ?? '').trim().toLowerCase();
  const issueRepository = repositoryFromGithubUrl(issue.html_url);
  const prRepository = repositoryFromGithubUrl(pr.html_url);
  if (issueNumber !== options.issueNumber || prNumber !== options.prNumber) {
    throw new Error('trusted_target: resolved Issue or PR number mismatch');
  }
  if (issueRepository.toLowerCase() !== repositorySlug.toLowerCase()
    || prRepository.toLowerCase() !== repositorySlug.toLowerCase()) {
    throw new Error('trusted_target: resolved repository mismatch');
  }
  if (String(issue.state ?? '').toLowerCase() !== 'open'
    || String(pr.state ?? '').toLowerCase() !== 'open') {
    throw new Error('trusted_target: Issue or PR is not open');
  }
  if (!/^[0-9a-f]{40}$/u.test(options.headSha.trim().toLowerCase())
    || headSha !== options.headSha.trim().toLowerCase()) {
    throw new Error('trusted_target: exact PR head mismatch');
  }
  const issueBody = String(issue.body ?? '');
  if (!suppliedIssueBodyMatches(issueBody, suppliedIssueBody)) {
    throw new Error('trusted_target: Issue body file does not match the fetched Issue body');
  }
  if (exactClosingIssue(String(pr.body ?? '')) !== issueNumber) {
    throw new Error('trusted_target: PR-to-Issue resolution is missing, multiple, or mismatched');
  }

  return {
    repositorySlug,
    issueNumber,
    prNumber,
    headSha,
    issueBody,
    issueBodyMatchesTarget: true,
    trustedPublisherLogin,
  };
}

export function parsePaginatedSmokeComments(text: string): WorkerSmokeCommentRecord[] {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed) || parsed.some((page) => !Array.isArray(page))) {
    throw new Error('comment_census: paginated output was not one slurped page array');
  }
  const comments = (parsed as unknown[][]).flat();
  const ids = new Set<number>();
  const normalized: WorkerSmokeCommentRecord[] = [];
  for (const raw of comments) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('comment_census: comment record was not an object');
    }
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

export function fetchPrComments(
  prNumber: number,
  repositorySlug: string,
  repoRoot: string,
): WorkerSmokeCommentRecord[] {
  const pages: unknown[][] = [];
  const perPage = 100;
  for (let page = 1; page <= 100; page += 1) {
    const batch = ghApiJson(
      'gh',
      `repos/${repositorySlug}/issues/${prNumber}/comments?per_page=${perPage}&page=${page}`,
      { cwd: repoRoot },
    ) as unknown;
    if (!Array.isArray(batch)) {
      throw new Error('comment_census: comment page was not an array');
    }
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
    actor: typeof comment.actor === 'string'
      ? comment.actor
      : String(comment.user?.login ?? comment.actor?.login ?? ''),
    body: String(comment.body ?? ''),
  })).sort((left, right) => left.id - right.id);
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

export function stabilizeSmokeCommentCensus(
  fetchCensus: () => WorkerSmokeCommentRecord[],
  maxTransitions = 3,
): WorkerSmokeCommentRecord[] {
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

export function fetchLivePrHead(
  prNumber: number,
  repositorySlug: string,
  repoRoot: string,
): string {
  const pr = githubApiObject(
    'pr-view-head',
    `repos/${repositorySlug}/pulls/${prNumber}`,
    repoRoot,
  );
  const head = pr.head && typeof pr.head === 'object' && !Array.isArray(pr.head)
    ? pr.head as Record<string, unknown>
    : {};
  if (positiveInteger(pr.number) !== prNumber || String(pr.state ?? '').toLowerCase() !== 'open') {
    throw new Error('trusted_target: live PR binding changed');
  }
  return String(head.sha ?? '').trim().toLowerCase();
}

function publishPrComment(prNumber: number, body: string, repoRoot: string): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'worker-smoke-comment-'));
  const bodyFile = join(tempDir, 'body.md');
  try {
    writeFileSync(bodyFile, body, 'utf8');
    requireProcessOutput('gh pr comment', runSmokeGhSync(
      ['pr', 'comment', String(prNumber), '--body-file', bodyFile], repoRoot,
    ));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function resolveCiGreen(
  prNumber: number,
  headSha: string,
  repositorySlug: string,
  repoRoot: string,
): boolean {
  const pr = githubApiObject(
    'pr-view-head-base',
    `repos/${repositorySlug}/pulls/${prNumber}`,
    repoRoot,
  );
  const head = pr.head && typeof pr.head === 'object' && !Array.isArray(pr.head)
    ? pr.head as Record<string, unknown>
    : {};
  const base = pr.base && typeof pr.base === 'object' && !Array.isArray(pr.base)
    ? pr.base as Record<string, unknown>
    : {};
  if (positiveInteger(pr.number) !== prNumber
    || String(pr.state ?? '').toLowerCase() !== 'open'
    || String(head.sha ?? '').trim().toLowerCase() !== headSha.trim().toLowerCase()) return false;
  const checks = JSON.parse(requireProcessOutput('required-ci-checks', runSmokeGhSync(
    ['pr', 'checks', String(prNumber), '--repo', repositorySlug, '--json', 'name,state,bucket,link,startedAt,completedAt,workflow,description'], repoRoot,
  ))) as { name?: string; state?: string; bucket?: string }[];
  const baseRef = String(base.ref ?? 'main').trim() || 'main';
  let requiredCheckNames: string[] = [];
  let requiredCheckLookupFailed = false;
  try {
    const protection = githubApiObject(
      'required-status-checks',
      `repos/${repositorySlug}/branches/${baseRef}/protection/required_status_checks`,
      repoRoot,
    );
    requiredCheckNames = Array.isArray(protection.contexts)
      ? protection.contexts.map((value) => String(value))
      : [];
  } catch {
    requiredCheckLookupFailed = true;
  }
  return classifyRequiredCiLevel(checks, { requiredCheckNames, requiredCheckLookupFailed }) === 'green';
}

function failureReason(failure: RuntimeOperationFailure): string {
  return `${failure.operation}:${failure.status}:${failure.reason}`;
}

function operationalReport(
  result: SmokeReport['result'],
  options: CliOptions,
  input: {
    action: string;
    expected: string;
    observed: string;
    terminalCleanup?: string;
    limitations?: string[];
    environmentNotes?: string[];
    worker?: RuntimeWorkerIdentity;
    adapterId?: string;
  },
): SmokeReport {
  return {
    result,
    issueNumber: options.issueNumber,
    prNumber: options.prNumber,
    headSha: options.headSha,
    scenarios: [{
      action: input.action,
      expected: input.expected,
      observed: input.observed,
      outcome: result === 'PASS' ? 'pass' : result === 'BLOCKED' ? 'blocked' : 'fail',
    }],
    limitations: input.limitations ?? [],
    trackedFilesUnmodified: true,
    terminalCleanup: input.terminalCleanup ?? 'not_started',
    environmentNotes: input.environmentNotes ?? [],
    producer: SMOKE_REPORT_PRODUCER,
    orcaExecutable: input.adapterId ?? 'runtime-adapter',
    terminalHandle: input.worker?.id,
  };
}

function publishSmokeReport(report: SmokeReport, options: CliOptions): void {
  if (!options.dryRun) {
    publishPrComment(options.prNumber, formatSmokeReportComment(report), options.repoRoot);
    writeWorkerSmokeReceipt(report);
  }
}

function runtimeClose(
  adapter: RuntimeAdapter,
  worker: RuntimeWorkerIdentity,
  options: CliOptions,
): string {
  const result = adapter.stopWorker(worker, { cwd: options.cwd });
  if (result.status === 'ok') return 'closed_owned_handle';
  if (result.reason === 'worker_generation_not_found') return 'closed_owned_handle_already_absent';
  return `close_failed:${result.reason}`;
}

function buildLifecyclePrompt(basePrompt: string, binding: SmokeRunBinding, scenarioCount: number): string {
  return [
    basePrompt,
    '',
    'Lifecycle protocol (child-produced evidence only):',
    `- Progress file: ${smokeProgressPath(binding.artifactDir)}`,
    `- Cancel request: ${smokeCancelRequestPath(binding.artifactDir)}`,
    `- Cancel acknowledgement: ${smokeCancelAcknowledgementPath(binding.artifactDir)}`,
    `- Declared scenario count: ${scenarioCount}`,
    '- Before each scenario append one JSON line: {"runId":"<run-id>","scenarioOrdinal":N,"phase":"started"}.',
    '- After each scenario append one JSON line: {"runId":"<run-id>","scenarioOrdinal":N,"phase":"terminal","outcome":"pass|fail|blocked|skipped"}.',
    '- Use declared order only and check cancel-request.json before each new scenario.',
  ].join('\n');
}

export interface RuntimeSmokeDeliveryResult {
  ok: boolean;
  reason?: string;
  observationToken?: RuntimeObservationToken;
  submitCount: number;
}

/** Exactly one prompt dispatch. Output heuristics never authorize a second actuation. */
export function establishRuntimeSmokeDelivery(input: {
  adapter: RuntimeAdapter;
  worker: RuntimeWorkerIdentity;
  prompt: string;
  binding: SmokeRunBinding;
  cwd: string;
  deadlineMs: number;
  now?: () => number;
  sleepMs?: (milliseconds: number) => void;
}): RuntimeSmokeDeliveryResult {
  const now = input.now ?? (() => Date.now());
  const sleepMs = input.sleepMs ?? sleep;
  const deadline = now() + input.deadlineMs;
  const dispatched = input.adapter.dispatchInput({ worker: input.worker, text: input.prompt }, { cwd: input.cwd });
  if (dispatched.status !== 'dispatched') {
    return { ok: false, reason: `${dispatched.status}:${dispatched.reason}`, submitCount: 0 };
  }

  let token: RuntimeObservationToken | undefined;
  const submitCount = 0;
  while (now() < deadline) {
    if (observeSmokeDeliveryEstablished(input.binding)) {
      return { ok: true, observationToken: token, submitCount };
    }
    const read = input.adapter.readBoundedOutput({
      worker: input.worker,
      previousToken: token,
      limit: 200,
    }, { cwd: input.cwd });
    if (read.status !== 'ok') {
      return { ok: false, reason: failureReason(read), submitCount };
    }
    token = read.value.observationToken;
    sleepMs(Math.min(SMOKE_LIFECYCLE_POLL_MS, Math.max(1, deadline - now())));
  }
  return { ok: false, reason: 'prompt_delivery_unconfirmed', observationToken: token, submitCount };
}

function waitForRuntimeSmokeCompletion(input: {
  adapter: RuntimeAdapter;
  worker: RuntimeWorkerIdentity;
  binding: SmokeRunBinding;
  scenarioCount: number;
  cwd: string;
  startedAtMs: number;
  previousToken?: RuntimeObservationToken;
  abortReason: () => string | undefined;
}): {
  ok: boolean;
  partial?: Partial<SmokeReport> | null;
  reason?: string;
  progress?: ReturnType<typeof inspectSmokeProgress>;
} {
  const absoluteDeadline = input.startedAtMs + SMOKE_ABSOLUTE_CEILING_MS;
  let lastProgressAt = Date.now();
  let acceptedProgress = 0;
  let token = input.previousToken;
  let completionState = createSmokeCompletionObservationState();

  while (Date.now() < absoluteDeadline) {
    const aborted = input.abortReason();
    if (aborted) return { ok: false, reason: `operator_cancelled:${aborted}` };

    const progress = inspectSmokeProgress({
      artifactDir: input.binding.artifactDir,
      runId: input.binding.runId,
      scenarioCount: input.scenarioCount,
    });
    if (progress.acceptedCount > acceptedProgress) {
      acceptedProgress = progress.acceptedCount;
      lastProgressAt = Date.now();
    }
    if (Date.now() - lastProgressAt >= SMOKE_PROGRESS_STALL_MS) {
      return { ok: false, reason: 'progress_stall', progress };
    }

    const observed = observeSmokeCompletionEvidence(input.binding, completionState);
    completionState = observed.state;
    if (observed.observation.publicationState === 'publish_complete_single') {
      return { ok: true, partial: observed.observation.partial, progress };
    }
    if (observed.observation.publicationState !== 'none') {
      return { ok: false, reason: observed.observation.publicationState, progress };
    }

    const read = input.adapter.readBoundedOutput({
      worker: input.worker,
      previousToken: token,
      limit: 200,
    }, { cwd: input.cwd });
    if (read.status !== 'ok') return { ok: false, reason: failureReason(read), progress };
    token = read.value.observationToken;

    const liveness = input.adapter.liveness({
      worker: input.worker,
      observationWindowMs: SMOKE_LIFECYCLE_POLL_MS,
    }, { cwd: input.cwd });
    if (liveness.status === 'gone') {
      const finalObservation = observeSmokeCompletionEvidence(input.binding, completionState);
      if (finalObservation.observation.publicationState === 'publish_complete_single') {
        return { ok: true, partial: finalObservation.observation.partial, progress };
      }
      return { ok: false, reason: 'agent_exited_without_report', progress };
    }
    sleep(SMOKE_LIFECYCLE_POLL_MS);
  }
  return { ok: false, reason: 'absolute_safety_ceiling' };
}

function waitForCooperativeShutdown(input: {
  adapter: RuntimeAdapter;
  worker: RuntimeWorkerIdentity;
  binding: SmokeRunBinding;
  cwd: string;
}): boolean {
  const deadline = Date.now() + SMOKE_SHUTDOWN_TIMEOUT_MS;
  let completionState = createSmokeCompletionObservationState();
  while (Date.now() < deadline) {
    if (observeSmokeCancellationAcknowledgement(input.binding.artifactDir, input.binding.runId)) return true;
    const observed = observeSmokeCompletionEvidence(input.binding, completionState);
    completionState = observed.state;
    if (observed.observation.publicationState === 'publish_complete_single') return true;
    input.adapter.readBoundedOutput({ worker: input.worker, limit: 0 }, { cwd: input.cwd });
    sleep(SMOKE_LIFECYCLE_POLL_MS);
  }
  return false;
}

function verifyPublishedSmokeProvenance(report: SmokeReport): boolean {
  return smokeReportHasPackProducer(report) && verifySmokeRunReceipt(report);
}

function coverageTarget(
  target: ResolvedSmokeTarget,
  liveHeadSha: string,
): WorkerSmokeTrustedTarget {
  return {
    repositorySlug: target.repositorySlug,
    issueNumber: target.issueNumber,
    prNumber: target.prNumber,
    headSha: target.headSha,
    resolvedIssueNumber: target.issueNumber,
    resolvedPrNumber: target.prNumber,
    liveHeadSha,
    issueBodyMatchesTarget: target.issueBodyMatchesTarget,
    trustedPublisherLogin: target.trustedPublisherLogin,
    commentCensusComplete: true,
    commentSnapshotStable: true,
  };
}

export function findVerifiedSmokeReceiptWitness(input: {
  issueBody: string;
  comments: readonly WorkerSmokeCommentRecord[];
  target: WorkerSmokeTrustedTarget;
}): SmokeReport | undefined {
  for (const comment of input.comments) {
    const contribution = evaluateWorkerSmokeCoverage({
      issueBody: input.issueBody,
      comments: [comment],
      target: input.target,
    });
    let candidate = contribution.latestClearingPass;
    const commentId = positiveInteger(comment.id);
    const globalBlock = contribution.diagnostics.globalBlock;
    if (!candidate
      && commentId > 0
      && globalBlock.blocked
      && globalBlock.commentId === commentId
      && (globalBlock.kind === 'FAIL' || globalBlock.kind === 'BLOCKED')) {
      const partial = parseSmokeAgentReport(String(comment.body ?? ''));
      if (partial) {
        const normalized = normalizeSmokeReport(partial, {
          issueNumber: input.target.issueNumber,
          prNumber: input.target.prNumber,
          headSha: input.target.headSha,
        });
        if (normalized.ok) candidate = normalized.report;
      }
    }
    if (candidate && verifyPublishedSmokeProvenance(candidate)) return candidate;
  }
  return undefined;
}

export function finalSmokeCommentSnapshotMatches(
  stabilized: readonly WorkerSmokeCommentRecord[],
  finalCensus: readonly WorkerSmokeCommentRecord[],
): boolean {
  return smokeCommentSnapshotDigest(stabilized) === smokeCommentSnapshotDigest(finalCensus);
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

export interface GateCheckDependencies {
  evaluateLifecycle: (cwd: string) => ReturnType<typeof evaluateSmokeLifecycleCleanliness>;
  resolveTarget: (options: CliOptions, suppliedIssueBody: string) => ResolvedSmokeTarget;
  fetchComments: (
    prNumber: number,
    repositorySlug: string,
    repoRoot: string,
  ) => WorkerSmokeCommentRecord[];
  fetchHead: (prNumber: number, repositorySlug: string, repoRoot: string) => string;
  selectAdapter: (cwd: string) => Promise<RuntimeAdapter>;
  ciGreen: (
    prNumber: number,
    headSha: string,
    repositorySlug: string,
    repoRoot: string,
  ) => boolean;
}

const DEFAULT_GATE_DEPENDENCIES: GateCheckDependencies = {
  evaluateLifecycle: evaluateSmokeLifecycleCleanliness,
  resolveTarget: resolveSmokeTarget,
  fetchComments: fetchPrComments,
  fetchHead: fetchLivePrHead,
  selectAdapter: async (cwd) => selectRuntimeAdapter({}, { cwd }),
  ciGreen: resolveCiGreen,
};

export async function runGateCheck(
  options: CliOptions,
  dependencies: GateCheckDependencies = DEFAULT_GATE_DEPENDENCIES,
): Promise<number> {
  const lifecycle = dependencies.evaluateLifecycle(options.cwd);
  if (!lifecycle.clean) {
    emit({ ok: false, allowed: false, reason: `smoke_lifecycle_unclean:${lifecycle.reasons[0]}`, lifecycle }, options.json);
    return 1;
  }

  try {
    const suppliedIssueBody = readIssueBody(options.issueBodyFile);
    const target = dependencies.resolveTarget(options, suppliedIssueBody);
    const issueBody = target.issueBody;
    const comments = stabilizeSmokeCommentCensus(
      () => dependencies.fetchComments(options.prNumber, target.repositorySlug, options.repoRoot),
    );
    const liveHeadSha = dependencies.fetchHead(
      options.prNumber,
      target.repositorySlug,
      options.repoRoot,
    );
    const trustedTarget = coverageTarget(target, liveHeadSha);
    const receiptWitness = findVerifiedSmokeReceiptWitness({
      issueBody,
      comments,
      target: trustedTarget,
    });
    const adapter = await dependencies.selectAdapter(options.cwd);
    const readiness = adapter.readiness({ cwd: options.cwd });
    let decision = evaluateWorkerSmokeGate({
      issueBody,
      issueNumber: target.issueNumber,
      prNumber: target.prNumber,
      headSha: target.headSha,
      prComments: comments,
      ciGreen: dependencies.ciGreen(
        options.prNumber,
        options.headSha,
        target.repositorySlug,
        options.repoRoot,
      ),
      orcaWorktreeOk: readiness.status === 'ok',
      ownedTerminalClosed: Boolean(receiptWitness),
      terminalProvenanceOk: Boolean(receiptWitness),
      repositorySlug: target.repositorySlug,
      resolvedIssueNumber: target.issueNumber,
      resolvedPrNumber: target.prNumber,
      liveHeadSha,
      issueBodyMatchesTarget: target.issueBodyMatchesTarget,
      trustedPublisherLogin: target.trustedPublisherLogin,
      commentCensusComplete: true,
      commentSnapshotStable: true,
    });

    if (decision.allowed) {
      const finalHeadSha = dependencies.fetchHead(
        options.prNumber,
        target.repositorySlug,
        options.repoRoot,
      );
      if (finalHeadSha !== target.headSha) {
        decision = {
          allowed: false,
          reason: 'live_pr_head_changed_during_evaluation',
          smokeRequired: true,
          diagnostics: decision.diagnostics,
        };
      } else {
        const finalComments = dependencies.fetchComments(
          options.prNumber,
          target.repositorySlug,
          options.repoRoot,
        );
        if (!finalSmokeCommentSnapshotMatches(comments, finalComments)) {
          decision = {
            allowed: false,
            reason: 'comment_snapshot_changed_before_allow',
            smokeRequired: true,
            diagnostics: decision.diagnostics,
          };
        }
      }
    }
    emit({ ok: decision.allowed, ...decision, lifecycle }, options.json);
    return decision.allowed ? 0 : 1;
  } catch (error) {
    const reason = scrubSmokeOutput(error instanceof Error ? error.message : String(error));
    emit({ ok: false, allowed: false, reason, smokeRequired: true, lifecycle }, options.json);
    return 1;
  }
}

async function runSmokeAttempt(options: CliOptions): Promise<number> {
  const issueBody = readIssueBody(options.issueBodyFile);
  const plan = resolveSmokeRequirement(issueBody);
  if (plan.requirement !== 'required') {
    emit({ ok: true, skipped: true, reason: plan.requirement }, options.json);
    return 0;
  }
  if (plan.scenarios.length === 0) {
    const report = operationalReport('FAIL', options, {
      action: 'parse smoke-test-plan', expected: 'at least one scenario', observed: 'zero_parsed_scenarios',
    });
    publishSmokeReport(report, options);
    emit({ ok: false, report }, options.json);
    return 1;
  }

  const adapter = await selectRuntimeAdapter({}, { cwd: options.cwd });
  const readiness = adapter.readiness({ cwd: options.cwd });
  if (readiness.status !== 'ok') {
    const report = operationalReport('BLOCKED', options, {
      action: 'resolve runtime worktree', expected: 'current worktree is runtime-managed', observed: failureReason(readiness), adapterId: adapter.id,
    });
    publishSmokeReport(report, options);
    emit({ ok: false, report }, options.json);
    return 1;
  }
  const headBinding = verifySmokeHeadBinding({
    requestedHeadSha: options.headSha,
    orcaHeadSha: readiness.value.headSha,
    gitHeadSha: gitHead(options.cwd),
  });
  if (!headBinding.ok) {
    const report = operationalReport('BLOCKED', options, {
      action: 'bind smoke to current head', expected: options.headSha, observed: `${headBinding.reason}:${headBinding.observed}`, adapterId: adapter.id,
    });
    publishSmokeReport(report, options);
    emit({ ok: false, report }, options.json);
    return 1;
  }

  const beforeStatus = gitPorcelain(options.cwd);
  if (hasPreexistingTrackedDirtiness(beforeStatus)) {
    const report = operationalReport('BLOCKED', options, {
      action: 'verify clean tracked worktree', expected: 'no tracked modifications', observed: trackedPorcelainPaths(beforeStatus).join(', '), adapterId: adapter.id,
    });
    publishSmokeReport(report, options);
    emit({ ok: false, report }, options.json);
    return 1;
  }
  const beforeHashes = hashTrackedPaths(options.cwd, trackedPorcelainPaths(beforeStatus));

  const runId = createSmokeRunIdentity();
  const artifactDir = resolveSmokeRunArtifactDir(options.cwd, runId);
  const admission = preflightSmokeLifecycle({
    repoRoot: options.cwd,
    runId,
    closeBoundHandle: () => 'close_failed:cross_process_identity_not_adopted',
  });
  if (!admission.admitted) {
    const report = operationalReport('BLOCKED', options, {
      action: 'acquire smoke spawn admission', expected: 'exclusive admission before spawn', observed: admission.reason ?? 'admission_refused', adapterId: adapter.id,
    });
    publishSmokeReport(report, options);
    emit({ ok: false, report, lifecycle: admission }, options.json);
    return 1;
  }

  const startedAtMs = Date.now();
  ensureSmokeRunArtifactDir(artifactDir);
  createSmokeLifecycleReservation({
    runId,
    artifactDir,
    issueNumber: options.issueNumber,
    prNumber: options.prNumber,
    headSha: options.headSha,
    nowMs: startedAtMs,
    createTimeoutMs: SMOKE_CREATE_TIMEOUT_MS,
    scenarioCount: plan.scenarios.length,
  });
  markSmokeCreateInProgress(artifactDir);

  let worker: RuntimeWorkerIdentity | undefined;
  let terminalCleanup = 'pending';
  let cleanupFinished = false;
  let signalReason: string | undefined;
  const onSigint = (): void => { signalReason = 'SIGINT'; };
  const onSigterm = (): void => { signalReason = 'SIGTERM'; };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  const cleanup = (reason: string, requestCancellation: boolean) => {
    let acknowledged = false;
    if (worker && requestCancellation) {
      if (writeSmokeCancelRequest({ artifactDir, runId, reason })) {
        acknowledged = waitForCooperativeShutdown({
          adapter, worker, binding: { runId, artifactDir }, cwd: options.cwd,
        });
      }
    }
    const result = cleanupSmokeLifecycle({
      artifactDir,
      runId,
      reason,
      requestCancellation,
      cooperativeAcknowledgementObserved: acknowledged,
      closeBoundHandle: (handle) => {
        if (!worker || handle !== worker.id) return 'close_failed:identity_binding_mismatch';
        return runtimeClose(adapter, worker, options);
      },
    });
    terminalCleanup = result.closeOutcome;
    cleanupFinished = true;
    releaseSmokeAdmission(options.cwd, runId);
    return result;
  };

  try {
    const spawned = adapter.spawnWorker({
      title: `smoke-${options.issueNumber}`,
      command: 'cursor-agent',
      workspace: 'active',
    }, { cwd: options.cwd, timeoutMs: SMOKE_CREATE_TIMEOUT_MS });
    if (spawned.status !== 'ok') {
      markSmokeCreateAmbiguous(artifactDir, failureReason(spawned));
      releaseSmokeAdmission(options.cwd, runId);
      const report = operationalReport('BLOCKED', options, {
        action: 'spawn runtime smoke worker', expected: 'composite worker identity', observed: failureReason(spawned), terminalCleanup: 'ambiguous_unbound', adapterId: adapter.id,
      });
      publishSmokeReport(report, options);
      emit({ ok: false, report }, options.json);
      return 1;
    }
    worker = spawned.value.identity;
    bindSmokeTerminalHandle(artifactDir, worker.id);

    const binding = { runId, artifactDir };
    const prompt = buildLifecyclePrompt(buildSmokeAgentPrompt({
      issueNumber: options.issueNumber,
      issueBody,
      prNumber: options.prNumber,
      headSha: options.headSha,
      plan,
      runBinding: binding,
    }), binding, plan.scenarios.length);
    const delivery = establishRuntimeSmokeDelivery({
      adapter,
      worker,
      prompt,
      binding,
      cwd: options.cwd,
      deadlineMs: SMOKE_DELIVERY_TIMEOUT_MS,
    });
    if (!delivery.ok) {
      const lifecycleCleanup = cleanup(delivery.reason ?? 'prompt_delivery_unconfirmed', true);
      const report = operationalReport('FAIL', options, {
        action: 'dispatch smoke prompt once',
        expected: 'dispatched and child-sealed delivery evidence',
        observed: delivery.reason ?? 'prompt_delivery_unconfirmed',
        terminalCleanup,
        environmentNotes: [`submit-count=${delivery.submitCount}`, `lifecycle-clean=${lifecycleCleanup.clean}`],
        worker,
        adapterId: adapter.id,
      });
      publishSmokeReport(report, options);
      emit({ ok: false, report, lifecycleCleanup }, options.json);
      return 1;
    }

    const completion = waitForRuntimeSmokeCompletion({
      adapter,
      worker,
      binding,
      scenarioCount: plan.scenarios.length,
      cwd: options.cwd,
      startedAtMs,
      previousToken: delivery.observationToken,
      abortReason: () => signalReason,
    });
    if (!completion.ok || !completion.partial) {
      const lifecycleCleanup = cleanup(completion.reason ?? 'agent_report_timeout', true);
      const report = operationalReport('FAIL', options, {
        action: 'wait for sealed smoke completion',
        expected: 'legal progress and one sealed report',
        observed: completion.reason ?? 'agent_report_timeout',
        terminalCleanup,
        limitations: completion.progress?.invalidEvents.slice(0, 10),
        environmentNotes: [`lifecycle-clean=${lifecycleCleanup.clean}`],
        worker,
        adapterId: adapter.id,
      });
      publishSmokeReport(report, options);
      emit({ ok: false, report, lifecycleCleanup }, options.json);
      return 1;
    }

    const afterStatus = gitPorcelain(options.cwd);
    const afterHashes = hashTrackedPaths(options.cwd, trackedPorcelainPaths(afterStatus));
    const mutated = detectTrackedImplementationMutation(beforeStatus, afterStatus, beforeHashes, afterHashes);
    const normalized = normalizeSmokeReport({
      ...completion.partial,
      result: mutated ? 'FAIL' : completion.partial.result ?? 'FAIL',
      scenarios: completion.partial.scenarios ?? [],
      limitations: completion.partial.limitations ?? [],
      trackedFilesUnmodified: !mutated && (completion.partial.trackedFilesUnmodified ?? true),
      terminalCleanup: 'pending',
      environmentNotes: completion.partial.environmentNotes ?? [],
      producer: SMOKE_REPORT_PRODUCER,
      orcaExecutable: adapter.id,
      terminalHandle: worker.id,
    }, {
      issueNumber: options.issueNumber,
      prNumber: options.prNumber,
      headSha: options.headSha,
    });
    const lifecycleCleanup = cleanup('completed', false);
    const report = normalized.report;
    report.terminalCleanup = terminalCleanup;
    if (!lifecycleCleanup.clean && report.result === 'PASS') report.result = 'FAIL';
    publishSmokeReport(report, options);
    emit({ ok: report.result === 'PASS', report, lifecycleCleanup }, options.json);
    return report.result === 'PASS' ? 0 : 1;
  } catch (error) {
    const observed = scrubSmokeOutput(error instanceof Error ? error.message : 'handled_exception');
    if (worker && !cleanupFinished) cleanup('handled_exception', true);
    else if (!worker) {
      try { markSmokeCreateAmbiguous(artifactDir, observed); } catch { /* fail closed */ }
      releaseSmokeAdmission(options.cwd, runId);
    }
    const report = operationalReport('BLOCKED', options, {
      action: 'run runtime-neutral worker smoke', expected: 'bounded terminal lifecycle', observed, terminalCleanup: worker ? terminalCleanup : 'ambiguous_unbound', worker, adapterId: adapter.id,
    });
    publishSmokeReport(report, options);
    emit({ ok: false, report }, options.json);
    return 1;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    if (worker && !cleanupFinished) {
      try { cleanup('finally_cleanup', true); } catch { /* lifecycle remains blocking */ }
    }
    releaseSmokeAdmission(options.cwd, runId);
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  switch (options.command) {
    case 'validate-plan': return runValidatePlan(options);
    case 'gate-check': return runGateCheck(options);
    case 'run': return runSmokeAttempt(options);
    default: throw new Error('usage: worker-smoke-run.ts <validate-plan|gate-check|run> [options]');
  }
}

const direct = import.meta.url === new URL(process.argv[1] ?? '', 'file:').href;
if (direct) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`worker-smoke-run: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
