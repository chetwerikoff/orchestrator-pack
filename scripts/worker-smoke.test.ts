import { describe, expect, it, vi } from 'vitest';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runProcessSync } from './kernel/subprocess.ts';
import { resolveRealGhBinary, resolveTrackedGhWrapper } from './lib/gh-resolve-real-binary.mjs';
import {
  buildSmokeGhChildEnv,
  evaluateWorkerSmokeCoverage,
  evaluateWorkerSmokeGate,
  formatSmokeReportComment,
  SMOKE_REPORT_PRODUCER,
  type SmokeReport,
  type SmokeScenario,
  type WorkerSmokeCommentRecord,
  type WorkerSmokeTrustedTarget,
} from './lib/worker-smoke-core.ts';
import { publishCurrentWorkerAssignment, resolveWorkerAssignmentStorePath } from './lib/worker-assignment-store.ts';
import { scrubSmokeOutput } from './lib/worker-smoke-core-base.ts';
import { DeterministicRuntimeAdapter } from './runtime/test-adapter.ts';
import {
  emit,
  parsePaginatedSmokeComments,
  publishPrComment,
  runPublishSmoke,
  type PublishSmokeTarget,
  reviewIndependentRequiredCiContexts,
  runDelegatedReadiness,
  runSmokeGhProcess,
  runSmokeGhWriteSync,
  smokeCommentSnapshotDigest,
  stabilizeSmokeCommentCensus,
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

function target(overrides: Partial<WorkerSmokeTrustedTarget> = {}): WorkerSmokeTrustedTarget {
  return {
    repositorySlug: REPOSITORY,
    issueNumber: 1343,
    prNumber: 2001,
    headSha: HEAD_ONE,
    resolvedIssueNumber: 1343,
    resolvedPrNumber: 2001,
    liveHeadSha: HEAD_ONE,
    issueBodyMatchesTarget: true,
    trustedPublisherLogin: TRUSTED_ACTOR,
    commentCensusComplete: true,
    commentSnapshotStable: true,
    ...overrides,
  };
}

function coverage(
  comments: readonly WorkerSmokeCommentRecord[],
  body: string,
  targetOverrides: Partial<WorkerSmokeTrustedTarget> = {},
) {
  return evaluateWorkerSmokeCoverage({ issueBody: body, comments, target: target(targetOverrides) });
}

function mutateMachineBlock(body: string, mutate: (block: string) => string): string {
  const start = body.indexOf('```worker-smoke-report\n');
  const end = body.indexOf('\n```', start + 1);
  if (start < 0 || end < 0) throw new Error('machine report block missing');
  return `${body.slice(0, start)}${mutate(body.slice(start, end))}${body.slice(end)}`;
}






describe('review-independent required CI facts', () => {
  it('excludes the pack-review authority while preserving required CI contexts', () => {
    expect(reviewIndependentRequiredCiContexts([
      'TypeScript runtime (Node 22)',
      'orchestrator-pack/pack-review',
      'TypeScript strict typecheck',
    ])).toEqual([
      'TypeScript runtime (Node 22)',
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

describe('exact-head cross-run worker-smoke coverage', () => {
  const AB = planBody([
    { action: 'A', expected: 'A passes' },
    { action: 'B', expected: 'B passes' },
  ]);
  const A = planBody([{ action: 'A', expected: 'A passes' }]);

  it('preserves one canonical all-PASS report compatibility', () => {
    const result = coverage([
      comment(1, report('PASS', [scenario('A', 'A passes'), scenario('B', 'B passes')])),
    ], AB);
    expect(result.accepting).toBe(true);
    expect(result.diagnostics.coverage).toBe('complete');
  });

  it('accumulates tuples while omission preserves prior PASS and clears quarantine', () => {
    const result = coverage([
      comment(1, report('FAIL', [scenario('A', 'A passes'), scenario('B', 'B passes', 'fail')])),
      comment(2, report('PASS', [scenario('B', 'B passes')])),
    ], AB);
    expect(result.accepting).toBe(true);
    expect(result.diagnostics.covered.total).toBe(2);
  });

  it('orders row revocation and restoration by created_at then numeric id', () => {
    const sameTime = '2026-08-05T00:00:00.000Z';
    const result = coverage([
      comment(3, report('PASS', [scenario('A', 'A passes')]), { createdAt: sameTime }),
      comment(1, report('PASS', [scenario('A', 'A passes')]), { createdAt: sameTime }),
      comment(2, report('FAIL', [scenario('A', 'A passes', 'blocked')]), { createdAt: sameTime }),
    ], A);
    expect(result.accepting).toBe(true);
    expect(result.diagnostics.covered.items[0]?.commentId).toBe(3);
  });

  it('applies zero-current-tuple global blocks and clears them with later PASS', () => {
    const blocked = coverage([
      comment(1, report('PASS', [scenario('A', 'A passes')])),
      comment(2, report('BLOCKED', [{ ...scenario('unknown', 'unknown', 'blocked'), causeFamily: 'scenario_precondition_unavailable' }])),
    ], A);
    expect(blocked.accepting).toBe(false);
    expect(blocked.diagnostics.globalBlock.kind).toBe('BLOCKED');

    const cleared = coverage([
      comment(1, report('PASS', [scenario('A', 'A passes')])),
      comment(2, report('BLOCKED', [{ ...scenario('unknown', 'unknown', 'blocked'), causeFamily: 'scenario_precondition_unavailable' }])),
      comment(3, report('PASS', [scenario('unknown', 'unknown')])),
    ], A);
    expect(cleared.accepting).toBe(true);
    expect(cleared.diagnostics.covered.items[0]?.commentId).toBe(1);
  });

  it('keeps row state across an invalid candidate and later clearing PASS', () => {
    const result = coverage([
      comment(1, report('PASS', [scenario('A', 'A passes')])),
      comment(2, report('FAIL', [
        scenario('A', 'A passes', 'fail'),
        scenario('A', 'A passes', 'blocked'),
      ])),
      comment(3, report('PASS', [scenario('unknown', 'unknown')])),
    ], A);
    expect(result.accepting).toBe(true);
    expect(result.diagnostics.covered.items[0]?.commentId).toBe(1);
    expect(result.diagnostics.invalidCandidates.total).toBe(1);
  });

  it.each([
    ['missing observed', (body: string) => mutateMachineBlock(body, (block) => block.replace('observed: pass observed', 'observed: '))],
    ['unsupported outcome', (body: string) => mutateMachineBlock(body, (block) => block.replace('outcome: pass', 'outcome: mystery'))],
    ['identical duplicate row', (_body: string) => formatSmokeReportComment(report('FAIL', [
      scenario('A', 'A passes', 'fail'),
      scenario('A', 'A passes', 'fail'),
    ]))],
    ['conflicting duplicate row', (_body: string) => formatSmokeReportComment(report('FAIL', [
      scenario('A', 'A passes', 'fail'),
      scenario('A', 'A passes', 'blocked'),
    ]))],
  ])('rejects the whole trusted candidate for %s', (_name, mutate) => {
    const canonical = formatSmokeReportComment(report('PASS', [scenario('A', 'A passes')]));
    const result = coverage([
      comment(1, report('PASS', [scenario('A', 'A passes')]), { body: mutate(canonical) }),
    ], A);
    expect(result.accepting).toBe(false);
    expect(result.diagnostics.invalidCandidates.total).toBe(1);
    expect(result.diagnostics.covered.total).toBe(0);
  });

  it.each([
    ['duplicate marker', (body: string) => `<!-- pack-worker-smoke-report/v1 -->\n${body}`],
    ['two report blocks', (body: string) => `${body}\n\`\`\`worker-smoke-report\nresult: FAIL\n\`\`\``],
    ['duplicate target line', (body: string) => `${body}\n- pr: #2001`],
    ['mixed target metadata', (body: string) => `${body}\n- head-sha: \`${HEAD_TWO}\``],
  ])('invalidates a current-target envelope with %s', (_name, mutate) => {
    const canonical = formatSmokeReportComment(report('PASS', [scenario('A', 'A passes')]));
    const result = coverage([
      comment(1, report('PASS', [scenario('A', 'A passes')]), { body: mutate(canonical) }),
    ], A);
    expect(result.accepting).toBe(false);
    expect(result.diagnostics.invalidCandidates.total).toBe(1);
  });

  it('treats another actor as non-candidate and a trusted edit as invalid', () => {
    const foreign = coverage([
      comment(1, report('PASS', [scenario('A', 'A passes')]), { actor: 'someone-else' }),
    ], A);
    expect(foreign.diagnostics.invalidCandidates.total).toBe(0);
    expect(foreign.diagnostics.missing.total).toBe(1);

    const createdAt = '2026-08-05T00:00:00.000Z';
    const edited = coverage([
      comment(1, report('PASS', [scenario('A', 'A passes')]), {
        createdAt,
        updatedAt: '2026-08-05T00:01:00.000Z',
      }),
    ], A);
    expect(edited.diagnostics.invalidCandidates.items[0]?.reason).toBe('candidate_edited');
  });

  it('flattens all pages and observes later-page revocation', () => {
    const first = comment(1, report('PASS', [scenario('A', 'A passes')]));
    const second = comment(2, report('FAIL', [scenario('A', 'A passes', 'fail')]));
    const parsed = parsePaginatedSmokeComments(JSON.stringify([[first], [second]]));
    expect(parsed).toHaveLength(2);
    expect(coverage(parsed, A).accepting).toBe(false);
    expect(() => parsePaginatedSmokeComments(JSON.stringify([first, second]))).toThrow(/slurped page array/u);
  });

  it('re-evaluates a growing high-water snapshot and refuses endless churn', () => {
    const pass = comment(1, report('PASS', [scenario('A', 'A passes')]));
    const revoke = comment(2, report('FAIL', [scenario('A', 'A passes', 'fail')]));
    const sequence = [[pass], [pass, revoke], [pass, revoke]];
    let index = 0;
    const stable = stabilizeSmokeCommentCensus(() => sequence[Math.min(index++, sequence.length - 1)]!);
    expect(coverage(stable, A).accepting).toBe(false);

    let id = 10;
    expect(() => stabilizeSmokeCommentCensus(
      () => [comment(id++, report('PASS', [scenario('A', 'A passes')]))],
      2,
    )).toThrow(/failed to stabilize/u);
  });

  it('applies post-ready revocation only on the next evaluation', () => {
    const pass = comment(1, report('PASS', [scenario('A', 'A passes')]));
    const ready = coverage([pass], A);
    const later = coverage([
      pass,
      comment(2, report('FAIL', [scenario('A', 'A passes', 'fail')])),
    ], A);
    expect(ready.accepting).toBe(true);
    expect(later.accepting).toBe(false);
  });

  it('resets absolutely on a new head without old-head diagnostics', () => {
    const result = coverage([
      comment(1, report('PASS', [scenario('A', 'A passes')], HEAD_ONE)),
    ], A, { headSha: HEAD_TWO, liveHeadSha: HEAD_TWO });
    expect(result.accepting).toBe(false);
    expect(result.diagnostics.covered.total).toBe(0);
    expect(result.diagnostics.invalidCandidates.total).toBe(0);
  });

  it.each([
    ['missing repository', { repositorySlug: undefined }],
    ['zero Issue', { issueNumber: 0, resolvedIssueNumber: 0 }],
    ['wrong Issue resolution', { resolvedIssueNumber: 999 }],
    ['wrong PR resolution', { resolvedPrNumber: 999 }],
    ['wrong Issue body', { issueBodyMatchesTarget: false }],
    ['head changed', { liveHeadSha: HEAD_TWO }],
    ['principal missing', { trustedPublisherLogin: '' }],
    ['census incomplete', { commentCensusComplete: false }],
    ['snapshot unstable', { commentSnapshotStable: false }],
  ])('fails target admission before contribution for %s', (_name, overrides) => {
    const result = coverage([
      comment(1, report('PASS', [scenario('A', 'A passes')])),
    ], A, overrides);
    expect(result.accepting).toBe(false);
    expect(result.diagnostics.covered.total).toBe(0);
  });

  it('reuses unchanged tuples but not changed tuples after a same-head Issue edit', () => {
    const observation = comment(1, report('PASS', [
      scenario('A', 'A passes'),
      scenario('B', 'B passes'),
    ]));
    expect(coverage([observation], AB).accepting).toBe(true);

    const edited = coverage([observation], planBody([
      { action: 'A', expected: 'A passes' },
      { action: 'C', expected: 'C changed' },
    ]));
    expect(edited.accepting).toBe(false);
    expect(edited.diagnostics.covered.total).toBe(1);
    expect(edited.diagnostics.missing.items[0]?.tuple).toContain('C');
  });

  it('orders authority independently from input and receipt order', () => {
    const timestamp = '2026-08-05T00:00:00.000Z';
    const fail = comment(1, report('FAIL', [scenario('A', 'A passes', 'fail')]), { createdAt: timestamp });
    const pass = comment(2, report('PASS', [scenario('A', 'A passes')]), { createdAt: timestamp });
    expect(smokeCommentSnapshotDigest([pass, fail])).toBe(smokeCommentSnapshotDigest([fail, pass]));
    expect(coverage([pass, fail], A).accepting).toBe(true);
  });

  it.each([
    ['producer', (body: string) => mutateMachineBlock(body, (block) => block.replace(`producer: ${SMOKE_REPORT_PRODUCER}`, 'producer: '))],
    ['terminal', (body: string) => mutateMachineBlock(body, (block) => block.replace('terminal-handle: smoke-terminal-1', 'terminal-handle: '))],
    ['cleanup', (body: string) => mutateMachineBlock(body, (block) => block.replace('terminal-cleanup: closed_owned_handle', 'terminal-cleanup: pending'))],
    ['tracked files', (body: string) => mutateMachineBlock(body, (block) => block.replace('tracked-files-unmodified: true', 'tracked-files-unmodified: false'))],
    ['row fields', (body: string) => mutateMachineBlock(body, (block) => block.replace('observed: fail observed', 'observed: '))],
  ])('rejects incomplete non-PASS evidence missing %s', (_name, mutate) => {
    const pass = comment(1, report('PASS', [scenario('A', 'A passes')]));
    const canonicalWeak = formatSmokeReportComment(report('FAIL', [scenario('A', 'A passes', 'fail')]));
    const weak = comment(2, report('FAIL', [scenario('A', 'A passes', 'fail')]), {
      body: mutate(canonicalWeak),
    });
    const cleared = comment(3, report('PASS', [scenario('unknown', 'unknown')]));
    const result = coverage([pass, weak, cleared], A);
    expect(result.accepting).toBe(true);
    expect(result.diagnostics.covered.items[0]?.commentId).toBe(1);
    expect(result.diagnostics.invalidCandidates.total).toBe(1);
  });

  it('bounds diagnostics without truncating the internal fold', () => {
    const scenarios = Array.from({ length: 70 }, (_, index) => ({
      action: `${'д'.repeat(300)}-${index}`,
      expected: `${'e'.repeat(300)}-${index}`,
    }));
    const rows = scenarios.map((entry) => scenario(entry.action, entry.expected));
    const result = coverage([comment(1000, report('PASS', rows))], planBody(scenarios));
    expect(result.accepting).toBe(true);
    expect(result.diagnostics.covered.total).toBe(70);
    expect(result.diagnostics.covered.items).toHaveLength(50);
    expect(result.diagnostics.covered.truncated).toBe(true);
    expect(Buffer.byteLength(result.diagnostics.covered.items[0]?.tuple ?? '', 'utf8')).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(JSON.stringify(result.diagnostics), 'utf8')).toBeLessThanOrEqual(64 * 1024);
  });

  it('keeps the ordinary gate, CI, and receipt predicates', () => {
    const smoke = comment(1, report('PASS', [scenario('A', 'A passes')]));
    const common = {
      issueBody: A,
      issueNumber: 1343,
      prNumber: 2001,
      headSha: HEAD_ONE,
      prComments: [smoke],
      orcaWorktreeOk: true,
      ownedTerminalClosed: true,
      terminalProvenanceOk: true,
      repositorySlug: REPOSITORY,
      resolvedIssueNumber: 1343,
      resolvedPrNumber: 2001,
      liveHeadSha: HEAD_ONE,
      issueBodyMatchesTarget: true,
      trustedPublisherLogin: TRUSTED_ACTOR,
      commentCensusComplete: true,
      commentSnapshotStable: true,
    };
    expect(evaluateWorkerSmokeGate({ ...common, ciGreen: true }).allowed).toBe(true);
    expect(evaluateWorkerSmokeGate({ ...common, ciGreen: false }).reason).toBe('required_ci_not_green');
    expect(evaluateWorkerSmokeGate({ ...common, ciGreen: true, terminalProvenanceOk: false }).reason)
      .toBe('smoke_terminal_provenance_unverified');
  });
});

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
          resolveCiGreen: () => true,
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
          resolveCiGreen: () => true,
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
  it('executes gh writes through scripts/gh under the minimal smoke child environment, not a PATH wrapper', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-publish-native-'));
    const machineBin = join(root, 'machine-bin');
    mkdirSync(machineBin, { recursive: true });
    const wrapperMarker = join(root, 'machine-wrapper-ran');
    const previousPath = process.env.PATH;
    const previousRealBinary = process.env.GH_REAL_BINARY;
    executable(join(machineBin, 'gh'), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(wrapperMarker)}, 'ran');\n`);
    delete process.env.GH_REAL_BINARY;
    const nativeBinary = resolveRealGhBinary();
    process.env.PATH = `${machineBin}:${dirname(nativeBinary)}:${previousPath ?? ''}`;
    try {
      expect(resolveRealGhBinary()).toBe(nativeBinary);
      expect(resolveTrackedGhWrapper()).toBe(join(process.cwd(), 'scripts', 'gh'));
      const result = runSmokeGhWriteSync(['api', '--method', 'POST', '--help'], root);
      expect(result.ok).toBe(true);
      expect(result.stdout).toMatch(/usage/iu);
      expect(existsSync(wrapperMarker)).toBe(false);
      expect(buildSmokeGhChildEnv({})).toEqual({});
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousRealBinary === undefined) delete process.env.GH_REAL_BINARY;
      else process.env.GH_REAL_BINARY = previousRealBinary;
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
    const previousRealBinary = process.env.GH_REAL_BINARY;
    const root = mkdtempSync(join(tmpdir(), 'smoke-publication-failure-'));
    const restoreProject = selectSmokeProjectForTest(root, process.cwd());
    process.env.GH_REAL_BINARY = process.execPath;
    try {
      expect(() => publishPrComment(1586, 'hello', process.cwd(), 25)).toThrow(/comment_publish_failed/u);
    } finally {
      restoreProject();
      if (previousRealBinary === undefined) delete process.env.GH_REAL_BINARY;
      else process.env.GH_REAL_BINARY = previousRealBinary;
      rmSync(root, { recursive: true, force: true });
    }
  });
});


describe('Issue #2319 terminal-free publish', () => {
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

  it('refuses mismatched PASS tuples and tracked dirtiness before any POST', async () => {
    let posts = 0;
    const deps = {
      resolveTarget: () => publishTarget,
      gitHead: () => HEAD_ONE,
      publishComment: () => { posts += 1; return 'https://github.com/comment'; },
    };
    await expect(runPublishSmoke(publishOptions(), {
      ...deps,
      readReportFile: () => reportText('PASS', [
        scenario('exercise publish scenario B', 'scenario B passes'),
        scenario('exercise publish scenario A', 'scenario A passes'),
      ]),
      gitStatus: () => [],
    })).rejects.toThrow(/report_plan_mismatch/);
    expect(posts).toBe(0);

    await expect(runPublishSmoke(publishOptions(), {
      ...deps,
      readReportFile: () => reportText('PASS', [
        scenario('exercise publish scenario A', 'scenario A passes'),
        scenario('exercise publish scenario B', 'scenario B passes'),
      ]),
      gitStatus: () => [' M scripts/example.ts'],
    })).rejects.toThrow(/tracked_worktree_dirty/);
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
});
