import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { collectLocalModuleSpecifiers } from './module-specifiers.mjs';
import { loadReverifyAllowlistConfig } from './reverify-allowlist-config.ts';
import type { TargetContext } from './target-context.ts';

const allowlist = loadReverifyAllowlistConfig();

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


function scriptPathMatchesAllowlistedPrefix(scriptPath: string, prefix: string): boolean {
  const normalizedPrefix = normalizePath(prefix).replace(/\/+$/, '');
  const normalizedScript = normalizePath(scriptPath);
  return normalizedScript === normalizedPrefix
    || normalizedScript.startsWith(`${normalizedPrefix}/`);
}

function argvMatchesPattern(argv: string[], pattern: string[]): boolean {
  if (argv.length !== pattern.length) {
    return false;
  }
  return argv.every((token, index) => token === pattern[index]);
}


function resolveNpmTestAllowlistedCommand(
  argv: string[],
  pattern: string[],
  parsedEnv: { env: Record<string, string> },
  repoRoot: string,
): ResolvedAllowlistedCommand | null {
  if (argv[1] !== 'test' || argv[2] !== '--') {
    return null;
  }
  const filter = argv[3];
  if (!filter) {
    return null;
  }
  const vitestScript = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
  if (!existsSync(vitestScript)) {
    return null;
  }
  return {
    executable: process.execPath,
    args: [vitestScript, 'run', filter],
    env: {
      ...parsedEnv.env,
      TMPDIR: '/tmp',
      VITEST_CACHE_DIR: '/tmp/opk-reverify-vitest-cache',
    },
    allowlistId: pattern.join(' '),
  };
}

