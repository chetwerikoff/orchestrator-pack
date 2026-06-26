/**
 * Spawn-owned worktree grant validation (Issue #470).
 */
import {
  classifySpawnAction,
  parseClaimPrNumberFromSpawnArgv,
} from './autonomous-orchestrator-boundary.mjs';
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';

export const SPAWN_WORKTREE_GRANT_SCHEMA_VERSION = 1;
export const SPAWN_WORKTREE_GRANT_TTL_SECONDS = 120;

/** Git globals that select a repository other than the process cwd. */
export const GIT_SOURCE_SELECTING_GLOBAL_FLAGS = new Set(['-C', '--git-dir', '--work-tree']);

/** `ao spawn` flags that consume the next argv token (see `ao spawn --help`). */
export const SPAWN_ARGV_OPTIONS_WITH_VALUE = ['--agent', '--claim-pr', '--prompt'];

/**
 * @param {string} token
 */
function spawnArgvOptionInlineValue(token) {
  const match = /^(--[^=]+)=(.*)$/i.exec(token);
  if (!match) {
    return null;
  }
  return { flag: match[1].toLowerCase(), value: match[2] };
}

/**
 * @param {string} token
 */
function spawnArgvOptionConsumesNextToken(token) {
  const inline = spawnArgvOptionInlineValue(token);
  if (inline) {
    return false;
  }
  return SPAWN_ARGV_OPTIONS_WITH_VALUE.includes(token.toLowerCase());
}

/**
 * @param {string[]} argv
 */
export function parseSpawnTargetFromArgv(argv) {
  const list = Array.isArray(argv) ? argv.map((part) => String(part)) : [];
  const action = classifySpawnAction(list);
  if (action === 'claim-pr-resume') {
    const prNumber = parseClaimPrNumberFromSpawnArgv(list);
    return {
      action,
      targetKey: prNumber === null ? '' : `pr:${prNumber}`,
      prNumber,
      issueTarget: null,
    };
  }
  if (action !== 'spawn-new') {
    return { action, targetKey: '', prNumber: null, issueTarget: null };
  }
  let sawSpawn = false;
  for (let index = 0; index < list.length; index += 1) {
    const token = list[index];
    if (!sawSpawn) {
      if (token.toLowerCase() === 'spawn') {
        sawSpawn = true;
      }
      continue;
    }
    if (token.startsWith('-')) {
      if (token === '--claim-pr' || /^--claim-pr=/i.test(token)) {
        break;
      }
      if (spawnArgvOptionInlineValue(token)) {
        continue;
      }
      if (spawnArgvOptionConsumesNextToken(token)) {
        if (index + 1 < list.length && !list[index + 1].startsWith('-')) {
          index += 1;
        }
        continue;
      }
      continue;
    }
    return {
      action,
      targetKey: token,
      prNumber: null,
      issueTarget: token,
    };
  }
  return { action, targetKey: '', prNumber: null, issueTarget: null };
}

/**
 * @param {string[]} argv
 */
