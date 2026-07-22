import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  BINDING_SOURCE_BACKFILL_RESOLVER,
  createDefaultPrSessionBindingCache,
  lookupBindingByPr,
  registerPrSessionBindingRecord,
  resolvePrSessionBindingForConsumer,
} from '../../../docs/pr-session-binding-cache.mjs';
import { preRunHeadReadyRecheck } from '../../pr2-foundation/terminalized/review-head-ready.ts';
import { resolveSessionPrBinding } from '../../../docs/session-pr-binding-resolver.mjs';
import {
  type GithubReviewCaptureAction,
  type GithubReviewSummary,
  type GithubReviewTransport,
} from '../../lib/github-review-reconciliation.js';
import {
  getPackReviewRun,
  updatePackReviewRun,
} from '../../lib/pack-review-run-store.js';
import { runClaimMatrix } from './task-311-claim.test-support.js';
import {
  appendTrace,
  captureEvidenceDocument,
  expectBehaviorRed,
  fixture,
  invariant,
  projectId,
  readCapture,
  readTrace,
  repoRoot,
  runGit,
  runPackReviewEntry,
  runStaleHeadGate,
  tempRoot,
  validateAssemblyEvidence,
  validateCompleteEvidence,
  validateMutationArray,
  type AcceptanceEvidence,
  type EgressTrap,
  type MutationRecord,
  type RunnerTarget,
} from './task-311-common.test-support.js';
import { runDeliveryMatrix } from './task-311-delivery.test-support.js';
import { installEgressTrap, runScopeGate } from './task-311-scope.test-support.js';

interface ArtifactEnvelope<T extends Record<string, unknown>> {
  schemaVersion: 1;
  subject: string;
  implementation: string;
  transport: 'json-file';
  payload: T;
}

type AoBoundaryPayload = Record<string, unknown> & {
  selectors: string[];
  row: Record<string, unknown>;
};

interface ObservedGithubTransport extends GithubReviewTransport {
  actions: GithubReviewCaptureAction[];
  observedReviews: GithubReviewSummary[];
}

