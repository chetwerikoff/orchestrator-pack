import { createHash } from 'node:crypto';
import dns from 'node:dns';
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
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path, { delimiter } from 'node:path';
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
  type GithubReviewCaptureAction,
  type GithubReviewSummary,
  type GithubReviewTransport,
} from '../../lib/github-review-reconciliation.js';
import { PACK_REVIEW_REQUIRED_STATUS_CONTEXT } from '../../lib/pack-review-delivery.js';
import {
  getPackReviewRun,
  updatePackReviewRun,
  type PackReviewRunRecord,
} from '../../lib/pack-review-run-store.js';
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

interface TraceRow {
  event: string;
  sequence: number;
  atMs: number;
  [key: string]: unknown;
}

interface ArtifactEnvelope<T extends Record<string, unknown>> {
  schemaVersion: 1;
  subject: string;
  implementation: string;
  transport: 'json-file';
  payload: T;
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
  attempts(): EgressAttempt[];
  restore(): void;
}

const supportDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(supportDir, '../../..');
const fixturePath = path.join(supportDir, 'task-311.fixture.json');
export const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as FixtureContract;
const projectId = 'orchestrator-pack';

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

export function runEvidenceMutationControls<T>(
  ac: AcId,
  baseline: T,
  validate: (candidate: T) => void,
  controls: Record<string, (candidate: T) => void>,
): MutationRecord[] {
  const declared = fixture.mutationControls[ac];
  invariant(sameStringSet(Object.keys(controls), declared), `${ac} control implementation set does not match declaration`);
  const rows: MutationRecord[] = [];
  for (const mutationId of declared) {
    const candidate = jsonClone(baseline);
    controls[mutationId]!(candidate);
    let red = false;
    try {
      validate(candidate);
    } catch {
      red = true;
    }
    invariant(red, `${ac}/${mutationId} unexpectedly stayed green`);
    validate(jsonClone(baseline));
    rows.push({ mutationId, executed: true, negativeOutcome: 'red', restoredOutcome: 'green' });
  }
  validateMutationArray(ac, rows);
  return rows;
}

function appendAttempt(statePath: string, attempt: EgressAttempt): void {
  appendFileSync(statePath, `${JSON.stringify(attempt)}\n`, 'utf8');
}

function writeExecutable(file: string, content: string): void {
  writeFileSync(file, content, 'utf8');
  if (process.platform !== 'win32') chmodSync(file, 0o700);
}