export function gitArgvHasSourceSelectingGlobals(argv) {
  const list = Array.isArray(argv) ? argv.map((part) => String(part)) : [];
  for (const token of list) {
    if (GIT_SOURCE_SELECTING_GLOBAL_FLAGS.has(token)) {
      return true;
    }
    if (/^--(?:git-dir|work-tree)=/i.test(token)) {
      return true;
    }
    if (token.startsWith('-C') && token !== '-C') {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} left
 * @param {string} right
 */
export function canonicalRepositoryRootsEqual(left, right) {
  const a = String(left ?? '').replace(/[/\\]+$/, '');
  const b = String(right ?? '').replace(/[/\\]+$/, '');
  if (!a || !b) {
    return false;
  }
  if (process.platform === 'win32') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/**
 * @param {string[]} argv
 */
export function parseGitSpawnWorktreeAddArgv(argv) {
  const list = Array.isArray(argv) ? argv.map((part) => String(part)) : [];
  let index = 0;
  while (index < list.length) {
    const token = list[index];
    if (token === '-C' || token === '-c' || token === '--git-dir' || token === '--work-tree' || token === '--exec-path' || token === '--namespace') {
      index += 2;
      continue;
    }
    if (token.startsWith('--') && token.includes('=')) {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) {
      index += 1;
      continue;
    }
    break;
  }
  if (index >= list.length || list[index].toLowerCase() !== 'worktree') {
    return { ok: false, reason: 'not_worktree' };
  }
  if (index + 1 >= list.length || list[index + 1].toLowerCase() !== 'add') {
    return { ok: false, reason: 'not_worktree_add' };
  }
  let cursor = index + 2;
  let branch = null;
  let detach = false;
  let path = null;
  let commit = null;
  while (cursor < list.length) {
    const token = list[cursor];
    if (/^--detach$/i.test(token)) {
      detach = true;
      cursor += 1;
      continue;
    }
    if (/^(-b|--branch)$/i.test(token)) {
      if (cursor + 1 >= list.length) {
        return { ok: false, reason: 'incomplete_branch_flag' };
      }
      branch = list[cursor + 1];
      cursor += 2;
      continue;
    }
    if (/^(-f|--force|--checkout|--lock|--orphan)$/i.test(token)) {
      cursor += 1;
      continue;
    }
    if (token.startsWith('-')) {
      return { ok: false, reason: 'unsupported_flag' };
    }
    if (!path) {
      path = token;
      cursor += 1;
      continue;
    }
    if (!commit) {
      commit = token;
      cursor += 1;
      continue;
    }
    return { ok: false, reason: 'extra_positional' };
  }
  if (!path) {
    return { ok: false, reason: 'missing_path' };
  }
  if (!commit) {
    return { ok: false, reason: 'missing_explicit_commit' };
  }
  return { ok: true, path, commit, branch, detach };
}

/**
 * @param {string} candidatePath
 * @param {string} prefixPath
 */
export function pathIsUnderCanonicalPrefix(candidatePath, prefixPath) {
  const candidate = String(candidatePath ?? '').replace(/[/\\]+$/, '');
  const prefix = String(prefixPath ?? '').replace(/[/\\]+$/, '');
  if (!candidate || !prefix) {
    return false;
  }
  if (process.platform === 'win32') {
    const lowerCandidate = candidate.toLowerCase();
    const lowerPrefix = prefix.toLowerCase();
    if (lowerCandidate === lowerPrefix) {
      return true;
    }
    return lowerCandidate.startsWith(`${lowerPrefix}/`) || lowerCandidate.startsWith(`${lowerPrefix}\\`);
  }
  if (candidate === prefix) {
    return true;
  }
  return candidate.startsWith(`${prefix}/`);
}

/**
 * @param {object} input
 */
export function evaluateSpawnWorktreeGrantConsume(input) {
  const grant = input.grant ?? null;
  const argv = Array.isArray(input.argv) ? input.argv.map((part) => String(part)) : [];
  const canonicalPath = String(input.canonicalPath ?? '');
  const worktreesPrefix = String(input.worktreesPrefix ?? '');
  const targetPreexists = Boolean(input.targetPreexists);
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();

  if (!grant || typeof grant !== 'object') {
    return { ok: false, reason: 'grant_missing' };
  }
  if (Number(grant.schemaVersion) !== SPAWN_WORKTREE_GRANT_SCHEMA_VERSION) {
    return { ok: false, reason: 'grant_schema_mismatch' };
  }
  if (grant.consumed) {
    return { ok: false, reason: 'grant_already_consumed' };
  }
  const expiresAtMs = Date.parse(String(grant.expiresAtUtc ?? ''));
  if (!Number.isFinite(expiresAtMs) || nowMs > expiresAtMs) {
    return { ok: false, reason: 'grant_expired' };
  }

  if (gitArgvHasSourceSelectingGlobals(argv)) {
    return { ok: false, reason: 'git_source_global_denied' };
  }

  const shape = parseGitSpawnWorktreeAddArgv(argv);
  if (!shape.ok) {
    return { ok: false, reason: shape.reason };
  }

  if (!canonicalPath || !worktreesPrefix) {
    return { ok: false, reason: 'path_unresolvable' };
  }
  if (!pathIsUnderCanonicalPrefix(canonicalPath, worktreesPrefix)) {
    return { ok: false, reason: 'path_escape' };
  }
  if (targetPreexists) {
    return { ok: false, reason: 'target_preexists' };
  }

  const basename = canonicalPath.split(/[/\\]/).pop() ?? '';
  const allowedNames = Array.isArray(grant.authorizedWorktreeNames)
    ? grant.authorizedWorktreeNames.map((name) => String(name))
    : [];
  if (allowedNames.length > 0 && !allowedNames.includes(basename)) {
    return { ok: false, reason: 'worktree_name_mismatch' };
  }

  const expectedHead = String(grant.expectedHeadRef ?? 'HEAD');
  if (String(shape.commit) !== expectedHead) {
    return { ok: false, reason: 'head_ref_mismatch' };
  }

  if (grant.action === 'claim-pr-resume') {
    const prNumber = Number(grant.prNumber);
    if (!Number.isFinite(prNumber) || prNumber <= 0) {
      return { ok: false, reason: 'grant_pr_missing' };
    }
  }
  else if (grant.action === 'spawn-new') {
    const issueTarget = String(grant.issueTarget ?? '').trim();
    if (!issueTarget) {
      return { ok: false, reason: 'grant_issue_missing' };
    }
  }
  else {
    return { ok: false, reason: 'grant_action_invalid' };
  }

  const grantRepo = String(grant.sourceRepositoryRoot ?? '').trim();
  if (!grantRepo) {
    return { ok: false, reason: 'grant_repository_unbound' };
  }
  const effectiveRepo = String(input.effectiveRepositoryRoot ?? '').trim();
  if (!effectiveRepo) {
    return { ok: false, reason: 'repository_root_unresolvable' };
  }
  if (!canonicalRepositoryRootsEqual(grantRepo, effectiveRepo)) {
    return { ok: false, reason: 'repository_root_mismatch' };
  }

  if (shape.branch) {
    const expectedBranch = grant.expectedBranch ? String(grant.expectedBranch) : null;
    if (!expectedBranch || String(shape.branch) !== expectedBranch) {
      return { ok: false, reason: 'branch_mismatch' };
    }
  }

  return { ok: true, reason: 'spawn_worktree_allow', basename, commit: shape.commit };
}

/**
 * @param {object} input
 */
export function buildSpawnWorktreeGrantRecord(input) {
  const parsed = parseSpawnTargetFromArgv(input.argv ?? []);
  if (!parsed.targetKey) {
    return { ok: false, reason: 'spawn_target_missing' };
  }
  const sourceRepositoryRoot = String(input.sourceRepositoryRoot ?? '').trim();
  if (!sourceRepositoryRoot) {
    return { ok: false, reason: 'source_repository_missing' };
  }
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  const expiresAtUtc = new Date(nowMs + SPAWN_WORKTREE_GRANT_TTL_SECONDS * 1000).toISOString();
  const authorized = new Set();
  if (parsed.issueTarget) {
    authorized.add(String(parsed.issueTarget));
  }
  if (parsed.prNumber !== null) {
    authorized.add(`pr-${parsed.prNumber}`);
  }
  for (const name of input.extraAuthorizedWorktreeNames ?? []) {
    if (name) {
      authorized.add(String(name));
    }
  }
  return {
    ok: true,
    reason: 'grant_built',
    grant: {
      schemaVersion: SPAWN_WORKTREE_GRANT_SCHEMA_VERSION,
      grantId: String(input.grantId ?? ''),
      action: parsed.action,
      projectId: String(input.projectId ?? 'orchestrator-pack'),
      targetKey: parsed.targetKey,
      issueTarget: parsed.issueTarget,
      prNumber: parsed.prNumber,
      authorizedWorktreeNames: [...authorized],
      expectedHeadRef: String(input.expectedHeadRef ?? 'HEAD'),
      expectedBranch: input.expectedBranch ? String(input.expectedBranch) : null,
      sourceRepositoryRoot,
      mintedAtUtc: new Date(nowMs).toISOString(),
      expiresAtUtc,
      consumed: false,
      holder: input.holder ?? null,
    },
  };
}

/**
 * @param {object} input
 */
export function evaluateBoundaryEscapeSignal(input) {
  const env = input.env ?? {};
  const orchestratorTmux = /\borchestrator\b/i.test(String(env.AO_TMUX_NAME ?? ''));
  const surfaceArmed = String(env.AO_AUTONOMOUS_ORCHESTRATOR_SURFACE ?? '') === '1';
  const bootstrapSeen = String(env.__AO_AUTONOMOUS_SURFACE_BOOTSTRAP ?? '') === '1';
  const pathValue = String(env.PATH ?? '');
  const packScripts = String(input.packScriptsDir ?? '');
  const packOnPath = packScripts ? pathValue.split(':').includes(packScripts) : true;
  const signals = [];
  if (orchestratorTmux && bootstrapSeen && !surfaceArmed) {
    signals.push('surface_unset_after_bootstrap');
  }
  if (orchestratorTmux && packScripts && !packOnPath) {
    signals.push('pack_scripts_missing_from_path');
  }
  if (signals.length === 0) {
    return { detected: false, reason: 'no_escape_signal', signals: [] };
  }
  return {
    detected: true,
    reason: 'surface_and_path_cooperative',
    signals,
  };
}

runStdinJsonCli('spawn-worktree-grant.mjs', {
  parseSpawnTarget: () => parseSpawnTargetFromArgv(readStdinJson().argv ?? []),
  buildGrant: () => buildSpawnWorktreeGrantRecord(readStdinJson()),
  evaluateConsume: () => evaluateSpawnWorktreeGrantConsume(readStdinJson()),
  evaluateBoundaryEscape: () => evaluateBoundaryEscapeSignal(readStdinJson()),
});
