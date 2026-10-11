import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runProcessSync } from './kernel/subprocess.js';
import {
  parsePackGptReviewArgs,
  runPackGptReviewCommand,
} from './pack-gpt-review.js';
import {
  applyCliTargetProject,
  bindReviewerProjectSelection,
  isRetryablePackReviewZeroSendCollision,
  parseArgs,
  reconcileStalePackReviewRuns,
  resolveCurrentPrHead,
  resolvePackReviewReconcileRepository,
  startPackReview,
} from './pack-review-runner.js';
import type { CarryoverReplayResult } from './pack-review-carryover.js';
import {
  PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
  commitPackReviewTerminal,
  initializePackReviewAuthority,
  readPackReviewAuthority,
} from './pack-review-state.js';
import { packReviewDeliveryNeedsResume } from './lib/pack-review-delivery.js';
import {
  createPackReviewRun,
  derivePackReviewNoJudgmentBudgetOutcome,
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

function selectProjectCard(storeRoot: string): void {
  const configHome = path.join(storeRoot, 'config');
  const projects = path.join(configHome, 'orchestrator-pack', 'projects');
  mkdirSync(projects, { recursive: true });
  writeFileSync(path.join(projects, 'orchestrator-pack.json'), JSON.stringify({
    projectId: 'orchestrator-pack',
    repository: 'chetwerikoff/orchestrator-pack',
    primaryRoot: repoRoot,
    defaultBranch: 'main',
    orcaWorkspacePattern: 'orca/workspaces/orchestrator-pack/',
    orchestratorTitlePattern: 'orchestrator-pack',
    browserGpt: { projectUrl: 'https://chatgpt.com/g/orchestrator-pack/project' },
  }), 'utf8');
  process.env.HOME = storeRoot;
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.OPK_PROJECT_ID = 'orchestrator-pack';
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
    fixtureRequiredCiPolicy: {
      contexts: ['verify orchestrator-pack structure', 'pr scope guard', 'orchestrator-pack/pack-review'],
      checks: [],
    },
    fixtureRequiredCiChecks: [
      { name: 'verify orchestrator-pack structure', state: 'SUCCESS' },
      { name: 'pr scope guard', state: 'SUCCESS' },
      { name: 'orchestrator-pack/pack-review', state: 'PENDING' },
    ],
    fixtureRequiredCiHeadAfterGate: HEAD_A,
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
    "} else if (args[0] === 'api' && /\\/pulls\\/\\d+$/.test(args[1] ?? '')) {",
    `  process.stdout.write(JSON.stringify({ number: 1111, state: 'closed', body: 'Closes #2346', head: { sha: '${HEAD_A}' }, base: { ref: 'main' } }));`,
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
  vi.useRealTimers();
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

  it('never retries a collision tuple contradicted by attempted-send evidence', () => {
    const result = failedTurn('profile_busy', 'profile_busy', 0);
    result.stdout = JSON.stringify({ ...JSON.parse(result.stdout), send_attempted: true });
    expect(isRetryablePackReviewZeroSendCollision(result, 'collision-test')).toBe(false);
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

describe('pack-review runner target selection CLI', () => {
  it('accepts --project, validates its card, and propagates it to reviewer child environment', () => {
    const storeRoot = tempRoot('opk-runner-project-flag-');
    selectProjectCard(storeRoot);

    const input = parseArgs(['--project', 'orchestrator-pack']);
    applyCliTargetProject(input as { targetProjectId?: string; projectId?: string });

    expect(input).toMatchObject({ targetProjectId: 'orchestrator-pack', projectId: 'orchestrator-pack' });
    expect(process.env.OPK_PROJECT_ID).toBe('orchestrator-pack');
  });

  it('canonicalizes mixed-case explicit reconcile repository before run identity matching', async () => {
    const storeRoot = tempRoot('opk-issue-2376-repo-case-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    const canonicalRepository = 'chetwerikoff/LeoPoker';
    const run = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 160,
      headSha: HEAD_A,
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      canonicalRepository,
    }).run;
    setPackReviewRunTerminal(run.id, 'failed', {
      failureReason: 'fixture-unfinished',
    }, { projectId: 'orchestrator-pack', storeRoot });

    const input = parseArgs([
      '--source-repo-root', '/fixture/leopoker',
      '--repo-slug', 'chetwerikoff/leopoker',
      '--pr-number', '160',
      '--immediate',
    ]);
    let observedReads = 0;
    const repository = await resolvePackReviewReconcileRepository({
      sourceRepoRoot: String(input.sourceRepoRoot),
      explicitRepoSlug: String(input.repoSlug),
      selectedTarget: { repository: canonicalRepository },
      resolveRepository: async () => {
        observedReads += 1;
        return 'chetwerikoff/orchestrator-pack';
      },
    });

    expect(repository).toBe(canonicalRepository);
    expect(observedReads).toBe(0);

    const reconciliation = await reconcileStalePackReviewRuns({
      repoSlug: repository,
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 160,
      fixtureRequiredStatusWriter: async () => {},
    });
    expect(reconciliation.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: run.id }),
    ]));
    expect(reconciliation.results).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: run.id, reason: 'repository_mismatch' }),
    ]));
  });
});

describe('Issue #2376 pre-start credentialed recovery isolation', () => {
  it('leaves unrelated final-cap authority unchanged before an ordinary start claim refusal', async () => {
    const storeRoot = tempRoot('opk-issue-2376-prestart-final-cap-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    const prNumber = 2376;
    const logicalRoundOrdinal = 1;
    const issueBody = '```complexity-tier\ntier: T1\n```';
    const authorityOptions = { storeRoot };
    let authority = initializePackReviewAuthority({
      prNumber,
      headSha: HEAD_A,
      tier: 'T1',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      options: authorityOptions,
    });
    const run = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber,
      headSha: HEAD_A,
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      canonicalRepository: 'chetwerikoff/orchestrator-pack',
      accountingVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      reviewCycleId: authority.cycle!.cycleId,
      logicalRoundOrdinal,
      logicalRoundCap: 1,
      resolvedReviewer: 'gpt',
      automaticBudgetDisposition: 'consume',
    }).run;
    setPackReviewRunTerminal(run.id, 'changes_requested', {
      reviewVerdict: 'findings',
      findingCount: 1,
      findings: [{ severity: 'blocking', title: 'unrelated final-cap finding' }],
      automaticBudgetDisposition: 'consume',
    }, { projectId: 'orchestrator-pack', storeRoot });
    authority = commitPackReviewTerminal({
      prNumber,
      expectedTransitionSeq: authority.transitionSeq,
      terminal: {
        schemaVersion: 1,
        terminalContractVersion: 2,
        terminalSource: 'normal',
        runId: run.id,
        targetSha: HEAD_A,
        reviewVerdict: 'findings',
        findingCount: 1,
        findingsDigest: 'issue-2376-unrelated-final-cap',
        automaticBudgetDisposition: 'consume',
        logicalRoundOrdinal,
      },
      status: 'changes_requested',
      findingCount: 1,
      options: authorityOptions,
    });
    expect(authority.cycle).toMatchObject({
      state: 'at_cap_open_findings',
      consumedRoundOrdinals: [logicalRoundOrdinal],
    });

    const claim = acquireReviewStartClaim({
      projectId: 'orchestrator-pack',
      prNumber,
      headSha: HEAD_B,
      surface: 'fixture-existing-claim',
      startReason: 'fixture-existing-claim',
      reviewRuns: listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot }),
    });
    expect(claim.acquired, JSON.stringify(claim)).toBe(true);

    const result = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: repoRoot,
      prNumber,
      headSha: HEAD_B,
      fixtureCurrentPrHeadSha: HEAD_B,
      fixturePrState: 'OPEN',
      fixturePrBody: `Closes #${prNumber}`,
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureIssueBody: issueBody,
      fixtureIssueNumber: prNumber,
      fixtureChangedPaths: ['scripts/pack-review-runner.ts'],
      fixtureBoundIssueSnapshotBytes: issueBody,
      fixtureRequiredStatusWriter: async () => {},
    });

    expect(result).toMatchObject({
      ok: false,
      created: false,
      reused: true,
      reason: 'claimed',
    });
    const after = readPackReviewAuthority(prNumber, authorityOptions);
    expect(after?.currentHeadSha).toBe(HEAD_A);
    expect(after?.cycle).toMatchObject({
      state: 'at_cap_open_findings',
      consumedRoundOrdinals: [logicalRoundOrdinal],
    });
    expect(after?.cycle?.reviewStageComplete).not.toBe(true);
  });
});

describe('programmatic pack-review project binding', () => {
  it('overrides absent or stale ambient selection with the runner project id', () => {
    expect(bindReviewerProjectSelection({}, 'leopoker')).toEqual({ OPK_PROJECT_ID: 'leopoker' });
    expect(bindReviewerProjectSelection({ OPK_PROJECT_ID: 'orchestrator-pack', PATH: '/bin' }, 'leopoker'))
      .toEqual({ OPK_PROJECT_ID: 'leopoker', PATH: '/bin' });
  });
});

