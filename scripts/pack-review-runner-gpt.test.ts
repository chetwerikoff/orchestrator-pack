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
import { startPackReview } from './pack-review-runner.js';
import type { CarryoverReplayResult } from './pack-review-carryover.js';
import { createPackReviewRun, getPackReviewRun, listPackReviewRuns } from './lib/pack-review-run-store.js';
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

function mergeCompositeReplay(): CarryoverReplayResult {
  const sourceHeadSha = 'c'.repeat(40);
  const mainSha = 'd'.repeat(40);
  const mergeBaseSha = 'e'.repeat(40);
  const bundle = {
    schema: 'merge-resolution-bundle/v2' as const,
    helperVersion: 'pack-review-carryover/v2' as const,
    sourceHeadSha,
    mainSha,
    targetHeadSha: HEAD_A,
    mergeBaseSha,
    orderedParentShas: [sourceHeadSha, mainSha] as [string, string],
    gitVersion: 'fixture',
    replayConfigDigest: 'fixture-config',
    replayDigest: 'fixture-replay',
    conflictCount: 1,
    conflicts: [],
    framedBytesBase64: '',
    bundleDigest: 'fixture-bundle',
  };
  return {
    kind: 'merge_composite',
    sourceHeadSha,
    mainSha,
    targetHeadSha: HEAD_A,
    mergeBaseSha,
    replayTreeSha: 'f'.repeat(40),
    replayDigest: 'fixture-replay',
    bundle,
  };
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
      const statusRequests: Array<{ state: string }> = [];

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
        fixtureRequiredStatusWriter: async (request) => {
          statusRequests.push(request);
          if (request.state === 'error') {
            expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })[0]?.status).toMatch(/failed|timed_out/);
          }
        },
      });

      expect(result.ok).toBe(false);
      expect(statusRequests.map((request) => request.state)).toEqual(['pending', 'error']);
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

describe('GPT terminal persistence claim handling (Issue #1307)', () => {
  const fallbackFailureCases = [
    {
      name: 'timeout',
      fixtureFallbackReviewTimedOut: true,
      expectedFailure: 'reviewer_process_timeout',
    },
    {
      name: 'process failure',
      fixtureFallbackReviewExitCode: 7,
      fixtureFallbackReviewStdout: '',
      expectedFailure: 'reviewer_process_failed',
    },
    {
      name: 'malformed output',
      fixtureFallbackReviewStdout: 'not-json',
      expectedFailure: 'reviewer_output_malformed',
    },
  ] as const;

  for (const failureCase of fallbackFailureCases) {
    it(`preserves the controlled cause for carryover fallback ${failureCase.name}`, async () => {
      const storeRoot = tempRoot(`opk-1307-carryover-fallback-${failureCase.name}-`);
      const capture = path.join(storeRoot, 'github-review.json');
      const statusRequests: Array<{ state: string }> = [];
      harnessEnv(storeRoot, capture);

      const result = await startPackReview({
        projectId: 'orchestrator-pack',
        storeRoot,
        sourceRepoRoot: repoRoot,
        prNumber: 1031,
        headSha: HEAD_A,
        claimMode: 'preacquired',
        fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
        fixtureCarryoverReplay: mergeCompositeReplay(),
        fixtureCarryoverSourceCleanRunId: 'source-clean',
        fixtureFocusedResolutionBundleDigest: 'wrong-bundle',
        fixtureReviewStdout: cleanTerminalPayload(),
        ...failureCase,
        fixtureRequiredStatusWriter: async (request) => {
          statusRequests.push(request);
        },
      });

      const persisted = getPackReviewRun(result.runId, { projectId: 'orchestrator-pack', storeRoot });
      expect(result.ok).toBe(false);
      expect(persisted?.failureReason).toContain(failureCase.expectedFailure);
      expect(statusRequests.map((request) => request.state)).toEqual(['pending', 'error']);
    });
  }

  it('fails closed before reviewer invocation when a same-head legacy repository is unresolved', async () => {
    const storeRoot = tempRoot('opk-1307-unresolved-legacy-repository-');
    const capture = path.join(storeRoot, 'github-review.json');
    const invocationLog = path.join(storeRoot, 'invocations.jsonl');
    const missingCheckout = path.join(storeRoot, 'deleted-checkout');
    harnessEnv(storeRoot, capture);
    process.env.PACK_REVIEW_RUNNER_INVOCATION_LOG = invocationLog;
    const legacy = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1031,
      headSha: HEAD_A,
      linkedSessionId: 'legacy-unresolved',
      startReason: 'fixture',
      surface: 'pack-review-runner-gpt-test',
      trustedPackRoot: repoRoot,
      sourceRepoRoot: missingCheckout,
    }).run;

    const result = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: repoRoot,
      prNumber: 1031,
      headSha: HEAD_A,
      claimMode: 'acquire',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureResolveRepositorySlug: async (sourceRoot) => {
        if (sourceRoot === missingCheckout) throw new Error('legacy checkout unavailable');
        return 'chetwerikoff/orchestrator-pack';
      },
      fixtureReviewStdout: cleanTerminalPayload(),
    });

    expect(result).toMatchObject({
      ok: false,
      created: false,
      reason: 'repository_identity_unresolved',
      runId: legacy.id,
    });
    expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })).toHaveLength(1);
    expect(() => readFileSync(invocationLog, 'utf8')).toThrow();
  });

  it('retains the acquired claim when required-status outcome persistence fails', async () => {
    const storeRoot = tempRoot('opk-1307-claim-persistence-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);

    const result = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: repoRoot,
      prNumber: 1031,
      headSha: HEAD_A,
      claimMode: 'acquire',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureReviewStdout: '',
      fixtureReviewExitCode: 1,
      fixtureRequiredStatusWriter: async (request) => {
        if (request.state === 'error') {
          chmodSync(path.join(storeRoot, 'runs'), 0o555);
        }
      },
    });

    chmodSync(path.join(storeRoot, 'runs'), 0o755);
    expect(result.ok).toBe(false);
    expect(getPackReviewRun(result.runId, { projectId: 'orchestrator-pack', storeRoot })?.deliveryOutcomes.requiredStatus)
      .toMatchObject({ state: 'succeeded', reason: 'status_pending' });
    expect(existsSync(path.join(
      storeRoot,
      'ao-base',
      'projects',
      'orchestrator-pack',
      'review-start-claims',
      `pr-1031-${HEAD_A}.json`,
    ))).toBe(true);
  });
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
