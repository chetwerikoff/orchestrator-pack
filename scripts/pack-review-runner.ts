import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess, type ProcessResult } from '#opk-kernel/subprocess';
import {
  createPackReviewRun, getPackReviewRun, heartbeatPackReviewRun, listPackReviewRuns,
  packReviewLogsDir, packReviewWorktreesDir, resolvePackReviewRunStoreRoot,
  setPackReviewRunTerminal, updatePackReviewRun,
  type PackReviewRunRecord, type PackReviewRunStatus,
// @ts-ignore -- Node 22 type stripping requires the explicit .ts runtime extension.
} from './lib/pack-review-run-store.ts';

export interface StartPackReviewInput {
  projectId?: string; sessionId?: string; linkedSessionId?: string; prNumber?: number;
  headSha?: string; repoRoot?: string; sourceRepoRoot?: string; baseRef?: string;
  startReason?: string; surface?: string; storeRoot?: string; timeoutSeconds?: number;
  claimMode?: 'acquire' | 'preacquired'; fixtureReviewStdout?: string;
  fixtureReviewExitCode?: number; fixtureGithubReviewId?: number; fixtureRepoSlug?: string;
}
type Obj = Record<string, unknown>;
type Binding = { sessionId: string; prNumber: number; headSha?: string | null; repoSlug?: string; issueNumber?: number | null };
type Finding = { title?: string; body?: string; filePath?: string };
type Verdict = { verdict: 'clean' | 'findings'; findingCount: number; findings: Finding[] };
type ClaimLease = {
  acquired: boolean;
  reason: string;
  directory: string;
  release: (action: 'run_started' | 'failure', reviewRuns: PackReviewRunRecord[], detail?: string) => Promise<void>;
};

const RUNNER = 'scripts/pack-review-runner.ts';
const REVIEWER = 'scripts/invoke-pack-review.ps1';
const CLAIM = 'scripts/lib/Review-StartClaim.ps1';
const PROJECT = 'orchestrator-pack';
const BASE = 'origin/main';
const TIMEOUT = 45 * 60;
const HEARTBEAT = 30_000;
const str = (value: unknown): string => String(value ?? '').trim();
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

