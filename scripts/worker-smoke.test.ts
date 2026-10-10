import { describe, expect, it, vi } from 'vitest';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcessSync } from './kernel/subprocess.ts';
import { resolveTrackedGhWrapper } from './lib/gh-resolve-real-binary.mjs';
import {
  buildSmokeGhChildEnv,
  classifyDeclaredScenarioNonPassCause,
  evaluateWorkerSmokeCoverage,
  formatSmokeReportComment,
  isSmokeNonPassCause,
  normalizeSmokeReport,
  parseSmokeAgentReport,
  SMOKE_REPORT_PRODUCER,
  type SmokeReport,
  type SmokeScenario,
  type WorkerSmokeCommentRecord,
} from './lib/worker-smoke-core.ts';
import { publishCurrentWorkerAssignment, resolveWorkerAssignmentStorePath } from './lib/worker-assignment-store.ts';
import { scrubSmokeOutput } from './lib/worker-smoke-core-base.ts';
import { DeterministicRuntimeAdapter } from './runtime/test-adapter.ts';
import {
  emit,
  main,
  publishPrComment,
  runPublishSmoke,
  type PublishSmokeTarget,
  reviewIndependentRequiredCiContexts,
  runDelegatedReadiness,
  runSmokeGhProcess,
  type CliOptions,
  type ResolvedSmokeTarget,
} from './worker-smoke-run.ts';

const issueBody = `
\`\`\`behavior-kind
action-producing
\`\`\`

\`\`\`smoke-test-plan
scenarios:
  - action: run runtime lifecycle | expected: PASS
\`\`\`
`;

const HEAD_ONE = '1'.repeat(40);
const HEAD_TWO = '2'.repeat(40);
const TRUSTED_ACTOR = 'pack-publisher';
const REPOSITORY = 'chetwerikoff/orchestrator-pack';

function sharedGreenRequiredCi(headSha = HEAD_ONE) {
  return {
    state: 'green',
    green: true,
    source: 'project_card',
    reason: 'green',
    expectedHeadSha: headSha,
    postProjectionHeadSha: headSha,
    headBinding: 'inferred_current',
    selectors: [{ kind: 'actions', workflow: 'CI', job: 'checks' }],
    diagnostics: [],
  } as const;
}

describe('Issue #2346 shared required CI smoke integration', () => {
  it('keeps production smoke on the shared resolver and post-projection head witness', () => {
    const source = readFileSync(join(process.cwd(), 'scripts', 'worker-smoke-run.ts'), 'utf8');
    expect(source).toContain('resolveRequiredCi({');
    expect(source).toContain('readCurrentPr: async () => fetchLivePrBinding');
    expect(source).toContain('requiredStatusChecksEndpoint(repositorySlug, baseRef)');
    expect(source).not.toContain('classifyRequiredCiLevel(checks');
  });
});

describe('Issue #2250 scrubbed report output is redaction-only', () => {
  it('retains a PASS machine report while redacting secret-shaped scenario output', () => {
    const dangerous = 'Authorization: Bearer example-smoke-secret';
    const reportBody = formatSmokeReportComment(report('PASS', [{
      ...scenario('inspect smoke logs', 'credentials are not exposed'),
      observed: dangerous,
    }]));
    const published = scrubSmokeOutput(reportBody);
    expect(published).toContain('result: PASS');
    expect(published).toContain('Authorization: Bearer [redacted]');
    expect(published).not.toContain('example-smoke-secret');
  });
});

function planBody(scenarios: readonly { action: string; expected: string }[]): string {
  return [
    '```behavior-kind',
    'action-producing',
    '```',
    '',
    '```smoke-test-plan',
    'scenarios:',
    ...scenarios.map((entry) => `  - action: ${entry.action} | expected: ${entry.expected}`),
    '```',
  ].join('\n');
}

function scenario(
  action: string,
  expected: string,
  outcome: SmokeScenario['outcome'] = 'pass',
): SmokeScenario {
  return { action, expected, observed: `${outcome ?? 'unknown'} observed`, outcome };
}

function report(
  result: SmokeReport['result'],
  scenarios: SmokeScenario[],
  headSha = HEAD_ONE,
): SmokeReport {
  return {
    result,
    issueNumber: 1343,
    prNumber: 2001,
    headSha,
    scenarios,
    limitations: [],
    trackedFilesUnmodified: true,
    terminalCleanup: 'closed_owned_handle',
    environmentNotes: [],
    producer: SMOKE_REPORT_PRODUCER,
    orcaExecutable: 'runtime-adapter',
    terminalHandle: 'smoke-terminal-1',
  };
}

function comment(
  id: number,
  smokeReport: SmokeReport,
  options: {
    actor?: string;
    createdAt?: string;
    updatedAt?: string;
    body?: string;
  } = {},
): WorkerSmokeCommentRecord {
  const createdAt = options.createdAt ?? new Date(Date.UTC(2026, 7, 5, 0, 0, 0, id)).toISOString();
  return {
    id,
    body: options.body ?? formatSmokeReportComment(smokeReport),
    created_at: createdAt,
    updated_at: options.updatedAt ?? createdAt,
    user: { login: options.actor ?? TRUSTED_ACTOR },
  };
}

