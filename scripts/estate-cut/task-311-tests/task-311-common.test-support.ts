import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path, { delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BINDING_SOURCE_BACKFILL_RESOLVER } from '../../../docs/pr-session-binding-cache.mjs';
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

interface TriggerBoundaryScenario {
  name: string;
  result: { started?: boolean; reason?: string };
  observedRecheck: Record<string, unknown>;
  freshReadCount: number;
  runnerInvocations: number;
  deliveryInvocations: number;
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

export function greenCiChecks(): Array<Record<string, string>> {
  return [
    { name: 'Verify orchestrator-pack structure', state: 'SUCCESS' },
    { name: 'PR scope guard', state: 'SUCCESS' },
    { name: 'Run pack contract tests', state: 'SUCCESS' },
    { name: 'Self-architect lint', state: 'SUCCESS' },
  ];
}

function runTriggerBoundaryScenario(name: string): TriggerBoundaryScenario {
  const root = tempRoot('task-311-ac5-boundary-');
  const scriptPath = path.join(root, 'scenario.ps1');
  const sourcePath = path.join(repoRoot, 'scripts/review-trigger-reconcile.ps1');
  const capturePath = path.join(repoRoot, fixture.capture.path);
  const reconcileCli = path.join(repoRoot, 'docs/review-trigger-reconcile.mjs');
  const plannedHead = '7'.repeat(40);
  const freshHead = '8'.repeat(40);
  const script = `
$ErrorActionPreference = 'Stop'
$SourcePath = ${psString(sourcePath)}
$CapturePath = ${psString(capturePath)}
$ReconcileCli = ${psString(reconcileCli)}
$ScenarioName = ${psString(name)}
$PrNumber = ${fixture.assembly.prNumber}
$PlannedHead = ${psString(plannedHead)}
$AdvancedHead = ${psString(freshHead)}
$Session = (Get-Content -LiteralPath $CapturePath -Raw | ConvertFrom-Json).data[0]

$source = Get-Content -LiteralPath $SourcePath -Raw
$marker = '$intervalMinutes = Get-ReconcileIntervalMinutes'
$markerIndex = $source.IndexOf($marker)
if ($markerIndex -lt 0) { throw 'review-trigger-reconcile main marker missing' }
$prefix = $source.Substring(0, $markerIndex)
$prefix = [regex]::Replace($prefix, '^#requires[^\r\n]*\r?\n', '')
$scriptsRoot = Split-Path -Parent $SourcePath
$escapedScriptsRoot = $scriptsRoot.Replace("'", "''")
$prefix = $prefix.Replace('$PSScriptRoot', "'$escapedScriptsRoot'")
. ([scriptblock]::Create($prefix))

$script:FreshReadCount = 0
$script:RunnerInvocations = 0
$script:DeliveryInvocations = 0
$script:ObservedRecheck = $null
$script:FreshHead = $AdvancedHead
$script:ForceAllowDrift = $false
$script:EmitDelivery = $true
$script:UseFixtureSnapshot = $false
$script:CiGreen = $true

switch ($ScenarioName) {
  'baseline-drift' { }
  'baseline-unchanged' { $script:FreshHead = $PlannedHead }
  'fault-run-after-drift' { $script:ForceAllowDrift = $true; $script:EmitDelivery = $false }
  'fault-delivery-after-drift' { $script:ForceAllowDrift = $true; $script:EmitDelivery = $true }
  'fault-no-reread' { $script:FreshHead = $PlannedHead; $script:UseFixtureSnapshot = $true }
  'fault-deny-unchanged' { $script:FreshHead = $PlannedHead; $script:CiGreen = $false }
  default { throw "unknown TASK-311 AC5 scenario: $ScenarioName" }
}

function New-Task311Snapshot {
  param([string]$Head, [bool]$ChecksGreen)
  $checks = @(
    @{ name = 'Verify orchestrator-pack structure'; state = 'SUCCESS' },
    @{ name = 'PR scope guard'; state = 'SUCCESS' },
    @{ name = 'Run pack contract tests'; state = $(if ($ChecksGreen) { 'SUCCESS' } else { 'FAILURE' }) },
    @{ name = 'Self-architect lint'; state = 'SUCCESS' }
  )
  $key = [string]$PrNumber
  $ciChecksByPr = @{}
  $ciChecksByPr[$key] = $checks
  $requiredNamesByPr = @{}
  $requiredNamesByPr[$key] = @($checks | ForEach-Object { [string]$_.name })
  $lookupFailedByPr = @{}
  $lookupFailedByPr[$key] = $false
  $sessionDetails = @{}
  $sessionDetails[[string]$Session.id] = $Session
  return @{
    openPrs = @(@{ number = $PrNumber; headRefOid = $Head; headRefName = "issue-$PrNumber-task-311"; headCommittedAt = '2026-07-06T05:00:00.000Z' })
    reviewRuns = @()
    sessions = @($Session)
    sessionDetailsById = $sessionDetails
    ciChecksByPr = $ciChecksByPr
    requiredCheckNamesByPr = $requiredNamesByPr
    requiredCheckLookupFailedByPr = $lookupFailedByPr
    aoEvents = @()
    dispatchJournal = @{}
    workerDeliveries = @()
    reactionMessages = @{}
    reactionConfigUnavailable = $false
    cycleState = @{}
    sharedCycleState = @{}
    legacyNudged = @{}
    repoRoot = $RepoRoot
  }
}

function Get-PreRunRecheckSnapshot {
  param([int]$PrNumber, [string]$Project, [string]$ConfigYaml = '', [hashtable]$ClaimResult = $null)
  $script:FreshReadCount++
  return New-Task311Snapshot -Head $script:FreshHead -ChecksGreen $script:CiGreen
}

function Invoke-ReconcileFilterCli {
  param([string]$Subcommand, [hashtable]$Payload)
  if ($Subcommand -ne 'preRunRecheck') { throw "unexpected TASK-311 filter command: $Subcommand" }
  $json = $Payload | ConvertTo-Json -Compress -Depth 30
  $output = $json | & node $ReconcileCli $Subcommand 2>&1
  if ($LASTEXITCODE -ne 0) { throw "real preRunRecheck CLI failed: $(@($output) -join ' ')" }
  $observed = (@($output) -join [Environment]::NewLine) | ConvertFrom-Json
  $script:ObservedRecheck = $observed
  if ($script:ForceAllowDrift -and -not [bool]$observed.emitReviewRun) {
    return [pscustomobject]@{ emitReviewRun = $true; reason = 'task311_fault_force_allow'; decision = $observed.decision }
  }
  return $observed
}

function Get-ReviewTriggerInvocationLine { param([string]$SessionId); return "ao-review run --session $SessionId" }
function Test-ReviewMechanicalForbiddenCommand { param([string]$CommandLine) }
function Get-AoReviewRuns { param([string]$Project); return @() }
function Acquire-ReviewStartClaim {
  param([int]$PrNumber, [string]$HeadSha, [string]$Surface, [array]$ReviewRuns, [string]$ProjectId, [string]$StartReason, [scriptblock]$LogWriter)
  return @{ acquired = $true; key = "pr-$PrNumber-$HeadSha"; claimId = 'task311-claim'; holder = @{} }
}
function Complete-ReviewStartClaimPreRunRecheckDenied { param($ClaimResult, $Recheck, [array]$ReviewRuns); return @{ ok = $true } }
function Complete-ReviewStartClaim { param($ClaimResult, [string]$Outcome, [array]$ReviewRuns, [hashtable]$Extra); return @{ ok = $true } }
function Release-ReviewStartClaimAfterRunFailure { param($ClaimResult, [array]$ReviewRuns, [string]$Failure); return @{ ok = $true } }
function Complete-ReviewStartClaimAfterRunInvoke { param($ClaimResult, [array]$ReviewRuns, [scriptblock]$ResolveReviewRuns, [scriptblock]$LogWriter); return @{ ok = $true } }
function Confirm-ReviewStartClaimLaunchGate { param($ClaimResult, [array]$ReviewRuns, [string]$DecisionSource, [scriptblock]$LogWriter); return @{ ok = $true } }
function Invoke-ReviewerWorkspacePreflight { param([string]$RepoRoot) }
function Get-OrchestratorSideEffectLockPath { param([string]$LockFileName); return (Join-Path ([System.IO.Path]::GetTempPath()) $LockFileName) }
function Write-OrchestratorSideProcessProgress { param([string]$ChildId, [string]$Phase) }
function Write-ReconcileLog { param([string]$Message) }
function Invoke-OrchestratorSideEffectFenced {
  param([string]$LockPath, [scriptblock]$Action)
  & $Action
  return @{ ok = $true }
}
function Invoke-Task311ObservedDelivery { $script:DeliveryInvocations++ }
function Invoke-AoReviewTriggerForWorker {
  param([string]$SessionId)
  $script:RunnerInvocations++
  if ($script:EmitDelivery) { Invoke-Task311ObservedDelivery }
  return @{ ok = $true; httpStatus = 200 }
}

$fixtureSnapshot = $null
if ($script:UseFixtureSnapshot) {
  $fixtureSnapshot = New-Task311Snapshot -Head $PlannedHead -ChecksGreen $script:CiGreen
}
$result = Invoke-PlannedReviewRun -SessionId ([string]$Session.id) -ReviewCommand 'task311-real-trigger-boundary' \`
  -PrNumber $PrNumber -HeadSha $PlannedHead -Project 'orchestrator-pack' -FixtureSnapshot $fixtureSnapshot \`
  -TrackingState @{} -StartReason 'task_311_ac5_boundary'

[ordered]@{
  name = $ScenarioName
  result = $result
  observedRecheck = $script:ObservedRecheck
  freshReadCount = $script:FreshReadCount
  runnerInvocations = $script:RunnerInvocations
  deliveryInvocations = $script:DeliveryInvocations
} | ConvertTo-Json -Compress -Depth 20
`;
  writeFileSync(scriptPath, script, 'utf8');
  try {
    const result = runProcessSync({
      command: 'pwsh',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      cwd: repoRoot,
      env: process.env,
      inheritParentEnv: false,
      encoding: 'utf8',
    });
    invariant(result.exitCode === 0, `TASK-311 AC5 boundary scenario ${name} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
    const jsonLine = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
    invariant(jsonLine, `TASK-311 AC5 boundary scenario ${name} produced no JSON`);
    return JSON.parse(jsonLine) as TriggerBoundaryScenario;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function validateDriftBoundaryScenario(candidate: TriggerBoundaryScenario): void {
  const drift = candidate.observedRecheck as any;
  invariant(drift?.emitReviewRun === false, 'advanced head emitted review run');
  invariant(drift?.reason === 'pre_run_recheck_head_advanced', 'advanced head reason drifted');
  invariant(drift?.decision?.reason === 'head_advanced_since_plan', 'advanced head decision drifted');
  invariant(candidate.freshReadCount === 1, 'current head was not freshly read at the trigger boundary');
  invariant(candidate.runnerInvocations === 0, 'advanced head reached the real review-trigger seam');
  invariant(candidate.deliveryInvocations === 0, 'advanced head reached the observed delivery seam');
  invariant(candidate.result.started === false && candidate.result.reason === 'pre_run_recheck_head_advanced', 'trigger boundary did not abort the drifted head');
}

function validateUnchangedBoundaryScenario(candidate: TriggerBoundaryScenario): void {
  const unchanged = candidate.observedRecheck as any;
  invariant(unchanged?.emitReviewRun === true, 'unchanged head was wrongly denied');
  invariant(candidate.freshReadCount === 1, 'unchanged-head path did not refresh current PR state');
  invariant(candidate.runnerInvocations === 1, 'unchanged-head path did not cross the real review-trigger seam exactly once');
  invariant(candidate.deliveryInvocations === 1, 'unchanged-head path did not reach the observed delivery seam exactly once');
  invariant(candidate.result.started === true, 'unchanged-head trigger boundary did not start review');
}

function executeAc5Mutation(
  mutationId: string,
  negativeScenario: string,
  validateNegative: (scenario: TriggerBoundaryScenario) => void,
  restoredScenario: string,
  validateRestored: (scenario: TriggerBoundaryScenario) => void,
): MutationRecord {
  const negative = runTriggerBoundaryScenario(negativeScenario);
  let red = false;
  try {
    validateNegative(negative);
  } catch {
    red = true;
  }
  invariant(red, `AC5/${mutationId} actual trigger-boundary mutation unexpectedly stayed green`);
  validateRestored(runTriggerBoundaryScenario(restoredScenario));
  return mutationRecord(mutationId);
}

function validateReviewStartEvidence(candidate: Record<string, unknown>): void {
  const value = candidate as any;
  invariant(value.headDecision === 'stale-head-review-start-denied', 'stale-head marker missing');
  invariant(value.triggerBoundary === 'scripts/review-trigger-reconcile.ps1#Invoke-PlannedReviewRun', 'real review-trigger boundary evidence missing');
  validateDriftBoundaryScenario({
    name: 'evidence-drift',
    result: value.driftResult,
    observedRecheck: value.drift,
    freshReadCount: value.freshReadCount,
    runnerInvocations: value.runnerInvocations,
    deliveryInvocations: value.deliveryInvocations,
  });
  validateUnchangedBoundaryScenario({
    name: 'evidence-unchanged',
    result: value.unchangedResult,
    observedRecheck: value.unchanged,
    freshReadCount: value.unchangedFreshReadCount,
    runnerInvocations: value.unchangedRunnerInvocations,
    deliveryInvocations: value.unchangedDeliveryInvocations,
  });
}

export function runStaleHeadGate(): { reviewStart: Record<string, unknown>; mutations: MutationRecord[] } {
  const plannedHead = '7'.repeat(40);
  const freshHead = '8'.repeat(40);
  const drift = runTriggerBoundaryScenario('baseline-drift');
  const unchanged = runTriggerBoundaryScenario('baseline-unchanged');
  validateDriftBoundaryScenario(drift);
  validateUnchangedBoundaryScenario(unchanged);

  const reviewStart = {
    headDecision: 'stale-head-review-start-denied',
    triggerBoundary: 'scripts/review-trigger-reconcile.ps1#Invoke-PlannedReviewRun',
    plannedHead,
    freshHead,
    drift: drift.observedRecheck,
    driftResult: drift.result,
    freshReadCount: drift.freshReadCount,
    runnerInvocations: drift.runnerInvocations,
    deliveryInvocations: drift.deliveryInvocations,
    unchanged: unchanged.observedRecheck,
    unchangedResult: unchanged.result,
    unchangedFreshReadCount: unchanged.freshReadCount,
    unchangedRunnerInvocations: unchanged.runnerInvocations,
    unchangedDeliveryInvocations: unchanged.deliveryInvocations,
  };
  validateReviewStartEvidence(reviewStart);

  const rows = [
    executeAc5Mutation(
      'advanced-head-run-emitted',
      'fault-run-after-drift',
      validateDriftBoundaryScenario,
      'baseline-drift',
      validateDriftBoundaryScenario,
    ),
    executeAc5Mutation(
      'advanced-head-delivery-emitted',
      'fault-delivery-after-drift',
      validateDriftBoundaryScenario,
      'baseline-drift',
      validateDriftBoundaryScenario,
    ),
    executeAc5Mutation(
      'current-head-not-reread',
      'fault-no-reread',
      validateDriftBoundaryScenario,
      'baseline-drift',
      validateDriftBoundaryScenario,
    ),
    executeAc5Mutation(
      'unchanged-head-wrongly-denied',
      'fault-deny-unchanged',
      validateUnchangedBoundaryScenario,
      'baseline-unchanged',
      validateUnchangedBoundaryScenario,
    ),
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
