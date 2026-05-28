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
  /** When set, skip Codex and use this stdout instead (tests). */
  fixtureStdout?: string;
}

export interface RunCodexReviewResult {
  exitCode: number;
  stdout: string;
  stderr: string;
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

export function buildCodexExecReviewArgs(options: {
  baseRef: string;
  outputFile: string;
  model?: string;
}): string[] {
  const args = ['exec', 'review'];
  if (options.model) {
    args.push('-m', options.model);
  }
  args.push(
    '--sandbox',
    'read-only',
    '--base',
    options.baseRef,
    '--output-last-message',
    options.outputFile,
    '-',
  );
  return args;
}

export function runCodexReview(options: RunCodexReviewOptions): RunCodexReviewResult {
  if (options.fixtureStdout !== undefined) {
    return { exitCode: 0, stdout: options.fixtureStdout, stderr: '' };
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'ao-codex-review-'));
  const outputFile = join(tempDir, 'last-message.txt');

  try {
    const args = buildCodexExecReviewArgs({
      baseRef: options.baseRef,
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
    const stdout = (result.stdout ?? '').toString();
    const fromFile = readOutputFile(outputFile);
    const combined = (fromFile ?? stdout).trim() || stderr.trim();

    return {
      exitCode: result.status ?? 1,
      stdout: combined,
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