function inside(candidate: string, parent: string): boolean {
  const value = relative(resolve(parent), resolve(candidate));
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

export function resolveTrustedRunnerPaths(env: NodeJS.ProcessEnv = process.env) {
  const own = resolve(fileURLToPath(import.meta.url));
  const ownRoot = resolve(dirname(own), '..');
  const root = resolve(str(env.AO_TRUSTED_PACK_ROOT || env.OPK_TRUSTED_PACK_ROOT) || ownRoot);
  const result = { trustedPackRoot: root, runnerPath: resolve(root, RUNNER), reviewerPath: resolve(root, REVIEWER), claimPath: resolve(root, CLAIM) };
  if (result.runnerPath !== own) throw new Error(`trusted runner mismatch: executing ${own}, expected ${result.runnerPath}`);
  for (const [label, path] of [['reviewer', result.reviewerPath], ['claim', result.claimPath]] as const) {
    if (!inside(path, root) || !existsSync(path)) throw new Error(`trusted ${label} unavailable at ${path}`);
  }
  return result;
}

function cachePath(env: NodeJS.ProcessEnv): string {
  if (str(env.AO_PR_SESSION_BINDING_CACHE)) return resolve(str(env.AO_PR_SESSION_BINDING_CACHE));
  if (str(env.AO_REPORT_STATE_SEED_STATE)) return join(dirname(resolve(str(env.AO_REPORT_STATE_SEED_STATE))), 'pr-session-binding-cache.json');
  return join(homedir(), '.local', 'state', 'orchestrator-pack-wake-supervisor', 'pr-session-binding-cache.json');
}

export function resolveBindingFromCache(sessionId: string, env: NodeJS.ProcessEnv = process.env): Binding {
  const wanted = str(sessionId);
  if (!wanted) throw new Error('pack review runner requires sessionId or explicit PR/head');
  const path = cachePath(env);
  if (!existsSync(path)) throw new Error(`pack review session binding cache missing at ${path}`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { throw new Error(`pack review session binding cache corrupt at ${path}: ${errorText(error)}`); }
  const records = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { records?: Obj }).records : undefined;
  if (!records) throw new Error(`pack review session binding cache corrupt at ${path}: missing records`);
  const matches = new Map<string, Binding>();
  for (const item of Object.values(records)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Obj;
    if (str(record.sessionId) !== wanted || record.superseded === true) continue;
    const prNumber = Number(record.prNumber);
    if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error(`pack review session binding cache corrupt at ${path}: invalid PR for ${wanted}`);
    const binding: Binding = { sessionId: wanted, prNumber, headSha: str(record.headSha) || null, repoSlug: str(record.repoSlug), issueNumber: Number(record.issueNumber) > 0 ? Number(record.issueNumber) : null };
    matches.set(`${binding.repoSlug ?? ''}|${prNumber}|${binding.headSha ?? ''}`, binding);
  }
  if (matches.size !== 1) throw new Error(matches.size ? `pack review session binding ambiguous for ${wanted}` : `pack review session binding missing for ${wanted}`);
  return [...matches.values()][0]!;
}

function positive(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}
async function required(result: ProcessResult, label: string): Promise<string> {
  if (!result.ok) throw new Error(`${label} failed${str(result.stderr || result.error || result.stdout) ? `: ${str(result.stderr || result.error || result.stdout)}` : ''}`);
  return result.stdout.trim();
}
async function git(root: string, args: readonly string[], label: string): Promise<string> {
  return required(await runProcess({ command: 'git', args, cwd: root, inheritParentEnv: true, allowEmptyStdout: true }), label);
}
async function repoSlug(root: string): Promise<string> {
  const value = await required(await runProcess({ command: 'gh', args: ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], cwd: root, inheritParentEnv: true, timeoutMs: 30_000 }), 'gh repo view');
  if (!/^[^/\s]+\/[^/\s]+$/.test(value)) throw new Error(`gh repo view returned invalid repository slug '${value}'`);
  return value;
}
async function liveHead(root: string, slug: string, pr: number): Promise<string> {
  const value = await required(await runProcess({ command: 'gh', args: ['pr', 'view', String(pr), '--repo', slug, '--json', 'headRefOid,state', '--jq', '.headRefOid + " " + .state'], cwd: root, inheritParentEnv: true, timeoutMs: 30_000 }), `gh pr view ${pr}`);
  const [sha, state] = value.split(/\s+/, 2);
  if (!/^[0-9a-f]{40}$/i.test(sha ?? '') || str(state).toUpperCase() !== 'OPEN') throw new Error(`PR #${pr} is not an open PR with a full head SHA`);
  return sha!.toLowerCase();
}

async function target(input: StartPackReviewInput, trustedRoot: string) {
  const sessionId = str(input.sessionId || input.linkedSessionId);
  const binding = input.prNumber && input.headSha ? undefined : resolveBindingFromCache(sessionId);
  const prNumber = positive(input.prNumber ?? binding?.prNumber, 'prNumber');
  if (!prNumber) throw new Error('pack review runner could not resolve PR number');
  const sourceRepoRoot = resolve(str(input.sourceRepoRoot || input.repoRoot) || trustedRoot);
  const fixture = process.env.OPK_VITEST_HARNESS === '1' && Boolean(input.prNumber && input.headSha);
  if (!fixture && !existsSync(join(sourceRepoRoot, '.git')) && !existsSync(join(sourceRepoRoot, 'HEAD'))) throw new Error(`source repository root is not a git checkout: ${sourceRepoRoot}`);
  const requested = str(input.headSha || binding?.headSha).toLowerCase();
  const slug = fixture ? str(input.fixtureRepoSlug) || str(binding?.repoSlug) || 'fixture/orchestrator-pack' : str(binding?.repoSlug) || await repoSlug(sourceRepoRoot);
  const headSha = fixture ? requested : await liveHead(sourceRepoRoot, slug, prNumber);
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error(`review target head is not a full SHA for PR #${prNumber}`);
  if (requested && requested !== headSha) throw new Error(`review target head changed for PR #${prNumber}: requested ${requested}, live ${headSha}`);
  return { prNumber, headSha, sessionId, issueNumber: binding?.issueNumber ? Number(binding.issueNumber) : undefined, repoSlug: slug, sourceRepoRoot };
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
    if ('process' in settled) throw new Error(`review claim helper exited before readiness: ${str(settled.process.stderr || settled.process.stdout || settled.process.error)}`);
    if (Date.now() >= deadline) throw new Error('review claim helper readiness timed out');
  }
}

