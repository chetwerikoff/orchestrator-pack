import { describe, expect, it, vi } from 'vitest';
import { parseSmokeTestPlan } from './draft-discipline.mjs';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { runProcess, runProcessSync } from './kernel/subprocess.ts';
import {
  buildSmokeAgentPrompt,
  checkSmokeTestPlan,
  createSmokeControlPlaneDiagnostic,
  ensureSmokeRunArtifactDir,
  evaluateReadyForReviewCombinations,
  evaluateWorkerSmokeCoverage,
  evaluateWorkerSmokeGate,
  extractSmokeReportsFromComments,
  formatSmokeReportComment,
  normalizeSmokeReport,
  resolveSmokeRequirement,
  smokeCompletionBodyPath,
  smokeCompletionPendingBodyPath,
  smokeCompletionSealPath,
  smokeDeliverySealedPath,
  SMOKE_REPORT_PRODUCER,
  type SmokeReport,
  type SmokeScenario,
  type WorkerSmokeCommentRecord,
  type WorkerSmokeTrustedTarget,
} from './lib/worker-smoke-core.ts';
import {
  computeSmokeCompletionBodyDigest,
  WORKER_SMOKE_CAUSE_FAMILIES,
  smokeResultForWorkerSmokeCauseFamily,
  workerSmokeCauseFamilyForHarnessReason,
} from './lib/worker-smoke-core-base.ts';
import { inspectSmokeProgress } from './lib/worker-smoke-lifecycle-base.ts';
import { evaluateSmokeLifecycleCleanliness, SMOKE_LIFECYCLE_POLL_MS } from './lib/worker-smoke-lifecycle.ts';
import {
  evaluateSameHeadBlockedRetryAdmission,
  listWorkerSmokeReceipts,
  readWorkerSmokeReceipt,
  verifySmokeRunReceipt,
  writeWorkerSmokeReceipt,
} from './lib/worker-smoke-receipt.ts';
import { DeterministicRuntimeAdapter } from './runtime/test-adapter.ts';
import type { RuntimeAdapter, RuntimeDispatchResult, RuntimeWorkerIdentity } from './runtime/contracts.ts';
import {
  beginSmokeOrdering,
  bindSmokeReportToPlan,
  establishRuntimeSmokeDelivery,
  emit,
  exactClosingIssue,
  finalSmokeCommentSnapshotMatches,
  findVerifiedSmokeReceiptWitness,
  finishSmokeOrderingBeforeDetachedTerminalization,
  gitTrackedSmokeRuntimePaths,
  parsePaginatedSmokeComments,
  publishPrComment,
  reviewIndependentRequiredCiContexts,
  resolveLiveSmokeExecutorProfile,
  resolveSmokeTarget,
  runGateCheck,
  runSmokeAttempt,
  resolveSmokeExecutorProfile,
  smokeCommentSnapshotDigest,
  stabilizeSmokeCommentCensus,
  waitForRuntimeSmokeCompletion,
  type CliOptions,
  type GateCheckDependencies,
  type ResolvedSmokeTarget,
} from './worker-smoke-run.ts';
import {
  commitSmokeOrderingTransition,
  observePackReviewHead,
  readPackReviewAuthority,
} from './pack-review-state.ts';

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

