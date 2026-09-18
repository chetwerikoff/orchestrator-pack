// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60

import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runProcessSync } from '../kernel/subprocess.ts';
import {
  formatSmokeReportComment,
  parseWorkerSmokeAffectedCarrier,
  planWorkerSmokeSelectiveRetry,
  projectWorkerSmokeSelectiveReport,
  SMOKE_REPORT_PRODUCER,
  type SmokeReport,
  type SmokeScenario,
  type WorkerSmokeCommentRecord,
  type WorkerSmokeTrustedTarget,
} from '../lib/worker-smoke-core.ts';
import { publishCurrentWorkerAssignment, resolveWorkerAssignmentStorePath, type WorkerAssignment } from '../lib/worker-assignment-store.ts';
import { commitPackReviewTerminal, initializePackReviewAuthority, recordPackReviewPublication } from '../pack-review-state.ts';
import type { RuntimeAdapter } from '../runtime/contracts.ts';
import { DeterministicRuntimeAdapter } from '../runtime/test-adapter.ts';
import { runSmokeAttempt } from '../worker-smoke-run.ts';
import { reconcilePostReviewSmoke, type PostReviewSmokeDependencies } from './post-review-smoke.ts';

const REPO = 'chetwerikoff/orchestrator-pack';
const ISSUE = 1418;
const PR = 1481;
const roots: string[] = [];
const ISSUE_BODY = `\`\`\`behavior-kind
action-producing
\`\`\`

\`\`\`complexity-tier
tier: T3
advisory-prior: T3
\`\`\`

\`\`\`smoke-test-plan
scenarios:
  - action: force a pre-action fence failure | expected: no lifecycle reservation or spawn
\`\`\``;

const gh = vi.hoisted(() => ({ head: '' }));
vi.mock('../lib/gh-repo-resolve.mjs', () => ({
  ghApiJson: vi.fn((_command: string, endpoint: string) => {
    switch (endpoint) {
      case 'user': return { login: 'preaction-fixture' };
      case `repos/${REPO}/issues/${ISSUE}`: return {
        number: ISSUE,
        state: 'open',
        html_url: `https://github.com/${REPO}/issues/${ISSUE}`,
        body: ISSUE_BODY,
      };
      case `repos/${REPO}/pulls/${PR}`: return {
        number: PR,
        state: 'open',
        html_url: `https://github.com/${REPO}/pull/${PR}`,
        body: `Closes #${ISSUE}`,
        head: { sha: gh.head },
      };
      default: throw new Error(`unexpected fixture endpoint: ${endpoint}`);
    }
  }),
}));

type Fixture = ReturnType<typeof makeFixture>;
type RuntimeFixture = ReturnType<typeof makeRuntime>;
type FenceObservation = { reason?: string; actionEntered?: boolean };
type FenceMutation = () => void | (() => void) | Promise<void | (() => void)>;

function runGit(cwd: string, ...args: string[]): string {
  const result = runProcessSync({ command: 'git', args, cwd, inheritParentEnv: true });
  if (!result.ok) throw new Error(`fixture git failed: ${args.join(' ')}: ${result.stderr || result.error || result.exitCode}`);
  return result.stdout.trim();
}

function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-preaction-'));
  roots.push(root);
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const commands = [
    ['init'],
    ['config', 'user.name', 'Preaction Fixture'],
    ['config', 'user.email', 'preaction@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
  ];
  for (const args of commands) runGit(workspace, ...args);
  writeFileSync(path.join(workspace, '.gitignore'), '.orca-worker-smoke/\n', 'utf8');
  writeFileSync(path.join(workspace, 'fixture.txt'), 'fixture\n', 'utf8');
  runGit(workspace, 'add', '.gitignore', 'fixture.txt');
  runGit(workspace, 'commit', '-m', 'fixture');
  runGit(workspace, 'remote', 'add', 'origin', `https://github.com/${REPO}.git`);
  return {
    root,
    workspace,
    headSha: runGit(workspace, 'rev-parse', 'HEAD').toLowerCase(),
    reviewRoot: path.join(root, 'review'),
    receiptRoot: path.join(root, 'receipts'),
    assignmentFile: resolveWorkerAssignmentStorePath('orchestrator-pack', { ...process.env, OPK_BASE_DIR: root }),
  };
}

