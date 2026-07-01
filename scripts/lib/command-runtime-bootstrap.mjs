#!/usr/bin/env node
/**
 * Autonomous orchestrator command-runtime bootstrap/preflight (Issue #532).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyArgv } from './gh-inventory-match.mjs';
import { PACK_SCRIPTS_DIR, resolveRealGhBinary } from './gh-resolve-real-binary.mjs';

export const COMMAND_RUNTIME_BOOTSTRAP_VERSION = 'command-runtime-bootstrap/v1';

export const RECOVERY_BOUNDARY_DIAGNOSTIC =
  'command-runtime-bootstrap: command failure implies worker recovery — route to Issue #522/#527; do not improvise cleanup/respawn';

export const TEMPORARY_REST_UNBLOCK_OWNER_NOTE =
  'Temporary operator REST unblock branches in scripts/gh remain owned by Issues #530/#531 until inventory routes land.';

/** @type {readonly { id: string, pattern: RegExp, allowProhibitionDoc?: boolean }[]} */
export const FORBIDDEN_WORKAROUND_PATTERNS = Object.freeze([
  { id: 'temp-gh-rest-bin', pattern: /\/tmp\/gh-rest-bin\/gh/gi, allowProhibitionDoc: true },
  {
    id: 'temp-gh-wrapper-instruction',
    pattern: /(?:create|write|mkdir|add).{0,40}(?:temporary|throwaway|temp).{0,20}`?gh`?(?:\s+wrapper|\s+shim)/gi,
    allowProhibitionDoc: true,
  },
  {
    id: 'curl-api-github',
    pattern: /\bcurl\b[^\n`]*api\.github\.com/gi,
    allowProhibitionDoc: true,
  },
  {
    id: 'gh-api-graphql',
    pattern: /\bgh\s+api\s+graphql/gi,
    allowProhibitionDoc: true,
  },
  {
    id: 'unset-gh-wrapper-active',
    pattern: /\bunset\s+GH_WRAPPER_ACTIVE\b/gi,
    allowProhibitionDoc: true,
  },
  {
    id: 'hand-built-rest-branch',
    pattern: /scripts\/gh[^\n`]*(?:REST unblock|temporary REST|hand-built REST)/gi,
    allowProhibitionDoc: true,
  },
]);

/** @type {readonly RegExp[]} */
export const RECOVERY_DUPLICATION_PATTERNS = Object.freeze([
  /\bSURFACE=0\b/,
  /\bworktree\s+remove\b/i,
  /\bao\s+session\s+kill\b/i,
  /\bao\s+spawn\b/i,
  /\bgit\s+worktree\s+remove\b/i,
]);

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PACK_ROOT = resolve(PACK_SCRIPTS_DIR, '..');

/**
 * @param {string} packScriptsDir
 * @param {string} [inheritedPath]
 */
export function buildCommandRuntimePath(packScriptsDir, inheritedPath = '') {
  const cleaned = String(inheritedPath ?? '')
    .split(':')
    .filter((part) => part && part !== packScriptsDir);
  return [packScriptsDir, ...cleaned].join(':');
}

/**
 * @param {string} effectivePath
 * @param {string} packScriptsDir
 */
export function classifyEffectivePath(effectivePath, packScriptsDir) {
  /** @type {string[]} */
  const classes = [];
  for (const part of String(effectivePath ?? '').split(':').filter(Boolean)) {
    if (part === packScriptsDir) {
      classes.push('pack-scripts');
    } else if (part.includes('/.ao/bin')) {
      classes.push('ao-bin');
    } else if (part === '/usr/bin') {
      classes.push('usr-bin');
    } else if (part === '/usr/local/bin') {
      classes.push('usr-local-bin');
    } else if (part.includes('/.local/bin')) {
      classes.push('home-local-bin');
    } else if (part.includes('/opt/microsoft/powershell')) {
      classes.push('pwsh-opt');
    } else {
      classes.push('other');
    }
  }
  return classes.length > 0 ? classes.join(',') : 'empty';
}

/**
 * @param {string} pathValue
 * @param {string} name
 */
