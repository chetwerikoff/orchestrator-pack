#!/usr/bin/env node
/**
 * Autonomous orchestrator command-runtime bootstrap/preflight (Issue #532).
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyArgv } from './gh-inventory-match.mjs';
import {
  PACK_SCRIPTS_DIR,
  TRACKED_GH_UNAVAILABLE_DIAGNOSTIC,
  TRACKED_GH_UNAVAILABLE_REASON,
  resolveRealGhBinary,
  resolveTrackedGhWrapper,
} from './gh-resolve-real-binary.mjs';

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
    } else if (part.includes('/.orchestrator-pack/bin')) {
      classes.push('ao-bin');
    } else if (part === '/usr/bin') {
      classes.push('usr-bin');
    } else if (part === '/usr/local/bin') {
      classes.push('usr-local-bin');
    } else if (part.includes('/.local/bin')) {
      classes.push('home-local-bin');
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
function resolveNode(pathValue = '') {
  return resolveExecutableOnPath(pathValue, 'node');
}

/**
 * @param {string} effectivePath
 * @param {string} packScriptsDir
 */
function resolvePackGh(effectivePath, packScriptsDir) {
  const firstGh = resolveExecutableOnPath(effectivePath, 'gh');
  try {
    const packGh = resolveTrackedGhWrapper(join(packScriptsDir, 'gh'));
    return { packGh, firstGh };
  } catch {
    return { packGh: null, firstGh };
  }
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
 * @param {{ node?: string | null, packGh?: string | null, firstGh?: string | null, nativeGh?: string | null, nativeGhError?: string | null }} [input.tools]
 */
export function evaluateCommandRuntimePreflight(input = {}) {
  const packRoot = resolve(input.packRoot ?? DEFAULT_PACK_ROOT);
  const packScriptsDir = resolve(input.packScriptsDir ?? join(packRoot, 'scripts'));
  const effectivePath =
    input.effectivePath ?? buildCommandRuntimePath(packScriptsDir, input.inheritedPath ?? process.env.PATH ?? '');
  const pathClass = classifyEffectivePath(effectivePath, packScriptsDir);

  const tools = input.tools ?? {
    node: resolveNode(effectivePath),
    ...resolvePackGh(effectivePath, packScriptsDir),
    nativeGh: null,
    nativeGhError: null,
  };

  if (!tools.node) {
    return failPreflight('missing_node', 'node', pathClass);
  }
  if (!tools.packGh) {
    return {
      ok: false,
      reason: TRACKED_GH_UNAVAILABLE_REASON,
      diagnostic: `${TRACKED_GH_UNAVAILABLE_DIAGNOSTIC} (path-class=${pathClass})`,
      pathClass,
      missingTool: 'scripts/gh',
    };
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
      node: tools.node,
      packGh: tools.packGh,
      nativeGh: native.nativeGh,
    },
  };
}


function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateManagerProjectUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? null : 'projectUrl must use http or https';
  } catch {
    return 'projectUrl must be an absolute URL';
  }
}

function validateManagerProfileDirectory(value) {
  if (!isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value)) return 'chromeUserDataDir must be an absolute path';
  try {
    if (!statSync(value).isDirectory()) return 'chromeUserDataDir is not a directory';
  } catch {
    return 'chromeUserDataDir does not exist or is not readable';
  }
  return null;
}

