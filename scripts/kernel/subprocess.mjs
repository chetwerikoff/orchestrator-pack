import { spawn, spawnSync } from 'node:child_process';

function minimalEnvironment(overrides) {
  const base = {};
  for (const key of ['PATH', 'SystemRoot', 'COMSPEC', 'PATHEXT']) {
    const value = process.env[key];
    if (value !== undefined) base[key] = value;
  }
  return { ...base, ...(overrides ?? {}) };
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function runProcess(options) {
  const env = options.inheritParentEnv
    ? { ...process.env, ...(options.env ?? {}) }
    : minimalEnvironment(options.env);
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(options.command, [...(options.args ?? [])], {
        cwd: options.cwd,
        env,
        shell: false,
        detached: options.detached ?? false,
        windowsHide: true,
        stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        outcome: 'spawn-failure',
        ok: false,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        error: describeError(error),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    if (child.stdout) child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    if (child.stderr) child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => {
      resolve({
        outcome: 'spawn-failure',
        ok: false,
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        error: describeError(error),
      });
    });
    child.once('close', (code, signal) => {
      resolve({
        outcome: signal ? 'signal' : 'exit',
        ok: code === 0,
        exitCode: code,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

export function runProcessSync(options) {
  const env = options.inheritParentEnv
    ? { ...process.env, ...(options.env ?? {}) }
    : minimalEnvironment(options.env);
  try {
    const result = spawnSync(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      env,
      shell: false,
      windowsHide: true,
      encoding: options.encoding ?? 'utf8',
      stdio: options.stdio,
    });
    if (result.error) {
      return {
        outcome: 'spawn-failure',
        ok: false,
        exitCode: null,
        signal: null,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        error: describeError(result.error),
      };
    }
    return {
      outcome: result.signal ? 'signal' : 'exit',
      ok: result.status === 0,
      exitCode: result.status,
      signal: result.signal,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } catch (error) {
    return {
      outcome: 'spawn-failure',
      ok: false,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: describeError(error),
    };
  }
}