describe('canonical Browser-GPT PR command (Issue #1111)', () => {
  it('accepts PR number with optional project/session binding and rejects caller-supplied head SHA', () => {
    expect(parsePackGptReviewArgs(['--pr-number', '1111'])).toEqual({
      prNumber: 1111,
      timeoutSeconds: undefined,
    });
    expect(parsePackGptReviewArgs([
      '--project', 'leopoker',
      '--session-id', 'leopoker-mgr-145',
      '--pr-number', '1111',
    ])).toEqual({
      prNumber: 1111,
      projectId: 'leopoker',
      sessionId: 'leopoker-mgr-145',
      timeoutSeconds: undefined,
    });
    expect(() => parsePackGptReviewArgs([])).toThrow('--pr-number is required');
    expect(() => parsePackGptReviewArgs(['--session-id'])).toThrow('--session-id requires a value');
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

  it('keeps canonical --project selection through the runner when ambient OPK_PROJECT_ID is absent', () => {
    const fixtureRoot = tempRoot('opk-issue-2346-explicit-project-');
    const commandRoot = tempRoot('opk-issue-2346-explicit-project-gh-');
    writeClosedPrGhFixture(commandRoot);
    const configHome = path.join(fixtureRoot, 'config');
    const projects = path.join(configHome, 'orchestrator-pack', 'projects');
    mkdirSync(projects, { recursive: true });
    writeFileSync(path.join(projects, 'orchestrator-pack.json'), JSON.stringify({
      projectId: 'orchestrator-pack',
      repository: 'chetwerikoff/orchestrator-pack',
      primaryRoot: repoRoot,
      defaultBranch: 'main',
      orcaWorkspacePattern: 'orca/workspaces/orchestrator-pack/',
      orchestratorTitlePattern: 'orchestrator-pack',
      browserGpt: { projectUrl: 'https://chatgpt.com/g/orchestrator-pack/project' },
    }), 'utf8');
    const childEnv = {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      PATH: `${commandRoot}${path.delimiter}${process.env.PATH ?? ''}`,
      GH_HOST: 'git.example.test',
      npm_config_update_notifier: 'false',
    };
    delete childEnv.OPK_PROJECT_ID;
    delete childEnv.OPK_VITEST_HARNESS;

    const result = runProcessSync({
      command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
      args: ['run', '--silent', 'pack-gpt-review', '--', '--project', 'orchestrator-pack', '--pr-number', '1111'],
      cwd: repoRoot,
      encoding: 'utf8',
      env: childEnv,
    });

    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(payload).toMatchObject({ ok: false, outcome: 'review_target_unavailable', prNumber: 1111 });
    expect(String(payload.reason)).not.toContain('missing-selection');
    expect(String(payload.reason)).toContain('gh api PR read 1111');
    expect(String(payload.reason)).toContain(
      'target gh host mismatch from GH_HOST: expected github.com, got git.example.test',
    );
  });

  it('forwards only an explicit launch-session binding to the review start', async () => {
    const starts: Array<Parameters<typeof startPackReview>[0]> = [];
    const startReview = async (input: Parameters<typeof startPackReview>[0]) => {
      starts.push(input);
      return {
        ok: true,
        created: true,
        reused: false,
        reason: 'completed',
        prNumber: 1111,
        headSha: HEAD_A,
        publicationHeadSha: HEAD_A,
        publicationVerified: true,
        runId: `prr-session-${starts.length}`,
        status: 'up_to_date',
      };
    };

    const bound = await runPackGptReviewCommand({
      prNumber: 1111,
      sessionId: 'leopoker-mgr-145',
      timeoutSeconds: 37,
    }, {
      env: {},
      stderr: { write: () => undefined },
      startReview,
    });
    const unbound = await runPackGptReviewCommand({
      prNumber: 1111,
      timeoutSeconds: 37,
    }, {
      env: {},
      stderr: { write: () => undefined },
      startReview,
    });

    expect(bound.exitCode).toBe(0);
    expect(unbound.exitCode).toBe(0);
    expect(bound.result).toMatchObject({
      publicationVerified: true, publicationHeadSha: HEAD_A, reason: 'completed',
    });
    expect(starts[0]).toMatchObject({
      prNumber: 1111,
      sessionId: 'leopoker-mgr-145',
      startReason: 'manual-browser-gpt',
      surface: 'pack-gpt-review',
    });
    expect(starts[1]).not.toHaveProperty('sessionId');
  });

  it('delivers a cross-project manual review notification to the launching session', async () => {
    const storeRoot = tempRoot('opk-issue-2372-cross-project-');
    const reviewCapture = path.join(storeRoot, 'github-review.json');
    const notificationCapture = path.join(storeRoot, 'worker-notification.json');
    harnessEnv(storeRoot, reviewCapture);
    process.env.OPK_REVIEW_CLAIM_DIR = path.join(
      storeRoot,
      'ao-base',
      'projects',
      'leopoker',
      'review-start-claims',
    );
    process.env.PACK_REVIEW_WORKER_NOTIFICATION_CAPTURE_FILE = notificationCapture;

    const result = await startPackReview({
      projectId: 'leopoker',
      storeRoot,
      sourceRepoRoot: repoRoot,
      sessionId: 'leopoker-mgr-145',
      prNumber: 1111,
      headSha: HEAD_A,
      startReason: 'manual-browser-gpt',
      surface: 'pack-gpt-review',
      fixtureCurrentPrHeadSha: HEAD_A,
      fixturePrState: 'OPEN',
      fixtureRepoSlug: 'chetwerikoff/LeoPoker',
      fixturePostReviewHeadSha: HEAD_A,
      fixtureReviewBySourceSlot: {
        'source-01': [{ stdout: successfulCleanReviewPayload('inv-2372-source-01') }],
        'source-02': [{ stdout: successfulCleanReviewPayload('inv-2372-source-02') }],
        'source-03': [{ stdout: successfulCleanReviewPayload('inv-2372-source-03') }],
      },
      fixtureIssueBody: '```complexity-tier\ntier: T1\n```',
      fixtureIssueNumber: 2372,
    });

    expect(result).toMatchObject({ ok: true, created: true });
    const runs = listPackReviewRuns({ projectId: 'leopoker', storeRoot });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      projectId: 'leopoker',
      linkedSessionId: 'leopoker-mgr-145',
      deliveryOutcomes: {
        workerNotification: { state: 'succeeded' },
      },
    });
    expect(JSON.parse(readFileSync(notificationCapture, 'utf8'))).toMatchObject({
      workerId: 'leopoker-mgr-145',
    });
  });

  it('resolves a PR-only target without imposing GPT and emits one start indication', async () => {
    const storeRoot = tempRoot('opk-issue-1111-fresh-');
    const capture = path.join(storeRoot, 'github-review.json');
    const engagement = path.join(storeRoot, 'gpt-engagements.jsonl');
    const invocationLog = path.join(storeRoot, 'invocations.jsonl');
    harnessEnv(storeRoot, capture);
    process.env.PACK_REVIEWER = 'codex';
    process.env.XDG_CONFIG_HOME = path.join(storeRoot, 'isolated-reviewer-config');
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
    // The fixture's Win32 legacy User layer is claude; route name must not
    // substitute GPT (or process-layer codex) for the real selector.
    expect(JSON.parse(readFileSync(invocationLog, 'utf8').trim()).reviewer).toBe('claude');
    expect(engagementCount(engagement)).toBe(0);
    expect(execution.result).toMatchObject({
      resolvedReviewer: 'claude',
      resolvedReviewerSource: 'legacy-env',
      executedReviewer: 'claude',
      reviewerInvokedForThisRun: true,
      reason: 'completed',
      httpStatus: 201,
    });
    // Native result retains the pre-#2496 acknowledged-delivery shape;
    // the GPT-only publication proof is not retroactively imposed on Claude.
    expect(execution.result).not.toHaveProperty('publicationVerified');
    expect(process.env.PACK_REVIEWER).toBe('codex');
    expect(process.env[PACK_REVIEW_BOUND_REVIEWER_ENV]).toBeUndefined();
  });

  it.each([403, 404] as const)(
    'admits manual start on HTTP %i protection lookup only when project-card requiredCi proves the same head green',
    async (policyStatus) => {
      const storeRoot = tempRoot(`opk-issue-2346-card-${policyStatus}-green-`);
      const capture = path.join(storeRoot, 'github-review.json');
      harnessEnv(storeRoot, capture);

      const execution = await runPackGptReviewCommand({ prNumber: 1111 }, {
        env: process.env,
        stderr: { write: () => undefined },
        startReview: canonicalCommandRunner(storeRoot, {
          fixtureRequiredCi: ['CI / checks'],
          fixtureRequiredCiPolicy: null,
          fixtureRequiredCiPolicyHttpStatus: policyStatus,
          fixtureRequiredCiChecks: [
            { workflow: 'CI', name: 'checks', state: 'SUCCESS' },
          ],
        }),
      });

      expect(execution.exitCode).toBe(0);
      expect(execution.result).toMatchObject({
        ok: true,
        created: true,
      });
      expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })).toEqual([
        expect.objectContaining({
          prNumber: 1111,
          headSha: HEAD_A,
        }),
      ]);
    },
  );

  it('does not retain the Issue #2344 bare-check fallback when protection is unavailable and the card has no requiredCi', async () => {
    const storeRoot = tempRoot('opk-issue-2346-no-card-403-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    const execution = await runPackGptReviewCommand({ prNumber: 1111 }, {
      env: process.env,
      stderr: { write: () => undefined },
      startReview: canonicalCommandRunner(storeRoot, {
        fixtureRequiredCiPolicy: null,
        fixtureRequiredCiPolicyHttpStatus: 403,
        fixtureRequiredCiChecks: [{ workflow: 'CI', name: 'checks', state: 'SUCCESS' }],
      }),
    });
    expect(execution.exitCode).toBe(1);
    expect(execution.result).toMatchObject({
      runnerReason: 'required_ci_not_green_for_current_head',
    });
  });

  it.each([
    ['pending', 'PENDING'],
    ['failed', 'FAILURE'],
  ] as const)(
    'refuses manual start on HTTP 403 policy lookup when checks is %s',
    async (_label, state) => {
      const storeRoot = tempRoot(`opk-issue-2344-policy-403-${state.toLowerCase()}-`);
      const capture = path.join(storeRoot, 'github-review.json');
      harnessEnv(storeRoot, capture);

      const execution = await runPackGptReviewCommand({ prNumber: 1111 }, {
        env: process.env,
        stderr: { write: () => undefined },
        startReview: canonicalCommandRunner(storeRoot, {
          fixtureRequiredCi: ['CI / checks'],
          fixtureRequiredCiPolicy: null,
          fixtureRequiredCiPolicyHttpStatus: 403,
          fixtureRequiredCiChecks: [
            { workflow: 'CI', name: 'checks', state },
          ],
        }),
      });

      expect(execution.exitCode).toBe(1);
      expect(execution.result).toMatchObject({
        reason: 'review_not_started',
        runnerReason: 'required_ci_not_green_for_current_head',
        prNumber: 1111,
        headSha: HEAD_A,
      });
      expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })).toHaveLength(0);
    },
  );

  it('keeps unrelated required-status policy lookup failures fail-closed', async () => {
    const storeRoot = tempRoot('opk-issue-2344-policy-500-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);

    const execution = await runPackGptReviewCommand({ prNumber: 1111 }, {
      env: process.env,
      stderr: { write: () => undefined },
      startReview: canonicalCommandRunner(storeRoot, {
        fixtureRequiredCiPolicy: null,
        fixtureRequiredCiPolicyHttpStatus: 500,
        fixtureRequiredCiChecks: [
          { name: 'checks', state: 'SUCCESS' },
        ],
      }),
    });

    expect(execution.exitCode).toBe(1);
    expect(execution.result).toMatchObject({
      reason: 'review_not_started',
      runnerReason: 'required_ci_not_green_for_current_head',
      prNumber: 1111,
      headSha: HEAD_A,
    });
    expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })).toHaveLength(0);
  });

  it.each([
    ['pending', 'PENDING'],
    ['failed', 'FAILURE'],
    ['cancelled', 'CANCELLED'],
  ] as const)('refuses manual start when a required review-independent check is %s', async (_label, state) => {
    const storeRoot = tempRoot('opk-issue-1958-ci-refusal-');
    const capture = path.join(storeRoot, 'github-review.json');
    const engagement = path.join(storeRoot, 'gpt-engagements.jsonl');
    harnessEnv(storeRoot, capture);
    process.env.PACK_REVIEW_RUNNER_GPT_ENGAGEMENT_FILE = engagement;

    const execution = await runPackGptReviewCommand({ prNumber: 1111 }, {
      env: process.env,
      stderr: { write: () => undefined },
      startReview: canonicalCommandRunner(storeRoot, {
        fixtureRequiredCiChecks: [
          { name: 'verify orchestrator-pack structure', state },
          { name: 'pr scope guard', state: 'SUCCESS' },
          { name: 'orchestrator-pack/pack-review', state: 'PENDING' },
        ],
      }),
    });

    expect(execution.exitCode).toBe(1);
    expect(execution.result).toMatchObject({
      created: false,
      outcome: 'review_not_started',
      reason: 'review_not_started',
      runnerReason: 'required_ci_not_green_for_current_head',
      prNumber: 1111,
      headSha: HEAD_A,
    });
    expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })).toHaveLength(0);
    expect(engagementCount(engagement)).toBe(0);
  });

  it('refuses missing required CI and exact-head drift before review admission', async () => {
    const storeRoot = tempRoot('opk-issue-1958-ci-missing-drift-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);

    const unprovable = await runPackGptReviewCommand({ prNumber: 1111 }, {
      env: process.env,
      stderr: { write: () => undefined },
      startReview: canonicalCommandRunner(storeRoot, {
        fixtureRequiredCiPolicy: null,
      }),
    });
    expect(unprovable.result).toMatchObject({
      reason: 'review_not_started',
      runnerReason: 'required_ci_not_green_for_current_head',
    });

    const missing = await runPackGptReviewCommand({ prNumber: 1111 }, {
      env: process.env,
      stderr: { write: () => undefined },
      startReview: canonicalCommandRunner(storeRoot, {
        fixtureRequiredCiChecks: [
          { name: 'verify orchestrator-pack structure', state: 'SUCCESS' },
          { name: 'orchestrator-pack/pack-review', state: 'SUCCESS' },
        ],
      }),
    });
    expect(missing.result).toMatchObject({
      reason: 'review_not_started',
      runnerReason: 'required_ci_not_green_for_current_head',
    });

    const drifted = await runPackGptReviewCommand({ prNumber: 1111 }, {
      env: process.env,
      stderr: { write: () => undefined },
      startReview: canonicalCommandRunner(storeRoot, {
        fixtureRequiredCiPostProjectionHead: HEAD_A,
        fixtureRequiredCiHeadAfterGate: HEAD_B,
      }),
    });
    expect(drifted.result).toMatchObject({
      reason: 'review_not_started',
      runnerReason: 'required_ci_not_green_for_current_head',
    });

    const retargeted = await runPackGptReviewCommand({ prNumber: 1111 }, {
      env: process.env,
      stderr: { write: () => undefined },
      startReview: canonicalCommandRunner(storeRoot, {
        fixtureRequiredCiPostProjectionHead: HEAD_A,
        fixtureRequiredCiPostProjectionBase: 'main',
        fixtureRequiredCiHeadAfterGate: HEAD_A,
        fixtureRequiredCiBaseAfterGate: 'release',
      }),
    });
    expect(retargeted.result).toMatchObject({
      reason: 'review_not_started',
      runnerReason: 'required_ci_not_green_for_current_head',
    });
    expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })).toHaveLength(0);
  });

  it('refuses non-green CI before mutating an existing stale run', async () => {
    const storeRoot = tempRoot('opk-issue-1958-ci-stale-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    const old = new Date(Date.now() - 10 * 60_000);
    const seeded = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      now: old,
      prNumber: 1111,
      headSha: HEAD_A,
      linkedSessionId: 'fixture-stale-run',
      startReason: 'fixture-stale-run',
      surface: 'fixture-stale-run',
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      canonicalRepository: 'chetwerikoff/orchestrator-pack',
    }).run;
    updatePackReviewRun(seeded.id, { runnerPid: 2147483647 }, {
      projectId: 'orchestrator-pack',
      storeRoot,
      now: old,
    });
    const before = readFileSync(path.join(storeRoot, 'runs', `${seeded.id}.json`), 'utf8');

    const execution = await runPackGptReviewCommand({ prNumber: 1111 }, {
      env: process.env,
      stderr: { write: () => undefined },
      startReview: canonicalCommandRunner(storeRoot, {
        fixtureRequiredCiChecks: [
          { name: 'verify orchestrator-pack structure', state: 'FAILURE' },
          { name: 'pr scope guard', state: 'SUCCESS' },
        ],
      }),
    });

    expect(execution.result).toMatchObject({
      reason: 'review_not_started',
      runnerReason: 'required_ci_not_green_for_current_head',
    });
    expect(readFileSync(path.join(storeRoot, 'runs', `${seeded.id}.json`), 'utf8')).toBe(before);
    expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })).toHaveLength(1);
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

    const first = await runPackGptReviewCommand({ prNumber: 1111, reviewer: 'gpt' }, {
      env: process.env,
      stderr: { write: () => undefined },
      startReview: canonicalCommandRunner(storeRoot),
    });
    const secondStderr: string[] = [];
    const second = await runPackGptReviewCommand({ prNumber: 1111, reviewer: 'gpt' }, {
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

  it.each(['early-send', 'late-send', 'pre-send-terminal', 'possible-delivery'] as const)(
    'paces three exact source admissions with parallel generation (%s)', async (mode) => {
      const storeRoot = tempRoot('opk-gpt-admission-2426-');
      const capture = path.join(storeRoot, 'github-review.json');
      harnessEnv(storeRoot, capture);
      selectProjectCard(storeRoot);
      delete process.env.PACK_GPT_BROWSER_PROJECT_URL;
      process.env.PACK_GPT_BROWSER_PROFILE = path.join(storeRoot, 'browser-profile');
      process.env.PACK_GPT_BROWSER_CDP = 'http://127.0.0.1:9222';
      delete process.env.PACK_GPT_BROWSER_CHAT_URL;
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const trace: Array<{ slotId: string; invocationId: string; at: number }> = [];
      const witnesses = new Map<string, number>();
      const releases: Array<() => void> = [];
      const fixtures: Record<string, Array<{ stdout: string; exitCode: number }>> = {};
      const readObservation = vi.fn((profileKey: string, invocationId: string) => ({
        profile_key: profileKey, invocation_id: invocationId,
        send_count: witnesses.get(invocationId), phase: 'sent_unharvested',
      }));
      const pending = startPackReview(pluralStart(storeRoot, capture, {
        fixtureGptAdmissionReadObservation: readObservation,
        fixtureReviewBySourceSlot: fixtures,
        fixtureAfterGptInvocationBound: async ({ slotId, invocationId }: { slotId: string; invocationId: string }) => {
          trace.push({ slotId, invocationId, at: Date.now() });
          fixtures[slotId] = [{ stdout: successfulCleanReviewPayload(invocationId), exitCode: 0 }];
          if (slotId === 'source-01' && (mode === 'pre-send-terminal' || mode === 'possible-delivery')) {
            fixtures[slotId] = [{ stdout: JSON.stringify({
              schema: 'turn-result/v1', state: 'driver_error', scope: 'invocation',
              cause: mode === 'possible-delivery' ? 'send_delivery_unproven' : 'pre_send_refused',
              invocation_id: invocationId, send_count: 0, send_attempted: mode === 'possible-delivery',
            }), exitCode: 1 }];
            return;
          }
          await new Promise<void>((resolve) => releases.push(resolve));
        },
      }));
      await vi.waitFor(() => expect(trace.length).toBeGreaterThan(0));
      expect(trace).toHaveLength(1);
      const first = trace[0]!;
      if (mode === 'early-send') witnesses.set(first.invocationId, 1);
      await vi.advanceTimersByTimeAsync(29_000);
      expect(trace).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      if (mode === 'late-send') {
        expect(trace).toHaveLength(1);
        // Foreign profile/invocation and non-exact numeric counts cannot open the gate.
        readObservation.mockImplementation((profileKey, invocationId) => ({
          profile_key: `${profileKey}-foreign`, invocation_id: invocationId, send_count: 1, phase: 'sent_unharvested',
        }));
        await vi.advanceTimersByTimeAsync(2_000);
        expect(trace).toHaveLength(1);
        readObservation.mockImplementation((profileKey, invocationId) => ({
          profile_key: profileKey, invocation_id: invocationId, send_count: 2, phase: 'sent_unharvested',
        }));
        await vi.advanceTimersByTimeAsync(1_000);
        expect(trace).toHaveLength(1);
        readObservation.mockImplementation((profileKey, invocationId) => ({
          profile_key: profileKey, invocation_id: invocationId, send_count: witnesses.get(invocationId), phase: 'sent_unharvested',
        }));
        witnesses.set(first.invocationId, 1);
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await vi.waitFor(() => expect(trace).toHaveLength(2));
      // Neither bound callback has completed: the sent source is still generating.
      expect(releases).toHaveLength(mode.endsWith('terminal') || mode === 'possible-delivery' ? 1 : 2);
      const second = trace[1]!;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(trace).toHaveLength(2);
      witnesses.set(second.invocationId, 1);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(trace).toHaveLength(3));
      expect(trace.map((entry) => entry.slotId)).toEqual(['source-01', 'source-02', 'source-03']);
      expect(new Set(trace.map((entry) => entry.invocationId)).size).toBe(3);
      expect(trace[1]!.at - first.at).toBeGreaterThanOrEqual(30_000);
      expect(trace[2]!.at - second.at).toBeGreaterThanOrEqual(30_000);
      releases.forEach((release) => release());
      const result = await pending;
      const run = getPackReviewRun(String(result.runId), { projectId: 'orchestrator-pack', storeRoot });
      expect(run?.reviewRound?.sourceSlots.map((slot) => slot.attemptOrdinal)).toEqual([1, 1, 1]);
      if (mode === 'possible-delivery') {
        expect(run?.reviewRound?.sourceSlots[0]?.terminalClass).toBe('possible_delivery');
        expect(run?.reviewRound?.sourceSlots[0]?.terminalResult).toMatchObject({ send_count: 0, send_attempted: true });
      }
    },
  );

  it.each([true, false].flatMap((published) => [true, false].map((sendAttempted) => ({ published, sendAttempted }))))(
    'censuses attempted zero-count sources without a second send (published $published, attempt flag $sendAttempted)', async ({ published, sendAttempted }) => {
    const storeRoot = tempRoot('opk-gpt-attempted-zero-census-');
    const capture = path.join(storeRoot, 'github-review.json');
    const invocationLog = path.join(storeRoot, 'invocations.jsonl');
    harnessEnv(storeRoot, capture);
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;
    process.env.PACK_REVIEW_RUNNER_INVOCATION_LOG = invocationLog;
    const comments: PackGptSourceGithubComment[] = [];
    const fixtures: Record<string, Array<{ stdout: string; exitCode: number }>> = {};
    const sourceTransport: PackGptSourceCommentTransport = {
      resolveActorLogin: async () => 'browser-gpt-bot',
      listComments: async () => comments,
      getComment: async (id) => comments.find((comment) => comment.id === id)!,
    };
    const censusSlots: string[] = [];
    const result = await startPackReview(pluralStart(storeRoot, capture, {
      fixtureGptSourceCommentTransport: sourceTransport,
      fixtureReviewBySourceSlot: fixtures,
      fixtureAfterGptInvocationBound: ({ slotId, invocationId }: { slotId: string; invocationId: string }) => {
        fixtures[slotId] = [{ stdout: JSON.stringify({
          schema: 'turn-result/v1', state: 'send_failed', scope: 'invocation',
          cause: 'send_delivery_unproven', invocation_id: invocationId, send_count: 0,
          ...(sendAttempted ? { send_attempted: true } : {}),
        }), exitCode: 1 }];
        if (published) {
          const id = 2424000 + comments.length;
          const identity: PackGptSourceIdentity = {
            repository: 'chetwerikoff/orchestrator-pack', prNumber: 1276, headSha: HEAD_A,
            runId: listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })[0]!.id, slotId, invocationId,
          };
          comments.push({ id, body: formatPackGptSourceCommentEnvelope(identity, 'NO_FINDINGS'),
            actorLogin: 'browser-gpt-bot', createdAt: '2026-08-29T03:01:00.000Z', updatedAt: '2026-08-29T03:01:00.000Z',
            url: `https://github.com/chetwerikoff/orchestrator-pack/pull/1276#issuecomment-${id}`,
            issueUrl: 'https://api.github.com/repos/chetwerikoff/orchestrator-pack/issues/1276',
          });
        }
      },
      fixtureBeforeGptSourceCommentCensus: ({ slotId }: { slotId: string }) => { censusSlots.push(slotId); },
    }));
    const run = getPackReviewRun(String(result.runId), { projectId: 'orchestrator-pack', storeRoot });
    expect(censusSlots).toEqual(['source-01', 'source-02', 'source-03']);
    expect(engagementCount(invocationLog)).toBe(3);
    expect(run?.reviewRound?.sourceSlots.map((slot) => slot.attemptOrdinal)).toEqual([1, 1, 1]);
    expect(run?.reviewRound?.sourceSlots.map((slot) => slot.terminalClass), JSON.stringify(result)).toEqual(
      Array(3).fill(published ? 'complete_clean' : sendAttempted ? 'possible_delivery' : 'send_failed:send_delivery_unproven'),
    );
    expect(run?.reviewRound?.sourceSlots.every((slot) => {
      const terminal = slot.terminalResult as any;
      return (published ? terminal.browser_terminal?.send_count : terminal.send_count) === 0;
    })).toBe(true);
    if (published) expect(result).toMatchObject({ status: 'up_to_date', coverage: { completedSourceCount: 3 } });
    },
  );

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
    expect(String(result.reason)).toMatch(/plural GPT review forbids a fixed chat URL/);
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

  it('preserves a 2/3 partial after one zero-send source exhausts its retry', async () => {
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
      ok: true,
      status: 'reviewing',
      reason: 'gpt_sources_partial_pending_reconcile:2/3',
      coverage: {
        kind: 'partial',
        completedSourceCount: 2,
        cardinality: 3,
      },
    });
    expect(run?.status).toBe('reviewing');
    expect(run?.failureReason).toBeUndefined();
    expect(run?.reviewRound?.settledSourceCount).toBeUndefined();
    expect(run?.reviewVerdict).toBeUndefined();
    expect(() => readFileSync(capture, 'utf8')).toThrow();
  });

  it('continues the same durable GPT round and relaunches only unresolved source slots', async () => {
    const storeRoot = tempRoot('opk-gpt-same-round-continuation-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;

    const first = await startPackReview(pluralStart(storeRoot, capture, {
      fixtureReviewBySourceSlot: {
        'source-01': [{ stdout: successfulCleanReviewPayload('inv-source-01') }],
        'source-02': [
          { stdout: terminalTurnPayload({ state: 'profile_busy', cause: 'profile_busy' }), exitCode: 13 },
          { stdout: terminalTurnPayload({ state: 'profile_busy', cause: 'profile_busy' }), exitCode: 13 },
        ],
        'source-03': [{ stdout: successfulCleanReviewPayload('inv-source-03') }],
      },
    }));
    expect(first).toMatchObject({
      ok: true,
      status: 'reviewing',
      coverage: { kind: 'partial', completedSourceCount: 2, cardinality: 3 },
    });
    const firstRunId = String(first.runId);
    const before = getPackReviewRun(firstRunId, { projectId: 'orchestrator-pack', storeRoot });
    expect(before?.reviewRound?.sourceSlots.map((slot) => slot.attemptOrdinal)).toEqual([1, 2, 1]);
    const completedBefore = before!.reviewRound!.sourceSlots
      .filter((slot) => slot.slotId !== 'source-02')
      .map((slot) => ({ slotId: slot.slotId, invocationId: slot.invocationId, payload: slot.payload }));
    const replacedBefore = before!.reviewRound!.sourceSlots.find((slot) => slot.slotId === 'source-02')!;

    const relaunched: string[] = [];
    const second = await startPackReview(pluralStart(storeRoot, capture, {
      fixtureGptAttemptObserver: async () => ({
        state: 'replacement_eligible' as const,
        replacementEligible: true,
        slotId: 'source-02',
      }),
      fixtureAfterGptInvocationBound: async ({ slotId }) => { relaunched.push(slotId); },
      fixtureReviewBySourceSlot: {
        'source-02': [{ stdout: successfulCleanReviewPayload('inv-source-02-replacement') }],
      },
    }));

    expect(second.ok).toBe(true);
    expect(second.runId).toBe(firstRunId);
    expect(relaunched).toEqual(['source-02']);
    const after = getPackReviewRun(firstRunId, { projectId: 'orchestrator-pack', storeRoot });
    expect(after?.reviewRound?.sourceSlots.map((slot) => slot.attemptOrdinal)).toEqual([1, 3, 1]);
    const replacedAfter = after!.reviewRound!.sourceSlots.find((slot) => slot.slotId === 'source-02')!;
    expect(replacedAfter.invocationId).not.toBe(replacedBefore.invocationId);
    expect(replacedAfter.attemptHistory).toEqual([{
      invocationId: replacedBefore.invocationId,
      attemptOrdinal: replacedBefore.attemptOrdinal,
      terminalClass: replacedBefore.terminalClass,
    }]);
    expect(after?.reviewRound?.sourceSlots.every((slot) => slot.terminalClass === 'complete_clean')).toBe(true);
    expect(after!.reviewRound!.sourceSlots
      .filter((slot) => slot.slotId !== 'source-02')
      .map((slot) => ({ slotId: slot.slotId, invocationId: slot.invocationId, payload: slot.payload })))
      .toEqual(completedBefore);
  });
  it('does not let an unverdicted same-round GPT run on an older head block a run on the current head', async () => {
    const storeRoot = tempRoot('opk-gpt-same-round-other-head-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;

    const first = await startPackReview(pluralStart(storeRoot, capture, {
      fixtureReviewBySourceSlot: {
        'source-01': [{ stdout: successfulCleanReviewPayload('inv-source-01') }],
        'source-02': [
          { stdout: terminalTurnPayload({ state: 'profile_busy', cause: 'profile_busy' }), exitCode: 13 },
          { stdout: terminalTurnPayload({ state: 'profile_busy', cause: 'profile_busy' }), exitCode: 13 },
        ],
        'source-03': [{ stdout: successfulCleanReviewPayload('inv-source-03') }],
      },
    }));
    expect(first).toMatchObject({ ok: true, status: 'reviewing' });
    const firstRunId = String(first.runId);
    const recoveryObserver = async () => ({
      state: 'reply_recovery_required' as const,
      replacementEligible: false,
    });

    const sameHead = await startPackReview(pluralStart(storeRoot, capture, {
      fixtureGptAttemptObserver: recoveryObserver,
    }));
    expect(sameHead).toMatchObject({
      ok: false,
      reused: true,
      reason: 'reply_recovery_required',
      runId: firstRunId,
    });

    const newHead = await startPackReview(pluralStart(storeRoot, capture, {
      headSha: HEAD_B,
      fixtureCurrentPrHeadSha: HEAD_B,
      fixturePostReviewHeadSha: HEAD_B,
      fixtureGptAttemptObserver: recoveryObserver,
      fixtureReviewBySourceSlot: {
        'source-01': [{ stdout: successfulCleanReviewPayload('inv-b-source-01') }],
        'source-02': [{ stdout: successfulCleanReviewPayload('inv-b-source-02') }],
        'source-03': [{ stdout: successfulCleanReviewPayload('inv-b-source-03') }],
      },
    }));
    expect(newHead.reason).not.toBe('reply_recovery_required');
    expect(newHead.created).toBe(true);
    expect(newHead.runId).not.toBe(firstRunId);
    expect(getPackReviewRun(String(newHead.runId), { projectId: 'orchestrator-pack', storeRoot })?.targetSha)
      .toBe(HEAD_B);
  });

  it('does not relaunch an unresolved GPT sibling whose own replacement gate is still closed', async () => {
    const storeRoot = tempRoot('opk-gpt-slot-scoped-replacement-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;

    const blocked = (invocationId: string) => ({
      stdout: terminalTurnPayload({ state: 'profile_busy', cause: 'profile_busy', invocationId }),
      exitCode: 13,
    });
    const first = await startPackReview(pluralStart(storeRoot, capture, {
      fixtureReviewBySourceSlot: {
        'source-01': [blocked('inv-source-01-a'), blocked('inv-source-01-b')],
        'source-02': [blocked('inv-source-02-a'), blocked('inv-source-02-b')],
        'source-03': [{ stdout: successfulCleanReviewPayload('inv-source-03') }],
      },
    }));
    expect(first).toMatchObject({
      ok: true,
      status: 'reviewing',
      coverage: { kind: 'partial', completedSourceCount: 1, cardinality: 3 },
    });
    const firstRunId = String(first.runId);
    const before = getPackReviewRun(firstRunId, { projectId: 'orchestrator-pack', storeRoot });
    const protectedSibling = before!.reviewRound!.sourceSlots.find((slot) => slot.slotId === 'source-02')!;

    const relaunched: string[] = [];
    const second = await startPackReview(pluralStart(storeRoot, capture, {
      fixtureGptAttemptObserver: async () => ({
        state: 'replacement_eligible' as const,
        replacementEligible: true,
        slotId: 'source-01',
        replacementEligibleSlotIds: ['source-01'],
      }),
      fixtureAfterGptInvocationBound: async ({ slotId }) => { relaunched.push(slotId); },
      fixtureReviewBySourceSlot: {
        'source-01': [{ stdout: successfulCleanReviewPayload('inv-source-01-replacement') }],
      },
    }));

    expect(second.ok).toBe(true);
    expect(second.runId).toBe(firstRunId);
    expect(relaunched).toEqual(['source-01']);
    const after = getPackReviewRun(firstRunId, { projectId: 'orchestrator-pack', storeRoot });
    const stillProtected = after!.reviewRound!.sourceSlots.find((slot) => slot.slotId === 'source-02')!;
    expect(stillProtected.attemptOrdinal).toBe(protectedSibling.attemptOrdinal);
    expect(stillProtected.invocationId).toBe(protectedSibling.invocationId);
    expect(stillProtected.terminalClass).toBe(protectedSibling.terminalClass);
  });

  it('fails an explicitly reconciled 1/3 partial after grace with the recovery reason', async () => {
    const storeRoot = tempRoot('opk-gpt-one-of-three-after-grace-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;
    process.env.PACK_REVIEW_RUN_STALE_MINUTES = '2';
    const statuses: Array<{ state: string; description?: string }> = [];

    const result = await startPackReview(pluralStart(storeRoot, capture, {
      fixtureRequiredStatusWriter: async (request) => {
        statuses.push({ state: request.state, description: request.description });
      },
      fixtureReviewBySourceSlot: {
        'source-01': [{ stdout: successfulCleanReviewPayload('inv-source-01') }],
        'source-02': [
          { stdout: terminalTurnPayload({ state: 'profile_busy', cause: 'profile_busy', invocationId: 'inv-source-02-a' }), exitCode: 13 },
          { stdout: terminalTurnPayload({ state: 'profile_busy', cause: 'profile_busy', invocationId: 'inv-source-02-b' }), exitCode: 13 },
        ],
        'source-03': [
          { stdout: terminalTurnPayload({ state: 'profile_busy', cause: 'profile_busy', invocationId: 'inv-source-03-a' }), exitCode: 13 },
          { stdout: terminalTurnPayload({ state: 'profile_busy', cause: 'profile_busy', invocationId: 'inv-source-03-b' }), exitCode: 13 },
        ],
      },
    }));
    expect(result).toMatchObject({
      ok: true,
      status: 'reviewing',
      coverage: { kind: 'partial', completedSourceCount: 1, cardinality: 3 },
    });

    const runId = String(result.runId);
    const current = getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot });
    expect(current?.reviewRound).toBeDefined();
    const admissions = current!.reviewRound!.sourceSlots
      .map((slot) => Date.parse(slot.admissionStartedAtUtc ?? ''))
      .filter((value) => Number.isFinite(value));
    expect(admissions.length).toBeGreaterThan(0);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Math.min(...admissions) + 3 * 60_000));

    const emptySourceTransport: PackGptSourceCommentTransport = {
      resolveActorLogin: async () => 'browser-gpt-bot',
      listComments: async () => [],
      getComment: async () => { throw new Error('unexpected source comment reread'); },
    };
    const reconciliation = await reconcileStalePackReviewRuns({
      repoSlug: 'chetwerikoff/orchestrator-pack',
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1276,
      immediate: true,
      fixtureCurrentPrHeadSha: HEAD_A,
      fixtureGptSourceCommentTransport: emptySourceTransport,
      fixtureRequiredStatusWriter: async (request) => {
        statuses.push({ state: request.state, description: request.description });
      },
    });

    expect(reconciliation.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId,
        terminalized: true,
        statusReconciled: true,
        reason: 'gpt_sources_incomplete_after_grace:1/3',
        status: 'failed',
        coverage: expect.objectContaining({
          kind: 'partial',
          completedSourceCount: 1,
          cardinality: 3,
        }),
      }),
    ]));
    expect(getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot })).toMatchObject({
      status: 'failed',
      failureReason: 'gpt_sources_incomplete_after_grace:1/3',
    });
    expect(statuses.map((request) => request.state)).toEqual(['pending', 'error']);
    expect(statuses.at(-1)?.description).toContain('partial source evidence (1/3)');
  });

  it.each([1, 2])('does not let non-immediate stale reconciliation settle an ordinary %i/3 partial after grace', async (completedCount) => {
    const storeRoot = tempRoot(`opk-gpt-non-immediate-partial-${completedCount}-`);
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;
    process.env.PACK_REVIEW_RUN_STALE_MINUTES = '2';

    const result = await startPackReview(pluralStart(storeRoot, capture, {
      fixtureReviewBySourceSlot: {
        'source-01': completedCount >= 1
          ? [{ stdout: successfulCleanReviewPayload('inv-source-01') }]
          : [{ stdout: terminalTurnPayload({ state: 'profile_busy', cause: 'profile_busy' }), exitCode: 13 }],
        'source-02': completedCount >= 2
          ? [{ stdout: successfulCleanReviewPayload('inv-source-02') }]
          : [
              { stdout: terminalTurnPayload({ state: 'profile_busy', cause: 'profile_busy', invocationId: 'inv-source-02-a' }), exitCode: 13 },
              { stdout: terminalTurnPayload({ state: 'profile_busy', cause: 'profile_busy', invocationId: 'inv-source-02-b' }), exitCode: 13 },
            ],
        'source-03': [
          { stdout: terminalTurnPayload({ state: 'profile_busy', cause: 'profile_busy', invocationId: 'inv-source-03-a' }), exitCode: 13 },
          { stdout: terminalTurnPayload({ state: 'profile_busy', cause: 'profile_busy', invocationId: 'inv-source-03-b' }), exitCode: 13 },
        ],
      },
    }));

    const runId = String(result.runId);
    const current = getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot });
    updatePackReviewRun(runId, { runnerPid: 2147483647 }, {
      projectId: 'orchestrator-pack',
      storeRoot,
    });
    const admissions = current!.reviewRound!.sourceSlots
      .map((slot) => Date.parse(slot.admissionStartedAtUtc ?? ''))
      .filter((value) => Number.isFinite(value));
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Math.min(...admissions) + 3 * 60_000));

    const reconciliation = await reconcileStalePackReviewRuns({
      repoSlug: 'chetwerikoff/orchestrator-pack',
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1276,
      settlePartialAfterGrace: false,
      fixtureCurrentPrHeadSha: HEAD_A,
      fixtureGptSourceCommentTransport: {
        resolveActorLogin: async () => 'browser-gpt-bot',
        listComments: async () => [],
        getComment: async () => { throw new Error('unexpected source comment reread'); },
      },
      fixtureRequiredStatusWriter: async () => {},
    });

    expect(reconciliation.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId,
        terminalized: false,
        statusReconciled: false,
        reason: 'gpt_partial_requires_explicit_immediate_reconcile',
        coverage: expect.objectContaining({
          kind: 'partial',
          completedSourceCount: completedCount,
          cardinality: 3,
        }),
      }),
    ]));
    const after = getPackReviewRun(runId, { projectId: 'orchestrator-pack', storeRoot });
    expect(after?.status).toBe('reviewing');
    expect(after?.reviewRound?.settledSourceCount).toBeUndefined();
  });

  it('keeps a possible-delivery source non-retryable while preserving 2/3 partial evidence', async () => {
    const storeRoot = tempRoot('opk-gpt-possible-delivery-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    selectProjectCard(storeRoot);
    delete process.env.PACK_GPT_BROWSER_PROJECT_URL;
    process.env.PACK_GPT_BROWSER_PROFILE = path.join(storeRoot, 'browser-profile');
    process.env.PACK_GPT_BROWSER_CDP = 'http://127.0.0.1:9222';

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
    expect(uncertain?.launchProfileKey).toMatch(/^profile-[0-9a-f]{32}$/);
    expect(uncertain?.launchCdpUrl).toBe('http://127.0.0.1:9222');
    expect(result).toMatchObject({
      ok: true,
      status: 'reviewing',
      reason: 'gpt_sources_partial_pending_reconcile:2/3',
      coverage: {
        kind: 'partial',
        completedSourceCount: 2,
        cardinality: 3,
      },
    });
    expect(run?.status).toBe('reviewing');
    expect(run?.failureReason).toBeUndefined();
    expect(run?.reviewRound?.settledSourceCount).toBeUndefined();
    expect(run?.reviewVerdict).toBeUndefined();
    expect(() => readFileSync(capture, 'utf8')).toThrow();
  });

  it('does not let an ordinary blocking finding shorten the pre-grace 3/3 census', async () => {
    const storeRoot = tempRoot('opk-gpt-blocking-partial-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;

    const result = await startPackReview(pluralStart(storeRoot, capture, {
      fixtureRequiredStatusWriter: async () => {},
      fixtureReviewBySourceSlot: {
        'source-01': [{ stdout: findingsPayload('real-blocker') }],
        'source-02': [
          { stdout: terminalTurnPayload({ state: 'profile_busy', cause: 'profile_busy' }), exitCode: 13 },
          { stdout: terminalTurnPayload({ state: 'profile_busy', cause: 'profile_busy' }), exitCode: 13 },
        ],
        'source-03': [{ stdout: successfulCleanReviewPayload('inv-source-03') }],
      },
    }));

    expect(result).toMatchObject({
      ok: true,
      status: 'reviewing',
      reason: 'gpt_sources_partial_pending_reconcile:2/3',
      coverage: {
        kind: 'partial',
        completedSourceCount: 2,
        cardinality: 3,
      },
    });
    const run = getPackReviewRun(String(result.runId), { projectId: 'orchestrator-pack', storeRoot });
    expect(run?.reviewVerdict).toBeUndefined();
    expect(run?.reviewRound?.settledSourceCount).toBeUndefined();
    expect(() => readFileSync(capture, 'utf8')).toThrow();
  });

  it('aggregates all findings when 3/3 sources finish before grace', async () => {
    const storeRoot = tempRoot('opk-gpt-blocking-full-census-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;

    const result = await startPackReview(pluralStart(storeRoot, capture, {
      fixtureRequiredStatusWriter: async () => {},
      fixtureReviewBySourceSlot: {
        'source-01': [{ stdout: findingsPayload('blocker-one') }],
        'source-02': [{ stdout: findingsPayload('blocker-two') }],
        'source-03': [{ stdout: successfulCleanReviewPayload('inv-source-03') }],
      },
    }));

    expect(result).toMatchObject({
      ok: true,
      status: 'changes_requested',
      coverage: { kind: 'complete', completedSourceCount: 3, cardinality: 3 },
    });
    const run = getPackReviewRun(String(result.runId), { projectId: 'orchestrator-pack', storeRoot });
    expect(run?.reviewRound?.settledSourceCount).toBe(3);
    expect(run?.findingCount).toBe(2);
    const posted = readFileSync(capture, 'utf8');
    expect(posted).toContain('blocker-one');
    expect(posted).toContain('blocker-two');
    expect(posted).not.toContain('degraded after timeout');
  });

  it.each([
    ['harvest_failed', 'harvest_failed', successfulCleanReviewPayload('inv-source-01')],
    ['no_reply', 'no_reply', successfulCleanReviewPayload('inv-source-01')],
    ['forbidden_verdict_envelope', 'forbidden_verdict_envelope', successfulCleanReviewPayload('inv-source-01')],
    ['harvest_failed with non-blocking finding', 'harvest_failed', findingsPayload('non-blocking-real', 'non-blocking')],
  ] as const)('publishes diagnostic COMMENT and terminal error for %s without synthetic code findings', async (_name, harvestClass, sourceOne) => {
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
        'source-02': [{ stdout: harvestTerminalPayload('inv-source-02', harvestClass), exitCode: 1 }],
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
    expect(run?.reviewRound?.sourceSlots[1]?.terminalClass).toBe(harvestClass);
    expect(run?.reviewRound?.sourceSlots[1]?.terminalResult).toMatchObject({
      review_evidence: expect.objectContaining({
        adapterPromptPath: '/fixture/gpt-evidence/inv-source-02/adapter-prompt.txt',
      }),
    });
    expect(posted).toContain(harvestClass);
    expect(posted).toContain('/fixture/gpt-evidence/inv-source-02/adapter-prompt.txt');
    expect(posted).not.toContain('GPT source source-02 did not complete');
  });

  it('keeps ordinary partial blockers pending under the same severity semantics as delivery classification', async () => {
    const storeRoot = tempRoot('opk-gpt-critical-blocking-partial-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;

    const result = await startPackReview(pluralStart(storeRoot, capture, {
      fixtureReviewBySourceSlot: {
        'source-01': [{ stdout: findingsPayload('critical-blocker', 'critical') }],
        'source-02': [
          { stdout: terminalTurnPayload({ state: 'profile_busy', cause: 'profile_busy' }), exitCode: 13 },
          { stdout: terminalTurnPayload({ state: 'profile_busy', cause: 'profile_busy' }), exitCode: 13 },
        ],
        'source-03': [{ stdout: successfulCleanReviewPayload('inv-source-03') }],
      },
    }));

    expect(result).toMatchObject({
      ok: true,
      status: 'reviewing',
      reason: 'gpt_sources_partial_pending_reconcile:2/3',
      coverage: { kind: 'partial', completedSourceCount: 2, cardinality: 3 },
    });
    expect(getPackReviewRun(String(result.runId), {
      projectId: 'orchestrator-pack',
      storeRoot,
    })?.reviewVerdict).toBeUndefined();
  });

  it.each([
    'harvest_failed',
    'no_reply',
    'forbidden_verdict_envelope',
  ] as const)('keeps real blocking findings pending when %s leaves the census partial', async (harvestClass) => {
    const storeRoot = tempRoot('opk-gpt-harvest-blocking-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;

    const result = await startPackReview(pluralStart(storeRoot, capture, {
      fixtureReviewBySourceSlot: {
        'source-01': [{ stdout: findingsPayload('real-blocker') }],
        'source-02': [{ stdout: harvestTerminalPayload('inv-source-02', harvestClass), exitCode: 1 }],
        'source-03': [{ stdout: successfulCleanReviewPayload('inv-source-03') }],
      },
    }));

    const run = getPackReviewRun(String(result.runId), { projectId: 'orchestrator-pack', storeRoot });
    expect(result).toMatchObject({
      ok: true,
      status: 'reviewing',
      reason: 'gpt_sources_partial_pending_reconcile:2/3',
      coverage: { kind: 'partial', completedSourceCount: 2, cardinality: 3 },
    });
    expect(run?.reviewVerdict).toBeUndefined();
    expect(run?.findingCount).toBeUndefined();
    expect(run?.reviewRound?.settledSourceCount).toBeUndefined();
    expect(run?.reviewRound?.sourceSlots[1]?.terminalClass).toBe(harvestClass);
    expect(() => readFileSync(capture, 'utf8')).toThrow();
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
  it.each(['attempted_zero', 'positive_count', 'bare_zero', 'foreign_invocation', 'ok_state', 'with_payload', 'complete_zero'] as const)(
    'persists only bound truthful possible-delivery evidence: %s', (scenario) => {
      const storeRoot = tempRoot('opk-gpt-attempted-durable-');
      const options = { projectId: 'orchestrator-pack', storeRoot };
      const created = createPackReviewRun({
        ...options, prNumber: 1276, headSha: HEAD_A, trustedPackRoot: repoRoot, sourceRepoRoot: repoRoot,
        reviewRound: plannedStoredGptRound(),
      }).run;
      const round = plannedStoredGptRound();
      round.sourceSlots[0] = {
        slotId: 'source-01', ordinal: 1, lifecycle: 'terminal', invocationId: 'inv-1', attemptOrdinal: 1,
        terminalClass: scenario === 'complete_zero' ? 'complete_clean' : 'possible_delivery',
        terminalResult: storedTerminalTurnResult(scenario === 'foreign_invocation' ? 'inv-foreign' : 'inv-1', {
          state: scenario === 'ok_state' || scenario === 'complete_zero' ? 'ok' : 'send_failed',
          cause: 'send_delivery_unproven', send_count: scenario === 'positive_count' ? 1 : 0,
          ...(scenario === 'bare_zero' || scenario === 'positive_count' ? {} : { send_attempted: true }),
        }),
        ...(scenario === 'with_payload' || scenario === 'complete_zero' ? { payload: { verdict: 'clean', findingCount: 0, findings: [] } } : {}),
      };
      const write = () => updatePackReviewRun(created.id, { reviewRound: round }, options);
      if (scenario === 'attempted_zero' || scenario === 'positive_count') {
        expect(write).not.toThrow();
        expect(getPackReviewRun(created.id, options)?.reviewRound?.sourceSlots[0]).toMatchObject({
          lifecycle: 'terminal', invocationId: 'inv-1', terminalClass: 'possible_delivery',
          terminalResult: { state: 'send_failed', send_count: scenario === 'positive_count' ? 1 : 0 },
        });
      } else {
        const error = scenario === 'foreign_invocation' ? /invocation_id is not bound/
          : scenario === 'with_payload' ? /non-complete terminal class cannot carry payload/
          : scenario === 'complete_zero' ? /complete_clean requires successful sent/
          : /possible_delivery requires a non-ok/;
        expect(write).toThrow(error);
        expect(getPackReviewRun(created.id, options)?.reviewRound?.sourceSlots[0].lifecycle).toBe('planned');
      }
    },
  );

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

  it('recovers all-complete unjournaled GPT rounds through the start path', async () => {
    const storeRoot = tempRoot('opk-gpt-1741-all-complete-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;

    const round: PackReviewGptRoundRecord = {
      schema: 'pack-review-gpt-round/v1',
      reviewer: 'gpt',
      tier: 'T1',
      roundOrdinal: 1,
      cardinality: 3,
      issueNumber: 1741,
      boundIssueSnapshotDigest: computeBoundIssueSnapshotHash('```complexity-tier\ntier: T1\n```'),
      sourceSlots: Array.from({ length: 3 }, (_, index) => ({
        slotId: `source-${String(index + 1).padStart(2, '0')}`,
        ordinal: index + 1,
        lifecycle: 'planned' as const,
      })),
    };
    const created = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1741,
      headSha: HEAD_A,
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      canonicalRepository: 'chetwerikoff/orchestrator-pack',
      reviewRound: round,
    }).run;
    const completeRound: PackReviewGptRoundRecord = {
      ...round,
      sourceSlots: round.sourceSlots.map((slot, index) => ({
        ...slot,
        lifecycle: 'terminal' as const,
        invocationId: `inv-1741-${index + 1}`,
        attemptOrdinal: 1,
        admissionStartedAtUtc: new Date().toISOString(),
        terminalClass: 'complete_clean',
        terminalResult: storedTerminalTurnResult(`inv-1741-${index + 1}`, {
          source_comment_authority: 'harness_fixture',
          source_comment_receipt: {
            commentId: 1741000 + index,
            repository: 'chetwerikoff/orchestrator-pack',
            prNumber: 1741,
            headSha: HEAD_A,
            runId: created.id,
            slotId: slot.slotId,
            invocationId: `inv-1741-${index + 1}`,
            commentUrl: `https://github.com/chetwerikoff/orchestrator-pack/pull/1741#issuecomment-${1741000 + index}`,
            actorLogin: 'browser-gpt-bot',
            createdAt: '2026-08-27T09:00:00.000Z',
            updatedAt: '2026-08-27T09:00:00.000Z',
            bodySha256: '0'.repeat(64),
          },
        }),
        payload: { verdict: 'clean', findingCount: 0, findings: [] },
      })),
    };
    updatePackReviewRun(created.id, { reviewRound: completeRound }, { projectId: 'orchestrator-pack', storeRoot });
    const failed = setPackReviewRunTerminal(created.id, 'failed', {
      exitCode: 1,
      failureReason: 'stale_head_before_terminal',
    }, { projectId: 'orchestrator-pack', storeRoot });
    expect(packReviewDeliveryNeedsResume(failed)).toBe(true);

    const reviews: GithubReviewSummary[] = [];
    const result = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: repoRoot,
      prNumber: 1741,
      headSha: HEAD_A,
      fixtureCurrentPrHeadSha: HEAD_A,
      fixturePrState: 'OPEN',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureGptSourceCommentTransport: {
        resolveActorLogin: async () => 'browser-gpt-bot',
        listComments: async () => [],
        getComment: async () => { throw new Error('complete source should not need comment hydration'); },
      },
      fixtureGithubReviewTransport: {
        resolveActorLogin: async () => 'pack-review-bot',
        listReviews: async () => [...reviews],
        postReview: async ({ body, commitId }) => {
          const id = 1741100 + reviews.length;
          const review: GithubReviewSummary = {
            id,
            body,
            commitId,
            url: `https://github.com/chetwerikoff/orchestrator-pack/pull/1741#pullrequestreview-${id}`,
            state: 'COMMENTED',
            userLogin: 'pack-review-bot',
            submittedAt: '2026-08-27T10:00:00.000Z',
          };
          reviews.push(review);
          return { id, url: review.url };
        },
        dismissReview: async () => {},
      },
      fixtureRequiredStatusWriter: async () => {},
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
      fixtureIssueBody: '```complexity-tier\ntier: T1\n```',
      fixtureIssueNumber: 1741,
      fixtureChangedPaths: ['scripts/pack-review-runner.ts'],
      fixtureBoundIssueSnapshotBytes: '```complexity-tier\ntier: T1\n```',
      fixtureReviewStdout: cleanTerminalPayload(),
    });

    expect(result).toMatchObject({ ok: true, created: false, reused: true });
    expect(getPackReviewRun(failed.id, { projectId: 'orchestrator-pack', storeRoot })).toMatchObject({
      status: 'up_to_date',
      reviewVerdict: 'clean',
      journalOutcome: { state: 'persisted' },
    });
    expect(reviews).toHaveLength(1);
    expect(listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot })).toHaveLength(1);
  });
});



