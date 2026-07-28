import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  closeOrcaTerminal,
  createOrcaTerminal,
  probeOrcaWorktree,
  resolveOrcaExecutable,
  runOrcaJson,
} from './lib/orca-cli.ts';
import {
  buildSmokeAgentPrompt,
  detectTrackedImplementationMutation,
  evaluateReadyForReviewCombinations,
  evaluateWorkerSmokeGate,
  extractSmokeReportsFromComments,
  findCurrentHeadSmokePass,
  formatSmokeReportComment,
  normalizeSmokeReport,
  parseSmokeAgentReport,
  SMOKE_REPORT_MARKER,
} from './lib/worker-smoke-core.ts';
import { checkSmokeTestPlan, resolveSmokeRequirement } from './draft-discipline.mjs';

const fixtureRoot = join(import.meta.dirname, '..', 'tests', 'fixtures', 'worker-smoke');
const headA = 'a'.repeat(40);
const headB = 'b'.repeat(40);

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
    const partial = parseSmokeAgentReport(passBody);
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
    scenarios: [{
      action: 'run helper',
      expected: 'prints ok',
      observed: 'ok',
      outcome: 'pass',
    }],
    limitations: [],
    trackedFilesUnmodified: true,
    terminalCleanup: 'closed_owned_handle',
    environmentNotes: [],
  });

  it('allows only current-head smoke PASS plus green CI', () => {
    const allowed = evaluateWorkerSmokeGate({
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
      issueBody,
      prNumber: 7,
      headSha: headA,
      prComments: [{ body: passComment }],
      ciGreen: false,
      orcaWorktreeOk: true,
      ownedTerminalClosed: true,
    }).allowed).toBe(false);

    expect(findCurrentHeadSmokePass([{ body: passComment }], 7, headB)).toBeNull();
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
