import { createHash } from 'node:crypto';
import {
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
import { preRunHeadReadyRecheck } from '../../../docs/review-head-ready.mjs';
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

function githubTransport(
  headSha: string,
  tracePath: string,
  options: { recordedEvent?: string; earlyEffect?: boolean } = {},
): GithubReviewTransport {
  const actions: GithubReviewCaptureAction[] = [];
  const reviews: GithubReviewSummary[] = [];
  if (options.earlyEffect) {
    appendTrace(tracePath, 'github-comment', { eventType: 'COMMENT', headSha, body: 'injected early external effect' });
  }
  return {
    actions,
    async resolveActorLogin() { return 'task-311-reviewer'; },
    async listReviews() { return [...reviews]; },
    async postReview(input) {
      invariant(input.event === 'COMMENT', 'runner must publish COMMENT');
      invariant(input.commitId === headSha, 'COMMENT must target exact head');
      if (!options.earlyEffect) {
        appendTrace(tracePath, 'github-comment', {
          eventType: options.recordedEvent ?? input.event,
          headSha: input.commitId,
          body: input.body,
        });
      }
      const review: GithubReviewSummary = {
        id: 31101 + reviews.length,
        state: 'COMMENTED',
        userLogin: 'task-311-reviewer',
        submittedAt: new Date().toISOString(),
        body: input.body,
        commitId: input.commitId,
        url: `fixture://task-311/review/${31101 + reviews.length}`,
      };
      reviews.push(review);
      actions.push({ kind: 'post', event: input.event, body: input.body });
      return { id: review.id, url: review.url };
    },
    async dismissReview(reviewId) {
      actions.push({ kind: 'dismiss', event: 'DISMISS', reviewId });
    },
  };
}

function runPreRunSubject(root: string, target: RunnerTarget, session: Record<string, unknown>): string {
  const openPr = {
    number: target.prNumber,
    headRefOid: target.headSha,
    headRefName: `issue-${target.prNumber}-task-311`,
    state: 'OPEN',
    repoSlug: fixture.repoSlug,
    headCommittedAt: '2026-07-06T05:00:00.000Z',
  };
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
  return writeArtifact(root, 'subject-1-pre-run', 'preRunHeadReadyRecheck', 'docs/review-head-ready.mjs#preRunHeadReadyRecheck', {
    target,
    openPr,
    result,
    freshReadCount: 1,
  });
}

function runBindingSubject(
  root: string,
  preRunPath: string,
  session: Record<string, unknown>,
  options: { substituteResolver?: boolean } = {},
): string {
  const prior = readArtifact<{
    target: RunnerTarget;
    openPr: Record<string, unknown>;
    result: { emitReviewRun: boolean };
  }>(preRunPath);
  invariant(prior.subject === 'preRunHeadReadyRecheck' && prior.payload.result.emitReviewRun, 'binding subject received no admitted pre-run artifact');
  const { target, openPr } = prior.payload;
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

interface RunnerFaults {
  expectedPr?: number;
  journalFailure?: boolean;
  earlyGithub?: boolean;
  statusHead?: string;
  recordedEvent?: string;
  workerCopies?: number;
  targetSession?: string;
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
  const result = await runPackReviewEntry({
    root: entryRoot,
    target,
    storeRoot,
    tracePath,
    githubTransport: githubTransport(target.headSha, tracePath, {
      recordedEvent: faults.recordedEvent,
      earlyEffect: faults.earlyGithub,
    }),
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
        const persisted = updatePackReviewRun(runId, fields, options);
        appendTrace(tracePath, 'journal-verdict', {
          runId,
          reviewVerdict: persisted.reviewVerdict,
          headSha: persisted.targetSha,
        });
        return persisted;
      },
  });
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
  preRun: ArtifactEnvelope<Record<string, unknown>>,
  binding: ArtifactEnvelope<Record<string, unknown>>,
  runner: ArtifactEnvelope<Record<string, unknown>>,
  trap: EgressTrap,
): Record<string, unknown> {
  return {
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
}

async function expectAssemblyRed(
  ac: 'AC1' | 'AC2',
  mutationId: string,
  factory: () => Promise<Record<string, unknown>> | Record<string, unknown>,
  restored: Record<string, unknown>,
): Promise<MutationRecord> {
  return expectBehaviorRed(ac, mutationId, async () => validateAssemblyEvidence(await factory()), () => validateAssemblyEvidence(restored));
}

async function runThreeSubjectAssembly(trap: EgressTrap): Promise<{
  assembly: Record<string, unknown>;
  mutations: { AC1: MutationRecord[]; AC2: MutationRecord[] };
}> {
  const root = tempRoot('task-311-three-subjects-');
  try {
    const { row: session } = readCapture();
    const target = { prNumber: fixture.assembly.prNumber, headSha: currentHeadSha(), sessionId: String(session.id) };
    invariant(Number(session.issueId) === target.prNumber, 'capture issueId does not bind fixture PR');
    const preRunPath = runPreRunSubject(root, target, session);
    const bindingPath = runBindingSubject(root, preRunPath, session);
    const runnerPath = await runRunnerSubject(root, bindingPath, trap);
    const preRun = readArtifact<Record<string, unknown>>(preRunPath);
    const binding = readArtifact<Record<string, unknown>>(bindingPath);
    const runner = readArtifact<Record<string, unknown>>(runnerPath);
    const assembly = assembleEvidence(target, preRun, binding, runner, trap);
    validateAssemblyEvidence(assembly);

    const AC1: MutationRecord[] = [];
    AC1.push(await expectAssemblyRed('AC1', 'real-subject-boundary-broken', () => {
      const badPath = writeArtifact(root, 'fake-pre-run', 'preRunHeadReadyRecheck', 'harness/fake-pre-run', preRun.payload);
      return assembleEvidence(target, readArtifact(badPath), binding, runner, trap);
    }, assembly));
    AC1.push(await expectBehaviorRed('AC1', 'reviewer-argv-broken', async () => {
      await runRunnerSubject(root, bindingPath, trap, { expectedPr: target.prNumber + 1 });
    }, () => validateAssemblyEvidence(assembly)));
    AC1.push(await expectBehaviorRed('AC1', 'resolver-output-constant-substitution', () => {
      runBindingSubject(root, preRunPath, session, { substituteResolver: true });
    }, () => validateAssemblyEvidence(assembly)));
    AC1.push(await expectAssemblyRed('AC1', 'subject-internals-reimplemented', () => {
      const badPath = writeArtifact(root, 'fake-binding', 'bindingResolverCacheClosure', 'harness/reimplemented-binding', binding.payload);
      return assembleEvidence(target, preRun, readArtifact(badPath), runner, trap);
    }, assembly));
    AC1.push(await expectBehaviorRed('AC1', 'runner-internal-hop-omitted', async () => {
      await runRunnerSubject(root, bindingPath, trap, { journalFailure: true });
    }, () => validateAssemblyEvidence(assembly)));
    AC1.push(await expectAssemblyRed('AC1', 'runner-internal-hop-reordered', async () => {
      const badRunner = readArtifact<Record<string, unknown>>(await runRunnerSubject(root, bindingPath, trap, { earlyGithub: true }));
      return assembleEvidence(target, preRun, binding, badRunner, trap);
    }, assembly));
    validateMutationArray('AC1', AC1);

    const AC2: MutationRecord[] = [];
    AC2.push(await expectAssemblyRed('AC2', 'invented-ao-field', () => {
      const fakeAoPath = writeArtifact(root, 'fake-ao', 'capture-backed-ao-boundary', 'harness/fake-ao', {
        selectors: [...Object.values(fixture.capture.selectors), '$.data[0].prNumber'],
        row: { ...session, prNumber: target.prNumber },
      });
      const fakeAo = readArtifact<{ selectors: string[]; row: Record<string, unknown> }>(fakeAoPath);
      const bad = assembleEvidence(target, preRun, binding, runner, trap) as any;
      bad.captureSelectors = fakeAo.payload.selectors;
      return bad;
    }, assembly));
    AC2.push(await expectAssemblyRed('AC2', 'identity-substitution', async () => {
      const badRunner = readArtifact<Record<string, unknown>>(await runRunnerSubject(root, bindingPath, trap, { targetSession: 'orchestrator-pack-substituted' }));
      return assembleEvidence(target, preRun, binding, badRunner, trap);
    }, assembly));
    AC2.push(await expectAssemblyRed('AC2', 'wrong-sha-status', async () => {
      const badRunner = readArtifact<Record<string, unknown>>(await runRunnerSubject(root, bindingPath, trap, { statusHead: 'b'.repeat(40) }));
      return assembleEvidence(target, preRun, binding, badRunner, trap);
    }, assembly));
    AC2.push(await expectAssemblyRed('AC2', 'non-comment-review', async () => {
      const badRunner = readArtifact<Record<string, unknown>>(await runRunnerSubject(root, bindingPath, trap, { recordedEvent: 'APPROVE' }));
      return assembleEvidence(target, preRun, binding, badRunner, trap);
    }, assembly));
    AC2.push(await expectAssemblyRed('AC2', 'worker-message-cardinality', async () => {
      const badRunner = readArtifact<Record<string, unknown>>(await runRunnerSubject(root, bindingPath, trap, { workerCopies: 2 }));
      return assembleEvidence(target, preRun, binding, badRunner, trap);
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
      expect((evidence.assembly as any).runner.reviewerObservedHeadSha).toBe((evidence.assembly as any).target.headSha);
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
