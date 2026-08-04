import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcessSync } from './kernel/subprocess.js';
import {
  parsePackGptReviewArgs,
  runPackGptReviewCommand,
} from './pack-gpt-review.js';
import { isRetryablePackReviewZeroSendCollision, startPackReview } from './pack-review-runner.js';
import {
  createPackReviewRun,
  getPackReviewRun,
  setPackReviewRunTerminal,
  terminalizePackReviewStaleRun,
  updatePackReviewRun,
  type PackReviewGptRoundRecord,
} from './lib/pack-review-run-store.js';
import { acquireReviewStartClaim } from './lib/review-start-claim-store.js';
import { PACK_REVIEW_BOUND_REVIEWER_ENV } from './lib/resolve-pack-reviewer.js';

const repoRoot = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const tempRoots: string[] = [];
const originalEnv = { ...process.env };

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function harnessEnv(storeRoot: string, capture: string): void {
  process.env.OPK_VITEST_HARNESS = '1';
  process.env.PACK_REVIEWER = 'gpt';
  process.env.PACK_REVIEW_GITHUB_REVIEW_CAPTURE_FILE = capture;
  process.env.AO_BASE_DIR = path.join(storeRoot, 'ao-base');
}

function cleanTerminalPayload(): string {
  return JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] });
}

function successfulCleanReviewPayload(invocationId: string): string {
  return terminalTurnPayload({
    state: 'ok',
    cause: 'completed_page_only',
    sendCount: 1,
    invocationId,
  }) + String.fromCharCode(10) + cleanTerminalPayload();
}

function terminalTurnPayload(input: {
  state: string;
  cause: string;
  sendCount?: number;
  invocationId?: string;
}): string {
  return JSON.stringify({
    schema: 'turn-result/v1',
    state: input.state,
    scope: input.state === 'profile_busy' ? 'profile' : 'invocation',
    cause: input.cause,
    invocation_id: input.invocationId ?? `inv-${input.state}`,
    send_count: input.sendCount ?? 0,
  });
}

function findingsPayload(title: string): string {
  return terminalTurnPayload({
    state: 'ok',
    cause: 'completed_page_only',
    sendCount: 1,
    invocationId: `inv-${title}`,
  }) + String.fromCharCode(10) + JSON.stringify({
    verdict: 'findings',
    findingCount: 1,
    findings: [{ title, body: 'body-' + title, severity: 'blocking' }],
  });
}

function canonicalCommandRunner(storeRoot: string, overrides: Record<string, unknown> = {}) {
  return (input: Parameters<typeof startPackReview>[0]) => startPackReview({
    ...input,
    projectId: 'orchestrator-pack',
    storeRoot,
    sourceRepoRoot: repoRoot,
    fixtureCurrentPrHeadSha: HEAD_A,
    fixturePrState: 'OPEN',
    fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
    fixturePostReviewHeadSha: HEAD_A,
    fixtureReviewStdout: cleanTerminalPayload(),
    fixtureReviewerLayerOverrides: { Process: 'codex', User: 'claude' },
    fixtureEmulateWin32Selector: true,
    ...overrides,
  });
}

function engagementCount(pathValue: string): number {
  if (!existsSync(pathValue)) return 0;
  return readFileSync(pathValue, 'utf8').trim().split('\n').filter(Boolean).length;
}

function writeClosedPrGhFixture(binRoot: string): void {
  if (process.platform === 'win32') {
    writeFileSync(path.join(binRoot, 'gh.cmd'), [
      '@echo off',
      'if "%1"=="repo" (',
      '  echo chetwerikoff/orchestrator-pack',
      '  exit /b 0',
      ')',
      'if "%1"=="pr" (',
      `  echo ${HEAD_A} CLOSED`,
      '  exit /b 0',
      ')',
      'exit /b 2',
      '',
    ].join('\r\n'), 'utf8');
    return;
  }

  const fixture = path.join(binRoot, 'gh');
  writeFileSync(fixture, [
    '#!/usr/bin/env node',
    "const args = process.argv.slice(2);",
    "if (args[0] === 'repo' && args[1] === 'view') {",
    "  process.stdout.write('chetwerikoff/orchestrator-pack\\n');",
    "} else if (args[0] === 'pr' && args[1] === 'view') {",
    `  process.stdout.write('${HEAD_A} CLOSED\\n');`,
    '} else {',
    '  process.exitCode = 2;',
    '}',
    '',
  ].join('\n'), 'utf8');
  chmodSync(fixture, 0o755);
}