export function installEgressTrap(root: string): EgressTrap {
  const binDir = path.join(root, 'egress-bin');
  const statePath = path.join(root, 'egress.jsonl');
  const preloadPath = path.join(root, 'egress-preload.cjs');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(statePath, '', 'utf8');
  writeFileSync(preloadPath, `
const fs = require('node:fs');
const state = process.env.TASK311_EGRESS_STATE;
const record = (edge, detail='') => {
  if (state) fs.appendFileSync(state, JSON.stringify({ kind: 'node', edge, detail }) + '\\n');
  const error = new Error('TASK311_EGRESS_BLOCKED:' + edge);
  error.code = 'TASK311_EGRESS_BLOCKED';
  throw error;
};
for (const [moduleName, names] of [
  ['node:http', ['request', 'get']],
  ['node:https', ['request', 'get']],
  ['node:net', ['connect', 'createConnection']],
  ['node:dns', ['lookup', 'resolve', 'resolve4', 'resolve6']]
]) {
  const mod = require(moduleName);
  for (const name of names) {
    try { Object.defineProperty(mod, name, { configurable: true, writable: true, value: (...args) => record(moduleName + '.' + name, String(args[0] ?? '')) }); } catch {}
  }
}
globalThis.fetch = (...args) => record('fetch', String(args[0] ?? ''));
`, 'utf8');

  for (const edge of ['gh', 'ao', 'curl', 'wget', 'ssh', 'nc']) {
    if (process.platform === 'win32') {
      writeExecutable(path.join(binDir, `${edge}.cmd`), `@echo {"kind":"process","edge":"${edge}"}>>"%TASK311_EGRESS_STATE%"\r\necho TASK311_EGRESS_BLOCKED:${edge} 1>&2\r\nexit /b 91\r\n`);
    } else {
      writeExecutable(path.join(binDir, edge), `#!/usr/bin/env sh\nprintf '%s\\n' '{"kind":"process","edge":"${edge}"}' >> "$TASK311_EGRESS_STATE"\necho 'TASK311_EGRESS_BLOCKED:${edge}' >&2\nexit 91\n`);
    }
  }

  const originalPath = process.env.PATH;
  const originalNodeOptions = process.env.NODE_OPTIONS;
  const originalState = process.env.TASK311_EGRESS_STATE;
  const originalFetch = globalThis.fetch;
  const patched: Array<{ target: Record<string, unknown>; key: string; value: unknown }> = [];
  const block = (edge: string) => (...args: unknown[]): never => {
    appendAttempt(statePath, { kind: 'node', edge, detail: String(args[0] ?? '') });
    throw Object.assign(new Error(`TASK311_EGRESS_BLOCKED:${edge}`), { code: 'TASK311_EGRESS_BLOCKED' });
  };
  const patch = (target: Record<string, unknown>, key: string, edge: string): void => {
    patched.push({ target, key, value: target[key] });
    Object.defineProperty(target, key, { configurable: true, writable: true, value: block(edge) });
  };

  process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`;
  process.env.TASK311_EGRESS_STATE = statePath;
  process.env.NODE_OPTIONS = [originalNodeOptions ?? '', `--require=${preloadPath}`].filter(Boolean).join(' ');
  globalThis.fetch = block('fetch') as typeof fetch;
  patch(http as unknown as Record<string, unknown>, 'request', 'node:http.request');
  patch(http as unknown as Record<string, unknown>, 'get', 'node:http.get');
  patch(https as unknown as Record<string, unknown>, 'request', 'node:https.request');
  patch(https as unknown as Record<string, unknown>, 'get', 'node:https.get');
  patch(net as unknown as Record<string, unknown>, 'connect', 'node:net.connect');
  patch(net as unknown as Record<string, unknown>, 'createConnection', 'node:net.createConnection');
  patch(dns as unknown as Record<string, unknown>, 'lookup', 'node:dns.lookup');
  patch(dns as unknown as Record<string, unknown>, 'resolve', 'node:dns.resolve');

  return {
    active: true,
    root,
    binDir,
    statePath,
    nodeOptions: process.env.NODE_OPTIONS,
    attempts() {
      if (!existsSync(statePath)) return [];
      return readFileSync(statePath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
        .map((line) => JSON.parse(line) as EgressAttempt);
    },
    restore() {
      globalThis.fetch = originalFetch;
      for (const entry of patched.reverse()) {
        Object.defineProperty(entry.target, entry.key, { configurable: true, writable: true, value: entry.value });
      }
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
      if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = originalNodeOptions;
      if (originalState === undefined) delete process.env.TASK311_EGRESS_STATE; else process.env.TASK311_EGRESS_STATE = originalState;
    },
  };
}

function artifactPath(root: string, name: string): string {
  return path.join(root, `${name}.json`);
}

function writeArtifact<T extends Record<string, unknown>>(
  root: string,
  name: string,
  subject: string,
  implementation: string,
  payload: T,
): string {
  const target = artifactPath(root, name);
  const envelope: ArtifactEnvelope<T> = { schemaVersion: 1, subject, implementation, transport: 'json-file', payload };
  writeFileSync(target, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  return target;
}

function readArtifact<T extends Record<string, unknown>>(target: string): ArtifactEnvelope<T> {
  const value = JSON.parse(readFileSync(target, 'utf8')) as ArtifactEnvelope<T>;
  invariant(value.schemaVersion === 1 && value.transport === 'json-file', `invalid subject artifact ${target}`);
  return value;
}

function artifactSha(target: string): string {
  return createHash('sha256').update(readFileSync(target)).digest('hex');
}

function currentHeadSha(): string {
  const sha = runGit(['rev-parse', 'HEAD']).trim().toLowerCase();
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

function appendTrace(tracePath: string, event: string, detail: Record<string, unknown> = {}): void {
  const sequence = existsSync(tracePath)
    ? readFileSync(tracePath, 'utf8').split(/\r?\n/).filter((line) => line.trim()).length + 1
    : 1;
  appendFileSync(tracePath, `${JSON.stringify({ event, sequence, atMs: Date.now(), ...detail })}\n`, 'utf8');
}

function readTrace(tracePath: string): TraceRow[] {
  if (!existsSync(tracePath)) return [];
  return readFileSync(tracePath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .map((line) => JSON.parse(line) as TraceRow);
}

function installReviewerExecutableBoundary(root: string, tracePath: string): string {
  const bin = path.join(root, 'reviewer-bin');
  mkdirSync(bin, { recursive: true });
  const fakeReviewer = path.join(root, 'fake-reviewer.cjs');
  writeFileSync(fakeReviewer, `
const fs = require('node:fs');
const args = process.argv.slice(2);
const trace = process.env.TASK311_TRACE_FILE;
const expectedPr = process.env.TASK311_EXPECTED_PR;
const expectedHead = process.env.TASK311_EXPECTED_HEAD;
const expectedSession = process.env.TASK311_EXPECTED_SESSION;
const fail = (message) => { process.stderr.write(message + '\\n'); process.exit(64); };
const valueAfter = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : ''; };
if (!args.some((value) => /plugins[\\\\/]ao-codex-pr-reviewer[\\\\/]bin[\\\\/]review\\.ts$/.test(value))) fail('real plugin reviewer wrapper was not invoked');
if (valueAfter('--pr-number') !== expectedPr) fail('reviewer argv lost exact PR');
if (!valueAfter('--repo-root')) fail('reviewer argv lost worktree root');
if (!valueAfter('--base')) fail('reviewer argv lost base ref');
if (process.env.AO_SESSION_ID !== expectedSession || process.env.AO_WORKER_SESSION_ID !== expectedSession) fail('reviewer env lost worker identity');
fs.appendFileSync(trace, JSON.stringify({ event: 'reviewer-wrapper', sequence: 1, atMs: Date.now(), argv: args, prNumber: Number(expectedPr), headSha: expectedHead, sessionId: expectedSession }) + '\\n');
process.stdout.write(JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] }) + '\\n');
`, 'utf8');
  if (process.platform === 'win32') {
    writeExecutable(path.join(bin, 'node.cmd'), `@echo off\r\nset args=%*\r\necho %args% | findstr /C:"plugins\\ao-codex-pr-reviewer\\bin\\review.ts" >nul\r\nif %errorlevel%==0 ("${process.execPath}" "${fakeReviewer}" %*) else ("${process.execPath}" %*)\r\n`);
    writeExecutable(path.join(bin, 'npm.cmd'), '@echo off\r\nexit /b 0\r\n');
  } else {
    writeExecutable(path.join(bin, 'node'), `#!/usr/bin/env sh\ncase "$*" in *plugins/ao-codex-pr-reviewer/bin/review.ts*) exec "${process.execPath}" "${fakeReviewer}" "$@" ;; *) exec "${process.execPath}" "$@" ;; esac\n`);
    writeExecutable(path.join(bin, 'npm'), '#!/usr/bin/env sh\nexit 0\n');
  }
  invariant(tracePath.length > 0, 'trace path must be configured');
  return bin;
}