describe('Issue #1936 truthful smoke evidence', () => {
  it('keeps the cause vocabulary closed and maps harness reasons without prose classification', () => {
    expect(WORKER_SMOKE_CAUSE_FAMILIES).toEqual([
      'harness_observation_interrupted',
      'harness_observation_timeout',
      'harness_admission_refused',
      'harness_head_mismatch',
      'harness_dirty_worktree',
      'scenario_precondition_unavailable',
      'scenario_assertion_failed',
      'scenario_evidence_missing',
      'lifecycle_cleanup_failed',
      'unknown',
    ]);
    expect(workerSmokeCauseFamilyForHarnessReason('runtime_cli_interrupted:SIGTERM')).toBe('harness_observation_interrupted');
    expect(workerSmokeCauseFamilyForHarnessReason('runtime_timeout')).toBe('harness_observation_timeout');
    expect(workerSmokeCauseFamilyForHarnessReason('trusted_target_head_mismatch:abc')).toBe('harness_head_mismatch');
    expect(workerSmokeCauseFamilyForHarnessReason('tracked_smoke_runtime_state')).toBe('harness_dirty_worktree');
    const currentHarnessReasons = [
      ['send_failed:write_channel_closed', 'harness_observation_interrupted'],
      ['dispatch_unknown:submit_witness_missing', 'harness_observation_interrupted'],
      ['opencode_panel_observation_failed:read_bounded_output:failed:unobservable', 'harness_observation_interrupted'],
      ['opencode_panel_idle_splash', 'harness_observation_interrupted'],
      ['operator_cancelled:SIGTERM', 'harness_observation_interrupted'],
      ['read_bounded_output:failed:runtime_response_invalid', 'harness_observation_interrupted'],
      ['smoke_ordering_independent_in_progress', 'harness_admission_refused'],
      ['smoke_ordering_independent_already_passed', 'harness_admission_refused'],
      ['smoke_ordering_review_unsettled', 'harness_admission_refused'],
      ['smoke_ordering_head_mismatch:stale', 'harness_head_mismatch'],
    ] as const;
    for (const [reason, family] of currentHarnessReasons) {
      expect(workerSmokeCauseFamilyForHarnessReason(reason)).toBe(family);
    }
    expect(workerSmokeCauseFamilyForHarnessReason('future prose-shaped reason')).toBe('unknown');
    expect(smokeResultForWorkerSmokeCauseFamily('scenario_precondition_unavailable')).toBe('BLOCKED');
    expect(smokeResultForWorkerSmokeCauseFamily('scenario_assertion_failed')).toBe('FAIL');
    expect(smokeResultForWorkerSmokeCauseFamily('unknown')).toBe('FAIL');
  });

  it('keeps control-plane result derivation on the closed family map', () => {
    const normalized = normalizeSmokeReport({
      result: 'PASS',
      scenarios: [{ action: 'run declared smoke', expected: 'pass', observed: 'pass', outcome: 'pass' }],
      trackedFilesUnmodified: true,
      limitations: [],
      environmentNotes: [],
      terminalCleanup: 'closed_owned_handle',
      producer: SMOKE_REPORT_PRODUCER,
      orcaExecutable: 'runtime-adapter',
      terminalHandle: 'terminal-owned',
    }, { issueNumber: 1936, prNumber: 1945, headSha: HEAD_ONE });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const diagnostic = createSmokeControlPlaneDiagnostic({
      terminalAcquired: true,
      operation: 'terminal_read',
      outcomeCategory: 'recognized_control_plane_code',
      controlPlaneCode: 'channel_control_overwritten',
    });
    expect(diagnostic).toBeDefined();
    if (!diagnostic) return;
    normalized.report.controlPlaneDiagnostic = diagnostic;
    expect(normalized.report.causeFamily).toBe('harness_observation_interrupted');
    expect(normalized.report.result).toBe('FAIL');
    expect(normalized.report.nonPassCause).toBe('orca_control_plane_lost_mid_smoke');
  });

  it('fails multiple terminal non-PASS rows closed independent of row order', () => {
    const rows: SmokeScenario[] = [
      { action: 'precondition', expected: 'available', observed: 'missing', outcome: 'blocked', causeFamily: 'scenario_precondition_unavailable' },
      { action: 'assertion', expected: 'match', observed: 'mismatch', outcome: 'fail', causeFamily: 'scenario_assertion_failed' },
    ];
    const first = normalizeSmokeReport({
      result: 'BLOCKED', scenarios: rows, trackedFilesUnmodified: true, limitations: [],
      environmentNotes: [], terminalCleanup: 'not_started',
    }, { issueNumber: 1936, prNumber: 1945, headSha: HEAD_ONE });
    const second = normalizeSmokeReport({
      result: 'BLOCKED', scenarios: [...rows].reverse(), trackedFilesUnmodified: true, limitations: [],
      environmentNotes: [], terminalCleanup: 'not_started',
    }, { issueNumber: 1936, prNumber: 1945, headSha: HEAD_ONE });
    expect(first.ok && first.report.result).toBe('FAIL');
    expect(first.ok && first.report.causeFamily).toBe('unknown');
    expect(second.ok && second.report.result).toBe('FAIL');
    expect(second.ok && second.report.causeFamily).toBe('unknown');
  });

  it('does not let a top-level family rescue a malformed terminal scenario row', () => {
    const normalized = normalizeSmokeReport({
      result: 'BLOCKED',
      scenarios: [{
        action: 'check declared precondition',
        expected: 'precondition available',
        observed: 'not available',
        outcome: 'blocked',
      }],
      causeFamily: 'harness_admission_refused',
      trackedFilesUnmodified: true,
      limitations: [],
      environmentNotes: [],
      terminalCleanup: 'not_started',
    }, { issueNumber: 1936, prNumber: 1945, headSha: HEAD_ONE });
    expect(normalized.ok).toBe(true);
    expect(normalized.ok && normalized.report.scenarios[0]?.causeFamily).toBe('unknown');
    expect(normalized.ok && normalized.report.causeFamily).toBe('unknown');
    expect(normalized.ok && normalized.report.result).toBe('FAIL');
  });

  it('normalizes carry-only PASS without synthesizing a runtime terminal handle', () => {
    const partial: Partial<SmokeReport> = {
      result: 'PASS',
      scenarios: [{ action: 'carry tuple', expected: 'already proven', observed: `carried PASS from head ${HEAD_TWO} comment 42; not freshly executed on ${HEAD_ONE}`, outcome: 'pass' }],
      trackedFilesUnmodified: true,
      limitations: [],
      environmentNotes: ['smoke-execution=carry-only'],
      terminalCleanup: 'not_started_no_execution',
      producer: SMOKE_REPORT_PRODUCER,
      orcaExecutable: 'fixture-adapter',
    };
    const carried = normalizeSmokeReport(partial, { issueNumber: 1936, prNumber: 1945, headSha: HEAD_ONE }, { executionMode: 'carry-only' });
    expect(carried.ok).toBe(true);
    expect(carried.ok && carried.report.terminalHandle).toBeUndefined();
    const unprovenCarry = normalizeSmokeReport({
      ...partial,
      scenarios: [{ action: 'carry tuple', expected: 'already proven', observed: 'claimed carry without selective proof', outcome: 'pass' }],
    }, { issueNumber: 1936, prNumber: 1945, headSha: HEAD_ONE }, { executionMode: 'carry-only' });
    expect(unprovenCarry.ok).toBe(false);
    const executed = normalizeSmokeReport({ ...partial, terminalCleanup: 'closed_owned_handle' }, { issueNumber: 1936, prNumber: 1945, headSha: HEAD_ONE });
    expect(executed.ok).toBe(false);
  });

  it('round-trips a canonical carry-only PASS through formatted comment history', () => {
    const carried: SmokeReport = {
      result: 'PASS',
      issueNumber: 1936,
      prNumber: 1945,
      headSha: HEAD_ONE,
      scenarios: [{
        action: 'carry tuple',
        expected: 'already proven',
        observed: `carried PASS from head ${HEAD_TWO} comment 42; not freshly executed on ${HEAD_ONE}`,
        outcome: 'pass',
      }],
      trackedFilesUnmodified: true,
      limitations: [],
      environmentNotes: ['smoke-execution=carry-only'],
      terminalCleanup: 'not_started_no_execution',
      producer: SMOKE_REPORT_PRODUCER,
      orcaExecutable: 'fixture-adapter',
    };
    const extracted = extractSmokeReportsFromComments([{ body: formatSmokeReportComment(carried) }]);
    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toMatchObject({
      result: 'PASS',
      issueNumber: 1936,
      prNumber: 1945,
      headSha: HEAD_ONE,
      terminalCleanup: 'not_started_no_execution',
    });
    expect(extracted[0]?.terminalHandle).toBeUndefined();
  });
  it('keeps same-head attempt receipts append-only and verifies the exact attempt', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-receipts-1936-'));
    const previous = process.env.WORKER_SMOKE_RECEIPT_ROOT;
    process.env.WORKER_SMOKE_RECEIPT_ROOT = root;
    try {
      const blocked: SmokeReport = {
        ...report('BLOCKED', [{
          action: 'check dependency', expected: 'dependency available', observed: 'dependency unavailable',
          outcome: 'blocked', causeFamily: 'scenario_precondition_unavailable',
        }]),
        causeFamily: 'scenario_precondition_unavailable',
      };
      const passed = report('PASS', [scenario('check dependency', 'dependency available', 'pass')]);
      writeWorkerSmokeReceipt(blocked, {
        attemptId: 'attempt-blocked', executionMode: 'carry-only', publishedAt: '2026-09-18T00:00:00.000Z',
      });
      const firstPath = join(root, 'pr-2001|' + HEAD_ONE + '|attempt-blocked.json');
      const firstBytes = readFileSync(firstPath, 'utf8');
      writeWorkerSmokeReceipt(passed, {
        attemptId: 'attempt-pass', executionMode: 'carry-only', publishedAt: '2026-09-18T00:01:00.000Z',
      });
      expect(readFileSync(firstPath, 'utf8')).toBe(firstBytes);
      expect(listWorkerSmokeReceipts(2001, HEAD_ONE).map((entry) => entry.attemptId)).toEqual(['attempt-blocked', 'attempt-pass']);
      expect(readWorkerSmokeReceipt(2001, HEAD_ONE)?.attemptId).toBe('attempt-pass');
      expect(verifySmokeRunReceipt(blocked, 'attempt-blocked')).toBe(true);
      expect(verifySmokeRunReceipt(blocked, 'attempt-pass')).toBe(false);
      expect(() => writeWorkerSmokeReceipt(
        { ...passed, terminalHandle: undefined },
        { attemptId: 'attempt-executed', runId: 'attempt-executed', executionMode: 'executed' },
      )).toThrow('worker_smoke_receipt_executed_pass_requires_terminal_handle');
    } finally {
      if (previous === undefined) delete process.env.WORKER_SMOKE_RECEIPT_ROOT;
      else process.env.WORKER_SMOKE_RECEIPT_ROOT = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a blocked tuple sticky across unrelated later attempts and makes override one-shot', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-retry-1936-'));
    const previous = process.env.WORKER_SMOKE_RECEIPT_ROOT;
    process.env.WORKER_SMOKE_RECEIPT_ROOT = root;
    try {
      const tuple = { action: 'probe prerequisite', expected: 'prerequisite exists' };
      const blocked: SmokeReport = {
        ...report('BLOCKED', [{ ...tuple, observed: 'not available', outcome: 'blocked', causeFamily: 'scenario_evidence_missing' }]),
        causeFamily: 'scenario_evidence_missing',
      };
      writeWorkerSmokeReceipt(blocked, {
        attemptId: 'blocked-a', executionMode: 'carry-only', publishedAt: '2026-09-18T00:00:00.000Z',
      });
      const harnessFailure: SmokeReport = {
        ...report('FAIL', [{ action: 'launch harness', expected: 'starts', observed: 'interrupted', outcome: 'fail' }]),
        causeFamily: 'harness_observation_interrupted',
      };
      writeWorkerSmokeReceipt(harnessFailure, {
        attemptId: 'harness-b', executionMode: 'carry-only', attemptObservations: [], publishedAt: '2026-09-18T00:01:00.000Z',
      });
      let receipts = listWorkerSmokeReceipts(2001, HEAD_ONE);
      expect(evaluateSameHeadBlockedRetryAdmission({ receipts, selectedScenarios: [tuple] }))
        .toMatchObject({ allowed: false, reason: 'smoke_blocked_precondition_unchanged' });
      expect(evaluateSameHeadBlockedRetryAdmission({
        receipts, selectedScenarios: [tuple], operatorOverrideReason: 'operator confirmed one diagnostic retry',
      })).toMatchObject({ allowed: true });
      writeWorkerSmokeReceipt(harnessFailure, {
        attemptId: 'override-harness-c', executionMode: 'carry-only', attemptObservations: [],
        operatorOverrideReason: 'operator confirmed one diagnostic retry', publishedAt: '2026-09-18T00:02:00.000Z',
      });
      receipts = listWorkerSmokeReceipts(2001, HEAD_ONE);
      expect(evaluateSameHeadBlockedRetryAdmission({ receipts, selectedScenarios: [tuple] }))
        .toMatchObject({ allowed: false, reason: 'smoke_blocked_precondition_unchanged' });
      writeWorkerSmokeReceipt(report('PASS', [{ ...tuple, observed: 'available now', outcome: 'pass' }]), {
        attemptId: 'fresh-pass-d', executionMode: 'carry-only', publishedAt: '2026-09-18T00:03:00.000Z',
      });
      receipts = listWorkerSmokeReceipts(2001, HEAD_ONE);
      expect(evaluateSameHeadBlockedRetryAdmission({ receipts, selectedScenarios: [tuple] })).toMatchObject({ allowed: true });
    } finally {
      if (previous === undefined) delete process.env.WORKER_SMOKE_RECEIPT_ROOT;
      else process.env.WORKER_SMOKE_RECEIPT_ROOT = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects plan-owned runtime/session evidence and unsupported fixture metadata', () => {
    const runtimeId = checkSmokeTestPlan(planBody([{ action: 'inspect term_fixture123', expected: 'stable result' }]));
    expect(runtimeId.ok).toBe(false);
    expect(runtimeId.errors.join('\n')).toContain('term_fixture123');
    const mutable = checkSmokeTestPlan(planBody([{ action: 'read prompt_history.json', expected: 'stable result' }]));
    expect(mutable.ok).toBe(false);
    expect(mutable.errors.join('\n')).toContain('prompt_history.json');
    const absoluteSmoke = checkSmokeTestPlan(planBody([{
      action: 'read /tmp/repo/.orca-worker-smoke/runs/run-123/final-evidence.json',
      expected: 'stable result',
    }]));
    expect(absoluteSmoke.ok).toBe(false);
    expect(absoluteSmoke.errors.join('\n')).toContain('/tmp/repo/.orca-worker-smoke/runs/run-123/final-evidence.json');
    const absoluteCursor = checkSmokeTestPlan(planBody([{
      action: 'read /home/user/.cursor/projects/demo/terminals/term-123/output.txt',
      expected: 'stable result',
    }]));
    expect(absoluteCursor.ok).toBe(false);
    expect(absoluteCursor.errors.join('\n')).toContain('/home/user/.cursor/projects/demo/terminals/term-123/output.txt');
    const fixture = checkSmokeTestPlan([
      '```behavior-kind', 'action-producing', '```', '', '```smoke-test-plan', 'scenarios:',
      '  - action: deterministic check | expected: deterministic result', '    fixture: run-owned', '```',
    ].join('\n'));
    expect(fixture.ok).toBe(false);
    expect(fixture.errors.join('\n')).toContain('unsupported metadata key: fixture');
    expect(checkSmokeTestPlan(planBody([{ action: 'run deterministic check', expected: 'deterministic result' }])).ok).toBe(true);
  });

  it('treats only tracked or staged .orca-worker-smoke state as repository dirtiness', () => {
    expect(readFileSync('.gitignore', 'utf8')).toContain('.orca-worker-smoke/');
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-tracked-state-'));
    try {
      expect(runProcessSync({ command: 'git', args: ['init'], cwd: root }).ok).toBe(true);
      mkdirSync(join(root, '.orca-worker-smoke'), { recursive: true });
      writeFileSync(join(root, '.orca-worker-smoke', 'lifecycle.json'), '{}\n', 'utf8');
      expect(gitTrackedSmokeRuntimePaths(root)).toEqual([]);
      expect(runProcessSync({ command: 'git', args: ['add', '-f', '.orca-worker-smoke/lifecycle.json'], cwd: root }).ok).toBe(true);
      expect(gitTrackedSmokeRuntimePaths(root)).toEqual(['.orca-worker-smoke/lifecycle.json']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps worktree-local .env non-authoritative for smoke profile resolution', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-profile-env-'));
    const priorCwd = process.cwd();
    try {
      writeFileSync(join(root, '.env'), [
        'PACK_EXECUTOR_SMOKE_ROUTINE_AGENT=unsupported-agent',
        'PACK_EXECUTOR_SMOKE_ROUTINE_MODEL=wrong-model',
        'PACK_EXECUTOR_SMOKE_ROUTINE_EFFORT=wrong-effort',
      ].join('\n'), 'utf8');
      process.chdir(root);
      const profile = resolveSmokeExecutorProfile('routine', {
        PACK_EXECUTOR_SMOKE_ROUTINE_AGENT: 'cursor',
        PACK_EXECUTOR_SMOKE_ROUTINE_MODEL: 'fixture-routine-model',
        PACK_EXECUTOR_SMOKE_ROUTINE_EFFORT: 'fixture-routine-effort',
      });
      expect(profile.command).toBe("agent --model 'fixture-routine-model-fixture-routine-effort'");
    } finally {
      process.chdir(priorCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finishes ordering before detached final evidence is terminalized', () => {
    const calls: string[] = [];
    finishSmokeOrderingBeforeDetachedTerminalization(
      () => calls.push('ordering'),
      () => calls.push('terminalize'),
    );
    expect(calls).toEqual(['ordering', 'terminalize']);
  });
});
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

describe('smoke executor profiles', () => {
  const env = {
    PACK_EXECUTOR_SMOKE_ROUTINE_AGENT: 'cursor',
    PACK_EXECUTOR_SMOKE_ROUTINE_MODEL: 'fixture-routine-model',
    PACK_EXECUTOR_SMOKE_ROUTINE_EFFORT: 'fixture-routine-effort',
    PACK_EXECUTOR_SMOKE_COMPLEX_AGENT: 'cursor',
    PACK_EXECUTOR_SMOKE_COMPLEX_MODEL: 'fixture-complex-model',
    PACK_EXECUTOR_SMOKE_COMPLEX_EFFORT: 'fixture-complex-effort',
  };

  it.each([
    ['routine', 'fixture-routine-model', 'fixture-routine-effort'],
    ['complex', 'fixture-complex-model', 'fixture-complex-effort'],
  ] as const)('applies only the %s Cursor profile before spawn', (complexity, model, effort) => {
    const profile = resolveSmokeExecutorProfile(complexity, env);
    expect(profile.command).toBe(`agent --model '${model}-${effort}'`);
    expect(profile.complexity).toBe(complexity);
    expect(profile.family).toBe('cursor');
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

  it('rejects cross-path aliases, unsupported tokens, and malformed profile data', () => {
    expect(() => resolveSmokeExecutorProfile('routine', {
      ...env, PACK_EXECUTOR_SMOKE_ROUTINE_AGENT: 'cursor-agent',
    })).toThrow('smoke_profile_unsupported_agent');
    expect(() => resolveSmokeExecutorProfile('routine', {
      ...env, PACK_EXECUTOR_SMOKE_ROUTINE_AGENT: 'unsupported-agent',
    })).toThrow('smoke_profile_unsupported_agent');
    expect(() => resolveSmokeExecutorProfile('routine', {
      ...env, PACK_EXECUTOR_SMOKE_ROUTINE_MODEL: 'model with spaces',
    })).toThrow('smoke_profile_malformed');
    expect(() => resolveSmokeExecutorProfile('routine', env)).not.toThrow();
  });

  it('recognizes OpenCode through the shared smoke mapping but pure resolution stays externally gated', () => {
    expect(() => resolveSmokeExecutorProfile('routine', {
      ...env,
      PACK_EXECUTOR_SMOKE_ROUTINE_AGENT: 'opencode',
      PACK_EXECUTOR_SMOKE_ROUTINE_MODEL: 'fixture-opencode-model',
      PACK_EXECUTOR_SMOKE_ROUTINE_EFFORT: 'fixture-opencode-effort',
    })).toThrow('executor_route_unavailable');
  });

  it('smoke admits the proven OpenCode model+effort spawn shape', () => {
    const calls: string[][] = [];
    const profile = resolveLiveSmokeExecutorProfile('routine', {
      ...env,
      PACK_EXECUTOR_SMOKE_ROUTINE_AGENT: 'opencode',
      PACK_EXECUTOR_SMOKE_ROUTINE_MODEL: 'fixture-opencode-model',
      PACK_EXECUTOR_SMOKE_ROUTINE_EFFORT: 'fixture-opencode-effort',
    }, (args, extraEnv = {}) => {
      calls.push([...args]);
      if (args[0] === 'opencode' && args[1] === 'models' && args.includes('--verbose')) {
        return {
          ok: true,
          stdout: [
            'fixture-opencode-model',
            '{',
            '  "variants": {',
            '    "fixture-opencode-effort": {}',
            '  }',
            '}',
            '',
          ].join('\n'),
        };
      }
      if (args[0] === 'opencode' && args[1] === 'models') return { ok: true, stdout: 'fixture-opencode-model\n', stderr: '' };
      if (args[0] === 'opencode' && args[1] === 'debug' && args[2] === 'config') {
        return { ok: true, stdout: JSON.stringify({ default_agent: 'build' }), stderr: '' };
      }
      if (args[0] === 'opencode' && args[1] === 'debug' && args[2] === 'agent') {
        return { ok: true, stdout: JSON.stringify({ name: 'build', prompt: 'fixture', model: { providerID: 'opencode', modelID: 'fixture-opencode-model' }, variant: 'fixture-opencode-effort' }), stderr: '' };
      }
      if (args[0] === 'opencode' && args[1] === 'debug' && args[2] === 'paths') {
        return { ok: true, stdout: String(extraEnv.XDG_STATE_HOME ?? ''), stderr: '' };
      }
      if (args[0] === 'opencode' && args.includes('--help')) {
        return { ok: true, stdout: '', stderr: 'Usage: opencode --agent AGENT\n' };
      }
      if (args[0] === process.execPath) return { ok: true, stdout: '', stderr: '' };
      return { ok: false, stdout: '', stderr: '' };
    }, process.cwd(), () => true);
    expect(profile).toMatchObject({
      complexity: 'routine',
      family: 'opencode',
      agent: 'opencode',
      command: expect.stringMatching(/^OPENCODE_CONFIG_CONTENT=.*opencode --hostname 127\.0\.0\.1 --port [1-9]\d* --agent 'pack-opk-/u),
    });
    expect(calls[0]).toEqual(['opencode', 'models']);
    expect(calls).toContainEqual(['opencode', '--help']);
    expect(calls).toContainEqual(['opencode', 'models', '--verbose']);
    expect(calls).toContainEqual(['opencode', 'debug', 'config']);
    expect(calls.some((args) => args[0] === process.execPath)).toBe(true);
  });

  it('refuses OpenCode Config/Agent probes without no-write proof', () => {
    const calls: string[][] = [];
    const opencodeEnv = {
      ...env,
      PACK_EXECUTOR_SMOKE_ROUTINE_AGENT: 'opencode',
      PACK_EXECUTOR_SMOKE_ROUTINE_MODEL: 'fixture-opencode-model',
      PACK_EXECUTOR_SMOKE_ROUTINE_EFFORT: 'fixture-opencode-effort',
    };
    expect(() => resolveLiveSmokeExecutorProfile('routine', opencodeEnv, (args) => {
      calls.push([...args]);
      if (args[0] === 'opencode' && args[1] === 'models' && args.includes('--verbose')) {
        return { ok: true, stdout: 'fixture-opencode-model\n"variants": { "fixture-opencode-effort": {} }', stderr: '' };
      }
      if (args[0] === 'opencode' && args[1] === 'models') return { ok: true, stdout: 'fixture-opencode-model\n', stderr: '' };
      if (args[0] === 'opencode' && args.includes('--help')) return { ok: true, stdout: '', stderr: 'Usage: opencode --agent AGENT\n' };
      return { ok: true, stdout: '{}', stderr: '' };
    })).toThrow('executor_effort_channel_unavailable');
    expect(calls.some((args) => args[0] === 'opencode' && args[1] === 'debug')).toBe(false);
  });

  it('blocks an unsupported OpenCode effort before runtime spawn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-opencode-effort-'));
    const issueBodyFile = join(root, 'issue.md');
    writeFileSync(issueBodyFile, issueBody, 'utf8');
    expect(runProcessSync({ command: 'git', args: ['init', '--quiet'], cwd: root }).ok).toBe(true);
    const adapter = new DeterministicRuntimeAdapter();
    const spawn = vi.spyOn(adapter, 'spawnWorker');
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const opencodeEnv = {
      ...env,
      PACK_EXECUTOR_SMOKE_ROUTINE_AGENT: 'opencode',
      PACK_EXECUTOR_SMOKE_ROUTINE_MODEL: 'fixture-opencode-model',
      PACK_EXECUTOR_SMOKE_ROUTINE_EFFORT: 'fixture-opencode-effort',
    };
    try {
      const code = await runSmokeAttempt({
        command: 'run',
        issueNumber: 1610,
        prNumber: 1699,
        headSha: HEAD_ONE,
        issueBodyFile,
        smokeComplexity: 'routine',
        repoRoot: root,
        cwd: root,
        dryRun: true,
        json: true,
      }, {
        adapter,
        resolveTarget: () => ({
          repositorySlug: 'chetwerikoff/orchestrator-pack',
          issueNumber: 1610,
          prNumber: 1699,
          headSha: HEAD_ONE,
          issueBody,
          prBody: 'Closes #1610',
          issueBodyMatchesTarget: true,
          trustedPublisherLogin: 'worker-smoke-fixture',
          prOpen: true,
          baseRef: 'main',
          expectedTargetRef: 'main',
          expectedTarget: true,
        }),
        fetchHistoryComments: () => [],
        resolveProfile: (complexity) => resolveLiveSmokeExecutorProfile(complexity, opencodeEnv, (args) => {
          if (args[0] === 'opencode' && args[1] === 'models' && args.includes('--verbose')) {
            return {
              ok: true,
              stdout: [
                'fixture-opencode-model',
                '{',
                '  "variants": {',
                '    "fixture-other-effort": {}',
                '  }',
                '}',
                '',
              ].join('\n'),
              stderr: '',
            };
          }
          if (args[0] === 'opencode' && args[1] === 'models') {
            return { ok: true, stdout: 'fixture-opencode-model\n', stderr: '' };
          }
          if (args[0] === 'opencode' && args[1] === 'debug' && args[2] === 'agent') {
            return { ok: true, stdout: JSON.stringify({ model: { providerID: 'opencode', modelID: 'fixture-opencode-model' }, variant: 'fixture-opencode-effort' }), stderr: '' };
          }
          if (args[0] === 'opencode' && args.includes('--help')) {
            return { ok: true, stdout: '', stderr: 'Usage: opencode --agent AGENT\n' };
          }
          if (args[0] === process.execPath) return { ok: true, stdout: '', stderr: '' };
          return { ok: false, stdout: '', stderr: '' };
        }),
      });
      expect(code).toBe(1);
      expect(spawn).not.toHaveBeenCalled();
      expect(output.mock.calls.map((entry) => String(entry[0])).join(''))
        .toContain('executor_effort_channel_unavailable');
    } finally {
      output.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reuses shared pre-spawn effort and route refusals for OpenCode smoke', () => {
    const opencodeEnv = {
      ...env,
      PACK_EXECUTOR_SMOKE_ROUTINE_AGENT: 'opencode',
      PACK_EXECUTOR_SMOKE_ROUTINE_MODEL: 'fixture-opencode-model',
      PACK_EXECUTOR_SMOKE_ROUTINE_EFFORT: 'fixture-opencode-effort',
    };
    expect(() => resolveLiveSmokeExecutorProfile('routine', opencodeEnv, (args) => {
      if (args[0] === 'opencode' && args[1] === 'models' && args.includes('--verbose')) {
        return {
          ok: true,
          stdout: [
            'fixture-opencode-model',
            '{',
            '  "variants": {',
            '    "fixture-opencode-effort": {}',
            '  }',
            '}',
            '',
          ].join('\n'),
          stderr: '',
        };
      }
      if (args[0] === 'opencode' && args[1] === 'models') return { ok: true, stdout: 'fixture-opencode-model\n', stderr: '' };
      if (args[0] === 'opencode' && args[1] === 'debug' && args[2] === 'config') return { ok: true, stdout: JSON.stringify({}), stderr: '' };
      if (args[0] === 'opencode' && args[1] === 'debug' && args[2] === 'agent') return { ok: true, stdout: JSON.stringify({ model: { providerID: 'opencode', modelID: 'fixture-opencode-model' } }), stderr: '' };
      if (args[0] === 'opencode' && args.includes('--help')) return { ok: true, stdout: '', stderr: 'Usage: opencode --agent AGENT\n' };
      return { ok: true, stdout: 'supported help surface\n', stderr: '' };
    })).toThrow('executor_effort_channel_unavailable');

    expect(() => resolveLiveSmokeExecutorProfile('routine', opencodeEnv, (args) =>
      args[0] === 'opencode' && args[1] === 'models'
        ? { ok: false, stdout: '' }
        : { ok: true, stdout: '' },
    )).toThrow('executor_profile_applicability_unproven');
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

describe('runtime-neutral worker smoke', () => {
  it('keeps the smoke-plan authoring floor', () => {
    const result = checkSmokeTestPlan(issueBody);
    expect(result.ok).toBe(true);
    expect(result.plan?.scenarios).toHaveLength(1);
  });

  it('fails no-tier required smoke at trusted-target admission without fabricating an empty-history fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-no-tier-target-failure-'));
    const issueBodyFile = join(root, 'issue.md');
    writeFileSync(issueBodyFile, issueBody, 'utf8');
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let historyCalls = 0;
    try {
      const code = await runSmokeAttempt({
        command: 'run',
        issueNumber: 1968,
        prNumber: 2002,
        headSha: HEAD_ONE,
        issueBodyFile,
        smokeComplexity: 'routine',
        repoRoot: root,
        cwd: root,
        dryRun: true,
        json: true,
      }, {
        resolveTarget: () => {
          throw new Error('trusted_target: fixture unavailable');
        },
        fetchHistoryComments: () => {
          historyCalls += 1;
          return [];
        },
      });
      const rendered = output.mock.calls.map((entry) => String(entry[0])).join('');
      expect(code).toBe(1);
      expect(historyCalls).toBe(0);
      expect(rendered).toContain('trusted_target');
      expect(rendered).not.toContain('no_prior_canonical_observation');
    } finally {
      output.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records lawful not-applicable worker smoke as passed ordering evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-not-applicable-'));
    const issueBodyFile = join(root, 'issue.md');
    const reviewStoreRoot = join(root, 'review-store');
    const body = [
      '```smoke-test-plan',
      'not-applicable: true',
      'reason: contract-prose-only',
      '```',
    ].join('\n');
    writeFileSync(issueBodyFile, body, 'utf8');
    const previousStoreRoot = process.env.PACK_REVIEW_RUN_STORE_ROOT;
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.env.PACK_REVIEW_RUN_STORE_ROOT = reviewStoreRoot;
    let resolverCalls = 0;
    try {
      const code = await runSmokeAttempt({
        command: 'run',
        issueNumber: 1719,
        prNumber: 1721,
        headSha: HEAD_ONE,
        issueBodyFile,
        smokeComplexity: 'routine',
        repoRoot: root,
        cwd: root,
        dryRun: false,
        json: true,
      }, {
        resolveIssueBody: (_options, suppliedBody) => {
          resolverCalls += 1;
          return suppliedBody;
        },
      });
      expect(code).toBe(0);
      expect(resolverCalls).toBe(1);
      expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual({
        ok: true,
        skipped: true,
        reason: 'not-applicable',
      });
      expect(readPackReviewAuthority(1721, { storeRoot: reviewStoreRoot })?.smokeOrdering?.workerOwned).toMatchObject({
        headSha: HEAD_ONE,
        status: 'passed',
      });
    } finally {
      output.mockRestore();
      if (previousStoreRoot === undefined) delete process.env.PACK_REVIEW_RUN_STORE_ROOT;
      else process.env.PACK_REVIEW_RUN_STORE_ROOT = previousStoreRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('parses dash bullets whose action and expected result are split by the first colon', () => {
    const markdown = [
      '```smoke-test-plan',
      '- Open the deployment page: the page loads successfully',
      '- Select the release: the release details are visible',
      '```',
    ].join('\n');

    expect(parseSmokeTestPlan(markdown)).toEqual({
      requirement: 'required',
      scenarios: [
        { action: 'Open the deployment page', expected: 'the page loads successfully' },
        { action: 'Select the release', expected: 'the release details are visible' },
      ],
    });
  });

  it('parses natural-language transaction labels as colon-delimited bullets', () => {
    const markdown = [
      '```smoke-test-plan',
      '- Verify transaction: the record persists',
      '```',
    ].join('\n');

    expect(parseSmokeTestPlan(markdown)).toEqual({
      requirement: 'required',
      scenarios: [
        { action: 'Verify transaction', expected: 'the record persists' },
      ],
    });
  });

  it('rejects a reserved expected-only dash bullet', () => {
    const markdown = [
      '```smoke-test-plan',
      '- expected: the page loads',
      '```',
    ].join('\n');

    expect(parseSmokeTestPlan(markdown)).toEqual({
      requirement: 'required',
      scenarios: [],
    });
  });

  it('parses YAML-ish nested action and expected lines', () => {
    const markdown = [
      '```smoke-test-plan',
      'scenarios:',
      '  - action: open the deployment page',
      '    expected: the page loads successfully',
      '  - action: select the release',
      '    expected: the release details are visible',
      '```',
    ].join('\n');

    expect(parseSmokeTestPlan(markdown)).toEqual({
      requirement: 'required',
      scenarios: [
        { action: 'open the deployment page', expected: 'the page loads successfully' },
        { action: 'select the release', expected: 'the release details are visible' },
      ],
    });
  });

  it('keeps parsing the existing pipe-delimited form', () => {
    const markdown = [
      '```smoke-test-plan',
      '- action: open the deployment page | expected: the page loads successfully',
      '```',
    ].join('\n');

    expect(parseSmokeTestPlan(markdown)).toEqual({
      requirement: 'required',
      scenarios: [
        { action: 'open the deployment page', expected: 'the page loads successfully' },
      ],
    });
  });

  it('parses every dash bullet in the live #1532 smoke-test-plan fence', () => {
    const markdown = [
      '```smoke-test-plan',
      '- Start from a valid historical v1 WorkerAssignment store with no pointer: read succeeds; operator-primary target use returns binding_absent; callback count remains 0.',
      '- Publish one exact current local WorkerAssignment; explicitly bind it; read back the exact logical pointer and prove no runtime identity fields exist in persisted bytes or CLI show output.',
      '- Exercise attachWorkerAssignmentIssueNumber on a bound store; prove the pointer is byte/value-equivalent afterward.',
      '- Publish/replace an unrelated assignment while a primary exists; prove the pointer is unchanged.',
      '- Replace the designated assignment through the existing assignment writer; prove the old pointer remains present and target use returns binding_stale rather than binding_absent; no automatic transfer occurs.',
      '- Exercise explicit replace with the exact expected primary and prove CAS succeeds once; stale/concurrent expectation fails closed.',
      '- Exercise explicit retire with exact expectation and prove pointer absence by read-back; stale retire fails closed.',
      '- Prove remote assignment cannot be positively bound.',
      '- Positive runtime seam: current local binding -> resolveAssignmentWorker -> exact findWorker/sameRuntimeWorker -> one synchronous receipt-returning callback with the exact snapshot; no raw identity is persisted/logged as authority.',
      '- Negative runtime seam: gone/unresolved/mismatch/ABA observed by available production surfaces -> target_not_current/target_unresolved and zero callback.',
      '- Provider remap after successful snapshot is not represented as fenced; test uses only available evidence and asserts the callback receives the already-authorized snapshot without claiming bindingKey remained mapped through effect.',
      '- Reject timeoutMs <=0, non-integer, non-finite, or >5000 as deadline_invalid; prove no runtime call/action occurs.',
      '- Exhaust the wrapper-observed outer remainder before the second required top-level adapter call and prove deadline_exhausted; separately prove no test asserts a hard total wall-clock bound over Orca resolveAssignmentWorker internals.',
      '- Compile-negative TypeScript proof rejects an async function, Promise-returning function, and thenable-returning function as the public action; the positive action returns only the closed synchronous receipt.',
      '- Hold the store lock from another owner and prove binding_store_busy with zero callback.',
      '- Throw from the synchronous action after entry and prove result diagnostics preserve actionEntered=true rather than laundering the attempt into a zero-effect failure.',
      '- Restart process-level fixture with logical pointer only; freshly resolve the current runtime snapshot and prove no cached runtime identity is loaded from disk.',
      '- Downgrade rehearsal: retire current binding, exact read-back proves pointer absence, then feed the resulting historical-compatible v1 store to an older pre-#1532 parser/writer fixture; no operator-primary state remains to be silently erased.',
      '- Instrument forbidden paths during bind/resolve-only tests and prove zero publication, nudge/remediation, spawn/stop/remove, review, merge, GitHub, alternate transport, retry, or fallback calls.',
      '```',
    ].join('\n');

    const parsed = parseSmokeTestPlan(markdown);
    expect(parsed?.requirement).toBe('required');
    expect(parsed?.scenarios).toHaveLength(19);
    expect(parsed?.scenarios.every((scenario) => scenario.action.length > 0 && scenario.expected.length > 0)).toBe(true);
  });

  it('binds child PASS observations to exact plan tuples before immediate gate coverage', () => {
    const declared = [
      {
        action: 'attempt replacement while the exact current local RuntimeWorker is `busy` or `idle`',
        expected: 'replacement returns `skipped_live`/no-effect, current assignment is unchanged, and zero start/stop/cleanup/workspace/publication effect occurs',
      },
      {
        action: 'after #1415 lands, enumerate every allowed-root and production caller, including terminalized report/wake compatibility copies',
        expected: 'every pre-existing root resolves; the only intentionally absent-before-implementation files are scripts/lib/worker-assignment-store.test.ts, scripts/lib/worker-assignment-runtime.test.ts, scripts/pr2-foundation/remote-worker-assignment.ts and scripts/pr2-foundation/remote-worker-assignment.test.ts; each executable compatibility twin is either retired or kept in semantic parity without widening to a blanket tree',
      },
    ];
    const child = report('PASS', [
      scenario('attempt replacement while the exact current local RuntimeWorker is busy or idle', 'replacement returns skipped_live/no-effect and the current assignment is unchanged'),
      scenario('after #1415 lands, enumerate every allowed-root and production caller', 'the only four named #1416 files are absent while compatibility remains in parity'),
    ]);
    const plan = resolveSmokeRequirement(planBody(declared));
    const bound = bindSmokeReportToPlan(child, plan);
    expect(bound.result).toBe('PASS');
    expect(bound.scenarios).toEqual([
      { ...declared[0], observed: 'pass observed', outcome: 'pass' },
      { ...declared[1], observed: 'pass observed', outcome: 'pass' },
    ]);

    const normalized = normalizeSmokeReport(bound, { issueNumber: 1343, prNumber: 2001, headSha: HEAD_ONE });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) throw new Error(normalized.reason);
    expect(normalized.report.scenarios).toEqual([
      { ...declared[0], observed: 'pass observed', outcome: 'pass' },
      { ...declared[1], observed: 'pass observed', outcome: 'pass' },
    ]);
    expect(coverage([comment(1, normalized.report)], planBody(declared)).accepting).toBe(true);

    expect(bindSmokeReportToPlan({ ...child, scenarios: child.scenarios.slice(0, 1) }, plan).result).toBe('FAIL');
    expect(bindSmokeReportToPlan({
      ...child,
      scenarios: [child.scenarios[0]!, { ...child.scenarios[1]!, observed: '' }],
    }, plan).result).toBe('FAIL');
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

  it('requires the OpenCode child panel to leave the idle splash after HTTP delivery', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-opencode-smoke-'));
    try {
      const artifactDir = join(root, 'run-opencode');
      ensureSmokeRunArtifactDir(artifactDir);
      writeFileSync(smokeDeliverySealedPath(artifactDir), JSON.stringify({ runId: 'run-opencode' }), 'utf8');
      const identity: RuntimeWorkerIdentity = { runtime: 'orca', id: 'opencode-worker', generation: 'generation-opencode' };
      let reads = 0;
      const adapter = {
        composerControl: () => ({ kind: 'opencode-http' as const, dispatch: () => ({ status: 'dispatched' as const }) }),
        dispatchInput: () => ({ status: 'dispatched' as const }),
        readBoundedOutput: () => {
          reads += 1;
          return {
            status: 'ok' as const,
            value: {
              worker: identity,
              lines: reads === 1 ? ['real idle splash'] : ['pointer rendered in child panel'],
              observationToken: { opaque: `screen-${reads}` },
              changed: reads > 1,
              terminalState: 'running' as const,
              source: 'screen' as const,
            },
          };
        },
      } as unknown as RuntimeAdapter;

      const result = establishRuntimeSmokeDelivery({
        adapter,
        worker: identity,
        prompt: 'verify visible pointer',
        binding: { runId: 'run-opencode', artifactDir },
        cwd: root,
        deadlineMs: 100,
        now: () => 1,
        sleepMs: () => undefined,
      });

      expect(result.ok).toBe(true);
      expect(reads).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails OpenCode smoke when the child panel remains on the idle splash', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-opencode-idle-'));
    try {
      const artifactDir = join(root, 'run-opencode-idle');
      ensureSmokeRunArtifactDir(artifactDir);
      writeFileSync(smokeDeliverySealedPath(artifactDir), JSON.stringify({ runId: 'run-opencode-idle' }), 'utf8');
      const identity: RuntimeWorkerIdentity = { runtime: 'orca', id: 'opencode-worker', generation: 'generation-opencode' };
      let clock = 0;
      const adapter = {
        composerControl: () => ({ kind: 'opencode-http' as const, dispatch: () => ({ status: 'dispatched' as const }) }),
        dispatchInput: () => ({ status: 'dispatched' as const }),
        readBoundedOutput: () => ({
          status: 'ok' as const,
          value: {
            worker: identity,
            lines: ['real idle splash'],
            observationToken: { opaque: 'screen-idle' },
            changed: false,
            terminalState: 'running' as const,
            source: 'screen' as const,
          },
        }),
      } as unknown as RuntimeAdapter;

      const result = establishRuntimeSmokeDelivery({
        adapter,
        worker: identity,
        prompt: 'verify invisible pointer',
        binding: { runId: 'run-opencode-idle', artifactDir },
        cwd: root,
        deadlineMs: 100,
        now: () => clock,
        sleepMs: () => { clock = 100; },
      });

      expect(result).toEqual({ ok: false, reason: 'opencode_panel_idle_splash', submitCount: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retries transient OpenCode baseline observations without dispatching until a screen is visible', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-opencode-baseline-retry-'));
    try {
      const artifactDir = join(root, 'run-opencode-baseline-retry');
      ensureSmokeRunArtifactDir(artifactDir);
      writeFileSync(smokeDeliverySealedPath(artifactDir), JSON.stringify({ runId: 'run-opencode-baseline-retry' }), 'utf8');
      const identity: RuntimeWorkerIdentity = { runtime: 'orca', id: 'opencode-worker', generation: 'generation-opencode' };
      let clock = 0;
      let reads = 0;
      const sleeps: number[] = [];
      const dispatchInput = vi.fn(() => ({ status: 'dispatched' as const }));
      const adapter = {
        composerControl: () => ({ kind: 'opencode-http' as const, dispatch: () => ({ status: 'dispatched' as const }) }),
        dispatchInput,
        readBoundedOutput: () => {
          reads += 1;
          if (reads === 1) {
            return { status: 'unsupported' as const, operation: 'read_bounded_output' as const, reason: 'runtime_output_source_unobservable' };
          }
          return {
            status: 'ok' as const,
            value: {
              worker: identity,
              lines: reads === 2 ? ['real idle splash'] : ['pointer rendered in child panel'],
              observationToken: { opaque: `screen-${reads}` },
              changed: reads > 2,
              terminalState: 'running' as const,
              source: 'screen' as const,
            },
          };
        },
      } as unknown as RuntimeAdapter;

      const result = establishRuntimeSmokeDelivery({
        adapter,
        worker: identity,
        prompt: 'verify visible pointer',
        binding: { runId: 'run-opencode-baseline-retry', artifactDir },
        cwd: root,
        deadlineMs: 1_000,
        now: () => clock,
        sleepMs: (milliseconds) => { sleeps.push(milliseconds); clock += milliseconds; },
      });

      expect(result.ok).toBe(true);
      expect(reads).toBe(3);
      expect(dispatchInput).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([250]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('times out a persistently unobservable OpenCode baseline without dispatching', () => {
    const identity: RuntimeWorkerIdentity = { runtime: 'orca', id: 'opencode-worker', generation: 'generation-opencode' };
    let clock = 0;
    let reads = 0;
    const sleeps: number[] = [];
    const dispatchInput = vi.fn(() => ({ status: 'dispatched' as const }));
    const adapter = {
      composerControl: () => ({ kind: 'opencode-http' as const, dispatch: () => ({ status: 'dispatched' as const }) }),
      dispatchInput,
      readBoundedOutput: () => {
        reads += 1;
        return { status: 'unsupported' as const, operation: 'read_bounded_output' as const, reason: 'runtime_output_source_unobservable' };
      },
    } as unknown as RuntimeAdapter;

    expect(establishRuntimeSmokeDelivery({
      adapter,
      worker: identity,
      prompt: 'verify',
      binding: { runId: 'run-opencode-baseline-timeout', artifactDir: '/missing' },
      cwd: process.cwd(),
      deadlineMs: 500,
      now: () => clock,
      sleepMs: (milliseconds) => { sleeps.push(milliseconds); clock += milliseconds; },
    })).toEqual({
      ok: false,
      reason: 'opencode_panel_observation_failed:read_bounded_output:unsupported:runtime_output_source_unobservable',
      submitCount: 0,
    });
    expect(reads).toBe(2);
    expect(dispatchInput).not.toHaveBeenCalled();
    expect(sleeps).toEqual([250, 250]);
  });

  it.each(['runtime_output_shape_unsupported', 'runtime_output_progress_unavailable'] as const)(
    'keeps baseline %s terminal without retry',
    (reason) => {
      const identity: RuntimeWorkerIdentity = { runtime: 'orca', id: 'opencode-worker', generation: 'generation-opencode' };
      const dispatchInput = vi.fn(() => ({ status: 'dispatched' as const }));
      const sleepMs = vi.fn();
      const adapter = {
        composerControl: () => ({ kind: 'opencode-http' as const, dispatch: () => ({ status: 'dispatched' as const }) }),
        dispatchInput,
        readBoundedOutput: () => ({ status: 'unsupported' as const, operation: 'read_bounded_output' as const, reason }),
      } as unknown as RuntimeAdapter;

      expect(establishRuntimeSmokeDelivery({
        adapter,
        worker: identity,
        prompt: 'verify',
        binding: { runId: 'run-opencode-baseline-terminal', artifactDir: '/missing' },
        cwd: process.cwd(),
        deadlineMs: 500,
        now: () => 0,
        sleepMs,
      })).toEqual({
        ok: false,
        reason: `opencode_panel_observation_failed:read_bounded_output:unsupported:${reason}`,
        submitCount: 0,
      });
      expect(dispatchInput).not.toHaveBeenCalled();
      expect(sleepMs).not.toHaveBeenCalled();
    },
  );

  it('retries transient post-dispatch observations without redispatch and recovers on progress', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-opencode-post-retry-'));
    try {
      const artifactDir = join(root, 'run-opencode-post-retry');
      ensureSmokeRunArtifactDir(artifactDir);
      writeFileSync(smokeDeliverySealedPath(artifactDir), JSON.stringify({ runId: 'run-opencode-post-retry' }), 'utf8');
      const identity: RuntimeWorkerIdentity = { runtime: 'orca', id: 'opencode-worker', generation: 'generation-opencode' };
      let clock = 0;
      let reads = 0;
      const sleeps: number[] = [];
      const dispatchInput = vi.fn(() => ({ status: 'dispatched' as const }));
      const adapter = {
        composerControl: () => ({ kind: 'opencode-http' as const, dispatch: () => ({ status: 'dispatched' as const }) }),
        dispatchInput,
        readBoundedOutput: () => {
          reads += 1;
          if (reads === 2) {
            return { status: 'unsupported' as const, operation: 'read_bounded_output' as const, reason: 'runtime_output_source_unobservable' };
          }
          return {
            status: 'ok' as const,
            value: {
              worker: identity,
              lines: reads === 1 ? ['real idle splash'] : ['pointer rendered in child panel'],
              observationToken: { opaque: `screen-${reads}` },
              changed: reads > 1,
              terminalState: 'running' as const,
              source: 'screen' as const,
            },
          };
        },
      } as unknown as RuntimeAdapter;

      const result = establishRuntimeSmokeDelivery({
        adapter,
        worker: identity,
        prompt: 'verify visible pointer',
        binding: { runId: 'run-opencode-post-retry', artifactDir },
        cwd: root,
        deadlineMs: 1_000,
        now: () => clock,
        sleepMs: (milliseconds) => { sleeps.push(milliseconds); clock += milliseconds; },
      });

      expect(result.ok).toBe(true);
      expect(reads).toBe(3);
      expect(dispatchInput).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([250]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves the latest transient post-dispatch observation failure at deadline without redispatch', () => {
    const identity: RuntimeWorkerIdentity = { runtime: 'orca', id: 'opencode-worker', generation: 'generation-opencode' };
    let clock = 0;
    let reads = 0;
    const sleeps: number[] = [];
    const dispatchInput = vi.fn(() => ({ status: 'dispatched' as const }));
    const adapter = {
      composerControl: () => ({ kind: 'opencode-http' as const, dispatch: () => ({ status: 'dispatched' as const }) }),
      dispatchInput,
      readBoundedOutput: () => {
        reads += 1;
        if (reads === 1) {
          return {
            status: 'ok' as const,
            value: {
              worker: identity,
              lines: ['real idle splash'],
              observationToken: { opaque: 'screen-baseline' },
              changed: false,
              terminalState: 'running' as const,
              source: 'screen' as const,
            },
          };
        }
        return { status: 'unsupported' as const, operation: 'read_bounded_output' as const, reason: 'runtime_output_source_unobservable' };
      },
    } as unknown as RuntimeAdapter;

    expect(establishRuntimeSmokeDelivery({
      adapter,
      worker: identity,
      prompt: 'verify',
      binding: { runId: 'run-opencode-post-timeout', artifactDir: '/missing' },
      cwd: process.cwd(),
      deadlineMs: 500,
      now: () => clock,
      sleepMs: (milliseconds) => { sleeps.push(milliseconds); clock += milliseconds; },
    })).toEqual({
      ok: false,
      reason: 'opencode_panel_observation_failed:read_bounded_output:unsupported:runtime_output_source_unobservable',
      submitCount: 0,
    });
    expect(reads).toBe(3);
    expect(dispatchInput).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([250, 250]);
  });

  it('clears a recovered transient post-dispatch failure before preserving idle-splash timeout behavior', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-opencode-post-idle-'));
    try {
      const artifactDir = join(root, 'run-opencode-post-idle');
      ensureSmokeRunArtifactDir(artifactDir);
      writeFileSync(smokeDeliverySealedPath(artifactDir), JSON.stringify({ runId: 'run-opencode-post-idle' }), 'utf8');
      const identity: RuntimeWorkerIdentity = { runtime: 'orca', id: 'opencode-worker', generation: 'generation-opencode' };
      let clock = 0;
      let reads = 0;
      const sleeps: number[] = [];
      const dispatchInput = vi.fn(() => ({ status: 'dispatched' as const }));
      const adapter = {
        composerControl: () => ({ kind: 'opencode-http' as const, dispatch: () => ({ status: 'dispatched' as const }) }),
        dispatchInput,
        readBoundedOutput: () => {
          reads += 1;
          if (reads === 2) {
            return { status: 'unsupported' as const, operation: 'read_bounded_output' as const, reason: 'runtime_output_source_unobservable' };
          }
          return {
            status: 'ok' as const,
            value: {
              worker: identity,
              lines: ['real idle splash'],
              observationToken: { opaque: `screen-${reads}` },
              changed: false,
              terminalState: 'running' as const,
              source: 'screen' as const,
            },
          };
        },
      } as unknown as RuntimeAdapter;

      expect(establishRuntimeSmokeDelivery({
        adapter,
        worker: identity,
        prompt: 'verify invisible pointer',
        binding: { runId: 'run-opencode-post-idle', artifactDir },
        cwd: root,
        deadlineMs: 500,
        now: () => clock,
        sleepMs: (milliseconds) => { sleeps.push(milliseconds); clock += milliseconds; },
      })).toEqual({ ok: false, reason: 'opencode_panel_idle_splash', submitCount: 0 });
      expect(reads).toBe(3);
      expect(dispatchInput).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([250, 250]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['runtime_output_shape_unsupported', 'runtime_output_progress_unavailable'] as const)(
    'keeps post-dispatch %s terminal on first sight without retry',
    (reason) => {
      const identity: RuntimeWorkerIdentity = { runtime: 'orca', id: 'opencode-worker', generation: 'generation-opencode' };
      let reads = 0;
      const dispatchInput = vi.fn(() => ({ status: 'dispatched' as const }));
      const sleepMs = vi.fn();
      const adapter = {
        composerControl: () => ({ kind: 'opencode-http' as const, dispatch: () => ({ status: 'dispatched' as const }) }),
        dispatchInput,
        readBoundedOutput: () => {
          reads += 1;
          if (reads === 1) {
            return {
              status: 'ok' as const,
              value: {
                worker: identity,
                lines: ['real idle splash'],
                observationToken: { opaque: 'screen-baseline' },
                changed: false,
                terminalState: 'running' as const,
                source: 'screen' as const,
              },
            };
          }
          return { status: 'unsupported' as const, operation: 'read_bounded_output' as const, reason };
        },
      } as unknown as RuntimeAdapter;

      expect(establishRuntimeSmokeDelivery({
        adapter,
        worker: identity,
        prompt: 'verify',
        binding: { runId: 'run-opencode-post-terminal', artifactDir: '/missing' },
        cwd: process.cwd(),
        deadlineMs: 500,
        now: () => 0,
        sleepMs,
      })).toEqual({
        ok: false,
        reason: `opencode_panel_observation_failed:read_bounded_output:unsupported:${reason}`,
        submitCount: 0,
      });
      expect(reads).toBe(2);
      expect(dispatchInput).toHaveBeenCalledTimes(1);
      expect(sleepMs).not.toHaveBeenCalled();
    },
  );

  it('never resends after dispatch_unknown', () => {
    const adapter = new DeterministicRuntimeAdapter();
    const spawned = adapter.spawnWorker({ title: 'smoke', command: 'cursor-agent' });
    expect(spawned.status).toBe('ok');
    if (spawned.status !== 'ok') return;
    const dispatch = vi.spyOn(adapter, 'dispatchInput').mockImplementation((
      _input: { readonly worker: RuntimeWorkerIdentity; readonly text?: string; readonly submitOnly?: boolean },
    ): RuntimeDispatchResult => ({ status: 'dispatch_unknown', reason: 'transport_interrupted' }));
    let clock = 0;

    expect(establishRuntimeSmokeDelivery({
      adapter,
      worker: spawned.value.identity,
      prompt: 'verify',
      binding: { runId: 'run-2', artifactDir: '/missing' },
      cwd: process.cwd(),
      deadlineMs: 2,
      now: () => clock++,
      sleepMs: () => undefined,
    })).toEqual({
      ok: false,
      reason: 'dispatch_unknown:transport_interrupted',
      submitCount: 0,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting when the first clock tick does not advance until delivery.sealed.json appears', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-smoke-stall-'));
    try {
      const artifactDir = join(root, 'run-stall');
      ensureSmokeRunArtifactDir(artifactDir);
      const adapter = new DeterministicRuntimeAdapter();
      const spawned = adapter.spawnWorker({ title: 'smoke', command: 'cursor-agent' });
      expect(spawned.status).toBe('ok');
      if (spawned.status !== 'ok') return;
      const dispatch = vi.spyOn(adapter, 'dispatchInput');

      const result = establishRuntimeSmokeDelivery({
        adapter,
        worker: spawned.value.identity,
        prompt: 'verify',
        binding: { runId: 'run-stall', artifactDir },
        cwd: root,
        deadlineMs: 100,
        now: () => 1,
        sleepMs: () => {
          writeFileSync(smokeDeliverySealedPath(artifactDir), JSON.stringify({ runId: 'run-stall' }), 'utf8');
        },
      });

      expect(result.ok).toBe(true);
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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


describe('waitForRuntimeSmokeCompletion post-plan completion wait', () => {
  const POLL_MS = SMOKE_LIFECYCLE_POLL_MS;
  const STALL_MS = 1_500_000;
  const CEILING_MS = 14_400_000;
  const passBody = [
    '```worker-smoke-report',
    'result: PASS',
    'tracked-files-unmodified: true',
    'scenarios:',
    '  - action: execute sealed completion | expected: one sealed report | observed: report sealed | outcome: pass',
    '```',
  ].join('\n');

  function buildValidProgressFixture(artifactDir: string, runId: string, scenarioCount: number): void {
    const progressPath = join(artifactDir, 'progress.ndjson');
    const lines: string[] = [];
    for (let i = 1; i <= scenarioCount; i++) {
      lines.push(JSON.stringify({ runId, scenarioOrdinal: i, phase: 'started' }));
      lines.push(JSON.stringify({ runId, scenarioOrdinal: i, phase: 'terminal', outcome: 'pass' }));
    }
    writeFileSync(progressPath, lines.join('\n') + '\n', 'utf8');
  }

  function assertValidProgressAndComplete(artifactDir: string, runId: string, scenarioCount: number): void {
    const inspection = inspectSmokeProgress({ artifactDir, runId, scenarioCount });
    expect(inspection.planComplete).toBe(true);
    expect(inspection.invalidEvents).toHaveLength(0);
  }


  function writeSeal(artifactDir: string, runId: string): void {
    const digest = computeSmokeCompletionBodyDigest(passBody);
    writeFileSync(smokeCompletionBodyPath(artifactDir, digest), passBody, 'utf8');
    writeFileSync(
      smokeCompletionSealPath(artifactDir, digest),
      JSON.stringify({ runId, bodySha256: digest }),
      'utf8',
    );
  }

  function setup(suffix: string): {
    root: string;
    artifactDir: string;
    adapter: DeterministicRuntimeAdapter;
    worker: RuntimeWorkerIdentity;
  } {
    const root = mkdtempSync(join(tmpdir(), `completion-${suffix}-`));
    const artifactDir = join(root, 'run');
    const adapter = new DeterministicRuntimeAdapter();
    const spawned = adapter.spawnWorker({ title: 'completion', command: 'cursor-agent' });
    if (spawned.status !== 'ok') throw new Error('test worker did not spawn');
    ensureSmokeRunArtifactDir(artifactDir);
    return { root, artifactDir, adapter, worker: spawned.value.identity };
  }

  function runDelayedSeal(partial: boolean): {
    completion: ReturnType<typeof waitForRuntimeSmokeCompletion>;
    sleeps: number[];
    idlePollsBeforeSeal: number;
    readCalls: number;
    livenessCalls: number;
  } {
    const fixture = setup(partial ? 'partial' : 'none');
    const sleeps: number[] = [];
    const reads = vi.spyOn(fixture.adapter, 'readBoundedOutput');
    const liveness = vi.spyOn(fixture.adapter, 'liveness');
    fixture.adapter.setLiveness(fixture.worker, 'idle');
    if (partial) writeFileSync(smokeCompletionPendingBodyPath(fixture.artifactDir), 'in progress', 'utf8');
    buildValidProgressFixture(fixture.artifactDir, 'completion-run', 1);
    assertValidProgressAndComplete(fixture.artifactDir, 'completion-run', 1);
    let clock = 0;
    let idlePollsBeforeSeal = 0;
    let sealWritten = false;
    try {
      const completion = waitForRuntimeSmokeCompletion({
        adapter: fixture.adapter,
        worker: fixture.worker,
        binding: { runId: 'completion-run', artifactDir: fixture.artifactDir },
        scenarioCount: 1,
        cwd: fixture.root,
        startedAtMs: 0,
        abortReason: () => undefined,
        now: () => clock,
        sleepMs: (milliseconds) => {
          sleeps.push(milliseconds);
          clock += milliseconds;
          if (!sealWritten) idlePollsBeforeSeal += 1;
          if (idlePollsBeforeSeal === 3) {
            sealWritten = true;
            if (partial) rmSync(smokeCompletionPendingBodyPath(fixture.artifactDir), { force: true });
            writeSeal(fixture.artifactDir, 'completion-run');
          }
        },
        absoluteCeilingMs: CEILING_MS,
        progressStallMs: STALL_MS,
      });
      return {
        completion,
        sleeps,
        idlePollsBeforeSeal,
        readCalls: reads.mock.calls.length,
        livenessCalls: liveness.mock.calls.length,
      };
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }

  it('stays pending through multiple idle polls before a delayed completion seal appears', () => {
    const result = runDelayedSeal(false);
    expect(result.completion.reason ?? '').not.toContain('agent_idle_without_report');
    expect(result.completion).toMatchObject({ ok: true, partial: { result: 'PASS' } });
    expect(result.idlePollsBeforeSeal).toBe(3);
    expect(result.sleeps.slice(0, 3)).toEqual([POLL_MS, POLL_MS, POLL_MS * 2]);
    expect(result.readCalls).toBe(3);
    expect(result.livenessCalls).toBe(3);
  });

  it('stays pending with partial publication through idle polls before a delayed completion seal appears', () => {
    const result = runDelayedSeal(true);
    expect(result.completion.reason ?? '').not.toContain('agent_idle_without_report');
    expect(result.completion).toMatchObject({ ok: true, partial: { result: 'PASS' } });
    expect(result.idlePollsBeforeSeal).toBe(3);
    expect(result.sleeps.slice(0, 3)).toEqual([POLL_MS, POLL_MS, POLL_MS * 2]);
    expect(result.readCalls).toBe(3);
    expect(result.livenessCalls).toBe(3);
  });

  it('fails fast for wrong-run binding with the existing idle cause', () => {
    const fixture = setup('wrong-run');
    const reads = vi.spyOn(fixture.adapter, 'readBoundedOutput');
    fixture.adapter.setLiveness(fixture.worker, 'idle');
    buildValidProgressFixture(fixture.artifactDir, 'expected-run', 1);
    assertValidProgressAndComplete(fixture.artifactDir, 'expected-run', 1);
    try {
      writeSeal(fixture.artifactDir, 'other-run');
      const completion = waitForRuntimeSmokeCompletion({
        adapter: fixture.adapter,
        worker: fixture.worker,
        binding: { runId: 'expected-run', artifactDir: fixture.artifactDir },
        scenarioCount: 1,
        cwd: fixture.root,
        startedAtMs: 0,
        abortReason: () => undefined,
        now: () => 0,
        sleepMs: () => { throw new Error('wrong-run observation must fail before sleeping'); },
        absoluteCeilingMs: CEILING_MS,
        progressStallMs: STALL_MS,
      });
      expect(completion.ok).toBe(false);
      expect(completion.reason).toContain('agent_idle_without_report');
      expect(completion.reason).toContain('missing=sealed_report_for_expected_run');
      expect(completion.reason).toContain('wrong_run_binding=true');
      expect(reads).not.toHaveBeenCalled();
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(['gone', 'exited'] as const)('keeps child %s failure behavior without a valid seal', (terminalState) => {
    const fixture = setup(`child-${terminalState}`);
    const read = vi.spyOn(fixture.adapter, 'readBoundedOutput');
    if (terminalState === 'gone') {
      fixture.adapter.setLiveness(fixture.worker, 'gone');
    } else {
      read.mockReturnValue({
        status: 'ok',
        value: {
          worker: fixture.worker,
          lines: [],
          observationToken: { opaque: 'exited' },
          changed: false,
          terminalState: 'exited',
          source: 'stream',
        },
      });
    }
    buildValidProgressFixture(fixture.artifactDir, 'completion-run', 1);
    assertValidProgressAndComplete(fixture.artifactDir, 'completion-run', 1);
    try {
      const completion = waitForRuntimeSmokeCompletion({
        adapter: fixture.adapter,
        worker: fixture.worker,
        binding: { runId: 'completion-run', artifactDir: fixture.artifactDir },
        scenarioCount: 1,
        cwd: fixture.root,
        startedAtMs: 0,
        abortReason: () => undefined,
        now: () => 0,
        sleepMs: () => { throw new Error('child exit must not sleep'); },
        absoluteCeilingMs: 1_000,
        progressStallMs: 900,
      });
      expect(completion.ok).toBe(false);
      expect(completion.reason).toContain('agent_exited_without_report');
      expect(completion.reason).not.toContain('agent_idle_without_report');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('backs off stalled idle polling while still probing completion and liveness', () => {
    const fixture = setup('stall');
    const sleeps: number[] = [];
    const reads = vi.spyOn(fixture.adapter, 'readBoundedOutput');
    const liveness = vi.spyOn(fixture.adapter, 'liveness');
    fixture.adapter.setLiveness(fixture.worker, 'idle');
    buildValidProgressFixture(fixture.artifactDir, 'completion-run', 1);
    assertValidProgressAndComplete(fixture.artifactDir, 'completion-run', 1);
    let clock = 0;
    try {
      const completion = waitForRuntimeSmokeCompletion({
        adapter: fixture.adapter,
        worker: fixture.worker,
        binding: { runId: 'completion-run', artifactDir: fixture.artifactDir },
        scenarioCount: 1,
        cwd: fixture.root,
        startedAtMs: 0,
        abortReason: () => undefined,
        now: () => clock,
        sleepMs: (milliseconds) => { sleeps.push(milliseconds); clock += milliseconds; },
        absoluteCeilingMs: CEILING_MS,
        progressStallMs: STALL_MS,
      });
      expect(completion.ok).toBe(false);
      expect(completion.reason).toContain('agent_report_timeout');
      expect(completion.reason).toContain('reason=progress_stall');
      expect(completion.reason).not.toContain('agent_idle_without_report');
      expect(sleeps).toEqual([
        POLL_MS, POLL_MS, POLL_MS * 2, POLL_MS * 4, POLL_MS * 8,
        POLL_MS * 16, POLL_MS * 32, POLL_MS * 64, POLL_MS * 128, POLL_MS * 256,
        POLL_MS * 512, POLL_MS * 1_024, POLL_MS * 2_048,
        STALL_MS - (POLL_MS * 4_096),
      ]);
      expect(reads.mock.calls.length).toBeLessThan(40);
      expect(reads).toHaveBeenCalledTimes(liveness.mock.calls.length);
      expect(liveness).toHaveBeenCalledTimes(reads.mock.calls.length);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('keeps incomplete-plan polling at 250ms before post-plan backoff begins', () => {
    const fixture = setup('progress-reset');
    const sleeps: number[] = [];
    const acceptedCounts: number[] = [];
    const originalLiveness = fixture.adapter.liveness.bind(fixture.adapter);
    vi.spyOn(fixture.adapter, 'liveness').mockImplementation((input) => {
      acceptedCounts.push(inspectSmokeProgress({
        artifactDir: fixture.artifactDir,
        runId: 'completion-run',
        scenarioCount: 2,
      }).acceptedCount);
      return originalLiveness(input);
    });
    fixture.adapter.setLiveness(fixture.worker, 'busy');
    buildValidProgressFixture(fixture.artifactDir, 'completion-run', 1);
    assertValidProgressAndComplete(fixture.artifactDir, 'completion-run', 1);
    expect(inspectSmokeProgress({
      artifactDir: fixture.artifactDir,
      runId: 'completion-run',
      scenarioCount: 2,
    }).planComplete).toBe(false);
    let clock = 0;
    let planCompleted = false;
    try {
      const completion = waitForRuntimeSmokeCompletion({
        adapter: fixture.adapter,
        worker: fixture.worker,
        binding: { runId: 'completion-run', artifactDir: fixture.artifactDir },
        scenarioCount: 2,
        cwd: fixture.root,
        startedAtMs: 0,
        abortReason: () => undefined,
        now: () => clock,
        sleepMs: (milliseconds) => {
          sleeps.push(milliseconds);
          clock += milliseconds;
          if (sleeps.length === 4 && !planCompleted) {
            planCompleted = true;
            appendFileSync(join(fixture.artifactDir, 'progress.ndjson'), [
              JSON.stringify({ runId: 'completion-run', scenarioOrdinal: 2, phase: 'started' }),
              JSON.stringify({ runId: 'completion-run', scenarioOrdinal: 2, phase: 'terminal', outcome: 'pass' }),
              '',
            ].join('\n'), 'utf8');
          }
          if (sleeps.length === 7) fixture.adapter.setLiveness(fixture.worker, 'gone');
        },
        absoluteCeilingMs: CEILING_MS,
        progressStallMs: STALL_MS,
      });
      expect(completion.ok).toBe(false);
      expect(completion.reason).toContain('agent_exited_without_report');
      expect(acceptedCounts).toEqual([2, 2, 2, 2, 4, 4, 4, 4]);
      expect(planCompleted).toBe(true);
      expect(sleeps.slice(0, 4)).toEqual([POLL_MS, POLL_MS, POLL_MS, POLL_MS]);
      expect(sleeps.slice(4)).toEqual([POLL_MS, POLL_MS, POLL_MS * 2]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
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

describe('publishPrComment', () => {
  it('publishes via gh api --input temp file', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-publish-'));
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const argvFile = join(root, 'argv.json');
    const payloadFile = join(root, 'payload.json');
    executable(join(bin, 'gh'), `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)), 'utf8');
const idx = process.argv.indexOf('--input');
if (idx !== -1) {
  writeFileSync(${JSON.stringify(payloadFile)}, readFileSync(process.argv[idx + 1], 'utf8'), 'utf8');
}
`);
    const body = 'hello\nworld';
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    try {
      publishPrComment(1586, body, root);
      const argv = JSON.parse(readFileSync(argvFile, 'utf8'));
      expect(argv).toEqual(['api', 'repos/chetwerikoff/orchestrator-pack/issues/1586/comments', '--method', 'POST', '--input', expect.stringMatching(/worker-smoke-comment-[^/]+\/body\.md$/u)]);
      const payload = JSON.parse(readFileSync(payloadFile, 'utf8'));
      expect(payload.body).toBe(body);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

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

  it('accepts a legacy fixture newline while the gate re-resolves the freshly fetched Issue body', async () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-caller-gate-'));
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const body = planBody([{ action: 'caller writes Issue body', expected: 'gate evaluates fetched bytes' }]);
    const issueBodyFile = join(root, 'caller-issue.md');
    const nativeCallsFile = join(root, 'native-calls.jsonl');
    writeFileSync(issueBodyFile, `${body}\n`, 'utf8');
    const suppliedBody = readFileSync(issueBodyFile, 'utf8');
    expect(suppliedBody).toBe(`${body}\n`);

    symlinkSync(process.execPath, join(bin, 'gh'));
    writeFileSync(join(root, 'api'), `
const { appendFileSync } = require('node:fs');
const endpoint = process.argv[2] ?? '';
appendFileSync(${JSON.stringify(nativeCallsFile)}, JSON.stringify({ endpoint, wrapperActive: process.env.GH_WRAPPER_ACTIVE ?? '' }) + '\\n', 'utf8');
if (endpoint === 'user') {
  process.stdout.write(JSON.stringify({ login: '${TRUSTED_ACTOR}' }));
} else if (endpoint.endsWith('/issues/1343')) {
  process.stdout.write(JSON.stringify({
    number: 1343,
    body: ${JSON.stringify(body)},
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
} else if (endpoint === 'repos/${REPOSITORY}') {
  process.stdout.write(JSON.stringify({ default_branch: 'main' }));
} else {
  process.stderr.write('unexpected endpoint: ' + endpoint);
  process.exitCode = 2;
}
`, 'utf8');
    expect(runChild('git', ['init', '--quiet', root], { encoding: 'utf8' }).status).toBe(0);
    expect(runChild(
      'git',
      ['-C', root, 'remote', 'add', 'origin', `https://github.com/${REPOSITORY}.git`],
      { encoding: 'utf8' },
    ).status).toBe(0);

    const previousPath = process.env.PATH;
    const previousReceiptRoot = process.env.WORKER_SMOKE_RECEIPT_ROOT;
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
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
      const nativeCalls = readFileSync(nativeCallsFile, 'utf8')
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { endpoint: string; wrapperActive: string });
      expect(nativeCalls.length).toBeGreaterThan(0);
      expect(nativeCalls.every((call) => call.wrapperActive === '1')).toBe(true);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
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
        ...report('FAIL', [{ ...scenario('A', 'A passes', 'fail'), causeFamily: 'scenario_assertion_failed' }]),
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
        const expectedWitness = 'terminal-fail';
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
describe('buildSmokeAgentPrompt selected declaration artifact', () => {
  it('skips docs/declarations/<issue>.pr-scope.json from product path accounting', () => {
    const prompt = buildSmokeAgentPrompt({
      issueNumber: 1260,
      issueBody: ['```smoke-test-plan', 'scenarios:', '  - action: scan paths | expected: only seven allowed paths', '```'].join('\n'),
      prNumber: 1609,
      headSha: 'a'.repeat(40),
      plan: {
        requirement: 'required',
        scenarios: [{ action: 'scan paths', expected: 'only seven allowed paths' }],
      },
    });

    expect(prompt).toContain('docs/declarations/1260.pr-scope.json');
    expect(prompt).toMatch(/skipped from product changed-path accounting/u);
    expect(prompt).toMatch(/selectedArtifactPath/u);
    expect(prompt).toMatch(/Do not FAIL an exact-scope or allowed-path scenario solely because that file appears in git diff/u);
  });

  it('advises bounded await handling for shell jobs', () => {
    const prompt = buildSmokeAgentPrompt({
      issueNumber: 1260,
      issueBody: ['```smoke-test-plan', 'scenarios:', '  - action: scan paths | expected: only seven allowed paths', '```'].join('\n'),
      prNumber: 1609,
      headSha: 'a'.repeat(40),
      plan: {
        requirement: 'required',
        scenarios: [{ action: 'scan paths', expected: 'only seven allowed paths' }],
      },
    });

    expect(prompt).toContain('Never await a shell that has already ended: read ~/.cursor/projects/<slug>/terminals/<shell_id>.txt first — if its tail carries exit_code:, the job is over and await will burn the whole ceiling instead of returning.');
    expect(prompt).toContain('Cap any single block_until_ms at 300000; re-check and re-await instead of one long block.');
  });
});

describe('independent pass is stored only after publication', () => {
  const action = 'publish the independent report';
  const expected = 'store passed only after the canonical comment exists';

  function tieredBody(): string {
    return [
      '```behavior-kind',
      'action-producing',
      '```',
      '',
      '```complexity-tier',
      'tier: T2',
      '```',
      '',
      '```smoke-test-plan',
      'scenarios:',
      `  - action: ${action} | expected: ${expected}`,
      '```',
    ].join('\n');
  }

  function gitFixture(prefix: string): { root: string; headSha: string } {
    const root = mkdtempSync(join(tmpdir(), prefix));
    const git = (...args: string[]): string => {
      const result = runProcessSync({ command: 'git', args, cwd: root });
      if (!result.ok) throw new Error(result.stderr || result.stdout || args.join(' '));
      return result.stdout.trim();
    };
    git('init', '--quiet');
    git('config', 'user.name', 'Ordering Fixture');
    git('config', 'user.email', 'ordering@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, 'fixture.txt'), 'fixture\n', 'utf8');
    git('add', 'fixture.txt');
    git('commit', '-m', 'fixture');
    return { root, headSha: git('rev-parse', 'HEAD').toLowerCase() };
  }

  async function runOrdering(input: {
    prefix: string;
    prNumber: number;
    actor: 'independent' | 'worker-owned';
    history: boolean;
    publishComment: (prNumber: number, body: string, repoRoot: string) => void;
    spawnFails?: boolean;
    receiptWriteFails?: boolean;
  }): Promise<{ code?: number; error?: unknown; headSha: string; storeRoot: string; root: string }> {
    const fixture = gitFixture(input.prefix);
    const body = tieredBody();
    const issueBodyFile = join(fixture.root, 'issue.md');
    writeFileSync(issueBodyFile, body, 'utf8');
    const adapter = new DeterministicRuntimeAdapter();
    Object.defineProperty(adapter, 'readiness', {
      configurable: true,
      value: () => ({ status: 'ok', value: { ready: true, workspacePath: fixture.root, headSha: fixture.headSha } }),
    });
    Object.defineProperty(adapter, 'spawnWorker', {
      configurable: true,
      value: () => {
        if (input.spawnFails) return { status: 'failed', operation: 'spawn_worker', reason: 'fixture-spawn-failed' };
        throw new Error('fixture-must-not-spawn');
      },
    });
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const previousStore = process.env.PACK_REVIEW_RUN_STORE_ROOT;
    const previousReceipts = process.env.WORKER_SMOKE_RECEIPT_ROOT;
    const storeRoot = join(fixture.root, 'review-store');
    const receiptRoot = input.receiptWriteFails
      ? join(dirname(fixture.root), `${basename(fixture.root)}-receipt-blocker`)
      : join(fixture.root, 'receipts');
    process.env.PACK_REVIEW_RUN_STORE_ROOT = storeRoot;
    if (input.receiptWriteFails) {
      mkdirSync(receiptRoot);
      chmodSync(receiptRoot, 0o555);
    }
    process.env.WORKER_SMOKE_RECEIPT_ROOT = receiptRoot;
    try {
      const code = await runSmokeAttempt({
        command: 'run',
        issueNumber: 2068,
        prNumber: input.prNumber,
        headSha: fixture.headSha,
        issueBodyFile,
        smokeComplexity: 'routine',
        smokeActor: input.actor,
        repoRoot: fixture.root,
        cwd: fixture.root,
        dryRun: false,
        json: true,
        reviewId: '',
        reviewHeadSha: '',
      }, {
        adapter,
        resolveProfile: () => ({
          complexity: 'routine',
          family: 'cursor',
          agent: 'cursor-agent',
          command: 'cursor-agent',
          names: [
            'PACK_EXECUTOR_SMOKE_ROUTINE_AGENT',
            'PACK_EXECUTOR_SMOKE_ROUTINE_MODEL',
            'PACK_EXECUTOR_SMOKE_ROUTINE_EFFORT',
          ],
        }),
        resolveTarget: () => ({
          repositorySlug: REPOSITORY,
          issueNumber: 2068,
          prNumber: input.prNumber,
          headSha: fixture.headSha,
          issueBody: body,
          prBody: 'Closes #2068',
          issueBodyMatchesTarget: true,
          trustedPublisherLogin: TRUSTED_ACTOR,
          prOpen: true,
          baseRef: 'main',
          expectedTargetRef: 'main',
          expectedTarget: true,
        }),
        fetchHistoryComments: () => input.history ? [comment(1, {
          ...report('PASS', [scenario(action, expected)]),
          issueNumber: 2068,
          prNumber: input.prNumber,
          headSha: fixture.headSha,
        })] : [],
        isHistoryAncestor: (ancestorSha, descendantSha) => ancestorSha === descendantSha,
        publishComment: input.publishComment,
      });
      return { code, headSha: fixture.headSha, storeRoot, root: fixture.root };
    } catch (error) {
      return { error, headSha: fixture.headSha, storeRoot, root: fixture.root };
    } finally {
      output.mockRestore();
      if (previousStore === undefined) delete process.env.PACK_REVIEW_RUN_STORE_ROOT;
      else process.env.PACK_REVIEW_RUN_STORE_ROOT = previousStore;
      if (previousReceipts === undefined) delete process.env.WORKER_SMOKE_RECEIPT_ROOT;
      else process.env.WORKER_SMOKE_RECEIPT_ROOT = previousReceipts;
      if (input.receiptWriteFails) {
        chmodSync(receiptRoot, 0o755);
        rmSync(receiptRoot, { recursive: true, force: true });
      }
    }
  }

  function independentStatus(prNumber: number, storeRoot: string): string | undefined {
    return readPackReviewAuthority(prNumber, { storeRoot })?.smokeOrdering?.independent?.status;
  }

  it('stores independent passed only after the exact-head PASS comment is published', async () => {
    const bodies: string[] = [];
    const result = await runOrdering({
      prefix: 'ordering-pass-published-',
      prNumber: 206801,
      actor: 'independent',
      history: true,
      publishComment: (_prNumber, body) => { bodies.push(body); },
    });
    try {
      expect(result.error).toBeUndefined();
      expect(result.code).toBe(0);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toContain('result: PASS');
      expect(bodies[0]).toContain(result.headSha);
      expect(independentStatus(206801, result.storeRoot)).toBe('passed');
    } finally {
      rmSync(result.root, { recursive: true, force: true });
    }
  });

  it('keeps a published independent PASS when the later receipt write throws', async () => {
    const bodies: string[] = [];
    const result = await runOrdering({
      prefix: 'ordering-pass-receipt-throws-',
      prNumber: 206809,
      actor: 'independent',
      history: true,
      receiptWriteFails: true,
      publishComment: (_prNumber, body) => { bodies.push(body); },
    });
    try {
      expect(result.code === 0 && result.error === undefined).toBe(false);
      expect(bodies.some((body) => body.includes('result: PASS') && body.includes(result.headSha))).toBe(true);
      expect(independentStatus(206809, result.storeRoot)).toBe('passed');
    } finally {
      rmSync(result.root, { recursive: true, force: true });
    }
  });

  it('does not store independent passed when publication of the local PASS throws', async () => {
    const result = await runOrdering({
      prefix: 'ordering-pass-unpublished-',
      prNumber: 206802,
      actor: 'independent',
      history: true,
      publishComment: () => { throw new Error('scenario_precondition_unavailable: publication failed'); },
    });
    try {
      expect(result.error).toBeInstanceOf(Error);
      expect(independentStatus(206802, result.storeRoot)).not.toBe('passed');
    } finally {
      rmSync(result.root, { recursive: true, force: true });
    }
  });

  it('does not store a published BLOCKED independent report as passed', async () => {
    const bodies: string[] = [];
    let calls = 0;
    const result = await runOrdering({
      prefix: 'ordering-blocked-published-',
      prNumber: 206803,
      actor: 'independent',
      history: true,
      publishComment: (_prNumber, body) => {
        calls += 1;
        bodies.push(body);
        if (calls === 1) throw new Error('admission_refused: publication failed');
      },
    });
    try {
      expect(result.error).toBeUndefined();
      expect(bodies.some((body) => body.includes('result: BLOCKED'))).toBe(true);
      expect(independentStatus(206803, result.storeRoot)).toBe('failed');
    } finally {
      rmSync(result.root, { recursive: true, force: true });
    }
  });

  it('stores a published independent FAIL as failed', async () => {
    const bodies: string[] = [];
    const result = await runOrdering({
      prefix: 'ordering-fail-published-',
      prNumber: 206804,
      actor: 'independent',
      history: false,
      spawnFails: true,
      publishComment: (_prNumber, body) => { bodies.push(body); },
    });
    try {
      expect(result.error).toBeUndefined();
      expect(result.code).toBe(1);
      expect(bodies.some((body) => body.includes('result: FAIL'))).toBe(true);
      expect(bodies.some((body) => body.includes('result: PASS'))).toBe(false);
      expect(independentStatus(206804, result.storeRoot)).toBe('failed');
    } finally {
      rmSync(result.root, { recursive: true, force: true });
    }
  });

  it('does not store a carry-only worker PASS as an independent pass', async () => {
    const bodies: string[] = [];
    const result = await runOrdering({
      prefix: 'ordering-worker-carry-',
      prNumber: 206805,
      actor: 'worker-owned',
      history: true,
      publishComment: (_prNumber, body) => { bodies.push(body); },
    });
    try {
      expect(result.error).toBeUndefined();
      expect(result.code).toBe(0);
      expect(bodies.some((body) => body.includes('result: PASS'))).toBe(true);
      const ordering = readPackReviewAuthority(206805, { storeRoot: result.storeRoot })?.smokeOrdering;
      expect(ordering?.independent?.status).not.toBe('passed');
      expect(ordering?.workerOwned?.status).not.toBe('passed');
    } finally {
      rmSync(result.root, { recursive: true, force: true });
    }
  });

  async function deadPid(): Promise<number> {
    let pid = 0;
    const result = await runProcess({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      allowEmptyStdout: true,
      onSpawn: (spawned) => {
        pid = spawned;
      },
    });
    if (!result.ok || pid <= 0) {
      throw new Error(`dead pid fixture failed: ${result.error ?? result.outcome}`);
    }
    return pid;
  }

  it('keeps a dead independent owner without a canonical result unpassed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ordering-dead-owner-'));
    const storeRoot = join(root, 'review-store');
    const previousStore = process.env.PACK_REVIEW_RUN_STORE_ROOT;
    process.env.PACK_REVIEW_RUN_STORE_ROOT = storeRoot;
    const body = tieredBody();
    writeFileSync(join(root, 'issue.md'), body, 'utf8');
    const headSha = 'a'.repeat(40);
    const options = {
      command: 'run',
      issueNumber: 2068,
      prNumber: 206806,
      headSha,
      issueBodyFile: join(root, 'issue.md'),
      smokeComplexity: 'routine' as const,
      smokeActor: 'independent' as const,
      repoRoot: root,
      cwd: root,
      dryRun: true,
      json: true,
      reviewId: '',
      reviewHeadSha: '',
    };
    try {
      const pid = await deadPid();
      beginSmokeOrdering(options, body, { attemptId: 'dead-owner-run', supervisorPid: pid, runId: 'dead-owner-run' });
      expect(() => beginSmokeOrdering(options, body, {
        attemptId: 'dead-owner-next',
        supervisorPid: process.pid,
        runId: 'dead-owner-next',
      })).toThrow(/smoke_ordering_independent_in_progress/);
      expect(readPackReviewAuthority(206806, { storeRoot })?.smokeOrdering?.independent?.status).not.toBe('passed');
    } finally {
      if (previousStore === undefined) delete process.env.PACK_REVIEW_RUN_STORE_ROOT;
      else process.env.PACK_REVIEW_RUN_STORE_ROOT = previousStore;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a live independent owner without a terminal result started', () => {
    const root = mkdtempSync(join(tmpdir(), 'ordering-live-owner-'));
    const storeRoot = join(root, 'review-store');
    const previousStore = process.env.PACK_REVIEW_RUN_STORE_ROOT;
    process.env.PACK_REVIEW_RUN_STORE_ROOT = storeRoot;
    const body = tieredBody();
    writeFileSync(join(root, 'issue.md'), body, 'utf8');
    const headSha = 'b'.repeat(40);
    const options = {
      command: 'run' as const,
      issueNumber: 2068,
      prNumber: 206808,
      headSha,
      issueBodyFile: join(root, 'issue.md'),
      smokeComplexity: 'routine' as const,
      smokeActor: 'independent' as const,
      repoRoot: root,
      cwd: root,
      dryRun: true,
      json: true,
      reviewId: '',
      reviewHeadSha: '',
    };
    try {
      beginSmokeOrdering(options, body, { attemptId: 'live-owner', supervisorPid: process.pid });
      expect(() => beginSmokeOrdering(options, body, {
        attemptId: 'live-owner-next',
        supervisorPid: process.pid,
      })).toThrow(/smoke_ordering_independent_in_progress/);
      expect(readPackReviewAuthority(206808, { storeRoot })?.smokeOrdering?.independent?.status).toBe('started');
    } finally {
      if (previousStore === undefined) delete process.env.PACK_REVIEW_RUN_STORE_ROOT;
      else process.env.PACK_REVIEW_RUN_STORE_ROOT = previousStore;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops a previous-head independent pass when the head changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'ordering-previous-head-'));
    const storeRoot = join(root, 'review-store');
    const previousStore = process.env.PACK_REVIEW_RUN_STORE_ROOT;
    process.env.PACK_REVIEW_RUN_STORE_ROOT = storeRoot;
    const body = tieredBody();
    writeFileSync(join(root, 'issue.md'), body, 'utf8');
    const options = {
      command: 'run' as const,
      issueNumber: 2068,
      prNumber: 206807,
      headSha: HEAD_ONE,
      issueBodyFile: join(root, 'issue.md'),
      smokeComplexity: 'routine' as const,
      smokeActor: 'independent' as const,
      repoRoot: root,
      cwd: root,
      dryRun: true,
      json: true,
      reviewId: '',
      reviewHeadSha: '',
    };
    const authorityOptions = { storeRoot };
    try {
      beginSmokeOrdering(options, body, { attemptId: 'previous-head-attempt', supervisorPid: process.pid });
      const started = readPackReviewAuthority(206807, authorityOptions);
      const passed = commitSmokeOrderingTransition({
        prNumber: 206807,
        expectedTransitionSeq: started?.transitionSeq ?? 0,
        actor: 'independent',
        headSha: HEAD_ONE,
        status: 'passed',
        attemptId: 'previous-head-attempt',
        supervisorPid: process.pid,
        options: authorityOptions,
      });
      const nextHead = observePackReviewHead({
        prNumber: 206807,
        expectedTransitionSeq: passed.transitionSeq,
        headSha: HEAD_TWO,
        options: authorityOptions,
      });
      expect(nextHead.smokeOrdering?.independent).toBeUndefined();
    } finally {
      if (previousStore === undefined) delete process.env.PACK_REVIEW_RUN_STORE_ROOT;
      else process.env.PACK_REVIEW_RUN_STORE_ROOT = previousStore;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