async function acquireClaimLease(options: { trustedRoot: string; claimPath: string; projectId: string; storeRoot: string; prNumber: number; headSha: string; surface: string; reason: string }): Promise<ClaimLease> {
  const directory = join(options.storeRoot, 'claim-leases', `claim-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const runsFile = join(directory, 'runs.json');
  const resultFile = join(directory, 'claim.json');
  const readyFile = join(directory, 'ready');
  const releaseFile = join(directory, 'release.json');
  const completeFile = join(directory, 'complete.json');
  writeFileSync(runsFile, `${JSON.stringify(listPackReviewRuns({ projectId: options.projectId, storeRoot: options.storeRoot }))}\n`, 'utf8');
  const helperPromise = runProcess({
    command: 'pwsh', args: ['-NoProfile', '-Command', CLAIM_LEASE_SCRIPT], cwd: options.trustedRoot,
    inheritParentEnv: true, allowEmptyStdout: true,
    env: {
      PACK_REVIEW_CLAIM_LIB: options.claimPath, PACK_REVIEW_CLAIM_RUNS: runsFile,
      PACK_REVIEW_CLAIM_RESULT: resultFile, PACK_REVIEW_CLAIM_READY: readyFile,
      PACK_REVIEW_CLAIM_RELEASE: releaseFile, PACK_REVIEW_CLAIM_COMPLETE: completeFile,
      PACK_REVIEW_CLAIM_PARENT_PID: String(process.pid), PACK_REVIEW_CLAIM_PR: String(options.prNumber),
      PACK_REVIEW_CLAIM_HEAD: options.headSha, PACK_REVIEW_CLAIM_PROJECT: options.projectId,
      PACK_REVIEW_CLAIM_SURFACE: options.surface, PACK_REVIEW_CLAIM_REASON: options.reason,
    },
  });
  try {
    await waitForFile(resultFile, helperPromise);
    const claim = JSON.parse(readFileSync(resultFile, 'utf8')) as { acquired?: boolean; reason?: string };
    if (!claim.acquired) {
      await helperPromise;
      return { acquired: false, reason: str(claim.reason) || 'claimed', directory, release: async () => undefined };
    }
    await waitForFile(readyFile, helperPromise);
    return {
      acquired: true, reason: 'acquired', directory,
      release: async (action, reviewRuns, detail = '') => {
        writeFileSync(releaseFile, `${JSON.stringify({ action, reviewRuns, detail })}\n`, 'utf8');
        const helper = await helperPromise;
        if (!helper.ok) throw new Error(`review claim helper completion failed: ${str(helper.stderr || helper.stdout || helper.error)}`);
        if (!existsSync(completeFile)) throw new Error('review claim helper wrote no completion result');
        const completion = JSON.parse(readFileSync(completeFile, 'utf8')) as { ok?: boolean; reason?: string };
        if (!completion.ok) throw new Error(`review claim completion failed: ${str(completion.reason) || 'unknown'}`);
      },
    };
  } catch (error) {
    if (!existsSync(releaseFile)) writeFileSync(releaseFile, `${JSON.stringify({ action: 'failure', reviewRuns: [], detail: errorText(error) })}\n`, 'utf8');
    throw error;
  }
}

function verdict(stdout: string): Verdict {
  for (const candidate of [stdout.trim(), ...stdout.trim().split(/\r?\n/).reverse()]) {
    try {
      const value = JSON.parse(candidate) as Partial<Verdict>;
      if ((value.verdict === 'clean' || value.verdict === 'findings') && Number.isInteger(value.findingCount) && Array.isArray(value.findings) && value.findingCount === value.findings.length) return value as Verdict;
    } catch { /* next */ }
  }
  throw new Error('reviewer produced no valid terminal verdict payload');
}
function reviewBody(run: PackReviewRunRecord, value: Verdict): string {
  const lines = [`## Pack review — ${value.verdict === 'clean' && value.findingCount === 0 ? 'no findings' : 'findings'}`, '', `Run: \`${run.id}\``, `Head: \`${run.targetSha}\``, ''];
  if (!value.findings.length) lines.push('No findings.', '');
  value.findings.forEach((finding, index) => { lines.push(`### ${finding.title || `Finding ${index + 1}`}`, ''); if (finding.body) lines.push(finding.body, ''); if (finding.filePath) lines.push(`Path: \`${finding.filePath}\``, ''); });
  lines.push('---', '_Automated review by orchestrator-pack pack-owned runner_');
  return lines.join('\n');
}
async function postReview(options: { root: string; slug: string; pr: number; sha: string; run: PackReviewRunRecord; value: Verdict; fixtureId?: number }) {
  const event = options.value.verdict === 'clean' && options.value.findingCount === 0 ? 'APPROVE' : 'REQUEST_CHANGES';
  const body = reviewBody(options.run, options.value);
  const capture = str(process.env.PACK_REVIEW_GITHUB_REVIEW_CAPTURE_FILE);
  if (capture || (process.env.OPK_VITEST_HARNESS === '1' && options.fixtureId)) {
    if (capture) { mkdirSync(dirname(resolve(capture)), { recursive: true }); writeFileSync(resolve(capture), `${JSON.stringify({ repoSlug: options.slug, prNumber: options.pr, commitId: options.sha, event, body }, null, 2)}\n`, 'utf8'); }
    return { id: options.fixtureId ?? 1, url: `fixture://pull/${options.pr}/review` };
  }
  const output = await required(await runProcess({ command: 'gh', args: ['api', '--method', 'POST', `repos/${options.slug}/pulls/${options.pr}/reviews`, '--input', '-'], input: `${JSON.stringify({ commit_id: options.sha, event, body })}\n`, cwd: options.root, inheritParentEnv: true, timeoutMs: 60_000 }), 'GitHub PR review post');
  const posted = JSON.parse(output) as { id?: number | string; html_url?: string };
  if (!posted.id) throw new Error('GitHub PR review post returned no review id');
  return { id: posted.id, url: str(posted.html_url) };
}

async function worktree(root: string, storeRoot: string, runId: string, sha: string): Promise<string> {
  const probe = await runProcess({ command: 'git', args: ['cat-file', '-e', `${sha}^{commit}`], cwd: root, inheritParentEnv: true, allowEmptyStdout: true });
  if (!probe.ok) await git(root, ['fetch', '--no-tags', 'origin', sha], `git fetch ${sha}`);
  const path = join(packReviewWorktreesDir(storeRoot), runId);
  mkdirSync(dirname(path), { recursive: true }); rmSync(path, { recursive: true, force: true });
  await git(root, ['worktree', 'add', '--detach', path, sha], 'git worktree add');
  return path;
}
async function removeWorktree(root: string, path: string): Promise<void> {
  if (!path) return;
  const result = await runProcess({ command: 'git', args: ['worktree', 'remove', '--force', path], cwd: root, inheritParentEnv: true, allowEmptyStdout: true });
  if (!result.ok) rmSync(path, { recursive: true, force: true });
}
function logs(storeRoot: string, runId: string, result: ProcessResult): void {
  const dir = packReviewLogsDir(storeRoot); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.stdout.log`), result.stdout, 'utf8'); writeFileSync(join(dir, `${runId}.stderr.log`), result.stderr, 'utf8');
}
async function reviewer(options: { path: string; trustedRoot: string; targetRoot: string; base: string; pr: number; issue?: number; session: string; timeout: number; runId: string; projectId: string; storeRoot: string; fixtureOut?: string; fixtureExit?: number }): Promise<ProcessResult> {
  if (process.env.OPK_VITEST_HARNESS === '1' && options.fixtureOut !== undefined) { const code = options.fixtureExit ?? 0; return { outcome: 'exit', ok: code === 0, exitCode: code, signal: null, stdout: options.fixtureOut, stderr: '', timedOut: false, cancelled: false }; }
  const args = ['-NoProfile', '-File', options.path, '--repo-root', options.targetRoot, '--base', options.base, '--pr-number', String(options.pr)];
  if (options.issue) args.push('--issue', String(options.issue));
  const env: NodeJS.ProcessEnv = { AO_PR_NUMBER: String(options.pr), GITHUB_PR_NUMBER: String(options.pr), AO_REVIEW_RUN_ID: options.runId, PACK_REVIEW_RUN_ID: options.runId };
  if (options.session) { env.AO_SESSION_ID = options.session; env.AO_WORKER_SESSION_ID = options.session; }
  return runProcess({ command: 'pwsh', args, cwd: options.trustedRoot, inheritParentEnv: true, env, allowEmptyStdout: true, timeoutMs: options.timeout * 1_000, onSpawn: () => { updatePackReviewRun(options.runId, { runnerPid: process.pid, status: 'running', latestRunStatus: 'running', reviewTargetRoot: options.targetRoot }, { projectId: options.projectId, storeRoot: options.storeRoot }); } });
}

export async function startPackReview(input: StartPackReviewInput): Promise<Obj> {
  const trusted = resolveTrustedRunnerPaths();
  const projectId = str(input.projectId) || PROJECT;
  const base = str(input.baseRef) || BASE;
  const timeout = positive(input.timeoutSeconds ?? TIMEOUT, 'timeoutSeconds') ?? TIMEOUT;
  const targetInfo = await target(input, trusted.trustedPackRoot);
  const storeRoot = resolvePackReviewRunStoreRoot({ projectId, storeRoot: input.storeRoot });
  let claimLease: ClaimLease | undefined; let run: PackReviewRunRecord | undefined; let targetRoot = ''; let terminal = false;
  try {
    if ((input.claimMode ?? 'acquire') === 'acquire') {
      claimLease = await acquireClaimLease({ trustedRoot: trusted.trustedPackRoot, claimPath: trusted.claimPath, projectId, storeRoot, prNumber: targetInfo.prNumber, headSha: targetInfo.headSha, surface: str(input.surface) || 'pack-review-runner-manual', reason: str(input.startReason) || 'manual' });
      if (!claimLease.acquired) return { ok: false, created: false, reused: true, reason: claimLease.reason, httpStatus: 200 };
    }
    const created = createPackReviewRun({ projectId, storeRoot, prNumber: targetInfo.prNumber, headSha: targetInfo.headSha, linkedSessionId: targetInfo.sessionId, startReason: str(input.startReason) || ((input.claimMode ?? 'acquire') === 'preacquired' ? 'automatic' : 'manual'), surface: str(input.surface) || 'pack-review-runner', trustedPackRoot: trusted.trustedPackRoot, sourceRepoRoot: targetInfo.sourceRepoRoot });
    run = created.run;
    if (created.reused) {
      if (claimLease?.acquired) await claimLease.release('run_started', listPackReviewRuns({ projectId, storeRoot }));
      return { ok: true, created: false, reused: true, reason: created.reason, runId: run.id, status: run.status, httpStatus: 200 };
    }
    updatePackReviewRun(run.id, { status: 'preparing', latestRunStatus: 'preparing', runnerPid: process.pid }, { projectId, storeRoot });
    if (process.env.OPK_VITEST_HARNESS === '1' && input.fixtureReviewStdout !== undefined) { targetRoot = join(packReviewWorktreesDir(storeRoot), run.id); mkdirSync(targetRoot, { recursive: true }); }
    else targetRoot = await worktree(targetInfo.sourceRepoRoot, storeRoot, run.id, targetInfo.headSha);
    updatePackReviewRun(run.id, { reviewTargetRoot: targetRoot }, { projectId, storeRoot });
    const timer = setInterval(() => { try { heartbeatPackReviewRun(run!.id, { projectId, storeRoot }); } catch { /* terminal write is fail-closed */ } }, HEARTBEAT); timer.unref();
    let result: ProcessResult;
    try { result = await reviewer({ path: trusted.reviewerPath, trustedRoot: trusted.trustedPackRoot, targetRoot, base, pr: targetInfo.prNumber, issue: targetInfo.issueNumber, session: targetInfo.sessionId, timeout, runId: run.id, projectId, storeRoot, fixtureOut: input.fixtureReviewStdout, fixtureExit: input.fixtureReviewExitCode }); }
    finally { clearInterval(timer); }
    logs(storeRoot, run.id, result);
    if (result.timedOut) { setPackReviewRunTerminal(run.id, 'timed_out', { exitCode: result.exitCode, failureReason: 'reviewer_process_timeout' }, { projectId, storeRoot }); terminal = true; throw new Error('reviewer process timed out'); }
    if (!result.ok) { setPackReviewRunTerminal(run.id, 'failed', { exitCode: result.exitCode, failureReason: str(result.error || result.stderr || result.stdout) || 'reviewer_process_failed' }, { projectId, storeRoot }); terminal = true; throw new Error(`reviewer process failed (exit ${String(result.exitCode)})`); }
    const value = verdict(result.stdout);
    updatePackReviewRun(run.id, { status: 'reviewing', latestRunStatus: 'reviewing' }, { projectId, storeRoot });
    const posted = await postReview({ root: targetInfo.sourceRepoRoot, slug: targetInfo.repoSlug, pr: targetInfo.prNumber, sha: targetInfo.headSha, run, value, fixtureId: input.fixtureGithubReviewId });
    const status: PackReviewRunStatus = value.verdict === 'clean' && value.findingCount === 0 ? 'up_to_date' : 'changes_requested';
    setPackReviewRunTerminal(run.id, status, { exitCode: 0, githubReviewId: posted.id, githubReviewUrl: posted.url }, { projectId, storeRoot }); terminal = true;
    if (claimLease?.acquired) await claimLease.release('run_started', listPackReviewRuns({ projectId, storeRoot }));
    return { ok: true, created: true, reused: false, reason: 'completed', runId: run.id, status, httpStatus: 201, githubReviewId: posted.id, githubReviewUrl: posted.url };
  } catch (error) {
    if (run && !terminal) { try { setPackReviewRunTerminal(run.id, 'failed', { exitCode: 1, failureReason: errorText(error) }, { projectId, storeRoot }); } catch { /* primary error wins */ } }
    if (claimLease?.acquired) { try { await claimLease.release('failure', listPackReviewRuns({ projectId, storeRoot }), errorText(error)); } catch { /* stale recovery remains */ } }
    return { ok: false, created: Boolean(run), reused: false, reason: errorText(error), runId: run?.id ?? '', status: run ? getPackReviewRun(run.id, { projectId, storeRoot })?.status : undefined, httpStatus: 500 };
  } finally {
    if (targetRoot) await removeWorktree(targetInfo.sourceRepoRoot, targetRoot);
    if (claimLease) rmSync(claimLease.directory, { recursive: true, force: true });
  }
}

const usage = () => ['Pack-owned review runner (Issue #839)', '', 'Manual trigger:', '  node --experimental-strip-types scripts/pack-review-runner.ts start --pr-number <n> --head-sha <40-hex>', '  node --experimental-strip-types scripts/pack-review-runner.ts start --session-id <worker-session-id>', '', 'Status:', '  node --experimental-strip-types scripts/pack-review-runner.ts list [--project-id orchestrator-pack]'].join('\n');
function args(argv: string[]): Obj {
  const result: Obj = {}; const map: Record<string, string> = { '--project-id': 'projectId', '--session-id': 'sessionId', '--pr-number': 'prNumber', '--head-sha': 'headSha', '--repo-root': 'repoRoot', '--source-repo-root': 'sourceRepoRoot', '--base': 'baseRef', '--start-reason': 'startReason', '--surface': 'surface', '--store-root': 'storeRoot', '--timeout-seconds': 'timeoutSeconds', '--claim-mode': 'claimMode' };
  for (let i = 0; i < argv.length; i += 1) { const flag = argv[i]!; const key = map[flag]; if (!key) throw new Error(`unknown argument '${flag}'\n${usage()}`); const value = argv[++i]; if (value === undefined) throw new Error(`missing value for ${flag}`); result[key] = key === 'prNumber' || key === 'timeoutSeconds' ? Number(value) : value; }
  return result;
}
function stdin(): Obj { if (process.stdin.isTTY) return {}; const raw = readFileSync(0, 'utf8').trim(); if (!raw) return {}; const value = JSON.parse(raw) as unknown; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('runner stdin payload must be a JSON object'); return value as Obj; }
async function main(): Promise<void> {
  const [command = 'help', ...argv] = process.argv.slice(2);
  if (command === 'help' || argv.includes('--help') || argv.includes('-h')) { process.stdout.write(`${usage()}\n`); return; }
  const input = { ...stdin(), ...args(argv) };
  if (command === 'list') { process.stdout.write(`${JSON.stringify({ runs: listPackReviewRuns(input) })}\n`); return; }
  if (command === 'status') { const runId = str(input.runId); if (!runId) throw new Error('status requires runId in JSON payload'); process.stdout.write(`${JSON.stringify({ run: getPackReviewRun(runId, input) })}\n`); return; }
  if (command === 'start') { const result = await startPackReview(input); process.stdout.write(`${JSON.stringify(result)}\n`); if (!result.ok) process.exitCode = 1; return; }
  throw new Error(`unknown subcommand '${command}'\n${usage()}`);
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) { try { await main(); } catch (error) { process.stderr.write(`${errorText(error)}\n`); process.exitCode = 1; } }
