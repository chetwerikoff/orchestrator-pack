/**
 * AO 0.10.x runnable `ao spawn` shape guard (Issue #589).
 * Source: ComposioHQ/agent-orchestrator v0.10.2 spawn CLI requires --project and a
 * non-empty --name display label (max 20 chars).
 */

/** @typedef {{ line: number; command: string; kind: 'line' | 'backtick' | 'inline' }} RunnableSpawnMatch */

export const AO_SPAWN_DISPLAY_NAME_MAX_LENGTH = 20;

/** Flags that consume the next argv token on `ao spawn` (AO 0.10.x). */
export const SPAWN_ARGV_OPTIONS_WITH_VALUE = [
  '--agent',
  '--claim-pr',
  '--issue',
  '--name',
  '--project',
  '--prompt',
];

const RUNNABLE_LINE = /^ao spawn(?:\s|$)/i;

/**
 * Negation that applies to ao spawn, not incidental words like "no worker" or "not a replacement".
 * @param {string} text
 * @param {number} spawnIndex index of the `ao spawn` match within text
 */
export function hasSpawnDirectedNegation(text, spawnIndex) {
  const before = text.slice(0, spawnIndex);
  const tail = before.slice(-100);

  if (/\bMUST\s+NOT\b/i.test(before) && /\b(?:or|and)\s*$/i.test(tail)) {
    return true;
  }

  if (/\b(?:never|must\s+not|do\s+not|don'?t|cannot|can'?t)\s+(?:[\w-]+\s+){0,5}$/i.test(tail)) {
    return true;
  }

  if (/\bnot\s+blind\s+$/i.test(tail) || /\bblind\s+$/i.test(tail)) {
    return true;
  }

  if (/\b(?:without|forbid(?:den|s)?|refuse(?:d|s)?|den(?:y|ies|ied))\s+(?:[\w-]+\s+){0,3}$/i.test(tail)) {
    return true;
  }

  return false;
}

/**
 * Extract an inline `ao spawn ...` command from prose that does not start with it.
 * @param {string} line
 * @param {number} spawnIndex
 */