afterEach(() => {
  process.env = { ...originalEnv };
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('GPT zero-send collision retry tuples (Issue #1276 AC20)', () => {
  const failedTurn = (state: string, cause: string, sendCount: number) => ({
    outcome: 'exit' as const,
    ok: false,
    exitCode: 13,
    signal: null,
    stdout: JSON.stringify({
      schema: 'turn-result/v1',
      state,
      scope: state === 'profile_busy' ? 'profile' : 'invocation',
      cause,
      invocation_id: 'collision-test',
      send_count: sendCount,
    }),
    stderr: '',
    timedOut: false,
    cancelled: false,
  });

  it('retries canonical profile and composer zero-send collisions only', () => {
    expect(isRetryablePackReviewZeroSendCollision(
      failedTurn('profile_busy', 'profile_busy', 0),
    )).toBe(true);
    expect(isRetryablePackReviewZeroSendCollision(
      failedTurn('ui_contract_mismatch', 'composer_unavailable', 0),
    )).toBe(true);
    expect(isRetryablePackReviewZeroSendCollision(
      failedTurn('profile_busy', 'profile_busy', 1),
    )).toBe(false);
    expect(isRetryablePackReviewZeroSendCollision(
      failedTurn('ui_contract_mismatch', 'composer_unavailable', 1),
    )).toBe(false);
  });
});

describe('GPT stale-head guard (Issue #1031 AC10)', () => {
  it('rejects a GPT payload when PR head advanced before publication', async () => {
    const storeRoot = tempRoot('opk-gpt-stale-head-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);

    const result = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: repoRoot,
      prNumber: 1031,
      headSha: HEAD_A,
      fixturePostReviewHeadSha: HEAD_B,
      claimMode: 'preacquired',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureReviewStdout: cleanTerminalPayload(),
    });

    expect(result.ok).toBe(false);
    expect(String(result.reason)).toContain('head changed after reviewer returned');
    expect(() => readFileSync(capture, 'utf8')).toThrow();
  });

  it('runs stale-head guard when User layer selects gpt but Process still has codex', async () => {
    const storeRoot = tempRoot('opk-gpt-stale-user-layer-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.PACK_REVIEWER = 'codex';

    const result = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: repoRoot,
      prNumber: 1031,
      headSha: HEAD_A,
      fixturePostReviewHeadSha: HEAD_B,
      claimMode: 'preacquired',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureReviewStdout: cleanTerminalPayload(),
      fixtureReviewerLayerOverrides: { Process: 'codex', User: 'gpt' },
      fixtureEmulateWin32Selector: true,
    });

    expect(result.ok).toBe(false);
    expect(String(result.reason)).toContain('head changed after reviewer returned');
    expect(() => readFileSync(capture, 'utf8')).toThrow();
  });

  it('publishes GPT clean payload through the common runner path when head is unchanged', async () => {
    const storeRoot = tempRoot('opk-gpt-clean-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);

    const result = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: repoRoot,
      prNumber: 1031,
      headSha: HEAD_A,
      fixturePostReviewHeadSha: HEAD_A,
      claimMode: 'preacquired',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureReviewStdout: cleanTerminalPayload(),
    });

    expect(result.ok).toBe(true);
    const posted = JSON.parse(readFileSync(capture, 'utf8')) as { event: string };
    expect(posted.event).toBe('COMMENT');
  });
});

describe('GPT failure matrix (Issue #1031 AC5)', () => {
  const failureCases = [
    { name: 'malformed stdout', stdout: 'not-json-at-all', exitCode: 0 },
    { name: 'nonzero reviewer exit', stdout: '', exitCode: 1 },
    { name: 'reviewer timeout', timedOut: true as const },
    { name: 'stale head after review', postHead: HEAD_B, stdout: cleanTerminalPayload(), exitCode: 0 },
  ];

  for (const failureCase of failureCases) {
    it(`fails closed for ${failureCase.name} without Codex failover`, async () => {
      const storeRoot = tempRoot(`opk-gpt-fail-${failureCase.name}-`);
      const capture = path.join(storeRoot, 'github-review.json');
      const invocationLog = path.join(storeRoot, 'invocations.jsonl');
      harnessEnv(storeRoot, capture);
      process.env.PACK_REVIEW_RUNNER_INVOCATION_LOG = invocationLog;

      const result = await startPackReview({
        projectId: 'orchestrator-pack',
        storeRoot,
        sourceRepoRoot: repoRoot,
        prNumber: 1031,
        headSha: HEAD_A,
        fixturePostReviewHeadSha: failureCase.postHead ?? HEAD_A,
        claimMode: 'preacquired',
        fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
        fixtureReviewStdout: failureCase.timedOut ? undefined : failureCase.stdout,
        fixtureReviewExitCode: failureCase.exitCode,
        fixtureReviewTimedOut: failureCase.timedOut,
      });

      expect(result.ok).toBe(false);
      expect(process.env.PACK_REVIEWER).toBe('gpt');
      expect(() => readFileSync(capture, 'utf8')).toThrow();
      expect(process.env.PACK_REVIEWER).toBe('gpt');

      const lines = readFileSync(invocationLog, 'utf8').trim().split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        const entry = JSON.parse(line) as { reviewer?: string; args?: string[] };
        expect(entry.reviewer).toBe('gpt');
        expect(entry.args?.join(' ')).toContain('invoke-pack-review.ps1');
        expect(entry.args?.join(' ')).not.toContain('run-pack-review.ps1');
      }
    });
  }
});

