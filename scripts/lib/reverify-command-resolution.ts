import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const allowlist = require('../contract-evidence-reverify-allowlist.json') as {
  trustedCommandPrefixes: string[];
  mutatingTokenPattern: string;
  allowedEnvVars: string[];
};

export const DEFAULT_REVERIFY_MANIFEST_PATH = 'tests/external-output-references/capture-manifest.json';

const SHELL_METACHAR_PATTERN = /[;|&$`<>()\n\r]|\$\(/;
const NODE_PREFIXES = allowlist.trustedCommandPrefixes
  .filter((prefix) => prefix.startsWith('node '))
  .map((prefix) => prefix.slice('node '.length));
const NPM_PATTERNS = allowlist.trustedCommandPrefixes
  .filter((prefix) => prefix.startsWith('npm '))
  .map((prefix) => prefix.split(/\s+/));

export interface ResolvedAllowlistedCommand {
  executable: string;
  args: string[];
  env: Record<string, string>;
  allowlistId: string;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function tokenizeArgv(command: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < command.length) {
    while (command[index] === ' ') {
      index += 1;
    }
    if (index >= command.length) {
      break;
    }
    const quote = command[index];
    if (quote === '"' || quote === "'") {
      index += 1;
      let token = '';
      while (index < command.length && command[index] !== quote) {
        token += command[index];
        index += 1;
      }
      if (command[index] === quote) {
        index += 1;
      }
      tokens.push(token);
      continue;
    }
    let token = '';
    while (index < command.length && command[index] !== ' ') {
      token += command[index];
      index += 1;
    }
    tokens.push(token);
  }
  return tokens;
}

function parseLeadingEnv(command: string): { env: Record<string, string>; rest: string } | null {
  const allowed = new Set(allowlist.allowedEnvVars ?? []);
  let rest = command.trim();
  const env: Record<string, string> = {};

  while (true) {
    const match = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match) {
      break;
    }
    const key = match[1]!;
    if (!allowed.has(key)) {
      return null;
    }
    rest = rest.slice(match[0].length);
    let value = '';
    if (rest[0] === '"' || rest[0] === "'") {
      const quote = rest[0]!;
      rest = rest.slice(1);
      const end = rest.indexOf(quote);
      if (end < 0) {
        return null;
      }
      value = rest.slice(0, end);
      rest = rest.slice(end + 1).trimStart();
    } else {
      const spaceIdx = rest.search(/\s+/);
      if (spaceIdx < 0) {
        value = rest;
        rest = '';
      } else {
        value = rest.slice(0, spaceIdx);
        rest = rest.slice(spaceIdx).trimStart();
      }
    }
    if (SHELL_METACHAR_PATTERN.test(value)) {
      return null;
    }
    env[key] = value;
  }

  return { env, rest };
}

function argvMatchesPattern(argv: string[], pattern: string[]): boolean {
  if (argv.length !== pattern.length) {
    return false;
  }
  return argv.every((token, index) => token === pattern[index]);
}

export function resolveAllowlistedCommand(
  command: string,
  options: { repoRoot: string },
): ResolvedAllowlistedCommand | null {
  const trimmed = command.trim();
  if (!trimmed || SHELL_METACHAR_PATTERN.test(trimmed)) {
    return null;
  }

  const parsedEnv = parseLeadingEnv(trimmed);
  if (!parsedEnv) {
    return null;
  }

  const argv = tokenizeArgv(parsedEnv.rest);
  if (argv.length === 0) {
    return null;
  }

  const combined = [...argv, ...Object.values(parsedEnv.env)].join(' ');
  if (new RegExp(allowlist.mutatingTokenPattern, 'i').test(combined)) {
    return null;
  }

  const [executable, ...args] = argv;
  if (executable === 'node') {
    if (args.length !== 1) {
      return null;
    }
    const scriptPath = normalizePath(args[0]!);
    if (scriptPath.includes('..')) {
      return null;
    }
    const matchedPrefix = NODE_PREFIXES.find((prefix) => scriptPath === normalizePath(prefix)
      || scriptPath.startsWith(`${normalizePath(prefix)}`));
    if (!matchedPrefix) {
      return null;
    }
    const absoluteScript = path.isAbsolute(scriptPath)
      ? scriptPath
      : path.join(options.repoRoot, scriptPath);
    if (!existsSync(absoluteScript)) {
      return null;
    }
    return {
      executable: process.execPath,
      args: [absoluteScript],
      env: parsedEnv.env,
      allowlistId: `node ${matchedPrefix}`,
    };
  }

  if (executable === 'npm') {
    for (const pattern of NPM_PATTERNS) {
      if (argvMatchesPattern(argv, pattern)) {
        return {
          executable: 'npm',
          args: argv.slice(1),
          env: parsedEnv.env,
          allowlistId: pattern.join(' '),
        };
      }
    }
    return null;
  }

  return null;
}

export function isCommandSafe(command: string, repoRoot: string): boolean {
  return resolveAllowlistedCommand(command, { repoRoot }) !== null;
}

export function listAllowlistedNodeScriptRelPaths(command: string, repoRoot: string): string[] {
  const resolved = resolveAllowlistedCommand(command, { repoRoot });
  if (!resolved || resolved.executable !== process.execPath) {
    return [];
  }
  const scriptPath = resolved.args[0];
  if (!scriptPath) {
    return [];
  }
  const rel = normalizePath(path.relative(repoRoot, scriptPath));
  if (!rel || rel.startsWith('..')) {
    return [];
  }
  return [rel];
}