export function resolveManagerBrowserOperatorConfig(input = {}) {
  const env = input.env ?? process.env;
  const envProjectUrl = env.DISCUSS_WITH_GPT_PROJECT_URL?.trim();
  const envChromeUserDataDir = env.DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR?.trim();
  let projectUrl;
  let chromeUserDataDir;
  let source;
  let operatorConfigPath;

  if (envProjectUrl && envChromeUserDataDir) {
    projectUrl = envProjectUrl;
    chromeUserDataDir = envChromeUserDataDir;
    source = 'environment';
  } else {
    const locator = input.operatorBrowserConfig?.trim();
    if (!locator) {
      return {
        ok: false,
        probe: 'operator_browser_config',
        reason: 'operator_browser_config_required',
        evidence: 'Browser-GPT operator configuration is unresolved',
        remedy: 'set DISCUSS_WITH_GPT_PROJECT_URL and DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR together or pass --operator-browser-config with the exact operator-owned local.config.json path',
      };
    }
    if (!isAbsolute(locator) && !/^[A-Za-z]:[\\/]/.test(locator)) {
      return {
        ok: false,
        probe: 'operator_browser_config',
        reason: 'operator_browser_config_invalid',
        evidence: `operator config path is not absolute: ${locator}`,
        remedy: 'pass the absolute path to the operator-owned local.config.json; do not copy or discover it from another checkout',
      };
    }
    let raw;
    try {
      if (!statSync(locator).isFile()) throw new Error('not a regular file');
      raw = JSON.parse(readFileSync(locator, 'utf8'));
    } catch (error) {
      return {
        ok: false,
        probe: 'operator_browser_config',
        reason: 'operator_browser_config_invalid',
        evidence: `unable to read operator Browser-GPT config at ${locator}: ${error instanceof Error ? error.message : String(error)}`,
        remedy: `fix the operator-owned local.config.json at ${locator}; do not copy it into the worktree`,
      };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {
        ok: false,
        probe: 'operator_browser_config',
        reason: 'operator_browser_config_invalid',
        evidence: `operator Browser-GPT config at ${locator} must be a JSON object`,
        remedy: `provide projectUrl and chromeUserDataDir in ${locator}`,
      };
    }
    if (!nonEmptyString(raw.projectUrl) || !nonEmptyString(raw.chromeUserDataDir)) {
      return {
        ok: false,
        probe: 'operator_browser_config',
        reason: 'operator_browser_config_invalid',
        evidence: `operator Browser-GPT config at ${locator} requires non-empty projectUrl and chromeUserDataDir`,
        remedy: `populate projectUrl and chromeUserDataDir in ${locator}`,
      };
    }
    projectUrl = raw.projectUrl.trim();
    chromeUserDataDir = raw.chromeUserDataDir.trim();
    source = 'operator-config';
    operatorConfigPath = locator;
  }

  const projectUrlError = validateManagerProjectUrl(projectUrl);
  if (projectUrlError) {
    return {
      ok: false,
      probe: 'operator_browser_config',
      reason: 'operator_browser_config_invalid',
      evidence: projectUrlError,
      remedy: 'provide a valid absolute Browser-GPT projectUrl in the selected operator configuration source',
    };
  }
  const profileError = validateManagerProfileDirectory(chromeUserDataDir);
  if (profileError) {
    return {
      ok: false,
      probe: 'chrome_user_data_dir',
      reason: 'operator_browser_config_invalid',
      evidence: `${profileError}: ${chromeUserDataDir}`,
      remedy: 'provide an existing absolute Chrome user-data directory in the selected operator configuration source',
    };
  }

  return {
    ok: true,
    config: {
      projectUrl,
      chromeUserDataDir,
      source,
      ...(operatorConfigPath ? { operatorConfigPath } : {}),
    },
  };
}

export function evaluateManagerBrowserEnvironmentPreflight(input = {}) {
  const packRoot = resolve(input.packRoot ?? DEFAULT_PACK_ROOT);
  const env = input.env ?? process.env;
  const effectivePath = input.effectivePath ?? env.PATH ?? '';
  const runtime = evaluateCommandRuntimePreflight({
    packRoot,
    effectivePath,
    ...(input.tools ? { tools: input.tools } : {}),
  });
  if (!runtime.ok || !runtime.tools?.packGh) {
    const firstGh = input.tools?.firstGh ?? resolveExecutableOnPath(effectivePath, 'gh');
    return {
      ok: false,
      probe: 'tracked_gh_path',
      reason: runtime.reason,
      evidence: firstGh
        ? `${runtime.diagnostic ?? runtime.reason}; resolved first gh: ${firstGh}`
        : runtime.diagnostic ?? runtime.reason,
      remedy: `put ${join(packRoot, 'scripts')} first on PATH so tracked scripts/gh is the first gh`,
      runtime,
    };
  }

  const config = resolveManagerBrowserOperatorConfig({
    env,
    operatorBrowserConfig: input.operatorBrowserConfig,
  });
  if (!config.ok) return { ...config, runtime };

  const sharedModuleSpecifier = input.sharedModuleSpecifier ?? '@orchestrator-pack/shared/lib/normalize.js';
  let sharedModulePath;
  try {
    const requireFromWorktree = createRequire(join(packRoot, 'package.json'));
    sharedModulePath = realpathSync(requireFromWorktree.resolve(sharedModuleSpecifier));
  } catch (error) {
    return {
      ok: false,
      probe: 'workspace_shared_module',
      reason: 'workspace_dependencies_unavailable',
      evidence: `${sharedModuleSpecifier}: ${error instanceof Error ? error.message : String(error)}`,
      remedy: 'run npm ci --include=dev in this worktree, then resume the same manager Dispatch',
      runtime,
    };
  }
  const sharedRoot = realpathSync(join(packRoot, 'plugins', '_shared'));
  const relativeShared = relative(sharedRoot, sharedModulePath);
  if (relativeShared.startsWith('..' + sep) || relativeShared === '..' || resolve(sharedModulePath) === resolve(sharedRoot)) {
    return {
      ok: false,
      probe: 'workspace_shared_module',
      reason: 'workspace_dependency_resolved_outside_worktree',
      evidence: `${sharedModuleSpecifier} resolved to ${sharedModulePath}; expected under ${sharedRoot}`,
      remedy: 'run npm ci --include=dev in this worktree and remove any foreign workspace resolution before resuming',
      runtime,
    };
  }

  return {
    ok: true,
    runtime,
    config: config.config,
    sharedModulePath,
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
