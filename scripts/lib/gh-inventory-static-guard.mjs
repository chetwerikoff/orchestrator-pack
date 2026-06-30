/**
 * Static no-drift guard helpers — derive coverage from classifyArgv (Issue #501).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import inventory from './graphql-quota-github-read-inventory.json' with { type: 'json' };
import { ghApiEndpointFromApiTokens } from './gh-api-endpoint.mjs';
import { isGraphqlPassthroughArgv } from './gh-graphql-degraded.mjs';
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

/** @type {RegExp[]} */
const RECONCILE_API_PATTERNS = [
  /\bgh\s+api\s+graphql[^\r\n#|]*/gi,
  /\bgh\s+api\s+[^\r\n#|]+/gi,
];

/**
 * @param {string} fragment
 */
function trimReconcileCommand(fragment) {
  return fragment
    .replace(/\s+2>&.*$/u, '')
    .replace(/\s+2>\$.*$/u, '')
    .replace(/\s+--paginate\b.*$/u, '')
    .replace(/\s+--jq\s+.*$/u, '')
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
  return /MUST NOT|Forbidden transports|forbidden transport|Do not run|Do not use|bypass the wrapper|temporary `?gh`? shims|do not create temp|do not author|workarounds\.|workarounds here|author `\/tmp\/gh-rest-bin|direct bash REST branches in `scripts\/gh`/i.test(line);
}

/**
 * @param {string} command
 */
function isIncompleteRuleSurfaceCommand(command) {
  const trimmed = command.trim().replace(/[,.)]+$/u, '').trim();
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
  if (/^gh\s+pr\s+view/i.test(trimmed) && !/--json/.test(trimmed) && !/^gh\s+pr\s+view\s+#?\d+/i.test(trimmed)) {
    return true;
  }
  if (/^gh\s+pr\s+checks/i.test(trimmed) && !/--json/.test(trimmed) && !/^gh\s+pr\s+checks\s+#?\d+/i.test(trimmed)) {
    return true;
  }
  if (/^gh\s+issue\s+view(?:[, ]|$)/i.test(trimmed) && !/--json/.test(trimmed)) {
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
    .replace(/closes\s+#N\b/gi, 'closes #42')
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
 * @param {string} command
 * @returns {string | null}
 */
function ghApiEndpointFromCommand(command) {
  const prefixed = command.trim().startsWith('gh ') ? command.trim() : `gh ${command.trim()}`;
  return ghApiEndpointFromApiTokens(commandTemplateToArgv(prefixed));
}

/**
 * @param {string} line
 * @returns {string | null}
 */
function ghApiEndpointFromLine(line) {
  const match = line.match(/\bgh\s+api\b/i);
  if (!match || match.index === undefined) {
    return null;
  }
  const fragment = line.slice(match.index).split(/\s*[|;&]/)[0].trim();
  return ghApiEndpointFromCommand(fragment);
}

/**
 * @param {string} command
 */
export function normalizeGhApiCommand(command) {
  let normalized = normalizeGhCommandTemplate(command).replace(/["']/g, '');
  const prefixed = normalized.startsWith('gh ') ? normalized : `gh ${normalized}`;
  const tokens = commandTemplateToArgv(prefixed);
  const endpoint = ghApiEndpointFromApiTokens(tokens);
  if (endpoint) {
    const endpointIdx = tokens.indexOf(endpoint);
    const after = endpointIdx >= 0 ? tokens.slice(endpointIdx + 1) : [];
    normalized = `gh api ${endpoint}${after.length ? ` ${after.join(' ')}` : ''}`;
  }
  return normalized
    .replace(/\$[A-Za-z_][\w]*/g, 'PLACEHOLDER')
    .replace(/\{[^}]+\}/g, 'PLACEHOLDER')
    .replace(/PLACEHOLDER\/PLACEHOLDER/g, 'OWNER/REPO')
    .replace(/repos\/PLACEHOLDER\/PLACEHOLDER/g, 'repos/OWNER/REPO')
    .replace(/repos\/OWNER\/REPO\/commits\/PLACEHOLDER/g, 'repos/OWNER/REPO/commits/SHA')
    .replace(/collaborators\/PLACEHOLDER/g, 'collaborators/ACTOR')
    .replace(/branches\/PLACEHOLDER/g, 'branches/BRANCH');
}

/**
 * @param {string} command
 */
export function matchRestDirectInventoryRow(command) {
  const normalized = normalizeGhApiCommand(command);
  if (!/^gh api repos\//i.test(normalized)) {
    return null;
  }
  for (const row of inventory.rows) {
    if (row.ownerClass !== 'rest_direct' || !row.pattern) {
      continue;
    }
    if (new RegExp(row.pattern, 'i').test(normalized)) {
      return row;
    }
  }
  return null;
}

/**
 * @param {string} command
 */
export function isClassifiedGhReadCommand(command) {
  const prefixed = command.trim().startsWith('gh ') ? command.trim() : `gh ${command.trim()}`;
  const argv = commandTemplateToArgv(prefixed);
  if (!argv) {
    return true;
  }

  if (isGraphqlPassthroughArgv(argv)) {
    return false;
  }

  if (argv[0] === 'api') {
    if (/gh api.*\/merge/i.test(prefixed)) {
      return true;
    }
    return matchRestDirectInventoryRow(prefixed) !== null;
  }

  return isInventoryCoveredCommand(prefixed);
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
  const hasHighLevel = /(^|[^a-zA-Z])gh\s+(pr|issue|repo)\s+/.test(line);
  const endpoint = ghApiEndpointFromLine(line);
  const hasApiRepos = endpoint?.startsWith('repos/') ?? false;
  const hasApiGraphql = endpoint === 'graphql';
  if (!hasHighLevel && !hasApiRepos && !hasApiGraphql) {
    return true;
  }
  if (/gh pr (merge|comment|create|close|edit|review)/.test(line)) {
    return true;
  }
  if (/gh api.*\/merge/i.test(line)) {
    return true;
  }
  if (/throw\s+"gh |Write-Error\s+"gh |WarningTemplate\s*=\s*'warn: gh /.test(line)) {
    return true;
  }
  if (/=\s*"gh\s+(?:pr|issue|repo)\s+[^"]*failed/i.test(line)) {
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

/**
 * @param {string} line
 * @returns {string[]}
 */
function extractForbiddenWorkaroundsFromLine(line) {
  if (/^\s*#/.test(line)) {
    return [];
  }
  /** @type {string[]} */
  const found = [];
  for (const pattern of FORBIDDEN_RULE_SURFACE_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      found.push(trimReconcileCommand(match[0]));
    }
  }
  return [...new Set(found)];
}

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
  for (const pattern of RECONCILE_API_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const trimmed = trimReconcileCommand(match[0]);
      if (!/gh api.*\/merge/i.test(trimmed)) {
        found.push(trimmed);
      }
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
        if (!isClassifiedGhReadCommand(prefixed)) {
          violations.push({ file: filePath, command: prefixed, line: line.trim() });
        }
      }
    }
    return violations;
  }

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    for (const command of extractForbiddenWorkaroundsFromLine(line)) {
      violations.push({ file: filePath, command, line: line.trim() });
    }
    for (const command of extractGhCommandsFromReconcileLine(line)) {
      const prefixed = command.startsWith('gh ') ? command : `gh ${command}`;
      if (!isClassifiedGhReadCommand(prefixed)) {
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