describe('GPT claim race (Issue #1031 AC11)', () => {
  it('records exactly one GPT reviewer engagement for a claimed run', async () => {
    const storeRoot = tempRoot('opk-gpt-race-');
    const capture = path.join(storeRoot, 'github-review.json');
    const engagement = path.join(storeRoot, 'gpt-engagements.jsonl');
    harnessEnv(storeRoot, capture);
    process.env.PACK_REVIEW_RUNNER_GPT_ENGAGEMENT_FILE = engagement;

    const result = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: repoRoot,
      prNumber: 1031,
      headSha: HEAD_A,
      fixturePostReviewHeadSha: HEAD_A,
      claimMode: 'preacquired',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureReviewStdout: cleanTerminalPayload(),
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const lines = readFileSync(engagement, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  it('admits only one concurrent GPT start for the same PR head', async () => {
    const storeRoot = tempRoot('opk-gpt-concurrent-');
    const capture = path.join(storeRoot, 'github-review.json');
    const engagement = path.join(storeRoot, 'gpt-engagements.jsonl');
    harnessEnv(storeRoot, capture);
    process.env.PACK_REVIEW_RUNNER_GPT_ENGAGEMENT_FILE = engagement;

    const shared = {
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: repoRoot,
      prNumber: 1031,
      headSha: HEAD_A,
      fixturePostReviewHeadSha: HEAD_A,
      claimMode: 'acquire' as const,
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureReviewStdout: cleanTerminalPayload(),
    };

    const [first, second] = await Promise.all([
      startPackReview(shared),
      startPackReview(shared),
    ]);

    const successes = [first, second].filter((result) => result.ok);
    expect(successes).toHaveLength(1);
    const blocked = [first, second].filter((result) => !result.ok || result.reused);
    expect(blocked.length).toBeGreaterThan(0);
    const lines = readFileSync(engagement, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
  });
});

describe('GPT crash/browser ambiguity (Issue #1031 AC12)', () => {
  it('does not publish GitHub review or emit clean terminal success on ambiguous reviewer failure', async () => {
    const storeRoot = tempRoot('opk-gpt-crash-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);

    const result = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: repoRoot,
      prNumber: 1031,
      headSha: HEAD_A,
      claimMode: 'preacquired',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureReviewExitCode: 1,
      fixtureReviewStdout: '',
    });

    expect(result.ok).toBe(false);
    expect(result.status).not.toBe('commented');
    expect(() => readFileSync(capture, 'utf8')).toThrow();
    expect(process.env.PACK_REVIEWER).toBe('gpt');
  });

  it('does not publish when reviewer times out before a valid terminal payload exists', async () => {
    const storeRoot = tempRoot('opk-gpt-timeout-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);

    const result = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: repoRoot,
      prNumber: 1031,
      headSha: HEAD_A,
      claimMode: 'preacquired',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureReviewTimedOut: true,
    });

    expect(result.ok).toBe(false);
    expect(() => readFileSync(capture, 'utf8')).toThrow();
  });
});

describe('canonical Browser-GPT PR command (Issue #1111)', () => {
  it('accepts PR number only and rejects caller-supplied head SHA', () => {
    expect(parsePackGptReviewArgs(['--pr-number', '1111'])).toEqual({
      prNumber: 1111,
      timeoutSeconds: undefined,
    });
    expect(() => parsePackGptReviewArgs([])).toThrow('--pr-number is required');
    expect(() => parsePackGptReviewArgs([
      '--pr-number', '1111', '--head-sha', HEAD_A,
    ])).toThrow("unknown argument '--head-sha'");
  });

  it('keeps the documented npm invocation stdout to one JSON object', () => {
    const fixtureRoot = tempRoot('opk-issue-1111-npm-stdout-');
    const commandRoot = tempRoot('opk-issue-1111-gh-bin-');
    writeClosedPrGhFixture(commandRoot);
    const childEnv = {
      ...process.env,
      AO_BASE_DIR: path.join(fixtureRoot, 'ao-base'),
      PATH: `${commandRoot}${path.delimiter}${process.env.PATH ?? ''}`,
      npm_config_update_notifier: 'false',
    };
    delete childEnv.OPK_VITEST_HARNESS;

    const result = runProcessSync({
      command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
      args: ['run', '--silent', 'pack-gpt-review', '--', '--pr-number', '1111'],
      cwd: repoRoot,
      encoding: 'utf8',
      env: childEnv,
    });

    expect(result.exitCode, result.stderr).toBe(1);
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      ok: false,
      outcome: 'review_target_unavailable',
      prNumber: 1111,
    });
    expect(result.stdout).not.toContain('> orchestrator-pack@');
    expect(result.stdout).not.toContain('> npm run check:node-major');
  });

  it('resolves a PR-only target, binds GPT above persistent layers, and emits one start indication', async () => {
    const storeRoot = tempRoot('opk-issue-1111-fresh-');
    const capture = path.join(storeRoot, 'github-review.json');
    const engagement = path.join(storeRoot, 'gpt-engagements.jsonl');
    const invocationLog = path.join(storeRoot, 'invocations.jsonl');
    harnessEnv(storeRoot, capture);
    process.env.PACK_REVIEWER = 'codex';
    process.env.PACK_REVIEW_RUNNER_GPT_ENGAGEMENT_FILE = engagement;
    process.env.PACK_REVIEW_RUNNER_INVOCATION_LOG = invocationLog;
    const stderr: string[] = [];

    const execution = await runPackGptReviewCommand({ prNumber: 1111, timeoutSeconds: 37 }, {
      env: process.env,
      stderr: { write: (chunk) => stderr.push(chunk) },
      startReview: canonicalCommandRunner(storeRoot),
    });

    expect(execution.exitCode).toBe(0);
    expect(execution.result).toMatchObject({ ok: true, created: true });
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(new RegExp(
      `started pr=1111 head=${HEAD_A} run=prr-[a-z0-9]+ timeout_seconds=37`,
    ));
    expect(JSON.parse(readFileSync(invocationLog, 'utf8').trim()).reviewer).toBe('gpt');
    expect(readFileSync(engagement, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(process.env.PACK_REVIEWER).toBe('codex');
    expect(process.env[PACK_REVIEW_BOUND_REVIEWER_ENV]).toBeUndefined();
  });

  it('maps same-head active reuse to non-zero review_not_started without GPT engagement', async () => {
    const storeRoot = tempRoot('opk-issue-1111-active-reuse-');
    const capture = path.join(storeRoot, 'github-review.json');
    const engagement = path.join(storeRoot, 'gpt-engagements.jsonl');
    harnessEnv(storeRoot, capture);
    process.env.PACK_REVIEW_RUNNER_GPT_ENGAGEMENT_FILE = engagement;
    createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1111,
      headSha: HEAD_A,
      linkedSessionId: 'fixture-active-run',
      startReason: 'fixture-active-run',
      surface: 'fixture-active-run',
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      canonicalRepository: 'chetwerikoff/orchestrator-pack',
    });
    const stderr: string[] = [];

    const execution = await runPackGptReviewCommand({ prNumber: 1111 }, {
      env: process.env,
      stderr: { write: (chunk) => stderr.push(chunk) },
      startReview: canonicalCommandRunner(storeRoot),
    });

    expect(execution.exitCode).toBe(1);
    expect(execution.result).toMatchObject({
      outcome: 'review_not_started',
      reason: 'review_not_started',
      runnerReason: 'active_run_exists',
      prNumber: 1111,
      headSha: HEAD_A,
    });
    expect(stderr).toHaveLength(0);
    expect(engagementCount(engagement)).toBe(0);
  });

  it('maps same-head terminal reuse to non-zero review_not_started without another GPT send', async () => {
    const storeRoot = tempRoot('opk-issue-1111-reuse-');
    const capture = path.join(storeRoot, 'github-review.json');
    const engagement = path.join(storeRoot, 'gpt-engagements.jsonl');
    harnessEnv(storeRoot, capture);
    process.env.PACK_REVIEW_RUNNER_GPT_ENGAGEMENT_FILE = engagement;

    const first = await runPackGptReviewCommand({ prNumber: 1111 }, {
      env: process.env,
      stderr: { write: () => undefined },
      startReview: canonicalCommandRunner(storeRoot),
    });
    const secondStderr: string[] = [];
    const second = await runPackGptReviewCommand({ prNumber: 1111 }, {
      env: process.env,
      stderr: { write: (chunk) => secondStderr.push(chunk) },
      startReview: canonicalCommandRunner(storeRoot),
    });

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(1);
    expect(second.result).toMatchObject({
      outcome: 'review_not_started',
      reason: 'review_not_started',
      runnerReason: 'terminal_run_exists',
      prNumber: 1111,
      headSha: HEAD_A,
    });
    expect(secondStderr).toHaveLength(0);
    expect(engagementCount(engagement)).toBe(1);
  });

  it('maps start-claim refusal to non-zero review_not_started without GPT engagement', async () => {
    const storeRoot = tempRoot('opk-issue-1111-claim-refusal-');
    const capture = path.join(storeRoot, 'github-review.json');
    const engagement = path.join(storeRoot, 'gpt-engagements.jsonl');
    harnessEnv(storeRoot, capture);
    process.env.PACK_REVIEW_RUNNER_GPT_ENGAGEMENT_FILE = engagement;
    const claim = acquireReviewStartClaim({
      projectId: 'orchestrator-pack',
      prNumber: 1111,
      headSha: HEAD_A,
      surface: 'fixture-existing-claim',
      startReason: 'fixture-existing-claim',
      reviewRuns: [],
    });
    expect(claim.acquired, JSON.stringify(claim)).toBe(true);
    const stderr: string[] = [];

    const execution = await runPackGptReviewCommand({ prNumber: 1111 }, {
      env: process.env,
      stderr: { write: (chunk) => stderr.push(chunk) },
      startReview: canonicalCommandRunner(storeRoot),
    });

    expect(execution.exitCode).toBe(1);
    expect(execution.result).toMatchObject({
      outcome: 'review_not_started',
      reason: 'review_not_started',
      runnerReason: 'claimed',
      prNumber: 1111,
      headSha: HEAD_A,
    });
    expect(stderr).toHaveLength(0);
    expect(engagementCount(engagement)).toBe(0);
  });

  it('fails a closed PR before reviewer engagement and names timeout as non-success', async () => {
    const closedRoot = tempRoot('opk-issue-1111-closed-');
    const closedCapture = path.join(closedRoot, 'github-review.json');
    const engagement = path.join(closedRoot, 'gpt-engagements.jsonl');
    harnessEnv(closedRoot, closedCapture);
    process.env.PACK_REVIEW_RUNNER_GPT_ENGAGEMENT_FILE = engagement;

    const closed = await runPackGptReviewCommand({ prNumber: 1111 }, {
      env: process.env,
      stderr: { write: () => undefined },
      startReview: canonicalCommandRunner(closedRoot, { fixturePrState: 'CLOSED' }),
    });

    expect(closed.exitCode).toBe(1);
    expect(closed.result.outcome).toBe('review_target_unavailable');
    expect(String(closed.result.reason)).toContain('PR #1111 is not open');
    expect(existsSync(engagement)).toBe(false);

    const timeoutRoot = tempRoot('opk-issue-1111-timeout-');
    const timeoutCapture = path.join(timeoutRoot, 'github-review.json');
    harnessEnv(timeoutRoot, timeoutCapture);
    const stderr: string[] = [];
    const timedOut = await runPackGptReviewCommand({ prNumber: 1111, timeoutSeconds: 2 }, {
      env: process.env,
      stderr: { write: (chunk) => stderr.push(chunk) },
      startReview: canonicalCommandRunner(timeoutRoot, {
        fixtureReviewStdout: undefined,
        fixtureReviewTimedOut: true,
      }),
    });

    expect(timedOut.exitCode).toBe(1);
    expect(timedOut.result).toMatchObject({ created: true, status: 'timed_out' });
    expect(String(timedOut.result.reason)).toContain('reviewer process timed out');
    expect(stderr).toHaveLength(1);
  });
});


