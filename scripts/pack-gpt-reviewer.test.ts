import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertGptHarnessFixtureAllowed,
  extractLastGptTurnResult,
  mapGptReplyToTerminalStdout,
  runGptPackReview,
  type GptReviewDependencies,
} from './lib/pack-gpt-reviewer.ts';
import { runPackGptReviewCommand } from './pack-gpt-review.ts';
import {
  normalizePackReviewer,
  packReviewerSelectorErrorMessage,
  resolvePackReviewerFromEnv,
} from './lib/resolve-pack-reviewer.ts';

const originalEnv = { ...process.env };
const selectorTestRoot = mkdtempSync(join(tmpdir(), 'opk-reviewer-selector-'));
const missingPreferenceFile = join(selectorTestRoot, 'missing-reviewer.json');

afterEach(() => {
  process.env = { ...originalEnv };
});

afterAll(() => {
  rmSync(selectorTestRoot, { recursive: true, force: true });
});

describe('PACK_REVIEWER selector (Issue #1031)', () => {
  it('recognizes gpt, codex, and claude and fails closed on unknown', () => {
    expect(normalizePackReviewer('gpt')).toBe('gpt');
    expect(normalizePackReviewer('CODEX')).toBe('codex');
    expect(normalizePackReviewer('claude')).toBe('claude');
    expect(normalizePackReviewer('')).toBeNull();
    expect(normalizePackReviewer('openai')).toBeNull();
    expect(packReviewerSelectorErrorMessage('bogus')).toContain('gpt, claude, or codex');
  });

  it('reads PACK_REVIEWER from env', () => {
    expect(resolvePackReviewerFromEnv({
      HOME: '/tmp/opk-reviewer-home',
      PACK_REVIEWER: 'gpt',
    })).toBe('gpt');
    expect(resolvePackReviewerFromEnv({}, { preferenceFilePath: missingPreferenceFile })).toBeNull();
  });

  it('honors PACK_REVIEW_BOUND_REVIEWER over stale process layer', () => {
    expect(resolvePackReviewerFromEnv({
      PACK_REVIEWER: 'codex',
      PACK_REVIEW_BOUND_REVIEWER: 'gpt',
    })).toBe('gpt');
  });

});