export function extractInlineSpawnCommand(line, spawnIndex) {
  let rest = line.slice(spawnIndex).trim();
  const parenIdx = rest.search(/\s+\(/);
  if (parenIdx > 0) {
    rest = rest.slice(0, parenIdx).trim();
  }
  rest = rest.replace(/[.,]\s*$/, '').trim();
  rest = rest.replace(/\s+for\s+[\w#-]+(?:\s+[\w#-]+)*\s*$/i, '').trim();
  const commaIdx = rest.indexOf(',');
  if (commaIdx > 0) {
    rest = rest.slice(0, commaIdx).trim();
  }
  return rest;
}

/**
 * @param {string} line
 * @param {string} [previousLine]
 */
export function isNonRunnableSpawnMention(line, previousLine = '') {
  const spawnIdx = line.search(/\bao spawn\b/i);
  if (spawnIdx < 0) {
    return true;
  }
  if (hasSpawnDirectedNegation(line, spawnIdx)) {
    return true;
  }
  if (/\b(?:must\s+not|never|do\s+not|don'?t)\s*$/i.test(String(previousLine).trim())) {
    return true;
  }
  if (/`ao spawn`,\s*`--claim-pr`/i.test(line)) {
    return true;
  }
  if (/\/\s*`ao spawn\b/i.test(line)) {
    return true;
  }
  if (/\bmid-`ao spawn`/i.test(line)) {
    return true;
  }
  return false;
}

/**
 * @param {string} text
 * @returns {RunnableSpawnMatch[]}
 */
export function findRunnableSpawnCommands(text) {
  /** @type {RunnableSpawnMatch[]} */
  const matches = [];
  const lines = String(text).split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const previousLine = index > 0 ? (lines[index - 1] ?? '') : '';
    const trimmed = line.trim();

    if (RUNNABLE_LINE.test(trimmed) && !isNonRunnableSpawnMention(line, previousLine)) {
      matches.push({ line: index + 1, command: trimmed, kind: 'line' });
      continue;
    }

    const inlineSpawnIdx = line.search(/\bao spawn\b/i);
    if (
      inlineSpawnIdx >= 0 &&
      !isNonRunnableSpawnMention(line, previousLine) &&
      !line.includes('`')
    ) {
      const command = extractInlineSpawnCommand(line, inlineSpawnIdx);
      if (command && isRunnableInlineSpawnCommand(command)) {
        matches.push({ line: index + 1, command: normalizeExtractedCommand(command), kind: 'inline' });
      }
    }

    const backtickPattern = /`([^`]*\bao spawn\b[^`]*)`/gi;
    let match = backtickPattern.exec(line);
    while (match) {
      const command = match[1].trim();
      const prefix = line.slice(0, match.index);
      const isSlashList = /\/\s*`?\s*$/.test(prefix);
      const isBareCategory = /^ao spawn$/i.test(command);
      const isClaimPrCategory = /^ao spawn --claim-pr$/i.test(command);
      const spawnIdxInLine =
        match.index + Math.max(0, command.search(/\bao spawn\b/i));
      if (
        !isSlashList &&
        !isBareCategory &&
        !isClaimPrCategory &&
        !hasSpawnDirectedNegation(line, spawnIdxInLine) &&
        !isNonRunnableSpawnMention(`${prefix}${command}`, previousLine)
      ) {
        matches.push({ line: index + 1, command, kind: 'backtick' });
      }
      match = backtickPattern.exec(line);
    }
  }

  return matches;
}

/**
 * Tokenize a spawn command argv while preserving quoted values.
 * @param {string} command
 * @returns {string[]}
 */
export function tokenizeSpawnArgv(command) {
  const tokens = [];
  let current = '';
  let quote = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = null;
        tokens.push(current);
        current = '';
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * @param {string} value
 */
function stripQuotes(value) {
  const trimmed = String(value).trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * @param {string | undefined} token
 */
function isSpawnOptionFlag(token) {
  return typeof token === 'string' && /^--[\w-]+/i.test(token);
}

/**
 * @param {string | undefined} token
 */
function isValidSpawnOptionValue(token) {
  if (token === undefined) {
    return false;
  }
  const value = stripQuotes(token);
  return value.length > 0 && !isSpawnOptionFlag(value);
}

/**
 * @param {string} command
 */
export function parseSpawnShapeFlags(command) {
  const tokens = tokenizeSpawnArgv(String(command).trim());
  /** @type {{ project?: string; name?: string; prompt?: string; claimPr?: boolean }} */
  const flags = {};

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const inline = /^(--[^=]+)=(.*)$/i.exec(token);
    if (inline) {
      const flag = inline[1].toLowerCase();
      const value = inline[2];
      if (flag === '--project' && isValidSpawnOptionValue(value)) {
        flags.project = stripQuotes(value);
      }
      if (flag === '--name' && isValidSpawnOptionValue(value)) {
        flags.name = stripQuotes(value);
      }
      continue;
    }

    const lower = token.toLowerCase();
    if (lower === '--project') {
      const value = tokens[index + 1];
      if (isValidSpawnOptionValue(value)) {
        flags.project = stripQuotes(value);
        index += 1;
      }
      continue;
    }
    if (lower === '--name') {
      const value = tokens[index + 1];
      if (isValidSpawnOptionValue(value)) {
        flags.name = stripQuotes(value);
        index += 1;
      }
      continue;
    }
    if (lower === '--prompt') {
      const value = tokens[index + 1];
      if (isValidSpawnOptionValue(value)) {
        flags.prompt = stripQuotes(value);
        index += 1;
      }
      continue;
    }
    if (lower === '--claim-pr') {
      flags.claimPr = true;
      const value = tokens[index + 1];
      if (isValidSpawnOptionValue(value)) {
        index += 1;
      }
      continue;
    }
    if (inline && inline[1].toLowerCase() === '--claim-pr') {
      flags.claimPr = true;
      continue;
    }
    if (lower === '--issue') {
      const value = tokens[index + 1];
      if (isValidSpawnOptionValue(value)) {
        index += 1;
      }
    }
  }

  return flags;
}


/**
 * @param {string} token
 */
function spawnShapeOptionConsumesNextToken(token) {
  const inline = /^(--[^=]+)=(.*)$/i.exec(token);
  if (inline) {
    return false;
  }
  return SPAWN_ARGV_OPTIONS_WITH_VALUE.includes(token.toLowerCase());
}

/**
 * @param {string} command
 */
function hasSpawnPositionalArguments(command) {
  const tokens = tokenizeSpawnArgv(String(command).trim());
  let spawnIndex = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].toLowerCase() === 'spawn') {
      spawnIndex = index;
      break;
    }
  }
  if (spawnIndex < 0) {
    return false;
  }
  for (let index = spawnIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith('-')) {
      if (/^(--[^=]+)=/.test(token)) {
        continue;
      }
      if (spawnShapeOptionConsumesNextToken(token)) {
        if (index + 1 < tokens.length && !tokens[index + 1].startsWith('-')) {
          index += 1;
        }
      }
      continue;
    }
    return true;
  }
  return false;
}

/**
 * @param {string} command
 * @returns {string[]}
 */
export function validateRunnableSpawnCommand(command) {
  const flags = parseSpawnShapeFlags(command);
  /** @type {string[]} */
  const violations = [];

  if (!flags.project || !String(flags.project).trim()) {
    violations.push('missing --project');
  }
  if (!flags.name || !String(flags.name).trim()) {
    violations.push('missing or empty --name');
  } else if (flags.name.length > AO_SPAWN_DISPLAY_NAME_MAX_LENGTH) {
    violations.push(
      `--name exceeds ${AO_SPAWN_DISPLAY_NAME_MAX_LENGTH} chars (AO 0.10.x display label limit)`,
    );
  }

  if (!flags.claimPr) {
    if (!flags.prompt || !String(flags.prompt).trim()) {
      violations.push('missing or empty --prompt');
    }
    if (hasSpawnPositionalArguments(command)) {
      violations.push('positional arguments are not allowed on ao spawn');
    }
  }

  return violations;
}

/**
 * @param {string} text
 * @param {{ relPath?: string }} [options]
 */
export function scanSpawnShapeViolations(text, options = {}) {
  /** @type {Array<{ relPath?: string; line: number; command: string; violations: string[] }>} */
  const violations = [];

  for (const match of findRunnableSpawnCommands(text)) {
    const matchViolations = validateRunnableSpawnCommand(match.command);
    if (matchViolations.length > 0) {
      violations.push({
        relPath: options.relPath,
        line: match.line,
        command: match.command,
        violations: matchViolations,
      });
    }
  }

  return violations;
}

/**
 * @param {string} rootDir
 * @param {{ corpusRelPaths: string[]; baselineRelPath: string }} config
 */
export async function scanSpawnShapeCorpus(rootDir, config) {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  /** @type {ReturnType<typeof scanSpawnShapeViolations>} */
  const allViolations = [];

  for (const relPath of config.corpusRelPaths) {
    const text = await readFile(join(rootDir, relPath), 'utf8');
    allViolations.push(...scanSpawnShapeViolations(text, { relPath }));
  }

  return allViolations;
}

/**
 * @param {import('node:fs').Dirent} entry
 */
function isCorpusMarkdown(entry) {
  return entry.isFile() && entry.name.endsWith('.md');
}

/**
 * @param {string} rootDir
 */

/** Spawn-gate fixture suites referenced by Issue #589 / #163. */
export const SPAWN_GATE_CORPUS_REL_PATHS = [
  'scripts/_test-autonomous-ao-stub-fixture.ts',
  'scripts/autonomous-orchestrator-boundary.test.ts',
  'scripts/autonomous-orchestrator-interposer.test.ts',
  'scripts/autonomous-spawn-policy.test.ts',
  'scripts/autonomous-spawn-worktree-gate.test.ts',
];

/**
 * @param {string} command
 */
function normalizeExtractedCommand(command) {
  let normalized = String(command).trim();
  if (
    (normalized.startsWith("'") && normalized.endsWith("'")) ||
    (normalized.startsWith('"') && normalized.endsWith('"'))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized.replace(/['"]$/, '').trim();
}

/**
 * @param {string} command
 */
function isRunnableInlineSpawnCommand(command) {
  const normalized = normalizeExtractedCommand(command);
  if (/^ao spawn\s+--/i.test(normalized)) {
    return true;
  }
  return /^ao spawn\s+(?:opk-[\w-]+|\d+|<[A-Za-z][\w-]*>|\$\{)/i.test(normalized);
}

export async function collectDefaultCorpusRelPaths(rootDir) {
  const { readdir } = await import('node:fs/promises');
  const { join, relative } = await import('node:path');

  /** @type {string[]} */
  const relPaths = ['agent-orchestrator.yaml.example'];

  const promptsDir = join(rootDir, 'prompts');
  for (const entry of await readdir(promptsDir, { withFileTypes: true })) {
    if (isCorpusMarkdown(entry)) {
      relPaths.push(relative(rootDir, join(promptsDir, entry.name)).replace(/\\/g, '/'));
    }
  }

  const docsDir = join(rootDir, 'docs');
  async function walkDocs(currentDir) {
    for (const entry of await readdir(currentDir, { withFileTypes: true })) {
      const abs = join(currentDir, entry.name);
      const rel = relative(rootDir, abs).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (rel === 'docs/issues_drafts' || rel === 'docs/declarations') {
          continue;
        }
        await walkDocs(abs);
        continue;
      }
      if (isCorpusMarkdown(entry)) {
        relPaths.push(rel);
      }
    }
  }
  await walkDocs(docsDir);

  relPaths.push(...SPAWN_GATE_CORPUS_REL_PATHS);

  return [...new Set(relPaths)].sort();
}

async function runCli() {
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');

  const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const corpusRelPaths = await collectDefaultCorpusRelPaths(rootDir);
  const violations = await scanSpawnShapeCorpus(rootDir, {
    corpusRelPaths,
    baselineRelPath: 'scripts/fixtures/ao-spawn-shape/safety-prose-baseline.json',
  });

  if (violations.length > 0) {
    for (const violation of violations) {
      const location = violation.relPath
        ? `${violation.relPath}:${violation.line}`
        : `line ${violation.line}`;
      process.stderr.write(
        `${location}: runnable ao spawn missing AO 0.10.x flags in "${violation.command}": ${violation.violations.join(', ')}\n`,
      );
    }
    process.exit(1);
  }

  process.stdout.write('[PASS] AO 0.10.x runnable ao spawn shape (Issue #589)\n');
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
