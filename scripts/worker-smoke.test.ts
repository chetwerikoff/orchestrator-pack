import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  closeOrcaTerminal,
  createOrcaTerminal,
  probeOrcaWorktree,
  findExecutableOnPath,
  resolveOrcaExecutable,
  runOrcaJson,
} from './lib/orca-cli.ts';
import {
  buildSmokeAgentPrompt,
  buildSmokeGhChildEnv,
  classifyDeclaredScenarioNonPassCause,
  classifySmokeChannelBinding,
  classifySmokeChildWaitObservation,
  createSmokeRunIdentity,
  ensureSmokeRunArtifactDir,
  createSmokeCompletionObservationState,
  observeSmokeCompletionEvidence,
  observeSmokeDeliveryEstablished,
  observeSmokeUnsubmittedComposerPaste,
  resolveSmokeRunArtifactDir,
  smokeCompletionBodyPath,
  smokeCompletionSealPath,
  computeSmokeCompletionBodyDigest,
  smokeCompletionPendingBodyPath,
  isDefinitePromptNonDelivery,
  smokeDeliverySealedPath,
  classifySmokeNonPassCause,
  SMOKE_HARNESS_TERMINAL_CLOSE_ACTION,
  detectTrackedImplementationMutation,
  hasPreexistingTrackedDirtiness,
  trackedPorcelainPaths,
  evaluateReadyForReviewCombinations,
  evaluateWorkerSmokeGate,
  extractSmokeReportsFromComments,
  findCurrentHeadSmokePass,
  SMOKE_GH_AUTH_ENV_KEYS,
  SMOKE_REPORT_PRODUCER,
  smokeAgentTerminalActivityBeyondSentPrompt,
  smokeAgentTerminalDeltaActivity,
  smokeAgentTerminalFullActivity,
  scrubForwardedGhSecrets,
  smokeReportCoversPlan,
  smokeReportHasPackProducer,
  scrubSmokeOutput,
  resolveSmokeGhConfigDirs,
  orcaTerminalReadLines,
  orcaTerminalReadNextCursor,
  verifySmokeHeadBinding,
  formatSmokeReportComment,
  normalizeSmokeReport,
  parseSmokeAgentReport,
  SMOKE_REPORT_MARKER,
} from './lib/worker-smoke-core.ts';
import { runProcessSync } from './kernel/subprocess.ts';
import {
  establishSmokePromptDelivery,
  runSmokeGhSync,
  waitForSmokeChildCompletion,
  waitForSmokeAgentCompletion,
} from './worker-smoke-run.ts';
import { readWorkerSmokeReceipt, verifySmokeRunReceipt, writeWorkerSmokeReceipt } from './lib/worker-smoke-receipt.ts';
import { checkSmokeTestPlan, resolveSmokeRequirement } from './draft-discipline.mjs';

const fixtureRoot = join(import.meta.dirname, '..', 'tests', 'fixtures', 'worker-smoke');
const headA = 'a'.repeat(40);
const headB = 'b'.repeat(40);

const gateBase = {
  issueNumber: 1061,
  terminalProvenanceOk: true,
} as const;

function passReportFields() {
  return {
    producer: SMOKE_REPORT_PRODUCER,
    orcaExecutable: 'orca-ide',
    terminalHandle: 'term_owned_smoke',
  } as const;
}

const planPassScenarios = [
  {
    action: 'run `worker-smoke-run validate-plan --issue-body-file issue.md`',
    expected: 'exits 0',
    observed: 'exits 0',
    outcome: 'pass' as const,
  },
  {
    action: 'invoke the new helper against fixture input',
    expected: 'prints structured PASS payload',
    observed: 'structured PASS payload',
    outcome: 'pass' as const,
  },
];

function readFixture(name: string): string {
  return readFileSync(join(fixtureRoot, name), 'utf8');
}

describe('worker smoke plan authoring floor', () => {
  it('requires a smoke plan for action-producing tasks', () => {
    const markdown = readFixture('action-producing-missing-plan.md');
    const result = checkSmokeTestPlan(markdown);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('smoke-test-plan');
  });

  it('accepts explicit reasoned not-applicable plans', () => {
    const markdown = readFixture('record-only-na-plan.md');
    const result = checkSmokeTestPlan(markdown);
    expect(result.ok).toBe(true);
    expect(result.plan?.requirement).toBe('not-applicable');
  });

  it('treats legacy issues without the fence as exempt at worker gate time', () => {
    const markdown = readFixture('legacy-pre-floor-issue.md');
    expect(resolveSmokeRequirement(markdown).requirement).toBe('legacy-exempt');
    const decision = evaluateWorkerSmokeGate({
      ...gateBase,
      issueBody: markdown,
      prNumber: 42,
      headSha: headA,
      prComments: [],
      ciGreen: true,
      orcaWorktreeOk: true,
      ownedTerminalClosed: true,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.smokeRequired).toBe(false);
  });
});

describe('orca current-worktree launch seam', () => {
  it('selects the supported Orca executable and creates a cursor-agent terminal without a new worktree', () => {
    const runner = vi.fn(() => ({
      stdout: JSON.stringify({
        ok: true,
        result: {
          terminal: { handle: 'term_owned', worktreeId: 'wt-current' },
        },
      }),
      stderr: '',
      status: 0,
    }));
    const created = createOrcaTerminal({
      cwd: '/tmp/worktree',
      title: 'smoke-1',
      command: 'cursor-agent',
      executable: 'orca-ide',
      runner: runner as never,
    });
    expect(created.ok).toBe(true);
    expect(resolveOrcaExecutable({ ORCA_CLI_COMMAND: 'orca-ide' })).toBe('orca-ide');
    const fakeBin = join(import.meta.dirname, '..', 'tests', 'fixtures', 'worker-smoke', 'fake-bin');
    expect(findExecutableOnPath('orca-dev', fakeBin)).toBe('orca-dev');
    expect(resolveOrcaExecutable({ PATH: fakeBin, ORCA_CLI_COMMAND: '' })).toBe('orca-dev');
    expect(runner).toHaveBeenCalledWith(
      'orca-ide',
      ['terminal', 'create', '--worktree', 'active', '--title', 'smoke-1', '--command', 'cursor-agent', '--json'],
      expect.objectContaining({ cwd: '/tmp/worktree' }),
    );
  });

  it('fails closed when cwd is not the Orca-managed current worktree', () => {
    const runner = vi.fn(() => ({
      stdout: JSON.stringify({
        ok: true,
        result: { worktree: { path: '/other/worktree', head: headA } },
      }),
      stderr: '',
      status: 0,
    }));
    const probe = probeOrcaWorktree('/tmp/worktree', { runner: runner as never });
    expect(probe.ok).toBe(false);
    expect(probe.reason).toBe('cwd_not_orca_managed_worktree');
  });
});

describe('smoke report publication and parsing', () => {
  it('normalizes PASS, FAIL, and BLOCKED reports with exact head binding', () => {
    const passBody = readFixture('agent-pass-report.txt');
    const partial = {
      ...parseSmokeAgentReport(passBody),
      ...passReportFields(),
    };
    const normalized = normalizeSmokeReport(partial ?? {}, {
      issueNumber: 1061,
      prNumber: 99,
      headSha: headA,
    });
    expect(normalized.ok).toBe(true);
    const comment = formatSmokeReportComment(normalized.report);
    expect(comment).toContain(SMOKE_REPORT_MARKER);
    expect(comment).toContain(headA);
    expect(comment).toContain('result: **PASS**');
    expect(comment).toContain('tracked-implementation-files-unmodified: yes');
  });

  it('parses unfenced agent smoke reports after prompt template lines', () => {
    const body = [
      '```worker-smoke-report',
      'result: PASS|FAIL|BLOCKED',
      '```',
      '',
      'result: PASS',
      'tracked-files-unmodified: true',
      'scenarios:',
      '  - action: run check | expected: ok | observed: ok | outcome: pass',
    ].join('\n');
    const partial = parseSmokeAgentReport(body);
    expect(partial?.result).toBe('PASS');
    expect(partial?.trackedFilesUnmodified).toBe(true);
    expect(partial?.scenarios).toHaveLength(1);
  });

  it('parses unfenced reports with Orca-indented lines', () => {
    const body = [
      '  result: PASS',
      '  tracked-files-unmodified: true',
      '  scenarios:',
      '    - action: run check | expected: ok | observed: ok | outcome: pass',
    ].join('\n');
    expect(parseSmokeAgentReport(body)?.result).toBe('PASS');
  });

  it('rejects malformed PASS output that omits required fields', () => {
    const partial = parseSmokeAgentReport('```worker-smoke-report\nresult: PASS\n```');
    expect(normalizeSmokeReport(partial ?? {}, {
      issueNumber: 1,
      prNumber: 2,
      headSha: headA,
    }).ok).toBe(false);
  });
});

describe('ready_for_review smoke and CI orthogonality', () => {
  const issueBody = readFixture('action-producing-with-plan.md');
  const passComment = formatSmokeReportComment({
    result: 'PASS',
    issueNumber: 1061,
    prNumber: 7,
    headSha: headA,
    scenarios: planPassScenarios,
    limitations: [],
    trackedFilesUnmodified: true,
    terminalCleanup: 'closed_owned_handle',
    environmentNotes: [],
    ...passReportFields(),
  });

  it('allows only current-head smoke PASS plus green CI', () => {
    vi.stubEnv('WORKER_SMOKE_RECEIPT_ROOT', mkdtempSync(join(tmpdir(), 'worker-smoke-receipt-')));
    const passReport = {
      result: 'PASS' as const,
      issueNumber: 1061,
      prNumber: 7,
      headSha: headA,
      scenarios: planPassScenarios,
      limitations: [],
      trackedFilesUnmodified: true,
      terminalCleanup: 'closed_owned_handle',
      environmentNotes: [],
      ...passReportFields(),
    };
    writeWorkerSmokeReceipt(passReport);
    const allowed = evaluateWorkerSmokeGate({
      ...gateBase,
      issueBody,
      prNumber: 7,
      headSha: headA,
      prComments: [{ body: passComment }],
      ciGreen: true,
      orcaWorktreeOk: true,
      ownedTerminalClosed: true,
    });
    expect(allowed).toEqual({ allowed: true, reason: 'smoke_pass_and_ci_green', smokeRequired: true });

    expect(evaluateWorkerSmokeGate({
      ...gateBase,
      issueBody,
      prNumber: 7,
      headSha: headA,
      prComments: [{ body: passComment }],
      ciGreen: false,
      orcaWorktreeOk: true,
      ownedTerminalClosed: true,
    }).allowed).toBe(false);


    expect(findCurrentHeadSmokePass([{ body: passComment }], 7, headB)).toBeNull();
    vi.unstubAllEnvs();
  });

  it('exercises the four smoke/CI combinations', () => {
    expect(evaluateReadyForReviewCombinations({ smokePass: true, ciGreen: true })).toBe(true);
    expect(evaluateReadyForReviewCombinations({ smokePass: true, ciGreen: false })).toBe(false);
    expect(evaluateReadyForReviewCombinations({ smokePass: false, ciGreen: true })).toBe(false);
    expect(evaluateReadyForReviewCombinations({ smokePass: false, ciGreen: false })).toBe(false);
  });
});

describe('orca cleanup and role boundaries', () => {
  it('closes only the owned terminal handle and leaves foreign terminals alone', () => {
    const runner = vi.fn(() => ({ stdout: JSON.stringify({ ok: true }), stderr: '', status: 0 }));
    const result = closeOrcaTerminal('term_owned', { runner: runner as never });
    expect(result.ok).toBe(true);
    expect(runner).toHaveBeenCalledWith(
      expect.any(String),
      ['terminal', 'close', '--terminal', 'term_owned', '--json'],
      expect.any(Object),
    );
  });

  it('detects tracked implementation mutations and forbids implementation/review actions in the smoke prompt', () => {
    expect(detectTrackedImplementationMutation([' M scripts/a.ts'], [' M scripts/a.ts', ' M scripts/b.ts'])).toBe(true);
    expect(detectTrackedImplementationMutation(
      [' M scripts/a.ts'],
      [' M scripts/a.ts'],
      { 'scripts/a.ts': 'aaa' },
      { 'scripts/a.ts': 'bbb' },
    )).toBe(true);
    expect(hasPreexistingTrackedDirtiness([' M scripts/a.ts'])).toBe(true);
    expect(hasPreexistingTrackedDirtiness(['?? scripts/new.ts'])).toBe(false);
    const prompt = buildSmokeAgentPrompt({
      issueNumber: 1,
      issueBody: 'body',
      prNumber: 2,
      headSha: headA,
      plan: {
        requirement: 'required',
        scenarios: [{ action: 'run npm test', expected: 'green' }],
      },
    });
    expect(prompt).toContain('Do not edit tracked implementation files');
    expect(prompt).not.toMatch(/^commit$/m);
  });

  it('extracts published reports from PR comments without a separate ledger', () => {
    const comment = formatSmokeReportComment({
      result: 'FAIL',
      issueNumber: 3,
      prNumber: 4,
      headSha: headA,
      scenarios: [{ action: 'x', expected: 'y', observed: 'z', outcome: 'fail' }],
      limitations: [],
      trackedFilesUnmodified: true,
      terminalCleanup: 'closed_owned_handle',
      environmentNotes: [],
    });
    const reports = extractSmokeReportsFromComments([{ body: comment }]);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.result).toBe('FAIL');
  });
});