describe('review-independent required CI facts', () => {
  it('excludes the pack-review authority while preserving required CI contexts', () => {
    expect(reviewIndependentRequiredCiContexts([
      'TypeScript runtime',
      'orchestrator-pack/pack-review',
      'TypeScript strict typecheck',
    ])).toEqual([
      'TypeScript runtime',
      'TypeScript strict typecheck',
    ]);
  });
});

describe('worker smoke output', () => {
  it('serializes object verdicts in the documented non-JSON mode', () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      emit({ ok: true, report: { result: 'PASS' } }, false);
      expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({
        ok: true,
        report: { result: 'PASS' },
      });
    } finally {
      output.mockRestore();
    }
  });
});

function gateOptions(root: string, issueBodyFile: string): CliOptions {
  return {
    command: 'delegated-readiness',
    issueNumber: 1343,
    prNumber: 2001,
    headSha: HEAD_ONE,
    issueBodyFile,
    repoRoot: root,
    cwd: root,
    dryRun: false,
    json: true,
    reviewId: '',
    reviewHeadSha: '',
    reportFile: '',
  };
}

function resolvedTarget(body: string): ResolvedSmokeTarget {
  return {
    projectId: 'orchestrator-pack',
    repositorySlug: REPOSITORY,
    defaultBranch: 'main',
    issueNumber: 1343,
    prNumber: 2001,
    headSha: HEAD_ONE,
    issueBody: body,
    prBody: 'Closes #1343',
    issueBodyMatchesTarget: true,
    trustedPublisherLogin: TRUSTED_ACTOR,
    prOpen: true,
    baseRef: 'main',
    expectedTargetRef: 'main',
    expectedTarget: true,
  };
}