describe('recovered sub-quorum blocking source regression', () => {
  it('keeps a credentialed recovered 1/3 blocker incomplete after grace', async () => {
    const storeRoot = tempRoot('opk-gpt-recovered-one-blocker-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    const issueBody = '```complexity-tier\ntier: T3\n```';
    const sourceOneInvocation = '77777777-1111-4111-8111-111111111111';
    const sourceTwoInvocation = '77777777-2222-4222-8222-222222222222';
    const sourceThreeInvocation = '77777777-3333-4333-8333-333333333333';

    initializePackReviewAuthority({
      prNumber: 1787,
      headSha: HEAD_A,
      tier: 'T3',
      options: { storeRoot },
    });

    const reviewRound: PackReviewGptRoundRecord = {
      schema: 'pack-review-gpt-round/v1',
      reviewer: 'gpt',
      tier: 'T3',
      roundOrdinal: 1,
      cardinality: 3,
      issueNumber: 1787,
      boundIssueSnapshotDigest: computeBoundIssueSnapshotHash(issueBody),
      sourceSlots: [
        {
          slotId: 'source-01',
          ordinal: 1,
          lifecycle: 'terminal',
          invocationId: sourceOneInvocation,
          attemptOrdinal: 1,
          admissionStartedAtUtc: '2026-08-29T03:00:00.000Z',
          terminalClass: 'reviewer_output_malformed',
          terminalResult: {
            ...storedTerminalTurnResult(sourceOneInvocation),
            source_comment_reconciliation: 'conflict',
          },
        },
        {
          slotId: 'source-02',
          ordinal: 2,
          lifecycle: 'terminal',
          invocationId: sourceTwoInvocation,
          attemptOrdinal: 2,
          terminalClass: 'explicit_refusal:zero_send_collision_exhausted',
          terminalResult: storedTerminalTurnResult(
            sourceTwoInvocation,
            { state: 'profile_busy', scope: 'profile', cause: 'profile_busy', send_count: 0 },
          ),
        },
        {
          slotId: 'source-03',
          ordinal: 3,
          lifecycle: 'terminal',
          invocationId: sourceThreeInvocation,
          attemptOrdinal: 2,
          terminalClass: 'explicit_refusal:zero_send_collision_exhausted',
          terminalResult: storedTerminalTurnResult(
            sourceThreeInvocation,
            { state: 'profile_busy', scope: 'profile', cause: 'profile_busy', send_count: 0 },
          ),
        },
      ],
    };

    const created = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1787,
      headSha: HEAD_A,
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      canonicalRepository: 'chetwerikoff/orchestrator-pack',
      reviewRound,
    }).run;
    const failed = setPackReviewRunTerminal(created.id, 'failed', {
      exitCode: 1,
      failureReason: 'stale_head_before_terminal',
    }, { projectId: 'orchestrator-pack', storeRoot });

    const sourceOneIdentity: PackGptSourceIdentity = {
      repository: 'chetwerikoff/orchestrator-pack',
      prNumber: 1787,
      headSha: HEAD_A,
      runId: failed.id,
      slotId: 'source-01',
      invocationId: sourceOneInvocation,
    };
    const sourceOneReply = JSON.stringify({
      findings: [{
        type: 'quality',
        code: 'quality:recovered-blocker',
        severity: 'blocking',
        path: 'scripts/pack-review-runner.ts',
        summary: 'recovered-blocker',
        source: 'gpt-browser',
      }],
    });
    const sourceComment: PackGptSourceGithubComment = {
      id: 1787001,
      body: formatPackGptSourceCommentEnvelope(sourceOneIdentity, sourceOneReply),
      actorLogin: 'browser-gpt-bot',
      createdAt: '2026-08-29T03:01:00.000Z',
      updatedAt: '2026-08-29T03:01:00.000Z',
      url: 'https://github.com/chetwerikoff/orchestrator-pack/pull/1787#issuecomment-1787001',
      issueUrl: 'https://api.github.com/repos/chetwerikoff/orchestrator-pack/issues/1787',
    };
    const sourceTransport: PackGptSourceCommentTransport = {
      resolveActorLogin: async () => 'browser-gpt-bot',
      listComments: async () => [sourceComment],
      getComment: async (id) => {
        if (id !== sourceComment.id) throw new Error(`unexpected source comment ${String(id)}`);
        return sourceComment;
      },
    };

    const reviewBodies: string[] = [];
    const statusStates: string[] = [];
    const reviews: GithubReviewSummary[] = [];
    const finalReviewTransport: GithubReviewTransport = {
      resolveActorLogin: async () => 'pack-review-bot',
      listReviews: async () => [...reviews],
      postReview: async ({ body, commitId }) => {
        reviewBodies.push(body);
        const review: GithubReviewSummary = {
          id: 178701,
          body,
          commitId,
          url: 'https://github.com/chetwerikoff/orchestrator-pack/pull/1787#pullrequestreview-178701',
          state: 'COMMENTED',
          userLogin: 'pack-review-bot',
          submittedAt: '2026-08-29T03:30:00.000Z',
        };
        reviews.push(review);
        return { id: review.id, url: review.url };
      },
      dismissReview: async () => {},
    };

    const reconciliation = await reconcileStalePackReviewRuns({
      repoSlug: 'chetwerikoff/orchestrator-pack',
      sourceRepoRoot: repoRoot,
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1787,
      immediate: true,
      fixtureCurrentPrHeadSha: HEAD_A,
      fixtureGptSourceCommentTransport: sourceTransport,
      fixtureGithubReviewTransport: finalReviewTransport,
      fixtureRequiredStatusWriter: async (request) => {
        statusStates.push(request.state);
      },
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
      fixtureIssueBody: issueBody,
      fixtureIssueNumber: 1787,
      fixtureChangedPaths: ['scripts/pack-review-runner.ts'],
      fixtureBoundIssueSnapshotBytes: issueBody,
    });

    expect(reconciliation.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: failed.id,
        terminalized: false,
        statusReconciled: false,
        usableSourceCount: 1,
        graceExpired: true,
        reason: 'gpt_sources_incomplete_after_grace:1/3',
      }),
    ]));
    const unsettled = getPackReviewRun(failed.id, { projectId: 'orchestrator-pack', storeRoot });
    expect(unsettled?.reviewRound?.settledSourceCount).toBeUndefined();
    expect(unsettled?.reviewVerdict).toBeUndefined();
    expect(unsettled?.findingCount).toBeUndefined();
    expect(statusStates).toEqual([]);
    expect(reviewBodies).toEqual([]);
  });
});


