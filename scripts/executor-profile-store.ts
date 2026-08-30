import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const EXECUTOR_PROFILE_STORE_RELATIVE_PATH = '.local/state/orchestrator-session/executor-profiles.env';
export const EXECUTOR_PROFILE_STORE_MALFORMED = 'executor_profile_store_malformed' as const;

const PROFILE_STORE_KEY_PATTERN = /^PACK_EXECUTOR_[A-Z0-9_]+$/u;

export interface ExecutorProfileStoreReadOptions {
  readonly storePath?: string;
  readonly readFile?: (path: string) => string;
}

export function executorProfileStorePath(home = homedir()): string {
  return join(home, EXECUTOR_PROFILE_STORE_RELATIVE_PATH);
}

function malformedStore(lineNumber: number, key: string): Error {
  return new Error(`${EXECUTOR_PROFILE_STORE_MALFORMED}:line=${lineNumber}:key=${key || '<missing>'}`);
}

function parseStoreValue(value: string, lineNumber: number, key: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed.at(-1);
    if ((first === '"' || first === "'") && last === first) return trimmed.slice(1, -1);
    if (first === '"' || first === "'") throw malformedStore(lineNumber, key);
  }
  return trimmed;
}

export function readExecutorProfileStore(
  options: ExecutorProfileStoreReadOptions = {},
): Readonly<Record<string, string>> {
  const path = options.storePath ?? executorProfileStorePath();
  const readFile = options.readFile ?? ((filePath: string) => readFileSync(filePath, 'utf8'));
  let contents: string;
  try {
    contents = readFile(path);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return {};
    throw new Error(`executor_profile_store_unreadable:${path}`);
  }

  const parsed: Record<string, string> = {};
  for (const [index, rawLine] of contents.split(/\r?\n/u).entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    const key = separator >= 0 ? line.slice(0, separator).trim() : line.trim();
    if (separator < 0 || !PROFILE_STORE_KEY_PATTERN.test(key)) throw malformedStore(lineNumber, key);
    parsed[key] = parseStoreValue(line.slice(separator + 1), lineNumber, key);
  }
  return parsed;
}

export function overlayExecutorProfileEnv(
  env: Readonly<NodeJS.ProcessEnv>,
  options: ExecutorProfileStoreReadOptions = {},
): Readonly<NodeJS.ProcessEnv> {
  const stored = readExecutorProfileStore(options);
  if (Object.keys(stored).length === 0) return env;
  return { ...env, ...stored };
}