describe('GPT plural source round (Issue #1276)', () => {
  it('freezes three slots and settles every source before publication', async () => {
    const storeRoot = tempRoot('opk-gpt-plural-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.AO_ISSUE_NUMBER = '1276';
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;

    const result = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: repoRoot,
      prNumber: 1276,
      headSha: HEAD_A,
      fixtureCurrentPrHeadSha: HEAD_A,
      fixturePrState: 'OPEN',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixturePostReviewHeadSha: HEAD_A,
      fixtureReviewStdout: cleanTerminalPayload(),
      fixtureIssueBody: '```complexity-tier\ntier: T1\n```',
      claimMode: 'preacquired',
    });

    expect(result.ok).toBe(true);
    const run = getPackReviewRun(String(result.runId), { projectId: 'orchestrator-pack', storeRoot });
    expect(run?.reviewRound).toMatchObject({ tier: 'T1', roundOrdinal: 1, cardinality: 3 });
    expect(run?.reviewRound?.sourceSlots).toHaveLength(3);
    expect(run?.reviewRound?.sourceSlots.every((slot) => slot.lifecycle === 'terminal')).toBe(true);
  });
});

describe('Issue #1276 deterministic smoke fixtures', () => {
  function pluralStart(
    storeRoot: string,
    capture: string,
    overrides: Record<string, unknown> = {},
  ): Parameters<typeof startPackReview>[0] {
    return {
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: repoRoot,
      prNumber: 1276,
      headSha: HEAD_A,
      fixtureCurrentPrHeadSha: HEAD_A,
      fixturePrState: 'OPEN',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixturePostReviewHeadSha: HEAD_A,
      fixtureReviewStdout: cleanTerminalPayload(),
      fixtureIssueBody: '```complexity-tier\ntier: T1\n```',
      claimMode: 'preacquired',
      ...overrides,
    };
  }

  it('fails plural fixed-chat configuration before invoking any source', async () => {
    const storeRoot = tempRoot('opk-gpt-fixed-chat-');
    const capture = path.join(storeRoot, 'github-review.json');
    const invocationLog = path.join(storeRoot, 'invocations.jsonl');
    harnessEnv(storeRoot, capture);
    process.env.AO_ISSUE_NUMBER = '1276';
    delete process.env.PACK_GPT_BROWSER_PROJECT_URL;
    process.env.PACK_GPT_BROWSER_CHAT_URL = 'https://chatgpt.com/c/fixed';
    process.env.PACK_REVIEW_RUNNER_INVOCATION_LOG = invocationLog;

    await expect(startPackReview(pluralStart(storeRoot, capture))).rejects.toThrow(/plural GPT review requires/);
    expect(engagementCount(invocationLog)).toBe(0);
    expect(() => readFileSync(capture, 'utf8')).toThrow();
  });

  it('rejects terminal-evidence-free clean payloads and keeps sibling outcomes', async () => {
    const storeRoot = tempRoot('opk-gpt-prelaunch-failure-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.AO_ISSUE_NUMBER = '1276';
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;

    const result = await startPackReview(pluralStart(storeRoot, capture, {
      fixtureReviewBySourceSlot: {
        'source-01': [{ stdout: cleanTerminalPayload() }],
        'source-02': [{ stdout: terminalTurnPayload({ state: 'driver_error', cause: 'rate_limit_detected' }), exitCode: 13 }],
        'source-03': [{ stdout: cleanTerminalPayload() }],
      },
    }));

    const run = getPackReviewRun(String(result.runId), { projectId: 'orchestrator-pack', storeRoot });
    expect(run?.reviewRound?.sourceSlots.map((slot) => slot.terminalClass)).toEqual([
      'reviewer_output_malformed',
      'driver_error:rate_limit_detected',
      'reviewer_output_malformed',
    ]);
    expect(run?.reviewRound?.sourceSlots.map((slot) => slot.attemptOrdinal)).toEqual([1, 1, 1]);
    expect(run?.reviewRound?.sourceSlots).toHaveLength(3);
  });

  it('does not relay or publish while an earlier source is terminal and siblings are pending', async () => {
    const storeRoot = tempRoot('opk-gpt-no-early-relay-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.AO_ISSUE_NUMBER = '1276';
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;
    const statusStates: string[] = [];
    const notifications: string[] = [];
    const earlyObservations: string[] = [];

    const result = await startPackReview(pluralStart(storeRoot, capture, {
      fixtureRequiredStatusWriter: async (request) => {
        statusStates.push(request.state);
      },
      fixtureWorkerNotifier: async (request) => {
        notifications.push(request.message);
        return { state: 'delivered', reason: 'fixture' };
      },
      fixtureAfterGptSourceSlotTerminal: async ({ slotId, round }) => {
        earlyObservations.push(`${slotId}:${round.sourceSlots.filter((slot) => slot.lifecycle === 'terminal').length}`);
        expect(statusStates).toEqual(['pending']);
        expect(notifications).toHaveLength(0);
      },
      fixtureReviewBySourceSlot: {
        'source-01': [{ stdout: successfulCleanReviewPayload('inv-source-01') }],
        'source-02': [{ stdout: successfulCleanReviewPayload('inv-source-02') }],
        'source-03': [{ stdout: successfulCleanReviewPayload('inv-source-03') }],
      },
    }));

    expect(result.ok).toBe(true);
    expect(earlyObservations).toEqual(['source-01:1', 'source-02:2', 'source-03:3']);
    expect(statusStates).toHaveLength(2);
    expect(notifications).toHaveLength(1);
  });

  it('retains disjoint source findings with source-slot attribution', async () => {
    const storeRoot = tempRoot('opk-gpt-finding-union-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.AO_ISSUE_NUMBER = '1276';
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;

    const result = await startPackReview(pluralStart(storeRoot, capture, {
      fixtureReviewBySourceSlot: {
        'source-01': [{ stdout: findingsPayload('finding-01') }],
        'source-02': [{ stdout: findingsPayload('finding-02') }],
        'source-03': [{ stdout: findingsPayload('finding-03') }],
      },
    }));

    const run = getPackReviewRun(String(result.runId), { projectId: 'orchestrator-pack', storeRoot });
    const sourceFindings = run?.reviewRound?.sourceSlots
      .flatMap((slot) => (slot.payload as { findings?: Array<{ title?: string }> } | undefined)?.findings ?? []);
    expect(sourceFindings?.map((finding) => finding.title)).toEqual(['finding-01', 'finding-02', 'finding-03']);
    expect(readFileSync(capture, 'utf8')).toContain('finding-01');
    expect(readFileSync(capture, 'utf8')).toContain('finding-02');
    expect(readFileSync(capture, 'utf8')).toContain('finding-03');
  });

  it('exhausts one zero-send collision retry without publishing clean', async () => {
    const storeRoot = tempRoot('opk-gpt-zero-send-exhausted-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.AO_ISSUE_NUMBER = '1276';
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;

    const result = await startPackReview(pluralStart(storeRoot, capture, {
      fixtureReviewBySourceSlot: {
        'source-01': [{ stdout: successfulCleanReviewPayload('inv-source-01') }],
        'source-02': [
          { stdout: terminalTurnPayload({ state: 'profile_busy', cause: 'profile_busy' }), exitCode: 13 },
          { stdout: terminalTurnPayload({ state: 'profile_busy', cause: 'profile_busy' }), exitCode: 13 },
        ],
        'source-03': [{ stdout: successfulCleanReviewPayload('inv-source-03') }],
      },
    }));

    const run = getPackReviewRun(String(result.runId), { projectId: 'orchestrator-pack', storeRoot });
    const exhausted = run?.reviewRound?.sourceSlots.find((slot) => slot.slotId === 'source-02');
    expect(exhausted).toMatchObject({
      lifecycle: 'terminal',
      attemptOrdinal: 2,
      terminalClass: 'explicit_refusal:zero_send_collision_exhausted',
    });
    expect(run?.reviewVerdict).toBe('findings');
    expect(readFileSync(capture, 'utf8')).toContain('zero_send_collision_exhausted');
  });

  it('keeps a possible-delivery source non-retryable and non-clean', async () => {
    const storeRoot = tempRoot('opk-gpt-possible-delivery-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.AO_ISSUE_NUMBER = '1276';
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;

    const result = await startPackReview(pluralStart(storeRoot, capture, {
      fixtureReviewBySourceSlot: {
        'source-01': [{ stdout: successfulCleanReviewPayload('inv-source-01') }],
        'source-02': [{ stdout: terminalTurnPayload({ state: 'driver_error', cause: 'browser_lost', sendCount: 1 }), exitCode: 13 }],
        'source-03': [{ stdout: successfulCleanReviewPayload('inv-source-03') }],
      },
    }));

    const run = getPackReviewRun(String(result.runId), { projectId: 'orchestrator-pack', storeRoot });
    const uncertain = run?.reviewRound?.sourceSlots.find((slot) => slot.slotId === 'source-02');
    expect(uncertain?.terminalClass).toBe('possible_delivery');
    expect(uncertain?.attemptOrdinal).toBe(1);
    expect(run?.reviewVerdict).toBe('findings');
  });

  it('terminalizes launched slots as possible-delivery evidence on stale recovery', () => {
    const storeRoot = tempRoot('opk-gpt-stale-round-');
    const created = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1276,
      headSha: HEAD_A,
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
    });
    const reviewRound = {
      schema: 'pack-review-gpt-round/v1' as const,
      reviewer: 'gpt' as const,
      tier: 'T1' as const,
      roundOrdinal: 1,
      cardinality: 3,
      issueNumber: 1276,
      boundIssueSnapshotDigest: 'fixture-digest',
      sourceSlots: [
        terminalStoredSlot({ slotId: 'source-01', ordinal: 1, lifecycle: 'planned' }),
        { slotId: 'source-02', ordinal: 2, lifecycle: 'invocation_started' as const, invocationId: 'inv-02' },
        { slotId: 'source-03', ordinal: 3, lifecycle: 'planned' as const },
      ],
    };
    updatePackReviewRun(created.run.id, { runnerPid: 999999, reviewRound }, { projectId: 'orchestrator-pack', storeRoot });

    const recovered = terminalizePackReviewStaleRun(created.run.id, {
      projectId: 'orchestrator-pack',
      storeRoot,
      now: new Date(Date.now() + 11 * 60_000),
    });

    expect(recovered.changed).toBe(true);
    expect(recovered.run.status).toBe('failed');
    expect(recovered.run.reviewRound?.sourceSlots[1]).toMatchObject({
      lifecycle: 'terminal',
      terminalClass: 'possible_delivery/missing_result',
      terminalResult: { noResend: true },
    });
    expect(recovered.run.reviewRound?.sourceSlots[2]).toMatchObject({
      lifecycle: 'terminal',
      terminalClass: 'pre_launch_interrupted',
      terminalResult: { noResend: true },
    });
  });
});

function storedTerminalTurnResult(
  invocationId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: 'turn-result/v1',
    state: 'ok',
    scope: 'invocation',
    cause: 'completed_page_only',
    invocation_id: invocationId,
    send_count: 1,
    ...overrides,
  };
}

function storedGptRound(): PackReviewGptRoundRecord {
  return {
    schema: 'pack-review-gpt-round/v1',
    reviewer: 'gpt',
    tier: 'T1',
    roundOrdinal: 1,
    cardinality: 3,
    issueNumber: 1276,
    boundIssueSnapshotDigest: 'fixture-digest',
    sourceSlots: Array.from({ length: 3 }, (_, index) => terminalStoredSlot({
      slotId: `source-${String(index + 1).padStart(2, '0')}`,
      ordinal: index + 1,
      lifecycle: 'planned',
    })),
  };
}

describe('GPT run-store source-slot identity validation (Issue #1276 scenario 23)', () => {
  it('rejects malformed source census on create, update, read, and terminal settlement', () => {
    const malformedCases: Array<{
      name: string;
      mutate: (round: PackReviewGptRoundRecord) => void;
    }> = [
      {
        name: 'missing slot',
        mutate: (round) => { round.sourceSlots.pop(); },
      },
      {
        name: 'duplicate slot identity',
        mutate: (round) => { round.sourceSlots[1] = { ...round.sourceSlots[0]! }; },
      },
      {
        name: 'missing slot id',
        mutate: (round) => { round.sourceSlots[1]!.slotId = ''; },
      },
      {
        name: 'unbound slot id',
        mutate: (round) => { round.sourceSlots[1]!.slotId = 'source-99'; },
      },
      {
        name: 'ordinal outside cardinality',
        mutate: (round) => { round.sourceSlots[1]!.ordinal = 4; },
      },
      {
        name: 'duplicate invocation identity',
        mutate: (round) => { round.sourceSlots[1]!.invocationId = round.sourceSlots[0]!.invocationId; },
      },
    ];

    for (const malformedCase of malformedCases) {
      const storeRoot = tempRoot(`opk-gpt-source-id-${malformedCase.name.replaceAll(' ', '-')}-`);
      const reviewRound = storedGptRound();
      malformedCase.mutate(reviewRound);
      expect(() => createPackReviewRun({
        projectId: 'orchestrator-pack',
        storeRoot,
        prNumber: 1276,
        headSha: HEAD_A,
        trustedPackRoot: repoRoot,
        sourceRepoRoot: repoRoot,
        reviewRound,
      }), malformedCase.name).toThrow(/reviewRound|sourceSlots|slotId|ordinal|invocationId/);
    }

    const storeRoot = tempRoot('opk-gpt-source-id-boundary-');
    const created = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1276,
      headSha: HEAD_A,
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      reviewRound: storedGptRound(),
    });

    const missingSlotRound = storedGptRound();
    missingSlotRound.sourceSlots.pop();
    expect(() => updatePackReviewRun(
      created.run.id,
      { reviewRound: missingSlotRound },
      { projectId: 'orchestrator-pack', storeRoot },
    )).toThrow(/sourceSlots cardinality mismatch/);

    const duplicateInvocationRound = storedGptRound();
    duplicateInvocationRound.sourceSlots[1]!.invocationId = duplicateInvocationRound.sourceSlots[0]!.invocationId;
    expect(() => setPackReviewRunTerminal(
      created.run.id,
      'commented',
      { reviewRound: duplicateInvocationRound },
      { projectId: 'orchestrator-pack', storeRoot },
    )).toThrow(/duplicate invocationId/);
    expect(getPackReviewRun(created.run.id, { projectId: 'orchestrator-pack', storeRoot })?.status).toBe('queued');

    const recordPath = path.join(storeRoot, 'runs', `${created.run.id}.json`);
    const raw = JSON.parse(readFileSync(recordPath, 'utf8')) as { reviewRound: PackReviewGptRoundRecord };
    raw.reviewRound.sourceSlots[1]!.slotId = 'source-99';
    writeFileSync(recordPath, `${JSON.stringify(raw)}\n`, 'utf8');
    expect(() => getPackReviewRun(created.run.id, {
      projectId: 'orchestrator-pack',
      storeRoot,
    })).toThrow(/not bound to ordinal/);
  });
});