describe('delegated readiness consumes the production post-smoke owner', () => {
  async function runDelegatedReadinessForComments(
    root: string,
    issueBodyFile: string,
    comments: readonly WorkerSmokeCommentRecord[],
  ): Promise<{ code: number; result: { ok: boolean; readiness: { state: string; failedPredicates: string[] }; smokeEvidence: { state: string; headSha: string } } }> {
    const assignmentFile = resolveWorkerAssignmentStorePath('orchestrator-pack', process.env);
    const implementation = await publishCurrentWorkerAssignment({
      file: assignmentFile, repository: REPOSITORY, issueNumber: 1343, taskId: 'task-delegated-integration',
      kind: 'local', provider: 'orca', bindingKey: 'dispatch-implementation', role: 'worker',
    });
    if (!implementation.ok) throw new Error(implementation.reason);
    const marker = {
      prNumber: 2001, expectedHeadSha: HEAD_ONE,
      predecessorAssignmentId: implementation.assignment.assignmentId,
      predecessorGeneration: implementation.assignment.generation,
    };
    const published = await publishCurrentWorkerAssignment({
      file: assignmentFile, repository: REPOSITORY, issueNumber: 1343, taskId: 'task-delegated-integration',
      kind: 'local', provider: 'orca', bindingKey: 'dispatch-delegated-integration',
      expectedCurrent: { assignmentId: implementation.assignment.assignmentId, generation: implementation.assignment.generation },
      role: 'worker', delegatedIntegration: marker,
    });
    if (!published.ok) throw new Error(published.reason);
    const issueBodyFileContents = readFileSync(issueBodyFile, 'utf8');
    const smokeTarget: ResolvedSmokeTarget = {
      ...resolvedTarget(issueBodyFileContents), prBody: 'Closes #1343', prOpen: true,
      baseRef: 'main', expectedTargetRef: 'main', expectedTarget: true,
    };
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const code = await runDelegatedReadiness({
        ...gateOptions(root, issueBodyFile), command: 'delegated-readiness',
      }, {
        resolveTarget: () => smokeTarget, fetchCurrentHead: () => HEAD_ONE,
        selectAdapter: async () => new DeterministicRuntimeAdapter(),
        readiness: {
          resolveRequiredCi: async () => sharedGreenRequiredCi(),
          currentPackReviewStatusFact: () => ({ hasLegitimateReview: true, unresolvedBlockingFinding: false }),
          fetchCurrentHead: () => HEAD_ONE,
          fetchSmokeComments: () => [...comments],
          listDirectReviews: async () => [], isAncestor: () => false,
        },
      });
      const rendered = output.mock.calls.map((entry) => String(entry[0])).join('');
      return {
        code,
        result: JSON.parse(rendered) as {
          ok: boolean; readiness: { state: string; failedPredicates: string[] };
          smokeEvidence: { state: string; headSha: string };
        },
      };
    } finally {
      output.mockRestore();
    }
  }
  it('refuses the exact current integration assignment when exact-head smoke evidence is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'delegated-readiness-smoke-'));
    const issueBodyFile = join(root, 'issue.md');
    writeFileSync(issueBodyFile, issueBody, 'utf8');
    const previousBase = process.env.OPK_BASE_DIR;
    process.env.OPK_BASE_DIR = root;
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const assignmentFile = resolveWorkerAssignmentStorePath('orchestrator-pack', process.env);
      const implementation = await publishCurrentWorkerAssignment({
        file: assignmentFile,
        repository: REPOSITORY,
        issueNumber: 1343,
        taskId: 'task-delegated-integration',
        kind: 'local',
        provider: 'orca',
        bindingKey: 'dispatch-implementation',
        role: 'worker',
      });
      if (!implementation.ok) throw new Error(implementation.reason);
      const marker = {
        prNumber: 2001,
        expectedHeadSha: HEAD_ONE,
        predecessorAssignmentId: implementation.assignment.assignmentId,
        predecessorGeneration: implementation.assignment.generation,
      };
      const published = await publishCurrentWorkerAssignment({
        file: assignmentFile,
        repository: REPOSITORY,
        issueNumber: 1343,
        taskId: 'task-delegated-integration',
        kind: 'local',
        provider: 'orca',
        bindingKey: 'dispatch-delegated-integration',
        expectedCurrent: {
          assignmentId: implementation.assignment.assignmentId,
          generation: implementation.assignment.generation,
        },
        role: 'worker',
        delegatedIntegration: marker,
      });
      if (!published.ok) throw new Error(published.reason);
      const smokeTarget: ResolvedSmokeTarget = {
        ...resolvedTarget(issueBody),
        prBody: 'Closes #1343',
        prOpen: true,
        baseRef: 'main',
        expectedTargetRef: 'main',
        expectedTarget: true,
      };
      const options = {
        ...gateOptions(root, issueBodyFile),
        command: 'delegated-readiness',
      };
      const code = await runDelegatedReadiness(options, {
        resolveTarget: () => smokeTarget,
        fetchCurrentHead: () => HEAD_ONE,
        selectAdapter: async () => new DeterministicRuntimeAdapter(),
        readiness: {
          resolveRequiredCi: async () => sharedGreenRequiredCi(),
          currentPackReviewStatusFact: () => ({ hasLegitimateReview: true, unresolvedBlockingFinding: false }),
          fetchCurrentHead: () => HEAD_ONE,
          fetchSmokeComments: () => [],
          listDirectReviews: async () => [],
          isAncestor: () => false,
        },
      });
      const rendered = output.mock.calls.map((entry) => String(entry[0])).join('');
      const result = JSON.parse(rendered) as {
        ok: boolean;
        readiness: { state: string; failedPredicates: string[] };
        smokeEvidence: { state: string; headSha: string };
      };
      expect(code).toBe(1);
      expect(result.ok).toBe(false);
      expect(result.smokeEvidence).toEqual({ state: 'missing', headSha: HEAD_ONE });
      expect(result.readiness.state).toBe('NOT_READY');
      expect(result.readiness.failedPredicates).toContain('pr_smoke_not_passed');
    } finally {
      output.mockRestore();
      if (previousBase === undefined) delete process.env.OPK_BASE_DIR;
      else process.env.OPK_BASE_DIR = previousBase;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts an earlier-head PR PASS without author, receipt, or latest-FAIL precedence', async () => {
    const failing = {
      ...report('FAIL', [{ ...scenario('run runtime lifecycle', 'PASS', 'fail'), causeFamily: 'scenario_assertion_failed' }]),
      terminalHandle: 'terminal-fail',
    };
    const blocked = {
      ...report('BLOCKED', [scenario('run runtime lifecycle', 'PASS', 'blocked')]),
      terminalHandle: 'terminal-blocked',
    };
    const passing = {
      ...report('PASS', [scenario('run runtime lifecycle', 'PASS')]),
      terminalHandle: 'terminal-pass',
    };
    const cases = [
      { name: 'FAIL only', reports: [failing], expected: 'missing' },
      { name: 'BLOCKED only', reports: [blocked], expected: 'missing' },
      { name: 'PASS then FAIL', reports: [passing, failing], expected: 'verified' },
      { name: 'PASS then BLOCKED', reports: [passing, blocked], expected: 'verified' },
      { name: 'PASS only', reports: [passing], expected: 'verified' },
      { name: 'PASS on earlier head', reports: [{ ...passing, headSha: HEAD_TWO }], expected: 'verified' },
      { name: 'PASS from other author', reports: [passing], expected: 'verified', actor: 'other-publisher' },
      { name: 'edited PASS', reports: [passing], expected: 'verified', edited: true },
    ] as const;

    for (const testCase of cases) {
      const root = mkdtempSync(join(tmpdir(), 'delegated-readiness-smoke-census-'));
      const issueBodyFile = join(root, 'issue.md');
      writeFileSync(issueBodyFile, issueBody, 'utf8');
      const previousBase = process.env.OPK_BASE_DIR;
      const previousReceiptRoot = process.env.WORKER_SMOKE_RECEIPT_ROOT;
      process.env.OPK_BASE_DIR = root;
      process.env.WORKER_SMOKE_RECEIPT_ROOT = join(root, 'smoke-receipts');
      try {
        const comments = testCase.reports.map((smokeReport, index) => comment(index + 1, smokeReport, {
          ...('actor' in testCase ? { actor: testCase.actor } : {}),
          ...('edited' in testCase && testCase.edited ? { updatedAt: new Date(Date.UTC(2026, 7, 6)).toISOString() } : {}),
        }));
        const { code, result } = await runDelegatedReadinessForComments(root, issueBodyFile, comments);
        expect(result.smokeEvidence.state, testCase.name).toBe(testCase.expected);
        if (testCase.expected === 'missing') {
          expect(code, testCase.name).toBe(1);
          expect(result.readiness.failedPredicates, testCase.name).toContain('pr_smoke_not_passed');
        } else {
          expect(result.readiness.failedPredicates, testCase.name).not.toContain('pr_smoke_not_passed');
        }
      } finally {
        if (previousBase === undefined) delete process.env.OPK_BASE_DIR;
        else process.env.OPK_BASE_DIR = previousBase;
        if (previousReceiptRoot === undefined) delete process.env.WORKER_SMOKE_RECEIPT_ROOT;
        else process.env.WORKER_SMOKE_RECEIPT_ROOT = previousReceiptRoot;
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
  it('preserves earlier PR PASS for readiness while strict coverage blocks newest terminal-free BLOCKED', async () => {
    let published = '';
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runPublishSmoke({
        ...gateOptions('/fixture/repo', ''), command: 'publish', reportFile: '/fixture/report.md',
      }, {
        resolveTarget: () => ({
          repositorySlug: REPOSITORY, issueNumber: 1343, prNumber: 2001, issueBody,
        }),
        readReportFile: () => [
          'result: BLOCKED',
          'scenarios:',
          '  - action: run runtime lifecycle | expected: PASS | observed: dependency unavailable | outcome: blocked | cause-family: scenario_precondition_unavailable',
        ].join('\n'),
        gitStatus: () => [],
        gitHead: () => HEAD_ONE,
        publishComment: (_pr, body) => { published = body; return 'https://github.com/comment'; },
      });
    } finally {
      output.mockRestore();
    }
    expect(parseSmokeAgentReport(published)?.nonPassCause).toBe('scenario_precondition_unavailable');

    // The earlier PASS is a synthetic terminal-owned strict-valid fixture.
    // No terminal provenance is invented for the publisher's newer BLOCKED.
    const terminalOwnedPass = formatSmokeReportComment(report('PASS', [
      scenario('run runtime lifecycle', 'PASS'),
    ])).replace(
      'producer: ' + SMOKE_REPORT_PRODUCER + '\n',
      'producer: ' + SMOKE_REPORT_PRODUCER
        + '\nterminal-handle: smoke-terminal-1\norca-executable: runtime-adapter\nterminal-cleanup: closed_owned_handle\n',
    );
    const earlierPass = comment(1, report('PASS', [
      scenario('run runtime lifecycle', 'PASS'),
    ]), { body: terminalOwnedPass });
    const laterBlocked = comment(2, report('BLOCKED', [{
      ...scenario('run runtime lifecycle', 'PASS', 'blocked'),
      causeFamily: 'scenario_precondition_unavailable',
    }]), { body: published });
    const target = {
      repositorySlug: REPOSITORY, issueNumber: 1343, prNumber: 2001, headSha: HEAD_ONE,
      resolvedIssueNumber: 1343, resolvedPrNumber: 2001, liveHeadSha: HEAD_ONE,
      issueBodyMatchesTarget: true, trustedPublisherLogin: TRUSTED_ACTOR,
      commentCensusComplete: true, commentSnapshotStable: true,
    };
    expect(evaluateWorkerSmokeCoverage({ issueBody, comments: [earlierPass], target }).accepting).toBe(true);
    const strictBoth = evaluateWorkerSmokeCoverage({
      issueBody, comments: [earlierPass, laterBlocked], target,
    });
    expect(strictBoth.accepting).toBe(false);
    expect(strictBoth.latestClearingPass?.result).toBe('PASS');
    expect(strictBoth.diagnostics.globalBlock).toMatchObject({
      blocked: true, kind: 'invalid_candidate', reason: 'terminal_handle_missing_or_invalid',
    });
    const strictBlockedOnly = evaluateWorkerSmokeCoverage({ issueBody, comments: [laterBlocked], target });
    expect(strictBlockedOnly.accepting).toBe(false);
    expect(strictBlockedOnly.diagnostics.globalBlock.blocked).toBe(true);

    for (const fixture of [
      { comments: [earlierPass, laterBlocked], expected: 'verified' },
      { comments: [laterBlocked], expected: 'missing' },
    ]) {
      const root = mkdtempSync(join(tmpdir(), 'smoke-readiness-2454-'));
      const issueFile = join(root, 'issue.md');
      writeFileSync(issueFile, issueBody, 'utf8');
      const previous = process.env.OPK_BASE_DIR;
      process.env.OPK_BASE_DIR = root;
      try {
        const { result } = await runDelegatedReadinessForComments(root, issueFile, fixture.comments);
        expect(result.smokeEvidence.state).toBe(fixture.expected);
        if (fixture.expected === 'missing') {
          expect(result.readiness.failedPredicates).toContain('pr_smoke_not_passed');
        } else {
          expect(result.readiness.failedPredicates).not.toContain('pr_smoke_not_passed');
        }
      } finally {
        if (previous === undefined) delete process.env.OPK_BASE_DIR;
        else process.env.OPK_BASE_DIR = previous;
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

});

function executable(path: string, source: string): void {
  writeFileSync(path, source, 'utf8');
  chmodSync(path, 0o755);
}

function runChild(
  command: string,
  args: readonly string[],
  _options: { readonly encoding?: string } = {},
): { status: number; stdout: string; stderr: string } {
  const result = runProcessSync({
    command,
    args,
    inheritParentEnv: true,
  });
  return {
    status: result.exitCode ?? (result.ok ? 0 : 1),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function selectSmokeProjectForTest(configRoot: string, primaryRoot: string): () => void {
  const oldXdg = process.env.XDG_CONFIG_HOME;
  const oldProject = process.env.OPK_PROJECT_ID;
  const xdg = join(configRoot, 'project-config');
  const cards = join(xdg, 'orchestrator-pack', 'projects');
  mkdirSync(cards, { recursive: true });
  writeFileSync(join(cards, 'smoke-fixture.json'), JSON.stringify({
    projectId: 'smoke-fixture',
    repository: REPOSITORY,
    primaryRoot,
    defaultBranch: 'main',
    orcaWorkspacePattern: '.*',
    orchestratorTitlePattern: '.*',
    browserGpt: { projectUrl: 'https://chatgpt.com/' },
  }), 'utf8');
  process.env.XDG_CONFIG_HOME = xdg;
  process.env.OPK_PROJECT_ID = 'smoke-fixture';
  return () => {
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdg;
    if (oldProject === undefined) delete process.env.OPK_PROJECT_ID;
    else process.env.OPK_PROJECT_ID = oldProject;
  };
}

describe('publishPrComment', () => {
  it('executes the one comment POST through tracked scripts/gh under the minimal smoke child environment', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-publish-native-'));
    const restoreProject = selectSmokeProjectForTest(root, process.cwd());
    const calls: Parameters<typeof runProcessSync>[0][] = [];
    const runner: typeof runProcessSync = (options) => {
      calls.push(options);
      return {
        outcome: 'exit',
        ok: true,
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({
          html_url: 'https://github.com/chetwerikoff/orchestrator-pack/issues/1586#issuecomment-1',
        }),
        stderr: '',
        timedOut: false,
        cancelled: false,
      };
    };
    try {
      expect(publishPrComment(1586, 'hello', process.cwd(), 250, runner)).toBe(
        'https://github.com/chetwerikoff/orchestrator-pack/issues/1586#issuecomment-1',
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        command: resolveTrackedGhWrapper(),
        args: [
          'api',
          'repos/chetwerikoff/orchestrator-pack/issues/1586/comments',
          '--method',
          'POST',
          '--input',
          expect.any(String),
        ],
        cwd: process.cwd(),
        env: {},
        timeoutMs: 250,
      });
      expect(buildSmokeGhChildEnv({})).toEqual({});
    } finally {
      restoreProject();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['pending', 8],
    ['failed', 1],
  ] as const)('accepts canonical pr-checks %s exit without retrying transport', (_label, exitCode) => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-gh-pr-checks-'));
    const gh = join(root, 'gh');
    const callsFile = join(root, 'calls.txt');
    executable(gh, `#!${process.execPath}\nconst { appendFileSync } = require('node:fs');\nappendFileSync(${JSON.stringify(callsFile)}, 'call\\n', 'utf8');\nprocess.stdout.write(JSON.stringify([{ workflow: 'CI', name: 'checks', state: '${exitCode === 8 ? 'PENDING' : 'FAILURE'}' }]));\nprocess.exitCode = ${exitCode};\n`);
    try {
      const result = runSmokeGhProcess(
        gh,
        ['pr', 'checks', '2001'],
        root,
        buildSmokeGhChildEnv({}),
        500,
        [0, 1, 8],
      );
      expect(result.exitCode).toBe(exitCode);
      expect(JSON.parse(result.stdout)).toEqual([
        expect.objectContaining({ workflow: 'CI', name: 'checks' }),
      ]);
      expect(readFileSync(callsFile, 'utf8').trim().split(/\r?\n/u)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('times out and retries a hung gh invocation once', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-gh-timeout-'));
    const hungGh = join(root, 'gh');
    const callsFile = join(root, 'calls.txt');
    executable(hungGh, `#!${process.execPath}\nconst { appendFileSync } = require('node:fs');\nappendFileSync(${JSON.stringify(callsFile)}, 'call\\n', 'utf8');\nsetTimeout(() => {}, 1000);\n`);
    try {
      const result = runSmokeGhProcess(hungGh, ['api'], root, buildSmokeGhChildEnv({}), 500);
      expect(result.ok).toBe(false);
      expect(readFileSync(callsFile, 'utf8').trim().split(/\r?\n/u)).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports one failed publication attempt when tracked gh fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-publication-failure-'));
    const restoreProject = selectSmokeProjectForTest(root, process.cwd());
    let calls = 0;
    const runner: typeof runProcessSync = () => {
      calls += 1;
      return {
        outcome: 'exit',
        ok: false,
        exitCode: 1,
        signal: null,
        stdout: '',
        stderr: 'forced failure',
        timedOut: false,
        cancelled: false,
      };
    };
    try {
      expect(() => publishPrComment(1586, 'hello', process.cwd(), 25, runner)).toThrow(/comment_publish_failed/u);
      expect(calls).toBe(1);
    } finally {
      restoreProject();
      rmSync(root, { recursive: true, force: true });
    }
  });
});


describe('Issue #2319 terminal-free publish', () => {
  it('rejects --head-sha as a publish input', async () => {
    await expect(main(['publish', '--head-sha', HEAD_ONE])).rejects.toThrow('publish does not accept --head-sha');
  });

  const publishPlanBody = planBody([
    { action: 'exercise publish scenario A', expected: 'scenario A passes' },
    { action: 'exercise publish scenario B', expected: 'scenario B passes' },
  ]);
  const publishTarget: PublishSmokeTarget = {
    repositorySlug: REPOSITORY,
    issueNumber: 1343,
    prNumber: 2001,
    issueBody: publishPlanBody,
  };
  const publishOptions = (reportFile = '/fixture/report.md'): CliOptions => ({
    command: 'publish',
    issueNumber: 1343,
    prNumber: 2001,
    headSha: '',
    issueBodyFile: '',
    repoRoot: '/fixture/repo',
    cwd: '/fixture/repo',
    dryRun: false,
    json: true,
    reviewId: '',
    reviewHeadSha: '',
    reportFile,
  });
  const reportText = (result: 'PASS' | 'FAIL' | 'BLOCKED', rows: readonly SmokeScenario[], nonPassCause?: string) => [
    'result: ' + result,
    ...(nonPassCause ? ['non-pass-cause: ' + nonPassCause] : []),
    'scenarios:',
    ...rows.map((row) => {
      const parts = [
        'action: ' + row.action,
        'expected: ' + row.expected,
        'observed: ' + (row.observed ?? ''),
        'outcome: ' + (row.outcome ?? ''),
      ];
      if (row.causeFamily) parts.push('cause-family: ' + row.causeFamily);
      return '  - ' + parts.join(' | ');
    }),
  ].join('\n');

  it('publishes a terminal-free PASS from local HEAD and emits the confirmed comment URL', async () => {
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const comments: string[] = [];
    try {
      const code = await runPublishSmoke(publishOptions(), {
        resolveTarget: () => publishTarget,
        readReportFile: () => reportText('PASS', [
          scenario('exercise publish scenario A', 'scenario A passes'),
          scenario('exercise publish scenario B', 'scenario B passes'),
        ]),
        gitStatus: () => ['?? report.md'],
        gitHead: () => HEAD_ONE,
        publishComment: (_pr, body) => {
          comments.push(body);
          return 'https://github.com/chetwerikoff/orchestrator-pack/issues/2001#issuecomment-1';
        },
      });
      expect(code).toBe(0);
      expect(comments).toHaveLength(1);
      expect(comments[0]).toContain('head-sha: `' + HEAD_ONE + '`');
      expect(comments[0]).not.toContain('terminal-handle');
      expect(comments[0]).not.toContain('orca-executable');
      expect(comments[0]).not.toContain('terminal-cleanup');
      expect(comments[0]).not.toContain('orca-terminal-cleanup');
      const emitted = JSON.parse(writes.join('').trim()) as Record<string, unknown>;
      expect(emitted).toMatchObject({
        schema: 'pack-worker-smoke-report/v1',
        producer: SMOKE_REPORT_PRODUCER,
        issueNumber: 1343,
        prNumber: 2001,
        headSha: HEAD_ONE,
        result: 'PASS',
        trackedFilesUnmodified: true,
        commentUrl: 'https://github.com/chetwerikoff/orchestrator-pack/issues/2001#issuecomment-1',
      });
      expect(emitted).not.toHaveProperty('terminalCleanup');
      expect(emitted).not.toHaveProperty('terminalHandle');
      expect(emitted).not.toHaveProperty('orcaExecutable');
    } finally {
      stdout.mockRestore();
    }
  });

  it('redacts JSON-escaped forwarded and config-home credentials before publish output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-publish-secret-'));
    const configDir = join(root, '.config', 'gh');
    mkdirSync(configDir, { recursive: true });
    const configSecret = 'config-secret-"quoted"\\path';
    const forwardedSecret = 'forwarded-secret-"quoted"\\path';
    writeFileSync(join(configDir, 'hosts.yml'), `github.com:\n  oauth_token: ${configSecret}\n`, 'utf8');
    vi.stubEnv('HOME', root);
    vi.stubEnv('GH_TOKEN', forwardedSecret);
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const comments: string[] = [];
    try {
      const code = await runPublishSmoke(publishOptions(), {
        resolveTarget: () => publishTarget,
        readReportFile: () => reportText('PASS', [
          {
            ...scenario('exercise publish scenario A', 'scenario A passes'),
            observed: `${forwardedSecret} ${configSecret}`,
          },
          scenario('exercise publish scenario B', 'scenario B passes'),
        ]),
        gitStatus: () => [],
        gitHead: () => HEAD_ONE,
        publishComment: (_pr, body) => {
          comments.push(body);
          return 'https://github.com/comment';
        },
      });
      expect(code).toBe(0);
      const output = comments.join('\n') + writes.join('');
      for (const secret of [forwardedSecret, configSecret]) {
        expect(output).not.toContain(secret);
        expect(output).not.toContain(JSON.stringify(secret).slice(1, -1));
      }
      expect(output).toContain('[redacted-secret]');
    } finally {
      stdout.mockRestore();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses mismatched PASS tuples, dirty worktrees, and PASS non-pass evidence before POST', async () => {
    let posts = 0;
    const deps = {
      resolveTarget: () => publishTarget,
      gitHead: () => HEAD_ONE,
      publishComment: () => { posts += 1; return 'https://github.com/comment'; },
    };
    const validRows = [
      scenario('exercise publish scenario A', 'scenario A passes'),
      scenario('exercise publish scenario B', 'scenario B passes'),
    ];
    await expect(runPublishSmoke(publishOptions(), {
      ...deps,
      readReportFile: () => reportText('PASS', [...validRows].reverse()),
      gitStatus: () => [],
    })).rejects.toThrow(/report_plan_mismatch/);
    expect(posts).toBe(0);

    await expect(runPublishSmoke(publishOptions(), {
      ...deps,
      readReportFile: () => reportText('PASS', validRows),
      gitStatus: () => [' M scripts/example.ts'],
    })).rejects.toThrow(/tracked_worktree_dirty/);
    expect(posts).toBe(0);

    await expect(runPublishSmoke(publishOptions(), {
      ...deps,
      readReportFile: () => reportText('PASS', validRows, 'executed_scenario_failure'),
      gitStatus: () => [],
    })).rejects.toThrow('report_normalization_failed: pass_cannot_have_non_pass_cause');
    expect(posts).toBe(0);
  });

  it('publishes a truthful early non-PASS prefix with structured evidence and exits zero', async () => {
    let posted = '';
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const code = await runPublishSmoke(publishOptions(), {
        resolveTarget: () => publishTarget,
        readReportFile: () => reportText('FAIL', [{
          ...scenario('exercise publish scenario A', 'scenario A passes', 'fail'),
          causeFamily: 'scenario_assertion_failed',
        }], 'executed_scenario_failure'),
        gitStatus: () => [],
        gitHead: () => HEAD_ONE,
        publishComment: (_pr, body) => {
          posted = body;
          return 'https://github.com/chetwerikoff/orchestrator-pack/issues/2001#issuecomment-2';
        },
      });
      expect(code).toBe(0);
      expect(posted).toContain('cause-family: scenario_assertion_failed');
      expect(posted).toContain('non-pass-cause: executed_scenario_failure');
      expect(JSON.parse(writes.join('').trim())).toMatchObject({
        result: 'FAIL',
        causeFamily: 'scenario_assertion_failed',
        nonPassCause: 'executed_scenario_failure',
      });
    } finally {
      stdout.mockRestore();
    }
  });
  it('recognizes the generic cause and only derives it from a terminal blocked precondition', () => {
    expect(isSmokeNonPassCause('scenario_precondition_unavailable')).toBe(true);
    expect(isSmokeNonPassCause('unsupported_executor_capability')).toBe(true);
    const terminal: SmokeScenario = {
      ...scenario('exercise publish scenario A', 'scenario A passes', 'blocked'),
      causeFamily: 'scenario_precondition_unavailable',
    };
    const classify = (result: 'PASS' | 'FAIL' | 'BLOCKED', rows: SmokeScenario[]) =>
      classifyDeclaredScenarioNonPassCause({
        partial: { result, scenarios: rows }, agentActivityObserved: false,
      });
    expect(classify('BLOCKED', [terminal])).toBe('scenario_precondition_unavailable');
    expect(classify('BLOCKED', [
      scenario('exercise publish scenario A', 'scenario A passes'), terminal,
    ])).toBe('scenario_precondition_unavailable');
    expect(classify('FAIL', [terminal])).toBeUndefined();
    expect(classify('BLOCKED', [{ ...terminal, causeFamily: 'scenario_evidence_missing' }])).toBeUndefined();
    expect(classify('FAIL', [{
      ...scenario('exercise publish scenario A', 'scenario A passes', 'fail'),
      causeFamily: 'scenario_assertion_failed',
    }])).toBe('executed_scenario_failure');
    expect(classify('BLOCKED', [
      scenario('exercise publish scenario A', 'scenario A passes', 'skipped'),
    ])).toBeUndefined();
    expect(classifyDeclaredScenarioNonPassCause({
      partial: null, agentActivityObserved: true, agentCompleted: true,
    })).toBe('missing_agent_report');
    expect(classifyDeclaredScenarioNonPassCause({
      zeroParsedScenarios: true, partial: null, agentActivityObserved: false,
    })).toBe('zero_parsed_scenarios');
  });

  it('publishes exact single and mixed precondition BLOCKED reports in one comment and JSON each', async () => {
    const blocked = (action: string, expected: string): SmokeScenario => ({
      ...scenario(action, expected, 'blocked'), causeFamily: 'scenario_precondition_unavailable',
    });
    const single = [blocked('exercise publish scenario A', 'scenario A passes')];
    const mixed = [
      scenario('exercise publish scenario A', 'scenario A passes'),
      scenario('exercise publish scenario B', 'scenario B passes'),
      blocked('exercise publish scenario C', 'scenario C can start'),
    ];
    for (const fixture of [
      { name: 'single absent', rows: single, explicit: false },
      { name: 'mixed absent', rows: mixed, explicit: false },
      { name: 'single explicit', rows: single, explicit: true },
    ]) {
      const writes: string[] = [];
      const posted: string[] = [];
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk)); return true;
      }) as typeof process.stdout.write);
      try {
        const code = await runPublishSmoke(publishOptions(), {
          resolveTarget: () => ({
            ...publishTarget,
            issueBody: planBody(fixture.rows.map((row) => ({ action: row.action, expected: row.expected }))),
          }),
          readReportFile: () => reportText('BLOCKED', fixture.rows,
            fixture.explicit ? 'scenario_precondition_unavailable' : undefined),
          gitStatus: () => ['?? synthetic-report.md'],
          gitHead: () => HEAD_ONE,
          publishComment: (_pr, body) => {
            posted.push(body);
            return 'https://github.com/chetwerikoff/orchestrator-pack/issues/2001#issuecomment-2454';
          },
        });
        expect(code, fixture.name).toBe(0);
        expect(posted, fixture.name).toHaveLength(1);
        const parsed = parseSmokeAgentReport(posted[0]);
        expect(parsed?.result).toBe('BLOCKED');
        expect(parsed?.nonPassCause).toBe('scenario_precondition_unavailable');
        expect(parsed?.causeFamily).toBe('scenario_precondition_unavailable');
        expect(parsed?.scenarios?.map((row) => row.outcome)).toEqual(fixture.rows.map((row) => row.outcome));
        const normalized = normalizeSmokeReport(parsed!, { issueNumber: 1343, prNumber: 2001, headSha: HEAD_ONE });
        expect(normalized.ok).toBe(true);
        if (normalized.ok) expect(normalized.report.nonPassCause).toBe('scenario_precondition_unavailable');
        const emitted = JSON.parse(writes.join('').trim()) as Record<string, unknown>;
        expect(emitted).toMatchObject({
          result: 'BLOCKED', nonPassCause: 'scenario_precondition_unavailable',
          causeFamily: 'scenario_precondition_unavailable', headSha: HEAD_ONE,
          issueNumber: 1343, prNumber: 2001,
        });
        expect(emitted.scenarios).toHaveLength(fixture.rows.length);
        expect(posted[0]).not.toContain('executed_scenario_failure');
        expect(posted[0]).not.toContain('terminal-handle');
      } finally {
        stdout.mockRestore();
      }
    }
  });

  it('rejects invalid raw cause, mismatched results and unsupported surrogates with zero POSTs', async () => {
    const blocked: SmokeScenario[] = [{
      ...scenario('exercise publish scenario A', 'scenario A passes', 'blocked'),
      causeFamily: 'scenario_precondition_unavailable',
    }];
    const original = reportText('BLOCKED', blocked);
    const causeLine = (cause: string) => original.replace('scenarios:', 'non-pass-cause: ' + cause + '\nscenarios:');
    const cases = [
      { name: 'unknown explicit', text: causeLine('invented_subtype') },
      { name: 'blank explicit', text: causeLine('') },
      { name: 'duplicate explicit', text: original.replace('scenarios:',
        'non-pass-cause: scenario_precondition_unavailable\nnon-pass-cause: scenario_precondition_unavailable\nscenarios:') },
      { name: 'malformed explicit', text: original.replace('scenarios:',
        'non-pass-cause = scenario_precondition_unavailable\nscenarios:') },
      ...[
        'unsupported_executor_capability', 'missing_agent_report', 'zero_parsed_scenarios',
        'executed_scenario_failure', 'login_required',
      ].map((cause) => ({ name: 'unsupported ' + cause, text: causeLine(cause) })),
      { name: 'FAIL with blocked', text: reportText('FAIL', blocked, 'scenario_precondition_unavailable') },
      { name: 'BLOCKED with fail', text: reportText('BLOCKED', [{
        ...scenario('exercise publish scenario A', 'scenario A passes', 'fail'),
        causeFamily: 'scenario_assertion_failed',
      }], 'executed_scenario_failure') },
      { name: 'multiple terminal rows', text: reportText('BLOCKED', [blocked[0], {
        ...scenario('exercise publish scenario B', 'scenario B passes', 'blocked'),
        causeFamily: 'scenario_precondition_unavailable',
      }]) },
      { name: 'missing family', text: reportText('BLOCKED', [
        scenario('exercise publish scenario A', 'scenario A passes', 'blocked'),
      ]) },
      { name: 'unknown family', text: original.replace(
        'cause-family: scenario_precondition_unavailable', 'cause-family: alien_family',
      ) },
      { name: 'wrong plan identity', text: reportText('BLOCKED', [{
        ...blocked[0], expected: 'different assertion',
      }]) },
      { name: 'extra plan row', text: reportText('BLOCKED', [
        scenario('exercise publish scenario A', 'scenario A passes'),
        scenario('exercise publish scenario B', 'scenario B passes'),
        blocked[0],
      ]) },
      { name: 'skipped prefix', text: reportText('BLOCKED', [
        scenario('exercise publish scenario A', 'scenario A passes', 'skipped'),
        { ...scenario('exercise publish scenario B', 'scenario B passes', 'blocked'),
          causeFamily: 'scenario_precondition_unavailable' },
      ]) },
      { name: 'tracked worktree dirty', text: original, dirty: true },
      { name: 'PASS with cause', text: reportText('PASS', [
        scenario('exercise publish scenario A', 'scenario A passes'),
        scenario('exercise publish scenario B', 'scenario B passes'),
      ], 'scenario_precondition_unavailable') },
    ];
    for (const testCase of cases) {
      let posts = 0;
      await expect(runPublishSmoke(publishOptions(), {
        resolveTarget: () => publishTarget,
        readReportFile: () => testCase.text,
        gitStatus: () => ('dirty' in testCase && testCase.dirty) ? [' M scripts/example.ts'] : [],
        gitHead: () => HEAD_ONE,
        publishComment: () => { posts += 1; return 'https://github.com/comment'; },
      }), testCase.name).rejects.toThrow(
        /report_file_invalid|report_plan_mismatch|report_normalization_failed|tracked_worktree_dirty/,
      );
      expect(posts, testCase.name).toBe(0);
    }
  });

});
