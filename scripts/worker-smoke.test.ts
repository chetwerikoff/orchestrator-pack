import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { DeterministicRuntimeAdapter } from './runtime/test-adapter.ts';
import type { RuntimeDispatchResult, RuntimeWorkerIdentity } from './runtime/contracts.ts';
import {
  establishRuntimeSmokeDelivery,
  parsePaginatedSmokeComments,
  smokeCommentSnapshotDigest,
  stabilizeSmokeCommentCensus,
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