describe('Issue #2451 zero-judgment budget and wrapper projection', () => {
  it.each(['review_stage_complete', 'terminal_run_exists'] as const)(
    'accepts only current-head published %s reuse without launching GPT', async (reason) => {
      const startReview = vi.fn(async () => ({
        ok: true, created: false, reused: true, reason,
        prNumber: 2451, headSha: HEAD_A,
        publicationHeadSha: HEAD_A, statusPublished: true, publicationVerified: true,
      }));
      const execution = await runPackGptReviewCommand({ prNumber: 2451 }, {
        env: {}, stderr: { write: () => undefined },
        startReview,
      });
      expect(execution).toMatchObject({
        exitCode: 0, result: { ok: true, created: false, reason, publicationHeadSha: HEAD_A },
      });
      expect(startReview).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { reason: 'terminal_run_exists', statusPublished: false, publicationHeadSha: HEAD_A },
    { reason: 'review_stage_complete', statusPublished: true, publicationHeadSha: HEAD_B },
    { reason: 'active_run_exists', statusPublished: true, publicationHeadSha: HEAD_A },
  ])('refuses unproven non-created result $reason ($statusPublished)', async (reply) => {
    const execution = await runPackGptReviewCommand({ prNumber: 2451 }, {
      env: {}, stderr: { write: () => undefined },
      startReview: async () => ({
        ok: true, created: false, reused: true, prNumber: 2451,
        headSha: HEAD_A, ...reply,
      }),
    });
    expect(execution).toMatchObject({
      exitCode: 1, result: { outcome: 'review_not_started', runnerReason: reply.reason },
    });
  });

  it('derives the zero-judgment terminal without rewriting verdict-eligible consumption', () => {
    const storeRoot = tempRoot('opk-2451-no-judgment-census-');
    const options = { projectId: 'orchestrator-pack', storeRoot };
    const round = plannedStoredGptRound();
    round.tier = 'T2';
    round.sourceSlots = round.sourceSlots.map((slot) => ({
      ...slot, lifecycle: 'terminal' as const, invocationId: `inv-${slot.ordinal}`,
      attemptOrdinal: 1,
      terminalClass: 'driver_error:connect_over_cdp_failed',
      terminalResult: storedTerminalTurnResult(`inv-${slot.ordinal}`, {
        state: 'driver_error', cause: 'connect_over_cdp_failed', send_count: 0,
      }),
    }));
    const created = createPackReviewRun({
      ...options, prNumber: 2451, headSha: HEAD_A,
      canonicalRepository: 'chetwerikoff/orchestrator-pack',
      trustedPackRoot: repoRoot, sourceRepoRoot: repoRoot,
      accountingVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      reviewCycleId: 'cycle-2451', logicalRoundOrdinal: 1, logicalRoundCap: 2,
      automaticBudgetDisposition: 'consume', reviewRound: round,
    }).run;
    const failed = setPackReviewRunTerminal(created.id, 'failed', {
      failureReason: 'gpt_source_non_complete:source-01:connect_over_cdp_failed',
    }, options);
    expect(derivePackReviewNoJudgmentBudgetOutcome(failed, [])).toBe('non_consuming_no_judgment');
    expect(derivePackReviewNoJudgmentBudgetOutcome(failed, [1])).toBeNull();
    expect(failed.automaticBudgetDisposition).toBe('consume');
    expect(failed.reviewVerdict).toBeUndefined();
    expect(failed.journalOutcome).toBeUndefined();
    expect(failed.reviewRound?.sourceSlots).toHaveLength(3);
  });

  it('merges independent verdict and failure notifications under the store lock', () => {
    const storeRoot = tempRoot('opk-2451-outcome-lock-');
    const options = { projectId: 'orchestrator-pack', storeRoot };
    const run = createPackReviewRun({
      ...options, prNumber: 2451, headSha: HEAD_A,
      trustedPackRoot: repoRoot, sourceRepoRoot: repoRoot,
    }).run;
    const stamp = '2026-10-10T00:00:00.000Z';
    const status = { state: 'succeeded' as const, reason: 'status_success',
      recordedAtUtc: stamp, idempotencyKey: `required-status:orchestrator-pack/pack-review:${HEAD_A}` };
    const failure = { state: 'escalated' as const, reason: 'submission_outcome_unresolved',
      recordedAtUtc: stamp, idempotencyKey: `worker-notification:no-judgment:${run.id}:${HEAD_A}` };
    updatePackReviewRun(run.id, { deliveryOutcomes: { requiredStatus: status } }, options);
    // Simulate a stale full-map writer racing the successful status outcome.
    updatePackReviewRun(run.id, { deliveryOutcomes: { noJudgmentWorkerNotification: failure } }, options);
    expect(getPackReviewRun(run.id, options)?.deliveryOutcomes).toMatchObject({
      requiredStatus: status, noJudgmentWorkerNotification: failure,
    });
  });
});


