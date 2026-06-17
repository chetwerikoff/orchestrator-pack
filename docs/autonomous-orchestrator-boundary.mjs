/**
 * Autonomous orchestrator spawn/git boundary (Issue #324).
 * Vitest: scripts/autonomous-orchestrator-boundary.test.ts
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';
import {
  isRawReviewRunInvocation,
  loadAutonomousReviewStartCapabilities,
  validateCapabilityInventory,
} from './orchestrator-claimed-review-run.mjs';

export const AUTONOMOUS_ORCHESTRATOR_BOUNDARY_VERSION =
  'autonomous-orchestrator-boundary/v1';
export const TURN_VISIBLE_REAL_BINARY_ENV_VARS = ['AO_REAL_BINARY', 'GIT_REAL_BINARY'];

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status',
  'log',
  'rev-parse',
  'diff',
  'show',
]);

const MUTATING_GIT_SUBCOMMANDS = new Set([
  'branch',
  'checkout',
  'switch',
  'worktree',
  'reset',
  'push',
  'fetch',
  'stash',
  'commit',
  'merge',
  'rebase',
  'pull',
  'tag',
  'cherry-pick',
  'revert',
]);

const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--exec-path',
  '--namespace',
]);

/**
 * @param {string[]} list
 * @param {number} [startIndex]
 */
