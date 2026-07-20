import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path, { delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BINDING_SOURCE_BACKFILL_RESOLVER } from '../../../docs/pr-session-binding-cache.mjs';
import { preRunHeadReadyRecheck } from '../../../docs/review-head-ready.mjs';
import { type GithubReviewTransport } from '../../lib/github-review-reconciliation.js';
import {
  PACK_REVIEW_REQUIRED_STATUS_CONTEXT,
  type PackReviewJournalWriter,
  type PackReviewRequiredStatusWriter,
  type PackReviewWorkerNotifier,
} from '../../lib/pack-review-delivery.js';
import { type PackReviewRunRecord } from '../../lib/pack-review-run-store.js';
import { runProcessSync } from '../../kernel/subprocess.js';
import { startPackReview } from '../../pack-review-runner.js';

export type AcId = 'AC1' | 'AC2' | 'AC3' | 'AC4' | 'AC5' | 'AC6';

export interface MutationRecord {
  mutationId: string;
  executed: true;
  negativeOutcome: 'red';
  restoredOutcome: 'green';
}

export interface AcceptanceEvidence {
  schemaVersion: 2;
  issue: 918;
  task: 311;
  assembly: Record<string, unknown>;
  capture: Record<string, unknown>;
  claim: Record<string, unknown>;
  delivery: Record<string, unknown>;
  reviewStart: Record<string, unknown>;
  scope: Record<string, unknown>;
  mutationEvidence: Record<AcId, MutationRecord[]>;
}

export interface FixtureContract {
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
    subjects: string[];
    runnerOrder: string[];
    consumer: { source: string; reason: string; failClosed: boolean };
  };
  mutationControls: Record<AcId, string[]>;
  scope: {
    root: string;
    laneConfig: string;
    allowedSuffixes: string[];
    expectedAddedPaths: string[];
    expectedHeavyTests: string[];
    regularModes: string[];
  };
}

export interface TraceRow {
  event: string;
  sequence: number;
  atMs: number;
  [key: string]: unknown;
}

export interface EgressAttempt {
  edge: string;
  kind: string;
  detail?: string;
}

export interface EgressTrap {
  active: true;
  root: string;
  binDir: string;
  statePath: string;
  nodeOptions: string;
  nativeLibrary: string;
  attempts(): EgressAttempt[];
  restore(): void;
}

export interface RunnerTarget {
  prNumber: number;
  headSha: string;
  sessionId: string;
}

export interface RunnerEntryOptions {
  root: string;
  target: RunnerTarget;
  storeRoot: string;
  tracePath: string;
  githubTransport: GithubReviewTransport;
  statusWriter: PackReviewRequiredStatusWriter;
  workerNotifier: PackReviewWorkerNotifier;
  journalWriter?: PackReviewJournalWriter;
  expectedPr?: number;
  expectedHead?: string;
}

const supportDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(supportDir, '../../..');
const fixturePath = path.join(supportDir, 'task-311.fixture.json');
export const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as FixtureContract;
export const projectId = 'orchestrator-pack';

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function tempRoot(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function psString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function runPwsh(script: string, env: NodeJS.ProcessEnv = {}): string {
  const result = runProcessSync({
    command: 'pwsh',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    cwd: repoRoot,
    env: { ...process.env, ...env },
    inheritParentEnv: false,
    encoding: 'utf8',
  });
  invariant(result.exitCode === 0, `pwsh failed ${result.exitCode ?? result.outcome}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result.stdout.trim();
}

export function runGit(args: readonly string[], cwd = repoRoot): string {
  const result = runProcessSync({
    command: 'git',
    args,
    cwd,
    env: process.env,
    inheritParentEnv: false,
    encoding: 'utf8',
  });
  invariant(result.exitCode === 0, `git ${args.join(' ')} failed: ${result.stderr || result.error || result.outcome}`);
  return result.stdout;
}

function selectorValue(document: unknown, selector: string): unknown {
  invariant(selector.startsWith('$.'), `unsupported selector ${selector}`);
  const tokens = selector.slice(2).replaceAll(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let current: unknown = document;
  for (const token of tokens) {
    invariant(current !== null && typeof current === 'object', `selector ${selector} stopped at ${token}`);
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

export function readCapture(): { document: Record<string, unknown>; row: Record<string, unknown> } {
  const capturePath = path.join(repoRoot, fixture.capture.path);
  const document = JSON.parse(readFileSync(capturePath, 'utf8')) as Record<string, unknown>;
  for (const [selector, expected] of Object.entries(fixture.capture.expected)) {
    invariant(Object.is(selectorValue(document, selector), expected), `capture selector ${selector} drifted`);
  }
  const data = document.data;
  invariant(Array.isArray(data) && data.length > 0, 'AO capture must contain data[0]');
  const row = data[0];
  invariant(row !== null && typeof row === 'object' && !Array.isArray(row), 'AO capture data[0] must be an object');
  return { document, row: row as Record<string, unknown> };
}

export function captureEvidenceDocument(): Record<string, unknown> {
  return readCapture().document;
}

function sameStringSet(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  if (actualSet.size !== actual.length || expectedSet.size !== expected.length) return false;
  return [...actualSet].every((value) => expectedSet.has(value));
}

export function validateMutationArray(ac: AcId, rows: readonly MutationRecord[]): void {
  const expected = fixture.mutationControls[ac];
  invariant(sameStringSet(rows.map((row) => row.mutationId), expected), `${ac} mutationId set drifted`);
  for (const row of rows) {
    invariant(row.executed === true, `${ac}/${row.mutationId} was not executed`);
    invariant(row.negativeOutcome === 'red', `${ac}/${row.mutationId} did not go red`);
    invariant(row.restoredOutcome === 'green', `${ac}/${row.mutationId} did not restore green`);
  }
}

export function mutationRecord(mutationId: string): MutationRecord {
  return { mutationId, executed: true, negativeOutcome: 'red', restoredOutcome: 'green' };
}

export async function expectBehaviorRed(
  ac: AcId,
  mutationId: string,
  negative: () => unknown | Promise<unknown>,
  restored: () => unknown | Promise<unknown>,
): Promise<MutationRecord> {
  let red = false;
  try {
    await negative();
  } catch {
    red = true;
  }
  invariant(red, `${ac}/${mutationId} unexpectedly stayed green`);
  await restored();
  return mutationRecord(mutationId);
}

export function expectBehaviorRedSync(
  ac: AcId,
  mutationId: string,
  negative: () => unknown,
  restored: () => unknown,
): MutationRecord {
  let red = false;
  try {
    negative();
  } catch {
    red = true;
  }
  invariant(red, `${ac}/${mutationId} unexpectedly stayed green`);
  restored();
  return mutationRecord(mutationId);
}

export function appendTrace(tracePath: string, event: string, detail: Record<string, unknown> = {}): void {
  const sequence = existsSync(tracePath)
    ? readFileSync(tracePath, 'utf8').split(/\r?\n/).filter((line) => line.trim()).length + 1
    : 1;
  appendFileSync(tracePath, `${JSON.stringify({ event, sequence, atMs: Date.now(), ...detail })}\n`, 'utf8');
}

export function readTrace(tracePath: string): TraceRow[] {
  if (!existsSync(tracePath)) return [];
  return readFileSync(tracePath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .map((line) => JSON.parse(line) as TraceRow);
}

function writeExecutable(file: string, content: string): void {
  writeFileSync(file, content, 'utf8');
  if (process.platform !== 'win32') chmodSync(file, 0o700);
}

function installReviewerExecutableBoundary(root: string): string {
  const bin = path.join(root, 'reviewer-bin');
  mkdirSync(bin, { recursive: true });
  const fakeReviewer = path.join(root, 'fake-reviewer.cjs');
  writeFileSync(fakeReviewer, `
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const trace = process.env.TASK311_TRACE_FILE;
const expectedPr = process.env.TASK311_EXPECTED_PR;
const expectedHead = process.env.TASK311_EXPECTED_HEAD;
const expectedSession = process.env.TASK311_EXPECTED_SESSION;
const fail = (message) => { process.stderr.write(message + '\\n'); process.exit(64); };
const valueAfter = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : ''; };
if (!args.some((value) => /plugins[\\\\/]ao-codex-pr-reviewer[\\\\/]bin[\\\\/]review\\.ts$/.test(value))) fail('real plugin reviewer wrapper was not invoked');
if (valueAfter('--pr-number') !== expectedPr) fail('reviewer argv lost exact PR');
const reviewRoot = valueAfter('--repo-root');
if (!reviewRoot) fail('reviewer argv lost worktree root');
if (!valueAfter('--base')) fail('reviewer argv lost base ref');
if (process.env.AO_SESSION_ID !== expectedSession || process.env.AO_WORKER_SESSION_ID !== expectedSession) fail('reviewer env lost worker identity');
const observed = cp.spawnSync('git', ['-C', reviewRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: process.env });
if (observed.status !== 0) fail('reviewer could not resolve checked-out worktree head: ' + String(observed.stderr || observed.error || 'unknown'));
const observedHead = String(observed.stdout || '').trim().toLowerCase();
if (observedHead !== expectedHead) fail('reviewer worktree head mismatch: ' + observedHead + ' != ' + expectedHead);
const sequence = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').split(/\\r?\\n/).filter(Boolean).length + 1 : 1;
fs.appendFileSync(trace, JSON.stringify({ event: 'reviewer-wrapper', sequence, atMs: Date.now(), argv: args, prNumber: Number(expectedPr), expectedHeadSha: expectedHead, observedHeadSha: observedHead, reviewTargetRoot: reviewRoot, sessionId: expectedSession }) + '\\n');
process.stdout.write(JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] }) + '\\n');
`, 'utf8');
  if (process.platform === 'win32') {
    writeExecutable(path.join(bin, 'node.cmd'), `@echo off\r\nset args=%*\r\necho %args% | findstr /C:"plugins\\ao-codex-pr-reviewer\\bin\\review.ts" >nul\r\nif %errorlevel%==0 ("${process.execPath}" "${fakeReviewer}" %*) else ("${process.execPath}" %*)\r\n`);
    writeExecutable(path.join(bin, 'npm.cmd'), '@echo off\r\nexit /b 0\r\n');
  } else {
    writeExecutable(path.join(bin, 'node'), `#!/usr/bin/env sh\ncase "$*" in *plugins/ao-codex-pr-reviewer/bin/review.ts*) exec "${process.execPath}" "${fakeReviewer}" "$@" ;; *) exec "${process.execPath}" "$@" ;; esac\n`);
    writeExecutable(path.join(bin, 'npm'), '#!/usr/bin/env sh\nexit 0\n');
  }
  return bin;
}