describe('pre-cutover blocked behavior', () => {
  it('reports BLOCKED when Orca worktree resolution fails instead of testing elsewhere', () => {
    const decision = evaluateWorkerSmokeGate({
      ...gateBase,
      issueBody: readFixture('action-producing-with-plan.md'),
      prNumber: 8,
      headSha: headA,
      prComments: [],
      ciGreen: true,
      orcaWorktreeOk: false,
      ownedTerminalClosed: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('orca_worktree_unresolved');
  });
});

describe('orca json runner', () => {
  it('parses JSON responses and surfaces empty stdout as failure', () => {
    const ok = runOrcaJson(['worktree', 'current'], {
      runner: () => ({ stdout: '{"ok":true,"result":{}}', stderr: '', status: 0 }) as never,
    });
    expect(ok.ok).toBe(true);
    const bad = runOrcaJson(['worktree', 'current'], {
      runner: () => ({ stdout: '', stderr: 'boom', status: 1 }) as never,
    });
    expect(bad.ok).toBe(false);
  });
});

describe('review finding regressions', () => {
  const issueBody = readFixture('action-producing-with-plan.md');

  it('revokes an earlier same-head PASS when a later FAIL is published', () => {
    const passComment = formatSmokeReportComment({
      result: 'PASS',
      issueNumber: 1061,
      prNumber: 7,
      headSha: headA,
      scenarios: planPassScenarios,
      limitations: [],
      trackedFilesUnmodified: true,
      terminalCleanup: 'closed_owned_handle',
      environmentNotes: [],
    });
    const failComment = formatSmokeReportComment({
      result: 'FAIL',
      issueNumber: 1061,
      prNumber: 7,
      headSha: headA,
      scenarios: [{
        action: 'run helper',
        expected: 'prints ok',
        observed: 'error',
        outcome: 'fail',
      }],
      limitations: [],
      trackedFilesUnmodified: true,
      terminalCleanup: 'closed_owned_handle',
      environmentNotes: [],
    });
    const comments = [{ body: passComment }, { body: failComment }];
    expect(findCurrentHeadSmokePass(comments, 7, headA)).toBeNull();
    expect(evaluateWorkerSmokeGate({
      ...gateBase,
      issueBody,
      prNumber: 7,
      headSha: headA,
      prComments: comments,
      ciGreen: true,
      orcaWorktreeOk: true,
      ownedTerminalClosed: true,
    }).allowed).toBe(false);
  });

  it('parses multiline smoke scenario blocks and rejects incomplete PASS evidence', () => {
    const multiline = [
      '```worker-smoke-report',
      'result: PASS',
      'tracked-files-unmodified: true',
      'terminal-cleanup: closed_owned_handle',
      'scenarios:',
      '  - action: run gate-check',
      '    expected: exits 0',
      '    observed: exits 0',
      '    outcome: pass',
      '```',
    ].join('\n');
    const partial = parseSmokeAgentReport(multiline);
    expect(partial?.scenarios?.[0]?.observed).toBe('exits 0');
    expect(normalizeSmokeReport(partial ?? {}, {
      issueNumber: 1061,
      prNumber: 7,
      headSha: headA,
    }).ok).toBe(false);
  });

  it('fails closed when issue body is unavailable instead of legacy-exempt', () => {
    expect(resolveSmokeRequirement('').requirement).toBe('unknown');
    expect(evaluateWorkerSmokeGate({
      ...gateBase,
      issueBody: '',
      prNumber: 7,
      headSha: headA,
      prComments: [],
      ciGreen: true,
      orcaWorktreeOk: true,
      ownedTerminalClosed: true,
    }).reason).toBe('issue_body_unavailable');
  });

  it('rejects PASS reports that omit required plan scenarios or include failing outcomes', () => {
    const plan = resolveSmokeRequirement(issueBody);
    const incompletePass = formatSmokeReportComment({
      result: 'PASS',
      issueNumber: 1061,
      prNumber: 7,
      headSha: headA,
      scenarios: [planPassScenarios[0]],
      limitations: [],
      trackedFilesUnmodified: true,
      terminalCleanup: 'closed_owned_handle',
      environmentNotes: [],
      ...passReportFields(),
    });
    const incompleteReport = {
      result: 'PASS' as const,
      issueNumber: 1061,
      prNumber: 7,
      headSha: headA,
      scenarios: [planPassScenarios[0]],
      limitations: [],
      trackedFilesUnmodified: true,
      terminalCleanup: 'closed_owned_handle',
      environmentNotes: [],
      ...passReportFields(),
    };
    expect(smokeReportCoversPlan(incompleteReport, plan)).toBe(false);
    expect(evaluateWorkerSmokeGate({
      ...gateBase,
      issueBody,
      prNumber: 7,
      headSha: headA,
      prComments: [{ body: incompletePass }],
      ciGreen: true,
      orcaWorktreeOk: true,
      ownedTerminalClosed: true,
    }).reason).toBe('smoke_plan_not_fully_covered');

    const changedExpected = formatSmokeReportComment({
      result: 'PASS',
      issueNumber: 1061,
      prNumber: 7,
      headSha: headA,
      scenarios: planPassScenarios.map((scenario, index) => (
        index === 0 ? { ...scenario, expected: 'wrong expected' } : scenario
      )),
      limitations: [],
      trackedFilesUnmodified: true,
      terminalCleanup: 'closed_owned_handle',
      environmentNotes: [],
      ...passReportFields(),
    });
    const changedReport = {
      result: 'PASS' as const,
      issueNumber: 1061,
      prNumber: 7,
      headSha: headA,
      scenarios: planPassScenarios.map((scenario, index) => (
        index === 0 ? { ...scenario, expected: 'wrong expected' } : scenario
      )),
      limitations: [],
      trackedFilesUnmodified: true,
      terminalCleanup: 'closed_owned_handle',
      environmentNotes: [],
      ...passReportFields(),
    };
    expect(smokeReportCoversPlan(changedReport, plan)).toBe(false);

    const failingOutcome = formatSmokeReportComment({
      result: 'PASS',
      issueNumber: 1061,
      prNumber: 7,
      headSha: headA,
      scenarios: planPassScenarios.map((scenario, index) => (
        index === 0 ? { ...scenario, outcome: 'fail' as const } : scenario
      )),
      limitations: [],
      trackedFilesUnmodified: true,
      terminalCleanup: 'closed_owned_handle',
      environmentNotes: [],
    });
    expect(normalizeSmokeReport(parseSmokeAgentReport(failingOutcome) ?? {}, {
      issueNumber: 1061,
      prNumber: 7,
      headSha: headA,
    }).reason).toBe('pass_scenario_1_not_pass');
  });

  it('binds smoke reports to issue number and verifies Orca/git head alignment', () => {
    const passComment = formatSmokeReportComment({
      result: 'PASS',
      issueNumber: 999,
      prNumber: 7,
      headSha: headA,
      scenarios: planPassScenarios,
      limitations: [],
      trackedFilesUnmodified: true,
      terminalCleanup: 'closed_owned_handle',
      environmentNotes: [],
    });
    expect(findCurrentHeadSmokePass([{ body: passComment }], 7, headA, 1061)).toBeNull();

    expect(verifySmokeHeadBinding({
      requestedHeadSha: headA,
      orcaHeadSha: headB,
      gitHeadSha: headA,
    })).toEqual({
      ok: false,
      reason: 'orca_head_mismatch',
      observed: headB,
    });
    expect(verifySmokeHeadBinding({
      requestedHeadSha: headA,
      orcaHeadSha: headA,
      gitHeadSha: headA,
    })).toEqual({ ok: true });
  });

  it('rejects unreasoned not-applicable smoke plans at runtime', () => {
    const markdown = [
      '```behavior-kind',
      'record-only',
      '```',
      '```smoke-test-plan',
      'not-applicable: true',
      '```',
    ].join('\n');
    expect(resolveSmokeRequirement(markdown).reason).toBe('missing_not_applicable_reason');
  });

  it('rejects forgeable PASS without pack-owned receipt', () => {
    const receiptRoot = mkdtempSync(join(tmpdir(), 'worker-smoke-receipt-'));
    vi.stubEnv('WORKER_SMOKE_RECEIPT_ROOT', receiptRoot);
    const forged = {
      result: 'PASS' as const,
      issueNumber: 1061,
      prNumber: 9099,
      headSha: headB,
      scenarios: planPassScenarios,
      limitations: [],
      trackedFilesUnmodified: true,
      terminalCleanup: 'closed_owned_handle',
      environmentNotes: [],
      ...passReportFields(),
    };
    expect(verifySmokeRunReceipt(forged)).toBe(false);
    writeWorkerSmokeReceipt(forged);
    expect(verifySmokeRunReceipt(forged)).toBe(true);
    expect(readWorkerSmokeReceipt(9099, headB)?.terminalHandle).toBe('term_owned_smoke');
    vi.unstubAllEnvs();
  });

  it('rejects heading-only forged smoke comments without machine block', () => {
    const forged = [
      '<!-- pack-worker-smoke-report/v1 -->',
      '## Worker smoke report',
      'result: PASS',
      'issue: #1061',
      'pr: #7',
      `head-sha: ${headA}`,
    ].join('\n');
    expect(extractSmokeReportsFromComments([{ body: forged }])).toHaveLength(0);
    expect(smokeReportHasPackProducer({
      result: 'PASS',
      issueNumber: 1061,
      prNumber: 7,
      headSha: headA,
      scenarios: planPassScenarios,
      limitations: [],
      trackedFilesUnmodified: true,
      terminalCleanup: 'closed_owned_handle',
      environmentNotes: [],
      ...passReportFields(),
    })).toBe(true);
  });

  it('requires explicit grandfather marker for legacy-exempt omission', () => {
    const withoutFence = '# Task\n\n```behavior-kind\naction-producing\n```\n';
    expect(resolveSmokeRequirement(withoutFence).requirement).toBe('required');
  });
});

describe('worker smoke gh child env forwarding (#1101)', () => {
  const authSentinel = 'opaque-sentinel-not-matching-gh-prefix-abc123';
  const unrelatedSentinel = 'fixture-unrelated-parent-sentinel-xyz';

  it('forwards supported gh auth/config carriers without unrelated parent env', () => {
    const parent = {
      PATH: '/bin',
      GH_TOKEN: authSentinel,
      GH_CONFIG_DIR: '/tmp/gh-config',
      UNRELATED_SENTINEL: unrelatedSentinel,
    } as NodeJS.ProcessEnv;
    const child = buildSmokeGhChildEnv(parent);
    expect(child.GH_TOKEN).toBe(authSentinel);
    expect(child.GH_CONFIG_DIR).toBe('/tmp/gh-config');
    expect(child.UNRELATED_SENTINEL).toBeUndefined();
    for (const key of SMOKE_GH_AUTH_ENV_KEYS) {
      if (parent[key] !== undefined) {
        expect(child[key]).toBe(parent[key]);
      }
    }
  });

  it('restores authenticated gh child behavior on the smoke-owned seam without leaking sentinels', () => {
    const fakeBin = join(fixtureRoot, 'fake-bin');
    const probePath = `${fakeBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`;
    const isolatedHome = mkdtempSync(join(tmpdir(), 'smoke-gh-noauth-'));
    const withoutAuth = runSmokeGhSync(
      ['api', 'repos/{owner}/{repo}/issues/1/comments', '--paginate'],
      fixtureRoot,
      { PATH: probePath, HOME: isolatedHome, XDG_CONFIG_HOME: isolatedHome },
    );
    expect(withoutAuth.ok).toBe(false);
    expect(withoutAuth.stderr).toContain('config-credential-missing');

    const withAuth = runSmokeGhSync(
      ['api', 'repos/{owner}/{repo}/issues/1/comments', '--paginate'],
      fixtureRoot,
      {
        PATH: probePath,
        ...buildSmokeGhChildEnv({
          GH_TOKEN: authSentinel,
          UNRELATED_SENTINEL: unrelatedSentinel,
        } as NodeJS.ProcessEnv),
      },
    );
    expect(withAuth.ok).toBe(true);
    expect(withAuth.stdout).toContain('[]');
    expect(withAuth.stdout).not.toContain(authSentinel);
    expect(withAuth.stderr).not.toContain(authSentinel);
  });


  it('does not forward GH_REPO as an auth/config carrier', () => {
    const child = buildSmokeGhChildEnv({ GH_REPO: 'other/repo' } as NodeJS.ProcessEnv);
    expect(child.GH_REPO).toBeUndefined();
  });

  it('restores authenticated gh child behavior via GH_CONFIG_DIR without token carriers', () => {
    const fakeBin = join(fixtureRoot, 'fake-bin');
    const probePath = `${fakeBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`;
    const configHomeDir = mkdtempSync(join(tmpdir(), 'smoke-gh-config-only-'));
    const configCredential = 'gho_confighomecredential1101abcdef';
    writeFileSync(join(configHomeDir, 'hosts.yml'), 'github.com:\n    oauth_token: ' + configCredential + '\n', 'utf8');
    const stripTokenCarriers = {
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      GH_ENTERPRISE_TOKEN: '',
      GITHUB_ENTERPRISE_TOKEN: '',
      GHE_TOKEN: '',
    } as NodeJS.ProcessEnv;

    try {
      const dirOnlyNoCredential = mkdtempSync(join(tmpdir(), 'smoke-gh-config-empty-'));
      const withoutCredential = runSmokeGhSync(
        ['api', 'repos/{owner}/{repo}/issues/1/comments', '--paginate'],
        fixtureRoot,
        {
          PATH: probePath,
          ...stripTokenCarriers,
          ...buildSmokeGhChildEnv({ GH_CONFIG_DIR: dirOnlyNoCredential } as NodeJS.ProcessEnv),
        },
      );
      expect(withoutCredential.ok).toBe(false);
      expect(withoutCredential.stderr).toContain('config-credential-missing');

      const isolatedHome = mkdtempSync(join(tmpdir(), 'smoke-gh-noconfig-'));
      const withoutConfigHome = runSmokeGhSync(
        ['api', 'repos/{owner}/{repo}/issues/1/comments', '--paginate'],
        fixtureRoot,
        {
          PATH: probePath,
          ...stripTokenCarriers,
          GH_CONFIG_DIR: '',
          HOME: isolatedHome,
          XDG_CONFIG_HOME: isolatedHome,
        },
      );
      expect(withoutConfigHome.ok).toBe(false);
      expect(withoutConfigHome.stderr).toContain('config-credential-missing');

      const withConfigHome = runSmokeGhSync(
        ['api', 'repos/{owner}/{repo}/issues/1/comments', '--paginate'],
        fixtureRoot,
        {
          PATH: probePath,
          ...stripTokenCarriers,
          ...buildSmokeGhChildEnv({ GH_CONFIG_DIR: configHomeDir } as NodeJS.ProcessEnv),
        },
      );
      expect(withConfigHome.ok).toBe(true);
      expect(withConfigHome.stdout).toContain('[]');
      expect(withConfigHome.stderr).not.toContain(configCredential);
    } finally {
      rmSync(configHomeDir, { recursive: true, force: true });
    }
  });

  it('scrubs config-home credentials resolved via XDG_CONFIG_HOME without GH_CONFIG_DIR', () => {
    const fakeBin = join(fixtureRoot, 'fake-bin');
    const probePath = `${fakeBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`;
    const xdgRoot = mkdtempSync(join(tmpdir(), 'smoke-xdg-config-'));
    const configHomeDir = join(xdgRoot, 'gh');
    mkdirSync(configHomeDir, { recursive: true });
    const configCredential = 'gho_xdgconfigscrub1101abcdef';
    writeFileSync(join(configHomeDir, 'hosts.yml'), 'github.com:\n    oauth_token: ' + configCredential + '\n', 'utf8');
    const childEnv = buildSmokeGhChildEnv({ XDG_CONFIG_HOME: xdgRoot } as NodeJS.ProcessEnv);
    try {
      expect(resolveSmokeGhConfigDirs(childEnv)).toContain(configHomeDir);
      const failed = runSmokeGhSync(
        ['fail-with-config-sentinel'],
        fixtureRoot,
        { PATH: probePath, ...childEnv },
      );
      const scrubbed = scrubSmokeOutput(scrubForwardedGhSecrets(`${failed.stderr}${failed.stdout}`, childEnv));
      expect(scrubbed).not.toContain(configCredential);
      expect(scrubbed).toContain('[redacted-secret]');
    } finally {
      rmSync(xdgRoot, { recursive: true, force: true });
    }
  });

  it('scrubs config-home credential values from stderr-derived failure surfaces', () => {
    const fakeBin = join(fixtureRoot, 'fake-bin');
    const probePath = `${fakeBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`;
    const configHomeDir = mkdtempSync(join(tmpdir(), 'smoke-gh-config-scrub-'));
    const configCredential = 'gho_confighomescrub1101abcdef';
    writeFileSync(join(configHomeDir, 'hosts.yml'), 'github.com:\n    oauth_token: ' + configCredential + '\n', 'utf8');
    const childEnv = buildSmokeGhChildEnv({ GH_CONFIG_DIR: configHomeDir } as NodeJS.ProcessEnv);
    try {
      const failed = runSmokeGhSync(
        ['fail-with-config-sentinel'],
        fixtureRoot,
        { PATH: probePath, ...childEnv },
      );
      const scrubbed = scrubSmokeOutput(scrubForwardedGhSecrets(`${failed.stderr}${failed.stdout}`, childEnv));
      expect(scrubbed).not.toContain(configCredential);
      expect(scrubbed).toContain('[redacted-secret]');
    } finally {
      rmSync(configHomeDir, { recursive: true, force: true });
    }
  });

  it('scrubs arbitrary forwarded token values from stderr-derived failure surfaces', () => {
    const fakeBin = join(fixtureRoot, 'fake-bin');
    const probePath = `${fakeBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`;
    const childEnv = buildSmokeGhChildEnv({ GH_TOKEN: authSentinel } as NodeJS.ProcessEnv);
    const failed = runSmokeGhSync(
      ['fail-with-sentinel'],
      fixtureRoot,
      { PATH: probePath, ...childEnv },
    );
    const scrubbed = scrubSmokeOutput(scrubForwardedGhSecrets(`${failed.stderr}${failed.stdout}`, childEnv));
    expect(scrubbed).not.toContain(authSentinel);
    expect(scrubbed).toContain('[redacted-secret]');
  });
});

describe('worker smoke agent start-aware wait (#1101)', () => {
  it('detects positive terminal activity beyond echoed prompt only', () => {
    const sentPrompt = 'run smoke now';
    expect(smokeAgentTerminalFullActivity('idle', 'idle', sentPrompt)).toBe(false);
    expect(smokeAgentTerminalFullActivity(`idle${sentPrompt}`, 'idle', sentPrompt)).toBe(false);
    expect(smokeAgentTerminalFullActivity(`idle${sentPrompt}\nagent output`, 'idle', sentPrompt)).toBe(true);
    expect(smokeAgentTerminalDeltaActivity('', sentPrompt)).toBe(false);
    expect(smokeAgentTerminalDeltaActivity(sentPrompt, sentPrompt)).toBe(false);
    expect(smokeAgentTerminalDeltaActivity(`${sentPrompt}\nagent output`, sentPrompt)).toBe(true);
    expect(smokeAgentTerminalActivityBeyondSentPrompt(`${sentPrompt}\nscenario output`, sentPrompt)).toBe(true);
  });

  it('detects short agent output after a long prompt via cursor accumulation', () => {
    const sentPrompt = 'x'.repeat(5000);
    expect(smokeAgentTerminalActivityBeyondSentPrompt('ok', sentPrompt)).toBe(true);
    expect(smokeAgentTerminalActivityBeyondSentPrompt(sentPrompt.slice(0, 40), sentPrompt)).toBe(false);
    expect(smokeAgentTerminalActivityBeyondSentPrompt(`${sentPrompt}\nok`, sentPrompt)).toBe(true);
  });

  it('does not treat echoed prompt text as agent activity', () => {
    let now = 0;
    const sentPrompt = 'run smoke now';
    const runner = vi.fn((executable: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('terminal read')) {
        return {
          stdout: JSON.stringify({ ok: true, result: { lines: [sentPrompt], nextCursor: 2 } }),
          stderr: '',
          status: 0,
        };
      }
      return { stdout: JSON.stringify({ ok: false, error: { message: 'unexpected' } }), stderr: '', status: 1 };
    });

    const result = waitForSmokeAgentCompletion('term_prompt_echo', {
      runner: runner as never,
      now: () => now,
      deadlineMs: 600,
      preSendBaselineText: 'idle',
      preSendCursor: 1,
      sentPrompt,
      sleepMs: (ms) => {
        now += ms;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.agentActivityObserved).toBe(false);
    expect(result.error?.code).toBe('smoke_agent_never_started');
  });

  it('does not treat PTY-only output as durable completion after #1115', () => {
    let now = 0;
    const sentPrompt = 'x'.repeat(5000);
    const runner = vi.fn((executable: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('terminal read')) {
        return {
          stdout: JSON.stringify({ ok: true, result: { lines: ['```worker-smoke-report', 'result: PASS', '```'], nextCursor: 2 } }),
          stderr: '',
          status: 0,
        };
      }
      return { stdout: JSON.stringify({ ok: false, error: { message: 'unexpected' } }), stderr: '', status: 1 };
    });

    const result = waitForSmokeAgentCompletion('term_long_prompt_short_output', {
      runner: runner as never,
      now: () => now,
      deadlineMs: 600,
      preSendBaselineText: 'idle',
      preSendCursor: 1,
      sentPrompt,
      sleepMs: (ms) => {
        now += ms;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.agentActivityObserved).toBe(true);
    expect(result.error?.code).toBe('smoke_agent_wait_timeout');
  });

  it('ignores delayed PTY report text without a sealed durable artifact', () => {
    let now = 0;
    let readCalls = 0;
    const sentPrompt = 'run smoke now';
    const runner = vi.fn((executable: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('terminal read')) {
        readCalls += 1;
        if (readCalls < 4) {
          return { stdout: JSON.stringify({ ok: true, result: { lines: [], nextCursor: 1 } }), stderr: '', status: 0 };
        }
        return {
          stdout: JSON.stringify({ ok: true, result: { lines: ['agent scenario output', '```worker-smoke-report', 'result: PASS', '```'], nextCursor: 2 } }),
          stderr: '',
          status: 0,
        };
      }
      return { stdout: JSON.stringify({ ok: false, error: { message: 'unexpected' } }), stderr: '', status: 1 };
    });

    const result = waitForSmokeAgentCompletion('term_delayed', {
      runner: runner as never,
      now: () => now,
      deadlineMs: 600,
      preSendBaselineText: 'idle',
      preSendCursor: 1,
      sentPrompt,
      sleepMs: (ms) => {
        now += ms;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('smoke_agent_wait_timeout');
  });

  it('maps activity-without-sealed-artifact to agent_report_timeout', () => {
    let now = 0;
    const sentPrompt = 'run smoke now';
    const runner = vi.fn((executable: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('terminal read')) {
        return { stdout: JSON.stringify({ ok: true, result: { lines: ['scenario output only'], nextCursor: 2 } }), stderr: '', status: 0 };
      }
      return { stdout: JSON.stringify({ ok: false, error: { message: 'unexpected' } }), stderr: '', status: 1 };
    });

    const waitResult = waitForSmokeAgentCompletion('term_started_no_report', {
      runner: runner as never,
      now: () => now,
      deadlineMs: 600,
      preSendBaselineText: 'idle',
      preSendCursor: 1,
      sentPrompt,
      sleepMs: (ms) => {
        now += ms;
      },
    });
    expect(waitResult.ok).toBe(false);
    expect(waitResult.agentActivityObserved).toBe(true);
    expect(waitResult.error?.code).toBe('smoke_agent_wait_timeout');
  });

  it('terminates at the shared deadline when the agent never starts', () => {
    let now = 0;
    const sentPrompt = 'run smoke now';
    const runner = vi.fn((executable: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('terminal read')) {
        return { stdout: JSON.stringify({ ok: true, result: { lines: [], nextCursor: 1 } }), stderr: '', status: 0 };
      }
      return { stdout: JSON.stringify({ ok: false, error: { message: 'unexpected' } }), stderr: '', status: 1 };
    });

    const result = waitForSmokeAgentCompletion('term_never', {
      runner: runner as never,
      now: () => now,
      deadlineMs: 600,
      preSendBaselineText: 'idle',
      preSendCursor: 1,
      sentPrompt,
      sleepMs: (ms) => {
        now += ms;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.agentActivityObserved).toBe(false);
    expect(result.error?.code).toBe('smoke_agent_never_started');
    expect(now).toBeLessThanOrEqual(600);
  });
});

describe('orca terminal read normalization (#1101)', () => {
  it('accepts live Orca terminal.tail payloads and string cursors', () => {
    const live = {
      terminal: {
        tail: ['prompt echo', 'agent output'],
        nextCursor: '315',
      },
    };
    expect(orcaTerminalReadLines(live)).toEqual(['prompt echo', 'agent output']);
    expect(orcaTerminalReadNextCursor(live)).toBe(315);
  });

  it('accepts capture-backed result.lines payloads', () => {
    const capture = { lines: ['```worker-smoke-report', 'result: PASS'], nextCursor: 7 };
    expect(orcaTerminalReadLines(capture)).toEqual(['```worker-smoke-report', 'result: PASS']);
    expect(orcaTerminalReadNextCursor(capture)).toBe(7);
  });
});

describe('worker smoke malformed PASS normalization (#1101)', () => {
  it('does not classify harness normalization failures as executed_scenario_failure', () => {
    const agentPartial = {
      result: 'PASS' as const,
      scenarios: [{ action: 'run scenario', expected: 'pass', observed: 'pass', outcome: 'pass' as const }],
    };
    const harnessFailureReport = {
      result: 'FAIL' as const,
      scenarios: [{
        action: 'normalize smoke agent report',
        expected: 'valid PASS evidence',
        observed: 'missing producer evidence',
        outcome: 'fail' as const,
      }],
    };
    expect(classifyDeclaredScenarioNonPassCause({
      partial: harnessFailureReport,
      agentActivityObserved: true,
      agentCompleted: true,
    })).toBe('executed_scenario_failure');
    expect(classifyDeclaredScenarioNonPassCause({
      partial: agentPartial,
      agentActivityObserved: true,
      agentCompleted: true,
    })).toBeUndefined();
  });
});

describe('worker smoke non-pass cause classification (#1101)', () => {
  it('distinguishes zero-parsed-scenarios, missing-agent-report, and executed-scenario-failure', () => {
    expect(classifySmokeNonPassCause({ zeroParsedScenarios: true, partial: null, agentActivityObserved: false }))
      .toBe('zero_parsed_scenarios');
    expect(classifySmokeNonPassCause({ partial: null, agentActivityObserved: true, agentCompleted: true }))
      .toBe('missing_agent_report');
    expect(classifySmokeNonPassCause({ partial: null, agentActivityObserved: true, agentCompleted: false }))
      .toBeUndefined();
    expect(classifySmokeNonPassCause({
      partial: {
        result: 'FAIL',
        scenarios: [{ action: 'x', expected: 'y', observed: 'z', outcome: 'fail' }],
      },
      agentActivityObserved: true,
      agentCompleted: true,
    })).toBe('executed_scenario_failure');
    expect(classifySmokeNonPassCause({
      partial: { result: 'FAIL', scenarios: [{ action: 'x', expected: 'y', observed: 'z', outcome: 'pass' }] },
      agentActivityObserved: true,
      agentCompleted: true,
    })).toBeUndefined();
    expect(classifyDeclaredScenarioNonPassCause({
      partial: {
        result: 'FAIL',
        scenarios: [
          { action: 'declared scenario', expected: 'pass', observed: 'pass', outcome: 'pass' },
          { action: SMOKE_HARNESS_TERMINAL_CLOSE_ACTION, expected: 'terminal close succeeds', observed: 'close_failed:unknown', outcome: 'fail' },
        ],
      },
      agentActivityObserved: true,
      agentCompleted: true,
    })).toBeUndefined();
  });

  it('includes nonPassCause in published machine block before emission', () => {
    const comment = formatSmokeReportComment({
      result: 'FAIL',
      issueNumber: 1101,
      prNumber: 7,
      headSha: headA,
      scenarios: [{ action: 'run scenario', expected: 'ok', observed: 'bad', outcome: 'fail' }],
      limitations: [],
      trackedFilesUnmodified: true,
      terminalCleanup: 'closed_owned_handle',
      environmentNotes: [],
      nonPassCause: 'executed_scenario_failure',
    });
    expect(comment).toContain('non-pass-cause: executed_scenario_failure');
  });

  it('parses numbered prose to zero scenarios and blocks gate-check without implying execution', () => {
    const markdown = readFixture('zero-scenario-numbered-prose.md');
    const plan = resolveSmokeRequirement(markdown);
    expect(plan.requirement).toBe('required');
    expect(plan.scenarios).toHaveLength(0);
    const decision = evaluateWorkerSmokeGate({
      ...gateBase,
      issueBody: markdown,
      prNumber: 7,
      headSha: headA,
      prComments: [],
      ciGreen: true,
      orcaWorktreeOk: true,
      ownedTerminalClosed: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('missing_smoke_plan');
  });

  it('run emits zero_parsed_scenarios before terminal creation for numbered-prose plans', () => {
    const bodyFile = join(fixtureRoot, 'zero-scenario-numbered-prose.md');
    const result = runProcessSync({
      command: process.execPath,
      args: [
        '--experimental-strip-types',
        join(import.meta.dirname, 'worker-smoke-run.ts'),
        'run',
        '--issue', '1101',
        '--pr', '1',
        '--head-sha', headA,
        '--issue-body-file', bodyFile,
        '--dry-run',
        '--json',
      ],
      inheritParentEnv: true,
    });
    expect(result.ok).toBe(false);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.nonPassCause).toBe('zero_parsed_scenarios');
    expect(payload.terminalCreated).toBe(false);
    expect(payload.published).toBe(false);
    expect(payload.report?.nonPassCause).toBe('zero_parsed_scenarios');
  });

    it('still serializes canonical non-empty scenarios into the smoke-agent prompt', () => {
    const markdown = readFixture('action-producing-with-plan.md');
    const plan = resolveSmokeRequirement(markdown);
    expect(plan.scenarios.length).toBeGreaterThan(0);
    const prompt = buildSmokeAgentPrompt({
      issueNumber: 1101,
      issueBody: markdown,
      prNumber: 1,
      headSha: headA,
      plan,
    });
    expect(prompt).toContain(plan.scenarios[0]?.action ?? '');
    expect(prompt).not.toContain('(none — report BLOCKED');
  });
});

function makeRunBinding(root: string, runId = createSmokeRunIdentity()) {
  const artifactDir = resolveSmokeRunArtifactDir(root, runId);
  ensureSmokeRunArtifactDir(artifactDir);
  return { runId, artifactDir };
}

function writeDeliverySealed(binding: { runId: string; artifactDir: string }) {
  writeFileSync(smokeDeliverySealedPath(binding.artifactDir), JSON.stringify({ runId: binding.runId }), 'utf8');
}

function observeCompletion(binding: { runId: string; artifactDir: string }, state?: import('./lib/worker-smoke-core.ts').SmokeCompletionObservationState) {
  return observeSmokeCompletionEvidence(binding, state).observation;
}

function writePassCompletion(binding: { runId: string; artifactDir: string }) {
  const body = [
    '```worker-smoke-report',
    'result: PASS',
    'tracked-files-unmodified: true',
    'scenarios:',
    '  - action: run scenario | expected: pass | observed: pass | outcome: pass',
    '```',
  ].join('\n');
  const digest = computeSmokeCompletionBodyDigest(body);
  writeFileSync(smokeCompletionBodyPath(binding.artifactDir, digest), body, 'utf8');
  writeFileSync(
    smokeCompletionSealPath(binding.artifactDir, digest),
    JSON.stringify({ runId: binding.runId, bodySha256: digest }),
    'utf8',
  );
  return { body, digest };
}

function writeCompletionBody(binding: { runId: string; artifactDir: string }, body: string, runId = binding.runId) {
  const digest = computeSmokeCompletionBodyDigest(body);
  writeFileSync(smokeCompletionBodyPath(binding.artifactDir, digest), body, 'utf8');
  writeFileSync(
    smokeCompletionSealPath(binding.artifactDir, digest),
    JSON.stringify({ runId, bodySha256: digest }),
    'utf8',
  );
  return digest;
}

describe('worker smoke child-wait completion contract (#1115)', () => {

  it('delivery-boot-delayed accepts sealed delivery after startup delay', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-delivery-boot-'));
    const binding = makeRunBinding(root);
    let now = 0;
    const runner = vi.fn((executable: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('terminal send')) {
        return { stdout: JSON.stringify({ ok: true, result: {} }), stderr: '', status: 0 };
      }
      return { stdout: JSON.stringify({ ok: true, result: { lines: [] } }), stderr: '', status: 0 };
    });
    const delivery = establishSmokePromptDelivery('child', {
      cwd: root,
      deadlineMs: 2_000,
      runBinding: binding,
      prompt: 'smoke prompt',
      runner: runner as never,
      now: () => now,
      sleepMs: (ms) => {
        now += ms;
        if (now >= 400) {
          writeDeliverySealed(binding);
        }
      },
    });
    expect(delivery.ok).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('delivery-scrollback-dropped does not require PTY delivery evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-delivery-scrollback-'));
    const binding = makeRunBinding(root);
    writeDeliverySealed(binding);
    expect(observeSmokeDeliveryEstablished(binding)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });


  it('partial second seal file stays pending rather than duplicate', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-completion-partial-seal2-'));
    const binding = makeRunBinding(root);
    writePassCompletion(binding);
    writeFileSync(join(binding.artifactDir, 'completion-deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef.sealed.json'), '{"runId":', 'utf8');
    expect(observeCompletion(binding).publicationState).toBe('publish_complete_single');
    rmSync(root, { recursive: true, force: true });
  });

  it('wrong-run extra seal is inadmissible and does not synthesize duplicate', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-completion-wrong-run-extra-'));
    const binding = makeRunBinding(root);
    writePassCompletion(binding);
    const foreign = [
      '```worker-smoke-report',
      'result: FAIL',
      'tracked-files-unmodified: true',
      'scenarios:',
      '  - action: run scenario | expected: pass | observed: fail | outcome: fail',
      '```',
    ].join('\n');
    writeCompletionBody(binding, foreign, 'foreign-run');
    const observation = observeCompletion(binding);
    expect(observation.publicationState).toBe('publish_complete_single');
    expect(observation.wrongRunBinding).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('completion publication straddle stays pending until body digest matches seal', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-completion-straddle-'));
    const binding = makeRunBinding(root);
    const finalBody = [
      '```worker-smoke-report',
      'result: PASS',
      'tracked-files-unmodified: true',
      'scenarios:',
      '  - action: run scenario | expected: pass | observed: pass | outcome: pass',
      '```',
    ].join('\n');
    const finalDigest = computeSmokeCompletionBodyDigest(finalBody);
    writeFileSync(smokeCompletionBodyPath(binding.artifactDir, finalDigest), 'partial-prefix', 'utf8');
    writeFileSync(
      smokeCompletionSealPath(binding.artifactDir, finalDigest),
      JSON.stringify({ runId: binding.runId, bodySha256: finalDigest }),
      'utf8',
    );
    expect(observeCompletion(binding).publicationState).toBe('partial');
    writeFileSync(smokeCompletionBodyPath(binding.artifactDir, finalDigest), finalBody, 'utf8');
    expect(observeCompletion(binding).publicationState).toBe('publish_complete_single');
    rmSync(root, { recursive: true, force: true });
  });

  it('competing content-addressed terminalizations are duplicate on first observation', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-completion-overwrite-'));
    const binding = makeRunBinding(root);
    writePassCompletion(binding);
    const replacement = [
      '```worker-smoke-report',
      'result: FAIL',
      'tracked-files-unmodified: true',
      'scenarios:',
      '  - action: run scenario | expected: pass | observed: fail | outcome: fail',
      '```',
    ].join('\n');
    writeCompletionBody(binding, replacement);
    expect(observeCompletion(binding).publicationState).toBe('publish_complete_duplicate');
    rmSync(root, { recursive: true, force: true });
  });

  it('in-place mutation of a hash-named body invalidates closure instead of masquerading', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-completion-inplace-mutate-'));
    const binding = makeRunBinding(root);
    const { digest } = writePassCompletion(binding);
    writeFileSync(smokeCompletionBodyPath(binding.artifactDir, digest), 'mutated-body', 'utf8');
    expect(observeCompletion(binding).publicationState).toBe('partial');
    rmSync(root, { recursive: true, force: true });
  });

  it('channel-untrustworthy matrix preserves exact upstream causes without verdict synthesis', () => {
    const channels = [
      ['supervisor', 'child', 'supervisor', 'agent_wait_self_handle'],
      ['other', 'child', undefined, 'agent_wait_unowned_handle'],
    ] as const;
    for (const [supervised, owned, supervisor, cause] of channels) {
      expect(classifySmokeChannelBinding({ supervisedHandle: supervised, ownedChildHandle: owned, supervisorHandle: supervisor })).toBe(cause);
    }
    const root = mkdtempSync(join(tmpdir(), 'smoke-channel-matrix-'));
    const binding = makeRunBinding(root);
    let now = 0;
    for (const code of ['channel_stale_handle', 'channel_lookup_empty', 'channel_control_unavailable', 'channel_control_overwritten'] as const) {
      now = 0;
      const runner = vi.fn(() => ({
        stdout: JSON.stringify({ ok: false, error: { code, message: `${code} observed` } }),
        stderr: '',
        status: 1,
      }));
      const result = waitForSmokeChildCompletion('child', {
        cwd: root,
        deadlineMs: 200,
        runBinding: binding,
        ownedChildHandle: 'child',
        runner: runner as never,
        now: () => now,
        sleepMs: (ms) => { now += ms; },
      });
      expect(result.ok).toBe(false);
      expect(result.nonPassCause).toBe(code);
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('PTY metamorphic property holds across reachable evidence branches', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-pty-matrix-'));

    const assertPtyInvariant = (
      setup: (dir: { runId: string; artifactDir: string }) => {
        deadlineMs?: number;
        childState?: () => import('./lib/worker-smoke-core.ts').SmokeChildStateWitness;
        supervisedHandle?: string;
        supervisorHandle?: string;
        runner?: ReturnType<typeof vi.fn>;
      },
      expected: { ok: boolean; cause?: string },
    ) => {
      const dir = makeRunBinding(root, createSmokeRunIdentity());
      const cfg = setup(dir);
      let now = 0;
      const base = {
        cwd: root,
        deadlineMs: cfg.deadlineMs ?? 200,
        runBinding: dir,
        ownedChildHandle: 'child',
        supervisedHandle: cfg.supervisedHandle,
        supervisorHandle: cfg.supervisorHandle,
        childStateWitness: cfg.childState,
        now: () => now,
        sleepMs: (ms: number) => { now += ms; },
        runner: cfg.runner,
      };
      const withPty = waitForSmokeChildCompletion(cfg.supervisedHandle ?? 'child', {
        ...base,
        runner: (cfg.runner ?? vi.fn(() => ({ stdout: JSON.stringify({ ok: true, result: { lines: ['pty-noise'] } }), stderr: '', status: 0 }))) as never,
      });
      now = 0;
      const withoutPty = waitForSmokeChildCompletion(cfg.supervisedHandle ?? 'child', {
        ...base,
        suppressPtyReads: true,
      });
      expect(withPty.ok).toBe(expected.ok);
      expect(withoutPty.ok).toBe(expected.ok);
      if (expected.cause) {
        expect(withPty.nonPassCause).toBe(expected.cause);
        expect(withoutPty.nonPassCause).toBe(expected.cause);
      }
      rmSync(dir.artifactDir, { recursive: true, force: true });
    };

    assertPtyInvariant(() => ({ deadlineMs: 50 }), { ok: false, cause: 'agent_report_timeout' });
    assertPtyInvariant((dir) => {
      writeFileSync(smokeCompletionPendingBodyPath(dir.artifactDir), 'partial', 'utf8');
      return {};
    }, { ok: false, cause: 'agent_report_timeout' });
    assertPtyInvariant((dir) => {
      writePassCompletion(dir);
      return { deadlineMs: 1_000 };
    }, { ok: true });
    assertPtyInvariant((dir) => {
      writePassCompletion(dir);
      const second = '```worker-smoke-report\nresult: FAIL\ntracked-files-unmodified: true\nscenarios:\n  - action: x | expected: y | observed: z | outcome: fail\n```';
      writeCompletionBody(dir, second);
      return {};
    }, { ok: false, cause: 'agent_report_duplicate' });
    assertPtyInvariant((dir) => {
      const unfenced = 'result: PASS\ntracked-files-unmodified: true\nscenarios:\n  - action: x | expected: y | observed: z | outcome: pass';
      writeCompletionBody(dir, unfenced);
      return {};
    }, { ok: false, cause: 'agent_report_unfenced' });
    assertPtyInvariant(() => ({ childState: () => ({ exited: true }), deadlineMs: 200 }), { ok: false, cause: 'agent_exited_without_report' });
    assertPtyInvariant(() => ({ childState: () => ({ idle: true }), deadlineMs: 200 }), { ok: false, cause: 'agent_idle_without_report' });
    assertPtyInvariant(() => ({ supervisedHandle: 'supervisor', supervisorHandle: 'supervisor' }), { ok: false, cause: 'agent_wait_self_handle' });
    assertPtyInvariant(() => ({ supervisedHandle: 'other' }), { ok: false, cause: 'agent_wait_unowned_handle' });
    assertPtyInvariant((dir) => ({
      runner: vi.fn(() => ({ stdout: JSON.stringify({ ok: false, error: { code: 'channel_control_unavailable', message: 'x' } }), stderr: '', status: 1 })),
    }), { ok: false, cause: 'channel_control_unavailable' });

    rmSync(root, { recursive: true, force: true });
  });

  it('delivery-ready-first-send waits for sealed delivery before completion', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-delivery-'));
    const binding = makeRunBinding(root);
    let now = 0;
    const runner = vi.fn((executable: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('terminal send')) {
        writeDeliverySealed(binding);
        return { stdout: JSON.stringify({ ok: true, result: {} }), stderr: '', status: 0 };
      }
      return { stdout: JSON.stringify({ ok: true, result: { lines: [] } }), stderr: '', status: 0 };
    });
    const delivery = establishSmokePromptDelivery('child', {
      cwd: root,
      deadlineMs: 2_000,
      runBinding: binding,
      prompt: 'smoke prompt',
      runner: runner as never,
      now: () => now,
      sleepMs: (ms) => { now += ms; },
    });
    expect(delivery.ok).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('delivery-exhausted yields prompt_delivery_unconfirmed without completion wait evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-delivery-exhaust-'));
    const binding = makeRunBinding(root);
    let now = 0;
    const runner = vi.fn(() => ({
      stdout: JSON.stringify({ ok: true, result: {} }),
      stderr: '',
      status: 0,
    }));
    const delivery = establishSmokePromptDelivery('child', {
      cwd: root,
      deadlineMs: 500,
      runBinding: binding,
      prompt: 'smoke prompt',
      runner: runner as never,
      now: () => now,
      sleepMs: (ms) => { now += ms; },
    });
    expect(delivery.ok).toBe(false);
    expect(delivery.cause).toBe('prompt_delivery_unconfirmed');
    rmSync(root, { recursive: true, force: true });
  });

  it('completion-current-run consumes sealed durable artifact independent of PTY', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-completion-current-'));
    const binding = makeRunBinding(root);
    writePassCompletion(binding);
    let now = 0;
    const result = waitForSmokeChildCompletion('child', {
      cwd: root,
      deadlineMs: 1_000,
      runBinding: binding,
      ownedChildHandle: 'child',
      suppressPtyReads: true,
      now: () => now,
      sleepMs: (ms) => { now += ms; },
    });
    expect(result.ok).toBe(true);
    expect(result.partial?.result).toBe('PASS');
    rmSync(root, { recursive: true, force: true });
  });

  it('completion-stale-run rejects wrong runId inside sealed artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-completion-stale-'));
    const binding = makeRunBinding(root);
    writePassCompletion({ ...binding, runId: 'stale-run-id' });
    const observation = observeCompletion(binding);
    expect(observation.wrongRunBinding).toBe(true);
    expect(observation.publicationState).toBe('none');
    rmSync(root, { recursive: true, force: true });
  });

  it('completion-publish-partial stays pending until seal closure', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-completion-partial-'));
    const binding = makeRunBinding(root);
    writeFileSync(smokeCompletionPendingBodyPath(binding.artifactDir), 'result: PASS', 'utf8');
    const pending = classifySmokeChildWaitObservation({
      completion: observeCompletion(binding),
      deadlineReached: false,
    });
    expect(pending.status).toBe('pending');
    const atDeadline = classifySmokeChildWaitObservation({
      completion: observeCompletion(binding),
      deadlineReached: true,
    });
    expect(atDeadline.status).toBe('non_pass');
    expect(atDeadline.cause).toBe('agent_report_timeout');
    rmSync(root, { recursive: true, force: true });
  });


  it('invalid seal without body digest stays pending until deadline', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-invalid-seal-'));
    const binding = makeRunBinding(root);
    const body = '```worker-smoke-report\nresult: PASS\ntracked-files-unmodified: true\nscenarios:\n  - action: x | expected: y | observed: z | outcome: pass\n```';
    const digest = computeSmokeCompletionBodyDigest(body);
    writeFileSync(smokeCompletionBodyPath(binding.artifactDir, digest), body, 'utf8');
    writeFileSync(smokeCompletionSealPath(binding.artifactDir, digest), JSON.stringify({ runId: binding.runId }), 'utf8');
    expect(observeCompletion(binding).publicationState).toBe('partial');
    rmSync(root, { recursive: true, force: true });
  });

  it('sealed body hash mismatch stays pending rather than accepting closure', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-hash-mismatch-'));
    const binding = makeRunBinding(root);
    const { digest } = writePassCompletion(binding);
    writeFileSync(smokeCompletionBodyPath(binding.artifactDir, digest), 'mutated body', 'utf8');
    expect(observeCompletion(binding).publicationState).toBe('partial');
    rmSync(root, { recursive: true, force: true });
  });

  it('completion-unfenced classifies only after publish-complete closure', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-completion-unfenced-'));
    const binding = makeRunBinding(root);
    const unfencedBody = 'result: PASS\ntracked-files-unmodified: true\nscenarios:\n  - action: x | expected: y | observed: z | outcome: pass';
    writeCompletionBody(binding, unfencedBody);
    const outcome = classifySmokeChildWaitObservation({
      completion: observeCompletion(binding),
      deadlineReached: false,
    });
    expect(outcome.status).toBe('non_pass');
    expect(outcome.cause).toBe('agent_report_unfenced');
    rmSync(root, { recursive: true, force: true });
  });

  it('completion-duplicate-report fails closed at publication boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-completion-dup-'));
    const binding = makeRunBinding(root);
    writePassCompletion(binding);
    const secondBody = [
      '```worker-smoke-report',
      'result: FAIL',
      'tracked-files-unmodified: true',
      'scenarios:',
      '  - action: run scenario | expected: pass | observed: fail | outcome: fail',
      '```',
    ].join('\n');
    writeCompletionBody(binding, secondBody);
    const outcome = classifySmokeChildWaitObservation({
      completion: observeCompletion(binding),
      deadlineReached: false,
    });
    expect(outcome.status).toBe('non_pass');
    expect(outcome.cause).toBe('agent_report_duplicate');
    rmSync(root, { recursive: true, force: true });
  });

  it('completion-no-terminal-evidence times out without synthesizing another class', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-completion-timeout-'));
    const binding = makeRunBinding(root);
    const outcome = classifySmokeChildWaitObservation({
      completion: observeCompletion(binding),
      deadlineReached: true,
    });
    expect(outcome.status).toBe('non_pass');
    expect(outcome.cause).toBe('agent_report_timeout');
    rmSync(root, { recursive: true, force: true });
  });

  it('completion-grounded-exit is immediate when witness is injected', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-completion-exit-'));
    const binding = makeRunBinding(root);
    const outcome = classifySmokeChildWaitObservation({
      completion: observeCompletion(binding),
      childState: { exited: true },
      deadlineReached: false,
    });
    expect(outcome.status).toBe('non_pass');
    expect(outcome.cause).toBe('agent_exited_without_report');
    rmSync(root, { recursive: true, force: true });
  });

  it('channel-self-handle and channel-unowned-handle refuse before completion evaluation', () => {
    expect(classifySmokeChannelBinding({
      supervisedHandle: 'supervisor',
      ownedChildHandle: 'child',
      supervisorHandle: 'supervisor',
    })).toBe('agent_wait_self_handle');
    expect(classifySmokeChannelBinding({
      supervisedHandle: 'other',
      ownedChildHandle: 'child',
    })).toBe('agent_wait_unowned_handle');
  });


  it('delivery-definite-nondelivery-retry resends only after definite non-delivery', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-delivery-retry-'));
    const binding = makeRunBinding(root);
    let sendCalls = 0;
    let now = 0;
    const runner = vi.fn((executable: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('terminal send')) {
        sendCalls += 1;
        if (sendCalls === 1) {
          return { stdout: JSON.stringify({ ok: false, error: { code: 'terminal_send_rejected', message: 'not accepted' } }), stderr: '', status: 1 };
        }
        writeDeliverySealed(binding);
        return { stdout: JSON.stringify({ ok: true, result: {} }), stderr: '', status: 0 };
      }
      return { stdout: JSON.stringify({ ok: true, result: { lines: [] } }), stderr: '', status: 0 };
    });
    const delivery = establishSmokePromptDelivery('child', {
      cwd: root,
      deadlineMs: 2_000,
      runBinding: binding,
      prompt: 'smoke prompt',
      allowDefiniteNondeliveryRetry: true,
      runner: runner as never,
      now: () => now,
      sleepMs: (ms) => { now += ms; },
    });
    expect(delivery.ok).toBe(true);
    expect(delivery.resendCount).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it('delivery-ambiguous-send-failure-never-retries without definite non-delivery code', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-delivery-ambiguous-fail-'));
    const binding = makeRunBinding(root);
    let sendCalls = 0;
    let now = 0;
    const runner = vi.fn((executable: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('terminal send')) {
        sendCalls += 1;
        return { stdout: JSON.stringify({ ok: false, error: { code: 'orca_invalid_json', message: 'empty stdout' } }), stderr: '', status: 1 };
      }
      return { stdout: JSON.stringify({ ok: true, result: {} }), stderr: '', status: 0 };
    });
    const delivery = establishSmokePromptDelivery('child', {
      cwd: root,
      deadlineMs: 500,
      runBinding: binding,
      prompt: 'smoke prompt',
      allowDefiniteNondeliveryRetry: true,
      runner: runner as never,
      now: () => now,
      sleepMs: (ms) => { now += ms; },
    });
    expect(delivery.ok).toBe(false);
    expect(sendCalls).toBe(1);
    expect(isDefinitePromptNonDelivery('orca_invalid_json')).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('delivery-ambiguous-send never resends on timeout alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-delivery-ambiguous-'));
    const binding = makeRunBinding(root);
    let sendCalls = 0;
    let now = 0;
    const runner = vi.fn((executable: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('terminal send')) {
        sendCalls += 1;
        return { stdout: JSON.stringify({ ok: true, result: {} }), stderr: '', status: 0 };
      }
      return { stdout: JSON.stringify({ ok: true, result: { lines: [] } }), stderr: '', status: 0 };
    });
    const delivery = establishSmokePromptDelivery('child', {
      cwd: root,
      deadlineMs: 500,
      runBinding: binding,
      prompt: 'smoke prompt',
      allowDefiniteNondeliveryRetry: true,
      runner: runner as never,
      now: () => now,
      sleepMs: (ms) => { now += ms; },
    });
    expect(delivery.ok).toBe(false);
    expect(sendCalls).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });


  it('delivery-bracketed-paste-stuck nudges composer submit until sealed delivery', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-delivery-paste-stuck-'));
    const binding = makeRunBinding(root);
    let fullSendCount = 0;
    let composerSubmitCount = 0;
    let now = 0;
    const runner = vi.fn((executable: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('terminal send')) {
        if (args.includes('--text')) {
          fullSendCount += 1;
          return { stdout: JSON.stringify({ ok: true, result: {} }), stderr: '', status: 0 };
        }
        composerSubmitCount += 1;
        if (composerSubmitCount >= 2) {
          writeDeliverySealed(binding);
        }
        return { stdout: JSON.stringify({ ok: true, result: {} }), stderr: '', status: 0 };
      }
      if (joined.includes('terminal read')) {
        const lines = observeSmokeDeliveryEstablished(binding)
          ? []
          : ['→ [Pasted text #1 +349 lines]'];
        return { stdout: JSON.stringify({ ok: true, result: { lines } }), stderr: '', status: 0 };
      }
      return { stdout: JSON.stringify({ ok: true, result: {} }), stderr: '', status: 0 };
    });
    const delivery = establishSmokePromptDelivery('child', {
      cwd: root,
      deadlineMs: 5_000,
      runBinding: binding,
      prompt: 'smoke prompt',
      runner: runner as never,
      now: () => now,
      sleepMs: (ms) => { now += ms; },
    });
    expect(delivery.ok).toBe(true);
    expect(fullSendCount).toBe(1);
    expect(composerSubmitCount).toBeGreaterThanOrEqual(1);
    expect(delivery.composerSubmitCount).toBe(composerSubmitCount);
    rmSync(root, { recursive: true, force: true });
  });

  it('delivery-bracketed-paste-stuck does not re-send full prompt text', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-delivery-paste-no-resend-'));
    const binding = makeRunBinding(root);
    let fullSendCount = 0;
    let now = 0;
    const runner = vi.fn((executable: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('terminal send') && args.includes('--text')) {
        fullSendCount += 1;
        return { stdout: JSON.stringify({ ok: true, result: {} }), stderr: '', status: 0 };
      }
      if (joined.includes('terminal send')) {
        writeDeliverySealed(binding);
        return { stdout: JSON.stringify({ ok: true, result: {} }), stderr: '', status: 0 };
      }
      if (joined.includes('terminal read')) {
        return {
          stdout: JSON.stringify({ ok: true, result: { lines: ['→ [Pasted text #1 +120 lines]'] } }),
          stderr: '',
          status: 0,
        };
      }
      return { stdout: JSON.stringify({ ok: true, result: {} }), stderr: '', status: 0 };
    });
    const delivery = establishSmokePromptDelivery('child', {
      cwd: root,
      deadlineMs: 2_000,
      runBinding: binding,
      prompt: 'smoke prompt',
      runner: runner as never,
      now: () => now,
      sleepMs: (ms) => { now += ms; },
    });
    expect(delivery.ok).toBe(true);
    expect(fullSendCount).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it('delivery-bracketed-paste-stuck skips composer nudge once delivery seal exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-delivery-paste-sealed-'));
    const binding = makeRunBinding(root);
    writeDeliverySealed(binding);
    let composerSubmitCount = 0;
    let now = 0;
    const runner = vi.fn((executable: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('terminal send') && !args.includes('--text')) {
        composerSubmitCount += 1;
      }
      if (joined.includes('terminal read')) {
        return {
          stdout: JSON.stringify({ ok: true, result: { lines: ['→ [Pasted text #1 +349 lines]'] } }),
          stderr: '',
          status: 0,
        };
      }
      return { stdout: JSON.stringify({ ok: true, result: {} }), stderr: '', status: 0 };
    });
    const delivery = establishSmokePromptDelivery('child', {
      cwd: root,
      deadlineMs: 500,
      runBinding: binding,
      prompt: 'smoke prompt',
      runner: runner as never,
      now: () => now,
      sleepMs: (ms) => { now += ms; },
    });
    expect(delivery.ok).toBe(true);
    expect(composerSubmitCount).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it('observeSmokeUnsubmittedComposerPaste recognizes bracketed paste affordance lines', () => {
    expect(observeSmokeUnsubmittedComposerPaste(['→ [Pasted text #1 +349 lines]'])).toBe(true);
    expect(observeSmokeUnsubmittedComposerPaste(['[Pasted text #2 +12 lines]'])).toBe(true);
    expect(observeSmokeUnsubmittedComposerPaste(['Composer 2.5 · 48.7%'])).toBe(false);
  });

  it('completion-wrong-run ignores artifacts outside the current run directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-completion-wrong-'));
    const current = makeRunBinding(root, 'current-run');
    const other = makeRunBinding(root, 'other-run');
    writePassCompletion(other);
    const observation = observeCompletion(current);
    expect(observation.publicationState).toBe('none');
    rmSync(root, { recursive: true, force: true });
  });

  it('completion-second-terminalization-at-closure is duplicate when second seal appears', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-completion-boundary-'));
    const binding = makeRunBinding(root);
    writePassCompletion(binding);
    const secondBody = [
      '```worker-smoke-report',
      'result: FAIL',
      'tracked-files-unmodified: true',
      'scenarios:',
      '  - action: run scenario | expected: pass | observed: fail | outcome: fail',
      '```',
    ].join('\n');
    writeCompletionBody(binding, secondBody);
    expect(observeCompletion(binding).publicationState).toBe('publish_complete_duplicate');
    rmSync(root, { recursive: true, force: true });
  });

  it('completion-grounded-idle is immediate only with injected idle witness', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-completion-idle-'));
    const binding = makeRunBinding(root);
    const outcome = classifySmokeChildWaitObservation({
      completion: observeCompletion(binding),
      childState: { idle: true },
      deadlineReached: false,
    });
    expect(outcome.cause).toBe('agent_idle_without_report');
    rmSync(root, { recursive: true, force: true });
  });

  it('channel control-plane causes pass through without smoke verdict synthesis', () => {
    let now = 0;
    const root = mkdtempSync(join(tmpdir(), 'smoke-channel-cp-'));
    const binding = makeRunBinding(root);
    const runner = vi.fn(() => ({
      stdout: JSON.stringify({ ok: false, error: { code: 'channel_control_unavailable', message: 'upstream control-plane failure' } }),
      stderr: '',
      status: 1,
    }));
    const result = waitForSmokeChildCompletion('child', {
      cwd: root,
      deadlineMs: 1_000,
      runBinding: binding,
      ownedChildHandle: 'child',
      runner: runner as never,
      now: () => now,
      sleepMs: (ms) => { now += ms; },
    });
    expect(result.ok).toBe(false);
    expect(result.nonPassCause).toBe('channel_control_unavailable');
    rmSync(root, { recursive: true, force: true });
  });

  it('shared terminal-phase budget reduces completion wait after delivery work', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-deadline-'));
    const binding = makeRunBinding(root);
    let now = 0;
    const deliveryStartedAt = 0;
    const deliveryMs = 400;
    const runner = vi.fn((executable: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('terminal send')) {
        return { stdout: JSON.stringify({ ok: true, result: {} }), stderr: '', status: 0 };
      }
      return { stdout: JSON.stringify({ ok: true, result: { lines: [] } }), stderr: '', status: 0 };
    });
    const delivery = establishSmokePromptDelivery('child', {
      cwd: root,
      deadlineMs: 1_000,
      runBinding: binding,
      prompt: 'smoke prompt',
      runner: runner as never,
      now: () => now,
      sleepMs: (ms) => { now += ms; },
    });
    void deliveryStartedAt;
    now = deliveryMs;
    writeDeliverySealed(binding);
    const waitStarted = now;
    const result = waitForSmokeChildCompletion('child', {
      cwd: root,
      deadlineMs: Math.max(0, 1_000 - (now - deliveryStartedAt)),
      runBinding: binding,
      ownedChildHandle: 'child',
      suppressPtyReads: true,
      now: () => now,
      sleepMs: (ms) => { now += ms; },
    });
    expect(result.ok).toBe(false);
    expect(result.nonPassCause).toBe('agent_report_timeout');
    expect(now - waitStarted).toBeLessThanOrEqual(600);
    rmSync(root, { recursive: true, force: true });
  });

  it('PTY suppression does not change durable completion classification', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-pty-meta-'));
    const binding = makeRunBinding(root);
    writePassCompletion(binding);
    let now = 0;
    const withPty = waitForSmokeChildCompletion('child', {
      cwd: root,
      deadlineMs: 1_000,
      runBinding: binding,
      ownedChildHandle: 'child',
      runner: vi.fn(() => ({ stdout: JSON.stringify({ ok: true, result: { lines: ['noise'] } }), stderr: '', status: 0 })) as never,
      now: () => now,
      sleepMs: (ms) => { now += ms; },
    });
    now = 0;
    const withoutPty = waitForSmokeChildCompletion('child', {
      cwd: root,
      deadlineMs: 1_000,
      runBinding: binding,
      ownedChildHandle: 'child',
      suppressPtyReads: true,
      now: () => now,
      sleepMs: (ms) => { now += ms; },
    });
    expect(withPty.ok).toBe(withoutPty.ok);
    expect(withPty.partial?.result).toBe(withoutPty.partial?.result);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('worker smoke Orca control-plane classification (#1125)', () => {
  const exactCodes = [
    'channel_stale_handle',
    'channel_lookup_empty',
    'channel_control_unavailable',
    'channel_control_overwritten',
  ] as const;
  const rawSentinel = 'RAW_UPSTREAM_SENTINEL_TOKEN_1125';

  it('categorizes local CLI outcomes and every exact control-plane code', async () => {
    const cli = await import('./lib/orca-cli.ts');
    const launch = cli.runOrcaJson(['worktree', 'current'], {
      runner: (() => { throw new Error(rawSentinel); }) as never,
    });
    expect(launch.outcomeCategory).toBe('process_launch_failed');
    expect(launch.operation).toBe('worktree_current');

    const empty = cli.runOrcaJson(['terminal', 'create'], {
      runner: (() => ({ stdout: '', stderr: rawSentinel, status: 1 })) as never,
    });
    expect(empty.outcomeCategory).toBe('empty_stdout');
    expect(empty.operation).toBe('terminal_create');

    const invalid = cli.runOrcaJson(['worktree', 'current'], {
      runner: (() => ({ stdout: `{${rawSentinel}`, stderr: '', status: 1 })) as never,
    });
    expect(invalid.outcomeCategory).toBe('invalid_json');

    const unsupported = cli.runOrcaJson(['terminal', 'read', '--terminal', 'term_owned'], {
      runner: (() => ({
        stdout: JSON.stringify({ ok: false, error: { code: 'terminal_busy', message: rawSentinel } }),
        stderr: '',
        status: 1,
      })) as never,
    });
    expect(unsupported.outcomeCategory).toBe('supported_operation_failure');
    expect(unsupported.operation).toBe('terminal_read');

    for (const code of exactCodes) {
      const response = cli.runOrcaJson(['terminal', 'close', '--terminal', 'term_owned'], {
        runner: (() => ({
          stdout: JSON.stringify({ ok: false, error: { code, message: rawSentinel } }),
          stderr: '',
          status: 1,
        })) as never,
      });
      expect(response.outcomeCategory).toBe('recognized_control_plane_code');
      expect(response.operation).toBe('terminal_close');
    }
    expect(cli.resolveOrcaOperation(['terminal', 'send', '--terminal', 'x', '--text', 'y'])).toBe('terminal_send');
    expect(cli.resolveOrcaOperation(['terminal', 'send', '--terminal', 'x', '--enter'])).toBe('terminal_submit');
  });

  it('maps only the supported phase matrices to stable causes', async () => {
    const core = await import('./lib/worker-smoke-core.ts');
    for (const operation of ['worktree_current', 'terminal_create'] as const) {
      for (const outcomeCategory of ['process_launch_failed', 'empty_stdout', 'invalid_json'] as const) {
        expect(core.createSmokeControlPlaneDiagnostic({
          terminalAcquired: false,
          operation,
          outcomeCategory,
        })).toEqual({
          cause: 'orca_control_plane_unavailable_preflight',
          evidence: [`operation=${operation}`, `outcome=${outcomeCategory}`],
          remediation: core.SMOKE_CONTROL_PLANE_REMEDIATION.orca_control_plane_unavailable_preflight,
        });
      }
    }

    for (const operation of ['terminal_send', 'terminal_read', 'terminal_submit', 'terminal_close'] as const) {
      for (const controlPlaneCode of exactCodes) {
        expect(core.createSmokeControlPlaneDiagnostic({
          terminalAcquired: true,
          operation,
          outcomeCategory: 'recognized_control_plane_code',
          controlPlaneCode,
        })).toEqual({
          cause: 'orca_control_plane_lost_mid_smoke',
          evidence: [
            `operation=${operation}`,
            'outcome=recognized_control_plane_code',
            `control_plane_code=${controlPlaneCode}`,
          ],
          remediation: core.SMOKE_CONTROL_PLANE_REMEDIATION.orca_control_plane_lost_mid_smoke,
        });
      }
    }

    expect(core.createSmokeControlPlaneDiagnostic({
      terminalAcquired: false,
      operation: 'worktree_current',
      outcomeCategory: 'recognized_control_plane_code',
      controlPlaneCode: 'channel_stale_handle',
    })).toBeUndefined();
    expect(core.createSmokeControlPlaneDiagnostic({
      terminalAcquired: true,
      operation: 'terminal_read',
      outcomeCategory: 'supported_operation_failure',
      controlPlaneCode: 'terminal_busy',
    })).toBeUndefined();
  });

  it('rejects noncanonical, reordered, duplicated, and oversized diagnostics without truncation', async () => {
    const core = await import('./lib/worker-smoke-core.ts');
    const valid = core.createSmokeControlPlaneDiagnostic({
      terminalAcquired: true,
      operation: 'terminal_read',
      outcomeCategory: 'recognized_control_plane_code',
      controlPlaneCode: 'channel_stale_handle',
    })!;
    expect(core.normalizeSmokeControlPlaneDiagnostic(valid)).toEqual({ ok: true, diagnostic: valid });
    expect(valid.evidence).toHaveLength(3);
    expect(valid.evidence.every((entry) => Buffer.byteLength(entry, 'utf8') <= 256)).toBe(true);
    expect(Buffer.byteLength(valid.remediation, 'utf8')).toBeLessThanOrEqual(256);

    expect(core.normalizeSmokeControlPlaneDiagnostic({
      ...valid,
      evidence: [...valid.evidence, 'operation=terminal_read'],
    })).toEqual({ ok: false, reason: 'control_plane_diagnostic_evidence_count_invalid' });
    expect(core.normalizeSmokeControlPlaneDiagnostic({
      ...valid,
      evidence: [valid.evidence[1], valid.evidence[0], valid.evidence[2]],
    })).toEqual({ ok: false, reason: 'control_plane_diagnostic_payload_mismatch' });
    expect(core.normalizeSmokeControlPlaneDiagnostic({
      ...valid,
      evidence: ['operation=terminal_read', 'operation=terminal_read', valid.evidence[2]],
    })).toEqual({ ok: false, reason: 'control_plane_diagnostic_evidence_noncanonical' });
    expect(core.normalizeSmokeControlPlaneDiagnostic({
      ...valid,
      evidence: [`operation=${'x'.repeat(246)}`],
    })).not.toEqual({ ok: false, reason: 'control_plane_diagnostic_evidence_too_large' });
    expect(core.normalizeSmokeControlPlaneDiagnostic({
      ...valid,
      evidence: [`operation=${'x'.repeat(247)}`],
    })).toEqual({ ok: false, reason: 'control_plane_diagnostic_evidence_too_large' });
    expect(core.normalizeSmokeControlPlaneDiagnostic({
      ...valid,
      remediation: `${valid.remediation}${rawSentinel}`,
    })).toEqual({ ok: false, reason: 'control_plane_diagnostic_payload_mismatch' });
    expect(core.normalizeSmokeControlPlaneDiagnostic({
      ...valid,
      evidence: ['operation=<script>alert_1125</script>'],
    })).toEqual({ ok: false, reason: 'control_plane_diagnostic_evidence_noncanonical' });
  });

  it('round-trips one safe payload through report extraction and current-head gate output', async () => {
    const core = await import('./lib/worker-smoke-core.ts');
    const diagnostic = core.createSmokeControlPlaneDiagnostic({
      terminalAcquired: true,
      operation: 'terminal_send',
      outcomeCategory: 'recognized_control_plane_code',
      controlPlaneCode: 'channel_control_unavailable',
    })!;
    const report = {
      result: 'BLOCKED' as const,
      issueNumber: 1125,
      prNumber: 1153,
      headSha: headA,
      scenarios: [{
        action: 'establish smoke prompt delivery',
        expected: 'delivery seal',
        observed: diagnostic.cause,
        outcome: 'blocked' as const,
      }],
      limitations: [],
      trackedFilesUnmodified: true,
      terminalCleanup: 'close_failed:recognized_control_plane_code',
      environmentNotes: [],
      nonPassCause: diagnostic.cause,
      controlPlaneDiagnostic: diagnostic,
    };
    const comment = core.formatSmokeReportComment(report);
    expect(comment).not.toContain(rawSentinel);
    const extracted = core.extractSmokeReportsFromComments([{ body: comment }]);
    expect(extracted).toHaveLength(1);
    expect(extracted[0]?.controlPlaneDiagnostic).toEqual(diagnostic);
    const decision = core.evaluateWorkerSmokeGate({
      issueBody: readFixture('action-producing-with-plan.md'),
      issueNumber: 1125,
      prNumber: 1153,
      headSha: headA,
      prComments: [{ body: comment }],
      ciGreen: true,
      orcaWorktreeOk: false,
      ownedTerminalClosed: false,
      terminalProvenanceOk: false,
    });
    expect(decision).toEqual({
      allowed: false,
      reason: 'orca_control_plane_lost_mid_smoke',
      smokeRequired: true,
      controlPlaneDiagnostic: diagnostic,
    });
  });

  it('preserves operation-specific diagnostics on delivery and child-wait seams', () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-control-plane-1125-'));
    const binding = makeRunBinding(root);
    let now = 0;
    const sendFailure = establishSmokePromptDelivery('child', {
      cwd: root,
      deadlineMs: 200,
      runBinding: binding,
      prompt: 'smoke prompt',
      runner: vi.fn(() => ({
        stdout: JSON.stringify({
          ok: false,
          error: { code: 'channel_stale_handle', message: rawSentinel },
        }),
        stderr: '',
        status: 1,
      })) as never,
      now: () => now,
      sleepMs: (ms) => { now += ms; },
    });
    expect(sendFailure.controlPlaneDiagnostic?.evidence).toEqual([
      'operation=terminal_send',
      'outcome=recognized_control_plane_code',
      'control_plane_code=channel_stale_handle',
    ]);

    now = 0;
    const readFailure = waitForSmokeChildCompletion('child', {
      cwd: root,
      deadlineMs: 200,
      runBinding: binding,
      ownedChildHandle: 'child',
      runner: vi.fn(() => ({
        stdout: JSON.stringify({
          ok: false,
          error: { code: 'channel_lookup_empty', message: rawSentinel },
        }),
        stderr: '',
        status: 1,
      })) as never,
      now: () => now,
      sleepMs: (ms) => { now += ms; },
    });
    expect(readFailure.controlPlaneDiagnostic?.evidence).toEqual([
      'operation=terminal_read',
      'outcome=recognized_control_plane_code',
      'control_plane_code=channel_lookup_empty',
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  it('does not let injected ORCA environment values authorize a worktree', () => {
    vi.stubEnv('ORCA_WORKTREE_PATH', '/tmp/worktree');
    vi.stubEnv('ORCA_WORKTREE_ID', 'injected-authority');
    const probe = probeOrcaWorktree('/tmp/worktree', {
      runner: vi.fn(() => ({ stdout: `{${rawSentinel}`, stderr: '', status: 1 })) as never,
    });
    expect(probe.ok).toBe(false);
    if (!probe.ok) {
      expect(probe.outcomeCategory).toBe('invalid_json');
      expect(probe.operation).toBe('worktree_current');
    }
    vi.unstubAllEnvs();
  });
});