function completeReview(input: Fixture): void {
  const options = { storeRoot: input.reviewRoot };
  const initial = initializePackReviewAuthority({ prNumber: PR, headSha: input.headSha, tier: 'T3', options });
  const terminal = commitPackReviewTerminal({
    prNumber: PR,
    expectedTransitionSeq: initial.transitionSeq,
    status: 'up_to_date',
    findingCount: 0,
    terminal: {
      schemaVersion: 1,
      terminalContractVersion: 2,
      terminalSource: 'normal',
      runId: 'preaction-review-run',
      targetSha: input.headSha,
      reviewVerdict: 'clean',
      findingCount: 0,
      findingsDigest: 'preaction-clean',
    },
    options,
  });
  recordPackReviewPublication({
    prNumber: PR,
    expectedTransitionSeq: terminal.transitionSeq,
    publication: {
      headSha: input.headSha,
      terminalRunId: 'preaction-review-run',
      status: 'succeeded',
      publicationDigest: 'preaction-published',
      recordedAtUtc: new Date().toISOString(),
    },
    options,
  });
}

async function setLocalAssignment(
  input: Fixture,
  bindingKey: string,
  expectedCurrent?: Pick<WorkerAssignment, 'assignmentId' | 'generation'>,
): Promise<WorkerAssignment> {
  const publication = await publishCurrentWorkerAssignment({
    file: input.assignmentFile,
    repository: REPO,
    issueNumber: ISSUE,
    taskId: 'preaction-task',
    kind: 'local',
    provider: 'orca',
    bindingKey,
    role: 'worker',
    ...(expectedCurrent ? { expectedCurrent } : {}),
  });
  if (!publication.ok) throw new Error(publication.reason);
  return publication.assignment;
}

function makeRuntime(input: Fixture, bindingKey: string, failResolveOrdinal?: number) {
  const adapter = new DeterministicRuntimeAdapter();
  const owner = adapter.spawnWorker({ title: 'preaction-owner', command: 'cursor-agent', workspace: input.workspace });
  if (owner.status !== 'ok') throw new Error('fixture owner spawn failed');
  const originalSpawn = adapter.spawnWorker.bind(adapter);
  let resolves = 0;
  let smokeSpawns = 0;
  Object.defineProperty(adapter, 'resolveAssignmentWorker', {
    configurable: true,
    value: vi.fn((selector: { bindingKey?: string }) => {
      if (selector.bindingKey !== bindingKey) return { status: 'ok' as const, value: { kind: 'gone' as const } };
      resolves += 1;
      if (resolves === failResolveOrdinal) {
        return { status: 'failed' as const, operation: 'resolve_assignment_worker' as const, reason: 'fixture-authority-unavailable' };
      }
      return { status: 'ok' as const, value: { kind: 'resolved' as const, worker: owner.value } };
    }),
  });
  Object.defineProperty(adapter, 'readiness', {
    configurable: true,
    value: vi.fn(() => ({ status: 'ok' as const, value: { ready: true as const, workspacePath: input.workspace, headSha: input.headSha } })),
  });
  Object.defineProperty(adapter, 'spawnWorker', {
    configurable: true,
    value: vi.fn((request: Parameters<RuntimeAdapter['spawnWorker']>[0]) => {
      smokeSpawns += 1;
      return originalSpawn(request);
    }),
  });
  return { adapter: adapter as unknown as RuntimeAdapter, spawnCount: () => smokeSpawns };
}

function baseDependencies(input: Fixture, runtime: RuntimeFixture): PostReviewSmokeDependencies {
  return {
    projectId: 'orchestrator-pack',
    repoRoot: input.workspace,
    assignmentStorePath: input.assignmentFile,
    adapter: runtime.adapter,
    env: { ...process.env, PACK_REVIEW_RUN_STORE_ROOT: input.reviewRoot },
    ciGreen: () => true,
    readIssueBody: async () => ISSUE_BODY,
    runAttempt: (options, deps) => runSmokeAttempt({ ...options, dryRun: true }, {
      ...deps,
      resolveTarget: (smokeOptions, suppliedBody) => {
        if (smokeOptions.issueNumber !== ISSUE
            || smokeOptions.prNumber !== PR
            || smokeOptions.headSha !== input.headSha
            || suppliedBody !== ISSUE_BODY) {
          throw new Error('preaction_fixture_target_mismatch');
        }
        return {
          repositorySlug: REPO,
          issueNumber: ISSUE,
          prNumber: PR,
          headSha: input.headSha,
          issueBody: ISSUE_BODY,
          prBody: `Closes #${ISSUE}`,
          issueBodyMatchesTarget: true,
          trustedPublisherLogin: 'preaction-fixture',
          prOpen: true,
          baseRef: 'main',
          expectedTargetRef: 'main',
          expectedTarget: true,
        };
      },
    }),
  };
}