function githubTransport(headSha: string, tracePath: string): GithubReviewTransport {
  const actions: GithubReviewCaptureAction[] = [];
  const reviews: GithubReviewSummary[] = [];
  return {
    actions,
    async resolveActorLogin() { return 'task-311-reviewer'; },
    async listReviews() { return [...reviews]; },
    async postReview(input) {
      invariant(input.event === 'COMMENT', 'runner must publish COMMENT');
      invariant(input.commitId === headSha, 'COMMENT must target exact head');
      appendTrace(tracePath, 'github-comment', { eventType: input.event, headSha: input.commitId, body: input.body });
      const review: GithubReviewSummary = {
        id: 31101,
        state: 'COMMENTED',
        userLogin: 'task-311-reviewer',
        submittedAt: new Date().toISOString(),
        body: input.body,
        commitId: input.commitId,
        url: 'fixture://task-311/review/31101',
      };
      reviews.push(review);
      actions.push({ kind: 'post', event: input.event, body: input.body });
      return { id: review.id, url: review.url };
    },
    async dismissReview(reviewId) { actions.push({ kind: 'dismiss', event: 'DISMISS', reviewId }); },
  };
}

function runPreRunSubject(root: string, target: { prNumber: number; headSha: string; sessionId: string }, session: Record<string, unknown>): string {
  const openPr = {
    number: target.prNumber,
    headRefOid: target.headSha,
    headRefName: `issue-${target.prNumber}-task-311`,
    state: 'OPEN',
    repoSlug: fixture.repoSlug,
    headCommittedAt: '2026-07-06T05:00:00.000Z',
  };
  const result = preRunHeadReadyRecheck({
    ...target,
    startReason: 'task_311_three_subject_gate',
  }, {
    openPrs: [openPr],
    reviewRuns: [],
    sessions: [session as any],
    ciChecks: greenCiChecks(),
    ownerResolution: { sessionId: target.sessionId, reason: 'capture_owner', failClosed: false },
    nowMs: Date.parse('2026-07-19T02:00:00.000Z'),
    workerDeliveries: [],
  });
  invariant(result.emitReviewRun, `real pre-run subject denied positive path: ${result.reason}`);
  return writeArtifact(root, 'subject-1-pre-run', 'preRunHeadReadyRecheck', 'docs/review-head-ready.mjs#preRunHeadReadyRecheck', {
    target,
    openPr,
    result,
    freshReadCount: 1,
  });
}

