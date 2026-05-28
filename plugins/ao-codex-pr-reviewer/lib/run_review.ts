import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface RunCodexReviewOptions {
  repoRoot: string;
  baseRef: string;
  prompt: string;
  model?: string;
  /** When set, skip Codex and use this stdout instead (tests). */
  fixtureStdout?: string;
}

export interface RunCodexReviewResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function readOutputFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
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
    '--base',
    options.baseRef,
    '--output-last-message',
    options.outputFile,
    '--dangerously-bypass-approvals-and-sandbox',
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
      env: process.env,
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
