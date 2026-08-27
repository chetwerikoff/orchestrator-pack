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
import {
  isRetryablePackReviewZeroSendCollision,
  reconcileStalePackReviewRuns,
  resolveCurrentPrHead,
  startPackReview,
} from './pack-review-runner.js';
import type { CarryoverReplayResult } from './pack-review-carryover.js';
import { initializePackReviewAuthority, readPackReviewAuthority } from './pack-review-state.js';
import {
  createPackReviewRun,
  getPackReviewRun,
  listPackReviewRuns,
  setPackReviewRunTerminal,
  terminalizePackReviewStaleRun,
  updatePackReviewRun,
  type PackReviewGptRoundRecord,
} from './lib/pack-review-run-store.js';
import { acquireReviewStartClaim } from './lib/review-start-claim-store.js';
import { PACK_REVIEW_BOUND_REVIEWER_ENV } from './lib/resolve-pack-reviewer.js';
import { computeBoundIssueSnapshotHash } from './lib/reverify-bound-issue-snapshot.js';
import {
  formatPackGptSourceCommentEnvelope,
  type PackGptSourceIdentity,
} from './lib/pack-gpt-source-comment-contract.js';
import type {
  PackGptSourceCommentTransport,
  PackGptSourceGithubComment,
} from './lib/pack-gpt-source-comment.js';
import type {
  GithubReviewSummary,
  GithubReviewTransport,
} from './lib/github-review-reconciliation.js';

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
  process.env.OPK_BASE_DIR = path.join(storeRoot, 'ao-base');
  process.env.OPK_REVIEW_CLAIM_DIR = path.join(
    storeRoot,
    'ao-base',
    'projects',
    'orchestrator-pack',
    'review-start-claims',
  );
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

function harvestTerminalPayload(
  invocationId: string,
  harvestClass: 'harvest_failed' | 'no_reply' | 'forbidden_verdict_envelope' = 'harvest_failed',
): string {
  const evidenceRoot = `/fixture/gpt-evidence/${invocationId}`;
  return JSON.stringify({
    schema: 'turn-result/v1',
    state: harvestClass === 'no_reply' ? 'no_reply' : 'ok',
    scope: 'invocation',
    cause: harvestClass === 'no_reply' ? 'no_reply' : 'completed_page_only',
    invocation_id: invocationId,
    send_count: 1,
    review_harvest_class: harvestClass,
    review_evidence: {
      adapterPromptPath: `${evidenceRoot}/adapter-prompt.txt`,
      terminalReplyPath: `${evidenceRoot}/terminal-reply.txt`,
      mappingErrorPath: `${evidenceRoot}/mapping-error.txt`,
      adapterStdoutPath: `${evidenceRoot}/adapter-stdout.json`,
    },
  });
}