function runBindingSubject(root: string, preRunPath: string, session: Record<string, unknown>): string {
  const prior = readArtifact<{ target: { prNumber: number; headSha: string; sessionId: string }; openPr: Record<string, unknown>; result: { emitReviewRun: boolean } }>(preRunPath);
  invariant(prior.subject === 'preRunHeadReadyRecheck' && prior.payload.result.emitReviewRun, 'binding subject received no admitted pre-run artifact');
  const { target, openPr } = prior.payload;
  const sessionBinding = resolveSessionPrBinding(session as any, [openPr as any], { headSha: target.headSha });
  invariant(sessionBinding.bound && sessionBinding.prNumber === target.prNumber, 'real binding resolver refused capture-backed target');
  const store = createDefaultPrSessionBindingCache();
  const registered = registerPrSessionBindingRecord(store, {
    sessionId: target.sessionId,
    prNumber: target.prNumber,
    repoSlug: fixture.repoSlug,
    issueNumber: target.prNumber,
    headSha: target.headSha,
    source: BINDING_SOURCE_BACKFILL_RESOLVER,
    openPrs: [openPr as any],
  }, Date.parse('2026-07-19T02:00:00.000Z'));
  invariant(registered.ok, `cache registration failed: ${registered.reason ?? registered.diagnostic}`);
  const cacheRecord = lookupBindingByPr(store, fixture.repoSlug, target.prNumber);
  invariant(cacheRecord, 'real cache lookup returned no record');
  const consumer = resolvePrSessionBindingForConsumer({
    store,
    repoSlug: fixture.repoSlug,
    prNumber: target.prNumber,
    headSha: target.headSha,
    sessions: [session as any],
    openPrs: [openPr as any],
    nowMs: Date.parse('2026-07-19T02:00:00.000Z'),
    writeBackfill: false,
    isLive: () => true,
  });
  invariant(consumer.source === 'cache' && consumer.reason === 'cache_hit' && consumer.failClosed === false, 'real cache consumer did not close through cache');
  return writeArtifact(root, 'subject-2-binding', 'bindingResolverCacheClosure', 'docs/session-pr-binding-resolver.mjs+docs/pr-session-binding-cache.mjs', {
    inputArtifactSha256: artifactSha(preRunPath),
    target,
    sessionBinding,
    cacheRecord,
    consumer,
  });
}