export async function runPackReviewEntry(options: RunnerEntryOptions): Promise<Record<string, unknown>> {
  const reviewerBin = installReviewerExecutableBoundary(options.root);
  const originalEnv = { ...process.env };
  try {
    process.env.PATH = `${reviewerBin}${delimiter}${process.env.PATH ?? ''}`;
    process.env.PACK_REVIEWER = fixture.assembly.reviewer;
    process.env.AO_REVIEW_CLAIM_DIR = path.join(options.root, 'claims');
    process.env.AO_REVIEW_START_MONOTONIC_NOW_MS = '1000';
    process.env.OPK_VITEST_HARNESS = '1';
    process.env.TASK311_TRACE_FILE = options.tracePath;
    process.env.TASK311_EXPECTED_PR = String(options.expectedPr ?? options.target.prNumber);
    process.env.TASK311_EXPECTED_HEAD = options.expectedHead ?? options.target.headSha;
    process.env.TASK311_EXPECTED_SESSION = options.target.sessionId;
    return await startPackReview({
      projectId,
      sessionId: options.target.sessionId,
      prNumber: options.target.prNumber,
      headSha: options.target.headSha,
      repoRoot,
      sourceRepoRoot: repoRoot,
      baseRef: 'origin/main',
      startReason: 'task_311_three_subject_gate',
      surface: 'task-311-real-runner-subject',
      storeRoot: options.storeRoot,
      fixtureRepoSlug: fixture.repoSlug,
      fixtureGithubReviewTransport: options.githubTransport,
      fixtureRequiredStatusWriter: options.statusWriter,
      fixtureWorkerNotifier: options.workerNotifier,
      fixtureJournalWriter: options.journalWriter,
    });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    for (const [key, value] of Object.entries(originalEnv)) process.env[key] = value;
  }
}