function findingsPayload(title: string, severity = 'blocking'): string {
  return terminalTurnPayload({
    state: 'ok',
    cause: 'completed_page_only',
    sendCount: 1,
    invocationId: `inv-${title}`,
  }) + String.fromCharCode(10) + JSON.stringify({
    verdict: 'findings',
    findingCount: 1,
    findings: [{ title, body: 'body-' + title, severity }],
  });
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

function writeSuccessfulGhFixture(binRoot: string): void {
  if (process.platform === 'win32') {
    writeFileSync(path.join(binRoot, 'gh.cmd'), '@echo off\r\nexit /b 0\r\n', 'utf8');
    return;
  }
  const fixture = path.join(binRoot, 'gh');
  writeFileSync(fixture, '#!/usr/bin/env node\nprocess.exitCode = 0;\n', 'utf8');
  chmodSync(fixture, 0o755);
}

afterEach(() => {
  process.env = { ...originalEnv };
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pack-review current-head REST read', () => {
  function processResult(stdout: string) {
    return {
      outcome: 'exit' as const,
      ok: true,
      exitCode: 0,
      signal: null,
      stdout,
      stderr: '',
      timedOut: false,
      cancelled: false,
    };
  }

  it('requests inventory-routable JSON without jq and parses the open head', async () => {
    const invocations: Array<{ command: string; args?: readonly string[] }> = [];
    const head = await resolveCurrentPrHead(repoRoot, 'chetwerikoff/orchestrator-pack', 1517, async (options) => {
      invocations.push({ command: options.command, args: options.args });
      return processResult(JSON.stringify({ headRefOid: HEAD_A, state: 'OPEN' }));
    });

    expect(head).toBe(HEAD_A);
    expect(invocations).toEqual([{
      command: path.join(repoRoot, 'scripts', 'gh'),
      args: ['api', 'repos/chetwerikoff/orchestrator-pack/pulls/1517'],
    }]);
  });

  it('preserves malformed-head and non-open PR failures', async () => {
    await expect(resolveCurrentPrHead(repoRoot, 'chetwerikoff/orchestrator-pack', 1517, async () => (
      processResult(JSON.stringify({ headRefOid: 'short', state: 'OPEN' }))
    ))).rejects.toThrow('PR #1517 returned invalid head SHA');

    await expect(resolveCurrentPrHead(repoRoot, 'chetwerikoff/orchestrator-pack', 1517, async () => (
      processResult(JSON.stringify({ headRefOid: HEAD_A, state: 'CLOSED' }))
    ))).rejects.toThrow('PR #1517 is not open');

    await expect(resolveCurrentPrHead(repoRoot, 'chetwerikoff/orchestrator-pack', 1517, async () => (
      processResult('not-json')
    ))).rejects.toThrow('PR #1517 returned invalid JSON');
  });
});


describe('Issue #1417 direct-CLI operator-only pack-review start', () => {
  const issueBody = [
    '```complexity-tier',
    'tier: T1',
    'advisory-prior: T1',
    '```',
  ].join('\n');
  const snapshot = computeBoundIssueSnapshotHash(issueBody);

  function directOperatorStart(
    storeRoot: string,
    stdinOverrides: Record<string, unknown> = {},
  ) {
    const commandRoot = tempRoot('opk-1417-gh-bin-');
    writeSuccessfulGhFixture(commandRoot);
    const explicitCapture = path.join(storeRoot, 'explicit-github-review.json');
    const childEnv = {
      ...process.env,
      OPK_VITEST_HARNESS: '1',
      PACK_REVIEWER: 'codex',
      PACK_REVIEW_GITHUB_REVIEW_CAPTURE_FILE: explicitCapture,
      PATH: `${commandRoot}${path.delimiter}${process.env.PATH ?? ''}`,
    };
    return runProcessSync({
      command: process.execPath,
      args: [
        '--experimental-strip-types',
        path.join(repoRoot, 'scripts', 'pack-review-runner.ts'),
        'start',
        '--pr-number', '1341',
        '--head-sha', HEAD_A,
        '--operator-repository', 'chetwerikoff/orchestrator-pack',
        '--operator-issue-number', '1341',
        '--operator-bound-snapshot', snapshot,
        '--operator-reason', 'direct operator recovery for the exact blocked review',
      ],
      cwd: repoRoot,
      encoding: 'utf8',
      env: childEnv,
      input: JSON.stringify({
        projectId: 'orchestrator-pack',
        storeRoot,
        sourceRepoRoot: repoRoot,
        fixtureCurrentPrHeadSha: HEAD_A,
        fixturePrState: 'OPEN',
        fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
        fixturePostReviewHeadSha: HEAD_A,
        fixtureIssueBody: issueBody,
        fixtureIssueNumber: 1341,
        fixtureReviewStdout: cleanTerminalPayload(),
        fixtureReviewExitCode: 0,
        fixtureGithubReviewId: 1417,
        ...stdinOverrides,
      }),
    });
  }

  it('rejects a programmatic operator tuple before run creation', async () => {
    const storeRoot = tempRoot('opk-1417-programmatic-operator-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.PACK_REVIEWER = 'codex';

    const forged = {
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: repoRoot,
      prNumber: 1341,
      headSha: HEAD_A,
      operatorRepository: 'chetwerikoff/orchestrator-pack',
      operatorIssueNumber: 1341,
      operatorBoundSnapshot: snapshot,
      operatorReason: 'forged programmatic operator start',
      fixtureCurrentPrHeadSha: HEAD_A,
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureIssueBody: issueBody,
      fixtureIssueNumber: 1341,
      fixtureReviewStdout: cleanTerminalPayload(),
    } as unknown as Parameters<typeof startPackReview>[0];

    await expect(startPackReview(forged)).rejects.toThrow(
      'operator pack-review start inputs are accepted only from direct CLI arguments',
    );
    expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })).toEqual([]);
  });

  it('rejects an operator tuple supplied through stdin', () => {
    const storeRoot = tempRoot('opk-1417-stdin-operator-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.PACK_REVIEWER = 'codex';
    const result = runProcessSync({
      command: process.execPath,
      args: [
        '--experimental-strip-types',
        path.join(repoRoot, 'scripts', 'pack-review-runner.ts'),
        'start',
      ],
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
      input: JSON.stringify({
        projectId: 'orchestrator-pack',
        storeRoot,
        sourceRepoRoot: repoRoot,
        prNumber: 1341,
        headSha: HEAD_A,
        operatorRepository: 'chetwerikoff/orchestrator-pack',
        operatorIssueNumber: 1341,
        operatorBoundSnapshot: snapshot,
        operatorReason: 'stdin operator start',
      }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('operator pack-review start inputs are accepted only from direct CLI arguments');
    expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })).toEqual([]);
  });

  it('keeps an active same-head run deduped even for direct-CLI explicit review', () => {
    const storeRoot = tempRoot('opk-1417-explicit-active-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.PACK_REVIEWER = 'codex';
    const created = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1341,
      headSha: HEAD_A,
      linkedSessionId: 'original-session',
      startReason: 'original reason',
      surface: 'original surface',
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      canonicalRepository: 'chetwerikoff/orchestrator-pack',
    });

    const explicit = directOperatorStart(storeRoot);
    expect(explicit.exitCode).toBe(0);
    const result = JSON.parse(explicit.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)!) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, created: false, reused: true, reason: 'active_run_exists' });
    const stored = getPackReviewRun(created.run.id, { projectId: 'orchestrator-pack', storeRoot });
    expect(stored?.startReason).toBe('original reason');
    expect(stored?.surface).toBe('original surface');
    expect(stored?.linkedSessionId).toBe('original-session');
    expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })).toHaveLength(1);
  });

  it('requires an explicit PR number when no operator target is supplied', async () => {
    const storeRoot = tempRoot('opk-1341-no-pr-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    await expect(startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: repoRoot,
      headSha: HEAD_A,
      fixtureCurrentPrHeadSha: HEAD_A,
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
    })).rejects.toThrow('pack review start requires --pr-number <n>');
    expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })).toEqual([]);
  });
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
        const args = entry.args?.join(' ') ?? '';
        expect(args).toContain('Invoke-TypeScriptCli.ts');
        expect(args).toContain('run-pack-review-gpt.ts');
        expect(args).not.toContain('invoke-pack-review.ps1');
        expect(args).not.toContain('run-pack-review.ps1');
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
      OPK_BASE_DIR: path.join(fixtureRoot, 'ao-base'),
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
      fixtureReviewBySourceSlot: {
        'source-01': [{ stdout: successfulCleanReviewPayload('inv-plural-source-01') }],
        'source-02': [{ stdout: successfulCleanReviewPayload('inv-plural-source-02') }],
        'source-03': [{ stdout: successfulCleanReviewPayload('inv-plural-source-03') }],
      },
      fixtureIssueBody: '```complexity-tier\ntier: T1\n```',
      fixtureIssueNumber: 1276,
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
      fixtureIssueNumber: 1276,
      claimMode: 'preacquired',
      ...overrides,
    };
  }

  it('fails plural fixed-chat configuration before invoking any source', async () => {
    const storeRoot = tempRoot('opk-gpt-fixed-chat-');
    const capture = path.join(storeRoot, 'github-review.json');
    const invocationLog = path.join(storeRoot, 'invocations.jsonl');
    harnessEnv(storeRoot, capture);
    delete process.env.PACK_GPT_BROWSER_PROJECT_URL;
    process.env.PACK_GPT_BROWSER_CHAT_URL = 'https://chatgpt.com/c/fixed';
    process.env.PACK_REVIEW_RUNNER_INVOCATION_LOG = invocationLog;

    const result = await startPackReview(pluralStart(storeRoot, capture));
    expect(result).toMatchObject({ ok: false, created: false, reused: false });
    expect(String(result.reason)).toMatch(/plural GPT review requires/);
    expect(engagementCount(invocationLog)).toBe(0);
    expect(() => readFileSync(capture, 'utf8')).toThrow();
  });

  it('rejects terminal-evidence-free clean payloads and keeps sibling outcomes', async () => {
    const storeRoot = tempRoot('opk-gpt-prelaunch-failure-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
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

  it('exhausts one zero-send collision retry without publishing a verdict', async () => {
    const storeRoot = tempRoot('opk-gpt-zero-send-exhausted-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
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
    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      reason: 'gpt_source_non_complete:source-02:explicit_refusal:zero_send_collision_exhausted',
    });
    expect(run?.reviewVerdict).toBeUndefined();
    expect(() => readFileSync(capture, 'utf8')).toThrow();
  });

  it('keeps a possible-delivery source non-retryable and outside normal verdict publication', async () => {
    const storeRoot = tempRoot('opk-gpt-possible-delivery-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
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
    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      reason: 'gpt_source_non_complete:source-02:possible_delivery',
    });
    expect(run?.reviewVerdict).toBeUndefined();
    expect(() => readFileSync(capture, 'utf8')).toThrow();
  });

  it.each([
    ['harvest_failed', successfulCleanReviewPayload('inv-source-01')],
    ['harvest_failed with non-blocking finding', findingsPayload('non-blocking-real', 'non-blocking')],
  ])('publishes diagnostic COMMENT and terminal error for %s without synthetic code findings', async (_name, sourceOne) => {
    const storeRoot = tempRoot('opk-gpt-harvest-incident-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;
    const statusStates: string[] = [];

    const result = await startPackReview(pluralStart(storeRoot, capture, {
      fixtureRequiredStatusWriter: async (request) => {
        statusStates.push(request.state);
      },
      fixtureReviewBySourceSlot: {
        'source-01': [{ stdout: sourceOne }],
        'source-02': [{ stdout: harvestTerminalPayload('inv-source-02'), exitCode: 1 }],
        'source-03': [{ stdout: successfulCleanReviewPayload('inv-source-03') }],
      },
    }));

    const run = getPackReviewRun(String(result.runId), { projectId: 'orchestrator-pack', storeRoot });
    expect(result).toMatchObject({ ok: false, status: 'failed', reason: 'harvest_failed' });
    expect(run?.reviewVerdict).toBeUndefined();
    expect(statusStates).toEqual(['pending', 'error']);
    const posted = readFileSync(capture, 'utf8');
    expect(posted).toContain('Review harvest incidents');
    expect(posted).toContain('source-02');
    expect(posted).toContain('harvest_failed');
    expect(posted).toContain('/fixture/gpt-evidence/inv-source-02/adapter-prompt.txt');
    expect(posted).not.toContain('GPT source source-02 did not complete');
  });

  it('keeps real blocking findings authoritative while reporting harvest incidents separately', async () => {
    const storeRoot = tempRoot('opk-gpt-harvest-blocking-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;

    const result = await startPackReview(pluralStart(storeRoot, capture, {
      fixtureReviewBySourceSlot: {
        'source-01': [{ stdout: findingsPayload('real-blocker') }],
        'source-02': [{ stdout: harvestTerminalPayload('inv-source-02'), exitCode: 1 }],
        'source-03': [{ stdout: successfulCleanReviewPayload('inv-source-03') }],
      },
    }));

    const run = getPackReviewRun(String(result.runId), { projectId: 'orchestrator-pack', storeRoot });
    expect(result).toMatchObject({ ok: true, status: 'changes_requested' });
    expect(run?.reviewVerdict).toBe('findings');
    expect(run?.findingCount).toBe(1);
    expect(run?.findings).toHaveLength(1);
    const posted = readFileSync(capture, 'utf8');
    expect(posted).toContain('real-blocker');
    expect(posted).toContain('Review harvest incidents');
    expect(posted).toContain('harvest_failed');
    expect(posted).not.toContain('GPT source source-02 did not complete');
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
      }), malformedCase.name).toThrow(/terminalResult|payload|class-inconsistent|non-complete|terminal class|zero-send collision|zero-send collision/);
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
    )).toThrow(/frozen reviewRound cardinality cannot change|cardinality violates tier\/round policy|cardinality violates tier\/round policy/);
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