function plannedStoredGptRound(): PackReviewGptRoundRecord {
  const round = storedGptRound();
  round.sourceSlots = round.sourceSlots.map((slot) => ({
    slotId: slot.slotId,
    ordinal: slot.ordinal,
    lifecycle: 'planned',
  }));
  return round;
}

function terminalStoredSlot(slot: PackReviewGptRoundRecord['sourceSlots'][number]) {
  const invocationId = `inv-${slot.ordinal}`;
  return {
    ...slot,
    lifecycle: 'terminal' as const,
    invocationId,
    attemptOrdinal: 1,
    terminalClass: 'complete_clean',
    terminalResult: storedTerminalTurnResult(invocationId),
    payload: { verdict: 'clean', findingCount: 0, findings: [] },
  };
}

function terminalClassOnlyStoredGptRound(): PackReviewGptRoundRecord {
  const round = plannedStoredGptRound();
  round.sourceSlots = round.sourceSlots.map((slot) => ({
    ...slot,
    lifecycle: 'terminal',
    invocationId: `inv-${slot.ordinal}`,
    attemptOrdinal: 1,
    terminalClass: 'complete_clean',
  }));
  return round;
}

describe('GPT run-store terminal evidence validation (Issue #1276 r08)', () => {
  it('rejects terminal-class-only slots across create, update, settlement, journal, and read', () => {
    const createRoot = tempRoot('opk-gpt-terminal-evidence-create-');
    expect(() => createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot: createRoot,
      prNumber: 1276,
      headSha: HEAD_A,
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      reviewRound: terminalClassOnlyStoredGptRound(),
    })).toThrow(/lacks valid terminalResult/);

    const storeRoot = tempRoot('opk-gpt-terminal-evidence-boundaries-');
    const created = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1276,
      headSha: HEAD_A,
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      reviewRound: plannedStoredGptRound(),
    });
    const terminalClassOnly = terminalClassOnlyStoredGptRound();

    expect(() => updatePackReviewRun(
      created.run.id,
      { reviewRound: terminalClassOnly },
      { projectId: 'orchestrator-pack', storeRoot },
    )).toThrow(/lacks valid terminalResult/);
    expect(() => setPackReviewRunTerminal(
      created.run.id,
      'commented',
      {
        reviewRound: terminalClassOnly,
        reviewVerdict: 'clean',
        findingCount: 0,
        findings: [],
      },
      { projectId: 'orchestrator-pack', storeRoot },
    )).toThrow(/lacks valid terminalResult/);
    expect(() => updatePackReviewRun(
      created.run.id,
      {
        reviewRound: terminalClassOnly,
        journalOutcome: {
          state: 'persisted',
          recordedAtUtc: new Date().toISOString(),
          reason: 'fixture',
          idempotencyKey: 'fixture-terminal-evidence',
          attempts: 1,
        },
      },
      { projectId: 'orchestrator-pack', storeRoot },
    )).toThrow(/lacks valid terminalResult/);
    expect(getPackReviewRun(created.run.id, { projectId: 'orchestrator-pack', storeRoot })?.status).toBe('queued');

    const readRoot = tempRoot('opk-gpt-terminal-evidence-read-');
    const readable = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot: readRoot,
      prNumber: 1276,
      headSha: HEAD_A,
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      reviewRound: storedGptRound(),
    });
    const recordPath = path.join(readRoot, 'runs', `${readable.run.id}.json`);
    const raw = JSON.parse(readFileSync(recordPath, 'utf8')) as { reviewRound: PackReviewGptRoundRecord };
    delete raw.reviewRound.sourceSlots[0]!.terminalResult;
    writeFileSync(recordPath, `${JSON.stringify(raw)}\n`, 'utf8');
    expect(() => getPackReviewRun(readable.run.id, {
      projectId: 'orchestrator-pack',
      storeRoot: readRoot,
    })).toThrow(/lacks valid terminalResult/);
  });

  it('rejects malformed and class-inconsistent terminal evidence', () => {
    const malformedCases: Array<{
      name: string;
      mutate: (round: PackReviewGptRoundRecord) => void;
    }> = [
      {
        name: 'malformed turn result',
        mutate: (round) => {
          round.sourceSlots[0]!.terminalResult = { schema: 'turn-result/v1', state: 'ok' };
        },
      },
      {
        name: 'complete clean without a successful send',
        mutate: (round) => {
          const slot = round.sourceSlots[0]!;
          slot.terminalResult = storedTerminalTurnResult(slot.invocationId!, { send_count: 0 });
        },
      },
      {
        name: 'complete clean with findings payload',
        mutate: (round) => {
          round.sourceSlots[0]!.payload = {
            verdict: 'findings',
            findingCount: 1,
            findings: [{ title: 'unexpected' }],
          };
        },
      },
      {
        name: 'complete findings with clean payload',
        mutate: (round) => {
          round.sourceSlots[0]!.terminalClass = 'complete_findings';
        },
      },
      {
        name: 'non-complete class carrying complete payload',
        mutate: (round) => {
          round.sourceSlots[0]!.terminalClass = 'possible_delivery';
        },
      },
      {
        name: 'terminal class mismatched to turn result',
        mutate: (round) => {
          const slot = round.sourceSlots[0]!;
          slot.terminalClass = 'driver_error:rate_limit_detected';
          slot.payload = undefined;
          slot.terminalResult = storedTerminalTurnResult(slot.invocationId!, {
            state: 'profile_busy',
            scope: 'profile',
            cause: 'profile_busy',
            send_count: 0,
          });
        },
      },
      {
        name: 'unsupported synthetic evidence',
        mutate: (round) => {
          round.sourceSlots[0]!.terminalResult = { kind: 'completed', sendCount: 1 };
        },
      },
    ];

    for (const malformedCase of malformedCases) {
      const storeRoot = tempRoot(`opk-gpt-terminal-evidence-${malformedCase.name.replaceAll(' ', '-')}-`);
      const round = storedGptRound();
      malformedCase.mutate(round);
      expect(() => createPackReviewRun({
        projectId: 'orchestrator-pack',
        storeRoot,
        prNumber: 1276,
        headSha: HEAD_A,
        trustedPackRoot: repoRoot,
        sourceRepoRoot: repoRoot,
        reviewRound: round,
      }), malformedCase.name).toThrow(/terminalResult|payload|class-inconsistent|non-complete|terminal class/);
    }
  });
});

