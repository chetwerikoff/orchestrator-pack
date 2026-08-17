import { describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcessSync } from './kernel/subprocess.ts';
import {
  checkSmokeTestPlan,
  ensureSmokeRunArtifactDir,
  evaluateReadyForReviewCombinations,
  evaluateWorkerSmokeCoverage,
  evaluateWorkerSmokeGate,
  formatSmokeReportComment,
  smokeDeliverySealedPath,
  SMOKE_REPORT_PRODUCER,
  type SmokeReport,
  type SmokeScenario,
  type WorkerSmokeCommentRecord,
  type WorkerSmokeTrustedTarget,
} from './lib/worker-smoke-core.ts';
import { evaluateSmokeLifecycleCleanliness } from './lib/worker-smoke-lifecycle.ts';
import { writeWorkerSmokeReceipt } from './lib/worker-smoke-receipt.ts';
import { DeterministicRuntimeAdapter } from './runtime/test-adapter.ts';
import type { RuntimeDispatchResult, RuntimeWorkerIdentity } from './runtime/contracts.ts';
import {
  establishRuntimeSmokeDelivery,
  exactClosingIssue,
  finalSmokeCommentSnapshotMatches,
  findVerifiedSmokeReceiptWitness,
  parsePaginatedSmokeComments,
  resolveSmokeTarget,
  runGateCheck,
  resolveSmokeExecutorProfile,
  smokeCommentSnapshotDigest,
  stabilizeSmokeCommentCensus,
  type CliOptions,
  type GateCheckDependencies,
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

describe('smoke executor profiles', () => {
  const env = {
    PACK_EXECUTOR_SMOKE_ROUTINE_AGENT: 'cursor-agent',
    PACK_EXECUTOR_SMOKE_ROUTINE_MODEL: 'fixture-routine-model',
    PACK_EXECUTOR_SMOKE_ROUTINE_EFFORT: 'fixture-routine-effort',
    PACK_EXECUTOR_SMOKE_COMPLEX_AGENT: 'cursor-agent',
    PACK_EXECUTOR_SMOKE_COMPLEX_MODEL: 'fixture-complex-model',
    PACK_EXECUTOR_SMOKE_COMPLEX_EFFORT: 'fixture-complex-effort',
  };

  it.each([
    ['routine', 'fixture-routine-model', 'fixture-routine-effort'],
    ['complex', 'fixture-complex-model', 'fixture-complex-effort'],
  ] as const)('applies only the %s profile before spawn', (complexity, model, effort) => {
    const profile = resolveSmokeExecutorProfile(complexity, env);
    expect(profile.command).toBe(`agent --model '${model}-${effort}'`);
    expect(profile.complexity).toBe(complexity);
  });

  it('maps the configured Cursor agent name onto the existing launch surface', () => {
    const profile = resolveSmokeExecutorProfile('complex', {
      ...env,
      PACK_EXECUTOR_SMOKE_COMPLEX_AGENT: 'cursor',
    });
    expect(profile.agent).toBe('agent');
    expect(profile.command).toBe("agent --model 'fixture-complex-model-fixture-complex-effort'");
  });

  it.each([
    ['routine', 'PACK_EXECUTOR_SMOKE_ROUTINE_MODEL'],
    ['complex', 'PACK_EXECUTOR_SMOKE_COMPLEX_EFFORT'],
  ] as const)('fails closed before spawn for missing %s profile data', (complexity, missing) => {
    const invalid = { ...env };
    delete invalid[missing];
    expect(() => resolveSmokeExecutorProfile(complexity, invalid)).toThrow('smoke_profile_missing');
  });

  it('rejects unsupported and malformed profile data', () => {
    expect(() => resolveSmokeExecutorProfile('routine', {
      ...env, PACK_EXECUTOR_SMOKE_ROUTINE_AGENT: 'unsupported-agent',
    })).toThrow('smoke_profile_unsupported_agent');
    expect(() => resolveSmokeExecutorProfile('routine', {
      ...env, PACK_EXECUTOR_SMOKE_ROUTINE_MODEL: 'model with spaces',
    })).toThrow('smoke_profile_malformed');
    expect(() => resolveSmokeExecutorProfile('routine', env)).not.toThrow();
  });
});

describe('runtime-neutral worker smoke', () => {
  it('keeps the smoke-plan authoring floor', () => {
    const result = checkSmokeTestPlan(issueBody);
    expect(result.ok).toBe(true);
    expect(result.plan?.scenarios).toHaveLength(1);
  });

  it('dispatches the prompt once and consumes child delivery evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-smoke-'));
    try {
      const artifactDir = join(root, 'run-1');
      ensureSmokeRunArtifactDir(artifactDir);
      writeFileSync(smokeDeliverySealedPath(artifactDir), JSON.stringify({ runId: 'run-1' }), 'utf8');
      const adapter = new DeterministicRuntimeAdapter();
      const spawned = adapter.spawnWorker({ title: 'smoke', command: 'cursor-agent' });
      expect(spawned.status).toBe('ok');
      if (spawned.status !== 'ok') return;
      const dispatch = vi.spyOn(adapter, 'dispatchInput');

      const result = establishRuntimeSmokeDelivery({
        adapter,
        worker: spawned.value.identity,
        prompt: 'verify',
        binding: { runId: 'run-1', artifactDir },
        cwd: root,
        deadlineMs: 100,
        now: () => 1,
        sleepMs: () => undefined,
      });

      expect(result.ok).toBe(true);
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never resends after dispatch_unknown', () => {
    const adapter = new DeterministicRuntimeAdapter();
    const spawned = adapter.spawnWorker({ title: 'smoke', command: 'cursor-agent' });
    expect(spawned.status).toBe('ok');
    if (spawned.status !== 'ok') return;
    const dispatch = vi.spyOn(adapter, 'dispatchInput').mockImplementation((
      _input: { readonly worker: RuntimeWorkerIdentity; readonly text?: string; readonly submitOnly?: boolean },
    ): RuntimeDispatchResult => ({ status: 'dispatch_unknown', reason: 'transport_interrupted' }));

    expect(establishRuntimeSmokeDelivery({
      adapter,
      worker: spawned.value.identity,
      prompt: 'verify',
      binding: { runId: 'run-2', artifactDir: '/missing' },
      cwd: process.cwd(),
      deadlineMs: 100,
      now: () => 1,
      sleepMs: () => undefined,
    })).toEqual({
      ok: false,
      reason: 'dispatch_unknown:transport_interrupted',
      submitCount: 0,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not turn pasted-text output into a second dispatch', () => {
    const adapter = new DeterministicRuntimeAdapter();
    const spawned = adapter.spawnWorker({ title: 'smoke', command: 'cursor-agent' });
    expect(spawned.status).toBe('ok');
    if (spawned.status !== 'ok') return;
    const dispatch = vi.spyOn(adapter, 'dispatchInput');
    vi.spyOn(adapter, 'readBoundedOutput').mockReturnValue({
      status: 'ok',
      value: {
        worker: spawned.value.identity,
        lines: ['[Pasted text #1 +1 lines]'],
        observationToken: { opaque: 'pasted-text-observation' },
        changed: true,
        terminalState: 'running',
      },
    });
    let clock = 0;

    expect(establishRuntimeSmokeDelivery({
      adapter,
      worker: spawned.value.identity,
      prompt: 'verify',
      binding: { runId: 'run-3', artifactDir: '/missing' },
      cwd: process.cwd(),
      deadlineMs: 2,
      now: () => clock++,
      sleepMs: () => undefined,
    })).toMatchObject({ ok: false, reason: 'prompt_delivery_unconfirmed', submitCount: 0 });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('keeps smoke and CI orthogonal for ready handoff', () => {
    expect(evaluateReadyForReviewCombinations({ smokePass: true, ciGreen: true })).toBe(true);
    expect(evaluateReadyForReviewCombinations({ smokePass: true, ciGreen: false })).toBe(false);
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
      comment(2, report('BLOCKED', [scenario('unknown', 'unknown', 'blocked')])),
    ], A);
    expect(blocked.accepting).toBe(false);
    expect(blocked.diagnostics.globalBlock.kind).toBe('BLOCKED');

    const cleared = coverage([
      comment(1, report('PASS', [scenario('A', 'A passes')])),
      comment(2, report('BLOCKED', [scenario('unknown', 'unknown', 'blocked')])),
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

function gateOptions(root: string, issueBodyFile: string): CliOptions {
  return {
    command: 'gate-check',
    issueNumber: 1343,
    prNumber: 2001,
    headSha: HEAD_ONE,
    issueBodyFile,
    smokeComplexity: 'routine',
    repoRoot: root,
    cwd: root,
    dryRun: false,
    json: true,
  };
}

function resolvedTarget(body: string): ResolvedSmokeTarget {
  return {
    repositorySlug: REPOSITORY,
    issueNumber: 1343,
    prNumber: 2001,
    headSha: HEAD_ONE,
    issueBody: body,
    issueBodyMatchesTarget: true,
    trustedPublisherLogin: TRUSTED_ACTOR,
  };
}

function gateDependencies(
  body: string,
  snapshots: readonly WorkerSmokeCommentRecord[][],
  root: string,
  resolveTargetOverride: GateCheckDependencies['resolveTarget'] = () => resolvedTarget(body),
): GateCheckDependencies {
  let snapshotIndex = 0;
  return {
    evaluateLifecycle: () => evaluateSmokeLifecycleCleanliness(root),
    resolveTarget: resolveTargetOverride,
    fetchComments: () => {
      const selected = snapshots[Math.min(snapshotIndex, snapshots.length - 1)] ?? [];
      snapshotIndex += 1;
      return [...selected];
    },
    fetchHead: () => HEAD_ONE,
    selectAdapter: async () => new DeterministicRuntimeAdapter(),
    ciGreen: () => true,
  };
}

async function runGateQuietly(
  options: CliOptions,
  dependencies: GateCheckDependencies,
): Promise<number> {
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    return await runGateCheck(options, dependencies);
  } finally {
    output.mockRestore();
  }
}

function executable(path: string, source: string): void {
  writeFileSync(path, source, 'utf8');
  chmodSync(path, 0o755);
}

function psQuote(value: string): string {
  return value.replaceAll("'", "''");
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

describe('worker-smoke consolidated gate regressions', () => {
  it('uses the canonical closing grammar and rejects missing, repeated, and mismatched relations', () => {
    for (const keyword of [
      'Close', 'Closes', 'Closed',
      'Fix', 'Fixes', 'Fixed',
      'Resolve', 'Resolves', 'Resolved',
    ]) {
      expect(exactClosingIssue(`${keyword} #1343`)).toBe(1343);
    }
    expect(exactClosingIssue('No closing relation')).toBeUndefined();
    expect(exactClosingIssue('Closes #1343\nFixes #1343')).toBeUndefined();
    expect(exactClosingIssue('Closes #1343\nFixes #999')).toBeUndefined();
    expect(exactClosingIssue('```md\nCloses #999\n```\nClose #1343')).toBe(1343);
  });

  it('accepts a legacy fixture newline but verifies the caller writes the freshly fetched Issue body without BOM', async () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-caller-gate-'));
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const body = planBody([{ action: 'caller writes Issue body', expected: 'gate evaluates fetched bytes' }]);
    const sourceBodyFile = join(root, 'source-issue.md');
    const issueBodyFile = join(root, 'caller-issue.md');
    writeFileSync(sourceBodyFile, body, 'utf8');
    const callerSource = readFileSync(resolve('scripts/pack-worker-report.ps1'), 'utf8');
    expect(callerSource).toContain(
      '[System.IO.File]::WriteAllText($issueBodyFile.FullName, $issueBody, [System.Text.UTF8Encoding]::new($false))',
    );
    const writer = runChild('pwsh', [
      '-NoProfile',
      '-Command',
      `$body = [System.IO.File]::ReadAllText('${psQuote(sourceBodyFile)}'); `
        + `Set-Content -LiteralPath '${psQuote(issueBodyFile)}' -Value $body -Encoding utf8NoBOM`,
    ], { encoding: 'utf8' });
    expect(writer.status, `${writer.stdout}\n${writer.stderr}`).toBe(0);
    const suppliedBody = readFileSync(issueBodyFile, 'utf8');
    expect([`${body}\n`, `${body}\r\n`]).toContain(suppliedBody);

    executable(join(bin, 'gh'), `#!/usr/bin/env node
const endpoint = process.argv[3] ?? '';
if (endpoint === 'user') {
  process.stdout.write(JSON.stringify({ login: '${TRUSTED_ACTOR}' }));
} else if (endpoint.endsWith('/issues/1343')) {
  process.stdout.write(JSON.stringify({
    number: 1343,
    body: process.env.FAKE_ISSUE_BODY,
    html_url: 'https://github.com/${REPOSITORY}/issues/1343',
    state: 'open',
  }));
} else if (endpoint.endsWith('/pulls/2001')) {
  process.stdout.write(JSON.stringify({
    number: 2001,
    body: 'Close #1343',
    html_url: 'https://github.com/${REPOSITORY}/pull/2001',
    state: 'open',
    head: { sha: '${HEAD_ONE}' },
    base: { ref: 'main' },
  }));
} else {
  process.stderr.write('unexpected endpoint: ' + endpoint);
  process.exitCode = 2;
}
`);
    expect(runChild('git', ['init', '--quiet', root], { encoding: 'utf8' }).status).toBe(0);
    expect(runChild(
      'git',
      ['-C', root, 'remote', 'add', 'origin', `https://github.com/${REPOSITORY}.git`],
      { encoding: 'utf8' },
    ).status).toBe(0);

    const previousPath = process.env.PATH;
    const previousBody = process.env.FAKE_ISSUE_BODY;
    const previousReceiptRoot = process.env.WORKER_SMOKE_RECEIPT_ROOT;
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    process.env.FAKE_ISSUE_BODY = body;
    process.env.WORKER_SMOKE_RECEIPT_ROOT = root;
    try {
      const smoke = report('PASS', [scenario(
        'caller writes Issue body',
        'gate evaluates fetched bytes',
      )]);
      writeWorkerSmokeReceipt(smoke);
      const comments = [comment(1, smoke)];
      const options = gateOptions(root, issueBodyFile);
      const resolved = resolveSmokeTarget(options, suppliedBody);
      expect(resolved.issueBody).toBe(body);
      expect(() => resolveSmokeTarget(options, `${body}\n\n`)).toThrow(/does not match/u);
      expect(await runGateQuietly(
        options,
        gateDependencies(body, [comments, comments, comments], root, resolveSmokeTarget),
      )).toBe(0);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousBody === undefined) delete process.env.FAKE_ISSUE_BODY;
      else process.env.FAKE_ISSUE_BODY = previousBody;
      if (previousReceiptRoot === undefined) delete process.env.WORKER_SMOKE_RECEIPT_ROOT;
      else process.env.WORKER_SMOKE_RECEIPT_ROOT = previousReceiptRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps comment publication order authoritative when receipt writes finish in reverse', async () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-receipt-order-'));
    const body = planBody([
      { action: 'A', expected: 'A passes' },
      { action: 'B', expected: 'B passes' },
    ]);
    const issueBodyFile = join(root, 'issue.md');
    writeFileSync(issueBodyFile, body, 'utf8');
    const first = { ...report('PASS', [scenario('A', 'A passes')]), terminalHandle: 'terminal-a' };
    const second = { ...report('PASS', [scenario('B', 'B passes')]), terminalHandle: 'terminal-b' };
    const comments = [comment(1, first), comment(2, second)];
    const previousReceiptRoot = process.env.WORKER_SMOKE_RECEIPT_ROOT;
    process.env.WORKER_SMOKE_RECEIPT_ROOT = root;
    try {
      writeWorkerSmokeReceipt(second);
      writeWorkerSmokeReceipt(first);
      const aggregate = coverage(comments, body);
      expect(aggregate.accepting).toBe(true);
      expect(aggregate.latestClearingPass?.terminalHandle).toBe('terminal-b');
      expect(findVerifiedSmokeReceiptWitness({
        issueBody: body,
        comments,
        target: target(),
      })?.terminalHandle).toBe('terminal-a');
      expect(await runGateQuietly(
        gateOptions(root, issueBodyFile),
        gateDependencies(body, [comments, comments, comments], root),
      )).toBe(0);
    } finally {
      if (previousReceiptRoot === undefined) delete process.env.WORKER_SMOKE_RECEIPT_ROOT;
      else process.env.WORKER_SMOKE_RECEIPT_ROOT = previousReceiptRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps FAIL-to-PASS admission independent of receipt write order', async () => {
    for (const receiptOrder of ['publication', 'inverted'] as const) {
      const root = mkdtempSync(join(tmpdir(), `worker-smoke-fail-pass-${receiptOrder}-`));
      const body = planBody([{ action: 'A', expected: 'A passes' }]);
      const issueBodyFile = join(root, 'issue.md');
      writeFileSync(issueBodyFile, body, 'utf8');
      const failReport = {
        ...report('FAIL', [scenario('A', 'A passes', 'fail')]),
        terminalHandle: 'terminal-fail',
      };
      const passReport = {
        ...report('PASS', [scenario('A', 'A passes')]),
        terminalHandle: 'terminal-pass',
      };
      const comments = [comment(1, failReport), comment(2, passReport)];
      const previousReceiptRoot = process.env.WORKER_SMOKE_RECEIPT_ROOT;
      process.env.WORKER_SMOKE_RECEIPT_ROOT = root;
      try {
        if (receiptOrder === 'publication') {
          writeWorkerSmokeReceipt(failReport);
          writeWorkerSmokeReceipt(passReport);
        } else {
          writeWorkerSmokeReceipt(passReport);
          writeWorkerSmokeReceipt(failReport);
        }
        const expectedWitness = receiptOrder === 'publication' ? 'terminal-pass' : 'terminal-fail';
        const aggregate = coverage(comments, body);
        expect(aggregate.accepting).toBe(true);
        expect(aggregate.latestClearingPass?.terminalHandle).toBe('terminal-pass');
        expect(findVerifiedSmokeReceiptWitness({
          issueBody: body,
          comments,
          target: target(),
        })?.terminalHandle).toBe(expectedWitness);
        expect(await runGateQuietly(
          gateOptions(root, issueBodyFile),
          gateDependencies(body, [comments, comments, comments], root),
        )).toBe(0);
      } finally {
        if (previousReceiptRoot === undefined) delete process.env.WORKER_SMOKE_RECEIPT_ROOT;
        else process.env.WORKER_SMOKE_RECEIPT_ROOT = previousReceiptRoot;
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('denies allow when the immediate final census contains a same-head FAIL or BLOCKED', async () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-final-census-'));
    const body = planBody([{ action: 'A', expected: 'A passes' }]);
    const issueBodyFile = join(root, 'issue.md');
    writeFileSync(issueBodyFile, body, 'utf8');
    const passReport = report('PASS', [scenario('A', 'A passes')]);
    const pass = comment(1, passReport);
    const blocked = comment(2, report('BLOCKED', [scenario('A', 'A passes', 'blocked')]));
    const previousReceiptRoot = process.env.WORKER_SMOKE_RECEIPT_ROOT;
    process.env.WORKER_SMOKE_RECEIPT_ROOT = root;
    try {
      writeWorkerSmokeReceipt(passReport);
      expect(finalSmokeCommentSnapshotMatches([pass], [pass, blocked])).toBe(false);
      const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        const code = await runGateCheck(
          gateOptions(root, issueBodyFile),
          gateDependencies(body, [[pass], [pass], [pass, blocked]], root),
        );
        expect(code).toBe(1);
        expect(output.mock.calls.map((entry) => String(entry[0])).join(''))
          .toContain('comment_snapshot_changed_before_allow');
      } finally {
        output.mockRestore();
      }
    } finally {
      if (previousReceiptRoot === undefined) delete process.env.WORKER_SMOKE_RECEIPT_ROOT;
      else process.env.WORKER_SMOKE_RECEIPT_ROOT = previousReceiptRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies the same strict admission grammar to malformed BLOCKED evidence', () => {
    const body = planBody([{ action: 'A', expected: 'A passes' }]);
    const pass = comment(1, report('PASS', [scenario('A', 'A passes')]));
    const malformedReport = report('BLOCKED', [scenario('A', 'A passes', 'blocked')]);
    const malformedBody = mutateMachineBlock(
      formatSmokeReportComment(malformedReport),
      (block) => block.replace(`producer: ${SMOKE_REPORT_PRODUCER}`, 'producer: '),
    );
    const result = coverage([
      pass,
      comment(2, malformedReport, { body: malformedBody }),
    ], body);
    expect(result.accepting).toBe(false);
    expect(result.diagnostics.invalidCandidates.total).toBe(1);
    expect(result.diagnostics.globalBlock.kind).toBe('invalid_candidate');
  });

  it('trims a real combined payload over 64 KiB deterministically without changing totals', () => {
    const escaped = '\\'.repeat(240);
    const rows = Array.from({ length: 180 }, (_, index) => ({
      action: `${escaped} action-${index}`,
      expected: `${escaped} expected-${index}`,
    }));
    const body = planBody(rows);
    const comments = [
      comment(1, report('PASS', rows.slice(0, 60).map((row) => scenario(row.action, row.expected)))),
      comment(2, report('FAIL', rows.slice(60, 120).map(
        (row) => scenario(row.action, row.expected, 'fail'),
      ))),
      comment(3, report('PASS', [scenario('unknown tuple', 'clear global block')])),
    ];
    const first = coverage(comments, body);
    const second = coverage(comments, body);
    expect(first.diagnostics.covered.total).toBe(60);
    expect(first.diagnostics.latestNonPass.total).toBe(60);
    expect(first.diagnostics.missing.total).toBe(60);
    expect(first.diagnostics.payloadOverflow).toBe(true);
    expect(first.diagnostics.payloadBytes).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(JSON.stringify(first.diagnostics), 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(JSON.stringify(first.diagnostics)).toBe(JSON.stringify(second.diagnostics));
  });

  it('uses a fresh runtime identity for each accumulated publication and leaves no live worker', () => {
    const adapter = new DeterministicRuntimeAdapter();
    const first = adapter.spawnWorker({ title: 'smoke-1', command: 'cursor-agent' });
    const second = adapter.spawnWorker({ title: 'smoke-2', command: 'cursor-agent' });
    expect(first.status).toBe('ok');
    expect(second.status).toBe('ok');
    if (first.status !== 'ok' || second.status !== 'ok') return;
    expect(first.value.identity).not.toEqual(second.value.identity);
    expect(adapter.stopWorker(first.value.identity).status).toBe('ok');
    expect(adapter.stopWorker(second.value.identity).status).toBe('ok');
    expect(adapter.listWorkers()).toEqual({ status: 'ok', value: [] });

    const body = planBody([
      { action: 'A', expected: 'A passes' },
      { action: 'B', expected: 'B passes' },
    ]);
    const comments = [
      comment(1, { ...report('PASS', [scenario('A', 'A passes')]), terminalHandle: first.value.identity.id }),
      comment(2, { ...report('PASS', [scenario('B', 'B passes')]), terminalHandle: second.value.identity.id }),
    ];
    expect(coverage(comments, body).accepting).toBe(true);
  });
});
