/**
 * Static no-drift guard helpers — derive coverage from classifyArgv (Issue #501).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyArgv } from './gh-inventory-match.mjs';

const WRITE_VERBS = new Set(['merge', 'comment', 'create', 'close', 'edit', 'review']);

/** @type {RegExp[]} */
const RULE_SURFACE_READ_PATTERNS = [
  /\bgh\s+pr\s+(?!merge|comment|create|close|edit|review)[^\n`]+/gi,
  /\bgh\s+issue\s+(?!merge|comment|create|close|edit|review)[^\n`]+/gi,
  /\bgh\s+repo\s+view[^\n`]+/gi,
];

/** @type {RegExp[]} */
const FORBIDDEN_RULE_SURFACE_PATTERNS = [
  /\bgh\s+api\s+graphql[^\n`]*/gi,
  /\bcurl\s+[^\n`]*api\.github\.com[^\n`]*/gi,
  /\bunset\s+GH_WRAPPER_ACTIVE\b/gi,
];

/** @type {RegExp[]} */
const RECONCILE_PATTERNS = [
  /\bgh\s+pr\s+list[^\r\n#|]+/gi,
  /\bgh\s+pr\s+view[^\r\n#|]+/gi,
  /\bgh\s+pr\s+checks[^\r\n#|]+/gi,
  /\bgh\s+pr\s+diff[^\r\n#|]+/gi,
  /\bgh\s+issue\s+view[^\r\n#|]+/gi,
  /\bgh\s+repo\s+view[^\r\n#|]+/gi,
];

/**
 * @param {string} fragment
 */
function trimReconcileCommand(fragment) {
  return fragment
    .replace(/\s+2>&.*$/u, '')
    .replace(/\s+\|\s+.*$/u, '')
    .replace(/\)\s*$/u, '')
    .trim();
}

/**
 * @param {string} fragment
 */
function trimRuleSurfaceCommand(fragment) {
  return fragment
    .replace(/[`]/g, '')
    .replace(/\s+(?:per PR|per\s+REQUIRED).*$/i, '')
    .replace(/\s+[—–-]\s+.*$/u, '')
    .replace(/\s+[;,+].*$/u, '')
    .replace(/\s+on that session.*$/i, '')
    .replace(/\s+or the worker.*$/i, '')
    .replace(/\s+or equivalent.*$/i, '')
    .replace(/\s+not session.*$/i, '')
    .replace(/[).]+$/u, '')
    .trim();
}

/**
 * @param {string} line
 */
function isProhibitionDocLine(line) {
  return /MUST NOT|Forbidden transports|forbidden transport|Do not run|Do not use|bypass the wrapper|temporary `gh` shims/i.test(line);
}

/**
 * @param {string} command
 */
function isIncompleteRuleSurfaceCommand(command) {
  const trimmed = command.trim();
  if (!trimmed.startsWith('gh ')) {
    return true;
  }
  if (/\b(?:pr|issue|repo)\/[\w-]+/i.test(trimmed) || /gh\s+pr\s+list\/view\/checks\/diff/i.test(trimmed)) {
    return true;
  }
  if (/…|\.\.\.|<REST path>| or the worker| or equivalent|\(current head\)| on that session/i.test(trimmed)) {
    return true;
  }
  if (/^gh\s+api\b/i.test(trimmed) && !/^gh\s+api\s+graphql/i.test(trimmed)) {
    return true;
  }
  if (/^gh\s+pr\s+(?:view|checks|list)$/i.test(trimmed)) {
    return true;
  }
  if (/^gh\s+pr\s+list(?:[, ]|$)/i.test(trimmed) && !/--json/.test(trimmed)) {
    return true;
  }
  if (/^gh\s+pr\s+view(?:[, ]|$)/i.test(trimmed) && !/--json/.test(trimmed)) {
    return true;
  }
  if (/^gh\s+issue\s+view\s+--json\s+…/i.test(trimmed)) {
    return true;
  }
  if (/gh api.*\/merge/i.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * @param {string} command
 */
export function normalizeGhCommandTemplate(command) {
  return command
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\(\[[^\]]+\][^)]*\)/g, '42')
    .replace(/<\w+>/gi, '42')
    .replace(/\$\{?\w+\}?/g, '42')
    .replace(/\s+(?:per PR|per\s+REQUIRED).*$/i, '')
    .replace(/\s+[—–-]\s+.*$/u, '')
    .replace(/\s+[;,].*$/u, '')
    .trim();
}

/**
 * @param {string} command
 * @returns {string[] | null}
 */
export function commandTemplateToArgv(command) {
  const normalized = normalizeGhCommandTemplate(command);
  if (!normalized.startsWith('gh ')) {
    return null;
  }
  const body = normalized.slice(3);
  const rawTokens = body.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  if (!rawTokens || rawTokens.length < 2) {
    return null;
  }
  const tokens = rawTokens.map((token) => {
    if ((token.startsWith("'") && token.endsWith("'")) || (token.startsWith('"') && token.endsWith('"'))) {
      return token.slice(1, -1);
    }
    return token;
  });
  const [, sub] = tokens;
  if (WRITE_VERBS.has(sub)) {
    return null;
  }
  return tokens;
}

/**
 * @param {string[]} argv
 */
export function isInventoryCoveredArgv(argv) {
  const { route } = classifyArgv(argv);
  return route !== null;
}

/**
 * @param {string} command
 */
export function isInventoryCoveredCommand(command) {
  const argv = commandTemplateToArgv(command);
  if (!argv) {
    return false;
  }
  return isInventoryCoveredArgv(argv);
}

/**
 * @param {string} line
 */
export function shouldSkipReconcileLine(line) {
  if ($lineMatchesSkip(line)) {
    return true;
  }
  return false;
}

/**
 * @param {string} line
 */
function $lineMatchesSkip(line) {
  if (/^\s*#/.test(line)) {
    return true;
  }
  if (!/(^|[^a-zA-Z])gh\s+(pr|issue|repo)\s+/.test(line)) {
    return true;
  }
  if (/gh pr (merge|comment|create|close|edit|review)/.test(line)) {
    return true;
  }
  if (/gh api\b/.test(line)) {
    return true;
  }
  if (/throw\s+"gh |Write-Error\s+"gh |WarningTemplate\s*=\s*'warn: gh /.test(line)) {
    return true;
  }
  if (/SYNOPSIS|Shared gh pr list/.test(line)) {
    return true;
  }
  return false;
}

/**
 * @param {string} line
 * @returns {string[]}
 */
export function extractGhCommandsFromReconcileLine(line) {
  if ($lineMatchesSkip(line)) {
    return [];
  }
  /** @type {string[]} */
  const found = [];
  for (const pattern of RECONCILE_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      found.push(trimReconcileCommand(match[0]));
    }
  }
  return [...new Set(found)];
}

/**
 * @param {string} line
 * @returns {string[]}
 */
export function extractGhCommandsFromRuleSurfaceLine(line) {
  /** @type {string[]} */
  const found = [];
  const prohibitionDoc = isProhibitionDocLine(line);

  for (const pattern of RULE_SURFACE_READ_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const trimmed = trimRuleSurfaceCommand(match[0]);
      if (!isIncompleteRuleSurfaceCommand(trimmed)) {
        found.push(trimmed);
      }
    }
  }

  if (!prohibitionDoc) {
    for (const pattern of FORBIDDEN_RULE_SURFACE_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(line)) !== null) {
        found.push(trimRuleSurfaceCommand(match[0]));
      }
    }
  }

  return [...new Set(found)];
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function extractGhCommandsFromRuleSurface(text) {
  /** @type {string[]} */
  const found = [];
  for (const line of text.split(/\r?\n/)) {
    found.push(...extractGhCommandsFromRuleSurfaceLine(line));
  }
  return [...new Set(found)];
}

/**
 * @param {string} filePath
 * @param {'reconcile' | 'rules'} mode
 * @returns {{ file: string, command: string, line?: string }[]}
 */
export function scanFileForViolations(filePath, mode) {
  const text = readFileSync(filePath, 'utf8');
  /** @type {{ file: string, command: string, line?: string }[]} */
  const violations = [];

  if (mode === 'rules') {
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      for (const command of extractGhCommandsFromRuleSurfaceLine(line)) {
        const prefixed = command.startsWith('gh ') ? command : `gh ${command}`;
        if (
          FORBIDDEN_RULE_SURFACE_PATTERNS.some((pattern) => {
            pattern.lastIndex = 0;
            return pattern.test(command);
          })
        ) {
          violations.push({ file: filePath, command, line: line.trim() });
          continue;
        }
        if (!isInventoryCoveredCommand(prefixed)) {
          violations.push({ file: filePath, command: prefixed, line: line.trim() });
        }
      }
    }
    return violations;
  }

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    for (const command of extractGhCommandsFromReconcileLine(line)) {
      const prefixed = command.startsWith('gh ') ? command : `gh ${command}`;
      if (!isInventoryCoveredCommand(prefixed)) {
        violations.push({ file: filePath, command: prefixed, line: line.trim() });
      }
    }
  }
  return violations;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write('usage: gh-inventory-static-guard.mjs <file> [--mode reconcile|rules]\n');
    process.exit(2);
  }

  const file = args[0];
  const modeFlag = args.indexOf('--mode');
  const mode = modeFlag >= 0 && args[modeFlag + 1] === 'rules' ? 'rules' : 'reconcile';
  const violations = scanFileForViolations(file, mode);
  if (violations.length > 0) {
    process.stdout.write(`${JSON.stringify(violations, null, 2)}\n`);
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