describe('Issue #2451 three-source no-judgment delivery', () => {
  it.each(['submitted', 'pre_dispatch_failure', 'ambiguous'] as const)(
    'submits the bounded failure-only notification once (%s)', async (submissionState) => {
      const storeRoot = tempRoot('opk-2451-zero-source-');
      const capture = path.join(storeRoot, 'review.json');
      harnessEnv(storeRoot, capture);
      process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
      delete process.env.PACK_GPT_BROWSER_CHAT_URL;
      const options = { projectId: 'orchestrator-pack', storeRoot };
      const slots: Record<string, Array<{ stdout: string; exitCode: number }>> = {};
      const notifications: string[] = [];
      const statusStates: string[] = [];
      const result = await startPackReview({
        ...options, sourceRepoRoot: repoRoot, prNumber: 2451, headSha: HEAD_A,
        tier: 'T2', fixtureCurrentPrHeadSha: HEAD_A, fixturePostReviewHeadSha: HEAD_A,
        fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
        fixturePrState: 'OPEN',
        claimMode: 'preacquired',
        fixtureIssueBody: ['```complexity-tier', 'tier: T2', '```'].join('\n'),
        fixtureIssueNumber: 2451,
        fixtureReviewBySourceSlot: slots,
        fixtureAfterGptInvocationBound: ({ slotId, invocationId }) => {
          slots[slotId] = [{ stdout: terminalTurnPayload({
            state: 'driver_error', cause: 'connect_over_cdp_failed', invocationId,
          }), exitCode: 1 }];
          // A fixture-only exact generation binding. A plain session string
          // cannot qualify as authorization for the notification channel.
          const run = listPackReviewRuns(options)[0];
          if (run) updatePackReviewRun(run.id, {
            workerNotificationBinding: {
              schemaVersion: 1, runtime: 'cursor', id: 'fixture-worker-2451',
              generation: 'fixture-generation', workspacePath: '/fixture/worktree',
              headSha: HEAD_A,
            },
          } as unknown as Parameters<typeof updatePackReviewRun>[1], options);
        },
        fixtureRequiredStatusWriter: async (request) => { statusStates.push(request.state); },
        fixtureWorkerNotifier: async (request) => {
          notifications.push(request.idempotencyKey);
          return { state: submissionState, reason: 'fixture-' + submissionState };
        },
      });
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: false, created: true, status: 'failed',
        budgetOutcome: 'non_consuming_no_judgment',
        requiredStatusPublication: 'published',
        noJudgmentWorkerNotification: { state: submissionState },
      });
      const run = getPackReviewRun(String(result.runId), options)!;
      expect(run.reviewVerdict).toBeUndefined();
      expect(run.journalOutcome).toBeUndefined();
      expect(run.automaticBudgetDisposition).toBe('consume');
      expect(readPackReviewAuthority(2451, { storeRoot })?.cycle?.consumedRoundOrdinals).toEqual([]);
      expect(notifications).toEqual([`worker-notification:no-judgment:${run.id}:${HEAD_A}`]);
      expect(run.deliveryOutcomes.noJudgmentWorkerNotification).toMatchObject({
        state: submissionState === 'submitted' ? 'succeeded'
          : submissionState === 'pre_dispatch_failure' ? 'failed' : 'escalated',
      });
      expect(run.deliveryOutcomes.workerNotification).toBeUndefined();
      expect(statusStates).toContain('error');
      expect(statusStates).not.toContain('success');
      expect(existsSync(capture)).toBe(false);
      // A second scoped read may recover evidence, but must never blindly
      // resubmit the already claimed failure-only channel.
      await reconcileStalePackReviewRuns({
        ...options, sourceRepoRoot: repoRoot, repoSlug: 'chetwerikoff/orchestrator-pack',
        prNumber: 2451, fixtureCurrentPrHeadSha: HEAD_A,
        fixtureGptSourceCommentTransport: {
          resolveActorLogin: async () => 'browser-gpt-bot',
          listComments: async () => [], getComment: async () => { throw new Error('unavailable'); },
        },
        fixtureRequiredStatusWriter: async (request) => { statusStates.push(request.state); },
        fixtureWorkerNotifier: async (request) => {
          notifications.push(request.idempotencyKey);
          return { state: 'submitted', reason: 'duplicate' };
        },
      });
      expect(notifications).toHaveLength(1);
    },
  );
});


