import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess, type ProcessResult } from './kernel/subprocess.js';
import {
  createPackReviewRun,
  getPackReviewRun,
  heartbeatPackReviewRun,
  listPackReviewRuns,
  packReviewLogsDir,
  packReviewWorktreesDir,
  resolvePackReviewRunStoreRoot,
  setPackReviewRunTerminal,
  updatePackReviewRun,
  type PackReviewRunRecord,
  type PackReviewRunStatus,
} from './lib/pack-review-run-store.js';
import {
  createGithubReviewTransport,
  requireProcess,
  reconcileGithubCommentReview,
  recoverIncompleteGithubCommentReviewForHead,
  writeGithubReviewCapture,
  type GithubReviewEvent,
  type GithubReviewTransport,
} from './lib/github-review-reconciliation.js';

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
  timeoutSeconds?: number;
  claimMode?: 'acquire' | 'preacquired';
  fixtureReviewStdout?: string;
  fixtureReviewExitCode?: number;
  fixtureReviewTimedOut?: boolean;
  fixtureGithubReviewId?: number;
  fixtureRepoSlug?: string;
  fixtureGithubReviewTransport?: GithubReviewTransport;
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
}


interface ClaimLease {
  acquired: boolean;
  reason: string;
  directory: string;
  release: (action: 'run_started' | 'failure', reviewRuns: PackReviewRunRecord[], detail?: string) => Promise<void>;
}

const RUNNER_RELATIVE_PATH = 'scripts/pack-review-runner.ts';
const REVIEWER_RELATIVE_PATH = 'scripts/invoke-pack-review.ps1';
const CLAIM_RELATIVE_PATH = 'scripts/lib/Review-StartClaim.ps1';
const DEFAULT_PROJECT_ID = 'orchestrator-pack';
const DEFAULT_BASE_REF = 'origin/main';
const DEFAULT_TIMEOUT_SECONDS = 45 * 60;
const HEARTBEAT_INTERVAL_MS = 30_000;