function writeArtifact<T extends Record<string, unknown>>(
  root: string,
  name: string,
  subject: string,
  implementation: string,
  payload: T,
): string {
  const target = path.join(root, `${name}.json`);
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

function writeAoBoundary(
  root: string,
  row: Record<string, unknown>,
  selectors: string[],
  options: { name?: string; implementation?: string } = {},
): string {
  return writeArtifact(
    root,
    options.name ?? 'ao-capture-boundary',
    'capture-backed-ao-boundary',
    options.implementation ?? fixture.capture.path,
    { selectors, row },
  );
}

function githubTransport(
  headSha: string,
  tracePath: string,
  options: { externalEvent?: 'COMMENT' | 'APPROVE' } = {},
): ObservedGithubTransport {
  const actions: GithubReviewCaptureAction[] = [];
  const reviews: GithubReviewSummary[] = [];
  return {
    actions,
    observedReviews: reviews,
    async resolveActorLogin() { return 'task-311-reviewer'; },
    async listReviews() { return [...reviews]; },
    async postReview(input) {
      invariant(input.event === 'COMMENT', 'runner must publish COMMENT');
      invariant(input.commitId === headSha, 'COMMENT must target exact head');
      const externalEvent = options.externalEvent ?? input.event;
      appendTrace(tracePath, 'github-comment', {
        eventType: externalEvent,
        headSha: input.commitId,
        body: input.body,
      });
      const review: GithubReviewSummary = {
        id: 31101 + reviews.length,
        state: externalEvent === 'APPROVE' ? 'APPROVED' : 'COMMENTED',
        userLogin: 'task-311-reviewer',
        submittedAt: new Date().toISOString(),
        body: input.body,
        commitId: input.commitId,
        url: `fixture://task-311/review/${31101 + reviews.length}`,
      };
      reviews.push(review);
      actions.push({ kind: 'post', event: externalEvent, body: input.body });
      return { id: review.id, url: review.url };
    },
    async dismissReview(reviewId) {
      actions.push({ kind: 'dismiss', event: 'DISMISS', reviewId });
    },
  };
}

function openPrForTarget(target: RunnerTarget): Record<string, unknown> {
  return {
    number: target.prNumber,
    headRefOid: target.headSha,
    headRefName: `issue-${target.prNumber}-task-311`,
    state: 'OPEN',
    repoSlug: fixture.repoSlug,
    headCommittedAt: '2026-07-06T05:00:00.000Z',
  };
}

function runPreRunSubject(
  root: string,
  target: RunnerTarget,
  aoPath: string,
  options: { name?: string } = {},
): string {
  const ao = readArtifact<AoBoundaryPayload>(aoPath);
  invariant(ao.subject === 'capture-backed-ao-boundary', 'pre-run subject received wrong AO boundary');
  const session = ao.payload.row;
  const openPr = openPrForTarget(target);
  const result = preRunHeadReadyRecheck({ ...target, startReason: 'task_311_three_subject_gate' }, {
    openPrs: [openPr],
    reviewRuns: [],
    sessions: [session as any],
    ciChecks: greenCiChecks(),
    ownerResolution: { sessionId: target.sessionId, reason: 'capture_owner', failClosed: false },
    nowMs: Date.parse('2026-07-19T02:00:00.000Z'),
    workerDeliveries: [],
  });
  invariant(result.emitReviewRun, `real pre-run subject denied positive path: ${result.reason}`);
  return writeArtifact(root, options.name ?? 'subject-1-pre-run', 'preRunHeadReadyRecheck', 'docs/review-head-ready.mjs#preRunHeadReadyRecheck', {
    inputArtifactSha256: artifactSha(aoPath),
    target,
    openPr,
    session,
    result,
    freshReadCount: 1,
  });
}

function runHarnessPreRunSubject(root: string, target: RunnerTarget, aoPath: string): string {
  const ao = readArtifact<AoBoundaryPayload>(aoPath);
  return writeArtifact(root, `fake-pre-run-${Math.random()}`, 'preRunHeadReadyRecheck', 'harness/fake-pre-run', {
    inputArtifactSha256: artifactSha(aoPath),
    target,
    openPr: openPrForTarget(target),
    session: ao.payload.row,
    result: { emitReviewRun: true, reason: 'harness_fabricated_admission' },
    freshReadCount: 0,
  });
}

function runBindingSubject(
  root: string,
  preRunPath: string,
  options: { substituteResolver?: boolean; name?: string } = {},
): string {
  const prior = readArtifact<{
    target: RunnerTarget;
    openPr: Record<string, unknown>;
    session: Record<string, unknown>;
    result: { emitReviewRun: boolean };
  }>(preRunPath);
  invariant(prior.subject === 'preRunHeadReadyRecheck' && prior.payload.result.emitReviewRun, 'binding subject received no admitted pre-run artifact');
  const { target, openPr, session } = prior.payload;
  const resolved = resolveSessionPrBinding(session as any, [openPr as any], { headSha: target.headSha });
  const sessionBinding = options.substituteResolver
    ? { bound: true, prNumber: target.prNumber, source: 'harness_constant', enriched: false }
    : resolved;
  invariant(sessionBinding.bound && sessionBinding.prNumber === target.prNumber, 'real binding resolver refused capture-backed target');
  invariant(sessionBinding.source === 'issue_correlation' && sessionBinding.enriched === true, 'resolver output was substituted or renamed');
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
  return writeArtifact(root, options.name ?? 'subject-2-binding', 'bindingResolverCacheClosure', 'docs/session-pr-binding-resolver.mjs+docs/pr-session-binding-cache.mjs', {
    inputArtifactSha256: artifactSha(preRunPath),
    target,
    sessionBinding,
    cacheRecord,
    consumer,
  });
}

function runHarnessBindingSubject(root: string, preRunPath: string): string {
  const prior = readArtifact<{
    target: RunnerTarget;
    result: { emitReviewRun: boolean };
  }>(preRunPath);
  invariant(prior.payload.result.emitReviewRun, 'fake binding subject received denied pre-run artifact');
  const { target } = prior.payload;
  return writeArtifact(root, `fake-binding-${Math.random()}`, 'bindingResolverCacheClosure', 'harness/reimplemented-binding', {
    inputArtifactSha256: artifactSha(preRunPath),
    target,
    sessionBinding: {
      bound: true,
      prNumber: target.prNumber,
      source: 'issue_correlation',
      enriched: true,
    },
    cacheRecord: {
      sessionId: target.sessionId,
      prNumber: target.prNumber,
      headSha: target.headSha,
      source: BINDING_SOURCE_BACKFILL_RESOLVER,
    },
    consumer: {
      source: 'cache',
      reason: 'cache_hit',
      failClosed: false,
      sessionId: target.sessionId,
    },
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

function writeExecutable(file: string, content: string): void {
  writeFileSync(file, content, 'utf8');
  if (process.platform !== 'win32') chmodSync(file, 0o700);
}

async function runPackReviewEntryWithReviewerRootOverride(
  options: Parameters<typeof runPackReviewEntry>[0],
  reviewerRootOverride: string,
): Promise<Record<string, unknown>> {
  const pending = runPackReviewEntry(options);
  const fakeReviewer = path.join(options.root, 'fake-reviewer.cjs');
  const reviewerBin = path.join(options.root, 'reviewer-bin');
  invariant(existsSync(fakeReviewer) && existsSync(reviewerBin), 'reviewer executable boundary was not installed before runner continuation');
  const dispatcher = path.join(options.root, 'reviewer-root-dispatch.cjs');
  writeFileSync(dispatcher, `
const cp = require('node:child_process');
const [fakeReviewer, ...args] = process.argv.slice(2);
const override = process.env.TASK311_REVIEW_ROOT_OVERRIDE || '';
const index = args.indexOf('--repo-root');
if (override && index >= 0) args[index + 1] = override;
const result = cp.spawnSync(process.execPath, [fakeReviewer, ...args], { env: process.env, stdio: 'inherit' });
if (result.error) { process.stderr.write(String(result.error) + '\\n'); process.exit(70); }
process.exit(result.status === null ? 71 : result.status);
`, 'utf8');
  if (process.platform === 'win32') {
    writeExecutable(path.join(reviewerBin, 'node.cmd'), `@echo off\r\nset args=%*\r\necho %args% | findstr /C:"plugins\\ao-codex-pr-reviewer\\bin\\review.ts" >nul\r\nif %errorlevel%==0 ("${process.execPath}" "${dispatcher}" "${fakeReviewer}" %*) else ("${process.execPath}" %*)\r\n`);
  } else {
    writeExecutable(path.join(reviewerBin, 'node'), `#!/usr/bin/env sh\ncase "$*" in *plugins/ao-codex-pr-reviewer/bin/review.ts*) exec "${process.execPath}" "${dispatcher}" "${fakeReviewer}" "$@" ;; *) exec "${process.execPath}" "$@" ;; esac\n`);
  }
  process.env.TASK311_REVIEW_ROOT_OVERRIDE = reviewerRootOverride;
  return await pending;
}

interface RunnerFaults {
  expectedPr?: number;
  journalFailure?: boolean;
  commentBeforeJournal?: boolean;
  statusHead?: string;
  externalReviewEvent?: 'COMMENT' | 'APPROVE';
  workerCopies?: number;
  targetSession?: string;
  reviewerRootOverride?: string;
}

async function runRunnerSubject(
  root: string,
  bindingPath: string,
  trap: EgressTrap,
  faults: RunnerFaults = {},
): Promise<string> {
  const bindingArtifact = readArtifact<{
    target: RunnerTarget;
    sessionBinding: Record<string, unknown>;
    cacheRecord: Record<string, unknown>;
    consumer: Record<string, unknown>;
  }>(bindingPath);
  invariant(bindingArtifact.subject === 'bindingResolverCacheClosure', 'runner subject received wrong upstream artifact');
  const target = { ...bindingArtifact.payload.target, ...(faults.targetSession ? { sessionId: faults.targetSession } : {}) };
  const tracePath = path.join(root, `runner-trace-${Math.random()}.jsonl`);
  const storeRoot = path.join(root, `review-store-${Math.random()}`);
  const entryRoot = path.join(root, `entry-${Math.random()}`);
  writeFileSync(tracePath, '', 'utf8');
  const statusRows: Array<Record<string, unknown>> = [];
  const workerRows: Array<Record<string, unknown>> = [];
  const transport = githubTransport(target.headSha, tracePath, {
    externalEvent: faults.externalReviewEvent,
  });
  const entryOptions: Parameters<typeof runPackReviewEntry>[0] = {
    root: entryRoot,
    target,
    storeRoot,
    tracePath,
    githubTransport: transport,
    expectedPr: faults.expectedPr,
    statusWriter: async (request) => {
      const row = { ...request, targetSha: faults.statusHead ?? target.headSha };
      statusRows.push(row);
      if (request.state !== 'pending') appendTrace(tracePath, 'required-status', row);
    },
    workerNotifier: async (request) => {
      const copies = faults.workerCopies ?? 1;
      for (let index = 0; index < copies; index += 1) {
        const row = { ...request, sessionId: target.sessionId, copy: index + 1 };
        workerRows.push(row);
        appendTrace(tracePath, 'worker-message', row);
      }
      return { state: 'delivered', reason: 'task_311_fixture_dispatched' };
    },
    journalWriter: faults.journalFailure
      ? () => { throw new Error('task-311 omitted durable journal hop'); }
      : (runId, fields, options) => {
        if (faults.commentBeforeJournal) {
          void transport.postReview({
            event: 'COMMENT',
            body: `TASK-311 injected COMMENT before durable verdict for ${runId}`,
            commitId: target.headSha,
          });
          invariant(transport.actions.length === 1, 'pre-journal COMMENT fault did not cross the real transport seam');
        }
        const persisted = updatePackReviewRun(runId, fields, options);
        appendTrace(tracePath, 'journal-verdict', {
          runId,
          reviewVerdict: persisted.reviewVerdict,
          headSha: persisted.targetSha,
        });
        return persisted;
      },
  };
  const result = faults.reviewerRootOverride
    ? await runPackReviewEntryWithReviewerRootOverride(entryOptions, faults.reviewerRootOverride)
    : await runPackReviewEntry(entryOptions);
  invariant(result.ok === true && result.created === true, `real runner subject failed: ${String(result.reason)}`);
  const runId = String(result.runId);
  const run = getPackReviewRun(runId, { projectId, storeRoot });
  invariant(run, 'runner returned missing run');
  const claim = terminalClaim(path.join(entryRoot, 'claims'), target.prNumber, target.headSha);
  const traceRows = readTrace(tracePath).sort((left, right) => left.sequence - right.sequence);
  const reviewer = traceRows.find((row) => row.event === 'reviewer-wrapper');
  const github = traceRows.find((row) => row.event === 'github-comment');
  const terminalStatus = [...statusRows].reverse().find((row) => row.state !== 'pending');
  invariant(reviewer && github && terminalStatus && workerRows.length >= 1, 'runner subject boundary evidence incomplete');
  const acquiredAtMs = Date.parse(String(claim.acquiredAtUtc));
  invariant(Number.isFinite(acquiredAtMs) && acquiredAtMs <= reviewer.atMs, 'claim was not durably acquired before reviewer wrapper');
  return writeArtifact(root, `subject-3-runner-${Math.random()}`, 'startPackReview:acquire', 'scripts/pack-review-runner.ts#startPackReview', {
    inputArtifactSha256: artifactSha(bindingPath),
    target,
    order: ['atomic-claim', ...traceRows.map((row) => row.event)],
    traceRows,
    reviewerArgv: reviewer.argv,
    reviewerObservedHeadSha: reviewer.observedHeadSha,
    reviewerExpectedHeadSha: reviewer.expectedHeadSha,
    reviewerWorktreeRoot: reviewer.reviewTargetRoot,
    github: { headSha: github.headSha, eventType: github.eventType, body: github.body },
    githubTransport: {
      actions: [...transport.actions],
      reviews: [...transport.observedReviews],
    },
    status: terminalStatus,
    workerMessages: workerRows,
    run,
    claim,
    result,
    trap: { active: trap.active },
  });
}

function assembleEvidence(
  target: RunnerTarget,
  ao: ArtifactEnvelope<AoBoundaryPayload>,
  preRun: ArtifactEnvelope<Record<string, unknown>>,
  binding: ArtifactEnvelope<Record<string, unknown>>,
  runner: ArtifactEnvelope<Record<string, unknown>>,
  trap: EgressTrap,
): Record<string, unknown> {
  return {
    target,
    externalBoundaries: { ao },
    subjects: { reviewStart: preRun, binding, runner },
    binding: {
      session: (binding.payload as any).sessionBinding,
      cacheRecord: (binding.payload as any).cacheRecord,
      consumer: (binding.payload as any).consumer,
    },
    runner: runner.payload,
    identity: 'one-pr-head-worker-chain',
    captureSelectors: ao.payload.selectors,
    trap: { active: trap.active, unexpectedAttempts: trap.attempts().length },
  };
}

function canonicalPath(value: unknown, label: string): string {
  invariant(typeof value === 'string' && value.length > 0, `${label} missing`);
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function validateTask311AssemblyEvidence(candidate: Record<string, unknown>): void {
  validateAssemblyEvidence(candidate);
  const value = candidate as any;
  invariant(value.externalBoundaries?.ao?.subject === 'capture-backed-ao-boundary', 'AO capture boundary missing');
  invariant(value.externalBoundaries?.ao?.transport === 'json-file', 'AO capture boundary was not transported through JSON');
  const reviewerRoot = canonicalPath(value.runner?.reviewerWorktreeRoot, 'reviewer worktree root');
  const persistedRoot = canonicalPath(value.runner?.run?.reviewTargetRoot, 'persisted review target root');
  const sourceRoot = canonicalPath(value.runner?.run?.sourceRepoRoot, 'source repository root');
  const trustedRoot = canonicalPath(value.runner?.run?.trustedPackRoot, 'trusted pack root');
  invariant(reviewerRoot === persistedRoot, 'reviewer argv root did not match the runner-created persisted review worktree');
  invariant(reviewerRoot !== sourceRoot, 'reviewer was pointed at the source checkout instead of the review worktree');
  invariant(reviewerRoot !== trustedRoot, 'reviewer was pointed at the trusted pack checkout instead of the review worktree');
  const rootIndex = value.runner.reviewerArgv.indexOf('--repo-root');
  invariant(rootIndex >= 0 && canonicalPath(value.runner.reviewerArgv[rootIndex + 1], 'reviewer argv --repo-root') === reviewerRoot, 'reviewer trace root did not come from actual argv');
  const runnerOwned = (value.runner?.order ?? []).filter((event: string) => fixture.assembly.runnerOrder.includes(event));
  invariant(runnerOwned.join(',') === fixture.assembly.runnerOrder.join(','), 'runner-owned hops were duplicated or reordered');
  const actions = value.runner?.githubTransport?.actions;
  const reviews = value.runner?.githubTransport?.reviews;
  invariant(Array.isArray(actions) && actions.length === 1 && actions[0]?.kind === 'post' && actions[0]?.event === 'COMMENT', 'fake GitHub transport did not actually post COMMENT');
  invariant(Array.isArray(reviews) && reviews.length === 1 && reviews[0]?.state === 'COMMENTED', 'fake GitHub transport did not create a COMMENTED review');
}

async function expectAssemblyRed(
  ac: 'AC1' | 'AC2',
  mutationId: string,
  factory: () => Promise<Record<string, unknown>> | Record<string, unknown>,
  restored: Record<string, unknown>,
): Promise<MutationRecord> {
  return expectBehaviorRed(ac, mutationId, async () => validateTask311AssemblyEvidence(await factory()), () => validateTask311AssemblyEvidence(restored));
}

async function runThreeSubjectAssembly(trap: EgressTrap): Promise<{
  assembly: Record<string, unknown>;
  mutations: { AC1: MutationRecord[]; AC2: MutationRecord[] };
}> {
  const root = tempRoot('task-311-three-subjects-');
  try {
    const { row: session } = readCapture();
    const aoPath = writeAoBoundary(root, session, Object.values(fixture.capture.selectors));
    const ao = readArtifact<AoBoundaryPayload>(aoPath);
    const target = { prNumber: fixture.assembly.prNumber, headSha: currentHeadSha(), sessionId: String(session.id) };
    invariant(Number(session.issueId) === target.prNumber, 'capture issueId does not bind fixture PR');
    const preRunPath = runPreRunSubject(root, target, aoPath);
    const bindingPath = runBindingSubject(root, preRunPath);
    const runnerPath = await runRunnerSubject(root, bindingPath, trap);
    const preRun = readArtifact<Record<string, unknown>>(preRunPath);
    const binding = readArtifact<Record<string, unknown>>(bindingPath);
    const runner = readArtifact<Record<string, unknown>>(runnerPath);
    const assembly = assembleEvidence(target, ao, preRun, binding, runner, trap);
    validateTask311AssemblyEvidence(assembly);

    const AC1: MutationRecord[] = [];
    AC1.push(await expectAssemblyRed('AC1', 'real-subject-boundary-broken', async () => {
      const badPreRunPath = runHarnessPreRunSubject(root, target, aoPath);
      const downstreamBindingPath = runBindingSubject(root, badPreRunPath, { name: `binding-after-fake-pre-run-${Math.random()}` });
      const downstreamRunnerPath = await runRunnerSubject(root, downstreamBindingPath, trap);
      return assembleEvidence(
        target,
        ao,
        readArtifact(badPreRunPath),
        readArtifact(downstreamBindingPath),
        readArtifact(downstreamRunnerPath),
        trap,
      );
    }, assembly));
    AC1.push(await expectAssemblyRed('AC1', 'reviewer-argv-broken', async () => {
      let wrongPrRejected = false;
      try {
        await runRunnerSubject(root, bindingPath, trap, { expectedPr: target.prNumber + 1 });
      } catch {
        wrongPrRejected = true;
      }
      invariant(wrongPrRejected, 'reviewer wrong-PR argv mutation unexpectedly stayed green');
      const badRunnerPath = await runRunnerSubject(root, bindingPath, trap, { reviewerRootOverride: repoRoot });
      return assembleEvidence(target, ao, preRun, binding, readArtifact(badRunnerPath), trap);
    }, assembly));
    AC1.push(await expectBehaviorRed('AC1', 'resolver-output-constant-substitution', () => {
      runBindingSubject(root, preRunPath, { substituteResolver: true, name: `substituted-binding-${Math.random()}` });
    }, () => validateTask311AssemblyEvidence(assembly)));
    AC1.push(await expectAssemblyRed('AC1', 'subject-internals-reimplemented', async () => {
      const badBindingPath = runHarnessBindingSubject(root, preRunPath);
      const downstreamRunnerPath = await runRunnerSubject(root, badBindingPath, trap);
      return assembleEvidence(target, ao, preRun, readArtifact(badBindingPath), readArtifact(downstreamRunnerPath), trap);
    }, assembly));
    AC1.push(await expectBehaviorRed('AC1', 'runner-internal-hop-omitted', async () => {
      await runRunnerSubject(root, bindingPath, trap, { journalFailure: true });
    }, () => validateTask311AssemblyEvidence(assembly)));
    AC1.push(await expectAssemblyRed('AC1', 'runner-internal-hop-reordered', async () => {
      const badRunner = readArtifact<Record<string, unknown>>(await runRunnerSubject(root, bindingPath, trap, { commentBeforeJournal: true }));
      return assembleEvidence(target, ao, preRun, binding, badRunner, trap);
    }, assembly));
    validateMutationArray('AC1', AC1);

    const AC2: MutationRecord[] = [];
    AC2.push(await expectAssemblyRed('AC2', 'invented-ao-field', async () => {
      const fakeAoPath = writeAoBoundary(
        root,
        { ...session, prNumber: target.prNumber },
        [...Object.values(fixture.capture.selectors), '$.data[0].prNumber'],
        { name: `fake-ao-${Math.random()}`, implementation: 'harness/invented-ao-field' },
      );
      const fakeAo = readArtifact<AoBoundaryPayload>(fakeAoPath);
      const inventedTarget = {
        prNumber: Number(fakeAo.payload.row.prNumber),
        headSha: target.headSha,
        sessionId: String(fakeAo.payload.row.id),
      };
      const badPreRunPath = runPreRunSubject(root, inventedTarget, fakeAoPath, { name: `pre-run-from-invented-ao-${Math.random()}` });
      const badBindingPath = runBindingSubject(root, badPreRunPath, { name: `binding-from-invented-ao-${Math.random()}` });
      const badRunnerPath = await runRunnerSubject(root, badBindingPath, trap);
      return assembleEvidence(
        inventedTarget,
        fakeAo,
        readArtifact(badPreRunPath),
        readArtifact(badBindingPath),
        readArtifact(badRunnerPath),
        trap,
      );
    }, assembly));
    AC2.push(await expectAssemblyRed('AC2', 'identity-substitution', async () => {
      const badRunner = readArtifact<Record<string, unknown>>(await runRunnerSubject(root, bindingPath, trap, { targetSession: 'orchestrator-pack-substituted' }));
      return assembleEvidence(target, ao, preRun, binding, badRunner, trap);
    }, assembly));
    AC2.push(await expectAssemblyRed('AC2', 'wrong-sha-status', async () => {
      const badRunner = readArtifact<Record<string, unknown>>(await runRunnerSubject(root, bindingPath, trap, { statusHead: 'b'.repeat(40) }));
      return assembleEvidence(target, ao, preRun, binding, badRunner, trap);
    }, assembly));
    AC2.push(await expectAssemblyRed('AC2', 'non-comment-review', async () => {
      const badRunner = readArtifact<Record<string, unknown>>(await runRunnerSubject(root, bindingPath, trap, { externalReviewEvent: 'APPROVE' }));
      return assembleEvidence(target, ao, preRun, binding, badRunner, trap);
    }, assembly));
    AC2.push(await expectAssemblyRed('AC2', 'worker-message-cardinality', async () => {
      const badRunner = readArtifact<Record<string, unknown>>(await runRunnerSubject(root, bindingPath, trap, { workerCopies: 2 }));
      return assembleEvidence(target, ao, preRun, binding, badRunner, trap);
    }, assembly));
    validateMutationArray('AC2', AC2);
    return { assembly, mutations: { AC1, AC2 } };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('TASK-311 real surviving review-cycle assembly gate', () => {
  it('drives real subjects, persisted restart classes, behavioral mutations, and a process-wide hermetic boundary', async () => {
    const trapRoot = tempRoot('task-311-egress-');
    const trap = installEgressTrap(trapRoot);
    try {
      expect(trap.active).toBe(true);
      expect(trap.nativeLibrary || process.platform !== 'linux').toBeTruthy();
      expect(trap.attempts()).toEqual([]);

      const assembled = await runThreeSubjectAssembly(trap);
      const claim = runClaimMatrix();
      const delivery = await runDeliveryMatrix();
      const reviewStart = runStaleHeadGate();
      expect(trap.attempts()).toEqual([]);
      const scope = runScopeGate(trap);

      const evidence: AcceptanceEvidence = {
        schemaVersion: 2,
        issue: 918,
        task: 311,
        assembly: assembled.assembly,
        capture: captureEvidenceDocument(),
        claim: claim.claim,
        delivery: delivery.delivery,
        reviewStart: reviewStart.reviewStart,
        scope: scope.scope,
        mutationEvidence: {
          AC1: assembled.mutations.AC1,
          AC2: assembled.mutations.AC2,
          AC3: claim.mutations,
          AC4: delivery.mutations,
          AC5: reviewStart.mutations,
          AC6: scope.mutations,
        },
      };

      validateCompleteEvidence(evidence);
      validateTask311AssemblyEvidence(evidence.assembly);
      expect((evidence.assembly as any).runner.reviewerObservedHeadSha).toBe((evidence.assembly as any).target.headSha);
      expect((evidence.assembly as any).runner.reviewerWorktreeRoot).toBe((evidence.assembly as any).runner.run.reviewTargetRoot);
      expect((evidence.assembly as any).binding.session.bound).toBe(true);
      expect((evidence.claim as any).classes).toBe('C1-C7-pass');
      expect((evidence.delivery as any).classes).toBe('J0-J6-pass');
      expect((evidence.reviewStart as any).headDecision).toBe('stale-head-review-start-denied');
      expect((evidence.scope as any).result).toBe('test-only-offline-capture-backed');
      process.stdout.write(`TASK311_ACCEPTANCE_EVIDENCE=${JSON.stringify(evidence)}\n`);
    } finally {
      trap.restore();
      rmSync(trapRoot, { recursive: true, force: true });
    }
  }, 900_000);
});
