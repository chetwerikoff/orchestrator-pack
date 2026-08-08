import { runProcessSync } from './subprocess.ts';

export interface TestProcessOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly encoding?: BufferEncoding;
}

export function runTestProcessSync(
  command: string,
  args: readonly string[],
  options: TestProcessOptions = {},
) {
  const result = runProcessSync({
    command,
    args,
    cwd: options.cwd,
    env: options.env,
    inheritParentEnv: options.env === undefined,
    encoding: options.encoding ?? 'utf8',
  });
  return {
    status: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
