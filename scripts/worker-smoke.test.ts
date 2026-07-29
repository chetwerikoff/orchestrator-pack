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
import { runSmokeGhSync, waitForSmokeAgentCompletion } from './worker-smoke-run.ts';
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

  it('accumulates short cursor deltas under a long prompt envelope', () => {
    let now = 0;
    let readCalls = 0;
    const sentPrompt = 'x'.repeat(5000);
    const runner = vi.fn((executable: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('terminal read')) {
        readCalls += 1;
        if (readCalls < 3) {
          return { stdout: JSON.stringify({ ok: true, result: { lines: [sentPrompt.slice(0, 1000)], nextCursor: readCalls } }), stderr: '', status: 0 };
        }
        return {
          stdout: JSON.stringify({ ok: true, result: { lines: ['ok'], nextCursor: 99 } }),
          stderr: '',
          status: 0,
        };
      }
      if (joined.includes('terminal wait') && joined.includes('tui-idle')) {
        return { stdout: JSON.stringify({ ok: true, result: {} }), stderr: '', status: 0 };
      }
      return { stdout: JSON.stringify({ ok: false, error: { message: 'unexpected' } }), stderr: '', status: 1 };
    });

    const result = waitForSmokeAgentCompletion('term_long_prompt_short_output', {
      runner: runner as never,
      now: () => now,
      deadlineMs: 5_000,
      preSendBaselineText: 'idle',
      preSendCursor: 1,
      sentPrompt,
      sleepMs: (ms) => {
        now += ms;
      },
    });
    expect(result.ok).toBe(true);
    expect(result.agentActivityObserved).toBe(true);
  });

  it('does not complete during initial idle before delayed first output', () => {
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
      if (joined.includes('terminal wait') && joined.includes('tui-idle')) {
        return { stdout: JSON.stringify({ ok: true, result: {} }), stderr: '', status: 0 };
      }
      return { stdout: JSON.stringify({ ok: false, error: { message: 'unexpected' } }), stderr: '', status: 1 };
    });

    const result = waitForSmokeAgentCompletion('term_delayed', {
      runner: runner as never,
      now: () => now,
      deadlineMs: 5_000,
      preSendBaselineText: 'idle',
      preSendCursor: 1,
      sentPrompt,
      sleepMs: (ms) => {
        now += ms;
      },
    });
    expect(result.ok).toBe(true);
    expect(result.agentActivityObserved).toBe(true);
    expect(readCalls).toBeGreaterThanOrEqual(4);
  });

  it('classifies started-without-report as missing_agent_report after idle', () => {
    let now = 0;
    let readCalls = 0;
    const sentPrompt = 'run smoke now';
    const runner = vi.fn((executable: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('terminal read')) {
        readCalls += 1;
        if (readCalls === 1) {
          return { stdout: JSON.stringify({ ok: true, result: { lines: ['scenario output only'], nextCursor: 2 } }), stderr: '', status: 0 };
        }
        return { stdout: JSON.stringify({ ok: true, result: { lines: ['more scenario output'], nextCursor: 3 } }), stderr: '', status: 0 };
      }
      if (joined.includes('terminal wait') && joined.includes('tui-idle')) {
        return { stdout: JSON.stringify({ ok: true, result: {} }), stderr: '', status: 0 };
      }
      return { stdout: JSON.stringify({ ok: false, error: { message: 'unexpected' } }), stderr: '', status: 1 };
    });

    const waitResult = waitForSmokeAgentCompletion('term_started_no_report', {
      runner: runner as never,
      now: () => now,
      deadlineMs: 5_000,
      preSendBaselineText: 'idle',
      preSendCursor: 1,
      sentPrompt,
      sleepMs: (ms) => {
        now += ms;
      },
    });
    expect(waitResult.ok).toBe(true);
    expect(waitResult.agentActivityObserved).toBe(true);
    expect(classifySmokeNonPassCause({
      partial: null,
      agentActivityObserved: waitResult.agentActivityObserved,
      agentCompleted: true,
    })).toBe('missing_agent_report');
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

