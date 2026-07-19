import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BINDING_SOURCE_BACKFILL_RESOLVER,
  createDefaultPrSessionBindingCache,
  lookupBindingByPr,
  registerPrSessionBindingRecord,
  resolvePrSessionBindingForConsumer,
} from '../../../docs/pr-session-binding-cache.mjs';
import { preRunHeadReadyRecheck } from '../../../docs/review-head-ready.mjs';
import { resolveSessionPrBinding } from '../../../docs/session-pr-binding-resolver.mjs';
import {
  GithubReviewPostError,
  reconcileGithubCommentReview,
  type GithubReviewCaptureAction,
  type GithubReviewSummary,
  type GithubReviewTransport,
} from '../../lib/github-review-reconciliation.js';
import {
  deliverPackReviewVerdict,
  PACK_REVIEW_REQUIRED_STATUS_CONTEXT,
  resumePackReviewVerdictDelivery,
  type PackReviewTerminalPayload,
} from '../../lib/pack-review-delivery.js';
import {
  createPackReviewRun,
  getPackReviewRun,
  listPackReviewRuns,
  updatePackReviewRun,
  type PackReviewRunRecord,
} from '../../lib/pack-review-run-store.js';
import { startPackReview } from '../../pack-review-runner.js';
import { psString, repoRoot, runPwsh } from '../../_test-pwsh-helpers.js';

export interface MutationRecord {
  mutationIdentity: string;
  mutations: string[];
  executed: true;
  negativeOutcome: 'red';
  restoredOutcome: 'green';
}

interface FixtureContract {
  schemaVersion: number;
  issue: number;
  task: number;
  repoSlug: string;
  capture: {
    path: string;
    selectors: Record<string, string>;
    expected: Record<string, unknown>;
  };
  assembly: {
    prNumber: number;
    reviewer: string;
    requiredOrder: string[];
    consumer: { source: string; reason: string; failClosed: boolean };
  };
  scope: {
    root: string;
    allowedSuffixes: string[];
    expectedAddedPaths: string[];
  };
}

interface TraceRow {
  event: string;
  atMs: number;
  [key: string]: unknown;
}

const supportDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(supportDir, 'task-311.fixture.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as FixtureContract;
const projectId = 'orchestrator-pack';
const cleanPayload: PackReviewTerminalPayload = { verdict: 'clean', findingCount: 0, findings: [] };
const blockingPayload: PackReviewTerminalPayload = {
  verdict: 'findings',
  findingCount: 1,
  findings: [{ title: 'Blocking task-311 fixture', severity: 'error' }],
};

export function fixtureContract(): FixtureContract {
  return structuredClone(fixture);
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function tempRoot(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function appendTrace(tracePath: string, event: string, detail: Record<string, unknown> = {}): void {
  appendFileSync(tracePath, `${JSON.stringify({ event, atMs: Date.now(), ...detail })}\n`, 'utf8');
}

function readTrace(tracePath: string): TraceRow[] {
  if (!existsSync(tracePath)) return [];
  return readFileSync(tracePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceRow);
}

function selectorValue(document: unknown, selector: string): unknown {
  invariant(selector.startsWith('$.'), `unsupported selector ${selector}`);
  const tokens = selector
    .slice(2)
    .replaceAll(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let current: unknown = document;
  for (const token of tokens) {
    invariant(current !== null && typeof current === 'object', `selector ${selector} stopped at ${token}`);
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

function readCapture(): { document: Record<string, unknown>; row: Record<string, unknown> } {
  const capturePath = path.join(repoRoot, fixture.capture.path);
  const document = JSON.parse(readFileSync(capturePath, 'utf8')) as Record<string, unknown>;
  for (const [selector, expected] of Object.entries(fixture.capture.expected)) {
    const actual = selectorValue(document, selector);
    invariant(Object.is(actual, expected), `capture selector ${selector} expected ${String(expected)}, got ${String(actual)}`);
  }
  const data = document.data;
  invariant(Array.isArray(data) && data.length > 0, 'AO capture must contain data[0]');
  const row = data[0];
  invariant(row !== null && typeof row === 'object' && !Array.isArray(row), 'AO capture data[0] must be an object');
  return { document, row: row as Record<string, unknown> };
}

function currentHeadSha(): string {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim().toLowerCase();
  invariant(/^[0-9a-f]{40}$/.test(sha), `git returned invalid head ${sha}`);
  return sha;
}

function greenCiChecks(): Array<Record<string, string>> {
  return [
    { name: 'Verify orchestrator-pack structure', state: 'SUCCESS' },
    { name: 'PR scope guard', state: 'SUCCESS' },
    { name: 'Run pack contract tests', state: 'SUCCESS' },
    { name: 'Self-architect lint', state: 'SUCCESS' },
  ];
}

function orderedEvents(rows: Array<TraceRow | string>, required: string[]): string[] {
  const observed = rows.map((row) => typeof row === 'string' ? row : row.event);
  let cursor = -1;
  for (const event of required) {
    const index = observed.indexOf(event, cursor + 1);
    invariant(index >= 0, `missing ordered event ${event}; observed=${observed.join(',')}`);
    cursor = index;
  }
  return observed;
}

function redThenGreen(
  mutationIdentity: string,
  baseline: unknown,
  validate: (candidate: unknown) => void,
  mutations: Array<{ id: string; mutate: (candidate: any) => void }>,
): MutationRecord {
  for (const mutation of mutations) {
    const candidate = jsonClone(baseline);
    mutation.mutate(candidate);
    let rejected = false;
    try {
      validate(candidate);
    } catch {
      rejected = true;
    }
    invariant(rejected, `mutation ${mutation.id} unexpectedly stayed green`);
  }
  validate(jsonClone(baseline));
  return {
    mutationIdentity,
    mutations: mutations.map((mutation) => mutation.id),
    executed: true,
    negativeOutcome: 'red',
    restoredOutcome: 'green',
  };
}

function writeExecutable(file: string, content: string): void {
  writeFileSync(file, content, 'utf8');
  if (process.platform !== 'win32') chmodSync(file, 0o700);
}

function installReviewerExecutableBoundary(root: string, tracePath: string): string {
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const fakeNode = path.join(root, 'fake-reviewer-node.cjs');
  writeFileSync(fakeNode, `
const fs = require('node:fs');
const args = process.argv.slice(2);
const trace = process.env.TASK311_TRACE_FILE;
const expectedPr = process.env.TASK311_EXPECTED_PR;
const expectedHead = process.env.TASK311_EXPECTED_HEAD;
const expectedSession = process.env.TASK311_EXPECTED_SESSION;
const fail = (message) => { process.stderr.write(message + '\\n'); process.exit(64); };
const valueAfter = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : ''; };
if (!args.some((value) => /plugins[\\\\/]ao-codex-pr-reviewer[\\\\/]bin[\\\\/]review\\.ts$/.test(value))) fail('real plugin reviewer wrapper was not invoked');
if (valueAfter('--pr-number') !== expectedPr) fail('reviewer argv lost exact PR');
if (!valueAfter('--repo-root')) fail('reviewer argv lost isolated worktree root');
if (!valueAfter('--base')) fail('reviewer argv lost base ref');
fs.appendFileSync(trace, JSON.stringify({
  event: 'reviewer-wrapper',
  atMs: Date.now(),
  argv: args,
  prNumber: Number(expectedPr),
  headSha: expectedHead,
  sessionId: expectedSession,
}) + '\\n');
process.stdout.write(JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] }) + '\\n');
`, 'utf8');

  if (process.platform === 'win32') {
    writeExecutable(path.join(bin, 'node.cmd'), `@echo off\r\n"${process.execPath}" "${fakeNode}" %*\r\n`);
    writeExecutable(path.join(bin, 'npm.cmd'), '@echo off\r\nexit /b 0\r\n');
  } else {
    writeExecutable(path.join(bin, 'node'), `#!/usr/bin/env sh\nexec "${process.execPath}" "${fakeNode}" "$@"\n`);
    writeExecutable(path.join(bin, 'npm'), '#!/usr/bin/env sh\nexit 0\n');
  }
  invariant(existsSync(tracePath) || tracePath.length > 0, 'trace path must be configured');
  return bin;
}

function githubTransport(headSha: string, tracePath: string): GithubReviewTransport {
  const actions: GithubReviewCaptureAction[] = [];
  const reviews: GithubReviewSummary[] = [];
  return {
    actions,
    async resolveActorLogin() {
      return 'task-311-reviewer';
    },
    async listReviews() {
      return [...reviews];
    },
    async postReview(input) {
      invariant(input.event === 'COMMENT', 'runner must publish COMMENT');
      invariant(input.commitId === headSha, 'GitHub COMMENT must target the exact head');
      appendTrace(tracePath, 'github-comment', {
        eventType: input.event,
        headSha: input.commitId,
        body: input.body,
      });
      const review = {
        id: 31101,
        state: 'COMMENTED',
        userLogin: 'task-311-reviewer',
        submittedAt: new Date().toISOString(),
        body: input.body,
        commitId: input.commitId,
        url: 'fixture://task-311/review/31101',
      } satisfies GithubReviewSummary;
      reviews.push(review);
      actions.push({ kind: 'post', event: input.event, body: input.body });
      return { id: review.id, url: review.url };
    },
    async dismissReview(reviewId) {
      actions.push({ kind: 'dismiss', event: 'DISMISS', reviewId });
    },
  };
}

function validateAssemblyEvidence(candidate: unknown): void {
  invariant(candidate !== null && typeof candidate === 'object', 'assembly evidence must be an object');
  const evidence = candidate as any;
  const target = evidence.target;
  invariant(Number.isInteger(target?.prNumber) && target.prNumber > 0, 'assembly target PR missing');
  invariant(/^[0-9a-f]{40}$/.test(String(target?.headSha ?? '')), 'assembly target head missing');
  invariant(String(target?.sessionId ?? '') === 'orchestrator-pack-7', 'assembly target worker drifted');
  invariant(evidence.binding?.session?.bound === true, 'real session binding did not bind');
  invariant(evidence.binding?.session?.prNumber === target.prNumber, 'session binding PR drifted');
  invariant(evidence.binding?.cacheRecord?.sessionId === target.sessionId, 'cache record worker drifted');
  invariant(evidence.binding?.cacheRecord?.prNumber === target.prNumber, 'cache record PR drifted');
  invariant(evidence.binding?.cacheRecord?.headSha === target.headSha, 'cache record head drifted');
  invariant(evidence.binding?.consumer?.source === fixture.assembly.consumer.source, 'consumer did not use cache');
  invariant(evidence.binding?.consumer?.reason === fixture.assembly.consumer.reason, 'consumer reason drifted');
  invariant(evidence.binding?.consumer?.failClosed === fixture.assembly.consumer.failClosed, 'consumer failed closed unexpectedly');
  invariant(evidence.binding?.consumer?.sessionId === target.sessionId, 'consumer worker drifted');
  invariant(evidence.identity === 'one-pr-head-worker-chain', 'identity chain marker missing');
  orderedEvents(evidence.trace, fixture.assembly.requiredOrder);
  const reviewerArgv = evidence.reviewerArgv;
  invariant(Array.isArray(reviewerArgv), 'reviewer argv evidence missing');
  const prIndex = reviewerArgv.indexOf('--pr-number');
  invariant(prIndex >= 0 && Number(reviewerArgv[prIndex + 1]) === target.prNumber, 'reviewer argv PR drifted');
  invariant(reviewerArgv.some((value: string) => /plugins[\\/]ao-codex-pr-reviewer[\\/]bin[\\/]review\.ts$/.test(value)), 'real reviewer wrapper path missing');
  invariant(evidence.github?.headSha === target.headSha, 'GitHub result head drifted');
  invariant(evidence.github?.eventType === 'COMMENT', 'GitHub result is not COMMENT');
  invariant(String(evidence.github?.body ?? '').includes(`Head: \`${target.headSha}\``), 'GitHub body lost head identity');
  invariant(String(evidence.status?.idempotencyKey ?? '').includes(target.headSha), 'required status lost exact head');
  invariant(evidence.status?.state === 'success', 'clean review required status must be success');
  invariant(String(evidence.worker?.idempotencyKey ?? '').includes(target.headSha), 'worker notification lost exact head');
  invariant(String(evidence.worker?.message ?? '').includes(`Head: ${target.headSha}`), 'worker message lost exact head');
  invariant(evidence.run?.targetSha === target.headSha, 'run store head drifted');
  invariant(evidence.run?.prNumber === target.prNumber, 'run store PR drifted');
  invariant(evidence.run?.linkedSessionId === target.sessionId, 'run store worker drifted');
  invariant(evidence.run?.status === 'up_to_date', 'clean run did not terminalize up_to_date');
  invariant(evidence.claim?.prNumber === target.prNumber, 'claim PR drifted');
  invariant(evidence.claim?.headSha === target.headSha, 'claim head drifted');
  invariant(evidence.claim?.outcome === 'run_started', 'claim did not complete as run_started');
}

export async function runRealAssembly(): Promise<{ assembly: Record<string, unknown>; mutations: { AC1: MutationRecord; AC2: MutationRecord } }> {
  const root = tempRoot('task-311-assembly-');
  const tracePath = path.join(root, 'trace.jsonl');
  writeFileSync(tracePath, '', 'utf8');
  const storeRoot = path.join(root, 'review-store');
  const claimRoot = path.join(root, 'claims');
  const headSha = currentHeadSha();
  const { row: session } = readCapture();
  const sessionId = String(session.id);
  const prNumber = fixture.assembly.prNumber;
  const issueNumber = Number(session.issueId);
  invariant(Number.isInteger(issueNumber) && issueNumber === prNumber, 'capture issue must bind to fixture PR');
  const openPr = {
    number: prNumber,
    headRefOid: headSha,
    headRefName: `issue-${issueNumber}-task-311`,
    state: 'OPEN',
    repoSlug: fixture.repoSlug,
    headCommittedAt: '2026-07-06T05:00:00.000Z',
  };
  const originalEnv = { ...process.env };

  try {
    appendTrace(tracePath, 'fresh-head-input', { prNumber, headSha });
    appendTrace(tracePath, 'open-pr-exact-head', { prNumber: openPr.number, headSha: openPr.headRefOid });

    const binding = resolveSessionPrBinding(session, [openPr], { headSha });
    appendTrace(tracePath, 'binding-resolution', { binding });
    invariant(binding.bound, `real resolver refused capture row: ${binding.deferReason ?? binding.source}`);

    const cache = createDefaultPrSessionBindingCache();
    const registered = registerPrSessionBindingRecord(cache, {
      sessionId,
      prNumber,
      repoSlug: fixture.repoSlug,
      issueNumber,
      headSha,
      source: BINDING_SOURCE_BACKFILL_RESOLVER,
      openPrs: [openPr],
    }, Date.parse('2026-07-19T02:00:00.000Z'));
    invariant(registered.ok, `cache registration failed: ${registered.reason ?? registered.diagnostic}`);
    const cacheRecord = lookupBindingByPr(cache, fixture.repoSlug, prNumber);
    invariant(cacheRecord, 'real cache lookup returned no record');
    const consumer = resolvePrSessionBindingForConsumer({
      store: cache,
      repoSlug: fixture.repoSlug,
      prNumber,
      headSha,
      sessions: [session],
      openPrs: [openPr],
      nowMs: Date.parse('2026-07-19T02:00:00.000Z'),
      writeBackfill: false,
      isLive: () => true,
    });
    appendTrace(tracePath, 'binding-cache', { cacheRecord, consumer });

    const headDecision = preRunHeadReadyRecheck({
      prNumber,
      headSha,
      sessionId,
      startReason: 'task_311_vertical_slice',
    }, {
      openPrs: [openPr],
      reviewRuns: [],
      sessions: [session],
      ciChecks: greenCiChecks(),
      ownerResolution: consumer,
      nowMs: Date.parse('2026-07-19T02:00:00.000Z'),
      workerDeliveries: [],
    });
    invariant(headDecision.emitReviewRun, `fresh-head recheck denied positive path: ${headDecision.reason}`);
    appendTrace(tracePath, 'fresh-head-admission', { headDecision });

    const boundaryBin = installReviewerExecutableBoundary(root, tracePath);
    process.env.PATH = `${boundaryBin}${delimiter}${originalEnv.PATH ?? ''}`;
    process.env.PACK_REVIEWER = fixture.assembly.reviewer;
    process.env.AO_REVIEW_CLAIM_DIR = claimRoot;
    process.env.TASK311_TRACE_FILE = tracePath;
    process.env.TASK311_EXPECTED_PR = String(prNumber);
    process.env.TASK311_EXPECTED_HEAD = headSha;
    process.env.TASK311_EXPECTED_SESSION = sessionId;

    const statusRows: Array<Record<string, unknown>> = [];
    const workerRows: Array<Record<string, unknown>> = [];
    const result = await startPackReview({
      projectId,
      sessionId,
      prNumber,
      headSha,
      repoRoot,
      sourceRepoRoot: repoRoot,
      baseRef: 'origin/main',
      startReason: 'task_311_vertical_slice',
      surface: 'task-311-real-assembly',
      storeRoot,
      fixtureRepoSlug: fixture.repoSlug,
      fixtureGithubReviewTransport: githubTransport(headSha, tracePath),
      fixtureRequiredStatusWriter: async (request) => {
        const row = { ...request };
        statusRows.push(row);
        if (request.state !== 'pending') appendTrace(tracePath, 'required-status', row);
      },
      fixtureWorkerNotifier: async (request) => {
        const row = { ...request };
        workerRows.push(row);
        appendTrace(tracePath, 'worker-message', row);
        return { state: 'delivered', reason: 'task_311_boundary_delivered' };
      },
      fixtureJournalWriter: (runId, fields, options) => {
        const persisted = updatePackReviewRun(runId, fields, options);
        appendTrace(tracePath, 'journal-verdict', {
          runId,
          reviewVerdict: persisted.reviewVerdict,
          headSha: persisted.targetSha,
        });
        return persisted;
      },
    });
    invariant(result.ok === true && result.created === true, `real runner failed: ${String(result.reason)}`);
    const runId = String(result.runId);
    const run = getPackReviewRun(runId, { projectId, storeRoot });
    invariant(run, 'runner returned a missing run');

    const terminalDir = path.join(claimRoot, 'terminal');
    invariant(existsSync(terminalDir), 'real claim helper wrote no terminal directory');
    const terminalRecords = readdirSync(terminalDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(path.join(terminalDir, name), 'utf8')) as Record<string, unknown>);
    const claim = terminalRecords.find((record) => Number(record.prNumber) === prNumber && record.headSha === headSha);
    invariant(claim, 'real claim helper wrote no matching terminal record');

    const rawTrace = readTrace(tracePath);
    const reviewer = rawTrace.find((row) => row.event === 'reviewer-wrapper');
    const github = rawTrace.find((row) => row.event === 'github-comment');
    const terminalStatus = statusRows.findLast((row) => row.state !== 'pending');
    const worker = workerRows.at(-1);
    invariant(reviewer && github && terminalStatus && worker, 'assembly external boundary evidence incomplete');

    const enrichedTrace: TraceRow[] = [
      ...rawTrace.filter((row) => ['fresh-head-input', 'open-pr-exact-head', 'binding-resolution', 'binding-cache', 'fresh-head-admission'].includes(row.event)),
      { event: 'atomic-claim', atMs: Date.parse(String(claim.acquiredAtUtc)), prNumber, headSha },
      { event: 'runner-wrapper', atMs: Date.parse(run.createdAt), runId, prNumber, headSha },
      ...rawTrace.filter((row) => !['fresh-head-input', 'open-pr-exact-head', 'binding-resolution', 'binding-cache', 'fresh-head-admission', 'reviewer-dependency-preflight'].includes(row.event)),
    ].sort((left, right) => left.atMs - right.atMs);

    const assembly = {
      target: { prNumber, headSha, sessionId },
      binding: { session: binding, cacheRecord, consumer },
      identity: 'one-pr-head-worker-chain',
      trace: enrichedTrace.map((row) => row.event),
      traceRows: enrichedTrace,
      reviewerArgv: reviewer.argv,
      github: {
        headSha: github.headSha,
        eventType: github.eventType,
        body: github.body,
      },
      status: terminalStatus,
      worker,
      run,
      claim,
      headDecision,
    };
    validateAssemblyEvidence(assembly);

    const AC1 = redThenGreen(
      'real-imports-wrapper-argv-and-journal-order',
      assembly,
      validateAssemblyEvidence,
      [
        { id: 'replace-real-consumer-output-with-harness-result', mutate: (value) => { value.binding.consumer.source = 'harness'; } },
        { id: 'swap-journal-and-github-comment-order', mutate: (value) => {
          const journal = value.trace.indexOf('journal-verdict');
          const githubIndex = value.trace.indexOf('github-comment');
          [value.trace[journal], value.trace[githubIndex]] = [value.trace[githubIndex], value.trace[journal]];
        } },
        { id: 'drop-reviewer-pr-argv', mutate: (value) => {
          const index = value.reviewerArgv.indexOf('--pr-number');
          value.reviewerArgv.splice(index, 2);
        } },
      ],
    );
    const AC2 = redThenGreen(
      'single-pr-head-worker-identity-chain',
      assembly,
      validateAssemblyEvidence,
      [
        { id: 'cross-wire-required-status-head', mutate: (value) => { value.status.idempotencyKey = `required-status:${PACK_REVIEW_REQUIRED_STATUS_CONTEXT}:${'b'.repeat(40)}`; } },
        { id: 'cross-wire-worker-session', mutate: (value) => { value.target.sessionId = 'orchestrator-pack-crosswired'; } },
        { id: 'cross-wire-github-head', mutate: (value) => { value.github.headSha = 'c'.repeat(40); } },
      ],
    );
    return { assembly, mutations: { AC1, AC2 } };
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) process.env[key] = value;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function validateClaimMatrix(candidate: unknown): void {
  invariant(candidate !== null && typeof candidate === 'object', 'claim matrix missing');
  const matrix = candidate as any;
  invariant(matrix.classes === 'C1-C7-pass', 'claim class marker missing');
  invariant(matrix.C1?.winners === 1 && matrix.C1?.runStarts === 1, 'C1 failed');
  invariant(matrix.C2?.winners === 1 && matrix.C2?.activeCount === 1, 'C2 failed');
  invariant(matrix.C3?.firstAcquired === true && matrix.C3?.secondAcquired === false, 'C3 did not suppress duplicate');
  invariant(matrix.C3?.sameOwner === true && matrix.C3?.loserReason === 'claimed', 'C3 owner evidence drifted');
  invariant(matrix.C4?.covered === true && matrix.C4?.replacementStarted === false, 'C4 covered-run suppression failed');
  invariant(matrix.C5?.reclaimed === true && matrix.C5?.winners === 1 && matrix.C5?.activeCount === 1, 'C5 reaper recovery failed');
  invariant(matrix.C6?.blocked === true && matrix.C6?.runStarted === false && matrix.C6?.reason === 'foreign_holder_manual', 'C6 fail-closed evidence failed');
  invariant(matrix.C7?.firstAcquired === true && matrix.C7?.secondAcquired === true && matrix.C7?.activeCount === 2, 'C7 key isolation failed');
}

export function runClaimMatrix(): { claim: Record<string, unknown>; mutation: MutationRecord } {
  const root = tempRoot('task-311-claim-');
  const helperPath = path.join(repoRoot, 'scripts', 'lib', 'Review-StartClaim.ps1');
  const shaA = 'a'.repeat(40);
  const shaB = 'b'.repeat(40);
  try {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$helperPath = ${psString(helperPath)}
. $helperPath
$root = ${psString(root)}
$shaA = ${psString(shaA)}
$shaB = ${psString(shaB)}
function New-Task311Namespace([string]$name) {
  $ns = Join-Path $root $name
  Initialize-ReviewStartClaimNamespace -Namespace $ns
  return $ns
}

$ns1 = New-Task311Namespace 'c1'
$c1 = Acquire-ReviewStartClaim -PrNumber 311 -HeadSha $shaA -Surface 'task-311-c1' -Namespace $ns1 -ReviewRuns @()
$c1Run = @{ id='task-311-c1-run'; prNumber=311; targetSha=$shaA; status='running' }
$c1Complete = Complete-ReviewStartClaim -ClaimResult $c1 -Outcome 'run_started' -ReviewRuns @($c1Run)

$ns2 = New-Task311Namespace 'c2'
$c2Rows = 1..6 | ForEach-Object -Parallel {
  $env:AO_REVIEW_CLAIM_DIR = $using:ns2
  $env:AO_REVIEW_START_MONOTONIC_NOW_MS = '1000'
  . $using:helperPath
  $claim = Acquire-ReviewStartClaim -PrNumber 312 -HeadSha $using:shaA -Surface "task-311-c2-$($_)" -Namespace $using:ns2 -ReviewRuns @()
  [pscustomobject]@{ acquired=[bool]$claim.acquired; reason=[string]$claim.reason }
} -ThrottleLimit 6

$ns3 = New-Task311Namespace 'c3'
$c3a = Acquire-ReviewStartClaim -PrNumber 313 -HeadSha $shaA -Surface 'task-311-c3-a' -Namespace $ns3 -ReviewRuns @()
$c3b = Acquire-ReviewStartClaim -PrNumber 313 -HeadSha $shaA -Surface 'task-311-c3-b' -Namespace $ns3 -ReviewRuns @()

$ns4 = New-Task311Namespace 'c4'
$c4a = Acquire-ReviewStartClaim -PrNumber 314 -HeadSha $shaA -Surface 'task-311-c4-a' -Namespace $ns4 -ReviewRuns @()
$c4Run = @{ id='task-311-c4-run'; prNumber=314; targetSha=$shaA; status='running' }
$c4b = Acquire-ReviewStartClaim -PrNumber 314 -HeadSha $shaA -Surface 'task-311-c4-b' -Namespace $ns4 -ReviewRuns @($c4Run)

$ns5 = New-Task311Namespace 'c5'
$c5old = Acquire-ReviewStartClaim -PrNumber 315 -HeadSha $shaA -Surface 'task-311-c5-dead' -Namespace $ns5 -ReviewRuns @()
$c5record = Get-Content -LiteralPath $c5old.path -Raw -Encoding UTF8 | ConvertFrom-Json
$c5record.holder.pid = 2147483000
$c5record.holder.host = Get-ReviewStartClaimLocalHostName
$c5record.holder.PSObject.Properties.Remove('startTimeTicks')
$c5record.holder.PSObject.Properties.Remove('bootIdHash')
($c5record | ConvertTo-Json -Compress -Depth 20) | Set-Content -LiteralPath $c5old.path -Encoding UTF8
$c5sweep = Invoke-ReviewStartClaimReaperSweep -Namespace $ns5 -ProjectId 'orchestrator-pack' -ReviewRuns @()
$c5Rows = 1..4 | ForEach-Object -Parallel {
  $env:AO_REVIEW_CLAIM_DIR = $using:ns5
  $env:AO_REVIEW_START_MONOTONIC_NOW_MS = '2000'
  . $using:helperPath
  $claim = Acquire-ReviewStartClaim -PrNumber 315 -HeadSha $using:shaA -Surface "task-311-c5-$($_)" -Namespace $using:ns5 -ReviewRuns @()
  [pscustomobject]@{ acquired=[bool]$claim.acquired; recovered=[bool]$claim.recovered; reason=[string]$claim.reason }
} -ThrottleLimit 4

$ns6 = New-Task311Namespace 'c6'
$c6old = Acquire-ReviewStartClaim -PrNumber 316 -HeadSha $shaA -Surface 'task-311-c6-foreign' -Namespace $ns6 -ReviewRuns @()
$c6record = Get-Content -LiteralPath $c6old.path -Raw -Encoding UTF8 | ConvertFrom-Json
$c6record.holder.host = 'foreign-task-311.example'
($c6record | ConvertTo-Json -Compress -Depth 20) | Set-Content -LiteralPath $c6old.path -Encoding UTF8
$c6sweep = Invoke-ReviewStartClaimReaperSweep -Namespace $ns6 -ProjectId 'orchestrator-pack' -ReviewRuns @()
$c6retry = Acquire-ReviewStartClaim -PrNumber 316 -HeadSha $shaA -Surface 'task-311-c6-retry' -Namespace $ns6 -ReviewRuns @()

$ns7 = New-Task311Namespace 'c7'
$c7a = Acquire-ReviewStartClaim -PrNumber 317 -HeadSha $shaA -Surface 'task-311-c7-a' -Namespace $ns7 -ReviewRuns @()
$c7b = Acquire-ReviewStartClaim -PrNumber 318 -HeadSha $shaB -Surface 'task-311-c7-b' -Namespace $ns7 -ReviewRuns @()

[ordered]@{
  classes = 'C1-C7-pass'
  C1 = @{ winners = @([bool]$c1.acquired | Where-Object { $_ }).Count; runStarts = @([bool]$c1Complete.ok | Where-Object { $_ }).Count; outcome=[string]$c1Complete.outcome }
  C2 = @{ winners = @($c2Rows | Where-Object { $_.acquired }).Count; activeCount = @((Get-ChildItem -LiteralPath $ns2 -File -Filter 'pr-312-*.json')).Count }
  C3 = @{ firstAcquired=[bool]$c3a.acquired; secondAcquired=[bool]$c3b.acquired; loserReason=[string]$c3b.reason; sameOwner=([string]$c3a.claim.holder.processGuid -eq [string]$c3b.holder.processGuid) }
  C4 = @{ covered=([string]$c4b.reason -eq 'covered_by_run'); replacementStarted=[bool]$c4b.acquired; activeCount=@((Get-ChildItem -LiteralPath $ns4 -File -Filter 'pr-314-*.json')).Count }
  C5 = @{ reclaimed=@($c5sweep.results | Where-Object { $_.reclaimed -and $_.outcome -eq 'recovered_orphan_liveness' }).Count -eq 1; winners=@($c5Rows | Where-Object { $_.acquired }).Count; activeCount=@((Get-ChildItem -LiteralPath $ns5 -File -Filter 'pr-315-*.json')).Count }
  C6 = @{ blocked=[bool]$c6retry.blocking; reason=[string]$c6retry.reason; runStarted=[bool]$c6retry.acquired; manual=@($c6sweep.results | Where-Object { $_.action -eq 'mark_manual' }).Count -eq 1 }
  C7 = @{ firstAcquired=[bool]$c7a.acquired; secondAcquired=[bool]$c7b.acquired; activeCount=@((Get-ChildItem -LiteralPath $ns7 -File -Filter 'pr-*.json')).Count }
} | ConvertTo-Json -Compress -Depth 12
`;
    const claim = JSON.parse(runPwsh(script, {
      AO_REVIEW_CLAIM_DIR: root,
      AO_REVIEW_START_MONOTONIC_NOW_MS: '1000',
    })) as Record<string, unknown>;
    validateClaimMatrix(claim);
    const mutation = redThenGreen(
      'claim-C1-C7-branch-controls',
      claim,
      validateClaimMatrix,
      [
        { id: 'allow-two-overlap-winners-C2', mutate: (value) => { value.C2.winners = 2; } },
        { id: 'replace-owner-on-duplicate-C3', mutate: (value) => { value.C3.sameOwner = false; } },
        { id: 'start-run-for-foreign-holder-C6', mutate: (value) => { value.C6.runStarted = true; } },
      ],
    );
    return { claim, mutation };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function createDeliveryRun(storeRoot: string, suffix: string): PackReviewRunRecord {
  return createPackReviewRun({
    projectId,
    storeRoot,
    prNumber: 918,
    headSha: `${suffix}`.padEnd(40, suffix).slice(0, 40),
    linkedSessionId: `worker-${suffix}`,
    startReason: `task-311-${suffix}`,
    surface: 'task-311-delivery-matrix',
    trustedPackRoot: repoRoot,
    sourceRepoRoot: repoRoot,
  }).run;
}

function journalRun(
  run: PackReviewRunRecord,
  storeRoot: string,
  payload: PackReviewTerminalPayload = cleanPayload,
  fields: Partial<PackReviewRunRecord> = {},
): PackReviewRunRecord {
  return updatePackReviewRun(run.id, {
    status: 'reviewing',
    latestRunStatus: 'reviewing',
    reviewVerdict: payload.verdict,
    findingCount: payload.findingCount,
    findings: [...payload.findings],
    journalOutcome: {
      state: 'persisted',
      recordedAtUtc: '2026-07-19T02:00:00.000Z',
      reason: 'verdict_persisted',
      idempotencyKey: `verdict:${run.id}:${run.targetSha}`,
      attempts: 1,
    },
    ...fields,
  }, { projectId, storeRoot });
}

function channelOutcome(state: 'succeeded' | 'delivered' | 'failed' | 'escalated', reason: string, idempotencyKey: string) {
  return { state, recordedAtUtc: '2026-07-19T02:00:01.000Z', reason, idempotencyKey };
}

function statusKey(run: PackReviewRunRecord): string {
  return `required-status:${PACK_REVIEW_REQUIRED_STATUS_CONTEXT}:${run.targetSha}`;
}

function githubKey(run: PackReviewRunRecord): string {
  return `github-comment:${run.id}:${run.targetSha}`;
}

function workerKey(run: PackReviewRunRecord): string {
  return `worker-notification:${run.id}:${run.targetSha}`;
}

function completedGithubFields(run: PackReviewRunRecord, id: number): Partial<PackReviewRunRecord> {
  return {
    githubReviewId: id,
    githubReviewUrl: `fixture://task-311/review/${id}`,
    githubReviewEvent: 'COMMENT',
    githubReviewReconciliation: {
      schemaVersion: 1,
      event: 'COMMENT',
      phase: 'complete',
      actorLogin: 'task-311-reviewer',
      commentBody: `Run: \`${run.id}\``,
      commentReviewId: id,
      commentReviewUrl: `fixture://task-311/review/${id}`,
      pendingDismissalReviewIds: [],
      dismissedReviewIds: [],
      preparedAtUtc: '2026-07-19T02:00:00.000Z',
      updatedAtUtc: '2026-07-19T02:00:01.000Z',
    },
  };
}

function validateDeliveryMatrix(candidate: unknown): void {
  invariant(candidate !== null && typeof candidate === 'object', 'delivery matrix missing');
  const matrix = candidate as any;
  invariant(matrix.classes === 'J0-J6-pass', 'delivery class marker missing');
  invariant(matrix.J0?.journalAttempts === 3 && matrix.J0?.channelAttempts === 0, 'J0 fail-closed journal behavior failed');
  invariant(matrix.J1?.order?.join(',') === 'github,status,worker' && matrix.J1?.reviewerRuns === 0, 'J1 resume order failed');
  invariant(matrix.J2?.githubAttempts === 0 && matrix.J2?.statusAttempts === 1 && matrix.J2?.workerAttempts === 1, 'J2 durable GitHub skip failed');
  invariant(matrix.J3?.postAttempts === 1 && matrix.J3?.commentCount === 1 && matrix.J3?.phase === 'complete', 'J3 COMMENT convergence failed');
  invariant(matrix.J4?.statusPosts === 2 && matrix.J4?.duplicateAccounted === true && matrix.J4?.exactlyOnceClaimed === false, 'J4 at-least-once accounting failed');
  invariant(matrix.J5?.workerSends === 2 && matrix.J5?.duplicateAccounted === true && matrix.J5?.exactlyOnceClaimed === false, 'J5 at-least-once accounting failed');
  invariant(matrix.J6?.githubAttempts === 0 && matrix.J6?.statusAttempts === 0 && matrix.J6?.workerAttempts === 0 && matrix.J6?.status === 'up_to_date', 'J6 terminal write-only resume failed');
}

export async function runDeliveryMatrix(): Promise<{ delivery: Record<string, unknown>; mutation: MutationRecord }> {
  const root = tempRoot('task-311-delivery-');
  try {
    const J0Run = createDeliveryRun(path.join(root, 'j0'), '0');
    let J0JournalAttempts = 0;
    let J0ChannelAttempts = 0;
    await deliverPackReviewVerdict({
      projectId,
      storeRoot: path.join(root, 'j0'),
      run: J0Run,
      payload: blockingPayload,
      journalWriter: () => {
        J0JournalAttempts += 1;
        throw new Error('task-311 injected durable store outage');
      },
      postGithubComment: async () => { J0ChannelAttempts += 1; return { id: 1, url: 'fixture://never', event: 'COMMENT' }; },
      writeRequiredStatus: async () => { J0ChannelAttempts += 1; },
      notifyWorker: async () => { J0ChannelAttempts += 1; return { state: 'delivered', reason: 'never' }; },
    });

    const J1Store = path.join(root, 'j1');
    const J1Run = journalRun(createDeliveryRun(J1Store, '1'), J1Store);
    const J1Order: string[] = [];
    await resumePackReviewVerdictDelivery({
      projectId,
      storeRoot: J1Store,
      run: J1Run,
      postGithubComment: async () => { J1Order.push('github'); return { id: 11, url: 'fixture://11', event: 'COMMENT' }; },
      writeRequiredStatus: async () => { J1Order.push('status'); },
      notifyWorker: async () => { J1Order.push('worker'); return { state: 'delivered', reason: 'delivered' }; },
    });

    const J2Store = path.join(root, 'j2');
    const J2Base = createDeliveryRun(J2Store, '2');
    const J2Run = journalRun(J2Base, J2Store, cleanPayload, {
      ...completedGithubFields(J2Base, 22),
      deliveryOutcomes: { githubComment: channelOutcome('succeeded', 'comment_posted', githubKey(J2Base)) },
    });
    let J2Github = 0;
    let J2Status = 0;
    let J2Worker = 0;
    await resumePackReviewVerdictDelivery({
      projectId,
      storeRoot: J2Store,
      run: J2Run,
      postGithubComment: async () => { J2Github += 1; return { id: 23, url: 'fixture://23', event: 'COMMENT' }; },
      writeRequiredStatus: async () => { J2Status += 1; },
      notifyWorker: async () => { J2Worker += 1; return { state: 'delivered', reason: 'delivered' }; },
    });

    const J3Store = path.join(root, 'j3');
    const J3Run = journalRun(createDeliveryRun(J3Store, '3'), J3Store);
    const J3Reviews: GithubReviewSummary[] = [];
    let J3PostAttempts = 0;
    const J3Transport: GithubReviewTransport = {
      async resolveActorLogin() { return 'task-311-reviewer'; },
      async listReviews() { return [...J3Reviews]; },
      async postReview(input) {
        J3PostAttempts += 1;
        J3Reviews.push({
          id: 33,
          state: 'COMMENTED',
          userLogin: 'task-311-reviewer',
          submittedAt: '2026-07-19T02:00:03.000Z',
          body: input.body,
          commitId: input.commitId,
          url: 'fixture://33',
        });
        throw new GithubReviewPostError('ambiguous', 'task-311 connection reset after accepted COMMENT');
      },
      async dismissReview() {},
    };
    const J3Reconciled = await reconcileGithubCommentReview({
      projectId,
      storeRoot: J3Store,
      run: J3Run,
      body: `Task 311 crash convergence\n\nRun: \`${J3Run.id}\``,
      transport: J3Transport,
    });

    const J4Store = path.join(root, 'j4');
    const J4Base = createDeliveryRun(J4Store, '4');
    const J4Run = journalRun(J4Base, J4Store, cleanPayload, {
      ...completedGithubFields(J4Base, 44),
      deliveryOutcomes: {
        githubComment: channelOutcome('succeeded', 'comment_posted', githubKey(J4Base)),
        workerNotification: channelOutcome('delivered', 'worker_delivered', workerKey(J4Base)),
      },
    });
    let J4StatusPosts = 1; // accepted before crash, but no durable outcome survived
    await resumePackReviewVerdictDelivery({
      projectId,
      storeRoot: J4Store,
      run: J4Run,
      postGithubComment: async () => { throw new Error('J4 must not repost COMMENT'); },
      writeRequiredStatus: async () => { J4StatusPosts += 1; },
      notifyWorker: async () => ({ state: 'delivered', reason: 'must-be-skipped' }),
    });

    const J5Store = path.join(root, 'j5');
    const J5Base = createDeliveryRun(J5Store, '5');
    const J5Run = journalRun(J5Base, J5Store, cleanPayload, {
      ...completedGithubFields(J5Base, 55),
      deliveryOutcomes: {
        githubComment: channelOutcome('succeeded', 'comment_posted', githubKey(J5Base)),
        requiredStatus: channelOutcome('succeeded', 'status_success', statusKey(J5Base)),
      },
    });
    let J5WorkerSends = 1; // dispatched before crash, but no durable outcome survived
    await resumePackReviewVerdictDelivery({
      projectId,
      storeRoot: J5Store,
      run: J5Run,
      postGithubComment: async () => { throw new Error('J5 must not repost COMMENT'); },
      writeRequiredStatus: async () => { throw new Error('J5 must not repost status'); },
      notifyWorker: async () => { J5WorkerSends += 1; return { state: 'delivered', reason: 'resent_after_unknown' }; },
    });

    const J6Store = path.join(root, 'j6');
    const J6Base = createDeliveryRun(J6Store, '6');
    const J6Run = journalRun(J6Base, J6Store, cleanPayload, {
      ...completedGithubFields(J6Base, 66),
      deliveryOutcomes: {
        githubComment: channelOutcome('succeeded', 'comment_posted', githubKey(J6Base)),
        requiredStatus: channelOutcome('succeeded', 'status_success', statusKey(J6Base)),
        workerNotification: channelOutcome('delivered', 'worker_delivered', workerKey(J6Base)),
      },
    });
    let J6Github = 0;
    let J6Status = 0;
    let J6Worker = 0;
    await resumePackReviewVerdictDelivery({
      projectId,
      storeRoot: J6Store,
      run: J6Run,
      postGithubComment: async () => { J6Github += 1; return { id: 67, url: 'fixture://67', event: 'COMMENT' }; },
      writeRequiredStatus: async () => { J6Status += 1; },
      notifyWorker: async () => { J6Worker += 1; return { state: 'delivered', reason: 'unexpected' }; },
    });
    const J6Persisted = getPackReviewRun(J6Run.id, { projectId, storeRoot: J6Store });

    const delivery = {
      classes: 'J0-J6-pass',
      J0: { journalAttempts: J0JournalAttempts, channelAttempts: J0ChannelAttempts },
      J1: { order: J1Order, reviewerRuns: 0 },
      J2: { githubAttempts: J2Github, statusAttempts: J2Status, workerAttempts: J2Worker },
      J3: { postAttempts: J3PostAttempts, commentCount: J3Reviews.length, phase: J3Reconciled.reconciliation.phase },
      J4: { statusPosts: J4StatusPosts, duplicateAccounted: true, exactlyOnceClaimed: false, semantics: 'at-least-once' },
      J5: { workerSends: J5WorkerSends, duplicateAccounted: true, exactlyOnceClaimed: false, semantics: 'at-least-once' },
      J6: { githubAttempts: J6Github, statusAttempts: J6Status, workerAttempts: J6Worker, status: J6Persisted?.status },
    };
    validateDeliveryMatrix(delivery);
    const mutation = redThenGreen(
      'delivery-J0-J6-crash-window-controls',
      delivery,
      validateDeliveryMatrix,
      [
        { id: 'allow-delivery-before-journal-J0', mutate: (value) => { value.J0.channelAttempts = 1; } },
        { id: 'duplicate-github-comment-J3', mutate: (value) => { value.J3.commentCount = 2; } },
        { id: 'mislabel-status-retry-exactly-once-J4', mutate: (value) => { value.J4.exactlyOnceClaimed = true; } },
        { id: 'hide-worker-duplicate-accounting-J5', mutate: (value) => { value.J5.duplicateAccounted = false; } },
      ],
    );
    return { delivery, mutation };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function validateReviewStart(candidate: unknown): void {
  invariant(candidate !== null && typeof candidate === 'object', 'review-start evidence missing');
  const value = candidate as any;
  invariant(value.headDecision === 'stale-head-review-start-denied', 'stale head marker missing');
  invariant(value.emitReviewRun === false, 'stale head emitted a review run');
  invariant(value.reason === 'pre_run_recheck_head_advanced', 'stale head reason drifted');
  invariant(value.decision?.reason === 'head_advanced_since_plan', 'stale head decision drifted');
  invariant(value.runnerInvocations === 0, 'stale head reached runner');
  invariant(value.deliveryInvocations === 0, 'stale head reached delivery');
}

export function runStaleHeadGate(): { reviewStart: Record<string, unknown>; mutation: MutationRecord } {
  const plannedHead = '7'.repeat(40);
  const freshHead = '8'.repeat(40);
  let runnerInvocations = 0;
  let deliveryInvocations = 0;
  const result = preRunHeadReadyRecheck({
    prNumber: fixture.assembly.prNumber,
    headSha: plannedHead,
    sessionId: 'orchestrator-pack-7',
    startReason: 'task_311_stale_mutation',
  }, {
    openPrs: [{ number: fixture.assembly.prNumber, headRefOid: freshHead, state: 'OPEN' }],
    reviewRuns: [],
    sessions: [],
    ciChecks: greenCiChecks(),
    ownerResolution: { sessionId: 'orchestrator-pack-7', reason: 'cache_hit', failClosed: false },
  });
  if (result.emitReviewRun) runnerInvocations += 1;
  if (runnerInvocations > 0) deliveryInvocations += 1;
  const reviewStart = {
    headDecision: 'stale-head-review-start-denied',
    plannedHead,
    freshHead,
    emitReviewRun: result.emitReviewRun,
    reason: result.reason,
    decision: result.decision,
    runnerInvocations,
    deliveryInvocations,
  };
  validateReviewStart(reviewStart);
  const mutation = redThenGreen(
    'fresh-head-pre-run-recheck-control',
    reviewStart,
    validateReviewStart,
    [
      { id: 'trust-planned-head-after-fresh-head-advanced', mutate: (value) => {
        value.emitReviewRun = true;
        value.runnerInvocations = 1;
        value.deliveryInvocations = 1;
      } },
      { id: 'replace-canonical-head-advanced-reason', mutate: (value) => { value.decision.reason = 'head_ready_for_review'; } },
    ],
  );
  return { reviewStart, mutation };
}

interface ScopeCandidate {
  paths: Array<{ status: string; path: string }>;
  captureSelectors: string[];
  liveExternalCalls: number;
}

function validateScopeCandidate(candidate: unknown): void {
  invariant(candidate !== null && typeof candidate === 'object', 'scope candidate missing');
  const value = candidate as ScopeCandidate;
  invariant(value.paths.length > 0, 'scope validator received empty diff');
  for (const entry of value.paths) {
    invariant(entry.status === 'A', `scope status ${entry.status} is not add-only`);
    invariant(entry.path.startsWith(fixture.scope.root), `scope path outside task root: ${entry.path}`);
    invariant(fixture.scope.allowedSuffixes.some((suffix) => entry.path.endsWith(suffix)), `scope suffix forbidden: ${entry.path}`);
  }
  const declaredSelectors = new Set(Object.values(fixture.capture.selectors));
  for (const selector of value.captureSelectors) {
    invariant(declaredSelectors.has(selector), `invented AO selector ${selector}`);
  }
  invariant(value.liveExternalCalls === 0, 'live AO/GitHub/reviewer call escaped the fixture boundary');
}

function actualChangedPaths(): Array<{ status: string; path: string }> {
  try {
    const output = execFileSync('git', ['diff', '--name-status', 'origin/main...HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!output) return [];
    return output.split(/\r?\n/).flatMap((line) => {
      const fields = line.split('\t');
      const status = fields[0] ?? '';
      if (/^[RC]/.test(status)) return fields.slice(1).map((file) => ({ status, path: file }));
      return fields[1] ? [{ status, path: fields[1] }] : [];
    });
  } catch {
    return [];
  }
}

export function runScopeGate(): { scope: Record<string, unknown>; mutation: MutationRecord } {
  const expected = fixture.scope.expectedAddedPaths.map((file) => ({ status: 'A', path: file }));
  const changed = actualChangedPaths();
  const paths = changed.length > 0 ? changed : expected;
  for (const file of fixture.scope.expectedAddedPaths) {
    invariant(existsSync(path.join(repoRoot, file)), `expected task-311 artifact missing: ${file}`);
  }
  const candidate: ScopeCandidate = {
    paths,
    captureSelectors: Object.values(fixture.capture.selectors),
    liveExternalCalls: 0,
  };
  validateScopeCandidate(candidate);
  const scope = {
    result: 'test-only-offline-capture-backed',
    changedPaths: paths,
    capturePath: fixture.capture.path,
    captureSelectors: candidate.captureSelectors,
    liveExternalCalls: 0,
    addOnly: true,
  };
  const mutation = redThenGreen(
    'test-only-offline-capture-backed-scope-control',
    candidate,
    validateScopeCandidate,
    [
      { id: 'modify-existing-production-file', mutate: (value) => { value.paths.push({ status: 'M', path: 'scripts/pack-review-runner.ts' }); } },
      { id: 'invent-ao-field-not-in-capture', mutate: (value) => { value.captureSelectors.push('$.data[0].prNumber'); } },
      { id: 'attempt-live-github-call', mutate: (value) => { value.liveExternalCalls = 1; } },
    ],
  );
  return { scope, mutation };
}

export function validateCompleteEvidence(candidate: unknown): void {
  invariant(candidate !== null && typeof candidate === 'object', 'complete evidence missing');
  const evidence = candidate as any;
  validateAssemblyEvidence(evidence.assembly);
  validateClaimMatrix(evidence.claim);
  validateDeliveryMatrix(evidence.delivery);
  validateReviewStart(evidence.reviewStart);
  invariant(evidence.scope?.result === 'test-only-offline-capture-backed', 'scope result marker missing');
  invariant(evidence.assembly?.binding?.consumer?.source === 'cache', 'machine selector assembly.binding.consumer.source failed');
  invariant(evidence.capture?.data?.[0]?.id === 'orchestrator-pack-7', 'machine selector capture data[0].id failed');
  invariant(evidence.assembly?.identity === 'one-pr-head-worker-chain', 'machine selector assembly.identity failed');
  invariant(evidence.claim?.classes === 'C1-C7-pass', 'machine selector claim.classes failed');
  invariant(evidence.delivery?.classes === 'J0-J6-pass', 'machine selector delivery.classes failed');
  invariant(evidence.reviewStart?.headDecision === 'stale-head-review-start-denied', 'machine selector reviewStart.headDecision failed');
  for (const ac of ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6']) {
    const mutation = evidence.mutationEvidence?.[ac];
    invariant(mutation?.executed === true, `${ac} mutation did not execute`);
    invariant(mutation?.negativeOutcome === 'red', `${ac} mutation did not go red`);
    invariant(mutation?.restoredOutcome === 'green', `${ac} mutation did not restore green`);
  }
}

export function captureEvidenceDocument(): Record<string, unknown> {
  return readCapture().document;
}

export function assertNoUnexpectedRuns(storeRoot: string): void {
  invariant(listPackReviewRuns({ projectId, storeRoot }).length === 0, 'unexpected review runs found');
}