// The selected card grants only its exact node entrypoint, confined to the card's
// primary checkout and to the checkout where the resolver will execute it.
function isConfinedExistingNodeScript(root: string, relativeScript: string): boolean {
  try {
    const canonicalRoot = realpathSync(root);
    const canonicalScript = realpathSync(path.resolve(root, relativeScript));
    const relative = path.relative(canonicalRoot, canonicalScript);
    return !!relative
      && relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
      && statSync(canonicalScript).isFile();
  } catch {
    return false;
  }
}
export function resolveAllowlistedCommand(
  command: string,
  options: { repoRoot: string; selectedContext?: TargetContext },
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
    const matchedPrefix = NODE_PREFIXES.find((prefix) => scriptPathMatchesAllowlistedPrefix(scriptPath, prefix));
    const selectedContext = options.selectedContext;
    const selectedCardBoundary = !!selectedContext?.contractEvidenceProducer
      && selectedContext.contractEvidenceProducer.boundaryCommand === trimmed
      && !path.isAbsolute(scriptPath)
      && isConfinedExistingNodeScript(selectedContext.primaryRoot, scriptPath)
      && isConfinedExistingNodeScript(options.repoRoot, scriptPath);
    if (!matchedPrefix && !selectedCardBoundary) {
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
      allowlistId: matchedPrefix ? `node ${matchedPrefix}` : 'selected-card:boundaryCommand',
    };
  }

  if (executable === 'npm') {
    for (const pattern of NPM_PATTERNS) {
      if (argvMatchesPattern(argv, pattern)) {
        const resolvedNpmTest = resolveNpmTestAllowlistedCommand(argv, pattern, parsedEnv, options.repoRoot);
        if (resolvedNpmTest) {
          return resolvedNpmTest;
        }
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

export function isCommandSafe(command: string, repoRoot: string, selectedContext?: TargetContext): boolean {
  return resolveAllowlistedCommand(command, { repoRoot, selectedContext }) !== null;
}


function resolveLocalModulePath(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    return null;
  }
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.mjs`,
    `${base}.js`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    path.join(base, 'index.mjs'),
    path.join(base, 'index.js'),
    path.join(base, 'index.ts'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveScriptDependencyClosureFromAbsEntry(
  entryScript: string,
  repoRoot: string,
): { relPaths: string[]; establishable: boolean } {
  const repoRootNorm = path.normalize(repoRoot);
  const visited = new Set<string>();
  const relPaths: string[] = [];
  let establishable = true;

  const walk = (absPath: string): void => {
    const normalized = path.normalize(absPath);
    if (visited.has(normalized)) {
      return;
    }
    visited.add(normalized);
    const rel = normalizePath(path.relative(repoRootNorm, normalized));
    if (!rel || rel.startsWith('..')) {
      return;
    }
    relPaths.push(rel);

    let content = '';
    try {
      content = readFileSync(normalized, 'utf8');
    } catch {
      return;
    }

    const collected = collectLocalModuleSpecifiers(content);
    if (!collected.establishable) {
      establishable = false;
    }
    for (const specifier of collected.specifiers) {
      if (!specifier.startsWith('.')) {
        continue;
      }
      const localPath = resolveLocalModulePath(normalized, specifier);
      if (!localPath) {
        establishable = false;
        continue;
      }
      const localNorm = path.normalize(localPath);
      if (localNorm === normalized) {
        continue;
      }
      if (!localNorm.startsWith(`${repoRootNorm}${path.sep}`)) {
        establishable = false;
        continue;
      }
      walk(localNorm);
    }
  };

  walk(entryScript);
  return { relPaths: [...new Set(relPaths)], establishable };
}

function resolveNodeScriptDependencyClosure(command: string, repoRoot: string): { relPaths: string[]; establishable: boolean } | null {
  const resolved = resolveAllowlistedCommand(command, { repoRoot });
  if (!resolved || resolved.executable !== process.execPath) {
    return null;
  }
  const entryScript = resolved.args[0];
  if (!entryScript) {
    return null;
  }

  return resolveScriptDependencyClosureFromAbsEntry(entryScript, repoRoot);
}

function parseNpmTestFilter(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed.startsWith('npm test --')) {
    return null;
  }
  const filter = trimmed.slice('npm test --'.length).trim();
  return filter || null;
}

function listVitestFilterMatchedTestRelPaths(filter: string, repoRoot: string): string[] {
  const vitestScript = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
  if (!existsSync(vitestScript)) {
    return [];
  }

  const result = spawnSync(process.execPath, [vitestScript, 'list', filter], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      VITEST_CACHE_DIR: '/tmp/opk-reverify-vitest-cache',
    },
    timeout: 60_000,
  });
  if (result.status !== 0) {
    return [];
  }

  const files = new Set<string>();
  for (const line of (result.stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const filePart = trimmed.split(' > ')[0]?.trim();
    if (!filePart) {
      continue;
    }
    const abs = path.isAbsolute(filePart) ? filePart : path.join(repoRoot, filePart);
    const rel = normalizePath(path.relative(repoRoot, abs));
    if (rel && !rel.startsWith('..')) {
      files.add(rel);
    }
  }
  return [...files];
}

function resolveNpmTestDependencyClosure(command: string, repoRoot: string): { relPaths: string[]; establishable: boolean } | null {
  const filter = parseNpmTestFilter(command);
  if (!filter || !isCommandSafe(command, repoRoot)) {
    return null;
  }

  const testRelPaths = listVitestFilterMatchedTestRelPaths(filter, repoRoot);
  if (testRelPaths.length === 0) {
    return { relPaths: [], establishable: false };
  }

  const relPaths = new Set<string>();
  let establishable = true;
  for (const testRelPath of testRelPaths) {
    const absPath = path.join(repoRoot, testRelPath);
    if (!existsSync(absPath)) {
      establishable = false;
      relPaths.add(testRelPath);
      continue;
    }
    const closure = resolveScriptDependencyClosureFromAbsEntry(absPath, repoRoot);
    if (!closure.establishable) {
      establishable = false;
    }
    for (const relPath of closure.relPaths) {
      relPaths.add(relPath);
    }
  }

  return { relPaths: [...relPaths], establishable };
}

/**
 * Check the exact selected-card producer against the committed primary P and
 * the review worktree W. The existing command resolver stays the only command
 * authorizer; this check never expands its allowlist.
 */
export function selectedCardProducerClosureIsTrusted(input: {
  command: string;
  selectedContext: TargetContext;
  reviewTargetRoot: string;
  prModifiedPaths: readonly string[];
}): boolean {
  const card = input.selectedContext.contractEvidenceProducer;
  if (!card || input.command.trim() !== card.boundaryCommand) return false;
  const primary = input.selectedContext.primaryRoot;
  const review = input.reviewTargetRoot;
  const primaryCommand = resolveAllowlistedCommand(card.boundaryCommand, {
    repoRoot: primary, selectedContext: input.selectedContext,
  });
  const reviewCommand = resolveAllowlistedCommand(card.boundaryCommand, {
    repoRoot: review, selectedContext: input.selectedContext,
  });
  if (!primaryCommand || !reviewCommand || primaryCommand.executable !== process.execPath
      || reviewCommand.executable !== process.execPath) return false;
  const primaryEntry = primaryCommand.args[0];
  const reviewEntry = reviewCommand.args[0];
  if (!primaryEntry || !reviewEntry) return false;
  const a = resolveScriptDependencyClosureFromAbsEntry(primaryEntry, primary);
  const b = resolveScriptDependencyClosureFromAbsEntry(reviewEntry, review);
  if (!a.establishable || !b.establishable) return false;
  const x = [...a.relPaths].sort();
  const y = [...b.relPaths].sort();
  if (x.length === 0 || x.length !== y.length
      || x.some((rel, index) => rel !== y[index])) return false;
  const changed = new Set(input.prModifiedPaths.map(normalizePath));
  try {
    const primaryRoot = realpathSync(primary);
    const reviewRoot = realpathSync(review);
    for (const rel of x) {
      if (changed.has(rel)) return false;
      const p = realpathSync(path.join(primary, rel));
      const w = realpathSync(path.join(review, rel));
      const confined = (root: string, file: string) => {
        const relative = path.relative(root, file);
        return !!relative && relative !== '..'
          && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      };
      if (!confined(primaryRoot, p) || !confined(reviewRoot, w)
          || !statSync(p).isFile() || !statSync(w).isFile()
          || !readFileSync(p).equals(readFileSync(w))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function listNodeScriptDependencyClosureRelPaths(command: string, repoRoot: string): string[] {
  return resolveNodeScriptDependencyClosure(command, repoRoot)?.relPaths ?? [];
}

export function isNodeScriptDependencyClosureEstablishable(command: string, repoRoot: string): boolean {
  const closure = resolveNodeScriptDependencyClosure(command, repoRoot);
  return closure?.establishable ?? false;
}

export function listNpmTestDependencyClosureRelPaths(command: string, repoRoot: string): string[] {
  return resolveNpmTestDependencyClosure(command, repoRoot)?.relPaths ?? [];
}

export function isNpmTestDependencyClosureEstablishable(command: string, repoRoot: string): boolean {
  const closure = resolveNpmTestDependencyClosure(command, repoRoot);
  return closure?.establishable ?? false;
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
