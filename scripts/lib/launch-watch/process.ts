import { runProcess, type ProcessResult } from '../../kernel/subprocess.ts';

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly timeoutMs: number; readonly input?: string },
) => Promise<ProcessResult>;

export const runOwnedProcess: ProcessRunner = (command, args, options) => runProcess({
  command: process.platform === 'win32' ? command : 'setsid',
  args: process.platform === 'win32' ? args : [command, ...args],
  cwd: options.cwd,
  timeoutMs: options.timeoutMs,
  input: options.input,
  allowEmptyStdout: true,
  inheritParentEnv: true,
});

export function processEvidence(result: ProcessResult): Record<string, unknown> {
  return {
    processOutcome: result.outcome,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error ? { error: result.error } : {}),
  };
}