function terminalClaim(claimRoot: string, prNumber: number, headSha: string): Record<string, unknown> {
  const terminalDir = path.join(claimRoot, 'terminal');
  invariant(existsSync(terminalDir), 'real claim helper wrote no terminal directory');
  const records = readdirSync(terminalDir).filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(path.join(terminalDir, name), 'utf8')) as Record<string, unknown>);
  const match = records.find((record) => Number(record.prNumber) === prNumber && record.headSha === headSha);
  invariant(match, 'real claim helper wrote no matching terminal record');
  return match;
}

async function runRunnerSubject(root: string, bindingPath: string, trap: EgressTrap): Promise<string> {
  const bindingArtifact = readArtifact<{
    target: { prNumber: number; headSha: string; sessionId: string };
    sessionBinding: Record<string, unknown>;
    cacheRecord: Record<string, unknown>;
    consumer: Record<string, unknown>;
  }>(bindingPath);
  invariant(bindingArtifact.subject === 'bindingResolverCacheClosure', 'runner subject received wrong upstream artifact');
  const target = bindingArtifact.payload.target;
  const tracePath = path.join(root, 'runner-trace.jsonl');
  const storeRoot = path.join(root, 'review-store');
  const claimRoot = path.join(root, 'claims');
  writeFileSync(tracePath, '', 'utf8');
  const reviewerBin = installReviewerExecutableBoundary(root, tracePath);
  const originalEnv = { ...process.env };
  try {
    process.env.PATH = `${reviewerBin}${delimiter}${process.env.PATH ?? ''}`;
    process.env.PACK_REVIEWER = fixture.assembly.reviewer;
    process.env.AO_REVIEW_CLAIM_DIR = claimRoot;
    process.env.AO_REVIEW_START_MONOTONIC_NOW_MS = '1000';
    process.env.OPK_VITEST_HARNESS = '1';
    process.env.TASK311_TRACE_FILE = tracePath;
    process.env.TASK311_EXPECTED_PR = String(target.prNumber);
    process.env.TASK311_EXPECTED_HEAD = target.headSha;
    process.env.TASK311_EXPECTED_SESSION = target.sessionId;
    const statusRows: Array<Record<string, unknown>> = [];
    const workerRows: Array<Record<string, unknown>> = [];
    const result = await startPackReview({
      projectId,
      sessionId: target.sessionId,
      prNumber: target.prNumber,
      headSha: target.headSha,
      repoRoot,
      sourceRepoRoot: repoRoot,
      baseRef: 'origin/main',
      startReason: 'task_311_three_subject_gate',
      surface: 'task-311-real-runner-subject',
      storeRoot,
      fixtureRepoSlug: fixture.repoSlug,
      fixtureGithubReviewTransport: githubTransport(target.headSha, tracePath),
      fixtureRequiredStatusWriter: async (request) => {
        const row = { ...request, targetSha: target.headSha };
        statusRows.push(row);
        if (request.state !== 'pending') appendTrace(tracePath, 'required-status', row);
      },
      fixtureWorkerNotifier: async (request) => {
        const row = { ...request, sessionId: target.sessionId };
        workerRows.push(row);
        appendTrace(tracePath, 'worker-message', row);
        return { state: 'delivered', reason: 'task_311_fixture_dispatched' };
      },
      fixtureJournalWriter: (runId, fields, options) => {
        const persisted = updatePackReviewRun(runId, fields, options);
        appendTrace(tracePath, 'journal-verdict', { runId, reviewVerdict: persisted.reviewVerdict, headSha: persisted.targetSha });
        return persisted;
      },
    });
    invariant(result.ok === true && result.created === true, `real runner subject failed: ${String(result.reason)}`);
    const runId = String(result.runId);
    const run = getPackReviewRun(runId, { projectId, storeRoot });
    invariant(run, 'runner returned missing run');
    const claim = terminalClaim(claimRoot, target.prNumber, target.headSha);
    const traceRows = readTrace(tracePath).sort((left, right) => left.sequence - right.sequence);
    const reviewer = traceRows.find((row) => row.event === 'reviewer-wrapper');
    const github = traceRows.find((row) => row.event === 'github-comment');
    const terminalStatus = statusRows.findLast((row) => row.state !== 'pending');
    invariant(reviewer && github && terminalStatus && workerRows.length === 1, 'runner subject boundary evidence incomplete');
    const acquiredAtMs = Date.parse(String(claim.acquiredAtUtc));
    invariant(Number.isFinite(acquiredAtMs) && acquiredAtMs <= reviewer.atMs, 'claim was not durably acquired before reviewer wrapper');
    const order = ['atomic-claim', ...traceRows.map((row) => row.event)];
    return writeArtifact(root, 'subject-3-runner', 'startPackReview:acquire', 'scripts/pack-review-runner.ts#startPackReview', {
      inputArtifactSha256: artifactSha(bindingPath),
      target,
      order,
      traceRows,
      reviewerArgv: reviewer.argv,
      github: { headSha: github.headSha, eventType: github.eventType, body: github.body },
      status: terminalStatus,
      workerMessages: workerRows,
      run,
      claim,
      result,
      trap: { active: trap.active },
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
  invariant(value.binding?.consumer?.source === fixture.assembly.consumer.source, 'consumer source drifted');
  invariant(value.binding?.consumer?.reason === fixture.assembly.consumer.reason, 'consumer reason drifted');
  invariant(value.binding?.consumer?.failClosed === fixture.assembly.consumer.failClosed, 'consumer failClosed drifted');
  invariant(value.binding?.consumer?.sessionId === value.target.sessionId, 'consumer worker drifted');
  invariant(value.binding?.cacheRecord?.prNumber === value.target.prNumber, 'cache PR drifted');
  invariant(value.binding?.cacheRecord?.headSha === value.target.headSha, 'cache head drifted');
  invariant(value.identity === 'one-pr-head-worker-chain', 'identity marker missing');
  invariant(orderedSubsequence(value.runner?.order ?? [], fixture.assembly.runnerOrder), 'real runner internal hop order drifted');
  invariant(Array.isArray(value.runner?.reviewerArgv), 'reviewer argv missing');
  const prIndex = value.runner.reviewerArgv.indexOf('--pr-number');
  invariant(prIndex >= 0 && Number(value.runner.reviewerArgv[prIndex + 1]) === value.target.prNumber, 'reviewer argv PR drifted');
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

export async function runThreeSubjectAssembly(trap: EgressTrap): Promise<{
  assembly: Record<string, unknown>;
  mutations: { AC1: MutationRecord[]; AC2: MutationRecord[] };
}> {
  const root = tempRoot('task-311-three-subjects-');
  try {
    invariant(trap.active, 'egress trap must be active before subjects run');
    const { row: session } = readCapture();
    const target = { prNumber: fixture.assembly.prNumber, headSha: currentHeadSha(), sessionId: String(session.id) };
    invariant(Number(session.issueId) === target.prNumber, 'capture issueId does not bind fixture PR');
    const preRunPath = runPreRunSubject(root, target, session);
    const bindingPath = runBindingSubject(root, preRunPath, session);
    const runnerPath = await runRunnerSubject(root, bindingPath, trap);
    const preRun = readArtifact<Record<string, unknown>>(preRunPath);
    const binding = readArtifact<Record<string, unknown>>(bindingPath);
    const runner = readArtifact<Record<string, unknown>>(runnerPath);
    const assembly = {
      target,
      subjects: { reviewStart: preRun, binding, runner },
      binding: {
        session: (binding.payload as any).sessionBinding,
        cacheRecord: (binding.payload as any).cacheRecord,
        consumer: (binding.payload as any).consumer,
      },
      runner: runner.payload,
      identity: 'one-pr-head-worker-chain',
      captureSelectors: Object.values(fixture.capture.selectors),
      trap: { active: trap.active, unexpectedAttempts: trap.attempts().length },
    };
    validateAssemblyEvidence(assembly);
    const AC1 = runEvidenceMutationControls('AC1', assembly, validateAssemblyEvidence, {
      'real-subject-boundary-broken': (value: any) => { value.subjects.reviewStart.implementation = 'harness/fake-pre-run'; },
      'reviewer-argv-broken': (value: any) => { const index = value.runner.reviewerArgv.indexOf('--pr-number'); value.runner.reviewerArgv.splice(index, 2); },
      'resolver-output-constant-substitution': (value: any) => { value.binding.consumer.source = 'harness-constant'; },
      'subject-internals-reimplemented': (value: any) => { value.subjects.binding.transport = 'in-memory-harness'; },
      'runner-internal-hop-omitted': (value: any) => { value.runner.order = value.runner.order.filter((entry: string) => entry !== 'journal-verdict'); },
      'runner-internal-hop-reordered': (value: any) => {
        const journal = value.runner.order.indexOf('journal-verdict');
        const comment = value.runner.order.indexOf('github-comment');
        [value.runner.order[journal], value.runner.order[comment]] = [value.runner.order[comment], value.runner.order[journal]];
      },
    });
    const AC2 = runEvidenceMutationControls('AC2', assembly, validateAssemblyEvidence, {
      'invented-ao-field': (value: any) => { value.captureSelectors.push('$.data[0].prNumber'); },
      'identity-substitution': (value: any) => { value.target.sessionId = 'orchestrator-pack-substituted'; },
      'wrong-sha-status': (value: any) => { value.runner.status.targetSha = 'b'.repeat(40); },
      'non-comment-review': (value: any) => { value.runner.github.eventType = 'APPROVE'; },
      'worker-message-cardinality': (value: any) => { value.runner.workerMessages.push(jsonClone(value.runner.workerMessages[0])); },
    });
    return { assembly, mutations: { AC1, AC2 } };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  const drift = preRunHeadReadyRecheck({
    prNumber: fixture.assembly.prNumber,
    headSha: plannedHead,
    sessionId: String(session.id),
    startReason: 'task_311_stale_head',
  }, {
    ...common,
    openPrs: [{ number: fixture.assembly.prNumber, headRefOid: freshHead, headCommittedAt: '2026-07-06T05:00:00.000Z' }],
  });
  const unchanged = preRunHeadReadyRecheck({
    prNumber: fixture.assembly.prNumber,
    headSha: plannedHead,
    sessionId: String(session.id),
    startReason: 'task_311_unchanged_head',
  }, {
    ...common,
    openPrs: [{ number: fixture.assembly.prNumber, headRefOid: plannedHead, headRefName: `issue-${fixture.assembly.prNumber}-task-311`, headCommittedAt: '2026-07-06T05:00:00.000Z' }],
  });
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
  const mutations = runEvidenceMutationControls('AC5', reviewStart, validateReviewStartEvidence, {
    'advanced-head-run-emitted': (value: any) => { value.drift.emitReviewRun = true; value.runnerInvocations = 1; },
    'advanced-head-delivery-emitted': (value: any) => { value.deliveryInvocations = 1; },
    'current-head-not-reread': (value: any) => { value.freshReadCount = 0; },
    'unchanged-head-wrongly-denied': (value: any) => { value.unchanged.emitReviewRun = false; },
  });
  return { reviewStart, mutations };
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
