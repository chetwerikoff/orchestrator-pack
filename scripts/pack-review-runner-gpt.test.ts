import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startPackReview } from './pack-review-runner.js';

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

      if (existsSync(invocationLog)) {
        const lines = readFileSync(invocationLog, 'utf8').trim().split('\n').filter(Boolean);
        for (const line of lines) {
          const entry = JSON.parse(line) as { reviewer?: string; args?: string[] };
          expect(entry.reviewer).toBe('gpt');
          expect(entry.args?.join(' ')).toContain('invoke-pack-review.ps1');
          expect(entry.args?.join(' ')).not.toContain('run-pack-review.ps1');
        }
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
