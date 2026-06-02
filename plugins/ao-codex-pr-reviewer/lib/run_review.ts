import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ReviewSource } from './types.js';

export interface RunCodexReviewOptions {
  repoRoot: string;
  baseRef: string;
  prompt: string;
  model?: string;
  source?: ReviewSource;
  /** When set, skip Codex and use this as last-message output (tests). */
  fixtureStdout?: string;
  /** When set with fixtureStdout, supplies Codex `--json` process stdout (tests). */
  fixtureProcessJsonl?: string;
  /** When set with fixtureStdout, supplies persisted session JSONL (tests). */
  fixtureSessionJsonl?: string;
}

export interface RunCodexReviewResult {
  exitCode: number;
  /** Codex `--json` process stdout (JSONL events). */
  processJsonl: string;
  /** Final message from `--output-last-message` (fallback/diagnostic channel). */
  lastMessage: string;
  stderr: string;
  /** @deprecated Use {@link lastMessage}. */
  stdout: string;
}

const CODEX_SPAWN_ENV_STRIP = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'CODEX_AUTH_JSON',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
] as const;

function readOutputFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function buildCodexSpawnEnv(source?: ReviewSource): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const untrusted =
    source === 'codex-github-action' || Boolean(process.env.PR_REPO_ROOT?.trim());
  if (!untrusted) {
    return env;
  }
  for (const key of CODEX_SPAWN_ENV_STRIP) {
    delete env[key];
  }
  return env;
}

/**
 * Codex CLI 0.13x treats `--base` and a custom [PROMPT] as mutually exclusive.
 * Pack review uses stdin prompt mode (includes base-ref scope in the prompt text).
 */
export function buildCodexExecReviewArgs(options: {
  outputFile: string;
  model?: string;
}): string[] {
  const args = ['exec', '--sandbox', 'read-only', 'review'];
  if (options.model) {
    args.push('-m', options.model);
  }
  args.push('--json', '--output-last-message', options.outputFile, '-');
  return args;
}

export function runCodexReview(options: RunCodexReviewOptions): RunCodexReviewResult {
  if (options.fixtureStdout !== undefined) {
    const lastMessage = options.fixtureStdout;
    return {
      exitCode: 0,
      processJsonl: options.fixtureProcessJsonl ?? '',
      lastMessage,
      stdout: lastMessage,
      stderr: '',
    };
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'ao-codex-review-'));
  const outputFile = join(tempDir, 'last-message.txt');

  try {
    const args = buildCodexExecReviewArgs({
      outputFile,
      model: options.model,
    });

    const spawnOptions = {
      cwd: options.repoRoot,
      input: options.prompt,
      encoding: 'utf8' as const,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 10 * 60_000,
      env: buildCodexSpawnEnv(options.source),
    };

    let result: ReturnType<typeof spawnSync>;
    if (process.platform === 'win32') {
      result = spawnSync(
        'cmd.exe',
        ['/c', 'codex', ...args],
        { ...spawnOptions, shell: false },
      );
    } else {
      result = spawnSync('codex', args, spawnOptions);
    }

    const stderr = (result.stderr ?? '').toString();
    const processJsonl = (result.stdout ?? '').toString();
    const fromFile = readOutputFile(outputFile);
    const lastMessage = (fromFile ?? '').trim();

    return {
      exitCode: result.status ?? 1,
      processJsonl,
      lastMessage,
      stdout: lastMessage,
      stderr,
    };
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}
