/**
 * Autonomous orchestrator spawn/git boundary (Issue #324 / #458).
 * Vitest: scripts/autonomous-orchestrator-boundary.test.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';
import {
  isAoReviewRunGitWorktreeSetupCommandLine,
  loadAutonomousReviewStartCapabilities,
  validateCapabilityInventory,
} from './orchestrator-claimed-review-run.mjs';

export const AUTONOMOUS_ORCHESTRATOR_BOUNDARY_VERSION =
  'autonomous-orchestrator-boundary/v1';
export const AUTONOMOUS_SPAWN_POLICY_VERSION = 'autonomous-spawn-policy/v1';
export const AUTONOMOUS_SPAWN_POLICY_RELATIVE_PATH = 'docs/autonomous-spawn-policy.json';
export const TURN_VISIBLE_REAL_BINARY_ENV_VARS = ['AO_REAL_BINARY', 'GIT_REAL_BINARY'];
const PREFLIGHT_GIT_PARENTS = [
  'reviewer-workspace-preflight.ps1',
  'orchestrator-worktree-preflight.ps1',
];
const CLAIMED_REVIEW_RUN_INVOKER = 'Invoke-OrchestratorClaimedReviewRun.ps1';

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status',
  'log',
  'rev-parse',
  'diff',
  'show',
  'ls-files',
  'ls-tree',
  'cat-file',
  'merge-base',
  'grep',
  'check-ignore',
  'check-attr',
  'describe',
  'for-each-ref',
  'show-ref',
  'name-rev',
  'var',
  'version',
  'help',
  'rev-list',
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

/**
 * @param {string[]} argv
 */
export function isGitArgvWorktreeList(argv) {
  const list = Array.isArray(argv) ? argv.map((part) => String(part)) : [];
  const index = gitArgvSubcommandIndex(list);
  if (index + 1 >= list.length) {
    return false;
  }
  return list[index].toLowerCase() === 'worktree' && list[index + 1].toLowerCase() === 'list';
}

/**
 * @param {string[]} argv
 */
export function isGitArgvWorktreeRemoveForce(argv) {
  const list = Array.isArray(argv) ? argv.map((part) => String(part)) : [];
  const index = gitArgvSubcommandIndex(list);
  if (index + 1 >= list.length || list[index].toLowerCase() !== 'worktree') {
    return false;
  }
  if (list[index + 1].toLowerCase() !== 'remove') {
    return false;
  }
  return list.slice(index + 2).some((token) => token === '--force' || token === '-f');
}

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
 * @param {string} token
 * @param {string} option
 */
function gitTokenIsExactOption(token, option) {
  const lowered = String(token).toLowerCase();
  const opt = String(option).toLowerCase();
  return lowered === opt || lowered.startsWith(`${opt}=`);
}

/**
 * @param {string[]} list
 * @param {number} startIndex
 * @param {string} option
 */
