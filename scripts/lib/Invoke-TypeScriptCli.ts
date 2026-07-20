#!/usr/bin/env -S node --experimental-strip-types
import { existsSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertNodeRuntimeContract } from '../toolchain/node-runtime-contract.mjs';

const NATIVE_TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.mts', '.cts']);

export interface TypeScriptCliInvocation {
  readonly repoRoot: string;
  readonly scriptPath: string;
  readonly forwardedArgs: readonly string[];
}

function invocationError(code: string, message: string): Error {
  const error = new Error(`${code}: ${message}`);
  Object.assign(error, { code });
  return error;
}

export function parseTypeScriptCliInvocation(
  argv: readonly string[],
  defaults: { readonly repoRoot?: string; readonly cwd?: string } = {},
): TypeScriptCliInvocation {
  const separator = argv.indexOf('--');
  const launcherArgs = separator >= 0 ? argv.slice(0, separator) : argv;
  const forwardedArgs = separator >= 0 ? argv.slice(separator + 1) : [];
  let repoRoot = defaults.repoRoot ?? resolve(import.meta.dirname, '../..');
  let scriptValue = '';

  for (let index = 0; index < launcherArgs.length; index += 1) {
    const token = launcherArgs[index];
    if (token === '--repo-root') {
      const value = launcherArgs[index + 1];
      if (!value) throw invocationError('OPK_TYPESCRIPT_CLI_ARGUMENT_MISSING', '--repo-root requires a path');
      repoRoot = value;
      index += 1;
      continue;
    }
    if (token === '--script') {
      const value = launcherArgs[index + 1];
      if (!value) throw invocationError('OPK_TYPESCRIPT_CLI_ARGUMENT_MISSING', '--script requires a path');
      scriptValue = value;
      index += 1;
      continue;
    }
    throw invocationError('OPK_TYPESCRIPT_CLI_ARGUMENT_UNKNOWN', `unknown launcher argument ${JSON.stringify(token)}`);
  }

  if (!scriptValue) {
    throw invocationError('OPK_TYPESCRIPT_CLI_ARGUMENT_MISSING', '--script is required');
  }

  const cwd = defaults.cwd ?? process.cwd();
  const scriptPath = isAbsolute(scriptValue) ? resolve(scriptValue) : resolve(cwd, scriptValue);
  const extension = extname(scriptPath).toLowerCase();
  if (!NATIVE_TYPESCRIPT_EXTENSIONS.has(extension)) {
    throw invocationError(
      'OPK_TYPESCRIPT_CLI_TARGET_EXTENSION_UNSUPPORTED',
      `target must use .ts, .mts, or .cts; received ${scriptPath}`,
    );
  }
  if (!existsSync(scriptPath) || !statSync(scriptPath).isFile()) {
    throw invocationError('OPK_TYPESCRIPT_CLI_TARGET_MISSING', `target does not exist: ${scriptPath}`);
  }

  return {
    repoRoot: resolve(repoRoot),
    scriptPath,
    forwardedArgs,
  };
}

export async function invokeTypeScriptCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const invocation = parseTypeScriptCliInvocation(argv);
  assertNodeRuntimeContract(invocation.repoRoot);

  process.argv = [process.execPath, invocation.scriptPath, ...invocation.forwardedArgs];
  await import(pathToFileURL(invocation.scriptPath).href);
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  invokeTypeScriptCli().catch((error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${detail}\n`);
    process.exitCode = 1;
  });
}