describe('Issue #1393 legacy aggregate compatibility and runner harvest matrix', () => {
  type HarvestClass = 'harvest_failed' | 'no_reply' | 'forbidden_verdict_envelope';

  function issue1393Start(
    storeRoot: string,
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
      fixtureIssueBody: '```complexity-tier\ntier: T1\n```',
      fixtureIssueNumber: 1276,
      claimMode: 'preacquired',
      ...overrides,
    };
  }

  function expectPersistedHarvestSlot(
    runId: string,
    storeRoot: string,
    slotId: string,
    fixtureInvocationId: string,
    harvestClass: HarvestClass,
  ): void {
    const run = getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot });
    const slot = run?.reviewRound?.sourceSlots.find((candidate) => candidate.slotId === slotId);
    const evidenceRoot = `/fixture/gpt-evidence/${fixtureInvocationId}`;
    const persistedInvocationId = slot?.invocationId;
    expect(persistedInvocationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(persistedInvocationId).not.toBe(fixtureInvocationId);
    expect(slot).toMatchObject({
      slotId,
      lifecycle: 'terminal',
      invocationId: persistedInvocationId,
      terminalClass: harvestClass,
      terminalResult: {
        invocation_id: persistedInvocationId,
        send_count: 1,
        review_harvest_class: harvestClass,
        review_evidence: {
          adapterPromptPath: `${evidenceRoot}/adapter-prompt.txt`,
          terminalReplyPath: `${evidenceRoot}/terminal-reply.txt`,
          mappingErrorPath: `${evidenceRoot}/mapping-error.txt`,
          adapterStdoutPath: `${evidenceRoot}/adapter-stdout.json`,
        },
      },
    });
    expect(slot?.payload).toBeUndefined();
  }

  function expectSingleReconciledComment(
    runId: string,
    storeRoot: string,
    capture: string,
    reviewId: number,
  ): void {
    const url = `fixture://pull/1276/review/${reviewId}`;
    const run = getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot });
    expect(run?.githubReviewReconciliation).toMatchObject({
      event: 'COMMENT',
      phase: 'complete',
      commentReviewId: reviewId,
      commentReviewUrl: url,
    });
    const captured = JSON.parse(readFileSync(capture, 'utf8')) as {
      event: string;
      body: string;
      actions: Array<{ kind: string; event: string }>;
    };
    expect(captured.event).toBe('COMMENT');
    expect(captured.actions.filter((action) => action.kind === 'post' && action.event === 'COMMENT')).toHaveLength(1);
  }

  it('rejects the legacy schema-v1 synthetic aggregate instead of reading it as findings', async () => {
    const storeRoot = tempRoot('opk-1393-legacy-synthetic-read-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;

    const legacyRound = storedGptRound();
    legacyRound.issueNumber = 1393;
    const malformed = legacyRound.sourceSlots[1]!;
    legacyRound.sourceSlots[1] = {
      ...malformed,
      terminalClass: 'reviewer_output_malformed',
      terminalResult: storedTerminalTurnResult(malformed.invocationId!),
      payload: undefined,
    };
    const legacy = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1393,
      headSha: HEAD_B,
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      canonicalRepository: 'chetwerikoff/orchestrator-pack',
      reviewRound: legacyRound,
    }).run;
    const recordPath = path.join(storeRoot, 'runs', `${legacy.id}.json`);
    const raw = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
    const syntheticFinding = {
      title: 'GPT source source-02 did not complete',
      body: 'The frozen GPT source slot settled as reviewer_output_malformed; the round cannot be clean.',
      severity: 'blocking',
      sourceSlotId: 'source-02',
    };
    const recordedAtUtc = new Date().toISOString();
    Object.assign(raw, {
      status: 'changes_requested',
      latestRunStatus: 'changes_requested',
      completedAtUtc: recordedAtUtc,
      exitCode: 0,
      reviewVerdict: 'findings',
      findingCount: 1,
      findings: [syntheticFinding],
      journalOutcome: {
        state: 'persisted',
        recordedAtUtc,
        reason: 'legacy schema-v1 persisted verdict',
        idempotencyKey: `verdict:${legacy.id}:${HEAD_B}`,
        attempts: 1,
      },
    });
    writeFileSync(recordPath, `${JSON.stringify(raw)}\n`, 'utf8');

    expect(() => listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot }))
      .toThrow(/reviewVerdict does not match terminal source census/);
    rmSync(recordPath);

    const result = await startPackReview(issue1393Start(storeRoot, {
      fixtureReviewBySourceSlot: {
        'source-01': [{ stdout: successfulCleanReviewPayload('inv-current-source-01') }],
        'source-02': [{ stdout: successfulCleanReviewPayload('inv-current-source-02') }],
        'source-03': [{ stdout: successfulCleanReviewPayload('inv-current-source-03') }],
      },
    }));
    expect(result.ok).toBe(true);
    expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })).toHaveLength(1);
  });

  it.each([
    ['harvest_failed', 139301],
    ['no_reply', 139302],
    ['forbidden_verdict_envelope', 139303],
  ] as const)('carries %s through runner persistence, error status, reconciliation, and receipt', async (harvestClass, reviewId) => {
    const storeRoot = tempRoot(`opk-1393-runner-${harvestClass}-`);
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;
    const statusStates: string[] = [];

    const result = await startPackReview(issue1393Start(storeRoot, {
      fixtureGithubReviewId: reviewId,
      fixtureRequiredStatusWriter: async (request) => {
        statusStates.push(request.state);
      },
      fixtureReviewBySourceSlot: {
        'source-01': [{ stdout: successfulCleanReviewPayload('inv-source-01') }],
        'source-02': [{ stdout: harvestTerminalPayload('inv-source-02', harvestClass), exitCode: 1 }],
        'source-03': [{ stdout: successfulCleanReviewPayload('inv-source-03') }],
      },
    }));

    const expectedUrl = `fixture://pull/1276/review/${reviewId}`;
    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      reason: 'harvest_failed',
      githubReviewId: reviewId,
      githubReviewUrl: expectedUrl,
    });
    expect(statusStates).toEqual(['pending', 'error']);
    expectPersistedHarvestSlot(String(result.runId), storeRoot, 'source-02', 'inv-source-02', harvestClass);
    const run = getPackReviewRun(String(result.runId), { projectId: 'orchestrator-pack', storeRoot });
    expect(run?.reviewVerdict).toBeUndefined();
    expect(run?.findingCount ?? 0).toBe(0);
    expect(run?.findings).toEqual([]);
    expectSingleReconciledComment(String(result.runId), storeRoot, capture, reviewId);
    const posted = readFileSync(capture, 'utf8');
    expect(posted).toContain('source-02');
    expect(posted).toContain(harvestClass);
    expect(posted).toContain('/fixture/gpt-evidence/inv-source-02/adapter-prompt.txt');
    expect(posted).not.toContain('GPT source source-02 did not complete');
  });

  it('persists multiple different harvest incident classes in one round with one reconciled COMMENT', async () => {
    const storeRoot = tempRoot('opk-1393-runner-multi-harvest-');
    const capture = path.join(storeRoot, 'github-review.json');
    const reviewId = 139304;
    harnessEnv(storeRoot, capture);
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;
    const statusStates: string[] = [];

    const result = await startPackReview(issue1393Start(storeRoot, {
      fixtureGithubReviewId: reviewId,
      fixtureRequiredStatusWriter: async (request) => {
        statusStates.push(request.state);
      },
      fixtureReviewBySourceSlot: {
        'source-01': [{ stdout: harvestTerminalPayload('inv-source-01', 'harvest_failed'), exitCode: 1 }],
        'source-02': [{ stdout: harvestTerminalPayload('inv-source-02', 'no_reply'), exitCode: 1 }],
        'source-03': [{ stdout: harvestTerminalPayload('inv-source-03', 'forbidden_verdict_envelope'), exitCode: 1 }],
      },
    }));

    const expectedUrl = `fixture://pull/1276/review/${reviewId}`;
    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      reason: 'harvest_failed',
      githubReviewId: reviewId,
      githubReviewUrl: expectedUrl,
    });
    expect(statusStates).toEqual(['pending', 'error']);
    expectPersistedHarvestSlot(String(result.runId), storeRoot, 'source-01', 'inv-source-01', 'harvest_failed');
    expectPersistedHarvestSlot(String(result.runId), storeRoot, 'source-02', 'inv-source-02', 'no_reply');
    expectPersistedHarvestSlot(
      String(result.runId),
      storeRoot,
      'source-03',
      'inv-source-03',
      'forbidden_verdict_envelope',
    );
    const run = getPackReviewRun(String(result.runId), { projectId: 'orchestrator-pack', storeRoot });
    expect(run?.reviewVerdict).toBeUndefined();
    expect(run?.findingCount ?? 0).toBe(0);
    expect(run?.findings).toEqual([]);
    expectSingleReconciledComment(String(result.runId), storeRoot, capture, reviewId);
    const posted = readFileSync(capture, 'utf8');
    for (const value of [
      'source-01',
      'harvest_failed',
      'source-02',
      'no_reply',
      'source-03',
      'forbidden_verdict_envelope',
    ]) {
      expect(posted).toContain(value);
    }
    expect(posted).not.toContain('GPT source source-01 did not complete');
    expect(posted).not.toContain('GPT source source-02 did not complete');
    expect(posted).not.toContain('GPT source source-03 did not complete');
  });
});