describe('Issue #2451 final-cap fixer regressions', () => {
  const optionsFor = (storeRoot: string) => ({ projectId: 'orchestrator-pack', storeRoot });

  async function failedZeroJudgmentFixture() {
    const storeRoot = tempRoot('opk-2451-fixer-');
    const capture = path.join(storeRoot, 'review.json');
    harnessEnv(storeRoot, capture);
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;
    const options = optionsFor(storeRoot);
    const slots: Record<string, Array<{ stdout: string; exitCode: number }>> = {};
    const started = await startPackReview({
      ...options, sourceRepoRoot: repoRoot, prNumber: 2451, headSha: HEAD_A,
      tier: 'T2', fixtureCurrentPrHeadSha: HEAD_A, fixturePostReviewHeadSha: HEAD_A,
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixturePrState: 'OPEN', claimMode: 'preacquired',
      fixtureIssueBody: ["```complexity-tier", 'tier: T2', "```"].join('\n'),
      fixtureIssueNumber: 2451,
      fixtureReviewBySourceSlot: slots,
      fixtureAfterGptInvocationBound: ({ slotId, invocationId }) => {
        slots[slotId] = [{
          stdout: terminalTurnPayload({
            state: 'driver_error', cause: 'connect_over_cdp_failed', invocationId,
          }),
          exitCode: 1,
        }];
      },
      fixtureRequiredStatusWriter: async (request) => {
        if (request.state === 'error') throw new Error('first no-judgment status write unavailable');
      },
    });
    expect(started, JSON.stringify(started)).toMatchObject({
      ok: false, status: 'failed', budgetOutcome: 'non_consuming_no_judgment',
      requiredStatusPublication: 'status_not_published',
      noJudgmentWorkerNotification: { state: 'skipped_unbound' },
    });
    const runId = String(started.runId);
    expect(getPackReviewRun(runId, options)?.deliveryOutcomes.requiredStatus?.state).toBe('failed');
    return { runId, storeRoot, options };
  }

  function emptyComments(): PackGptSourceCommentTransport {
    return {
      resolveActorLogin: async () => 'browser-gpt-bot',
      listComments: async () => [],
      getComment: async () => { throw new Error('no synthetic comment'); },
    };
  }

  it.each(['status-first', 'notification-first'] as const)(
    'retains newer independent channels when both writers submit full stale maps (%s)', (order) => {
      const storeRoot = tempRoot('opk-2451-fixer-full-map-');
      const options = optionsFor(storeRoot);
      const run = createPackReviewRun({
        ...options, prNumber: 2451, headSha: HEAD_A,
        trustedPackRoot: repoRoot, sourceRepoRoot: repoRoot,
      }).run;
      const first = '2026-10-10T00:00:00.000Z';
      const later = '2026-10-10T00:00:01.000Z';
      const statusKey = 'required-status:orchestrator-pack/pack-review:' + HEAD_A;
      const failureKey = 'worker-notification:no-judgment:' + run.id + ':' + HEAD_A;
      const oldStatus = { state: 'failed' as const, reason: 'not_published',
        idempotencyKey: statusKey, recordedAtUtc: first };
      const oldFailure = { state: 'escalated' as const, reason: 'submission_unresolved',
        idempotencyKey: failureKey, recordedAtUtc: first };
      updatePackReviewRun(run.id, {
        deliveryOutcomes: { requiredStatus: oldStatus, noJudgmentWorkerNotification: oldFailure },
      }, options);
      const stale = { ...getPackReviewRun(run.id, options)!.deliveryOutcomes };
      const currentStatus = { ...oldStatus, state: 'succeeded' as const,
        reason: 'status_published', recordedAtUtc: later };
      const currentFailure = { ...oldFailure, state: 'succeeded' as const,
        reason: 'submit_succeeded', recordedAtUtc: later };
      if (order === 'status-first') {
        updatePackReviewRun(run.id, { deliveryOutcomes: { requiredStatus: currentStatus } }, options);
        updatePackReviewRun(run.id, {
          deliveryOutcomes: { ...stale, noJudgmentWorkerNotification: currentFailure },
        }, options);
      } else {
        updatePackReviewRun(run.id, {
          deliveryOutcomes: { noJudgmentWorkerNotification: currentFailure },
        }, options);
        updatePackReviewRun(run.id, {
          deliveryOutcomes: { ...stale, requiredStatus: currentStatus },
        }, options);
      }
      const verdict = { state: 'succeeded' as const, reason: 'verdict_submitted',
        idempotencyKey: 'worker-notification:' + run.id + ':' + HEAD_A,
        recordedAtUtc: later };
      updatePackReviewRun(run.id, {
        deliveryOutcomes: { ...stale, workerNotification: verdict },
      }, options);
      expect(getPackReviewRun(run.id, options)?.deliveryOutcomes).toMatchObject({
        requiredStatus: currentStatus,
        noJudgmentWorkerNotification: currentFailure,
        workerNotification: verdict,
      });
      // Even an equal-clock stale claim cannot revoke completed submission.
      updatePackReviewRun(run.id, {
        deliveryOutcomes: {
          noJudgmentWorkerNotification: { ...oldFailure, recordedAtUtc: later },
        },
      }, options);
      expect(getPackReviewRun(run.id, options)?.deliveryOutcomes.noJudgmentWorkerNotification)
        .toEqual(currentFailure);
    },
  );

  it('retries missing status and failure-only submission after empty source recovery', async () => {
    const f = await failedZeroJudgmentFixture();
    updatePackReviewRun(f.runId, {
      workerNotificationBinding: {
        schemaVersion: 1, runtime: 'cursor', id: 'fixture-worker-2451',
        generation: 'fixture-generation', workspacePath: '/fixture/worktree',
        headSha: HEAD_A,
      },
    } as unknown as Parameters<typeof updatePackReviewRun>[1], f.options);
    const statuses: string[] = [];
    const notifications: string[] = [];
    const input = {
      ...f.options, sourceRepoRoot: repoRoot,
      repoSlug: 'chetwerikoff/orchestrator-pack',
      prNumber: 2451, fixtureCurrentPrHeadSha: HEAD_A,
      fixtureGptSourceCommentTransport: emptyComments(),
      fixtureRequiredStatusWriter: async (request: { state: string }) => { statuses.push(request.state); },
      fixtureWorkerNotifier: async (request: { idempotencyKey: string }) => {
        notifications.push(request.idempotencyKey);
        return { state: 'submitted' as const, reason: 'fixture_submit_only' };
      },
    };
    const reconciled = await reconcileStalePackReviewRuns(input);
    expect(reconciled.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: f.runId, statusReconciled: true }),
    ]));
    expect(statuses).toEqual(['error']);
    expect(notifications).toEqual([
      'worker-notification:no-judgment:' + f.runId + ':' + HEAD_A,
    ]);
    expect(getPackReviewRun(f.runId, f.options)?.deliveryOutcomes).toMatchObject({
      requiredStatus: { state: 'succeeded' },
      noJudgmentWorkerNotification: { state: 'succeeded' },
    });
    await reconcileStalePackReviewRuns(input);
    expect(statuses).toEqual(['error']);
    expect(notifications).toHaveLength(1);
    expect(readPackReviewAuthority(2451, { storeRoot: f.storeRoot })?.cycle?.consumedRoundOrdinals)
      .toEqual([]);
  });

  it('restores a same-run credentialed verdict when a stale reconcile error lands last', async () => {
    const f = await failedZeroJudgmentFixture();
    const published: string[] = [];
    let recovered = false;
    const result = await reconcileStalePackReviewRuns({
      ...f.options, sourceRepoRoot: repoRoot,
      repoSlug: 'chetwerikoff/orchestrator-pack',
      prNumber: 2451, fixtureCurrentPrHeadSha: HEAD_A,
      fixtureGptSourceCommentTransport: emptyComments(),
      fixtureRequiredStatusWriter: async (request) => {
        if (request.state === 'error' && !recovered) {
          recovered = true;
          const run = getPackReviewRun(f.runId, f.options)!;
          const now = '2026-10-10T00:00:01.000Z';
          // The incumbent frozen-source merge admits a completed comment for
          // its original invocation only with credentialed GitHub evidence.
          // Two of the three original zero-send slots become a sufficient,
          // explicitly settled source quorum; the third stays non-complete.
          const recoveredRound = {
            ...run.reviewRound!,
            settledSourceCount: 2,
            sourceSlots: run.reviewRound!.sourceSlots.map((slot, index) => index < 2
              ? {
                  ...slot,
                  terminalClass: 'complete_clean',
                  terminalResult: {
                    schema: 'turn-result/v1',
                    state: 'ok', scope: 'invocation', cause: 'completed_page_only',
                    invocation_id: slot.invocationId, send_count: 1,
                    source_comment_authority: 'credentialed_github',
                    source_comment_receipt: { id: 245100 + index },
                  },
                  payload: { verdict: 'clean' as const, findingCount: 0, findings: [] },
                }
              : slot),
          };
          updatePackReviewRun(run.id, { reviewRound: recoveredRound }, f.options);
          // Barrier fixture: a second reconciler has committed this validated
          // same-run credentialed verdict and published success while the
          // first reconciler's obsolete error write is still awaiting.
          setPackReviewRunTerminal(run.id, 'up_to_date', {
            reviewVerdict: 'clean', findingCount: 0, findings: [],
            journalOutcome: {
              state: 'persisted', reason: 'credentialed_verdict',
              recordedAtUtc: now, idempotencyKey: 'verdict:' + run.id + ':' + HEAD_A,
              attempts: 1,
            },
          }, f.options);
          const authority = readPackReviewAuthority(2451, { storeRoot: f.storeRoot })!;
          commitPackReviewTerminal({
            prNumber: 2451, expectedTransitionSeq: authority.transitionSeq,
            terminal: {
              schemaVersion: 1, terminalContractVersion: 2, terminalSource: 'normal',
              runId: run.id, targetSha: HEAD_A, reviewVerdict: 'clean',
              findingCount: 0, findingsDigest: 'fixture-2451-credentialed-verdict',
              automaticBudgetDisposition: 'consume', logicalRoundOrdinal: 1,
            },
            status: 'clean', findingCount: 0, options: { storeRoot: f.storeRoot },
          });
          published.push('success', 'error');
        } else {
          published.push(request.state);
        }
      },
    });
    expect(recovered).toBe(true);
    expect(published).toEqual(['success', 'error', 'success']);
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: f.runId, statusReconciled: false,
        reason: 'same_run_verdict_status_restored',
        statusPublication: 'authoritative_verdict_restored',
      }),
    ]));
    expect(getPackReviewRun(f.runId, f.options)).toMatchObject({
      status: 'up_to_date', reviewVerdict: 'clean',
      deliveryOutcomes: { requiredStatus: { state: 'succeeded' } },
    });
    expect(readPackReviewAuthority(2451, { storeRoot: f.storeRoot })?.cycle?.consumedRoundOrdinals)
      .toEqual([1]);
  });
});