function candidate(input: Fixture) {
  return { repoSlug: REPO, prNumber: PR, headSha: input.headSha, prBody: `Closes #${ISSUE}` };
}

function runs(input: Fixture): string[] {
  const directory = path.join(input.workspace, '.orca-worker-smoke', 'runs');
  return existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : [];
}

function withFenceMutation(
  base: PostReviewSmokeDependencies,
  mutate: FenceMutation,
  observation: FenceObservation,
): PostReviewSmokeDependencies {
  return {
    ...base,
    runAttempt: (options, deps) => runSmokeAttempt({ ...options, dryRun: true }, {
      ...deps,
      startFence: async (action) => {
        const fence = deps.startFence;
        if (!fence) throw new Error('fixture missing production start fence');
        const cleanup = await mutate();
        try {
          const result = await fence(action);
          if (!result.ok) {
            observation.reason = result.reason;
            observation.actionEntered = result.actionEntered;
          }
          return result;
        } finally {
          cleanup?.();
        }
      },
    }),
  };
}

async function readyCase(bindingKey: string, failResolveOrdinal?: number) {
  const input = makeFixture();
  vi.stubEnv('PACK_REVIEW_RUN_STORE_ROOT', input.reviewRoot);
  vi.stubEnv('WORKER_SMOKE_RECEIPT_ROOT', input.receiptRoot);
  vi.stubEnv('PACK_EXECUTOR_SMOKE_COMPLEX_AGENT', 'cursor');
  vi.stubEnv('PACK_EXECUTOR_SMOKE_COMPLEX_MODEL', 'preaction-model');
  vi.stubEnv('PACK_EXECUTOR_SMOKE_COMPLEX_EFFORT', 'high');
  gh.head = input.headSha;
  completeReview(input);
  const assignment = await setLocalAssignment(input, bindingKey);
  const runtime = makeRuntime(input, assignment.bindingKey, failResolveOrdinal);
  return { input, assignment, runtime, deps: baseDependencies(input, runtime) };
}

function expectZeroAttempt(result: Awaited<ReturnType<typeof reconcilePostReviewSmoke>>, runtime: RuntimeFixture, input: Fixture): void {
  expect(result).toMatchObject({ handled: true, attempted: false });
  expect(runtime.spawnCount()).toBe(0);
  expect(runs(input)).toHaveLength(0);
}