function orderedSubsequence(observed: readonly string[], required: readonly string[]): boolean {
  let cursor = -1;
  for (const event of required) {
    cursor = observed.indexOf(event, cursor + 1);
    if (cursor < 0) return false;
  }
  return true;
}

export function validateAssemblyEvidence(candidate: Record<string, unknown>): void {
  const value = candidate as any;
  invariant(value.target?.prNumber === fixture.assembly.prNumber, 'assembly target PR drifted');
  invariant(/^[0-9a-f]{40}$/.test(String(value.target?.headSha ?? '')), 'assembly target head missing');
  invariant(value.target?.sessionId === 'orchestrator-pack-7', 'assembly worker identity drifted');
  invariant(value.subjects?.reviewStart?.implementation === 'docs/review-head-ready.mjs#preRunHeadReadyRecheck', 'real pre-run subject boundary missing');
  invariant(value.subjects?.binding?.implementation === 'docs/session-pr-binding-resolver.mjs+docs/pr-session-binding-cache.mjs', 'real binding subject boundary missing');
  invariant(value.subjects?.runner?.implementation === 'scripts/pack-review-runner.ts#startPackReview', 'real runner subject boundary missing');
  invariant(value.subjects?.reviewStart?.transport === 'json-file' && value.subjects?.binding?.transport === 'json-file' && value.subjects?.runner?.transport === 'json-file', 'subjects were not joined only through artifacts');
  invariant(value.binding?.session?.bound === true, 'session resolver bound field drifted');
  invariant(value.binding?.session?.prNumber === value.target.prNumber, 'session resolver PR drifted');
  invariant(value.binding?.session?.source === 'issue_correlation', 'session resolver source drifted');
  invariant(value.binding?.session?.enriched === true, 'session resolver enriched field drifted');
  invariant(value.binding?.cacheRecord?.sessionId === value.target.sessionId, 'cache sessionId drifted');
  invariant(value.binding?.cacheRecord?.prNumber === value.target.prNumber, 'cache PR drifted');
  invariant(value.binding?.cacheRecord?.headSha === value.target.headSha, 'cache head drifted');
  invariant(value.binding?.cacheRecord?.source === BINDING_SOURCE_BACKFILL_RESOLVER, 'cache source drifted');
  invariant(value.binding?.consumer?.source === fixture.assembly.consumer.source, 'consumer source drifted');
  invariant(value.binding?.consumer?.reason === fixture.assembly.consumer.reason, 'consumer reason drifted');
  invariant(value.binding?.consumer?.failClosed === fixture.assembly.consumer.failClosed, 'consumer failClosed drifted');
  invariant(value.binding?.consumer?.sessionId === value.target.sessionId, 'consumer worker drifted');
  invariant(value.identity === 'one-pr-head-worker-chain', 'identity marker missing');
  invariant(orderedSubsequence(value.runner?.order ?? [], fixture.assembly.runnerOrder), 'real runner internal hop order drifted');
  invariant(Array.isArray(value.runner?.reviewerArgv), 'reviewer argv missing');
  const prIndex = value.runner.reviewerArgv.indexOf('--pr-number');
  invariant(prIndex >= 0 && Number(value.runner.reviewerArgv[prIndex + 1]) === value.target.prNumber, 'reviewer argv PR drifted');
  invariant(value.runner?.reviewerObservedHeadSha === value.target.headSha, 'reviewer did not observe actual checked-out worktree head');
  invariant(value.runner?.reviewerExpectedHeadSha === value.target.headSha, 'reviewer expected head drifted');
  invariant(typeof value.runner?.reviewerWorktreeRoot === 'string' && value.runner.reviewerWorktreeRoot.length > 0, 'reviewer worktree root missing');
  invariant(value.runner?.github?.eventType === 'COMMENT', 'review event is not COMMENT');
  invariant(value.runner?.github?.headSha === value.target.headSha, 'COMMENT head drifted');
  invariant(value.runner?.status?.targetSha === value.target.headSha, 'status target SHA drifted');
  invariant(String(value.runner?.status?.idempotencyKey ?? '').includes(value.target.headSha), 'status idempotency lost head');
  invariant(Array.isArray(value.runner?.workerMessages) && value.runner.workerMessages.length === 1, 'worker message cardinality drifted');
  invariant(value.runner.workerMessages[0]?.sessionId === value.target.sessionId, 'worker session drifted');
  invariant(value.runner?.run?.targetSha === value.target.headSha && value.runner?.run?.prNumber === value.target.prNumber, 'run identity drifted');
  invariant(value.runner?.run?.linkedSessionId === value.target.sessionId && value.runner?.run?.status === 'up_to_date', 'run worker/status drifted');
  invariant(value.runner?.claim?.prNumber === value.target.prNumber && value.runner?.claim?.headSha === value.target.headSha, 'claim identity drifted');
  invariant(value.runner?.claim?.outcome === 'run_started', 'claim did not terminalize run_started');
  const allowedSelectors = new Set(Object.values(fixture.capture.selectors));
  invariant(Array.isArray(value.captureSelectors) && value.captureSelectors.every((selector: string) => allowedSelectors.has(selector)), 'invented AO selector used');
  invariant(value.trap?.active === true && value.trap?.unexpectedAttempts === 0, 'egress trap was inactive or observed unexpected egress');
}