describe('Issue #2469 proven 0/3 orphan terminal/status repair', () => {
  const projectId = 'orchestrator-pack';
  const repoSlug = 'chetwerikoff/orchestrator-pack';
  const prNumber = 2469;
  const failure = 'gpt_source_non_complete:after_grace_zero_usable:0/3';
  const issueBody = ['```complexity-tier', 'tier: T2', '```'].join('\n');

  function seedOrphan(
    slotMode: 'planned' | 'first-attempt' | 'prelaunch' = 'first-attempt',
    firstSlotOverride?: (slot: PackReviewGptRoundRecord['sourceSlots'][number]) =>
      PackReviewGptRoundRecord['sourceSlots'][number],
  ) {
    const storeRoot = tempRoot('opk-2469-orphan-');
    harnessEnv(storeRoot, path.join(storeRoot, 'review.json'));
    process.env.PACK_REVIEW_RUN_STALE_MINUTES = '2';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T08:00:00.000Z'));
    const options = { projectId, storeRoot };
    const authority = initializePackReviewAuthority({
      prNumber, headSha: HEAD_A, tier: 'T2',
      capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      options: { storeRoot },
    });
    const round = plannedStoredGptRound();
    round.tier = 'T2';
    round.issueNumber = prNumber;
    round.boundIssueSnapshotDigest = computeBoundIssueSnapshotHash(issueBody);
    if (slotMode === 'first-attempt') {
      round.sourceSlots[0] = {
        ...round.sourceSlots[0]!,
        lifecycle: 'terminal',
        invocationId: 'inv-2469-first-attempt',
        attemptOrdinal: 1,
        terminalClass: 'driver_error:connect_over_cdp_failed',
        terminalResult: storedTerminalTurnResult('inv-2469-first-attempt', {
          state: 'driver_error', cause: 'connect_over_cdp_failed', send_count: 0,
        }),
      };
    }
    if (slotMode === 'prelaunch') {
      round.sourceSlots[0] = {
        ...round.sourceSlots[0]!,
        lifecycle: 'terminal',
        terminalClass: 'pre_launch_interrupted',
        terminalResult: { kind: 'stale_pre_launch_interruption', noResend: true },
      };
    }
    if (firstSlotOverride) round.sourceSlots[0] = firstSlotOverride(round.sourceSlots[0]!);
    const created = createPackReviewRun({
      ...options, prNumber, headSha: HEAD_A,
      canonicalRepository: repoSlug,
      trustedPackRoot: repoRoot, sourceRepoRoot: repoRoot,
      accountingVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
      reviewCycleId: authority.cycle!.cycleId,
      logicalRoundOrdinal: 1, logicalRoundCap: 1,
      automaticBudgetDisposition: 'consume',
      resolvedReviewer: 'gpt', reviewRound: round,
    }).run;
    updatePackReviewRun(created.id, {
      status: 'reviewing', latestRunStatus: 'reviewing',
      runnerPid: 2147483647,
    }, options);
    const emptyComments: PackGptSourceCommentTransport = {
      resolveActorLogin: async () => 'synthetic-reviewer',
      listComments: async () => [],
      getComment: async () => { throw new Error('no comment for exact invocation'); },
    };
    const input: Parameters<typeof reconcileStalePackReviewRuns>[0] = {
      ...options, prNumber, sourceRepoRoot: repoRoot, repoSlug,
      fixtureCurrentPrHeadSha: HEAD_A,
      fixtureGptSourceCommentTransport: emptyComments,
      fixtureRequiredStatusWriter: async () => {},
    };
    return {
      runId: created.id, options, input,
      expire: () => vi.setSystemTime(new Date('2026-10-10T08:05:00.000Z')),
    };
  }

  it.each(['planned', 'first-attempt', 'prelaunch'] as const)(
    'terminalizes only proven dead-runner after grace: %s', async (mode) => {
      const f = seedOrphan(mode);
      const written: string[] = [];
      const before = await reconcileStalePackReviewRuns({
        ...f.input, immediate: true,
      });
      expect(before.results).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ runId: f.runId, terminalized: true }),
      ]));
      expect(getPackReviewRun(f.runId, f.options)?.status).toBe('reviewing');
      f.expire();
      updatePackReviewRun(f.runId, { runnerPid: process.pid }, f.options);
      await reconcileStalePackReviewRuns({ ...f.input, immediate: true });
      expect(getPackReviewRun(f.runId, f.options)?.status).toBe('reviewing');
      updatePackReviewRun(f.runId, { runnerPid: 2147483647 }, f.options);
      // An active-run update legitimately refreshes its heartbeat. Age the
      // dead runner again before testing the post-grace transition.
      vi.setSystemTime(new Date('2026-10-10T08:10:00.000Z'));
      const result = await reconcileStalePackReviewRuns({
        ...f.input,
        fixtureRequiredStatusWriter: async ({ state }) => { written.push(state); },
      });
      expect(result.results).toEqual(expect.arrayContaining([
        expect.objectContaining({ runId: f.runId, terminalized: true, statusReconciled: true }),
      ]));
      const stored = getPackReviewRun(f.runId, f.options)!;
      expect(stored).toMatchObject({
        status: 'failed', failureReason: failure,
        automaticBudgetDisposition: 'consume',
        deliveryOutcomes: { requiredStatus: { state: 'succeeded' } },
      });
      expect(stored.reviewVerdict).toBeUndefined();
      expect(stored.journalOutcome).toBeUndefined();
      expect(stored.reviewRound?.sourceSlots).toHaveLength(3);
      expect(readPackReviewAuthority(prNumber, { storeRoot: f.options.storeRoot })?.cycle?.consumedRoundOrdinals).toEqual([]);
      expect(written).toEqual(['error']);
    },
  );

  it.each([
    ['second-attempt-without-prior-proof', (slot: PackReviewGptRoundRecord['sourceSlots'][number]) => ({
      ...slot, attemptOrdinal: 2,
    })],
    ['summary-history-only', (slot: PackReviewGptRoundRecord['sourceSlots'][number]) => ({
      ...slot, attemptHistory: [{
        invocationId: 'inv-prior', attemptOrdinal: 1, terminalClass: 'driver_error:connect_over_cdp_failed',
      }],
    })],
    ['possible-delivery-zero-send', (slot: PackReviewGptRoundRecord['sourceSlots'][number]) => ({
      ...slot, terminalClass: 'possible_delivery',
      terminalResult: storedTerminalTurnResult('inv-2469-first-attempt', {
        state: 'driver_error', cause: 'connect_over_cdp_failed',
        send_count: 0, send_attempted: true,
      }),
    })],
    ['possible-delivery-send-one', (slot: PackReviewGptRoundRecord['sourceSlots'][number]) => ({
      ...slot, terminalClass: 'possible_delivery',
      terminalResult: storedTerminalTurnResult('inv-2469-first-attempt', {
        state: 'driver_error', cause: 'connect_over_cdp_failed',
        send_count: 1,
      }),
    })],
    ['contradictory-dispatch-phase', (slot: PackReviewGptRoundRecord['sourceSlots'][number]) => ({
      ...slot,
      terminalResult: storedTerminalTurnResult('inv-2469-first-attempt', {
        state: 'driver_error', cause: 'connect_over_cdp_failed', send_count: 0,
        diagnostics: { persisted_observation: { phase: 'dispatching', send_count: 0 } },
      }),
    })],
    ['conflicting-comment-provenance', (slot: PackReviewGptRoundRecord['sourceSlots'][number]) => ({
      ...slot,
      terminalResult: storedTerminalTurnResult('inv-2469-first-attempt', {
        state: 'driver_error', cause: 'connect_over_cdp_failed', send_count: 0,
        source_comment_reconciliation: 'conflict',
      }),
    })],
    ['contradictory-send-flag', (slot: PackReviewGptRoundRecord['sourceSlots'][number]) => ({
      ...slot,
      terminalResult: storedTerminalTurnResult('inv-2469-first-attempt', {
        state: 'driver_error', cause: 'connect_over_cdp_failed', send_count: 0,
        send_attempted: 'unknown',
      }),
    })],
    ['started-without-terminal', (slot: PackReviewGptRoundRecord['sourceSlots'][number]) => ({
      slotId: slot.slotId, ordinal: slot.ordinal, lifecycle: 'invocation_started' as const,
      attemptOrdinal: 1, invocationId: 'inv-2469-first-attempt',
    })],
  ])('does not classify unsafe 0/3 witness: %s', async (name, mutate) => {
    // Build persisted negative evidence directly. The incumbent store rightly
    // rejects overwriting terminal attempt results after they are recorded.
    const f = seedOrphan(name === 'started-without-terminal' ? 'planned' : 'first-attempt', mutate);
    f.expire();
    const result = await reconcileStalePackReviewRuns(f.input);
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: f.runId, terminalized: false, statusReconciled: false,
        reason: 'gpt_zero_judgment_first_attempt_or_comment_census_unproven',
      }),
    ]));
    expect(getPackReviewRun(f.runId, f.options)?.status).toBe('reviewing');
  });

  it.each(['actor-failure', 'census-failure'] as const)(
    'fails closed on incomplete typed comment witness (%s)', async (mode) => {
      const f = seedOrphan();
      f.expire();
      const result = await reconcileStalePackReviewRuns({
        ...f.input,
        fixtureGptSourceCommentTransport: {
          resolveActorLogin: async () => {
            if (mode === 'actor-failure') throw new Error('synthetic actor offline');
            return 'synthetic-reviewer';
          },
          listComments: async () => {
            if (mode === 'census-failure') throw new Error('synthetic page failed');
            return [];
          },
          getComment: async () => { throw new Error('not credentialed'); },
        },
      });
      expect(result.results).toEqual(expect.arrayContaining([
        expect.objectContaining({ runId: f.runId, terminalized: false, statusReconciled: false }),
      ]));
      expect(getPackReviewRun(f.runId, f.options)?.status).toBe('reviewing');
    },
  );

  it('returns a parsable same-PR reconcile action, never retry/reset', async () => {
    const f = seedOrphan();
    f.expire();
    const output = await reconcileStalePackReviewRuns(f.input);
    const terminal = output.results.find((row) => row.runId === f.runId && row.terminalized === true)!;
    const action = String(terminal.nextAction);
    expect(action).toContain('node --experimental-strip-types scripts/pack-review-runner.ts reconcile');
    expect(action).toContain('--pr-number 2469');
    expect(action).not.toMatch(/(?:\s)(?:retry|reset)(?:\s|$)/);
    const cliArgs = action.split(' ').slice(4);
    // The CLI string quotes its actual repository root for shell safety.
    cliArgs[1] = JSON.parse(cliArgs[1]!);
    const args = parseArgs(cliArgs);
    expect(args).toMatchObject({ sourceRepoRoot: repoRoot, repoSlug, prNumber });
  });

  it('does not turn zero-judgment failure into permission to send without observation', async () => {
    const f = seedOrphan();
    f.expire();
    await reconcileStalePackReviewRuns(f.input);
    vi.useRealTimers();
    selectProjectCard(f.options.storeRoot);
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;
    const invocations: string[] = [];
    const result = await startPackReview({
      ...f.options,
      sourceRepoRoot: repoRoot, prNumber, headSha: HEAD_A,
      tier: 'T2', claimMode: 'preacquired',
      fixturePrState: 'OPEN', fixtureRepoSlug: repoSlug,
      fixtureCurrentPrHeadSha: HEAD_A, fixturePostReviewHeadSha: HEAD_A,
      fixtureIssueBody: issueBody,
      fixtureIssueNumber: prNumber,
      fixtureGptAttemptObserver: async () => ({
        state: 'observation_unavailable' as const, replacementEligible: false,
      }),
      fixtureAfterGptInvocationBound: async ({ slotId }) => { invocations.push(slotId); },
      fixtureRequiredStatusWriter: async () => {},
    });
    expect(result).toMatchObject({
      ok: false, created: false, runId: f.runId,
      reason: 'observation_unavailable', replacementEligible: false,
    });
    expect(invocations).toEqual([]);
    expect(readPackReviewAuthority(prNumber, { storeRoot: f.options.storeRoot })?.cycle?.consumedRoundOrdinals).toEqual([]);
  });

  it('can consume ordinal 1 once only after independent existing same-head eligibility', async () => {
    const f = seedOrphan();
    f.expire();
    await reconcileStalePackReviewRuns(f.input);
    vi.useRealTimers();
    selectProjectCard(f.options.storeRoot);
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;
    const launched: string[] = [];
    const result = await startPackReview({
      ...f.options,
      sourceRepoRoot: repoRoot, prNumber, headSha: HEAD_A,
      tier: 'T2', claimMode: 'preacquired',
      fixturePrState: 'OPEN', fixtureRepoSlug: repoSlug,
      fixtureCurrentPrHeadSha: HEAD_A, fixturePostReviewHeadSha: HEAD_A,
      fixtureIssueBody: issueBody,
      fixtureIssueNumber: prNumber,
      fixtureGptAttemptObserver: async () => ({
        state: 'replacement_eligible' as const, replacementEligible: true,
        slotId: 'source-01',
        replacementEligibleSlotIds: ['source-01'],
        initialLaunchSlotIds: ['source-02', 'source-03'],
      }),
      fixtureAfterGptInvocationBound: async ({ slotId }) => { launched.push(slotId); },
      fixtureReviewBySourceSlot: {
        'source-01': [{ stdout: successfulCleanReviewPayload('inv-source-01') }],
        'source-02': [{ stdout: successfulCleanReviewPayload('inv-source-02') }],
        'source-03': [{ stdout: successfulCleanReviewPayload('inv-source-03') }],
      },
      fixtureRequiredStatusWriter: async () => {},
    });
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true, runId: f.runId,
    });
    expect(launched).toEqual(['source-01', 'source-02', 'source-03']);
    expect(getPackReviewRun(f.runId, f.options)?.reviewVerdict).toBe('clean');
    expect(readPackReviewAuthority(prNumber, { storeRoot: f.options.storeRoot })?.cycle?.consumedRoundOrdinals)
      .toEqual([1]);
  });

  it('preserves failure-only notification channel across repeated 0/3 reconciliation', async () => {
    const f = seedOrphan();
    updatePackReviewRun(f.runId, {
      workerNotificationBinding: {
        schemaVersion: 1, runtime: 'cursor', id: 'synthetic-worker-2469',
        generation: 'synthetic-generation', workspacePath: '/synthetic/worktree',
        headSha: HEAD_A,
      },
    } as unknown as Parameters<typeof updatePackReviewRun>[1], f.options);
    f.expire();
    const sent: string[] = [];
    const input = {
      ...f.input,
      fixtureWorkerNotifier: async (request: { idempotencyKey: string }) => {
        sent.push(request.idempotencyKey);
        return { state: 'submitted' as const, reason: 'synthetic-notification-sent' };
      },
    };
    await reconcileStalePackReviewRuns(input);
    await reconcileStalePackReviewRuns(input);
    expect(sent).toEqual([`worker-notification:no-judgment:${f.runId}:${HEAD_A}`]);
    expect(getPackReviewRun(f.runId, f.options)?.deliveryOutcomes.noJudgmentWorkerNotification)
      .toMatchObject({ state: 'succeeded' });
  });

  it('republishes same-run pending after a delayed zero-judgment error finishes', async () => {
    const f = seedOrphan();
    f.expire();
    const external: string[] = [];
    let requeued = false;
    const result = await reconcileStalePackReviewRuns({
      ...f.input,
      fixtureRequiredStatusWriter: async (request) => {
        if (request.state === 'error' && !requeued) {
          requeued = true;
          updatePackReviewRun(f.runId, {
            status: 'queued', latestRunStatus: 'queued',
            failureReason: undefined, stale: undefined,
          }, f.options);
          external.push('pending');
        }
        external.push(request.state);
      },
    });
    expect(external).toEqual(['pending', 'error', 'pending']);
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: f.runId, statusReconciled: false,
        reason: 'same_run_pending_status_restored',
        statusPublication: 'authoritative_pending_restored',
      }),
    ]));
    expect(getPackReviewRun(f.runId, f.options)).toMatchObject({
      status: 'queued', deliveryOutcomes: { requiredStatus: { state: 'succeeded' } },
    });
    expect(readPackReviewAuthority(prNumber, { storeRoot: f.options.storeRoot })?.cycle?.consumedRoundOrdinals).toEqual([]);
  });

  it.each(['write-failed', 'head-advanced'] as const)(
    'never claims 0/3 error publication without verified status (%s)', async (mode) => {
      const f = seedOrphan();
      f.expire();
      let head = HEAD_A;
      const result = await reconcileStalePackReviewRuns({
        ...f.input,
        fixtureReadCurrentPrHead: async () => head,
        fixtureRequiredStatusWriter: async (request) => {
          if (request.state !== 'error') return;
          if (mode === 'write-failed') throw new Error('synthetic status outage');
          head = HEAD_B;
        },
      });
      expect(result.results).toEqual(expect.arrayContaining([
        expect.objectContaining({ runId: f.runId, statusReconciled: false }),
      ]));
      expect(getPackReviewRun(f.runId, f.options)?.failureReason).toBe(failure);
    },
  );
});