describe('Issue #1741 failed GPT round source-comment settlement', () => {
  it('hydrates complete GitHub sources after stale terminalization without replacing the run', async () => {
    const storeRoot = tempRoot('opk-gpt-1741-settlement-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;

    initializePackReviewAuthority({
      prNumber: 1740,
      headSha: HEAD_A,
      tier: 'T1',
      options: { storeRoot },
    });
    const invocationIds = [
      '11111111-1111-4111-8111-000000000001',
      '11111111-1111-4111-8111-000000000002',
      '11111111-1111-4111-8111-000000000003',
    ];
    const sourceSlots = invocationIds.map((invocationId, index) => ({
      slotId: `source-${String(index + 1).padStart(2, '0')}`,
      ordinal: index + 1,
      lifecycle: 'terminal' as const,
      invocationId,
      attemptOrdinal: 1,
      admissionStartedAtUtc: '2026-08-27T09:00:00.000Z',
      terminalClass: 'reviewer_output_malformed',
      terminalResult: {
        ...storedTerminalTurnResult(invocationId),
        source_comment_reconciliation: 'conflict',
      },
    }));
    const created = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1740,
      headSha: HEAD_A,
      trustedPackRoot: repoRoot,
      sourceRepoRoot: path.join(storeRoot, 'fm-pointer-notification-episodes'),
      canonicalRepository: 'chetwerikoff/orchestrator-pack',
      reviewRound: {
        schema: 'pack-review-gpt-round/v1',
        reviewer: 'gpt',
        tier: 'T1',
        roundOrdinal: 1,
        cardinality: 3,
        issueNumber: 1741,
        boundIssueSnapshotDigest: computeBoundIssueSnapshotHash('```complexity-tier\ntier: T1\n```'),
        sourceSlots,
      },
    }).run;
    const failed = setPackReviewRunTerminal(created.id, 'failed', {
      exitCode: 1,
      failureReason: 'stale_head_before_terminal',
    }, { projectId: 'orchestrator-pack', storeRoot });
    expect(failed).toMatchObject({ status: 'failed', failureReason: 'stale_head_before_terminal' });
    expect(failed.reviewVerdict).toBeUndefined();

    const identities = new Map<string, PackGptSourceIdentity>();
    const sourceCommentIds = [5437227435, 5437250730, 5437258834];
    const sourceTransport: PackGptSourceCommentTransport = {
      resolveActorLogin: async () => 'browser-gpt-bot',
      listComments: async (): Promise<PackGptSourceGithubComment[]> => sourceCommentIds.map((id, index) => {
        const identity = identities.get(`source-${String(index + 1).padStart(2, '0')}`)!;
        const timestamp = '2026-08-27T09:00:00.000Z';
        return {
          id,
          body: formatPackGptSourceCommentEnvelope(identity, 'NO_FINDINGS'),
          actorLogin: 'browser-gpt-bot',
          createdAt: timestamp,
          updatedAt: timestamp,
          url: `https://github.com/chetwerikoff/orchestrator-pack/pull/1740#issuecomment-${id}`,
          issueUrl: 'https://api.github.com/repos/chetwerikoff/orchestrator-pack/issues/1740',
        };
      }),
      getComment: async (id): Promise<PackGptSourceGithubComment> => {
        const comment = (await sourceTransport.listComments()).find((candidate) => candidate.id === id);
        if (!comment) throw new Error(`fixture source comment ${String(id)} missing`);
        return comment;
      },
    };
    for (const slot of failed.reviewRound!.sourceSlots) {
      identities.set(slot.slotId, {
        repository: 'chetwerikoff/orchestrator-pack',
        prNumber: 1740,
        headSha: HEAD_A,
        runId: failed.id,
        slotId: slot.slotId,
        invocationId: slot.invocationId!,
      });
    }

    const replacement = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1740,
      headSha: HEAD_A,
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      canonicalRepository: 'chetwerikoff/orchestrator-pack',
      reviewRound: {
        schema: 'pack-review-gpt-round/v1',
        reviewer: 'gpt',
        tier: 'T1',
        roundOrdinal: 1,
        cardinality: 3,
        issueNumber: 1741,
        boundIssueSnapshotDigest: computeBoundIssueSnapshotHash('```complexity-tier\ntier: T1\n```'),
        sourceSlots: invocationIds.map((invocationId, index) => ({
          slotId: `source-${String(index + 1).padStart(2, '0')}`,
          ordinal: index + 1,
          lifecycle: 'planned' as const,
        })),
      },
    });
    expect(replacement.created).toBe(false);
    expect(replacement.reused).toBe(true);
    expect(replacement.reason).toBe('gpt_round_requires_settlement');
    expect(replacement.run.id).toBe(failed.id);

    const reviews: GithubReviewSummary[] = [];
    let finalReviewPosts = 0;
    const finalReviewTransport: GithubReviewTransport = {
      resolveActorLogin: async () => 'pack-review-bot',
      listReviews: async () => [...reviews],
      postReview: async ({ body, commitId }) => {
        finalReviewPosts += 1;
        const id = 174100 + finalReviewPosts;
        const review: GithubReviewSummary = {
          id,
          body,
          commitId,
          url: `https://github.com/chetwerikoff/orchestrator-pack/pull/1740#pullrequestreview-${id}`,
          state: 'COMMENTED',
          userLogin: 'pack-review-bot',
          submittedAt: '2026-08-27T10:00:00.000Z',
        };
        reviews.push(review);
        return { id, url: review.url };
      },
      dismissReview: async () => {},
    };

    const reconciliation = await reconcileStalePackReviewRuns({
      repoSlug: 'chetwerikoff/orchestrator-pack',
      sourceRepoRoot: path.join(storeRoot, 'fm-pointer-notification-episodes'),
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1740,
      immediate: true,
      fixtureCurrentPrHeadSha: HEAD_A,
      fixtureGptSourceCommentTransport: sourceTransport,
      fixtureGithubReviewTransport: finalReviewTransport,
      fixtureRequiredStatusWriter: async () => {},
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
      fixtureIssueBody: '```complexity-tier\ntier: T1\n```',
      fixtureIssueNumber: 1741,
      fixtureChangedPaths: ['scripts/pack-review-runner.ts'],
      fixtureBoundIssueSnapshotBytes: '```complexity-tier\ntier: T1\n```',
    });

    expect(reconciliation.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: failed.id, recovered: true, statusReconciled: true }),
    ]));
    const settled = getPackReviewRun(failed.id, { projectId: 'orchestrator-pack', storeRoot });
    expect(settled).toMatchObject({
      status: 'up_to_date',
      reviewVerdict: 'clean',
      journalOutcome: { state: 'persisted' },
    });
    expect(settled?.reviewRound?.sourceSlots.every((slot) => slot.terminalClass === 'complete_clean')).toBe(true);
    expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })).toHaveLength(1);
    expect(finalReviewPosts).toBe(1);
  });
});