function resolveExecutableOnPath(pathValue, name) {
  for (const dir of String(pathValue ?? '').split(':').filter(Boolean)) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * @param {string} [pathValue]
 */
function resolvePwsh(pathValue = '') {
  return resolveExecutableOnPath(pathValue, 'pwsh');
}

/**
 * @param {string} [pathValue]
 */
function resolveNode(pathValue = '') {
  return resolveExecutableOnPath(pathValue, 'node');
}

/**
 * @param {string} effectivePath
 * @param {string} packScriptsDir
 */
function resolvePackGh(effectivePath, packScriptsDir) {
  const packGh = join(packScriptsDir, 'gh');
  if (!existsSync(packGh)) {
    return { packGh: null, firstGh: resolveExecutableOnPath(effectivePath, 'gh') };
  }
  const firstGh = resolveExecutableOnPath(effectivePath, 'gh');
  return { packGh, firstGh };
}

/**
 * @param {string} effectivePath
 * @param {string} packGh
 */
function resolveNativeGh(effectivePath, packGh) {
  try {
    const nativeGh = resolveRealGhBinary(resolve(packGh));
    return { nativeGh, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { nativeGh: null, error: message };
  }
}

/**
 * @param {object} input
 * @param {string} [input.packRoot]
 * @param {string} [input.packScriptsDir]
 * @param {string} [input.inheritedPath]
 * @param {string} [input.effectivePath]
 * @param {{ pwsh?: string | null, node?: string | null, packGh?: string | null, firstGh?: string | null, nativeGh?: string | null, nativeGhError?: string | null }} [input.tools]
 */
export function evaluateCommandRuntimePreflight(input = {}) {
  const packRoot = resolve(input.packRoot ?? DEFAULT_PACK_ROOT);
  const packScriptsDir = resolve(input.packScriptsDir ?? join(packRoot, 'scripts'));
  const effectivePath =
    input.effectivePath ?? buildCommandRuntimePath(packScriptsDir, input.inheritedPath ?? process.env.PATH ?? '');
  const pathClass = classifyEffectivePath(effectivePath, packScriptsDir);

  const tools = input.tools ?? {
    pwsh: resolvePwsh(effectivePath),
    node: resolveNode(effectivePath),
    ...resolvePackGh(effectivePath, packScriptsDir),
    nativeGh: null,
    nativeGhError: null,
  };

  if (!tools.pwsh) {
    return failPreflight('missing_pwsh', 'pwsh', pathClass);
  }
  if (!tools.node) {
    return failPreflight('missing_node', 'node', pathClass);
  }
  if (!tools.packGh) {
    return failPreflight('missing_pack_gh', 'scripts/gh', pathClass);
  }
  if (!tools.firstGh || resolve(tools.firstGh) !== resolve(tools.packGh)) {
    return {
      ok: false,
      reason: 'pack_gh_not_first_on_path',
      diagnostic: `command-runtime-bootstrap: pack scripts/gh must be first gh on PATH (path-class=${pathClass})`,
      pathClass,
      missingTool: 'pack-gh-path-order',
    };
  }

  const native =
    input.tools?.nativeGh !== undefined
      ? { nativeGh: input.tools.nativeGh, error: input.tools.nativeGhError ?? null }
      : resolveNativeGh(effectivePath, tools.packGh);

  if (!native.nativeGh) {
    return {
      ok: false,
      reason: 'native_gh_unresolved',
      diagnostic: `command-runtime-bootstrap: ${native.error ?? 'no native gh executable found'} (path-class=${pathClass})`,
      pathClass,
      missingTool: 'native-gh',
    };
  }

  return {
    ok: true,
    reason: 'command_runtime_preflight_ok',
    pathClass,
    tools: {
      pwsh: tools.pwsh,
      node: tools.node,
      packGh: tools.packGh,
      nativeGh: native.nativeGh,
    },
  };
}

/**
 * @param {string} reason
 * @param {string} tool
 * @param {string} pathClass
 */
function failPreflight(reason, tool, pathClass) {
  return {
    ok: false,
    reason,
    diagnostic: `command-runtime-bootstrap: missing tool ${tool} (path-class=${pathClass})`,
    pathClass,
    missingTool: tool,
  };
}

/**
 * @param {object} input
 * @param {string} [input.stdout]
 * @param {string} [input.stderr]
 * @param {string} [input.combined]
 */
export function parseStructuredCommandOutput(input = {}) {
  if (input.combined !== undefined && input.combined !== null) {
    return { ok: false, reason: 'structured_output_polluted' };
  }

  const stderr = String(input.stderr ?? '').trim();
  const stdout = String(input.stdout ?? '').trim();
  if (!stdout) {
    return { ok: false, reason: 'empty_child_output' };
  }

  try {
    const value = JSON.parse(stdout);
    return { ok: true, value, stderr };
  } catch (error) {
    if (stderr) {
      try {
        JSON.parse(`${stderr}\n${stdout}`);
        return { ok: false, reason: 'structured_output_polluted' };
      } catch {
        if (stdout.startsWith(stderr)) {
          return { ok: false, reason: 'structured_output_polluted' };
        }
      }
    }
    const jsonStart = stdout.indexOf('{');
    if (jsonStart > 0) {
      try {
        JSON.parse(stdout.slice(jsonStart));
        return { ok: false, reason: 'structured_output_polluted' };
      } catch {
        // fall through to malformed
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `malformed_child_output:${message}` };
  }
}

/**
 * @param {string[]} argv
 */
export function evaluateUncoveredGhArgv(argv) {
  const { route } = classifyArgv(argv);
  if (route) {
    return { ok: true, covered: true, route: route.id };
  }
  return {
    ok: false,
    covered: false,
    reason: 'gh_inventory_gap',
    diagnostic:
      'command-runtime-bootstrap: uncovered gh read form — report argv shape for inventory extension; do not create temp gh wrappers, curl api.github.com, gh api graphql, unset GH_WRAPPER_ACTIVE, or hand-built REST branches',
    argvShape: argv.join(' '),
  };
}

/**
 * @param {string} line
 */
function isProhibitionDocLine(line) {
  return /MUST NOT|Forbidden transports|forbidden transport|Do not run|Do not use|bypass the wrapper|temporary `?gh`? shims|do not create temp|do not author|workarounds\.|workarounds here|author `\/tmp\/gh-rest-bin|direct bash REST branches in `scripts\/gh`/i.test(
    line,
  );
}

/**
 * @param {string} text
 * @param {string} filePath
 * @returns {{ file: string, id: string, line: string }[]}
 */
export function scanForbiddenWorkaroundInstructions(text, filePath) {
  /** @type {{ file: string, id: string, line: string }[]} */
  const violations = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (const line of lines) {
    const prohibitionDoc = isProhibitionDocLine(line);
    for (const rule of FORBIDDEN_WORKAROUND_PATTERNS) {
      rule.pattern.lastIndex = 0;
      if (!rule.pattern.test(line)) {
        continue;
      }
      if (rule.allowProhibitionDoc && prohibitionDoc) {
        continue;
      }
      violations.push({ file: filePath, id: rule.id, line: line.trim() });
    }
  }
  return violations;
}

/**
 * @param {string} text
 * @param {string} filePath
 * @returns {{ file: string, pattern: string, line: string }[]}
 */
export function scanRecoveryDuplication(text, filePath) {
  /** @type {{ file: string, pattern: string, line: string }[]} */
  const violations = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    for (const pattern of RECOVERY_DUPLICATION_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({ file: filePath, pattern: pattern.source, line: line.trim() });
      }
    }
  }
  return violations;
}

/**
 * @param {string} packRoot
 */
export function runLiveCommandRuntimePreflight(packRoot = DEFAULT_PACK_ROOT) {
  const result = evaluateCommandRuntimePreflight({
    packRoot,
    effectivePath: process.env.PATH ?? '',
  });
  if (!result.ok) {
    process.stderr.write(`${result.diagnostic}\n`);
    process.exit(1);
  }
  process.stderr.write('[PASS] command-runtime bootstrap preflight\n');
  process.exit(0);
}

function main() {
  const sub = process.argv[2];
  if (sub === 'livePreflight') {
    const packRootFlag = process.argv.indexOf('--pack-root');
    const packRoot = packRootFlag >= 0 ? process.argv[packRootFlag + 1] : DEFAULT_PACK_ROOT;
    runLiveCommandRuntimePreflight(packRoot);
    return;
  }
  if (sub === 'evaluatePreflight') {
    const payload = process.argv[3] ? JSON.parse(process.argv[3]) : {};
    process.stdout.write(`${JSON.stringify(evaluateCommandRuntimePreflight(payload))}\n`);
    return;
  }
  if (sub === 'parseStructuredOutput') {
    const payload = process.argv[3] ? JSON.parse(process.argv[3]) : {};
    process.stdout.write(`${JSON.stringify(parseStructuredCommandOutput(payload))}\n`);
    return;
  }
  if (sub === 'scanWorkaround') {
    const filePath = process.argv[3];
    if (!filePath) {
      process.stderr.write('usage: command-runtime-bootstrap.mjs scanWorkaround <file>\n');
      process.exit(2);
    }
    const violations = scanForbiddenWorkaroundInstructions(readFileSync(filePath, 'utf8'), filePath);
    if (violations.length > 0) {
      process.stdout.write(`${JSON.stringify(violations, null, 2)}\n`);
      process.exit(1);
    }
    process.exit(0);
  }
  if (sub === 'scanRecovery') {
    const filePath = process.argv[3];
    if (!filePath) {
      process.stderr.write('usage: command-runtime-bootstrap.mjs scanRecovery <file>\n');
      process.exit(2);
    }
    const violations = scanRecoveryDuplication(readFileSync(filePath, 'utf8'), filePath);
    if (violations.length > 0) {
      process.stdout.write(`${JSON.stringify(violations, null, 2)}\n`);
      process.exit(1);
    }
    process.exit(0);
  }
  process.stderr.write(
    'usage: command-runtime-bootstrap.mjs livePreflight [--pack-root <path>] | evaluatePreflight <json> | parseStructuredOutput <json> | scanWorkaround <file> | scanRecovery <file>\n',
  );
  process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
