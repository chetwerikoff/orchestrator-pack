import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  mapGptReplyToTerminalStdout,
  runGptPackReview,
  type GptReviewDependencies,
} from './lib/pack-gpt-reviewer.ts';
import {
  normalizePackReviewer,
  packReviewerSelectorErrorMessage,
  resolvePackReviewerFromEnv,
} from './lib/resolve-pack-reviewer.ts';

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
    expect(resolvePackReviewerFromEnv({ PACK_REVIEWER: 'gpt' })).toBe('gpt');
    expect(resolvePackReviewerFromEnv({})).toBeNull();
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

    process.env.PACK_GPT_REVIEWER_FIXTURE_REPLY = 'NO_FINDINGS';
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
    }

    delete process.env.PACK_GPT_REVIEWER_FIXTURE_REPLY;
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

  it('does not silently succeed on malformed GPT output', async () => {
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
});