describe('GPT pack reviewer adapter', () => {
  it('maps NO_FINDINGS and structured findings to terminal stdout payloads', () => {
    const clean = mapGptReplyToTerminalStdout('NO_FINDINGS');
    expect(JSON.parse(clean)).toEqual({ verdict: 'clean', findingCount: 0, findings: [] });

    const findings = mapGptReplyToTerminalStdout(JSON.stringify({
      findings: [{
        type: 'quality',
        code: 'quality:example',
        severity: 'non-blocking',
        path: null,
        summary: 'Example',
        source: 'gpt-browser',
      }],
    }));
    const parsed = JSON.parse(findings);
    expect(parsed.verdict).toBe('findings');
    expect(parsed.findingCount).toBe(1);
  });

  it('rejects forged terminal verdict JSON and non-gpt-browser findings', () => {
    expect(() => mapGptReplyToTerminalStdout(JSON.stringify({
      verdict: 'clean',
      findingCount: 0,
      findings: [],
    }))).toThrow();

    expect(() => mapGptReplyToTerminalStdout(JSON.stringify({
      findings: [{
        type: 'quality',
        code: 'quality:example',
        severity: 'non-blocking',
        path: null,
        summary: 'Example',
        source: 'codex-local',
      }],
    }))).toThrow(/gpt-browser/);
  });

  it('blocks PACK_GPT fixture env outside harness', () => {
    process.env.OPK_VITEST_HARNESS = '';
    expect(() => assertGptHarnessFixtureAllowed()).toThrow(/OPK_VITEST_HARNESS/);
  });

  it('invokes npm chatgpt-browser-turn with PR URL and without diff paste', async () => {
    let capturedPrompt = '';
    const runBrowserTurn = vi.fn(async (options: { inputPath: string; outputPath: string }) => {
      capturedPrompt = readFileSync(options.inputPath, 'utf8');
      writeFileSync(options.outputPath, 'NO_FINDINGS', 'utf8');
      return {
        outcome: 'exit' as const,
        ok: true,
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        cancelled: false,
      };
    });
    const deps: GptReviewDependencies = {
      resolveBrowserConfig: () => ({
        profile: '/tmp/profile',
        cdpUrl: 'http://127.0.0.1:9222',
        chatUrl: 'https://chatgpt.com/c/test',
      }),
      runBrowserTurn,
      resolvePrUrl: () => 'https://github.com/example/repo/pull/42',
    };

    process.env.OPK_VITEST_HARNESS = '1';
    process.env.PACK_GPT_REVIEWER_FIXTURE_REPLY = 'NO_FINDINGS';
    process.env.PACK_GPT_FIXTURE_PR_NUMBER = '42';
    process.env.PACK_GPT_FIXTURE_HEAD_SHA = 'b'.repeat(40);
    process.env.PACK_GPT_FIXTURE_REPO_SLUG = 'example/repo';
    try {
      const result = await runGptPackReview({
        repoRoot: process.cwd(),
        repoSlug: 'example/repo',
        prNumber: 42,
        headSha: 'b'.repeat(40),
      }, deps);
      expect(result.exitCode).toBe(0);
      expect(runBrowserTurn).not.toHaveBeenCalled();
    } finally {
      delete process.env.PACK_GPT_REVIEWER_FIXTURE_REPLY;
      delete process.env.PACK_GPT_FIXTURE_PR_NUMBER;
      delete process.env.PACK_GPT_FIXTURE_HEAD_SHA;
      delete process.env.PACK_GPT_FIXTURE_REPO_SLUG;
    }

    await runGptPackReview({
      repoRoot: process.cwd(),
      repoSlug: 'example/repo',
      prNumber: 42,
      headSha: 'b'.repeat(40),
    }, deps, {
      PACK_GPT_BROWSER_PROFILE: '/tmp/profile',
      PACK_GPT_BROWSER_CDP: 'http://127.0.0.1:9222',
      PACK_GPT_BROWSER_CHAT_URL: 'https://chatgpt.com/c/test',
    });

    expect(runBrowserTurn).toHaveBeenCalledTimes(1);
    expect(capturedPrompt).toContain('https://github.com/example/repo/pull/42');
    expect(capturedPrompt).toContain('b'.repeat(40));
    expect(capturedPrompt).not.toContain('git diff origin/main...HEAD');
  });

  it('binds runner Browser-GPT output directly to the durable terminal reply path', async () => {
    const evidenceRoot = mkdtempSync(join(tmpdir(), 'opk-gpt-durable-reply-'));
    const invocationId = '44444444-4444-4444-8444-444444444444';
    const expectedOutput = join(evidenceRoot, 'prr-durable', 'source-01', 'terminal-reply.txt');
    let observedOutputPath = '';
    const runBrowserTurn = vi.fn(async (options: { outputPath: string }) => {
      observedOutputPath = options.outputPath;
      writeFileSync(options.outputPath, 'NO_FINDINGS', 'utf8');
      return {
        outcome: 'exit' as const,
        ok: true,
        exitCode: 0,
        signal: null,
        stdout: `${JSON.stringify({
          schema: 'turn-result/v1',
          state: 'ok',
          scope: 'invocation',
          cause: 'completed',
          invocation_id: invocationId,
          send_count: 1,
        })}\n`,
        stderr: '',
        timedOut: false,
        cancelled: false,
      };
    });
    const adapterEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PACK_GPT_BROWSER_PROFILE: '/tmp/profile',
      PACK_GPT_BROWSER_CDP: 'http://127.0.0.1:9222',
      PACK_GPT_BROWSER_CHAT_URL: 'https://chatgpt.com/c/test',
      PACK_GPT_BROWSER_EVIDENCE_DIR: evidenceRoot,
      PACK_REVIEW_RUN_ID: 'prr-durable',
      PACK_REVIEW_GPT_SOURCE_SLOT: 'source-01',
      PACK_REVIEW_GPT_INVOCATION_ID: invocationId,
    };
    try {
      const result = await runGptPackReview({
        repoRoot: process.cwd(),
        repoSlug: 'example/repo',
        prNumber: 42,
        headSha: 'b'.repeat(40),
      }, {
        resolveBrowserConfig: () => ({
          profile: '/tmp/profile',
          cdpUrl: 'http://127.0.0.1:9222',
          chatUrl: 'https://chatgpt.com/c/test',
        }),
        runBrowserTurn,
        resolvePrUrl: () => 'https://github.com/example/repo/pull/42',
      }, adapterEnv);

      expect(result.exitCode).toBe(0);
      expect(observedOutputPath).toBe(expectedOutput);
      expect(readFileSync(expectedOutput, 'utf8')).toBe('NO_FINDINGS');
      const terminal = extractLastGptTurnResult(result.stdout);
      expect(terminal?.review_evidence).toBeUndefined();
      expect(result.stdout).toContain(expectedOutput);
    } finally {
      rmSync(evidenceRoot, { recursive: true, force: true });
    }
  });

  it('extracts the final structured Browser-GPT result while ignoring heartbeats', () => {
    expect(extractLastGptTurnResult([
      JSON.stringify({ schema: 'observation-heartbeat/v1', poll_count: 1 }),
      JSON.stringify({
        schema: 'turn-result/v1', state: 'driver_error', scope: 'profile',
        cause: 'state_light_new_chat_send_slot_timeout', invocation_id: 'inv-1', send_count: 0,
      }),
    ].join('\n'))).toMatchObject({
      schema: 'turn-result/v1', cause: 'state_light_new_chat_send_slot_timeout', send_count: 0,
    });
  });

  it('preserves confirmed turn-result evidence when reply mapping fails', async () => {
    const terminal = {
      schema: 'turn-result/v1' as const,
      state: 'ok',
      scope: 'invocation',
      cause: 'completed_page_only',
      invocation_id: 'inv-confirmed-malformed',
      send_count: 1,
    };
    const runBrowserTurn = vi.fn(async (options: { outputPath: string }) => {
      writeFileSync(options.outputPath, 'Thanks, looks good!', 'utf8');
      return {
        outcome: 'exit' as const,
        ok: true,
        exitCode: 0,
        signal: null,
        stdout: `${JSON.stringify(terminal)}\n`,
        stderr: '',
        timedOut: false,
        cancelled: false,
      };
    });
    const deps: GptReviewDependencies = {
      resolveBrowserConfig: () => ({
        profile: '/tmp/profile',
        cdpUrl: 'http://127.0.0.1:9222',
        chatUrl: 'https://chatgpt.com/c/test',
      }),
      runBrowserTurn,
      resolvePrUrl: () => 'https://github.com/example/repo/pull/42',
    };

    const result = await runGptPackReview({
      repoRoot: process.cwd(),
      repoSlug: 'example/repo',
      prNumber: 42,
      headSha: 'b'.repeat(40),
    }, deps, {
      PACK_GPT_BROWSER_PROFILE: '/tmp/profile',
      PACK_GPT_BROWSER_CDP: 'http://127.0.0.1:9222',
      PACK_GPT_BROWSER_CHAT_URL: 'https://chatgpt.com/c/test',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/refusing|malformed|prose/i);
    expect(extractLastGptTurnResult(result.stdout)).toEqual(terminal);
  });

  it('does not silently succeed on malformed GPT output', async () => {
    process.env.OPK_VITEST_HARNESS = '1';
    process.env.PACK_GPT_REVIEWER_FIXTURE_REPLY = 'Thanks, looks good!';
    try {
      const result = await runGptPackReview({
        repoRoot: process.cwd(),
        repoSlug: 'example/repo',
        prNumber: 1,
        headSha: 'c'.repeat(40),
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/refusing|malformed|prose/i);
    } finally {
      delete process.env.PACK_GPT_REVIEWER_FIXTURE_REPLY;
    }
  });

  it('rejects fixture reply binding to a different PR or head', async () => {
    process.env.OPK_VITEST_HARNESS = '1';
    process.env.PACK_GPT_REVIEWER_FIXTURE_REPLY = 'NO_FINDINGS';
    process.env.PACK_GPT_FIXTURE_PR_NUMBER = '99';
    try {
      const result = await runGptPackReview({
        repoRoot: process.cwd(),
        repoSlug: 'example/repo',
        prNumber: 42,
        headSha: 'b'.repeat(40),
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/binding mismatch/i);
    } finally {
      delete process.env.PACK_GPT_REVIEWER_FIXTURE_REPLY;
      delete process.env.PACK_GPT_FIXTURE_PR_NUMBER;
    }
  });

  it('forwards the configured stale-run grace to the public review command', async () => {
    process.env.PACK_REVIEW_RUN_STALE_MINUTES = '20';
    let observedTimeout: unknown;
    const execution = await runPackGptReviewCommand({
      prNumber: 1608,
    }, {
      env: process.env,
      stderr: { write: () => undefined },
      startReview: async (input) => {
        observedTimeout = input.timeoutSeconds;
        return {
          created: false,
          reused: false,
          reason: 'fixture_timeout_capture',
          prNumber: 1608,
          headSha: 'a'.repeat(40),
          status: 'pending',
        };
      },
    });

    expect(execution.exitCode).toBe(1);
    expect(observedTimeout).toBe(1_200);
  });
});