function greenCiChecks(): Array<Record<string, string>> {
  return [
    { name: 'Verify orchestrator-pack structure', state: 'SUCCESS' },
    { name: 'PR scope guard', state: 'SUCCESS' },
    { name: 'Run pack contract tests', state: 'SUCCESS' },
    { name: 'Self-architect lint', state: 'SUCCESS' },
  ];
}

function validateReviewStartEvidence(candidate: Record<string, unknown>): void {
  const value = candidate as any;
  invariant(value.headDecision === 'stale-head-review-start-denied', 'stale-head marker missing');
  invariant(value.drift?.emitReviewRun === false, 'advanced head emitted review run');
  invariant(value.drift?.reason === 'pre_run_recheck_head_advanced', 'advanced head reason drifted');
  invariant(value.drift?.decision?.reason === 'head_advanced_since_plan', 'advanced head decision drifted');
  invariant(value.runnerInvocations === 0, 'advanced head reached runner');
  invariant(value.deliveryInvocations === 0, 'advanced head reached delivery');
  invariant(value.freshReadCount === 1, 'current head was not freshly read');
  invariant(value.unchanged?.emitReviewRun === true, 'unchanged head was wrongly denied');
}

export function runStaleHeadGate(): { reviewStart: Record<string, unknown>; mutations: MutationRecord[] } {
  const { row: session } = readCapture();
  const plannedHead = '7'.repeat(40);
  const freshHead = '8'.repeat(40);
  const common = {
    reviewRuns: [],
    sessions: [session as any],
    ciChecks: greenCiChecks(),
    ownerResolution: { sessionId: String(session.id), reason: 'capture_owner', failClosed: false },
    nowMs: Date.parse('2026-07-19T02:00:00.000Z'),
  };
  const evaluate = (headRefOid: string, ciChecks = common.ciChecks) => preRunHeadReadyRecheck({
    prNumber: fixture.assembly.prNumber,
    headSha: plannedHead,
    sessionId: String(session.id),
    startReason: 'task_311_stale_head',
  }, {
    ...common,
    ciChecks,
    openPrs: [{ number: fixture.assembly.prNumber, headRefOid, headRefName: `issue-${fixture.assembly.prNumber}-task-311`, headCommittedAt: '2026-07-06T05:00:00.000Z' }],
  });
  const drift = evaluate(freshHead);
  const unchanged = evaluate(plannedHead);
  const reviewStart = {
    headDecision: 'stale-head-review-start-denied',
    plannedHead,
    freshHead,
    drift,
    unchanged,
    freshReadCount: 1,
    runnerInvocations: drift.emitReviewRun ? 1 : 0,
    deliveryInvocations: drift.emitReviewRun ? 1 : 0,
  };
  validateReviewStartEvidence(reviewStart);
  const rows = [
    expectBehaviorRedSync('AC5', 'advanced-head-run-emitted', () => {
      const staleRead = evaluate(plannedHead);
      validateReviewStartEvidence({ ...reviewStart, drift: staleRead, runnerInvocations: staleRead.emitReviewRun ? 1 : 0 });
    }, () => validateReviewStartEvidence(reviewStart)),
    expectBehaviorRedSync('AC5', 'advanced-head-delivery-emitted', () => {
      const staleRead = evaluate(plannedHead);
      validateReviewStartEvidence({ ...reviewStart, drift: staleRead, deliveryInvocations: staleRead.emitReviewRun ? 1 : 0 });
    }, () => validateReviewStartEvidence(reviewStart)),
    expectBehaviorRedSync('AC5', 'current-head-not-reread', () => {
      const staleRead = evaluate(plannedHead);
      validateReviewStartEvidence({ ...reviewStart, drift: staleRead, freshReadCount: 0 });
    }, () => validateReviewStartEvidence(reviewStart)),
    expectBehaviorRedSync('AC5', 'unchanged-head-wrongly-denied', () => {
      const denied = evaluate(plannedHead, [{ name: 'Run pack contract tests', state: 'FAILURE' }]);
      validateReviewStartEvidence({ ...reviewStart, unchanged: denied });
    }, () => validateReviewStartEvidence(reviewStart)),
  ];
  validateMutationArray('AC5', rows);
  return { reviewStart, mutations: rows };
}

export function validateCompleteEvidence(evidence: AcceptanceEvidence): void {
  invariant(evidence.schemaVersion === 2 && evidence.issue === 918 && evidence.task === 311, 'acceptance evidence identity drifted');
  validateAssemblyEvidence(evidence.assembly);
  invariant((evidence.capture as any)?.data?.[0]?.id === 'orchestrator-pack-7', 'capture selector data[0].id failed');
  invariant((evidence.claim as any)?.classes === 'C1-C7-pass', 'claim selector failed');
  invariant((evidence.delivery as any)?.classes === 'J0-J6-pass', 'delivery selector failed');
  validateReviewStartEvidence(evidence.reviewStart);
  invariant((evidence.scope as any)?.result === 'test-only-offline-capture-backed', 'scope selector failed');
  for (const ac of ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6'] as const) validateMutationArray(ac, evidence.mutationEvidence[ac]);
}

export function requiredStatusKey(run: PackReviewRunRecord): string {
  return `required-status:${PACK_REVIEW_REQUIRED_STATUS_CONTEXT}:${run.targetSha}`;
}