describe('Issue #2496 r03 public GPT command settlement', () => {
  it('partial-202-not-settled', async () => {
    const result = await runPackGptReviewCommand({ prNumber: 2496 }, {
      env: {}, stderr: { write: () => undefined },
      startReview: async () => ({
        ok: true, created: true, reason: 'gpt_sources_partial_pending_reconcile:2/3',
        prNumber: 2496, headSha: HEAD_A, runId: 'prr-partial',
        status: 'reviewing', httpStatus: 202,
      }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.result).toMatchObject({
      ok: false, created: true, runnerReason: 'gpt_sources_partial_pending_reconcile:2/3',
      status: 'reviewing', runId: 'prr-partial',
      outcome: 'review_not_settled', nextAction: expect.stringContaining('observe'),
    });
  });

  it('journal-failed-not-complete', async () => {
    const result = await runPackGptReviewCommand({ prNumber: 2496 }, {
      env: {}, stderr: { write: () => undefined },
      startReview: async () => ({
        ok: true, created: true, reason: 'journal_write_failed',
        prNumber: 2496, headSha: HEAD_A, runId: 'prr-journal',
        status: 'up_to_date', httpStatus: 201,
      }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.result).toMatchObject({
      ok: false, outcome: 'review_not_settled', runId: 'prr-journal',
      runnerReason: 'journal_write_failed', nextAction: expect.stringContaining('journal'),
    });
  });

  it('prose-harvest-failed-actionable', async () => {
    const result = await runPackGptReviewCommand({ prNumber: 2496 }, {
      env: {}, stderr: { write: () => undefined },
      startReview: async () => ({
        ok: false, created: true, reason: 'harvest_failed', status: 'failed',
        prNumber: 2496, headSha: HEAD_A, runId: 'prr-prose',
      }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.result).toMatchObject({
      ok: false, runnerReason: 'harvest_failed', status: 'failed',
      nextAction: expect.stringContaining('same-run slots'),
    });
  });

  it('accepts a verified delivered round but not an unobserved status', async () => {
    for (const verified of [false, true]) {
      const result = await runPackGptReviewCommand({ prNumber: 2496 }, {
        env: {}, stderr: { write: () => undefined },
        startReview: async () => ({
          ok: true, created: true, reason: 'completed', status: 'commented',
          prNumber: 2496, headSha: HEAD_A, runId: 'prr-verified',
          publicationHeadSha: HEAD_A, publicationVerified: verified,
        }),
      });
      expect(result.exitCode).toBe(verified ? 0 : 1);
    }
  });

  it('retains a distinct publication failure even when the runner accepted delivery work', async () => {
    const result = await runPackGptReviewCommand({ prNumber: 2496 }, {
      env: {}, stderr: { write: () => undefined },
      startReview: async () => ({
        ok: true, created: true, reason: 'completed_with_delivery_failures',
        publicationVerified: false,
        publicationReason: 'review_comment_not_published',
        prNumber: 2496, headSha: HEAD_A, runId: 'prr-comment-uncertain',
        status: 'up_to_date',
      }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.result).toMatchObject({
      ok: false, created: true, outcome: 'review_not_settled',
      reason: 'review_comment_not_published',
      runnerReason: 'completed_with_delivery_failures',
      runId: 'prr-comment-uncertain',
      headSha: HEAD_A,
      nextAction: expect.stringContaining('do not blindly duplicate'),
    });
  });
});

describe('Issue #2496 r03 genuine GPT source delivery and status observation', () => {
  function fixture(prNumber: number) {
    const storeRoot = tempRoot('opk-2496-gpt-observed-status-');
    const capture = path.join(storeRoot, 'github-review.json');
    harnessEnv(storeRoot, capture);
    process.env.PACK_GPT_BROWSER_PROJECT_URL = 'https://chatgpt.com/g/fixture/project';
    delete process.env.PACK_GPT_BROWSER_CHAT_URL;
    const statuses: string[] = [];
    let observed: string | undefined;
    const input = {
      projectId: 'orchestrator-pack', storeRoot, sourceRepoRoot: repoRoot,
      prNumber, headSha: HEAD_A, reviewerOverride: 'gpt' as const,
      fixtureCurrentPrHeadSha: HEAD_A, fixturePostReviewHeadSha: HEAD_A,
      fixturePrState: 'OPEN' as const,
      fixturePrBody: `Closes #${prNumber}`, fixturePostReviewPrBody: `Closes #${prNumber}`,
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureIssueNumber: prNumber,
      fixtureIssueBody: '```complexity-tier\ntier: T2\n```',
      claimMode: 'preacquired' as const,
      fixtureGithubReviewId: 249601,
      fixtureReviewBySourceSlot: {
        'source-01': [{ stdout: successfulCleanReviewPayload('inv-2496-gpt-source-01') }],
        'source-02': [{ stdout: successfulCleanReviewPayload('inv-2496-gpt-source-02') }],
        'source-03': [{ stdout: successfulCleanReviewPayload('inv-2496-gpt-source-03') }],
      },
      fixtureRequiredStatusReader: async (headSha: string) => {
        expect(headSha).toBe(HEAD_A);
        return observed;
      },
      fixtureRequiredStatusWriter: async (request: { state: string }) => {
        statuses.push(request.state);
        observed = request.state;
      },
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    };
    return {
      input, statuses, storeRoot,
      setObserved: (value: string | undefined) => { observed = value; },
      getObserved: () => observed,
    };
  }

  it('gpt-verified-delivery-and-notification-only-nonblocking', async () => {
    const f = fixture(249601);
    const reader = vi.fn(f.input.fixtureRequiredStatusReader);
    const result = await startPackReview({
      ...f.input,
      fixtureRequiredStatusReader: reader,
      fixtureWorkerNotifier: async () => { throw new Error('offline GPT worker notification failure'); },
    });
    expect(result).toMatchObject({
      ok: true, created: true, reason: 'completed',
      publicationVerified: true, publicationHeadSha: HEAD_A, requiredStatusState: 'success',
    });
    const run = getPackReviewRun(String(result.runId), { projectId: 'orchestrator-pack', storeRoot: f.storeRoot });
    expect(run?.reviewRound?.reviewer).toBe('gpt');
    expect(run?.reviewRound?.sourceSlots).toHaveLength(3);
    expect(run?.deliveryOutcomes.workerNotification?.state).toBe('failed');
    expect(f.statuses).toEqual(['pending', 'success']);
    expect(reader).toHaveBeenCalledWith(HEAD_A);
  });

  it('status-post-late-ack-restores-or-unresolved for genuine GPT', async () => {
    const f = fixture(249602);
    const result = await startPackReview({
      ...f.input,
      fixtureRequiredStatusWriter: async (request) => {
        f.statuses.push(request.state);
        const attempts = f.statuses.filter((state) => state === 'success').length;
        // The first ACK is followed by a visible older error status.
        f.setObserved(request.state === 'success' && attempts === 1 ? 'error' : request.state);
      },
    });
    expect(result).toMatchObject({
      ok: true, created: true, publicationVerified: true,
      publicationHeadSha: HEAD_A, requiredStatusState: 'success',
    });
    expect(f.statuses.filter((state) => state === 'success')).toHaveLength(2);
    expect(f.getObserved()).toBe('success');
  });

  it('status-ack-unobserved-not-settled for genuine GPT', async () => {
    const f = fixture(249603);
    const result = await startPackReview({
      ...f.input,
      fixtureRequiredStatusReader: async () => undefined,
    });
    expect(result).toMatchObject({
      ok: true, created: true, reason: 'completed',
      publicationVerified: false,
      publicationReason: 'status_not_published:current_head_status_unconfirmed',
      nextAction: expect.any(String),
    });
    expect(result).not.toHaveProperty('publicationHeadSha');
    expect(f.statuses.filter((state) => state === 'success')).toHaveLength(2);
  });

  it('status-failed-comment-success-reposts via the same GPT journaled PR-led resume', async () => {
    const f = fixture(249604);
    let denyFirstTerminalPost = true;
    const writer = async (request: { state: string }) => {
      f.statuses.push(request.state);
      if (request.state === 'success' && denyFirstTerminalPost) {
        denyFirstTerminalPost = false;
        throw new Error('offline required-status POST failed');
      }
      f.setObserved(request.state);
    };
    const first = await startPackReview({ ...f.input, fixtureRequiredStatusWriter: writer });
    expect(first).toMatchObject({
      ok: true, created: true, publicationVerified: false,
      publicationReason: 'status_not_published:failed_required_status_channel',
    });
    expect(f.statuses.filter((state) => state === 'success')).toHaveLength(1);
    const priorRun = getPackReviewRun(String(first.runId), { projectId: 'orchestrator-pack', storeRoot: f.storeRoot });
    const priorAttempts = priorRun?.reviewRound?.sourceSlots.map((slot) => ({
      slotId: slot.slotId, invocationId: slot.invocationId, attemptOrdinal: slot.attemptOrdinal,
    }));
    expect(priorAttempts).toHaveLength(3);
    const noNewSourceInvocations = vi.fn(() => { throw new Error('journaled status resume must never resend GPT sources'); });
    const recovered = await startPackReview({
      ...f.input,
      fixtureRequiredStatusWriter: writer,
      fixtureAfterGptInvocationBound: noNewSourceInvocations,
    });
    expect(recovered).toMatchObject({
      ok: true, created: false, reused: true, recovered: true,
      runId: first.runId, reason: 'resumed_journaled_delivery',
      publicationVerified: true, publicationHeadSha: HEAD_A, requiredStatusState: 'success',
    });
    expect(f.statuses.filter((state) => state === 'success')).toHaveLength(2);
    const runs = listPackReviewRuns({ projectId: 'orchestrator-pack', storeRoot: f.storeRoot });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.reviewRound?.sourceSlots.map((slot) => ({
      slotId: slot.slotId, invocationId: slot.invocationId, attemptOrdinal: slot.attemptOrdinal,
    }))).toEqual(priorAttempts);
    expect(noNewSourceInvocations).not.toHaveBeenCalled();
  });

  it('genuine GPT head drift does not inherit an earlier acknowledged status', async () => {
    const f = fixture(249605);
    let liveHead = HEAD_A;
    const result = await startPackReview({
      ...f.input,
      fixtureReadCurrentPrHead: async () => liveHead,
      fixtureRequiredStatusWriter: async (request) => {
        f.statuses.push(request.state);
        f.setObserved(request.state);
        if (request.state === 'success') liveHead = HEAD_B;
      },
    });
    expect(result).toMatchObject({
      ok: true, created: true, publicationVerified: false,
      publicationReason: expect.stringContaining('status_not_published'),
    });
    expect(result).not.toHaveProperty('publicationHeadSha');
  });
});

describe('Issue #2496 native PR-only command settlement compatibility', () => {
  it.each(['claude', 'codex'] as const)(
    'keeps a delivered %s result successful without GPT-only publication proof',
    async (reviewer) => {
      const execution = await runPackGptReviewCommand({ prNumber: 1111 }, {
        env: {}, stderr: { write: () => undefined },
        startReview: async () => ({
          ok: true, created: true, reused: false, resolvedReviewer: reviewer,
          reason: 'completed', status: 'up_to_date', httpStatus: 201,
          prNumber: 1111, headSha: HEAD_A, runId: `prr-native-${reviewer}`,
        }),
      });
      expect(execution).toMatchObject({
        exitCode: 0, result: {
          ok: true, created: true, resolvedReviewer: reviewer,
          reason: 'completed', status: 'up_to_date',
        },
      });
      expect(execution.result).not.toHaveProperty('publicationVerified');
    },
  );

  it.each([
    ['unselected', undefined, 'completed', 'up_to_date', 201, undefined],
    ['GPT without status observation', 'gpt', 'completed', 'up_to_date', 201, undefined],
    ['native failed delivery', 'claude', 'completed_with_delivery_failures', 'up_to_date', 201, undefined],
    ['native unfinished review', 'codex', 'completed', 'reviewing', 201, undefined],
    ['native accepted-but-pending', 'codex', 'completed', 'up_to_date', 202, undefined],
    ['native explicit unverified publication', 'claude', 'completed', 'up_to_date', 201, false],
  ] as const)(
    'does not turn %s into a settled terminal result',
    async (_label, reviewer, reason, status, httpStatus, publicationVerified) => {
      const execution = await runPackGptReviewCommand({ prNumber: 1111 }, {
        env: {}, stderr: { write: () => undefined },
        startReview: async () => ({
          ok: true, created: true, reused: false,
          ...(reviewer ? { resolvedReviewer: reviewer } : {}),
          ...(publicationVerified === undefined ? {} : { publicationVerified }),
          reason, status, httpStatus,
          prNumber: 1111, headSha: HEAD_A, runId: 'prr-negative-native-shape',
        }),
      });
      expect(execution).toMatchObject({
        exitCode: 1, result: {
          ok: false, created: true, outcome: 'review_not_settled',
          runnerReason: reason,
          nextAction: expect.any(String),
        },
      });
    },
  );
});