function gitArgvTailHasExactOption(list, startIndex, option) {
  for (let index = startIndex; index < list.length; index += 1) {
    if (gitTokenIsExactOption(list[index], option)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string[]} list
 * @param {number} startIndex
 */

function gitTokenIsConfigGetOption(token) {
  const lowered = String(token).toLowerCase();
  return (
    lowered === '--get'
    || lowered === '--get-all'
    || lowered === '--get-regexp'
    || lowered === '--get-urlmatch'
    || lowered.startsWith('--get=')
    || lowered.startsWith('--get-all=')
    || lowered.startsWith('--get-regexp=')
    || lowered.startsWith('--get-urlmatch=')
  );
}

/**
 * @param {string[]} list
 * @param {number} startIndex
 */
function gitArgvConfigTailIsGetReadOnly(list, startIndex) {
  let sawGet = false;
  for (let tokenIndex = startIndex; tokenIndex < list.length; tokenIndex += 1) {
    const token = list[tokenIndex];
    if (gitTokenIsConfigGetOption(token)) {
      sawGet = true;
      continue;
    }
    if (String(token).startsWith('-')) {
      continue;
    }
    if (!sawGet) {
      return false;
    }
  }
  return sawGet;
}

function gitArgvTailHasPositionalOperand(list, startIndex) {
  for (let index = startIndex; index < list.length; index += 1) {
    if (!String(list[index]).startsWith('-')) {
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
  if (isGitArgvWorktreeList(list)) {
    return false;
  }
  const sub = list[index].toLowerCase();
  if (sub === 'fetch') {
    return !gitArgvTailHasExactOption(list, index + 1, '--dry-run');
  }
  if (sub === 'stash') {
    if (index + 1 >= list.length) {
      return true;
    }
    const stashSub = list[index + 1].toLowerCase();
    return stashSub !== 'list' && stashSub !== 'show';
  }
  if (sub === 'config') {
    return !gitArgvConfigTailIsGetReadOnly(list, index + 1);
  }
  if (sub === 'branch') {
    if (gitArgvTailHasPositionalOperand(list, index + 1)) {
      return true;
    }
    return !gitArgvTailHasExactOption(list, index + 1, '--show-current');
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
 * @param {string[]} argv
 */
export function isSpawnAoArgv(argv) {
  const list = Array.isArray(argv) ? argv.map((part) => String(part)) : [];
  for (const token of list) {
    if (token.startsWith('-')) {
      continue;
    }
    return token.toLowerCase() === 'spawn';
  }
  return false;
}

/**
 * @param {string} commandLine
 */
export function isRawSpawnInvocation(commandLine) {
  return /\bao(?:\.cmd)?\s+spawn\b/i.test(String(commandLine ?? ''));
}

/**
 * @param {string[]} argv
 */
export function hasClaimPrFlagInSpawnArgv(argv) {
  const list = Array.isArray(argv) ? argv.map((part) => String(part)) : [];
  for (const token of list) {
    if (token === '--claim-pr' || /^--claim-pr=/i.test(token)) {
      return true;
    }
  }
  return false;
}

export function classifySpawnAction(argv) {
  const list = Array.isArray(argv) ? argv.map((part) => String(part)) : [];
  if (!isSpawnAoArgv(list)) {
    return 'not-spawn';
  }
  if (hasClaimPrFlagInSpawnArgv(list)) {
    if (parseClaimPrNumberFromSpawnArgv(list) !== null) {
      return 'claim-pr-resume';
    }
    return 'claim-pr-malformed';
  }
  return 'spawn-new';
}

/**
 * @param {string} raw
 * @returns {number | null}
 */
export function parseStrictPositiveIntegerToken(raw) {
  const value = String(raw).trim();
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * @param {string[]} argv
 * @returns {number | null}
 */
export function parseClaimPrNumberFromSpawnArgv(argv) {
  const list = Array.isArray(argv) ? argv.map((part) => String(part)) : [];
  for (let index = 0; index < list.length; index += 1) {
    const token = list[index];
    if (token === '--claim-pr' && index + 1 < list.length) {
      return parseStrictPositiveIntegerToken(list[index + 1]);
    }
    const eqMatch = /^--claim-pr=(.+)$/i.exec(token);
    if (eqMatch) {
      return parseStrictPositiveIntegerToken(eqMatch[1]);
    }
  }
  return null;
}

/**
 * @param {unknown} policy
 */
export function validateAutonomousSpawnPolicy(policy) {
  if (!policy || typeof policy !== 'object') {
    return { ok: false, reason: 'spawn_policy_missing_or_unreadable' };
  }
  const version = String(/** @type {{ version?: string }} */ (policy).version ?? '').trim();
  if (version !== AUTONOMOUS_SPAWN_POLICY_VERSION) {
    return { ok: false, reason: 'spawn_policy_unknown_version' };
  }
  const allowSpawnNew = /** @type {{ allowSpawnNew?: unknown }} */ (policy).allowSpawnNew;
  const allowClaimPrResume = /** @type {{ allowClaimPrResume?: unknown }} */ (policy).allowClaimPrResume;
  if (typeof allowSpawnNew !== 'boolean' || typeof allowClaimPrResume !== 'boolean') {
    return { ok: false, reason: 'spawn_policy_non_boolean_toggle' };
  }
  return {
    ok: true,
    reason: 'spawn_policy_ok',
    policy: {
      allowSpawnNew,
      allowClaimPrResume,
    },
  };
}

/**
 * @param {string} [packRoot]
 */
export function loadAutonomousSpawnPolicy(packRoot) {
  const root = String(packRoot ?? process.cwd());
  const policyPath = join(root, AUTONOMOUS_SPAWN_POLICY_RELATIVE_PATH);
  if (!existsSync(policyPath)) {
    return { ok: false, reason: 'spawn_policy_missing_or_unreadable', policy: null };
  }
  try {
    const parsed = JSON.parse(readFileSync(policyPath, 'utf8'));
    const validated = validateAutonomousSpawnPolicy(parsed);
    if (!validated.ok) {
      return { ok: false, reason: validated.reason, policy: null };
    }
    return { ok: true, reason: validated.reason, policy: validated.policy };
  }
  catch {
    return { ok: false, reason: 'spawn_policy_malformed', policy: null };
  }
}

/**
 * @param {object} input
 * @param {string[]} [input.argv]
 * @param {boolean} [input.autonomousSurface]
 * @param {{ allowSpawnNew: boolean, allowClaimPrResume: boolean } | null} [input.policy]
 * @param {boolean} [input.policyLoadOk]
 * @param {string} [input.policyLoadReason]
 */
export function evaluateAutonomousSpawnPolicyDecision(input) {
  const argv = Array.isArray(input.argv) ? input.argv.map((part) => String(part)) : [];
  const action = classifySpawnAction(argv);
  if (action === 'not-spawn') {
    return { allowed: true, denied: false, reason: 'not_spawn', action, auditLine: '' };
  }
  if (!input.autonomousSurface) {
    return { allowed: true, denied: false, reason: 'manual_surface', action, auditLine: '' };
  }
  if (action === 'claim-pr-malformed') {
    return {
      allowed: false,
      denied: true,
      reason: 'claim_pr_resume_invalid_pr',
      action,
      auditLine: 'autonomous spawn policy deny: action=claim-pr-malformed reason=claim_pr_resume_invalid_pr',
    };
  }
  if (!input.policyLoadOk || !input.policy) {
    const reason = String(input.policyLoadReason ?? 'spawn_policy_missing_or_unreadable');
    return {
      allowed: false,
      denied: true,
      reason,
      action,
      auditLine: `autonomous spawn policy deny: action=${action} reason=${reason}`,
    };
  }
  const toggleAllowed =
    action === 'spawn-new'
      ? input.policy.allowSpawnNew
      : action === 'claim-pr-resume'
        ? input.policy.allowClaimPrResume
        : false;
  if (!toggleAllowed) {
    const reason =
      action === 'spawn-new' ? 'spawn_policy_allowSpawnNew_false' : 'spawn_policy_allowClaimPrResume_false';
    return {
      allowed: false,
      denied: true,
      reason,
      action,
      auditLine: `autonomous spawn policy deny: action=${action} reason=${reason}`,
    };
  }
  return {
    allowed: true,
    denied: false,
    reason: 'spawn_policy_allowed',
    action,
    auditLine: `autonomous spawn policy allow: action=${action} allowSpawnNew=${input.policy.allowSpawnNew} allowClaimPrResume=${input.policy.allowClaimPrResume}`,
  };
}

/**
 * @param {object} input
 * @param {number} [input.prNumber]
 * @param {boolean} [input.resumeMutexHeld]
 * @param {boolean} [input.liveOwnerPresent]
 * @param {boolean} [input.ownerLivenessKnown]
 * @param {boolean} [input.concurrentAttemptLost]
 */
export function evaluateClaimPrResumeSafety(input) {
  const prNumber = Number(input.prNumber);
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    return { allowed: false, reason: 'claim_pr_resume_invalid_pr' };
  }
  if (input.concurrentAttemptLost) {
    return {
      allowed: false,
      reason: 'claim_pr_resume_already_in_progress',
    };
  }
  if (input.resumeMutexHeld) {
    return {
      allowed: false,
      reason: 'claim_pr_resume_already_in_progress',
    };
  }
  if (input.liveOwnerPresent) {
    return {
      allowed: false,
      reason: 'claim_pr_resume_cleanup_required',
    };
  }
  if (input.ownerLivenessKnown === false) {
    return {
      allowed: false,
      reason: 'claim_pr_resume_cleanup_required',
    };
  }
  if (input.staleArtifactPresent) {
    return {
      allowed: false,
      reason: 'claim_pr_resume_cleanup_required',
    };
  }
  if (input.staleArtifactKnown === false) {
    return {
      allowed: false,
      reason: 'claim_pr_resume_cleanup_required',
    };
  }
  return { allowed: true, reason: 'claim_pr_resume_safe' };
}

/**
 * @param {object} input
 * @param {boolean} [input.autonomousSurface]
 * @param {string} [input.commandLine]
 * @param {string[]} [input.argv]
 * @param {{ allowSpawnNew: boolean, allowClaimPrResume: boolean } | null} [input.policy]
 * @param {boolean} [input.policyLoadOk]
 * @param {string} [input.policyLoadReason]
 * @param {boolean} [input.claimPrResumeSafe]
 * @param {string} [input.claimPrResumeReason]
 */
export function evaluateAutonomousSpawnPolicyBoundary(input) {
  const argv = Array.isArray(input.argv)
    ? input.argv.map((part) => String(part))
    : tokenizeProcessCommandLine(String(input.commandLine ?? '')).slice(1);
  const decision = evaluateAutonomousSpawnPolicyDecision({
    argv,
    autonomousSurface: input.autonomousSurface,
    policy: input.policy ?? null,
    policyLoadOk: input.policyLoadOk,
    policyLoadReason: input.policyLoadReason,
  });
  if (!decision.allowed) {
    return decision;
  }
  if (decision.action === 'claim-pr-resume') {
    if (input.claimPrResumeSafe === false) {
      const reason = String(input.claimPrResumeReason ?? 'claim_pr_resume_cleanup_required');
      return {
        allowed: false,
        denied: true,
        reason,
        action: decision.action,
        auditLine: `autonomous spawn policy deny: action=${decision.action} reason=${reason}`,
      };
    }
  }
  return decision;
}

/**
 * @param {object} input
 * @param {boolean} [input.autonomousSurface]
 * @param {string} [input.commandLine]
 * @param {string[]} [input.argv]
 * @param {{ allowSpawnNew: boolean, allowClaimPrResume: boolean } | null} [input.policy]
 * @param {boolean} [input.policyLoadOk]
 */

/**
 * @param {string[]} argv
 */
export function isAutonomousAoReadFastPath(argv) {
  const list = Array.isArray(argv) ? argv.map((part) => String(part)) : [];
  let sub = '';
  let next = '';
  for (const token of list) {
    if (token.startsWith('-')) {
      continue;
    }
    if (!sub) {
      sub = token.toLowerCase();
      continue;
    }
    next = token.toLowerCase();
    break;
  }
  if (!sub) {
    return false;
  }
  if (sub === 'status') {
    return true;
  }
  if (sub === 'review') {
    return next === 'list';
  }
  return false;
}

/**
 * @param {string[]} argv
 */
export function isAutonomousGitReadFastPath(argv) {
  return !isMutatingGitArgv(argv);
}

export function evaluateAutonomousSpawnBoundary(input) {
  const argv = Array.isArray(input.argv)
    ? input.argv.map((part) => String(part))
    : undefined;
  const commandLine = String(input.commandLine ?? '');
  if (argv) {
    return evaluateAutonomousSpawnPolicyBoundary({
      argv,
      autonomousSurface: input.autonomousSurface,
      policy: input.policy ?? null,
      policyLoadOk: input.policyLoadOk ?? Boolean(input.policy),
      policyLoadReason: input.policyLoadReason,
      claimPrResumeSafe: input.claimPrResumeSafe,
      claimPrResumeReason: input.claimPrResumeReason,
    });
  }
  if (!isRawSpawnInvocation(commandLine)) {
    return { allowed: true, denied: false, reason: 'not_spawn', action: 'not-spawn', auditLine: '' };
  }
  if (!input.autonomousSurface) {
    return { allowed: true, denied: false, reason: 'manual_surface', action: 'spawn-new', auditLine: '' };
  }
  const defaultPolicy = input.policy ?? { allowSpawnNew: true, allowClaimPrResume: true };
  const tokens = tokenizeProcessCommandLine(commandLine);
  const spawnIndex = tokens.findIndex((token) => token.toLowerCase() === 'spawn');
  const aoArgv = spawnIndex >= 0 ? tokens.slice(spawnIndex) : ['spawn'];
  return evaluateAutonomousSpawnPolicyBoundary({
    argv: aoArgv,
    autonomousSurface: true,
    policy: defaultPolicy,
    policyLoadOk: input.policyLoadOk ?? true,
    policyLoadReason: input.policyLoadReason,
    claimPrResumeSafe: input.claimPrResumeSafe ?? true,
    claimPrResumeReason: input.claimPrResumeReason,
  });
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
  if (isGitArgvAoOwnedWorktreeAdd(argv)) {
    if (input.claimBoundWorktreeAllow) {
      return { allowed: true, reason: 'claimed_worktree_allow' };
    }
    if (input.spawnWorktreeGrantAllow) {
      return { allowed: true, reason: 'spawn_worktree_allow' };
    }
    return { allowed: false, reason: 'autonomous_mutating_git_denied' };
  }
  if (isGitArgvWorktreeRemoveForce(argv)) {
    if (input.recoveryWorktreeRemoveAllow) {
      return { allowed: true, reason: 'recovery_worktree_remove_allow' };
    }
    if (
      input.sanctionedProvenance
      || hasSanctionedGitParentChain(input.parentChain, argv)
    ) {
      return { allowed: true, reason: 'sanctioned_git_child' };
    }
    return { allowed: false, reason: input.recoveryDenyReason ?? 'autonomous_mutating_git_denied' };
  }
  if (
    input.sanctionedProvenance
    || hasSanctionedGitParentChain(input.parentChain, argv)
  ) {
    return { allowed: true, reason: 'sanctioned_git_child' };
  }
  return { allowed: false, reason: 'autonomous_mutating_git_denied' };
}

/**
 * @param {string} commandLine
 */
export function tokenizeProcessCommandLine(commandLine) {
  const text = String(commandLine ?? '');
  const tokens = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (/\s/.test(char) && !inSingle && !inDouble) {
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
 * @param {string} commandLine
 * @param {string[]} [sanctionedScripts]
 */
export function isSanctionedGitParentCommandLine(commandLine, sanctionedScripts) {
  const inventory = loadAutonomousReviewStartCapabilities();
  const scripts = sanctionedScripts ?? inventory.sanctionedGitParents ?? [];
  const tokens = tokenizeProcessCommandLine(commandLine);
  if (tokens.length === 0) {
    return false;
  }
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].toLowerCase() === '-file' && index + 1 < tokens.length) {
      const leaf = tokens[index + 1].replace(/^['"]|['"]$/g, '').split(/[/\\]/).pop() ?? '';
      if (scripts.includes(leaf)) {
        return true;
      }
    }
  }
  const firstLeaf = tokens[0].replace(/^['"]|['"]$/g, '').split(/[/\\]/).pop() ?? '';
  return scripts.includes(firstLeaf);
}

const SYSTEM_GIT_PREFIXES = ['/usr/bin/', '/bin/', '/usr/local/bin/'];

/**
 * @param {string} candidatePath
 */
export function isKnownSystemGitBinaryPath(candidatePath) {
  const normalized = String(candidatePath ?? '').replace(/\\/g, '/');
  const leaf = normalized.split('/').pop() ?? '';
  if (leaf !== 'git') {
    return false;
  }
  return SYSTEM_GIT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * @param {object} input
 * @param {string} [input.configuredGitPath]
 * @param {string} [input.packRoot]
 */
export function evaluateConfiguredGitBinaryBypass(input) {
  const configured = String(input.configuredGitPath ?? '');
  const packRoot = String(input.packRoot ?? '');
  if (!configured) {
    return { bypassPresent: false, reason: 'no_configured_git' };
  }
  if (isKnownSystemGitBinaryPath(configured)) {
    return { bypassPresent: true, reason: 'configured_system_git_binary' };
  }
  const expectedSuffix = '/scripts/git-real-binary';
  if (!configured.endsWith('git-real-binary') && !configured.endsWith(expectedSuffix)) {
    return { bypassPresent: true, reason: 'configured_git_not_pack_wrapper' };
  }
  if (packRoot) {
    const expected = `${packRoot.replace(/\\/g, '/')}/scripts/git-real-binary`;
    if (configured.replace(/\\/g, '/') !== expected) {
      return { bypassPresent: true, reason: 'configured_git_not_pack_wrapper' };
    }
  }
  return { bypassPresent: false, reason: 'configured_git_wrapper_ok' };
}

/**
 * @param {object} input
 * @param {string} [input.commandLine]
 */
export function evaluateAbsoluteSystemGitInvocationBoundary(input) {
  const commandLine = String(input.commandLine ?? '');
  const match = /^(\/usr\/bin\/git|\/bin\/git|\/usr\/local\/bin\/git)\b(.*)$/i.exec(commandLine);
  if (!match) {
    return { allowed: true, reason: 'not_absolute_system_git' };
  }
  if (!input.autonomousSurface) {
    return { allowed: true, reason: 'manual_surface' };
  }
  const argv = match[2].trim().split(/\s+/).filter(Boolean);
  return evaluateAutonomousGitBoundary({
    argv,
    autonomousSurface: true,
    parentChain: input.parentChain,
    claimedBypass: input.claimedBypass,
  });
}

/**
 * @param {string[]} argv
 */
export function isGitArgvAoOwnedWorktreeAdd(argv) {
  const list = Array.isArray(argv) ? argv.map((part) => String(part)) : [];
  const index = gitArgvSubcommandIndex(list);
  if (index >= list.length) {
    return false;
  }
  if (list[index].toLowerCase() !== 'worktree') {
    return false;
  }
  if (index + 1 >= list.length) {
    return false;
  }
  return list[index + 1].toLowerCase() === 'add';
}

/**
 * @param {string[] | undefined} parentChain
 * @param {number} [maxDepth]
 */
export function classifySanctionedGitProvenance(parentChain, maxDepth) {
  const inventory = loadAutonomousReviewStartCapabilities();
  const depthLimit = Number.isFinite(maxDepth)
    ? Math.max(0, maxDepth)
    : Number(inventory.sanctionedGitParentMaxDepth ?? 2);
  const chain = Array.isArray(parentChain) ? parentChain.map((line) => String(line)) : [];
  for (const line of chain.slice(0, depthLimit)) {
    if (isSanctionedGitParentCommandLine(line, PREFLIGHT_GIT_PARENTS)) {
      return 'preflight';
    }
  }
  for (const line of chain.slice(0, depthLimit)) {
    if (isSanctionedGitParentCommandLine(line, [CLAIMED_REVIEW_RUN_INVOKER])) {
      return 'claimed_review_run';
    }
    if (isAoReviewRunGitWorktreeSetupCommandLine(line)) {
      return 'review_run_worktree_command';
    }
  }
  return 'none';
}

/**
 * @param {string[] | undefined} parentChain
 * @param {string[]} [argv]
 * @param {boolean} [claimedBypass]
 * @param {number} [maxDepth]
 */
export function hasSanctionedGitParentChain(parentChain, argv = [], claimedBypass = false, maxDepth) {
  void claimedBypass;
  void argv;
  const provenance = classifySanctionedGitProvenance(parentChain, maxDepth);
  if (provenance === 'preflight') {
    return true;
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
  evaluateSpawnPolicy: () => evaluateAutonomousSpawnPolicyBoundary(readStdinJson()),
  evaluateSpawnPolicyDecision: () => evaluateAutonomousSpawnPolicyDecision(readStdinJson()),
  evaluateClaimPrResumeSafety: () => evaluateClaimPrResumeSafety(readStdinJson()),
  validateSpawnPolicy: () => validateAutonomousSpawnPolicy(readStdinJson()),
  evaluateGitBoundary: () => evaluateAutonomousGitBoundary(readStdinJson()),
  evaluateTurnBypass: () => evaluateTurnVisibleRealBinaryBypass(readStdinJson()),
  evaluatePreflight: () => evaluateBoundaryCapabilityPreflight(readStdinJson()),
});
