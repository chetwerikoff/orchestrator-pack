import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as subprocess from './kernel/subprocess.ts';
import {
  defaultRunBrowserTurn,
  mapGptReplyToTerminalStdout,
  runGptPackReview,
  type GptReviewDependencies,
} from './lib/pack-gpt-reviewer.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const harnessBin = join(repoRoot, 'tests/fixtures/bin');
const harnessSmokeRecord = JSON.parse(readFileSync(
  join(repoRoot, 'tests/external-output-references/pack-gpt-browser-smoke-56875db8.json'),
  'utf8',
)) as { headSha: string; replyToken: string; evidenceKind: string };
const runnerSmokeRecord = JSON.parse(readFileSync(
  join(repoRoot, 'tests/external-output-references/pack-gpt-browser-smoke-e83275e3.json'),
  'utf8',
)) as {
  headSha: string;
  evidenceKind: string;
  packReviewRunId: string;
  githubReviewId: number;
  adapterPromptPath: string;
  adapterPromptSha256: string;
  terminalReplyPath: string;
  terminalReplySha256: string;
  adapterStdoutPath: string;
  harnessIntegrationOnly: string;
};

function successfulTurnResult(): string {
  return JSON.stringify({
    schema: 'turn-result/v1',
    state: 'ok',
    scope: 'none',
    cause: 'completed_page_only',
    invocation_id: '00000000-0000-4000-8000-000000000001',
    configured_profile_key: 'fixture-profile',
    send_count: 1,
    poll_count: 1,
    goto_count: 1,
    new_chat_click_count: 0,
    navigation_count: 1,
    incidents: [],
    cleanup: 'confirmed',
  });
}

const originalEnv = { ...process.env };

function sha256File(relativePath: string): string {
  const bytes = readFileSync(join(repoRoot, relativePath));
  return createHash('sha256').update(bytes).digest('hex');
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe('GPT browser transport path (Issue #1031 AC3/AC12)', () => {
  it('retains runner-driven AC3 smoke evidence with causal adapter→reply→stdout→publication binding', () => {
    expect(runnerSmokeRecord.evidenceKind).toBe('runner-driven-adapter-turn');
    expect(runnerSmokeRecord.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(runnerSmokeRecord.packReviewRunId).toMatch(/^prr-/);
    expect(runnerSmokeRecord.githubReviewId).toBeGreaterThan(0);
    expect(harnessSmokeRecord.evidenceKind).toBe('harness-integration-only');
    expect(runnerSmokeRecord.harnessIntegrationOnly).toContain('pack-gpt-browser-smoke-56875db8.json');

    expect(sha256File(runnerSmokeRecord.adapterPromptPath)).toBe(runnerSmokeRecord.adapterPromptSha256);
    expect(sha256File(runnerSmokeRecord.terminalReplyPath)).toBe(runnerSmokeRecord.terminalReplySha256);

    const prompt = readFileSync(join(repoRoot, runnerSmokeRecord.adapterPromptPath), 'utf8');
    const reply = readFileSync(join(repoRoot, runnerSmokeRecord.terminalReplyPath), 'utf8');
    const stdout = readFileSync(join(repoRoot, runnerSmokeRecord.adapterStdoutPath), 'utf8').trim();

    expect(prompt).toContain(runnerSmokeRecord.headSha);
    expect(prompt).toContain('https://github.com/chetwerikoff/orchestrator-pack/pull/1050');
    expect(prompt).toContain('Do **not** create GitHub reviews');
    expect(prompt).not.toMatch(/выполни пак ревью/i);
    expect(mapGptReplyToTerminalStdout(reply)).toBe(stdout);
  });

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

  it('returns parseable terminal stdout through harness integration npm shim without runProcess mocks', async () => {
    chmodSync(join(harnessBin, 'npm'), 0o755);
    const priorPath = process.env.PATH;
    process.env.PATH = `${harnessBin}:${priorPath ?? ''}`;
    process.env.OPK_VITEST_HARNESS = '1';

    const result = await runGptPackReview({
      repoRoot: process.cwd(),
      repoSlug: 'chetwerikoff/orchestrator-pack',
      prNumber: 1050,
      headSha: harnessSmokeRecord.headSha,
    }, {}, {
      PACK_GPT_BROWSER_PROFILE: '/tmp/opk-harness-profile',
      PACK_GPT_BROWSER_CDP: 'http://127.0.0.1:9222',
      PACK_GPT_BROWSER_CHAT_URL: 'https://chatgpt.com/c/harness-smoke',
    });

    process.env.PATH = priorPath;
    expect(result.exitCode).toBe(0);
    const output = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(output[0]).toMatchObject({ schema: 'turn-result/v1', send_count: 1 });
    expect(output.at(-1)).toEqual({ verdict: 'clean', findingCount: 0, findings: [] });
  });

  it('writes adapter prompt, terminal reply, and mapped stdout when evidence dir is set', async () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), 'opk-gpt-evidence-'));
    const deps: GptReviewDependencies = {
      resolveBrowserConfig: () => ({
        profile: '/tmp/profile',
        cdpUrl: 'http://127.0.0.1:9222',
        chatUrl: 'https://chatgpt.com/c/test',
      }),
      runBrowserTurn: async ({ outputPath }) => {
        writeFileSync(outputPath, 'NO_FINDINGS', 'utf8');
        return {
          outcome: 'exit' as const,
          ok: true,
          exitCode: 0,
          signal: null,
          stdout: successfulTurnResult(),
          stderr: '',
          timedOut: false,
          cancelled: false,
        };
      },
      resolvePrUrl: () => 'https://github.com/example/repo/pull/99',
    };

    const result = await runGptPackReview({
      repoRoot: process.cwd(),
      repoSlug: 'example/repo',
      prNumber: 99,
      headSha: 'a'.repeat(40),
    }, deps, {
      PACK_GPT_BROWSER_PROFILE: '/tmp/profile',
      PACK_GPT_BROWSER_CDP: 'http://127.0.0.1:9222',
      PACK_GPT_BROWSER_CHAT_URL: 'https://chatgpt.com/c/test',
      PACK_GPT_BROWSER_EVIDENCE_DIR: evidenceDir,
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(evidenceDir, 'terminal-reply.txt'), 'utf8')).toBe('NO_FINDINGS');
    expect(readFileSync(join(evidenceDir, 'adapter-stdout.json'), 'utf8').trim()).toBe(result.stdout.trim());
    rmSync(evidenceDir, { recursive: true, force: true });
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
          stdout: successfulTurnResult(),
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
      const output = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(output[0]).toMatchObject({ schema: 'turn-result/v1', send_count: 1 });
      expect(output.at(-1)).toEqual({ verdict: 'clean', findingCount: 0, findings: [] });
      expect(runProcess).toHaveBeenCalled();
      const npmCall = runProcess.mock.calls.find(([options]) => options.command === 'npm');
      expect(npmCall?.[0].args).toEqual(expect.arrayContaining(['run', 'chatgpt-browser-turn', '--', 'turn']));
    } finally {
      runProcess.mockRestore();
    }
  });
});