describe('GPT frozen census persistence and stale recovery (Issue #1276 r08)', () => {
  it('rejects a self-consistent replacement census while preserving intermediate updates', () => {
    const storeRoot = tempRoot('opk-gpt-frozen-census-');
    const created = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1276,
      headSha: HEAD_A,
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      reviewRound: plannedStoredGptRound(),
    });
    const intermediate = plannedStoredGptRound();
    intermediate.sourceSlots[0] = {
      ...intermediate.sourceSlots[0]!,
      lifecycle: 'invocation_started',
      attemptOrdinal: 1,
      admissionStartedAtUtc: new Date().toISOString(),
    };
    const updated = updatePackReviewRun(
      created.run.id,
      { reviewRound: intermediate },
      { projectId: 'orchestrator-pack', storeRoot },
    );
    expect(updated.reviewRound?.sourceSlots[0]?.lifecycle).toBe('invocation_started');

    const replacement: PackReviewGptRoundRecord = {
      ...plannedStoredGptRound(),
      cardinality: 1,
      sourceSlots: [{ slotId: 'source-01', ordinal: 1, lifecycle: 'planned' }],
    };
    expect(() => updatePackReviewRun(
      created.run.id,
      { reviewRound: replacement },
      { projectId: 'orchestrator-pack', storeRoot },
    )).toThrow(/frozen reviewRound cardinality cannot change/);
    expect(getPackReviewRun(created.run.id, {
      projectId: 'orchestrator-pack',
      storeRoot,
    })?.reviewRound?.sourceSlots).toHaveLength(3);
  });

  it('blocks verdict terminal settlement until every frozen source slot is terminal', () => {
    const storeRoot = tempRoot('opk-gpt-incomplete-terminal-');
    const round = plannedStoredGptRound();
    round.sourceSlots[0] = terminalStoredSlot(round.sourceSlots[0]!);
    const created = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1276,
      headSha: HEAD_A,
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      reviewRound: round,
    });

    expect(() => setPackReviewRunTerminal(
      created.run.id,
      'commented',
      { reviewVerdict: 'findings', findingCount: 0, findings: [] },
      { projectId: 'orchestrator-pack', storeRoot },
    )).toThrow(/mandatory source slot source-02 is not terminal/);
    expect(getPackReviewRun(created.run.id, {
      projectId: 'orchestrator-pack',
      storeRoot,
    })?.status).toBe('queued');
  });

  it('rejects string-coerced decision-bearing round fields', () => {
    const storeRoot = tempRoot('opk-gpt-strict-round-types-');
    const malformed = plannedStoredGptRound() as unknown as Record<string, unknown>;
    malformed.cardinality = '3';
    expect(() => createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1276,
      headSha: HEAD_A,
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      reviewRound: malformed as unknown as PackReviewGptRoundRecord,
    })).toThrow(/invalid reviewRound cardinality/);
  });

  it('never opens a same-head replacement after terminal or mixed source evidence is stale', () => {
    const variants: Array<{ name: string; round: PackReviewGptRoundRecord }> = [
      {
        name: 'terminal-plus-planned',
        round: (() => {
          const round = plannedStoredGptRound();
          round.sourceSlots[0] = terminalStoredSlot(round.sourceSlots[0]!);
          return round;
        })(),
      },
      {
        name: 'all-terminal-unjournaled',
        round: (() => {
          const round = plannedStoredGptRound();
          round.sourceSlots = round.sourceSlots.map(terminalStoredSlot);
          return round;
        })(),
      },
    ];

    for (const variant of variants) {
      const storeRoot = tempRoot(`opk-gpt-stale-no-replacement-${variant.name}-`);
      const staleAt = new Date(Date.now() - 11 * 60_000);
      const created = createPackReviewRun({
        projectId: 'orchestrator-pack',
        storeRoot,
        prNumber: 1276,
        headSha: HEAD_A,
        trustedPackRoot: repoRoot,
        sourceRepoRoot: repoRoot,
        reviewRound: variant.round,
        now: staleAt,
      });
      updatePackReviewRun(
        created.run.id,
        { runnerPid: 999999 },
        { projectId: 'orchestrator-pack', storeRoot, now: staleAt },
      );
      const recovered = terminalizePackReviewStaleRun(created.run.id, {
        projectId: 'orchestrator-pack',
        storeRoot,
        now: new Date(),
      });
      expect(recovered.run.status, variant.name).toBe('failed');

      const replacement = createPackReviewRun({
        projectId: 'orchestrator-pack',
        storeRoot,
        prNumber: 1276,
        headSha: HEAD_A,
        trustedPackRoot: repoRoot,
        sourceRepoRoot: repoRoot,
        reviewRound: plannedStoredGptRound(),
      });
      expect(replacement.created, variant.name).toBe(false);
      expect(replacement.reused, variant.name).toBe(true);
      expect(replacement.reason, variant.name).toBe('gpt_round_requires_settlement');
      expect(replacement.run.id, variant.name).toBe(created.run.id);
    }
  });
});
