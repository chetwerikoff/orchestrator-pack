/**
 * AO 0.10.x runnable `ao spawn` shape guard (Issue #589).
 * Source: ComposioHQ/agent-orchestrator v0.10.2 spawn CLI requires --project and a
 * non-empty --name display label (max 20 chars).
 */

/** @typedef {{ line: number; command: string; kind: 'line' | 'backtick' }} RunnableSpawnMatch */

export const AO_SPAWN_DISPLAY_NAME_MAX_LENGTH = 20;

/** Flags that consume the next argv token on `ao spawn` (AO 0.10.x). */
export const SPAWN_ARGV_OPTIONS_WITH_VALUE = [
  '--agent',
  '--claim-pr',
  '--name',
  '--project',
  '--prompt',
];

const NON_RUNNABLE_NEGATION =
  /\b(?:never|not|no|without|forbid(?:den|s|s)?|must\s+not|do\s+not|don'?t|cannot|can'?t|refuse(?:d|s)?|den(?:y|ies|ied)|blind)\b/i;

const RUNNABLE_LINE = /^ao spawn(?:\s|$)/i;

/**
 * @param {string} line
 * @param {string} [previousLine]
 */
export function isNonRunnableSpawnMention(line, previousLine = '') {
  const spawnIdx = line.search(/\bao spawn\b/i);
  if (spawnIdx < 0) {
    return true;
  }
  const prefix = line.slice(0, spawnIdx);
  if (NON_RUNNABLE_NEGATION.test(prefix)) {
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

    const backtickPattern = /`([^`]*\bao spawn\b[^`]*)`/gi;
    let match = backtickPattern.exec(line);
    while (match) {
      const command = match[1].trim();
      const prefix = line.slice(0, match.index);
      const isSlashList = /\/\s*`?\s*$/.test(prefix);
      const isBareCategory = /^ao spawn$/i.test(command);
      const isClaimPrCategory = /^ao spawn --claim-pr$/i.test(command);
      if (
        !isSlashList &&
        !isBareCategory &&
        !isClaimPrCategory &&
        !NON_RUNNABLE_NEGATION.test(prefix) &&
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
 * @param {string} command
 */
export function parseSpawnShapeFlags(command) {
  const tokens = String(command).trim().split(/\s+/);
  /** @type {{ project?: string; name?: string }} */
  const flags = {};

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const inline = /^(--[^=]+)=(.*)$/i.exec(token);
    if (inline) {
      const flag = inline[1].toLowerCase();
      const value = inline[2];
      if (flag === '--project') {
        flags.project = value;
      }
      if (flag === '--name') {
        flags.name = stripQuotes(value);
      }
      continue;
    }

    const lower = token.toLowerCase();
    if (lower === '--project' && index + 1 < tokens.length) {
      flags.project = tokens[index + 1];
      index += 1;
      continue;
    }
    if (lower === '--name' && index + 1 < tokens.length) {
      flags.name = stripQuotes(tokens[index + 1]);
      index += 1;
    }
  }

  return flags;
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

  return violations;
}

/**
 * @param {string} text
 * @param {{ relPath?: string; allowedCommands?: string[] }} [options]
 */
export function scanSpawnShapeViolations(text, options = {}) {
  const allowed = new Set(options.allowedCommands ?? []);
  /** @type {Array<{ relPath?: string; line: number; command: string; violations: string[] }>} */
  const violations = [];

  for (const match of findRunnableSpawnCommands(text)) {
    if (allowed.has(match.command)) {
      continue;
    }
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

  const baselineRaw = await readFile(join(rootDir, config.baselineRelPath), 'utf8');
  const baseline = JSON.parse(baselineRaw);
  const allowedCommands = Array.isArray(baseline.allowedCommands)
    ? baseline.allowedCommands
    : [];

  /** @type {ReturnType<typeof scanSpawnShapeViolations>} */
  const allViolations = [];

  for (const relPath of config.corpusRelPaths) {
    const text = await readFile(join(rootDir, relPath), 'utf8');
    allViolations.push(
      ...scanSpawnShapeViolations(text, { relPath, allowedCommands }),
    );
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

  return relPaths.sort();
}

async function runCli() {
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');

  const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const corpusRelPaths = await collectDefaultCorpusRelPaths(rootDir);
  const violations = await scanSpawnShapeCorpus(rootDir, {
    corpusRelPaths,
    baselineRelPath: 'tests/fixtures/ao-spawn-shape/safety-prose-baseline.json',
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
