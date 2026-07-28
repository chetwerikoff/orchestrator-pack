import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as subprocess from './kernel/subprocess.ts';
import {
  defaultRunBrowserTurn,
  runGptPackReview,
  type GptReviewDependencies,
} from './lib/pack-gpt-reviewer.ts';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe('GPT browser transport path (Issue #1031 AC3/AC12)', () => {
  it('defaultRunBrowserTurn invokes npm run chatgpt-browser-turn -- turn with profile, cdp, and chat-url', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'opk-gpt-browser-turn-'));
    const inputPath = join(workDir, 'prompt.txt');
    const outputPath = join(workDir, 'reply.txt');
    writeFileSync(inputPath, 'https://github.com/example/repo/pull/42\n\nreview', 'utf8');

    const runProcess = vi.spyOn(subprocess, 'runProcess').mockResolvedValue({
      outcome: 'exit',
      ok: true,
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      cancelled: false,
    });

    try {
      await defaultRunBrowserTurn({
        packRoot: process.cwd(),
        inputPath,
        outputPath,
        config: {
          profile: '/tmp/profile',
          cdpUrl: 'http://127.0.0.1:9222',
          chatUrl: 'https://chatgpt.com/c/test',
        },
      });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }

    expect(runProcess).toHaveBeenCalledTimes(1);
    const call = runProcess.mock.calls[0]?.[0];
    expect(call?.command).toBe('npm');
    expect(call?.args).toEqual([
      'run',
      'chatgpt-browser-turn',
      '--',
      'turn',
      '--profile', '/tmp/profile',
      '--cdp', 'http://127.0.0.1:9222',
      '--input', inputPath,
      '--output', outputPath,
      '--chat-url', 'https://chatgpt.com/c/test',
    ]);
  });

  it('fails closed when the tracked browser turn returns a non-ok result', async () => {
    const deps: GptReviewDependencies = {
      resolveBrowserConfig: () => ({
        profile: '/tmp/profile',
        cdpUrl: 'http://127.0.0.1:9222',
        chatUrl: 'https://chatgpt.com/c/test',
      }),
      runBrowserTurn: async () => ({
        outcome: 'exit',
        ok: false,
        exitCode: 12,
        signal: null,
        stdout: '{"schema":"turn-result/v1","state":"orphaned_fresh_turn"}',
        stderr: '',
        timedOut: false,
        cancelled: false,
      }),
      resolvePrUrl: () => 'https://github.com/example/repo/pull/42',
    };

    const result = await runGptPackReview({
      repoRoot: process.cwd(),
      repoSlug: 'example/repo',
      prNumber: 42,
      headSha: 'd'.repeat(40),
    }, deps, {
      PACK_GPT_BROWSER_PROFILE: '/tmp/profile',
      PACK_GPT_BROWSER_CDP: 'http://127.0.0.1:9222',
      PACK_GPT_BROWSER_CHAT_URL: 'https://chatgpt.com/c/test',
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/orphaned_fresh_turn|browser turn failed/i);
  });

  it('fails closed when browser turn times out before a terminal payload exists', async () => {
    const deps: GptReviewDependencies = {
      resolveBrowserConfig: () => ({
        profile: '/tmp/profile',
        cdpUrl: 'http://127.0.0.1:9222',
        chatUrl: 'https://chatgpt.com/c/test',
      }),
      runBrowserTurn: async () => ({
        outcome: 'timeout',
        ok: false,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: true,
        cancelled: false,
      }),
      resolvePrUrl: () => 'https://github.com/example/repo/pull/42',
    };

    const result = await runGptPackReview({
      repoRoot: process.cwd(),
      repoSlug: 'example/repo',
      prNumber: 42,
      headSha: 'e'.repeat(40),
    }, deps, {
      PACK_GPT_BROWSER_PROFILE: '/tmp/profile',
      PACK_GPT_BROWSER_CDP: 'http://127.0.0.1:9222',
      PACK_GPT_BROWSER_CHAT_URL: 'https://chatgpt.com/c/test',
    });

    expect(result.exitCode).toBe(124);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/timed out/i);
  });

  it('returns parseable terminal stdout through default browser turn and adapter chain', async () => {
    const runProcess = vi.spyOn(subprocess, 'runProcess').mockImplementation(async (options) => {
      const outputIndex = options.args?.indexOf('--output') ?? -1;
      if (options.command === 'npm' && outputIndex >= 0) {
        const outputPath = options.args![outputIndex + 1]!;
        writeFileSync(outputPath, 'NO_FINDINGS', 'utf8');
        return {
          outcome: 'exit',
          ok: true,
          exitCode: 0,
          signal: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          cancelled: false,
        };
      }
      throw new Error(`unexpected subprocess call: ${options.command} ${options.args?.join(' ')}`);
    });

    try {
      const result = await runGptPackReview({
        repoRoot: process.cwd(),
        repoSlug: 'example/repo',
        prNumber: 42,
        headSha: 'f'.repeat(40),
      }, {}, {
        PACK_GPT_BROWSER_PROFILE: '/tmp/profile',
        PACK_GPT_BROWSER_CDP: 'http://127.0.0.1:9222',
        PACK_GPT_BROWSER_CHAT_URL: 'https://chatgpt.com/c/test',
      });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ verdict: 'clean', findingCount: 0, findings: [] });
      expect(runProcess).toHaveBeenCalled();
      const npmCall = runProcess.mock.calls.find(([options]) => options.command === 'npm');
      expect(npmCall?.[0].args).toEqual(expect.arrayContaining(['run', 'chatgpt-browser-turn', '--', 'turn']));
    } finally {
      runProcess.mockRestore();
    }
  });
});