export function gitArgvSubcommandIndex(list, startIndex = 0) {
  let index = startIndex;
  while (index < list.length) {
    const token = list[index];
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(token)) {
      index += 2;
      continue;
    }
    if (token.startsWith('--') && token.includes('=')) {
      index += 1;
      continue;
    }
    if ((token.startsWith('-c') && token !== '-c') || (token.startsWith('-C') && token !== '-C')) {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

/**
 * @param {string[]} argv
 */
export function gitSubcommandFromArgv(argv) {
  const list = Array.isArray(argv) ? argv.map((part) => String(part)) : [];
  const index = gitArgvSubcommandIndex(list);
  if (index >= list.length) {
    return '';
  }
  return list[index].toLowerCase();
}

/**
 * @param {string[]} argv
 */
export function gitArgvDefinesAlias(argv) {
  const list = Array.isArray(argv) ? argv.map((part) => String(part)) : [];
  for (let index = 0; index < list.length; index++) {
    const token = list[index];
    if (token === '-c' && index + 1 < list.length) {
      if (/^alias\./i.test(list[index + 1])) {
        return true;
      }
      index += 1;
      continue;
    }
    if (token.startsWith('-c') && token !== '-c' && /^alias\./i.test(token.slice(2))) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string[]} argv
 */
export function isMutatingGitArgv(argv) {
  const list = Array.isArray(argv) ? argv.map((part) => String(part)) : [];
  if (gitArgvDefinesAlias(list)) {
    return true;
  }
  const index = gitArgvSubcommandIndex(list);
  if (index >= list.length) {
    return false;
  }
  const sub = list[index].toLowerCase();
  if (sub === 'fetch') {
    const tail = list.slice(index + 1).join(' ');
    return !/--dry-run/i.test(tail);
  }
  if (sub === 'stash') {
    if (index + 1 >= list.length) {
      return true;
    }
    const stashSub = list[index + 1].toLowerCase();
    return stashSub !== 'list' && stashSub !== 'show';
  }
  if (READ_ONLY_GIT_SUBCOMMANDS.has(sub)) {
    return false;
  }
  if (MUTATING_GIT_SUBCOMMANDS.has(sub)) {
    return true;
  }
  return true;
}

/**
 * @param {string} commandLine
 */
export function isRawSpawnInvocation(commandLine) {
  return /\bao(?:\.cmd)?\s+spawn\b/i.test(String(commandLine ?? ''));
}

/**
 * @param {object} input
 * @param {boolean} [input.autonomousSurface]
 */
export function evaluateAutonomousSpawnBoundary(input) {
  const commandLine = String(input.commandLine ?? '');
  if (!isRawSpawnInvocation(commandLine)) {
    return { allowed: true, reason: 'not_spawn' };
  }
  if (!input.autonomousSurface) {
    return { allowed: true, reason: 'manual_surface' };
  }
  return { allowed: false, reason: 'autonomous_spawn_denied' };
}

/**
 * @param {object} input
 * @param {string[]} [input.argv]
 * @param {boolean} [input.autonomousSurface]
 * @param {boolean} [input.sanctionedProvenance]
 * @param {boolean} [input.claimedBypass]
 * @param {string[]} [input.parentChain]
 */
export function evaluateAutonomousGitBoundary(input) {
  const argv = Array.isArray(input.argv) ? input.argv.map((part) => String(part)) : [];
  if (!input.autonomousSurface) {
    return { allowed: true, reason: 'manual_surface' };
  }
  if (!isMutatingGitArgv(argv)) {
    return { allowed: true, reason: 'read_only_git' };
  }
  if (
    input.sanctionedProvenance
    || hasSanctionedGitParentChain(input.parentChain, Boolean(input.claimedBypass))
  ) {
    return { allowed: true, reason: 'sanctioned_git_child' };
  }
  return { allowed: false, reason: 'autonomous_mutating_git_denied' };
}

/**
 * @param {string[] | undefined} parentChain
 * @param {boolean} [claimedBypass]
 * @param {number} [maxDepth]
 */
export function hasSanctionedGitParentChain(parentChain, claimedBypass = false, maxDepth) {
  const inventory = loadAutonomousReviewStartCapabilities();
  const patterns = inventory.sanctionedGitParents ?? [];
  const depthLimit = Number.isFinite(maxDepth)
    ? Math.max(0, maxDepth)
    : Number(inventory.sanctionedGitParentMaxDepth ?? 2);
  const chain = Array.isArray(parentChain) ? parentChain.map((line) => String(line)) : [];
  const scoped = chain.slice(0, depthLimit);
  for (const line of scoped) {
    for (const pattern of patterns) {
      if (line.includes(pattern)) {
        return true;
      }
    }
  }
  if (claimedBypass) {
    for (const line of chain) {
      if (isRawReviewRunInvocation(line)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * @param {string} segment
 * @param {string} binaryName
 */
function pathSegmentContainsBinary(segment, binaryName) {
  if (!segment) {
    return false;
  }
  try {
    return existsSync(join(segment, binaryName));
  } catch {
    return false;
  }
}

/**
 * @param {object} input
 * @param {Record<string, string | undefined>} [input.env]
 * @param {string} [input.pathValue]
 */
export function evaluateTurnVisibleRealBinaryBypass(input) {
  const env = input.env ?? {};
  for (const name of TURN_VISIBLE_REAL_BINARY_ENV_VARS) {
    if (env[name]) {
      return { bypassPresent: true, reason: 'turn_visible_real_binary_env', name };
    }
  }
  const pathValue = String(input.pathValue ?? env.PATH ?? '');
  const segments = pathValue.split(':').filter(Boolean);
  const scriptsIdx = segments.findIndex((segment) => segment.endsWith('/scripts'));
  if (scriptsIdx > 0) {
    const before = segments.slice(0, scriptsIdx);
    for (const segment of before) {
      if (segment.endsWith('/ao') || segment.endsWith('/git')) {
        return { bypassPresent: true, reason: 'real_binary_before_shim_on_path' };
      }
      if (pathSegmentContainsBinary(segment, 'ao') || pathSegmentContainsBinary(segment, 'git')) {
        return { bypassPresent: true, reason: 'real_binary_before_shim_on_path' };
      }
    }
  }
  return { bypassPresent: false, reason: 'no_turn_visible_bypass' };
}

/**
 * @param {object} input
 * @param {Array<{ id: string, classification: string }>} [input.liveCapabilities]
 */
export function evaluateBoundaryCapabilityPreflight(input) {
  const violations = [];
  const rows = Array.isArray(input.liveCapabilities) ? input.liveCapabilities : [];
  const byId = new Map(rows.map((row) => [String(row.id), String(row.classification)]));
  for (const id of ['ao-spawn-raw', 'git-mutating-direct', 'turn-visible-real-binary-env']) {
    const classification = byId.get(id);
    if (classification !== 'unavailable') {
      violations.push(`${id}_not_unavailable`);
    }
  }
  for (const id of ['git-shim', 'git-autonomous-guard', 'autonomous-real-binaries-config']) {
    const classification = byId.get(id);
    if (classification !== 'gated') {
      violations.push(`${id}_not_gated`);
    }
  }
  return {
    ok: violations.length === 0,
    reason: violations.length === 0 ? 'boundary_preflight_ok' : violations.join(','),
    boundaryVersion: AUTONOMOUS_ORCHESTRATOR_BOUNDARY_VERSION,
  };
}

/**
 * @param {string} [inventoryPath]
 */
export function loadAutonomousOrchestratorBoundaryInventory(inventoryPath) {
  return loadAutonomousReviewStartCapabilities(inventoryPath);
}

/**
 * @param {object} input
 */
export function validateBoundaryCapabilityInventory(input) {
  return validateCapabilityInventory(input);
}

runStdinJsonCli('autonomous-orchestrator-boundary.mjs', {
  evaluateSpawnBoundary: () => evaluateAutonomousSpawnBoundary(readStdinJson()),
  evaluateGitBoundary: () => evaluateAutonomousGitBoundary(readStdinJson()),
  evaluateTurnBypass: () => evaluateTurnVisibleRealBinaryBypass(readStdinJson()),
  evaluatePreflight: () => evaluateBoundaryCapabilityPreflight(readStdinJson()),
});