function trim(value: unknown): string {
  return String(value ?? '').trim();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

async function runGit(repoRoot: string, args: readonly string[], label: string): Promise<string> {
  return requireProcess(await runProcess({
    command: 'git',
    args,
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: true,
  }), label);
}

async function resolveRepositorySlug(repoRoot: string): Promise<string> {
  const result = await runProcess({
    command: 'gh',
    args: ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: 30_000,
  });
  const slug = await requireProcess(result, 'gh repo view');
  if (!/^[^/\s]+\/[^/\s]+$/.test(slug)) throw new Error(`gh repo view returned invalid repository slug '${slug}'`);
  return slug;
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
  const binding = input.prNumber && input.headSha ? undefined : resolveBindingFromCache(sessionId);
  const prNumber = positiveInteger(input.prNumber ?? binding?.prNumber, 'prNumber');
  if (!prNumber) throw new Error('pack review runner could not resolve PR number');

  const sourceRepoRoot = resolve(trim(input.sourceRepoRoot || input.repoRoot) || trustedPackRoot);
  const harnessExplicit = process.env.OPK_VITEST_HARNESS === '1' && Boolean(input.prNumber && input.headSha);
  if (!harnessExplicit && !existsSync(join(sourceRepoRoot, '.git')) && !existsSync(join(sourceRepoRoot, 'HEAD'))) {
    throw new Error(`source repository root is not a git checkout: ${sourceRepoRoot}`);
  }
  const requestedHead = trim(input.headSha || binding?.headSha).toLowerCase();
  const repoSlug = harnessExplicit
    ? trim(input.fixtureRepoSlug) || trim(binding?.repoSlug) || 'fixture/orchestrator-pack'
    : trim(binding?.repoSlug) || await resolveRepositorySlug(sourceRepoRoot);
  const liveHead = harnessExplicit ? requestedHead : await resolveCurrentPrHead(sourceRepoRoot, repoSlug, prNumber);
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

function asReviewPayloadFinding(value: unknown): ReviewPayloadFinding | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as ReviewPayloadFinding
    : null;
}

function selectGithubReviewEvent(payload: ReviewPayload): GithubReviewEvent {
  if (payload.findings.length === 0) {
    return payload.verdict === 'clean' && payload.findingCount === 0
      ? 'APPROVE'
      : 'REQUEST_CHANGES';
  }

  const allNonBlocking = payload.findings.every((value) => {
    const finding = asReviewPayloadFinding(value);
    return finding?.severity === 'warning' || finding?.severity === 'info';
  });
  return allNonBlocking ? 'COMMENT' : 'REQUEST_CHANGES';
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
  event: GithubReviewEvent;
  dismissedReviewIds: Array<number | string>;
}> {
  const event = selectGithubReviewEvent(options.payload);
  const body = formatGithubReviewBody(options.run, options.payload);
  if (event === 'COMMENT') {
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

  const posted = await options.transport.postReview({
    event,
    body,
    commitId: options.headSha,
  });
  writeGithubReviewCapture({
    repoSlug: options.repoSlug,
    prNumber: options.prNumber,
    commitId: options.headSha,
    event,
    body,
    dismissedReviewIds: [],
    transport: options.transport,
  });
  return { ...posted, event, dismissedReviewIds: [] };
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

const CLAIM_LEASE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
. $env:PACK_REVIEW_CLAIM_LIB
$runsRaw = Get-Content -LiteralPath $env:PACK_REVIEW_CLAIM_RUNS -Raw -Encoding UTF8
$runsParsed = if ($runsRaw.Trim()) { $runsRaw | ConvertFrom-Json } else { @() }
$runs = @($runsParsed)
$claim = Acquire-ReviewStartClaim -PrNumber ([int]$env:PACK_REVIEW_CLAIM_PR) -HeadSha $env:PACK_REVIEW_CLAIM_HEAD -Surface $env:PACK_REVIEW_CLAIM_SURFACE -ReviewRuns $runs -ProjectId $env:PACK_REVIEW_CLAIM_PROJECT -StartReason $env:PACK_REVIEW_CLAIM_REASON
($claim | ConvertTo-Json -Depth 30 -Compress) | Set-Content -LiteralPath $env:PACK_REVIEW_CLAIM_RESULT -Encoding UTF8
if (-not $claim.acquired) { exit 3 }
New-Item -ItemType File -Path $env:PACK_REVIEW_CLAIM_READY -Force | Out-Null
while (-not (Test-Path -LiteralPath $env:PACK_REVIEW_CLAIM_RELEASE -PathType Leaf)) {
  try { Get-Process -Id ([int]$env:PACK_REVIEW_CLAIM_PARENT_PID) -ErrorAction Stop | Out-Null } catch { exit 4 }
  Start-Sleep -Milliseconds 200
}
$release = Get-Content -LiteralPath $env:PACK_REVIEW_CLAIM_RELEASE -Raw -Encoding UTF8 | ConvertFrom-Json
$releaseRuns = @($release.reviewRuns)
if ([string]$release.action -eq 'run_started') {
  $complete = Complete-ReviewStartClaimAfterRunInvoke -ClaimResult $claim -ReviewRuns $releaseRuns
} else {
  $complete = Release-ReviewStartClaimAfterRunFailure -ClaimResult $claim -ReviewRuns $releaseRuns -Failure ([string]$release.detail)
}
($complete | ConvertTo-Json -Depth 30 -Compress) | Set-Content -LiteralPath $env:PACK_REVIEW_CLAIM_COMPLETE -Encoding UTF8
if (-not $complete.ok) { exit 5 }
`;

async function waitForFile(path: string, processPromise: Promise<ProcessResult>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    const settled = await Promise.race([
      processPromise.then((result) => ({ process: result })),
      new Promise<{ tick: true }>((resolveTick) => setTimeout(() => resolveTick({ tick: true }), 50)),
    ]);
    if ('process' in settled) {
      throw new Error(`review claim helper exited before readiness: ${trim(settled.process.stderr || settled.process.stdout || settled.process.error)}`);
    }
    if (Date.now() >= deadline) throw new Error('review claim helper readiness timed out');
  }
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
}): Promise<ClaimLease> {
  const directory = join(options.storeRoot, 'claim-leases', `claim-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const runsFile = join(directory, 'runs.json');
  const resultFile = join(directory, 'claim.json');
  const readyFile = join(directory, 'ready');
  const releaseFile = join(directory, 'release.json');
  const completeFile = join(directory, 'complete.json');
  writeFileSync(runsFile, `${JSON.stringify(listPackReviewRuns({ projectId: options.projectId, storeRoot: options.storeRoot }))}\n`, 'utf8');

  const helperPromise = runProcess({
    command: 'pwsh',
    args: ['-NoProfile', '-Command', CLAIM_LEASE_SCRIPT],
    cwd: options.trustedPackRoot,
    inheritParentEnv: true,
    allowEmptyStdout: true,
    env: {
      PACK_REVIEW_CLAIM_LIB: options.claimPath,
      PACK_REVIEW_CLAIM_RUNS: runsFile,
      PACK_REVIEW_CLAIM_RESULT: resultFile,
      PACK_REVIEW_CLAIM_READY: readyFile,
      PACK_REVIEW_CLAIM_RELEASE: releaseFile,
      PACK_REVIEW_CLAIM_COMPLETE: completeFile,
      PACK_REVIEW_CLAIM_PARENT_PID: String(process.pid),
      PACK_REVIEW_CLAIM_PR: String(options.prNumber),
      PACK_REVIEW_CLAIM_HEAD: options.headSha,
      PACK_REVIEW_CLAIM_PROJECT: options.projectId,
      PACK_REVIEW_CLAIM_SURFACE: options.surface,
      PACK_REVIEW_CLAIM_REASON: options.startReason,
    },
  });

  try {
    await waitForFile(resultFile, helperPromise);
    const claim = JSON.parse(readFileSync(resultFile, 'utf8')) as { acquired?: boolean; reason?: string };
    if (!claim.acquired) {
      await helperPromise;
      return {
        acquired: false,
        reason: trim(claim.reason) || 'claimed',
        directory,
        release: async () => undefined,
      };
    }
    await waitForFile(readyFile, helperPromise);
    return {
      acquired: true,
      reason: 'acquired',
      directory,
      release: async (action, reviewRuns, detail = '') => {
        writeFileSync(releaseFile, `${JSON.stringify({ action, reviewRuns, detail })}\n`, 'utf8');
        const helper = await helperPromise;
        if (!helper.ok) throw new Error(`review claim helper completion failed: ${trim(helper.stderr || helper.stdout || helper.error)}`);
        if (!existsSync(completeFile)) throw new Error('review claim helper wrote no completion result');
        const completion = JSON.parse(readFileSync(completeFile, 'utf8')) as { ok?: boolean; reason?: string };
        if (!completion.ok) throw new Error(`review claim completion failed: ${trim(completion.reason) || 'unknown'}`);
      },
    };
  } catch (error) {
    if (!existsSync(releaseFile)) {
      writeFileSync(releaseFile, `${JSON.stringify({ action: 'failure', reviewRuns: [], detail: describeError(error) })}\n`, 'utf8');
    }
    throw error;
  }
}

async function invokeReviewer(options: {
  reviewerPath: string;
  trustedPackRoot: string;
  reviewTargetRoot: string;
  baseRef: string;
  prNumber: number;
  issueNumber?: number;
  sessionId: string;
  timeoutSeconds: number;
  runId: string;
  projectId: string;
  storeRoot: string;
  fixtureReviewStdout?: string;
  fixtureReviewExitCode?: number;
  fixtureReviewTimedOut?: boolean;
}): Promise<ProcessResult> {
  if (process.env.OPK_VITEST_HARNESS === '1' && options.fixtureReviewTimedOut) {
    return { outcome: 'timeout', ok: false, exitCode: null, signal: null, stdout: '', stderr: '', timedOut: true, cancelled: false };
  }

  if (process.env.OPK_VITEST_HARNESS === '1' && options.fixtureReviewStdout !== undefined) {
    const exitCode = options.fixtureReviewExitCode ?? 0;
    return {
      outcome: 'exit',
      ok: exitCode === 0,
      exitCode,
      signal: null,
      stdout: options.fixtureReviewStdout,
      stderr: '',
      timedOut: false,
      cancelled: false,
    };
  }

  const args = [
    '-NoProfile',
    '-File', options.reviewerPath,
    '--repo-root', options.reviewTargetRoot,
    '--base', options.baseRef,
    '--pr-number', String(options.prNumber),
  ];
  if (options.issueNumber) args.push('--issue', String(options.issueNumber));
  const env: NodeJS.ProcessEnv = {
    AO_PR_NUMBER: String(options.prNumber),
    GITHUB_PR_NUMBER: String(options.prNumber),
    AO_REVIEW_RUN_ID: options.runId,
    PACK_REVIEW_RUN_ID: options.runId,
  };
  if (options.sessionId) {
    env.AO_SESSION_ID = options.sessionId;
    env.AO_WORKER_SESSION_ID = options.sessionId;
  }

  return runProcess({
    command: 'pwsh',
    args,
    cwd: options.trustedPackRoot,
    inheritParentEnv: true,
    env,
    allowEmptyStdout: true,
    timeoutMs: options.timeoutSeconds * 1_000,
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
}

export async function startPackReview(input: StartInput): Promise<Record<string, unknown>> {
  const trusted = resolveTrustedRunnerPaths();
  const projectId = trim(input.projectId) || DEFAULT_PROJECT_ID;
  const baseRef = trim(input.baseRef) || DEFAULT_BASE_REF;
  const timeoutSeconds = positiveInteger(input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, 'timeoutSeconds') ?? DEFAULT_TIMEOUT_SECONDS;
  const target = await resolveTarget(input, trusted.trustedPackRoot);
  const storeRoot = resolvePackReviewRunStoreRoot({ projectId, storeRoot: input.storeRoot });
  const claimMode = input.claimMode ?? 'acquire';
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
    });
    if (!claimLease.acquired) {
      return { ok: false, created: false, reused: true, reason: claimLease.reason, httpStatus: 200 };
    }
  }

  try {
    const recovered = await recoverIncompleteGithubCommentReviewForHead({
      projectId,
      storeRoot,
      prNumber: target.prNumber,
      headSha: target.headSha,
      transport: githubReviewTransport,
    });
    if (recovered) {
      const runs = listPackReviewRuns({ projectId, storeRoot });
      if (claimLease) await claimLease.release('run_started', runs);
      return {
        ok: true,
        created: false,
        reused: true,
        recovered: true,
        reason: 'recovered_comment_reconciliation',
        runId: recovered.id,
        status: recovered.status,
        httpStatus: 200,
        githubReviewId: recovered.githubReviewId,
        githubReviewUrl: recovered.githubReviewUrl,
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
    });
    run = created.run;
    if (created.reused) {
      if (claimLease) await claimLease.release('run_started', listPackReviewRuns({ projectId, storeRoot }));
      return { ok: true, created: false, reused: true, reason: created.reason, runId: run.id, httpStatus: 200, status: run.status };
    }

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

    const heartbeat = setInterval(() => {
      try { heartbeatPackReviewRun(run!.id, { projectId, storeRoot }); } catch { /* fail closed at terminal write */ }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    let result: ProcessResult;
    try {
      result = await invokeReviewer({
        reviewerPath: trusted.reviewerPath,
        trustedPackRoot: trusted.trustedPackRoot,
        reviewTargetRoot: worktree,
        baseRef,
        prNumber: target.prNumber,
        issueNumber: target.issueNumber,
        sessionId: target.sessionId,
        timeoutSeconds,
        runId: run.id,
        projectId,
        storeRoot,
        fixtureReviewStdout: input.fixtureReviewStdout,
        fixtureReviewExitCode: input.fixtureReviewExitCode,
        fixtureReviewTimedOut: input.fixtureReviewTimedOut,
      });
    } finally {
      clearInterval(heartbeat);
    }
    writeRunLogs(storeRoot, run.id, result.stdout, result.stderr);

    if (result.timedOut) {
      setPackReviewRunTerminal(run.id, 'timed_out', {
        exitCode: result.exitCode,
        failureReason: 'reviewer_process_timeout',
      }, { projectId, storeRoot });
      terminal = true;
      throw new Error('reviewer process timed out');
    }
    if (!result.ok) {
      setPackReviewRunTerminal(run.id, 'failed', {
        exitCode: result.exitCode,
        failureReason: trim(result.error || result.stderr || result.stdout) || 'reviewer_process_failed',
      }, { projectId, storeRoot });
      terminal = true;
      throw new Error(`reviewer process failed (exit ${String(result.exitCode)})`);
    }

    const payload = parseReviewPayload(result.stdout);
    updatePackReviewRun(run.id, {
      status: 'reviewing',
      latestRunStatus: 'reviewing',
    }, { projectId, storeRoot });
    const githubReview = await postGithubReview({
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
    const status: PackReviewRunStatus = githubReview.event === 'APPROVE'
      ? 'up_to_date'
      : githubReview.event === 'COMMENT'
        ? 'commented'
        : 'changes_requested';
    setPackReviewRunTerminal(run.id, status, {
      exitCode: 0,
      githubReviewId: githubReview.id,
      githubReviewUrl: githubReview.url,
      githubReviewEvent: githubReview.event,
    }, { projectId, storeRoot });
    terminal = true;
    const runs = listPackReviewRuns({ projectId, storeRoot });
    if (claimLease) await claimLease.release('run_started', runs);
    return {
      ok: true,
      created: true,
      reused: false,
      reason: 'completed',
      runId: run.id,
      status,
      httpStatus: 201,
      githubReviewId: githubReview.id,
      githubReviewUrl: githubReview.url,
    };
  } catch (error) {
    if (run && !terminal) {
      try {
        setPackReviewRunTerminal(run.id, 'failed', {
          exitCode: 1,
          failureReason: describeError(error),
        }, { projectId, storeRoot });
      } catch {
        // Preserve the primary failure; store corruption remains fail-closed on next read.
      }
    }
    if (claimLease?.acquired) {
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
    if (claimLease) rmSync(claimLease.directory, { recursive: true, force: true });
  }
}

function usage(): string {
  return [
    'Pack-owned review runner (Issue #839)',
    '',
    'Manual trigger:',
    '  node --experimental-strip-types scripts/pack-review-runner.ts start --pr-number <n> --head-sha <40-hex>',
    '  node --experimental-strip-types scripts/pack-review-runner.ts start --session-id <worker-session-id>',
    '',
    'Status:',
    '  node --experimental-strip-types scripts/pack-review-runner.ts list [--project-id orchestrator-pack]',
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
    result[key] = key === 'prNumber' || key === 'timeoutSeconds' ? Number(value) : value;
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