afterEach(() => {
  vi.unstubAllEnvs();
  gh.head = '';
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Issue #1418 r10 production pre-action fence failures', () => {
  it('keeps final runtime-authority unavailability pre-action and smoke-free', async () => {
    const { input, runtime, deps } = await readyCase('preaction-runtime-unavailable', 2);
    const result = await reconcilePostReviewSmoke(candidate(input), deps);
    expectZeroAttempt(result, runtime, input);
  });

  it('keeps assignment_store_busy pre-action and smoke-free', async () => {
    const { input, runtime, deps } = await readyCase('preaction-busy');
    const observation: FenceObservation = {};
    const lockPath = `${input.assignmentFile}.lock`;
    const admissionPath = path.join(input.workspace, '.orca-worker-smoke', 'admission.lock.json');
    let admissionObservedBeforeFence = false;
    const busy = withFenceMutation(deps, () => {
      admissionObservedBeforeFence = existsSync(admissionPath);
      mkdirSync(path.dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce: 'busy', acquiredAtMs: Date.now() })}\n`);
      return () => rmSync(lockPath, { force: true });
    }, observation);
    const result = await reconcilePostReviewSmoke(candidate(input), busy);
    expect(observation).toEqual({ reason: 'assignment_store_busy', actionEntered: false });
    expect(admissionObservedBeforeFence).toBe(true);
    expect(existsSync(admissionPath)).toBe(false);
    expectZeroAttempt(result, runtime, input);
  });

  it('keeps assignment_stale pre-action and smoke-free', async () => {
    const { input, assignment, runtime, deps } = await readyCase('preaction-stale-g');
    const observation: FenceObservation = {};
    const stale = withFenceMutation(deps, async () => {
      await setLocalAssignment(input, 'preaction-stale-g-plus-1', {
        assignmentId: assignment.assignmentId,
        generation: assignment.generation,
      });
    }, observation);
    const result = await reconcilePostReviewSmoke(candidate(input), stale);
    expect(observation).toEqual({ reason: 'assignment_stale', actionEntered: false });
    expectZeroAttempt(result, runtime, input);
  });

  it('uses generic assignment_fence_failed as zero attempt only with observed non-entry', async () => {
    const { input, runtime, deps } = await readyCase('preaction-generic');
    const observation: FenceObservation = {};
    const storeDirectory = path.dirname(input.assignmentFile);
    const backup = `${storeDirectory}.backup`;
    const unavailable = withFenceMutation(deps, () => {
      renameSync(storeDirectory, backup);
      writeFileSync(storeDirectory, 'not-a-directory\n');
      return () => {
        rmSync(storeDirectory, { force: true });
        renameSync(backup, storeDirectory);
      };
    }, observation);
    const result = await reconcilePostReviewSmoke(candidate(input), unavailable);
    expect(observation).toEqual({ reason: 'assignment_fence_failed', actionEntered: false });
    expectZeroAttempt(result, runtime, input);
  });
});

const SELECTIVE_ISSUE = 1924;
const SELECTIVE_PR = 1930;
const SELECTIVE_ACTOR = 'pack-publisher';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const SHA_D = 'd'.repeat(40);
const selectiveScenarios = [
  { action: 'S1 action', expected: 'S1 expected' },
  { action: 'S2 action', expected: 'S2 expected' },
  { action: 'S3 action', expected: 'S3 expected' },
  { action: 'S4 action', expected: 'S4 expected' },
] as const;

function selectivePlanBody(specs: readonly { action: string; expected: string }[] = selectiveScenarios): string {
  const rows = specs.map((entry) => `  - action: ${entry.action} | expected: ${entry.expected}`).join('\n');
  return `\`\`\`behavior-kind\naction-producing\n\`\`\`\n\n\`\`\`smoke-test-plan\nscenarios:\n${rows}\n\`\`\``;
}

function selectiveTieredPlanBody(specs: readonly { action: string; expected: string }[] = selectiveScenarios): string {
  const rows = specs.map((entry) => `  - action: ${entry.action} | expected: ${entry.expected}`).join('\n');
  return `\`\`\`behavior-kind\naction-producing\n\`\`\`\n\n\`\`\`complexity-tier\ntier: T3\nadvisory-prior: T3\n\`\`\`\n\n\`\`\`smoke-test-plan\nscenarios:\n${rows}\n\`\`\``;
}

function selectiveScenario(index: number, outcome: SmokeScenario['outcome'] = 'pass'): SmokeScenario {
  const spec = selectiveScenarios[index - 1]!;
  return { action: spec.action, expected: spec.expected, observed: `${spec.action} ${outcome ?? 'unknown'}`, outcome };
}

function selectiveReport(
  headSha: string,
  scenarios: SmokeScenario[],
  result: SmokeReport['result'] = scenarios.every((row) => row.outcome === 'pass') ? 'PASS' : 'FAIL',
): SmokeReport {
  return {
    result,
    issueNumber: SELECTIVE_ISSUE,
    prNumber: SELECTIVE_PR,
    headSha,
    scenarios,
    limitations: [],
    trackedFilesUnmodified: true,
    terminalCleanup: 'closed_owned_handle',
    environmentNotes: [],
    producer: SMOKE_REPORT_PRODUCER,
    orcaExecutable: 'runtime-adapter',
    terminalHandle: `selective-${headSha[0]}`,
  };
}

function selectiveComment(id: number, report: SmokeReport): WorkerSmokeCommentRecord {
  const createdAt = new Date(Date.UTC(2026, 8, 16, 1, 0, 0, id)).toISOString();
  return {
    id,
    body: formatSmokeReportComment(report),
    created_at: createdAt,
    updated_at: createdAt,
    user: { login: SELECTIVE_ACTOR },
  };
}

function selectiveTarget(headSha: string): WorkerSmokeTrustedTarget {
  return {
    repositorySlug: REPO,
    issueNumber: SELECTIVE_ISSUE,
    prNumber: SELECTIVE_PR,
    headSha,
    resolvedIssueNumber: SELECTIVE_ISSUE,
    resolvedPrNumber: SELECTIVE_PR,
    liveHeadSha: headSha,
    issueBodyMatchesTarget: true,
    trustedPublisherLogin: SELECTIVE_ACTOR,
    commentCensusComplete: true,
    commentSnapshotStable: true,
  };
}

function ancestry(edges: readonly [string, string][]) {
  const known = new Set(edges.map(([ancestor, descendant]) => `${ancestor}>${descendant}`));
  return (ancestor: string, descendant: string): boolean => ancestor === descendant || known.has(`${ancestor}>${descendant}`);
}

function affected(headSha: string, indexes: readonly number[]): string {
  return [
    '```worker-smoke-affected',
    JSON.stringify({
      head: headSha,
      scenarios: indexes.map((index) => ({
        action: selectiveScenarios[index - 1]!.action,
        expected: selectiveScenarios[index - 1]!.expected,
      })),
    }),
    '```',
  ].join('\n');
}

function indexesOf(plan: ReturnType<typeof planWorkerSmokeSelectiveRetry>['attemptPlan']): number[] {
  return plan.scenarios.map((row) => selectiveScenarios.findIndex((entry) =>
    entry.action === row.action && entry.expected === row.expected) + 1);
}

describe('Issue #1924 selective smoke retry', () => {
  it('reuses prior exact PASS tuples and retries only non-PASS plus unexecuted tuples', () => {
    const selection = planWorkerSmokeSelectiveRetry({
      issueBody: selectivePlanBody(),
      prBody: '',
      comments: [selectiveComment(1, selectiveReport(
        SHA_A,
        [selectiveScenario(1), selectiveScenario(2), selectiveScenario(3, 'fail')],
        'FAIL',
      ))],
      target: selectiveTarget(SHA_B),
      isAncestor: ancestry([[SHA_A, SHA_B]]),
    });
    expect(selection.fallbackReason).toBeUndefined();
    expect(indexesOf(selection.attemptPlan)).toEqual([3, 4]);
    expect(selection.carried.map((entry) => entry.scenario.action)).toEqual(['S1 action', 'S2 action']);
  });

  it('treats omitted, empty, stale, and malformed affected carriers as local empty input', () => {
    const comments = [selectiveComment(1, selectiveReport(
      SHA_A,
      [selectiveScenario(1), selectiveScenario(2), selectiveScenario(3, 'fail')],
      'FAIL',
    ))];
    const bodies = ['', affected(SHA_B, []), affected(SHA_A, [2]), '```worker-smoke-affected\n{not-json}\n```'];
    for (const prBody of bodies) {
      const selection = planWorkerSmokeSelectiveRetry({
        issueBody: selectivePlanBody(),
        prBody,
        comments,
        target: selectiveTarget(SHA_B),
        isAncestor: ancestry([[SHA_A, SHA_B]]),
      });
      expect(selection.fallbackReason).toBeUndefined();
      expect(indexesOf(selection.attemptPlan)).toEqual([3, 4]);
    }
  });

  it('invalidates only the exact current-head affected prior PASS tuple', () => {
    const selection = planWorkerSmokeSelectiveRetry({
      issueBody: selectivePlanBody(),
      prBody: affected(SHA_B, [2]),
      comments: [selectiveComment(1, selectiveReport(
        SHA_A,
        [selectiveScenario(1), selectiveScenario(2), selectiveScenario(3, 'fail')],
        'FAIL',
      ))],
      target: selectiveTarget(SHA_B),
      isAncestor: ancestry([[SHA_A, SHA_B]]),
    });
    expect(indexesOf(selection.attemptPlan)).toEqual([2, 3, 4]);
    expect(selection.carried.map((entry) => entry.scenario.action)).toEqual(['S1 action']);
  });

  it('lets a fresh same-head PASS supersede a still-present affected carrier', () => {
    const selection = planWorkerSmokeSelectiveRetry({
      issueBody: selectivePlanBody([selectiveScenarios[1]]),
      prBody: affected(SHA_B, [2]),
      comments: [
        selectiveComment(1, selectiveReport(SHA_A, [selectiveScenario(2)])),
        selectiveComment(2, selectiveReport(SHA_B, [selectiveScenario(2)])),
      ],
      target: selectiveTarget(SHA_B),
      isAncestor: ancestry([[SHA_A, SHA_B]]),
    });
    expect(selection.attemptPlan.scenarios).toHaveLength(0);
    expect(selection.carried[0]?.sourceHeadSha).toBe(SHA_B);
  });

  it('uses descendant precedence and never resurrects an older PASS after a newer FAIL', () => {
    const selection = planWorkerSmokeSelectiveRetry({
      issueBody: selectivePlanBody([selectiveScenarios[1]]),
      prBody: '',
      comments: [
        selectiveComment(1, selectiveReport(SHA_A, [selectiveScenario(2)])),
        selectiveComment(2, selectiveReport(SHA_B, [selectiveScenario(2, 'fail')], 'FAIL')),
      ],
      target: selectiveTarget(SHA_C),
      isAncestor: ancestry([[SHA_A, SHA_B], [SHA_A, SHA_C], [SHA_B, SHA_C]]),
    });
    expect(indexesOf(selection.attemptPlan)).toEqual([2]);
    expect(selection.carried).toHaveLength(0);
  });

  it('falls back to the full plan when any valid history candidate has unprovable current-head ancestry', () => {
    const selection = planWorkerSmokeSelectiveRetry({
      issueBody: selectivePlanBody([selectiveScenarios[0], selectiveScenarios[1]]),
      prBody: '',
      comments: [
        selectiveComment(1, selectiveReport(SHA_A, [selectiveScenario(1)])),
        selectiveComment(2, selectiveReport(SHA_B, [selectiveScenario(2, 'fail')], 'FAIL')),
      ],
      target: selectiveTarget(SHA_C),
      isAncestor: (ancestorSha, descendantSha) => {
        if (ancestorSha === SHA_A && descendantSha === SHA_C) return true;
        if (ancestorSha === SHA_B && descendantSha === SHA_C) throw new Error('fixture ancestry unavailable');
        return ancestorSha === descendantSha;
      },
    });
    expect(selection.fallbackReason).toBe('history_lineage_unprovable');
    expect(indexesOf(selection.attemptPlan)).toEqual([1, 2]);
    expect(selection.carried).toHaveLength(0);
  });

  it('falls back to the full plan on mixed rewritten history instead of keeping an older ancestor PASS', () => {
    const selection = planWorkerSmokeSelectiveRetry({
      issueBody: selectivePlanBody([selectiveScenarios[0], selectiveScenarios[1]]),
      prBody: '',
      comments: [
        selectiveComment(1, selectiveReport(SHA_A, [selectiveScenario(1), selectiveScenario(2)])),
        selectiveComment(2, selectiveReport(SHA_B, [selectiveScenario(2, 'fail')], 'FAIL')),
      ],
      target: selectiveTarget(SHA_C),
      isAncestor: ancestry([[SHA_A, SHA_B], [SHA_A, SHA_C]]),
    });
    expect(selection.fallbackReason).toBe('history_non_descendant');
    expect(indexesOf(selection.attemptPlan)).toEqual([1, 2]);
    expect(selection.carried).toHaveLength(0);
  });

  it('reruns only the tuple whose maximal ancestor observations are incomparable', () => {
    const selection = planWorkerSmokeSelectiveRetry({
      issueBody: selectivePlanBody([selectiveScenarios[0], selectiveScenarios[1]]),
      prBody: '',
      comments: [
        selectiveComment(1, selectiveReport(SHA_A, [selectiveScenario(1), selectiveScenario(2)])),
        selectiveComment(2, selectiveReport(SHA_B, [selectiveScenario(2)])),
      ],
      target: selectiveTarget(SHA_D),
      isAncestor: ancestry([[SHA_A, SHA_D], [SHA_B, SHA_D]]),
    });
    expect(selection.attemptPlan.scenarios.map((row) => row.action)).toEqual(['S2 action']);
    expect(selection.carried.map((entry) => entry.scenario.action)).toEqual(['S1 action']);
  });

  it('uses ordinary full-plan fallback only for whole-attempt history or binding failures', () => {
    const noHistory = planWorkerSmokeSelectiveRetry({
      issueBody: selectivePlanBody(), prBody: '', comments: [], target: selectiveTarget(SHA_B), isAncestor: ancestry([]),
    });
    expect(noHistory.fallbackReason).toBe('no_prior_canonical_observation');
    expect(indexesOf(noHistory.attemptPlan)).toEqual([1, 2, 3, 4]);
    expect(planWorkerSmokeSelectiveRetry({
      issueBody: selectivePlanBody(), prBody: '', comments: [], target: selectiveTarget(SHA_B),
      isAncestor: ancestry([]), historyReadable: false,
    }).fallbackReason).toBe('history_unreadable');
    expect(planWorkerSmokeSelectiveRetry({
      issueBody: selectivePlanBody(), prBody: '', comments: [], target: selectiveTarget(SHA_B),
      isAncestor: ancestry([]), historyBindingTrusted: false,
    }).fallbackReason).toBe('history_binding_untrusted');
    expect(planWorkerSmokeSelectiveRetry({
      issueBody: selectivePlanBody(), prBody: '',
      comments: [selectiveComment(1, selectiveReport(SHA_A, [selectiveScenario(1)]))],
      target: selectiveTarget(SHA_B), isAncestor: ancestry([]),
    }).fallbackReason).toBe('history_non_descendant');
  });

  it('projects carried and fresh rows into truthful fresh current-head coverage', () => {
    const selection = planWorkerSmokeSelectiveRetry({
      issueBody: selectivePlanBody(),
      prBody: '',
      comments: [selectiveComment(1, selectiveReport(
        SHA_A,
        [selectiveScenario(1), selectiveScenario(2), selectiveScenario(3, 'fail')],
        'FAIL',
      ))],
      target: selectiveTarget(SHA_B),
      isAncestor: ancestry([[SHA_A, SHA_B]]),
    });
    const projected = projectWorkerSmokeSelectiveReport({
      selection,
      partial: { result: 'PASS', scenarios: [selectiveScenario(3), selectiveScenario(4)], environmentNotes: [] },
    });
    expect(projected.result).toBe('PASS');
    expect(projected.scenarios).toHaveLength(4);
    expect(projected.scenarios?.[0]?.observed).toContain('not freshly executed');
    expect(projected.environmentNotes).toContain('smoke-carried=2');
    expect(projected.environmentNotes).toContain('smoke-fresh=2');
  });

  it('runs a carry-only zero-execution plan through the production independent path without reserving or spawning', async () => {
    const input = makeFixture();
    vi.stubEnv('PACK_REVIEW_RUN_STORE_ROOT', input.reviewRoot);
    const issueBody = selectiveTieredPlanBody([selectiveScenarios[1]]);
    const issueBodyFile = path.join(input.root, 'selective-issue.md');
    writeFileSync(issueBodyFile, issueBody, 'utf8');
    const prBody = `Closes #${SELECTIVE_ISSUE}\n\n${affected(input.headSha, [2])}`;
    const history = [selectiveComment(1, selectiveReport(input.headSha, [selectiveScenario(2)]))];
    const runtime = makeRuntime(input, 'unused-selective-binding');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const code = await runSmokeAttempt({
        command: 'run',
        issueNumber: SELECTIVE_ISSUE,
        prNumber: SELECTIVE_PR,
        headSha: input.headSha,
        issueBodyFile,
        smokeComplexity: 'complex',
        smokeActor: 'independent',
        operatorSmokeOnly: false,
        repoRoot: input.workspace,
        cwd: input.workspace,
        dryRun: true,
        json: true,
        reviewId: '',
        reviewHeadSha: '',
      }, {
        adapter: runtime.adapter,
        resolveProfile: () => ({
          complexity: 'complex',
          family: 'cursor',
          agent: 'cursor-agent',
          command: 'cursor-agent',
          names: [
            'PACK_EXECUTOR_SMOKE_COMPLEX_AGENT',
            'PACK_EXECUTOR_SMOKE_COMPLEX_MODEL',
            'PACK_EXECUTOR_SMOKE_COMPLEX_EFFORT',
          ],
        }),
        resolveTarget: () => ({
          repositorySlug: REPO,
          issueNumber: SELECTIVE_ISSUE,
          prNumber: SELECTIVE_PR,
          headSha: input.headSha,
          issueBody,
          prBody,
          issueBodyMatchesTarget: true,
          trustedPublisherLogin: SELECTIVE_ACTOR,
          prOpen: true,
          baseRef: 'main',
          expectedTargetRef: 'main',
          expectedTarget: true,
        }),
        fetchHistoryComments: () => history,
        isHistoryAncestor: (ancestorSha, descendantSha) => ancestorSha === descendantSha,
      });
      const emitted = JSON.parse(String(stdout.mock.calls.at(-1)?.[0] ?? '{}')) as {
        ok?: boolean;
        report?: SmokeReport;
        selection?: { attempted?: number; carried?: number };
      };
      expect(code).toBe(0);
      expect(emitted).toMatchObject({
        ok: true,
        report: { result: 'PASS', terminalCleanup: 'not_started_no_execution' },
        selection: { attempted: 0, carried: 1 },
      });
      expect(emitted.report?.terminalHandle).toBeUndefined();
      expect(runtime.spawnCount()).toBe(0);
      expect(runs(input)).toHaveLength(0);
    } finally {
      stdout.mockRestore();
    }
  });

  it('uses the existing selective census for no-tier required worker smoke', async () => {
    const input = makeFixture();
    const issueBody = selectivePlanBody([selectiveScenarios[1]]);
    const issueBodyFile = path.join(input.root, 'selective-no-tier-issue.md');
    writeFileSync(issueBodyFile, issueBody, 'utf8');
    const prBody = `Closes #${SELECTIVE_ISSUE}`;
    const history = [selectiveComment(1, selectiveReport(input.headSha, [selectiveScenario(2)]))];
    const runtime = makeRuntime(input, 'unused-no-tier-selective-binding');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let targetCalls = 0;
    let historyCalls = 0;
    try {
      const code = await runSmokeAttempt({
        command: 'run',
        issueNumber: SELECTIVE_ISSUE,
        prNumber: SELECTIVE_PR,
        headSha: input.headSha,
        issueBodyFile,
        smokeComplexity: 'complex',
        smokeActor: 'worker-owned',
        operatorSmokeOnly: false,
        repoRoot: input.workspace,
        cwd: input.workspace,
        dryRun: true,
        json: true,
        reviewId: '',
        reviewHeadSha: '',
      }, {
        adapter: runtime.adapter,
        resolveProfile: () => ({
          complexity: 'complex',
          family: 'cursor',
          agent: 'cursor-agent',
          command: 'cursor-agent',
          names: [
            'PACK_EXECUTOR_SMOKE_COMPLEX_AGENT',
            'PACK_EXECUTOR_SMOKE_COMPLEX_MODEL',
            'PACK_EXECUTOR_SMOKE_COMPLEX_EFFORT',
          ],
        }),
        resolveTarget: () => {
          targetCalls += 1;
          return {
            repositorySlug: REPO,
            issueNumber: SELECTIVE_ISSUE,
            prNumber: SELECTIVE_PR,
            headSha: input.headSha,
            issueBody,
            prBody,
            issueBodyMatchesTarget: true,
            trustedPublisherLogin: SELECTIVE_ACTOR,
            prOpen: true,
            baseRef: 'main',
            expectedTargetRef: 'main',
            expectedTarget: true,
          };
        },
        fetchHistoryComments: () => {
          historyCalls += 1;
          return history;
        },
        isHistoryAncestor: (ancestorSha, descendantSha) => ancestorSha === descendantSha,
      });
      const emitted = JSON.parse(String(stdout.mock.calls.at(-1)?.[0] ?? '{}')) as {
        ok?: boolean;
        report?: SmokeReport;
        selection?: { attempted?: number; carried?: number; fallbackReason?: string };
      };
      expect(code).toBe(0);
      expect(targetCalls).toBe(1);
      expect(historyCalls).toBeGreaterThan(0);
      expect(emitted).toMatchObject({
        ok: true,
        report: { result: 'PASS', terminalCleanup: 'not_started_no_execution' },
        selection: { attempted: 0, carried: 1 },
      });
      expect(emitted.selection?.fallbackReason).toBeUndefined();
      expect(emitted.report?.terminalHandle).toBeUndefined();
      expect(runtime.spawnCount()).toBe(0);
      expect(runs(input)).toHaveLength(0);
    } finally {
      stdout.mockRestore();
    }
  });

  it('unions and deduplicates valid exact-current-head affected tuples', () => {
    const parsed = parseWorkerSmokeAffectedCarrier([
      affected(SHA_B, [1, 2]),
      affected(SHA_A, [3]),
      affected(SHA_B, [2, 3]),
    ].join('\n\n'), SHA_B);
    expect(parsed.tupleKeys).toHaveLength(3);
    expect(parsed.diagnostics).toEqual([]);
  });
});
